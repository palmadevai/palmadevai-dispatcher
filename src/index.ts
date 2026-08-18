/**
 * Entry point — boot order:
 *   1. env validated (zod fail-fast).
 *   2. metricsCollector instantiated.
 *   3. Redis Stream + Consumer Group ensured (XGROUP CREATE MKSTREAM, ignore
 *      BUSYGROUP).
 *   4. 3 workers started (dispatcher, recovery, metrics-flush — all STUB
 *      mode in F1.2.a).
 *   5. Fastify server starts (/health + /admin/queues).
 *   6. SIGTERM/SIGINT handlers for graceful shutdown.
 */
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { bullmqConnection, rawRedis } from './lib/redis.js';
import { sql } from './lib/postgres.js';
import { createMetaApiClient } from './lib/meta-api.js';
import { MetricsCollector } from './observability/metrics-collector.js';
import { startDispatcher } from './workers/dispatcher.js';
import { startRecovery } from './workers/recovery.js';
import { startMetricsFlush } from './workers/metrics-flush.js';
import { startCrmWebhookEmitter } from './workers/crm-webhook-emitter.js';
import { startWakeupSubscriber } from './workers/wakeup-subscriber.js';
import { startTemplateSync } from './workers/template-sync.js';
import { graphManagement } from './providers/whatsapp-management.js';
import { sendEmail } from './providers/email.js';
import type { ManagementDeps } from './core/management.js';
import { startServer } from './server.js';

async function ensureStreamAndGroup(): Promise<void> {
  try {
    await rawRedis.call(
      'XGROUP',
      'CREATE',
      env.CAMPAIGNS_STREAM,
      env.CAMPAIGNS_GROUP,
      '$',
      'MKSTREAM',
    );
    logger.info(
      { stream: env.CAMPAIGNS_STREAM, group: env.CAMPAIGNS_GROUP },
      'XGROUP CREATE ok (stream + group created)',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('BUSYGROUP')) {
      logger.info(
        { stream: env.CAMPAIGNS_STREAM, group: env.CAMPAIGNS_GROUP },
        'XGROUP already exists (idempotent)',
      );
    } else {
      throw err;
    }
  }
}

async function main(): Promise<void> {
  logger.info(
    {
      node_env: env.NODE_ENV,
      client_slug: env.CLIENT_SLUG,
      domain: env.DOMAIN,
      hostname_consumer: env.HOSTNAME,
      concurrency: env.DISPATCHER_CONCURRENCY,
      stub_mode: false,
    },
    'palmadevai-dispatcher boot start (F1.2.b real logic)',
  );

  const metricsCollector = new MetricsCollector();
  // metaApi facade is preserved for non-hot-path callers and health/ping uses.
  // The dispatcher hot path uses sendWhatsApp() directly.
  const metaApi = createMetaApiClient(logger);
  void metaApi;

  // 1. Asegurar stream + consumer group antes de levantar la lectura.
  await ensureStreamAndGroup();

  // 2. Workers (real impl — F1.2.b).
  const dispatcherHandle = startDispatcher({
    rawRedis,
    sql,
    logger,
    metricsCollector,
  });

  const recoveryHandle = startRecovery({
    rawRedis,
    sql,
    logger,
  });

  const metricsFlushHandle = startMetricsFlush({
    rawRedis,
    sql,
    logger,
    metricsCollector,
  });

  // Fase 6 Item 1 — CRM webhook emitter (outbox poller con HMAC).
  const crmWebhookEmitterHandle = startCrmWebhookEmitter({
    sql,
    logger,
  });

  // Wakeup subscriber — enqueue (n8n) publica a campaigns:enqueued; acá lo
  // consumimos y XADDeamos los pendings frescos al stream → envío inmediato
  // (sin esperar el recovery net de 5 min). Bug funcional fix 2026-06-01.
  const wakeupHandle = startWakeupSubscriber({
    rawRedis,
    sql,
    logger,
  });

  // F3 — management plane core deps: shared by the HTTP transport
  // (/management/*) and the template-sync cron worker (misma lógica, dos puertas).
  const managementCore: ManagementDeps = {
    sql,
    logger,
    graph: graphManagement,
    cockpitUrl: env.COCKPIT_URL,
    sendEmail,
  };

  const templateSyncHandle = startTemplateSync(managementCore, {
    intervalMinutes: env.DISPATCHER_TEMPLATE_SYNC_INTERVAL_MINUTES,
    stubMode: env.STUB_MODE,
  });

  // 3. HTTP server (healthcheck + Bull Board).
  const server = await startServer({
    bullmqConnection,
    rawRedis,
    sql,
    logger,
    metricsCollector,
    managementCore,
  });

  // bullmqConnection is still passed to the HTTP server because Bull Board
  // mounts a (mostly idle) BullMQ Queue handle for the operator UI — see
  // src/workers/README.md "Bull Board impact".
  void bullmqConnection;

  logger.info('dispatcher fully booted (real logic — XREADGROUP loop + DLQ + metrics)');

  // 4. Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received — closing workers + connections');
    try {
      clearInterval(recoveryHandle);
      clearInterval(metricsFlushHandle);
      clearInterval(crmWebhookEmitterHandle);
      templateSyncHandle.stop();
      await wakeupHandle.stop();
      await dispatcherHandle.stop();
      await server.close();
      await rawRedis.quit();
      await sql.end({ timeout: 5 });
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message, stack: (err as Error).stack }, 'fatal boot error');
  process.exit(1);
});
