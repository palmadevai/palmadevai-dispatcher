/**
 * Recovery worker — runs every 5 min (spec §5.3, ADR-009, ADR-015).
 *
 * Three layers of defense:
 *
 *   1. PEL recovery — XCLAIM stale entries (IDLE > 5min) so a dead worker
 *      doesn't block forever. Just transfers ownership; the dispatcher loop
 *      picks them up on next XREADGROUP.
 *
 *   2. Postgres safety net — re-XADD deliveries that are status='pending'
 *      but queued_at < now - 5min. Covers AOF gap / Redis evict / stream
 *      trim scenarios.
 *
 *   3. PEL timeout (1h) — entries idle > 1h are presumed dead. Terminal-fail
 *      the delivery + insert DLQ row + XACK. failure_reason='pel_timeout_1h'.
 *
 * All three are idempotent: XCLAIM is safe to re-issue, re-XADD goes through
 * SELECT FOR UPDATE SKIP LOCKED in the dispatcher (non-pending → skip), and
 * the DLQ insert duplicates are acceptable (operator dedups on display).
 */
import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import { env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import { parseQueuedAt } from '../lib/parse-queued-at.js';
import { isMissingRelation, announceOnce } from '../lib/pg-errors.js';
import { moveToDLQ } from './dlq.js';

const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
const STALE_MS = 5 * 60 * 1000;
const PEL_DEAD_MS = 60 * 60 * 1000;

export interface RecoveryDeps {
  rawRedis: Redis;
  sql: Sql;
  logger: Logger;
}

export function startRecovery(deps: RecoveryDeps): NodeJS.Timeout {
  const { logger, rawRedis, sql } = deps;

  logger.info(
    {
      interval_ms: RECOVERY_INTERVAL_MS,
      stream: env.CAMPAIGNS_STREAM,
      group: env.CAMPAIGNS_GROUP,
    },
    'starting recovery worker',
  );

  const tick = async (): Promise<void> => {
    try {
      await recoverStalled(rawRedis, sql, logger);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'recovery tick failed');
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, RECOVERY_INTERVAL_MS);

  // First tick at 30s so the dispatcher has time to fully boot.
  setTimeout(() => {
    void tick();
  }, 30_000);

  return handle;
}

async function recoverStalled(rawRedis: Redis, sql: Sql, logger: Logger): Promise<void> {
  // ── 1. PEL recovery: XCLAIM stale entries (IDLE > 5min) ───────────────────
  try {
    const pending = (await rawRedis.call(
      'XPENDING',
      env.CAMPAIGNS_STREAM,
      env.CAMPAIGNS_GROUP,
      'IDLE',
      String(STALE_MS),
      '-',
      '+',
      '1000',
    )) as Array<[string, string, number, number]> | null;

    if (Array.isArray(pending) && pending.length > 0) {
      const ids = pending.map((p) => p[0]).filter((id): id is string => typeof id === 'string');
      if (ids.length > 0) {
        await rawRedis.call(
          'XCLAIM',
          env.CAMPAIGNS_STREAM,
          env.CAMPAIGNS_GROUP,
          env.HOSTNAME,
          String(STALE_MS),
          ...ids,
        );
        logger.info({ count: ids.length }, 'XCLAIMED stalled PEL entries');
      }
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'XCLAIM step failed');
  }

  // ── 2. Postgres safety net: requeue pending zombies ───────────────────────
  try {
    const zombies = await sql<Array<{ id: number; queued_at: Date }>>`
      SELECT id::bigint AS id, queued_at
      FROM bot.campaign_deliveries
      WHERE status = 'pending'
        AND queued_at < now() - interval '5 minutes'
      LIMIT 100
    `;
    for (const z of zombies) {
      try {
        await rawRedis.xadd(
          env.CAMPAIGNS_STREAM,
          '*',
          'delivery_id',
          String(z.id),
          'queued_at',
          z.queued_at.toISOString(),
        );
      } catch (xaddErr) {
        logger.error(
          { err: (xaddErr as Error).message, deliveryId: z.id },
          'safety-net XADD failed',
        );
      }
    }
    if (zombies.length > 0) {
      logger.warn({ count: zombies.length }, 'requeued postgres zombies');
    }
  } catch (err) {
    if (isMissingRelation(err)) {
      // Sin la feature `campaigns` no hay deliveries que rescatar. Es el paso
      // que más ruido hacía de los cuatro: corre por cron cada 5 minutos, así
      // que en un cliente sin campañas escribía un `error` cada 5 minutos,
      // para siempre.
      announceOnce(
        logger,
        'missing:campaign_deliveries:safety-net',
        {},
        'sin bot.campaign_deliveries (cliente sin la feature campaigns): el safety-net no tiene nada que rescatar. Estado esperado, se dice una vez.',
      );
    } else {
      logger.error({ err: (err as Error).message }, 'safety-net step failed');
    }
  }

  // ── 3. PEL dead-letter: IDLE > 1h → terminal failed + DLQ + XACK ──────────
  try {
    const ancient = (await rawRedis.call(
      'XPENDING',
      env.CAMPAIGNS_STREAM,
      env.CAMPAIGNS_GROUP,
      'IDLE',
      String(PEL_DEAD_MS),
      '-',
      '+',
      '100',
    )) as Array<[string, string, number, number]> | null;

    if (Array.isArray(ancient) && ancient.length > 0) {
      for (const entry of ancient) {
        const streamId = entry[0];
        if (typeof streamId !== 'string') continue;
        try {
          const xrange = (await rawRedis.call(
            'XRANGE',
            env.CAMPAIGNS_STREAM,
            streamId,
            streamId,
          )) as Array<[string, string[]]> | null;
          if (!Array.isArray(xrange) || xrange.length === 0) {
            // Entry already trimmed/deleted; just ACK to release the PEL slot.
            await rawRedis.xack(env.CAMPAIGNS_STREAM, env.CAMPAIGNS_GROUP, streamId);
            continue;
          }
          const fields = xrange[0]?.[1] ?? [];
          const fieldMap: Record<string, string> = {};
          for (let i = 0; i + 1 < fields.length; i += 2) {
            const k = fields[i];
            const v = fields[i + 1];
            if (k !== undefined && v !== undefined) fieldMap[k] = v;
          }
          const deliveryIdRaw = fieldMap['delivery_id'];
          const queuedAtRaw = fieldMap['queued_at'];
          if (!deliveryIdRaw) {
            await rawRedis.xack(env.CAMPAIGNS_STREAM, env.CAMPAIGNS_GROUP, streamId);
            continue;
          }
          const deliveryId = Number(deliveryIdRaw);
          const parsed = parseQueuedAt(queuedAtRaw);
          if (parsed.fallback) {
            logger.warn(
              { streamId, deliveryId, queuedAtRaw, normalized: parsed.normalized },
              'PEL dead-letter: queued_at raw inválido — fallback now()',
            );
          }
          const queuedAt = parsed.date;

          // Range ±1ms para tolerar precision drift JS Date ↔ µs Postgres
          // (ver techdebt-dispatcher-smoke-bugs-2026-05-27). RETURNING queued_at
          // captura el valor exacto del DB para moveToDLQ.
          const updated = await sql<Array<{ campaign_id: string; queued_at: Date }>>`
            UPDATE bot.campaign_deliveries SET
              status = 'failed',
              failed_at = COALESCE(failed_at, now()),
              failure_reason = COALESCE(failure_reason, 'pel_timeout_1h')
            WHERE id = ${deliveryId}
              AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond'
                                AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
              AND status = 'pending'
            RETURNING campaign_id::text AS campaign_id, queued_at
          `;

          const updatedRow = updated[0];
          if (updatedRow) {
            await moveToDLQ(sql, logger, {
              deliveryId,
              queuedAt: updatedRow.queued_at,
              campaignId: updatedRow.campaign_id,
              errorCategory: 'worker_crash_loop',
              errorMessage: 'PEL idle > 1h — worker presumed dead',
              attemptsMade: env.DISPATCHER_BULLMQ_ATTEMPTS,
              firstFailedAt: new Date(),
            });
          }

          await rawRedis.xack(env.CAMPAIGNS_STREAM, env.CAMPAIGNS_GROUP, streamId);
          logger.warn(
            { deliveryId, streamId },
            'PEL timeout 1h — moved to DLQ + XACK',
          );
        } catch (entryErr) {
          logger.error(
            { err: (entryErr as Error).message, streamId },
            'PEL dead-letter processing failed',
          );
        }
      }
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'PEL dead-letter step failed');
  }
}
