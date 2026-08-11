/**
 * Cifrado en reposo de las credenciales de aplicación (el «piso 1»).
 *
 * Diseño y ADRs: `infra/doc/analysis-secretos-en-reposo.md`.
 *
 * ADR-002 — EL CIFRADO VA ACÁ, NO EN `pgcrypto`
 *
 * Con `pgcrypto` el plaintext **y la llave** viajan dentro de la sentencia SQL,
 * así que terminan en `pg_stat_activity`, en el log de queries y en cualquier
 * `log_min_duration_statement`. Es la forma clásica de filtrar un secreto
 * creyendo que se lo está protegiendo. Postgres guarda bytes opacos y no sabe
 * nada; la master key nunca entra a la base.
 *
 * ADR-003 — ESTE MÓDULO VIVE EN EL DISPATCHER
 *
 * El dispatcher es el único custodio de `SECRETS_MASTER_KEY`. El cockpit manda
 * la credencial en claro UNA vez por la red interna y no persiste ni la llave
 * ni el secreto. T9.4 le sacó al cockpit la credencial de Resend a propósito
 * —salió hasta del `package.json`, con un test que lo fija—; darle la llave
 * maestra sería devolverle algo más grande que lo que se le quitó.
 *
 * QUÉ PROTEGE Y QUÉ NO (está en §3 del diseño, y conviene tenerlo acá también)
 *
 * Protege el **dump**: un backup filtrado, un `pg_dump` que se va a Drive, una
 * réplica. NO protege contra un atacante con root en el VPS, que tiene el
 * `.env` (la llave) y la base (el ciphertext). Nadie debería leer este archivo
 * y concluir que las credenciales están a salvo de una máquina comprometida.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGO = 'aes-256-gcm';
/** GCM usa 96 bits: es el tamaño para el que está especificado. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface SealedSecret {
  key_version: number;
  algo: string;
  iv: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
  /**
   * Últimos 4 caracteres del secreto, en claro. Es lo que deja que la UI diga
   * «termina en …a3f9» para que el operador confirme CUÁL key está cargada, sin
   * revelar nada útil. Patrón estándar (lo hace Stripe con las tarjetas).
   */
  last4: string;
}

/**
 * Las master keys disponibles, por versión.
 *
 * Son DOS a propósito (§4.6 del diseño): sin una versión previa que todavía
 * pueda descifrar, rotar la llave es un big-bang sobre todas las filas a la vez
 * — o sea que no se hace nunca. Con esto, rotar es: cargar la nueva, mover la
 * vieja a `previous`, re-cifrar en un pase, borrar `previous`.
 */
export interface MasterKeys {
  /** Versión con la que se CIFRA (y también descifra). */
  current: { version: number; key: Buffer };
  /** Versión que SÓLO descifra, durante una rotación en curso. */
  previous?: { version: number; key: Buffer };
}

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/**
 * Parsea una master key de su forma en el `.env`: 32 bytes en base64.
 *
 * Se valida el LARGO, no sólo que decodifique: un base64 corto decodifica sin
 * error y daría una llave de 16 bytes, que `createCipheriv` rechazaría recién
 * en el primer cifrado — o sea en producción, con un secreto en la mano.
 */
export function parseMasterKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxError(
      `${label}: se esperaban ${KEY_BYTES} bytes en base64 y vinieron ${key.length}. ` +
        `Generala con: openssl rand -base64 32`,
    );
  }
  return key;
}

/**
 * Datos autenticados adicionales. Atan el ciphertext A SU FILA: sin esto, el
 * blob de Resend pegado en la fila de OpenAI —o el de un cliente en la base de
 * otro— descifraría bien y entregaría un secreto en el lugar equivocado.
 * Cuesta una línea y cierra una clase entera de error.
 */
function aad(clientSlug: string, providerId: string, keyVersion: number): Buffer {
  return Buffer.from(`${clientSlug}|${providerId}|${keyVersion}`, 'utf8');
}

export interface SealParams {
  plaintext: string;
  clientSlug: string;
  providerId: string;
  keys: MasterKeys;
}

/** Cifra con la versión CURRENT. Nunca con `previous`: esa sólo descifra. */
export function seal({ plaintext, clientSlug, providerId, keys }: SealParams): SealedSecret {
  if (!plaintext) throw new SecretBoxError('seal: el secreto vacío no se guarda');

  const { version, key } = keys.current;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(clientSlug, providerId, version));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    key_version: version,
    algo: ALGO,
    iv,
    auth_tag: cipher.getAuthTag(),
    ciphertext,
    last4: plaintext.slice(-4),
  };
}

export interface OpenParams {
  sealed: SealedSecret;
  clientSlug: string;
  providerId: string;
  keys: MasterKeys;
}

/**
 * Descifra. Elige la llave por `key_version`, así que una fila cifrada con la
 * llave vieja sigue abriendo durante una rotación.
 *
 * ⚠ Si el `auth_tag` no valida —llave equivocada, ciphertext manipulado, blob
 * movido de fila— **tira**. No hay camino de "abrir igual": un GCM que no
 * autentica no es un secreto, es basura que parece un secreto.
 */
export function open({ sealed, clientSlug, providerId, keys }: OpenParams): string {
  if (sealed.algo !== ALGO) {
    throw new SecretBoxError(`open: algoritmo desconocido '${sealed.algo}'`);
  }

  const candidate =
    keys.current.version === sealed.key_version
      ? keys.current
      : keys.previous?.version === sealed.key_version
        ? keys.previous
        : null;

  if (!candidate) {
    throw new SecretBoxError(
      `open: no tengo la master key versión ${sealed.key_version}. ` +
        `Si es de una rotación a medias, cargá SECRETS_MASTER_KEY_PREVIOUS.`,
    );
  }

  const decipher = createDecipheriv(ALGO, candidate.key, sealed.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(clientSlug, providerId, sealed.key_version));
  decipher.setAuthTag(sealed.auth_tag);

  try {
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // El error de node ("Unsupported state or unable to authenticate data") no
    // le dice nada a nadie. Se traduce, SIN incluir el ciphertext ni la llave.
    throw new SecretBoxError(
      `open: el secreto de '${providerId}' no autentica (llave equivocada, ` +
        `blob movido de fila, o dato corrupto)`,
    );
  }
}

/**
 * ¿Dos master keys son la misma? Comparación en tiempo constante.
 *
 * Se usa al validar el env: si `SECRETS_MASTER_KEY_PREVIOUS` es igual a la
 * actual, la rotación no rotó nada y hay que decirlo al boot en vez de dejar
 * una falsa sensación de llave nueva.
 */
export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
