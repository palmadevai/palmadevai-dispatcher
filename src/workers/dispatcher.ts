/**
 * Dispatcher worker — BullMQ Worker que consume jobs del queue 'campaigns'.
 *
 * F1.2.a (skeleton): logea + ACKea jobs sin procesarlos. Esto sirve para
 * verificar que la conexión BullMQ↔Redis levanta correctamente, el rate
 * limiter está configurado, y que el container reporta los workers en /health.
 *
 * F1.2.b (próximo PR): implementación completa según spec.md §5.3:
 *   1. SELECT bot.campaign_deliveries WHERE id=$1 FOR UPDATE SKIP LOCKED
 *   2. pickPhone(audience_contact_id) → sticky assignment ADR-013
 *   3. metaApi.sendMessage({ ..., client_ref: delivery.client_ref })
 *      con biz_opaque_callback_data (ADR-011 idempotency)
 *   4. classifyError() en catch → DLQ vs retry (ADR-009)
 *   5. UPDATE deliveries SET status='accepted', meta_message_id, accepted_at
 *   6. Redis PUBLISH campaigns:updates:<campaign_id> para SSE (ADR-005)
 *   7. metricsCollector.recordSend(latencyMs)
 */
import { Worker, type Job, type ConnectionOptions } from 'bullmq';
import { env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { SqlClient } from '../lib/postgres.js';
import type { MetaApi } from '../lib/meta-api.js';
import type { MetricsCollector } from '../observability/metrics-collector.js';

export interface DispatcherDeps {
  connection: ConnectionOptions;
  sql: SqlClient;
  logger: Logger;
  metaApi: MetaApi;
  metricsCollector: MetricsCollector;
}

export interface CampaignJobData {
  delivery_id: number;
  campaign_id: number;
  audience_contact_id: number;
  // Más campos llegan en F1.2.b al hacer XADD en el workflow campaigns-enqueue.
  [key: string]: unknown;
}

export function startDispatcher(deps: DispatcherDeps): Worker<CampaignJobData> {
  const { logger, metricsCollector } = deps;

  logger.info(
    {
      concurrency: env.DISPATCHER_CONCURRENCY,
      rate_burst_mps: env.CAMPAIGNS_DEFAULT_RATE_BURST_MPS,
      attempts: env.DISPATCHER_BULLMQ_ATTEMPTS,
      backoff_ms: env.DISPATCHER_BULLMQ_BACKOFF_MS,
    },
    'starting BullMQ dispatcher worker (STUB mode — F1.2.a)',
  );

  const worker = new Worker<CampaignJobData>(
    'campaigns',
    async (job: Job<CampaignJobData>) => {
      // STUB. Real impl en F1.2.b — ver doc en file header.
      logger.info(
        {
          job_id: job.id,
          delivery_id: job.data?.delivery_id,
          campaign_id: job.data?.campaign_id,
          attempts_made: job.attemptsMade,
        },
        'STUB: received job, returning success without processing',
      );
      metricsCollector.recordDequeue();
      return { skipped: 'stub', delivery_id: job.data?.delivery_id ?? null };
    },
    {
      connection: deps.connection,
      concurrency: env.DISPATCHER_CONCURRENCY,
      // BullMQ rate limiter nativo (ADR-004). Burst MPS cap absoluto 80 = Meta
      // tier ceiling. Per-campaign override en bot.campaigns.rate_limit_mps
      // viene en F1.2.b (per-job concurrency mode).
      limiter: {
        max: env.CAMPAIGNS_DEFAULT_RATE_BURST_MPS,
        duration: 1000,
      },
    },
  );

  worker.on('completed', (job) => {
    logger.debug({ job_id: job.id }, 'job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { job_id: job?.id, err: err.message, stack: err.stack },
      'job failed',
    );
    metricsCollector.recordError('worker_failed');
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'worker error event');
  });

  return worker;
}
