/**
 * Carga las master keys del env y las deja listas para `secret-box`.
 *
 * Vive aparte de `secret-box.ts` a propósito: ese módulo es **puro** (entra
 * plaintext, sale ciphertext) y por eso se puede testear sin tocar el env ni
 * la base. Acá está la única parte que sabe de dónde salen las llaves.
 *
 * Diseño: `infra/doc/analysis-secretos-en-reposo.md` §4.6.
 */
import { env } from '../env.js';
import { logger } from './logger.js';
import { parseMasterKey, sameKey, SecretBoxError, type MasterKeys } from './secret-box.js';

let cached: MasterKeys | null | undefined;

/**
 * Las master keys, o `null` si este cliente todavía no tiene el piso 1 cableado.
 *
 * **`null` no es un error**: los tres clientes ya corren y el env es opcional a
 * propósito (ver `env.ts`). El llamador decide qué hacer — el resolver cae al
 * env como siempre (T5.6), y guardar una credencial responde un error que
 * nombra la env que falta.
 *
 * Se cachea porque parsear base64 en cada envío no aporta nada. La llave no
 * cambia sin recrear el container: cambiarla ES un cambio de `.env`.
 */
export function masterKeys(): MasterKeys | null {
  if (cached !== undefined) return cached;
  cached = build();
  return cached;
}

function build(): MasterKeys | null {
  const raw = env.SECRETS_MASTER_KEY?.trim();
  if (!raw) return null;

  const current = {
    version: env.SECRETS_MASTER_KEY_VERSION,
    key: parseMasterKey(raw, 'SECRETS_MASTER_KEY'),
  };

  const prevRaw = env.SECRETS_MASTER_KEY_PREVIOUS?.trim();
  if (!prevRaw) return { current };

  const prevVersion = env.SECRETS_MASTER_KEY_PREVIOUS_VERSION;
  if (prevVersion === undefined) {
    // Sin versión no se puede saber qué filas le corresponden, y adivinarla
    // (`current - 1`) sería inventar. Se ignora y se dice fuerte.
    logger.error(
      'SECRETS_MASTER_KEY_PREVIOUS está cargada sin SECRETS_MASTER_KEY_PREVIOUS_VERSION: se ignora. ' +
        'Las filas cifradas con la llave vieja NO van a abrir.',
    );
    return { current };
  }

  const previous = { version: prevVersion, key: parseMasterKey(prevRaw, 'SECRETS_MASTER_KEY_PREVIOUS') };

  // Una "rotación" en la que las dos llaves son la misma no rotó nada, y es un
  // error fácil de cometer copiando el .env. Mejor decirlo que dejar una falsa
  // sensación de llave nueva.
  if (sameKey(current.key, previous.key)) {
    logger.error(
      'SECRETS_MASTER_KEY y SECRETS_MASTER_KEY_PREVIOUS son la MISMA llave: la rotación no rotó nada.',
    );
  }
  if (previous.version === current.version) {
    throw new SecretBoxError(
      'SECRETS_MASTER_KEY_PREVIOUS_VERSION no puede ser igual a SECRETS_MASTER_KEY_VERSION: ' +
        'no habría forma de saber con cuál se cifró cada fila.',
    );
  }

  return { current, previous };
}

/** Sólo para tests: el cache es del proceso y no se comparte entre casos. */
export function __resetMasterKeys(): void {
  cached = undefined;
}
