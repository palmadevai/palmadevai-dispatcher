/**
 * Resolver de proveedores externos (T5.1 / T5.4 del plan de servicios/email).
 *
 * CONTRATO: el llamador pide la credencial por `provider_id` y **no sabe ni le
 * importa de quién es la cuenta**. Hoy todas son `managed` (nuestras); mañana un
 * cliente trae la suya (BYOK, `owned`) y el llamador no cambia una línea.
 *
 * POR QUÉ ACÁ Y NO EN CADA EMISOR
 *
 * R5 dice *«resolver ≠ emisor: componen»* — no que cada emisor necesite el
 * suyo. El dispatcher **es** el messaging service, así que este es el lugar
 * donde el resolver vive **una vez**. Cuando el cockpit y el chat-site migren a
 * `/send` (T9.4), heredan este resolver y borran el propio.
 *
 * `key_ref` es una **referencia** (el nombre de la env), nunca el secreto.
 * Cuando exista el cifrado en reposo de las keys `owned` (T7.2), este es el
 * único lugar que cambia.
 *
 * FALLBACK, A PROPÓSITO (T5.6)
 *
 * El deploy es GitOps pull con ~3 min de latencia y sin gate: si este código
 * aterriza antes que las filas del modelo, sin fallback se corta el correo de
 * los tres clientes a la vez. "Sin fila en la DB" no es un error — es el estado
 * normal de la transición.
 */
import { sql } from './postgres.js';
import { env } from '../env.js';
import { logger } from './logger.js';
import { loadProviderCredential } from '../core/provider-credentials.js';

export type ProviderId = 'resend' | 'meta' | 'openai';

/** Env canónica por proveedor. Es el fallback de T5.6, no la fuente de verdad. */
const ENV_FALLBACK: Record<ProviderId, string> = {
  resend: 'RESEND_API_KEY',
  // S5.1 (ADR-005): los otros dos secretos que consume el dispatcher entran al
  // MISMO resolver — piso 1 con fallback a env mientras dura la transición.
  // `meta` es el bearer de la Cloud API (canal WhatsApp); `openai` es la key
  // de personalización de campañas. Sin fila en el modelo ni credencial en el
  // vault, resuelven por env como siempre — cero cambio de comportamiento.
  meta: 'META_WA_BEARER_TOKEN',
  openai: 'OPENAI_API_KEY__CAMPAIGNS__DISPATCHER__PERSONALIZE_OPENAI',
};

// Cache corto: un envío no puede pagar un round-trip por mail, pero tampoco
// puede quedar pegado a una credencial vieja después de un cutover. 30 s es más
// corto que el ciclo del deploy (~3 min), así que un cambio se toma solo.
const TTL_MS = 30_000;

type Row = { key_ref: string | null; status: string | null; ownership: string | null };
const keyCache = new Map<string, { at: number; row: Row | null }>();
let mailCache: { at: number; from: string | null } | null = null;

async function readProviderRow(id: ProviderId): Promise<Row | null> {
  const hit = keyCache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;

  let row: Row | null = null;
  try {
    const rows = await sql<Row[]>`
      SELECT key_ref, status, ownership FROM config.v_client_providers WHERE id = ${id}
    `;
    row = rows[0] ?? null;
  } catch (err) {
    // La vista todavía no existe (mig 142 sin aplicar) o la DB no responde.
    // No es un error del llamador: se cae al env, que es el estado previo.
    logger.debug({ err, provider: id }, 'providers: sin modelo, uso el env');
    row = null;
  }
  keyCache.set(id, { at: Date.now(), row });
  return row;
}

export type ResolvedKey =
  | { ok: true; apiKey: string; source: 'vault' | 'db' | 'env' }
  | { ok: false; error: string };

/**
 * Credencial vigente del proveedor, sin exponer de quién es la cuenta.
 *
 * Tres pasos, en orden (§4.7 de `analysis-secretos-en-reposo.md`):
 *
 *   1. `ownership='owned'` + ciphertext  → descifrar        (`vault`)
 *   2. `key_ref` del modelo              → `env[key_ref]`   (`db`)
 *   3. `ENV_FALLBACK[id]`                → env              (`env`)
 *
 * **El paso 1 se activa SÓLO con `ownership='owned'`.** Mientras el estado es
 * `pending_verification` la credencial nueva ya está guardada pero **no se
 * usa**: el correo sigue saliendo con la nuestra. Es lo que hace que una key
 * mal cargada no le rompa el mail a nadie, y es la mitad del gate del cutover
 * (T7.3 / T9.8.3).
 */
export async function resolveProviderKey(id: ProviderId): Promise<ResolvedKey> {
  const row = await readProviderRow(id);

  // ── Paso 1: la credencial del cliente (BYOK) ────────────────────────────
  if (row?.ownership === 'owned') {
    const loaded = await loadProviderCredential(
      { sql, logger, clientSlug: env.CLIENT_SLUG },
      id,
    );
    if (loaded.ok) return { ok: true, apiKey: loaded.credential, source: 'vault' };

    // ⚠ NO se cae al env. El cliente está en `owned`: mandar con la credencial
    // `managed` sería emitir su correo DESDE NUESTRA CUENTA, que es justo lo
    // que el BYOK evita. Falla cerrado y con la causa nombrada.
    return {
      ok: false,
      error: `${id}: la cuenta es del cliente (owned) y su credencial no se pudo usar — ${loaded.message}`,
    };
  }

  const envName = row?.key_ref?.trim() || ENV_FALLBACK[id];
  const apiKey = (env as unknown as Record<string, string | undefined>)[envName];

  if (!apiKey) {
    // El error nombra la env concreta: es lo único accionable en un log.
    return { ok: false, error: `${id}: falta la credencial (${envName} sin valor)` };
  }
  return { ok: true, apiKey, source: row?.key_ref ? 'db' : 'env' };
}

/**
 * Remitente por defecto del cliente, desde `bot.config['branding'].email_from`
 * — donde ya vive y de donde lo leen los seis workflows de n8n.
 *
 * ⚠ Devuelve `null` si no hay dato, y eso es deliberado: **no hay default**.
 * Un default es lo que dejó entrar el sandbox de Resend como remitente de
 * clientes reales — `onboarding@resend.dev` devuelve 200 y entrega **al dueño
 * de la cuenta**, así que una campaña se reportaba enviada y no llegaba a
 * nadie. Sin remitente no se manda, igual que el gate de los workflows.
 */
export async function resolveDefaultFrom(): Promise<string | null> {
  if (mailCache && Date.now() - mailCache.at < TTL_MS) return mailCache.from;

  let from: string | null = null;
  try {
    const rows = await sql<Array<{ email_from: string | null }>>`
      SELECT value->>'email_from' AS email_from FROM bot.config WHERE key = 'branding'
    `;
    const v = rows[0]?.email_from;
    from = typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch (err) {
    logger.debug({ err }, 'providers: sin branding en DB, uso el env');
    from = null;
  }

  // Fallback de transición: el `.env` sigue siendo válido hasta que el dato esté
  // cargado en los tres clientes. NO es un default inventado — es el mismo dato,
  // en su ubicación anterior.
  if (!from) {
    const v = env.CAMPAIGNS_DEFAULT_FROM_EMAIL;
    from = typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  mailCache = { at: Date.now(), from };
  return from;
}

/**
 * Config del canal WhatsApp (dispatcher#feat-channel-whatsapp-config).
 *
 * `META_WA_WABA_ID` / `META_WA_DEFAULT_PHONE_NUMBER_ID` son configuración NO
 * SECRETA del cliente (criterio del handbook: «¿hay que rotarlo si se
 * filtra? No → config, no BW/env»). Hoy sólo salen del `.env`; pasan a poder
 * vivir en `bot.config['channel_whatsapp']` (jsonb `{waba_id,
 * default_phone_number_id}`), que el cockpit va a editar sin redeploy.
 *
 * MISMO patrón que `readProviderRow`/`resolveDefaultFrom`: cache in-process
 * TTL 30 s, `pool.connect` dentro del try, error de DB → fallback a env sin
 * tirar.
 *
 * FALLBACK POR CAMPO, no por objeto: si la DB trae `waba_id` pero no
 * `default_phone_number_id` (o viceversa), el campo faltante cae a SU PROPIA
 * env — no se descarta la fila entera. Es el mismo espíritu del piso 1
 * (T5.6): una fila parcial en el modelo no puede ser peor que no tener fila.
 */
export interface ChannelWhatsAppConfig {
  wabaId: string | null;
  defaultPhoneNumberId: string | null;
  /** 'db' si ALGÚN campo resolvió por DB; si no, 'env' si alguno resolvió por env; si no, 'none'. */
  source: 'db' | 'env' | 'none';
}

type ChannelWhatsAppRow = { waba_id: string | null; default_phone_number_id: string | null };
let channelWhatsAppCache: { at: number; row: ChannelWhatsAppRow | null } | null = null;

async function readChannelWhatsAppRow(): Promise<ChannelWhatsAppRow | null> {
  if (channelWhatsAppCache && Date.now() - channelWhatsAppCache.at < TTL_MS) {
    return channelWhatsAppCache.row;
  }

  let row: ChannelWhatsAppRow | null = null;
  try {
    const rows = await sql<ChannelWhatsAppRow[]>`
      SELECT value->>'waba_id' AS waba_id,
             value->>'default_phone_number_id' AS default_phone_number_id
        FROM bot.config WHERE key = 'channel_whatsapp'
    `;
    row = rows[0] ?? null;
  } catch (err) {
    // Igual que readProviderRow: sin modelo (o DB caída) no es un error del
    // llamador — se cae al env, que es el estado previo a esta feature.
    logger.debug({ err }, 'providers: sin channel_whatsapp en DB, uso el env');
    row = null;
  }
  channelWhatsAppCache = { at: Date.now(), row };
  return row;
}

/** `''` de la DB o del env cuenta como AUSENTE — nunca como valor. */
function nonEmpty(v: string | null | undefined): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export async function readChannelWhatsAppConfig(): Promise<ChannelWhatsAppConfig> {
  const row = await readChannelWhatsAppRow();

  const dbWaba = nonEmpty(row?.waba_id);
  const dbPhone = nonEmpty(row?.default_phone_number_id);
  const envWaba = nonEmpty(env.META_WA_WABA_ID);
  const envPhone = nonEmpty(env.META_WA_DEFAULT_PHONE_NUMBER_ID);

  const wabaId = dbWaba ?? envWaba;
  const defaultPhoneNumberId = dbPhone ?? envPhone;

  const anyDb = dbWaba !== null || dbPhone !== null;
  const anyEnv = envWaba !== null || envPhone !== null;
  const source: ChannelWhatsAppConfig['source'] = anyDb ? 'db' : anyEnv ? 'env' : 'none';

  return { wabaId, defaultPhoneNumberId, source };
}

/** Invalida el cache de config del canal WhatsApp — mismo motivo que T7.4. */
export function invalidateChannelWhatsAppCache(): void {
  channelWhatsAppCache = null;
}

/**
 * Invalida el cache de un proveedor (o de todos) — T7.4.
 *
 * El TTL de 30 s ya haría que un cutover se tome solo, y por eso esto **no es
 * lo que hace correcto al cutover**: es lo que evita la ventana en la que el
 * operador ve «listo» en la UI y el mail siguiente sale todavía con la
 * credencial vieja. Media ventana de 30 s alcanza para que alguien concluya
 * que el cutover no funcionó y lo repita.
 *
 * ⚠️ Es del PROCESO. Con `DISPATCHER_REPLICAS > 1` cada réplica tiene el suyo,
 * así que las demás siguen pagando el TTL. No se resuelve con un broadcast:
 * 30 s de convergencia es exactamente lo que el diseño ya aceptó (§5.2).
 */
export function invalidateProviderCache(id?: ProviderId): void {
  if (id) keyCache.delete(id);
  else keyCache.clear();
}

/** Sólo para tests: los caches son del proceso y no se comparten entre casos. */
export function __resetProviderCache(): void {
  keyCache.clear();
  mailCache = null;
  channelWhatsAppCache = null;
}
