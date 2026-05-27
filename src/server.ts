/**
 * Fastify HTTP server. Routes:
 *   GET /health         — Docker healthcheck. Pinga Redis + Postgres con
 *                         timeout 2s c/u. 200 si todo ok, 503 si alguno falla.
 *   GET /admin/queues/* — Bull Board UI (BullMQ queue inspector + retry).
 *                         Auth: header X-Cockpit-Auth = COCKPIT_INTERNAL_TOKEN.
 *                         Si token env vacío, log warning + allow (DEV ONLY).
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

export interface ServerDeps {
  bullmqConnection: ConnectionOptions;
  rawRedis: Redis;
  sql: SqlClient;
  logger: Logger;
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
  const { logger, bullmqConnection, rawRedis, sql } = deps;

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
