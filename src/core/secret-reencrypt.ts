/**
 * El pase de re-cifrado de la rotación de master key (F5, §4.6 del diseño).
 *
 * Diseño: `infra/doc/analysis-secretos-en-reposo.md` §4.6. Rotar la llave es:
 * cargar la nueva, mover la vieja a `SECRETS_MASTER_KEY_PREVIOUS`, correr este
 * pase, y recién entonces borrar `_PREVIOUS`. Sin el pase, la rotación es un
 * big-bang sobre todas las filas a la vez — o sea que no ocurre nunca.
 *
 * ES UN COMANDO DEL DISPATCHER, NO UN SCRIPT SUELTO. Tiene que correr donde
 * vive la llave (ADR-003): `docker exec <slug>_dispatcher node dist/secrets-cli.js
 * reencrypt`. El runbook que lo usa:
 * `infra/doc/runbook-restore-provider-secrets.md`.
 *
 * QUÉ NO HACE, Y ES DELIBERADO
 *
 * - Una fila que no abre **no se toca**: se reporta y el pase sigue. Re-escribir
 *   un blob ilegible destruiría la única copia del ciphertext que quizá abra
 *   con una llave que todavía está en BW.
 * - No pisa `rotated_at`: ese campo dice cuándo se reemplazó la CREDENCIAL, y
 *   acá la credencial no cambia — cambia la llave con la que está guardada.
 * - El UPDATE es optimista (`WHERE ... AND iv = <el que leí>`): si el cliente
 *   reemplazó su credencial en el medio, la fila nueva ya está cifrada con la
 *   llave current y el pase la deja en paz en vez de pisarla.
 */
import type { SqlClient } from '../lib/postgres.js';
import type { Logger } from '../lib/logger.js';
import { open, seal, SecretBoxError } from '../lib/secret-box.js';
import { masterKeys } from '../lib/master-keys.js';

export interface ReencryptDeps {
  sql: SqlClient;
  logger: Logger;
  clientSlug: string;
}

interface SecretRow {
  provider_id: string;
  key_version: number;
  algo: string;
  iv: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
  last4: string;
  created_at: Date;
  created_by: string | null;
  rotated_at: Date | null;
}

const NO_MASTER_KEY =
  'este cliente no tiene el piso 1 cableado: falta SECRETS_MASTER_KEY en el .env del VPS ' +
  'y en la lista curada environment: del stack 93-dispatcher';

async function allRows(deps: ReencryptDeps): Promise<SecretRow[]> {
  return deps.sql<SecretRow[]>`
    SELECT provider_id, key_version, algo, iv, auth_tag, ciphertext, last4,
           created_at, created_by, rotated_at
      FROM config.client_provider_secrets
     ORDER BY provider_id
  `;
}

export interface SecretStatusRow {
  provider_id: string;
  key_version: number;
  last4: string;
  created_at: string;
  created_by: string | null;
  rotated_at: string | null;
  decryptable: boolean;
  /** Sólo cuando `decryptable=false`: el motivo, sin ciphertext ni llave. */
  error?: string;
}

export type StatusResult =
  | { ok: true; current_version: number; previous_version: number | null; rows: SecretStatusRow[] }
  | { ok: false; code: 'no_master_key'; message: string };

/**
 * Qué hay guardado y si abre con las llaves de este proceso. **Nunca** el
 * plaintext: es la verificación del runbook de restore — «el dump + la master
 * key recuperan la credencial» se prueba con `decryptable: true`, no
 * imprimiendo el secreto en una terminal.
 */
export async function secretsStatus(deps: ReencryptDeps): Promise<StatusResult> {
  const keys = masterKeys();
  if (!keys) return { ok: false, code: 'no_master_key', message: NO_MASTER_KEY };

  const rows = await allRows(deps);
  const out: SecretStatusRow[] = rows.map((row) => {
    const base = {
      provider_id: row.provider_id,
      key_version: row.key_version,
      last4: row.last4,
      created_at: row.created_at.toISOString(),
      created_by: row.created_by,
      rotated_at: row.rotated_at ? row.rotated_at.toISOString() : null,
    };
    try {
      open({ sealed: row, clientSlug: deps.clientSlug, providerId: row.provider_id, keys });
      return { ...base, decryptable: true };
    } catch (err) {
      const error = err instanceof SecretBoxError ? err.message : 'no se pudo descifrar';
      return { ...base, decryptable: false, error };
    }
  });

  return {
    ok: true,
    current_version: keys.current.version,
    previous_version: keys.previous?.version ?? null,
    rows: out,
  };
}

export interface ReencryptResult {
  ok: boolean;
  current_version: number;
  total: number;
  already_current: number;
  reencrypted: string[];
  /** El cliente reemplazó la credencial mientras corría el pase: nada que hacer. */
  raced: string[];
  failed: Array<{ provider_id: string; error: string }>;
}

export type ReencryptOutcome =
  | ReencryptResult
  | { ok: false; code: 'no_master_key'; message: string };

/**
 * Re-cifra con la llave CURRENT toda fila guardada con otra versión.
 * Idempotente: correrlo dos veces deja lo mismo.
 */
export async function reencryptSecrets(deps: ReencryptDeps): Promise<ReencryptOutcome> {
  const keys = masterKeys();
  if (!keys) return { ok: false, code: 'no_master_key', message: NO_MASTER_KEY };

  const rows = await allRows(deps);
  const result: ReencryptResult = {
    ok: true,
    current_version: keys.current.version,
    total: rows.length,
    already_current: 0,
    reencrypted: [],
    raced: [],
    failed: [],
  };

  for (const row of rows) {
    if (row.key_version === keys.current.version) {
      result.already_current += 1;
      continue;
    }

    let plaintext: string;
    try {
      plaintext = open({ sealed: row, clientSlug: deps.clientSlug, providerId: row.provider_id, keys });
    } catch (err) {
      const error = err instanceof SecretBoxError ? err.message : 'no se pudo descifrar';
      result.failed.push({ provider_id: row.provider_id, error });
      deps.logger.error({ provider_id: row.provider_id, key_version: row.key_version, err: error },
        're-cifrado: la fila no abre y NO se toca');
      continue;
    }

    const sealed = seal({ plaintext, clientSlug: deps.clientSlug, providerId: row.provider_id, keys });

    const updated = await deps.sql<Array<{ provider_id: string }>>`
      UPDATE config.client_provider_secrets
         SET key_version = ${sealed.key_version},
             iv          = ${sealed.iv},
             auth_tag    = ${sealed.auth_tag},
             ciphertext  = ${sealed.ciphertext}
       WHERE provider_id = ${row.provider_id}
         AND iv = ${row.iv}
       RETURNING provider_id
    `;

    if (updated.length === 0) {
      result.raced.push(row.provider_id);
      continue;
    }

    result.reencrypted.push(row.provider_id);
    deps.logger.info(
      { provider_id: row.provider_id, from_version: row.key_version, to_version: sealed.key_version },
      're-cifrado: fila migrada a la llave current',
    );
  }

  result.ok = result.failed.length === 0;
  return result;
}
