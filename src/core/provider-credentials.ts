/**
 * El custodio: guardar y leer la credencial que el cliente trae (BYOK).
 *
 * Diseño: `infra/doc/analysis-secretos-en-reposo.md` (F2). El plan del BYOK
 * completo —máquina de estados del `ownership`, gate del cutover— es **T7/F3**;
 * acá está sólo el almacén.
 *
 * ADR-003 — POR QUÉ ESTO VIVE EN EL DISPATCHER
 *
 * Es el único proceso con `SECRETS_MASTER_KEY`. El cockpit manda la credencial
 * en claro **una vez** por la red interna y no persiste ni la llave ni el valor;
 * T9.4 le sacó la credencial de Resend a propósito y darle la llave maestra
 * sería devolverle algo más grande que lo que se le quitó.
 *
 * LO QUE ESTE MÓDULO NO HACE, Y ES DELIBERADO
 *
 * **No toca `config.client_providers`.** Guardar una credencial NO la pone en
 * uso: el `ownership` lo mueve el cutover de T7, con su gate de verificación.
 * Si guardar flipeara a `owned`, una key mal copiada cortaría el correo del
 * cliente en el mismo click — que es justo lo que el diseño evita al exigir un
 * envío real antes de completar el flip.
 */
import type { SqlClient } from '../lib/postgres.js';
import type { Logger } from '../lib/logger.js';
import { seal, open, SecretBoxError, type SealedSecret } from '../lib/secret-box.js';
import { masterKeys } from '../lib/master-keys.js';

export interface CredentialDeps {
  sql: SqlClient;
  logger: Logger;
  clientSlug: string;
}

export type StoreResult =
  | { ok: true; last4: string; key_version: number }
  | { ok: false; code: 'no_master_key' | 'unknown_provider' | 'crypto_error'; message: string };

export type CredentialInfo = {
  has_key: boolean;
  last4?: string;
  key_version?: number;
  created_at?: string;
  created_by?: string | null;
};

const NO_MASTER_KEY =
  'este cliente no tiene el piso 1 cableado: falta SECRETS_MASTER_KEY en el .env del VPS ' +
  'y en la lista curada environment: del stack 93-dispatcher';

/**
 * Guarda (o reemplaza) la credencial del cliente, cifrada.
 *
 * El plaintext **no se loguea, no se devuelve y no se conserva**: entra, se
 * cifra y se va. Lo único que vuelve es `last4`, que es lo que deja a la UI
 * decir «termina en …a3f9» sin revelar nada.
 */
export async function storeProviderCredential(
  deps: CredentialDeps,
  providerId: string,
  credential: string,
  createdBy: string | null,
): Promise<StoreResult> {
  const keys = masterKeys();
  if (!keys) return { ok: false, code: 'no_master_key', message: NO_MASTER_KEY };

  // El proveedor tiene que existir en el catálogo. Sin este chequeo el error
  // sería una violación de FK — un 500 opaco donde corresponde un 404 que
  // nombra el id.
  const known = await deps.sql<Array<{ id: string }>>`
    SELECT id FROM config.providers WHERE id = ${providerId} AND archived_at IS NULL
  `;
  if (known.length === 0) {
    return {
      ok: false,
      code: 'unknown_provider',
      message: `proveedor '${providerId}' desconocido o archivado en config.providers`,
    };
  }

  let sealed: SealedSecret;
  try {
    sealed = seal({ plaintext: credential, clientSlug: deps.clientSlug, providerId, keys });
  } catch (err) {
    // El mensaje de SecretBoxError nunca incluye el secreto ni la llave.
    const message = err instanceof SecretBoxError ? err.message : 'no se pudo cifrar la credencial';
    return { ok: false, code: 'crypto_error', message };
  }

  await deps.sql`
    INSERT INTO config.client_provider_secrets
      (provider_id, key_version, algo, iv, auth_tag, ciphertext, last4, created_by, created_at)
    VALUES (${providerId}, ${sealed.key_version}, ${sealed.algo}, ${sealed.iv}, ${sealed.auth_tag},
            ${sealed.ciphertext}, ${sealed.last4}, ${createdBy}, now())
    ON CONFLICT (provider_id) DO UPDATE
      SET key_version = EXCLUDED.key_version,
          algo        = EXCLUDED.algo,
          iv          = EXCLUDED.iv,
          auth_tag    = EXCLUDED.auth_tag,
          ciphertext  = EXCLUDED.ciphertext,
          last4       = EXCLUDED.last4,
          created_by  = EXCLUDED.created_by,
          rotated_at  = now()
  `;

  // `last4` sí puede loguearse: identifica la key sin revelarla, y es lo que
  // deja reconstruir «qué credencial estaba cargada» al mirar un incidente.
  deps.logger.info(
    { provider_id: providerId, last4: sealed.last4, key_version: sealed.key_version, by: createdBy },
    'credencial del cliente guardada (cifrada)',
  );

  return { ok: true, last4: sealed.last4, key_version: sealed.key_version };
}

/** Qué hay cargado. **Nunca** el valor: es un campo write-only. */
export async function getProviderCredentialInfo(
  deps: CredentialDeps,
  providerId: string,
): Promise<CredentialInfo> {
  const rows = await deps.sql<
    Array<{ last4: string; key_version: number; created_at: Date; created_by: string | null }>
  >`
    SELECT last4, key_version, created_at, created_by
      FROM config.client_provider_secrets
     WHERE provider_id = ${providerId}
  `;
  const row = rows[0];
  if (!row) return { has_key: false };
  return {
    has_key: true,
    last4: row.last4,
    key_version: row.key_version,
    created_at: row.created_at.toISOString(),
    created_by: row.created_by,
  };
}

/**
 * Borra la credencial del cliente.
 *
 * Es la mitad del camino de vuelta `owned → managed` (T7.5); la otra mitad —el
 * `ownership`— la mueve T7. Se expone desde F2 porque un almacén sin borrado
 * obliga a SQL a mano, y un camino de vuelta que necesita un DBA no es un
 * camino de vuelta.
 */
export async function deleteProviderCredential(
  deps: CredentialDeps,
  providerId: string,
): Promise<{ deleted: boolean }> {
  const rows = await deps.sql<Array<{ provider_id: string }>>`
    DELETE FROM config.client_provider_secrets
     WHERE provider_id = ${providerId}
     RETURNING provider_id
  `;
  const deleted = rows.length > 0;
  if (deleted) {
    deps.logger.info({ provider_id: providerId }, 'credencial del cliente borrada');
  }
  return { deleted };
}

export type LoadResult =
  | { ok: true; credential: string }
  | { ok: false; code: 'absent' | 'no_master_key' | 'undecryptable'; message: string };

/**
 * Descifra la credencial del cliente para usarla en un envío.
 *
 * ⚠️ **`undecryptable` NO puede caer al env.** Si el cliente está en `owned` y
 * su credencial no abre, mandar con la credencial `managed` significaría
 * emitir el correo de ese cliente **desde nuestra cuenta**, que es exactamente
 * lo que el BYOK existe para evitar. Falla cerrado y que se vea.
 */
export async function loadProviderCredential(
  deps: CredentialDeps,
  providerId: string,
): Promise<LoadResult> {
  const keys = masterKeys();
  if (!keys) return { ok: false, code: 'no_master_key', message: NO_MASTER_KEY };

  const rows = await deps.sql<
    Array<{ key_version: number; algo: string; iv: Buffer; auth_tag: Buffer; ciphertext: Buffer; last4: string }>
  >`
    SELECT key_version, algo, iv, auth_tag, ciphertext, last4
      FROM config.client_provider_secrets
     WHERE provider_id = ${providerId}
  `;
  const row = rows[0];
  if (!row) {
    return { ok: false, code: 'absent', message: `sin credencial cargada para '${providerId}'` };
  }

  try {
    const credential = open({
      sealed: {
        key_version: row.key_version,
        algo: row.algo,
        iv: row.iv,
        auth_tag: row.auth_tag,
        ciphertext: row.ciphertext,
        last4: row.last4,
      },
      clientSlug: deps.clientSlug,
      providerId,
      keys,
    });
    return { ok: true, credential };
  } catch (err) {
    const message = err instanceof SecretBoxError ? err.message : 'no se pudo descifrar';
    deps.logger.error({ provider_id: providerId, last4: row.last4, err: message }, 'credencial owned ilegible');
    return { ok: false, code: 'undecryptable', message };
  }
}
