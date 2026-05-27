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
  HOSTNAME: z.string().default('dispatcher-0'),
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
