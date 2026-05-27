/**
 * Metrics flush worker — cron 30s (configurable via env). Lee snapshot del
 * MetricsCollector + queue depth via XLEN, hace INSERT a bot.dispatcher_metrics.
 *
 * F1.2.a (skeleton): loguea el snapshot a stdout. NO escribe a Postgres.
 *
 * F1.2.b (próximo PR):
 *   1. queue_depth = await rawRedis.xlen(stream)
 *   2. INSERT INTO bot.dispatcher_metrics (
 *        ts, hostname, queue_depth, dequeue_rate_60s, send_latency_p50_ms,
 *        send_latency_p95_ms, send_latency_p99_ms, error_count_5m,
 *        error_ratio_5m, send_count_5m
 *      ) VALUES (...)
 *   3. (opcional) prune via pg_cron job '0 3 * * *' retention 7d.
 *
 * Ver spec.md §5.3 (metrics-flush) + ADR-012 SRE metrics + migration 051.
 */
import type { Redis } from 'ioredis';
import { env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { SqlClient } from '../lib/postgres.js';
import type { MetricsCollector } from '../observability/metrics-collector.js';

export interface MetricsFlushDeps {
  rawRedis: Redis;
  sql: SqlClient;
  logger: Logger;
  metricsCollector: MetricsCollector;
}

export function startMetricsFlush(deps: MetricsFlushDeps): NodeJS.Timeout {
  const { logger, metricsCollector, rawRedis } = deps;
  const intervalMs = env.DISPATCHER_METRICS_FLUSH_INTERVAL_SECONDS * 1000;

  logger.info({ interval_ms: intervalMs }, 'starting metrics-flush worker (STUB mode — F1.2.a)');

  const tick = async (): Promise<void> => {
    try {
      // Queue depth desde Redis (cuesta poco y conviene tenerlo aunque sea stub).
      let depth = 0;
      try {
        depth = await rawRedis.xlen(env.CAMPAIGNS_STREAM);
      } catch (err) {
        const error = err as Error;
        logger.debug({ err: error.message }, 'XLEN failed (stream may not exist yet)');
      }
      metricsCollector.setQueueDepth(depth);

      const snapshot = metricsCollector.snapshot();
      logger.info(
        { snapshot, stub: true },
        'STUB: metrics snapshot — NOT inserted to bot.dispatcher_metrics yet (F1.2.b)',
      );
    } catch (err) {
      const error = err as Error;
      logger.error({ err: error.message }, 'metrics-flush tick failed');
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  return handle;
}
