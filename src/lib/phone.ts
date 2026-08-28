/**
 * Normalización a E.164 — la forma canónica de un teléfono en toda la flota.
 *
 * E.164 estricto es `+` seguido de 8 a 15 dígitos. Es lo que enforcean las
 * constraints `leads_phone_e164` / `personas_phone_e164` en la base y
 * lo que valida el ingest del cockpit (`normalizePhoneE164` en
 * `cockpit/src/lib/external-api.ts`). Acá se replica el mismo criterio.
 *
 * Lo único que agregamos es tolerancia de ENTRADA para valores cargados a mano
 * —típicamente en un `.env`— que vienen sin el `+` o con separadores:
 *
 *     "549 11 4540-2018"  →  "+5491145402018"
 *     "5491145402018"     →  "+5491145402018"
 *     "+5491145402018"    →  "+5491145402018"
 *
 * NO intentamos interpretar texto libre ni inferir país: eso es trabajo de
 * `libphonenumber-js` en el sub-workflow de n8n, y meterlo acá sería adivinar.
 * Lo que no normaliza devuelve `null`, que es distinto de "no coincide".
 *
 * Incidente que lo motivó (2026-08-03): el teléfono del asesor estaba en
 * `bot.agents.phone_e164` como `+549…` y en `STAFF_NOTIFY_ALLOWLIST` como
 * `549…`. Mismo número, comparación literal, 403 en cada notificación de
 * `ai-recovery-scheduler`. El bug no era el dato: era comparar sin normalizar.
 */

const E164 = /^\+\d{8,15}$/;

/** Devuelve el teléfono en E.164 canónico, o `null` si no es un teléfono válido. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // separadores de presentación; NO tocamos el `+` ni los dígitos
  const cleaned = raw.trim().replace(/[\s\-().]/g, '');
  if (!cleaned) return null;
  const withPlus = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  return E164.test(withPlus) ? withPlus : null;
}

/**
 * Normaliza una allowlist cargada a mano. Los valores que no normalizan se
 * descartan y se reportan: **un valor que no normaliza no va a matchear nunca**,
 * así que dejarlo pasar en silencio es prometer una autorización que no existe.
 */
export function normalizeAllowlist(values: string[]): { allowed: string[]; invalid: string[] } {
  const allowed: string[] = [];
  const invalid: string[] = [];
  for (const v of values) {
    const e164 = toE164(v);
    if (e164) allowed.push(e164);
    else invalid.push(v);
  }
  return { allowed, invalid };
}
