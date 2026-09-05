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
import { MetricsCollector } from './observability/metrics-collector.js';
import { startDispatcher } from './workers/dispatcher.js';
import { startRecovery } from './workers/recovery.js';
import { startMetricsFlush } from './workers/metrics-flush.js';
import { startCrmWebhookEmitter } from './workers/crm-webhook-emitter.js';
import { startWakeupSubscriber } from './workers/wakeup-subscriber.js';
import { startTemplateSync } from './workers/template-sync.js';
import { graphManagement } from './providers/whatsapp-management.js';
import { sendMessage, type SendDeps } from './core/messaging.js';
import type { NotifyDeps } from './core/notify.js';
import { normalizeAllowlist } from './lib/phone.js';
import { readChannelWhatsAppConfig } from './lib/providers.js';
import type { ManagementDeps } from './core/management.js';
import { startServer } from './server.js';
import { probeSchemaState, decideBoot } from './lib/schema-probe.js';
import { announceOnce } from './lib/pg-errors.js';

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

  // 1. Asegurar stream + consumer group antes de levantar la lectura.
  await ensureStreamAndGroup();

  // ── Envío y avisos, armados UNA vez ───────────────────────────────────────
  // `sendDeps` estaba duplicado en `server.ts` (ruta /send + tools MCP). Se
  // arma acá porque los avisos (`notifyDeps`) los necesitan tres consumidores
  // que NO cuelgan del server: el template-sync, el DLQ y el recovery.
  //
  // La allowlist se normaliza sólo para AVISAR de lo que no normaliza: un valor
  // que no es E.164 no va a matchear nunca, y dejarlo pasar en silencio es
  // prometer una autorización que no existe. La comparación real vuelve a
  // normalizar del lado de `sendMessage`.
  const staffAllowlist = env.STAFF_NOTIFY_ALLOWLIST.split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  {
    const { allowed, invalid } = normalizeAllowlist(staffAllowlist);
    if (invalid.length > 0) {
      logger.warn(
        { invalid_count: invalid.length, valid_count: allowed.length },
        'STAFF_NOTIFY_ALLOWLIST: hay valores que no son un teléfono E.164 — nunca van a matchear',
      );
    }
  }

  // Resolver inyectado (no un valor baked al boot): DB
  // `bot.config['channel_whatsapp'].default_phone_number_id` → env
  // `META_WA_DEFAULT_PHONE_NUMBER_ID`, cacheado 30 s en `lib/providers.ts`. El
  // cockpit puede cambiar el teléfono default sin redeploy.
  const resolveDefaultPhoneNumberId = async (): Promise<string | null> =>
    (await readChannelWhatsAppConfig()).defaultPhoneNumberId;

  const sendDeps: SendDeps = {
    sql,
    redis: rawRedis,
    logger,
    metrics: metricsCollector,
    staffAllowlist,
    resolveDefaultPhoneNumberId,
    defaultFromEmail: env.CAMPAIGNS_DEFAULT_FROM_EMAIL,
  };

  // F7.5 — la mecánica de los avisos, una sola instancia para todo el proceso.
  const notifyDeps: NotifyDeps = {
    sql,
    logger,
    send: (msg) => sendMessage(sendDeps, msg),
  };

  // F9.6 — el esquema que este cliente CONTRATÓ, sondeado una vez. Decide qué
  // workers arrancan y si el proceso queda degradado (ver lib/schema-probe.ts).
  const schema = await probeSchemaState(sql);
  const boot = decideBoot(schema);
  if (!boot.campaignsWorkers) {
    announceOnce(
      logger,
      'boot:campaigns-schema',
      { missing: schema.missing.filter((n) => !n.includes('outbound_endpoints') && !n.includes('message_templates')) },
      'sin esquema de campañas — los workers de campañas (stream, recovery, wakeup, webhooks CRM) no arrancan; esperado en un cliente sin la feature',
    );
  }
  for (const reason of boot.degradedReasons) {
    logger.warn({ missing: schema.missing }, `boot DEGRADADO — ${reason}`);
  }

  // 2. Workers (real impl — F1.2.b). Los de campañas, sólo con su esquema.
  const dispatcherHandle = boot.campaignsWorkers
    ? startDispatcher({
        rawRedis,
        sql,
        logger,
        metricsCollector,
        notify: notifyDeps,
      })
    : null;

  const recoveryHandle = boot.campaignsWorkers
    ? startRecovery({
        rawRedis,
        sql,
        logger,
        notify: notifyDeps,
      })
    : null;

  const metricsFlushHandle = startMetricsFlush({
    rawRedis,
    sql,
    logger,
    metricsCollector,
  });

  // Fase 6 Item 1 — CRM webhook emitter (outbox poller con HMAC).
  const crmWebhookEmitterHandle = boot.campaignsWorkers
    ? startCrmWebhookEmitter({
        sql,
        logger,
      })
    : null;

  // Wakeup subscriber — enqueue (n8n) publica a campaigns:enqueued; acá lo
  // consumimos y XADDeamos los pendings frescos al stream → envío inmediato
  // (sin esperar el recovery net de 5 min). Bug funcional fix 2026-06-01.
  const wakeupHandle = boot.campaignsWorkers
    ? startWakeupSubscriber({
        rawRedis,
        sql,
        logger,
      })
    : null;

  // F3 — management plane core deps: shared by the HTTP transport
  // (/management/*) and the template-sync cron worker (misma lógica, dos puertas).
  const managementCore: ManagementDeps = {
    sql,
    logger,
    graph: graphManagement,
    cockpitUrl: env.COCKPIT_URL,
    notify: notifyDeps,
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
    sendDeps,
    notifyDeps,
    // F9.6 — lo que /health tiene que decir del esquema y del estado del proceso.
    schema,
    degradedReasons: boot.degradedReasons,
    workersCount: (boot.campaignsWorkers ? 4 : 0) + 2,
  });

  // bullmqConnection is still passed to the HTTP server because Bull Board
  // mounts a (mostly idle) BullMQ Queue handle for the operator UI — see
  // src/workers/README.md "Bull Board impact".
  void bullmqConnection;

  logger.info(
    { schema, campaigns_workers: boot.campaignsWorkers, degraded: boot.degradedReasons.length > 0 },
    'dispatcher fully booted (real logic — XREADGROUP loop + DLQ + metrics)',
  );

  // 4. Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received — closing workers + connections');
    try {
      if (recoveryHandle) clearInterval(recoveryHandle);
      clearInterval(metricsFlushHandle);
      if (crmWebhookEmitterHandle) clearInterval(crmWebhookEmitterHandle);
      templateSyncHandle.stop();
      if (wakeupHandle) await wakeupHandle.stop();
      if (dispatcherHandle) await dispatcherHandle.stop();
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
