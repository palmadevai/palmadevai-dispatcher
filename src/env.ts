/**
 * Env vars validados con Zod. Fail-fast: si falta una required, el proceso
 * crashea con un error explícito al boot (mejor que NPE en runtime 3 horas
 * después).
 *
 * Source of truth: palmadevai-apps/features/campaigns/manifest.yaml env_required.
 * Defaults aquí matchean los del manifest.
 */
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),

  // ── Worker config ────────────────────────────────────────────────────────
  DISPATCHER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  DISPATCHER_BATCH_SIZE: z.coerce.number().int().min(1).default(50),
  DISPATCHER_HEALTHCHECK_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DISPATCHER_METRICS_FLUSH_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
  DISPATCHER_BULLMQ_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  DISPATCHER_BULLMQ_BACKOFF_MS: z.coerce.number().int().min(1000).default(60000),

  // ── Redis ────────────────────────────────────────────────────────────────
  REDIS_HOST: z.string().default('redis'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: z.string().min(1, 'REDIS_PASSWORD required'),
  REDIS_DB: z.coerce.number().int().default(0),
  CAMPAIGNS_STREAM: z.string().default('campaigns:stream'),
  CAMPAIGNS_GROUP: z.string().default('dispatchers'),

  // ── Postgres ─────────────────────────────────────────────────────────────
  APPDB_HOST: z.string().default('postgresql'),
  APPDB_PORT: z.coerce.number().int().default(5432),
  APPDB_USER: z.string().default('appdb_user'),
  APPDB_PASSWORD: z.string().min(1, 'APPDB_PASSWORD required'),
  APPDB_DATABASE: z.string().default('appdb'),
  DB_SCHEMA: z.string().default('bot'),

  // ── Meta WhatsApp Cloud API ──────────────────────────────────────────────
  META_WA_BEARER_TOKEN: z.string().min(1, 'META_WA_BEARER_TOKEN required'),
  META_WA_APP_SECRET: z.string().min(1, 'META_WA_APP_SECRET required'),
  META_WA_WABA_ID: z.string().min(1, 'META_WA_WABA_ID required'),
  META_WA_DEFAULT_PHONE_NUMBER_ID: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default('v17.0'),

  // ── Rate limits ──────────────────────────────────────────────────────────
  CAMPAIGNS_DEFAULT_RATE_BURST_MPS: z.coerce.number().int().default(10),
  CAMPAIGNS_DEFAULT_DAILY_CAP_OVERRIDE: z.coerce.number().int().optional(),

  // ── Bull Board auth ──────────────────────────────────────────────────────
  // Opcional en F1.2.a (skeleton). En F1.2.b será required para producción —
  // por ahora si vacío el server arranca con un warning.
  COCKPIT_INTERNAL_TOKEN: z.string().optional(),

  // ── Cliente metadata ─────────────────────────────────────────────────────
  CLIENT_SLUG: z.string().min(1, 'CLIENT_SLUG required'),
  DOMAIN: z.string().min(1, 'DOMAIN required'),
  COCKPIT_URL: z.string().url().optional(),

  // HOSTNAME = consumer_name dentro del Consumer Group (BullMQ + Redis
  // Streams). Cada replica del worker tiene PEL separada por consumer_name.
  // En docker-compose, el HOSTNAME viene del container; fallback "dispatcher-0".
  // Zod min(1) impide cadena vacía — docker-compose con `HOSTNAME: ${HOSTNAME:-}`
  // pasaría empty string, que rompía silenciosamente XREADGROUP (rutea a
  // consumer sin nombre, no entrega). Si llega empty/missing, default "dispatcher-0".
  HOSTNAME: z
    .string()
    .transform((v) => (v === '' ? 'dispatcher-0' : v))
    .default('dispatcher-0'),

  // STUB_MODE: si true, los workers loguean intención pero NO ejecutan side
  // effects reales (no Meta POST, no DLQ insert, no metrics flush). Default
  // false (= F1.2.b real). Útil para development local sin tocar Meta API.
  STUB_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ── AI body personalization (Fase 4 item 3) ──────────────────────────────
  // OpenAI key para sustituir {{ai_generated}} bindings. Si falta + alguna
  // campaign tiene ai_personalization_enabled=true → el dispatcher loguea
  // warning y deja el binding como literal '{{ai_generated}}'. Sin esta key,
  // las campañas AI no rompen el motor — solo no personalizan.
  // Convención per-node Fase 2e:
  // OPENAI_API_KEY__CAMPAIGNS__DISPATCHER__PERSONALIZE_OPENAI
  OPENAI_API_KEY__CAMPAIGNS__DISPATCHER__PERSONALIZE_OPENAI: z.string().optional(),
  AI_PERSONALIZE_DEFAULT_MODEL: z.string().default('gpt-5.4-mini'),
  AI_PERSONALIZE_DEFAULT_MAX_TOKENS: z.coerce.number().int().min(50).max(2000).default(200),
  AI_PERSONALIZE_DEFAULT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  AI_PERSONALIZE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),

  // ── Email channel (Fase 5 Item 1 — Resend) ───────────────────────────────
  // Optional: if missing, email deliveries fail terminally with
  // `error_code='resend_api_key_missing'` (classified payload_invalid, no retry).
  // The dispatcher boots fine — only campaigns with channel='email' are blocked.
  RESEND_API_KEY: z.string().optional(),
  // Default From for email campaigns. Per-campaign override comes from
  // template.body.from once cockpit UI ships (PR3). Sandbox default below
  // works only for the Resend account owner; configure a verified domain
  // before launching real campaigns.
  CAMPAIGNS_DEFAULT_FROM_EMAIL: z.string().default('onboarding@resend.dev'),
  // Public unsubscribe link prefix injected in every email footer. Final URL is
  // `<base>/u/<audience_contact_id>`. Default derives from DOMAIN at boot.
  CAMPAIGNS_UNSUBSCRIBE_BASE_URL: z.string().optional(),

  // ── CRM webhooks salientes (Fase 6 Item 1) ───────────────────────────────
  // Worker crm-webhook-emitter polea bot.crm_webhook_deliveries cada
  // INTERVAL_MS, dispatcha hasta BATCH_SIZE filas por tick con HMAC firmado.
  // Defaults coinciden con manifest features/campaigns/manifest.yaml. timeout
  // y max_attempts son per-endpoint (columnas en bot.crm_webhook_endpoints).
  CAMPAIGNS_WEBHOOK_EMITTER_INTERVAL_MS: z.coerce.number().int().min(500).default(2000),
  CAMPAIGNS_WEBHOOK_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  CAMPAIGNS_WEBHOOK_USER_AGENT: z.string().default('palmadev-webhooks/1'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('FATAL: env validation failed');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
