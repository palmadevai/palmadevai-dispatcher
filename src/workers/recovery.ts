/**
 * Recovery worker — cron 5min. Procesa el PEL (Pending Entries List) del
 * Consumer Group para hacer XCLAIM de mensajes idle >5min (ADR-009 DLQ flow).
 *
 * F1.2.a (skeleton): solo loguea el output de XPENDING — cuenta, min/max
 * idle time, consumer breakdown. NO hace XCLAIM ni reprocesa.
 *
 * F1.2.b (próximo PR):
 *   1. XPENDING summary + XPENDING IDLE 5min → lista de candidate IDs
 *   2. XCLAIM (movemos ownership a este consumer)
 *   3. Re-enqueue como BullMQ job (con attempts++ para hit DLQ threshold)
 *   4. Defense-in-depth Postgres: SELECT bot.campaign_deliveries WHERE
 *      status='queued' AND queued_at < now()-5min → re-XADD (cubre case
 *      donde AOF window perdió msgs del stream)
 *
 * Ver spec.md §5.3 (recovery worker) + ADR-015 race conditions.
 */
import type { Redis } from 'ioredis';
import { env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { SqlClient } from '../lib/postgres.js';

const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

export interface RecoveryDeps {
  rawRedis: Redis;
  sql: SqlClient;
  logger: Logger;
}

/**
 * Devuelve un handle al setInterval para que el shutdown lo pueda clear.
 */
export function startRecovery(deps: RecoveryDeps): NodeJS.Timeout {
  const { logger, rawRedis } = deps;

  logger.info(
    { interval_ms: RECOVERY_INTERVAL_MS, stream: env.CAMPAIGNS_STREAM, group: env.CAMPAIGNS_GROUP },
    'starting recovery worker (STUB mode — F1.2.a)',
  );

  const tick = async (): Promise<void> => {
    try {
      // XPENDING <stream> <group>
      // Returns: [total_pending, min_id, max_id, [[consumer_name, count], ...]]
      // o (count, null, null, null) si no hay pending.
      const result = await rawRedis.call(
        'XPENDING',
        env.CAMPAIGNS_STREAM,
        env.CAMPAIGNS_GROUP,
      );

      if (Array.isArray(result)) {
        const [total, minId, maxId, consumers] = result as [
          number,
          string | null,
          string | null,
          Array<[string, string]> | null,
        ];

        if (total === 0) {
          logger.debug('recovery tick: 0 pending entries');
          return;
        }

        logger.info(
          {
            total_pending: total,
            min_id: minId,
            max_id: maxId,
            consumers: consumers?.map(([name, cnt]) => ({ name, count: cnt })) ?? [],
          },
          'STUB: PEL summary — XCLAIM not implemented yet (F1.2.b)',
        );
      } else {
        logger.warn({ result }, 'unexpected XPENDING response shape');
      }
    } catch (err) {
      const error = err as Error;
      logger.error({ err: error.message }, 'recovery tick failed');
    }
  };

  // Primer tick a los 30s (evitar correr antes que el worker termine de bootear).
  const handle = setInterval(() => {
    void tick();
  }, RECOVERY_INTERVAL_MS);

  setTimeout(() => {
    void tick();
  }, 30_000);

  return handle;
}
