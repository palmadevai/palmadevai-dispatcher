/**
 * Defensive parser para el field `queued_at` que llega por Redis stream.
 *
 * Producer canónico (recovery worker safety net) usa `Date.toISOString()` →
 * `2026-05-28T12:34:56.123Z`. Pero hay 2 paths que entregan formatos sucios:
 *
 *   1. XADD manual del operador con texto pegado de SELECT en psql:
 *      `2026-05-28 12:34:56.123456+00` (espacio, microsegundos, offset corto).
 *      JS `new Date()` en Node 22 V8 devuelve Invalid Date para algunas
 *      combinaciones (especialmente offset sin colon `+00` vs `+00:00`).
 *
 *   2. n8n Redis publish con timestamp serialized desde Code node que usó
 *      la representación texto del row Postgres en vez de `.toISOString()`.
 *
 * Si `new Date(raw)` da Invalid, hacíamos cascade: `queuedAt.toISOString()`
 * en el retry ZSET path tira `Invalid time value` → `zadd` falla → retry se
 * pierde. Detectado durante smoke AI body Fase 4 2026-05-28.
 *
 * Estrategia: normalizar a ISO 8601 antes del constructor, y si todo falla,
 * caer a `new Date()` (= now) con un warning log al caller.
 */

const ISO_OFFSET_NO_COLON = /([+-]\d{2})(?!:|\d)/;

export interface ParseResult {
  date: Date;
  fallback: boolean; // true si usamos now() por raw inválido
  normalized?: string; // formato post-normalización (debug)
}

export function parseQueuedAt(raw: string | undefined | null): ParseResult {
  if (!raw) {
    return { date: new Date(), fallback: true };
  }

  // Fast path: ISO ya válido.
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) {
    return { date: direct, fallback: false };
  }

  // Epoch ms como string ("1748456789012" o "1748456789012.345"). V8 trata
  // strings numéricas como Invalid Date — convertir a número primero.
  // El n8n trigger-evaluate workflow devuelve `queued_at_ms` con EXTRACT
  // EPOCH * 1000 (float). Si algo aguas abajo lo XADDea como string, cae acá.
  if (/^\d{10,16}(\.\d+)?$/.test(raw.trim())) {
    const asNum = Number(raw.trim());
    const fromEpoch = new Date(asNum);
    if (!Number.isNaN(fromEpoch.getTime())) {
      return { date: fromEpoch, fallback: false, normalized: `epoch_ms=${asNum}` };
    }
  }

  // Normalización: Postgres text format → ISO.
  //   "2026-05-28 12:34:56.123456+00"     → "2026-05-28T12:34:56.123456+00:00"
  //   "2026-05-28 12:34:56.123456+00:00"  → "2026-05-28T12:34:56.123456+00:00"
  //   "2026-05-28 12:34:56+00"            → "2026-05-28T12:34:56+00:00"
  let s = raw.trim();
  // Espacio → T
  if (s.includes(' ') && !s.includes('T')) {
    s = s.replace(' ', 'T');
  }
  // Offset corto +00 / -03 → +00:00 / -03:00 (sin tocar si ya tiene `:`)
  s = s.replace(ISO_OFFSET_NO_COLON, '$1:00');

  const normalized = new Date(s);
  if (!Number.isNaN(normalized.getTime())) {
    return { date: normalized, fallback: false, normalized: s };
  }

  // Último recurso: now(). El caller debe loguear; el SELECT FOR UPDATE
  // con BETWEEN ±1ms va a fallar (no encontrar el row), y la entrada del
  // stream va a XACK-skip + recovery worker la repesca.
  return { date: new Date(), fallback: true, normalized: s };
}
