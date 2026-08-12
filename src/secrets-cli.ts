/**
 * CLI del piso 1 — corre DONDE VIVE LA LLAVE (ADR-003): adentro del container
 * del dispatcher, nunca desde el host ni desde otro servicio.
 *
 *   docker exec <slug>_dispatcher node dist/secrets-cli.js status
 *   docker exec <slug>_dispatcher node dist/secrets-cli.js status --database restore_f5
 *   docker exec <slug>_dispatcher node dist/secrets-cli.js reencrypt
 *
 * `status`     — qué credenciales hay guardadas y si ABREN con las llaves de
 *                este proceso. Con `--database` apunta a otra base del mismo
 *                Postgres: es la verificación del runbook de restore — un dump
 *                restaurado en una base scratch tiene que dar `decryptable: true`
 *                SIN tocar la base viva.
 * `reencrypt`  — el pase de la rotación de master key (§4.6 del diseño): migra
 *                a la llave current toda fila guardada con otra versión.
 *
 * El CLI **nunca imprime el plaintext** ni la llave. La prueba de que un
 * secreto se recuperó es `decryptable: true`, no verlo en una terminal.
 *
 * Runbook: `infra/doc/runbook-restore-provider-secrets.md`.
 */
import postgres from 'postgres';
import { env } from './env.js';
import { secretsStatus, reencryptSecrets, type ReencryptDeps } from './core/secret-reencrypt.js';

function usage(): never {
  console.error('uso: node dist/secrets-cli.js <status|reencrypt> [--database <nombre>]');
  process.exit(2);
}

function parseArgs(argv: string[]): { command: 'status' | 'reencrypt'; database: string } {
  const [command, ...rest] = argv;
  if (command !== 'status' && command !== 'reencrypt') usage();
  let database = env.APPDB_DATABASE;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--database' && rest[i + 1]) {
      database = rest[i + 1];
      i += 1;
    } else {
      usage();
    }
  }
  if (command === 'reencrypt' && database !== env.APPDB_DATABASE) {
    // El pase escribe. Contra una scratch de verificación no tiene sentido, y
    // permitirlo invita a "probar" la rotación en la copia y creer que la base
    // viva quedó migrada.
    console.error('reencrypt corre sólo contra la base viva (sin --database)');
    process.exit(2);
  }
  return { command, database };
}

async function main(): Promise<void> {
  const { command, database } = parseArgs(process.argv.slice(2));

  const sql = postgres({
    host: env.APPDB_HOST,
    port: env.APPDB_PORT,
    user: env.APPDB_USER,
    password: env.APPDB_PASSWORD,
    database,
    ssl: false,
    max: 2,
    prepare: false,
  });

  // console como "logger": es un CLI interactivo, el output ES la interfaz.
  const logger = {
    info: (o: unknown, msg?: string) => console.log(msg ?? '', JSON.stringify(o)),
    error: (o: unknown, msg?: string) => console.error(msg ?? '', JSON.stringify(o)),
    warn: (o: unknown, msg?: string) => console.warn(msg ?? '', JSON.stringify(o)),
    debug: () => undefined,
  } as unknown as ReencryptDeps['logger'];

  const deps: ReencryptDeps = { sql, logger, clientSlug: env.CLIENT_SLUG };

  try {
    if (command === 'status') {
      const result = await secretsStatus(deps);
      if (!result.ok) {
        console.error(result.message);
        process.exitCode = 2;
        return;
      }
      console.log(
        `master key: current v${result.current_version}` +
          (result.previous_version !== null ? ` · previous v${result.previous_version}` : ''),
      );
      console.log(`database: ${database} · filas: ${result.rows.length}`);
      for (const row of result.rows) {
        const state = row.decryptable ? 'ABRE' : `NO ABRE — ${row.error}`;
        console.log(
          `  ${row.provider_id} · v${row.key_version} · …${row.last4} · ` +
            `cargada ${row.created_at} por ${row.created_by ?? '?'} · ${state}`,
        );
      }
      if (result.rows.some((r) => !r.decryptable)) process.exitCode = 1;
      return;
    }

    const result = await reencryptSecrets(deps);
    if (!('total' in result)) {
      console.error(result.message);
      process.exitCode = 2;
      return;
    }
    console.log(
      `re-cifrado a v${result.current_version}: ${result.total} filas · ` +
        `${result.already_current} ya current · ${result.reencrypted.length} migradas` +
        (result.raced.length ? ` · ${result.raced.length} reemplazadas en el medio (sin tocar)` : ''),
    );
    for (const id of result.reencrypted) console.log(`  migrada: ${id}`);
    for (const f of result.failed) console.error(`  NO ABRE (sin tocar): ${f.provider_id} — ${f.error}`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
