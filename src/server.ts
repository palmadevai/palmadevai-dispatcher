/**
 * Fastify HTTP server. Routes:
 *   GET /health         — Docker healthcheck. Pinga Redis + Postgres con
 *                         timeout 2s c/u. 200 si todo ok, 503 si alguno falla.
 *   GET /admin/queues/* — Bull Board UI (BullMQ queue inspector + retry).
 *                         Auth: header X-Cockpit-Auth = COCKPIT_INTERNAL_TOKEN.
 *                         Si token env vacío, log warning + allow (DEV ONLY).
 *   POST /send          — Messaging Service H2.1 (bajo volumen, sincrónico).
 *                         Auth: Bearer DISPATCHER_SEND_BEARER. Ver
 *                         `transports/http/send-route.ts`.
 *   /management/*       — Messaging Service F3 (templates/endpoints/quality).
 *                         Mismo bearer que /send. Ver
 *                         `transports/http/management-routes.ts`.
 *   /mcp/messaging-v0   — Messaging MCP Tier 1 (F4, read-only, SSE). Bearer
 *                         propio MESSAGING_MCP_BEARER. Ver
 *                         `transports/mcp/routes.ts`.
 *
 * Cockpit consume /admin/queues vía reverse-proxy interno (red Docker `net`
 * compartida): https://cockpit.<DOMAIN>/admin/queues → http://dispatcher:8080/admin/queues
 * + session cookie del cockpit (auth conocida).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { Queue, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { env } from './env.js';
import type { Logger } from './lib/logger.js';
import type { SqlClient } from './lib/postgres.js';
import type { MetricsCollector } from './observability/metrics-collector.js';
import { registerSendRoute } from './transports/http/send-route.js';
import { registerManagementRoutes } from './transports/http/management-routes.js';
import { registerMcpRoutes } from './transports/mcp/routes.js';
import type { ManagementDeps } from './core/management.js';

export interface ServerDeps {
  bullmqConnection: ConnectionOptions;
  rawRedis: Redis;
  sql: SqlClient;
  logger: Logger;
  metricsCollector: MetricsCollector;
  /** F3 — deps del core de management (Graph adapter + email inyectados). */
  managementCore: ManagementDeps;
}

const HEALTHCHECK_PING_TIMEOUT_MS = 2000;

async function pingRedis(redis: Redis): Promise<boolean> {
  try {
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('redis ping timeout')), HEALTHCHECK_PING_TIMEOUT_MS),
      ),
    ]);
    return pong === 'PONG';
  } catch {
    return false;
  }
}

async function pingPostgres(sql: SqlClient): Promise<boolean> {
  try {
    const result = await Promise.race([
      sql`SELECT 1 AS ok`,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('postgres ping timeout')), HEALTHCHECK_PING_TIMEOUT_MS),
      ),
    ]);
    return Array.isArray(result) && result.length > 0;
  } catch {
    return false;
  }
}

const startTimestamp = Date.now();

export async function startServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { logger, bullmqConnection, rawRedis, sql, metricsCollector, managementCore } = deps;

  // Fastify 5 acepta un logger instance pre-built via la opción `loggerInstance`.
  // El cast a `any` evita el generic mismatch entre nuestros logger types y
  // los de Fastify (compatibles en runtime, divergen en typings).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: FastifyInstance = Fastify({
    loggerInstance: logger as any,
    disableRequestLogging: env.NODE_ENV === 'production',
    bodyLimit: 1024 * 1024, // 1MB — admin endpoints no necesitan más
  }) as any;

  // ── /health ─────────────────────────────────────────────────────────────
  app.get('/health', async (_req, reply) => {
    const [redisOk, postgresOk] = await Promise.all([
      pingRedis(rawRedis),
      pingPostgres(sql),
    ]);

    const healthy = redisOk && postgresOk;
    const body = {
      status: healthy ? 'healthy' : 'unhealthy',
      redis_ok: redisOk,
      postgres_ok: postgresOk,
      // F1.2.b: contar workers vivos (los pasamos al server desde index.ts).
      // Por ahora: hardcoded 3 (dispatcher + recovery + metrics-flush).
      bullmq_workers_count: 3,
      uptime_ms: Date.now() - startTimestamp,
      stub_mode: env.STUB_MODE,
    };
    return reply.code(healthy ? 200 : 503).send(body);
  });

  // ── /send (Messaging Service H2.1) ──────────────────────────────────────
  registerSendRoute(app, {
    sql,
    redis: rawRedis,
    logger,
    metricsCollector,
    sendBearer: env.DISPATCHER_SEND_BEARER,
    staffAllowlist: env.STAFF_NOTIFY_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean),
    defaultWaPhoneNumberId: env.META_WA_DEFAULT_PHONE_NUMBER_ID,
    defaultFromEmail: env.CAMPAIGNS_DEFAULT_FROM_EMAIL,
  });

  // ── /management/* (Messaging Service F3) ────────────────────────────────
  registerManagementRoutes(app, {
    core: managementCore,
    sendBearer: env.DISPATCHER_SEND_BEARER,
  });

  // ── /mcp/messaging-v0 (Messaging MCP: Tier 1 F4, Tier 2/3 F5) ───────────
  // Los tres cores se pasan siempre; qué tools se registran lo decide el scope
  // de la identidad que resuelva el bearer de cada conexión (identity.ts).
  registerMcpRoutes(app, {
    tools: {
      reads: { sql, redis: rawRedis, logger },
      management: managementCore,
      send: {
        sql,
        redis: rawRedis,
        logger,
        metrics: metricsCollector,
        staffAllowlist: env.STAFF_NOTIFY_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean),
        defaultWaPhoneNumberId: env.META_WA_DEFAULT_PHONE_NUMBER_ID,
        defaultFromEmail: env.CAMPAIGNS_DEFAULT_FROM_EMAIL,
      },
    },
    bearers: {
      read: env.MESSAGING_MCP_BEARER,
      write: env.MESSAGING_MCP_WRITE_BEARER,
    },
  });

  // ── /admin/queues (Bull Board) ──────────────────────────────────────────
  // Auth pre-handler: chequea X-Cockpit-Auth si COCKPIT_INTERNAL_TOKEN está
  // seteado. Si no, log warning una sola vez y permite (dev mode).
  let warnedOpenAdmin = false;
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/admin/queues')) return;
    if (!env.COCKPIT_INTERNAL_TOKEN) {
      if (!warnedOpenAdmin) {
        logger.warn(
          { url: req.url },
          'COCKPIT_INTERNAL_TOKEN not set — /admin/queues exposed without auth (DEV ONLY)',
        );
        warnedOpenAdmin = true;
      }
      return;
    }
    const provided = req.headers['x-cockpit-auth'];
    if (provided !== env.COCKPIT_INTERNAL_TOKEN) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // Bull Board setup. Necesita acceso al queue del worker — instanciamos un
  // Queue handle aquí (BullMQ Queue es liviano, solo wrapper para el inspector).
  const campaignsQueue = new Queue('campaigns', { connection: bullmqConnection });
  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: [new BullMQAdapter(campaignsQueue)],
    serverAdapter,
  });

  await app.register(serverAdapter.registerPlugin(), {
    prefix: '/admin/queues',
  });

  // ── Listen ──────────────────────────────────────────────────────────────
  const port = env.DISPATCHER_HEALTHCHECK_PORT;
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'HTTP server listening');

  return app;
}
