/**
 * Metrics flush worker — cron 30s (env DISPATCHER_METRICS_FLUSH_INTERVAL_SECONDS).
 *
 * Reads:
 *   - XLEN campaigns:stream  → queue_depth
 *   - XPENDING campaigns:stream dispatchers  → pel_pending_count
 *   - MetricsCollector.snapshot() → rates + latency percentiles + error breakdown
 *   - bot.campaign_dlq count (resolution='pending')  → dlq_count
 *   - bot.campaigns count where status='sending'    → active_campaigns
 *
 * Writes one row to bot.dispatcher_metrics. Snapshot.reset() called after
 * INSERT to bound RAM (per-row counters reset; cumulative totals like
 * dequeue_count_total stay).
 *
 * Retention 7d via pg_cron in migration 054 (NOT this worker's responsibility).
 */
import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import { env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { MetricsCollector } from '../observability/metrics-collector.js';

export interface MetricsFlushDeps {
  rawRedis: Redis;
  sql: Sql;
  logger: Logger;
  metricsCollector: MetricsCollector;
}

export function startMetricsFlush(deps: MetricsFlushDeps): NodeJS.Timeout {
  const { logger, metricsCollector, rawRedis, sql } = deps;
  const intervalMs = env.DISPATCHER_METRICS_FLUSH_INTERVAL_SECONDS * 1000;

  logger.info({ interval_ms: intervalMs }, 'starting metrics-flush worker');

  const tick = async (): Promise<void> => {
    try {
      // ── Read queue depth ──────────────────────────────────────────────────
      let queueDepth = 0;
      try {
        queueDepth = await rawRedis.xlen(env.CAMPAIGNS_STREAM);
      } catch (err) {
        logger.debug({ err: (err as Error).message }, 'XLEN failed');
      }
      metricsCollector.setQueueDepth(queueDepth);

      // ── PEL count ─────────────────────────────────────────────────────────
      let pelPendingCount = 0;
      try {
        const pelInfo = (await rawRedis.call(
          'XPENDING',
          env.CAMPAIGNS_STREAM,
          env.CAMPAIGNS_GROUP,
        )) as Array<number | string | null> | null;
        if (Array.isArray(pelInfo) && typeof pelInfo[0] === 'number') {
          pelPendingCount = pelInfo[0];
        }
      } catch (err) {
        logger.debug({ err: (err as Error).message }, 'XPENDING summary failed');
      }

      const snapshot = metricsCollector.snapshot();

      // ── DLQ pending count + active campaigns from Postgres ────────────────
      let dlqCount = 0;
      let activeCampaigns = 0;
      try {
        const rows = await sql<Array<{ dlq_pending: number; active_campaigns: number }>>`
          SELECT
            (SELECT count(*)::int FROM bot.campaign_dlq WHERE resolution = 'pending')
              AS dlq_pending,
            (SELECT count(*)::int FROM bot.campaigns WHERE status = 'sending')
              AS active_campaigns
        `;
        if (rows[0]) {
          dlqCount = rows[0].dlq_pending;
          activeCampaigns = rows[0].active_campaigns;
        }
      } catch (err) {
        logger.debug({ err: (err as Error).message }, 'metrics aux query failed');
      }

      // ── Error breakdown JSON ──────────────────────────────────────────────
      // MetricsSnapshot currently exposes a single error_count_5m / error_ratio_5m
      // (no per-category breakdown in F1.2.a schema). We expose breakdown via
      // a new aggregation read directly from the collector.
      const errorBreakdown = metricsCollector.errorBreakdown();

      // ── INSERT bot.dispatcher_metrics ─────────────────────────────────────
      await sql`
        INSERT INTO bot.dispatcher_metrics (
          recorded_at,
          queue_depth, pel_pending_count, dlq_count,
          dequeue_rate_per_sec_60s, send_rate_per_sec_60s,
          send_latency_p50_ms, send_latency_p95_ms, send_latency_p99_ms,
          error_ratio_5m, error_breakdown,
          active_workers, active_campaigns
        ) VALUES (
          now(),
          ${queueDepth}, ${pelPendingCount}, ${dlqCount},
          ${snapshot.dequeue_rate_60s / 60}, ${snapshot.send_count_5m / 300},
          ${snapshot.send_latency_p50_ms},
          ${snapshot.send_latency_p95_ms},
          ${snapshot.send_latency_p99_ms},
          ${snapshot.error_ratio_5m},
          ${sql.json(errorBreakdown)},
          ${env.DISPATCHER_CONCURRENCY}, ${activeCampaigns}
        )
      `;

      logger.debug({ snapshot, dlqCount, activeCampaigns }, 'metrics flushed');

      // ── Reset per-window counters (keep dequeueCountTotal cumulative) ─────
      metricsCollector.resetWindows();
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'metrics-flush tick failed');
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  return handle;
}
