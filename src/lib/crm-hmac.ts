/**
 * HMAC-SHA256 signing helpers para webhooks salientes al CRM cliente
 * (Fase 6 Item 1).
 *
 * Formato del header X-PalmaDev-Signature (Stripe-style):
 *
 *     t=<unix_seconds>,v1=<hex_sha256>
 *
 * Donde `hex_sha256 = HMAC_SHA256(secret, "<t>.<raw_body>")`.
 *
 * El cliente reconstruye `<t>.<raw_body>` con el header `t` y el body
 * exacto recibido, recalcula HMAC con su copia del secret, y compara
 * en constant-time. Si abs(now - t) > 5min → anti-replay reject.
 *
 * Notas:
 * - El raw body es el JSON string LITERAL que va al wire (sin re-stringify
 *   en el receiver). El emitter pasa ese mismo string a `signRawBody` y
 *   POSTea con `body: rawBody`.
 * - SHA-256 hex usa lower-case (consistente con Stripe / GitHub).
 * - `verifySignature` no se usa en el dispatcher (lo expone para tests +
 *   eventual use cases server-side, ej. echo endpoint).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Devuelve el valor del header `X-PalmaDev-Signature` a setear en el POST. */
export function buildSignatureHeader(
  secret: string,
  rawBody: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const sig = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

export interface ParsedSignature {
  timestamp: number;
  v1: string;
}

/** Parsea el header. Devuelve `null` si el formato es inválido. */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  const parts = header.split(',').map((p) => p.trim());
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) t = parsed;
    } else if (key === 'v1') {
      v1 = value;
    }
  }
  if (t === null || v1 === null) return null;
  return { timestamp: t, v1 };
}

/**
 * Verifica una firma. Útil para tests + endpoints que reciben echo del
 * cliente. `maxSkewSeconds` default 300 (5min) para anti-replay.
 *
 * Devuelve `{ valid: true }` si todo OK, o `{ valid: false, reason }`
 * con `reason ∈ { 'malformed_header', 'timestamp_skew_exceeded',
 * 'signature_mismatch' }`.
 */
export function verifySignature(
  secret: string,
  rawBody: string,
  header: string,
  opts: { maxSkewSeconds?: number; now?: number } = {},
):
  | { valid: true }
  | { valid: false; reason: 'malformed_header' | 'timestamp_skew_exceeded' | 'signature_mismatch' } {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: 'malformed_header' };

  const maxSkewSeconds = opts.maxSkewSeconds ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > maxSkewSeconds) {
    return { valid: false, reason: 'timestamp_skew_exceeded' };
  }

  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest();
  let received: Buffer;
  try {
    received = Buffer.from(parsed.v1, 'hex');
  } catch {
    return { valid: false, reason: 'malformed_header' };
  }
  if (received.length !== expected.length) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  if (!timingSafeEqual(received, expected)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}
