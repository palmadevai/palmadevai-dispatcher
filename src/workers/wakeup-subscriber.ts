/**
 * Wakeup subscriber — cierra el gap entre el enqueue (n8n) y el stream.
 *
 * El workflow n8n "Campaigns Enqueue" INSERTA las deliveries (status='pending')
 * pero NO puede hacer XADD al stream (el nodo Redis de n8n no expone XADD); en su
 * lugar PUBLISHea un wakeup a `CAMPAIGNS_WAKEUP_CHANNEL` (campaigns:enqueued).
 *
 * Sin un subscriber, el único path pending → stream era el recovery net (cada
 * 5 min, zombies con queued_at < now-5min) → TODA campaña tardaba hasta ~5 min en
 * salir. Bug funcional (incidente 2026-06-01).
 *
 * Este worker SUBSCRIBE al canal y, debounced, XADDea los pendings FRESCOS
 * (queued_at > now-5min) al stream → el dispatcher los procesa en segundos.
 * Complementa (no pisa) al recovery net, que sigue cubriendo los >5min.
 *
 * Idempotente: re-XADDear un delivery ya en vuelo es seguro — el dispatcher hace
 * SELECT FOR UPDATE SKIP LOCKED + skip si status!='pending'.
 */
import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import type { Logger } from '../lib/logger.js';
import { env } from '../env.js';

export interface WakeupSubscriberDeps {
  rawRedis: Redis;
  sql: Sql;
  logger: Logger;
}

export interface WakeupSubscriberHandle {
  stop(): Promise<void>;
}

// Debounce: coalesce ráfagas de wakeups (varios launches) en un solo scan.
const DEBOUNCE_MS = 250;
// Cap por scan — el recovery net cubre el resto si hubiera más.
const SCAN_LIMIT = 500;

export function startWakeupSubscriber(deps: WakeupSubscriberDeps): WakeupSubscriberHandle {
  const { rawRedis, sql, logger } = deps;
  const channel = env.CAMPAIGNS_WAKEUP_CHANNEL;
  // Conexión dedicada: una conexión en modo subscribe no puede correr otros comandos.
  const sub = rawRedis.duplicate();
  let stopping = false;
  let scanScheduled = false;

  async function scanAndEnqueue(reason: string): Promise<void> {
    scanScheduled = false;
    if (stopping) return;
    try {
      const fresh = await sql<Array<{ id: string; queued_at: Date }>>`
        SELECT id::bigint AS id, queued_at
        FROM bot.campaign_deliveries
        WHERE status = 'pending'
          AND queued_at > now() - interval '5 minutes'
        ORDER BY queued_at ASC
        LIMIT ${SCAN_LIMIT}
      `;
      for (const d of fresh) {
        try {
          await rawRedis.xadd(
            env.CAMPAIGNS_STREAM,
            '*',
            'delivery_id',
            String(d.id),
            'queued_at',
            d.queued_at.toISOString(),
          );
        } catch (xaddErr) {
          logger.error(
            { err: (xaddErr as Error).message, deliveryId: d.id },
            'wakeup: XADD failed',
          );
        }
      }
      if (fresh.length > 0) {
        logger.info({ count: fresh.length, reason }, 'wakeup: enqueued fresh pending deliveries to stream');
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'wakeup: scan failed');
    }
  }

  function schedule(reason: string): void {
    if (stopping || scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => void scanAndEnqueue(reason), DEBOUNCE_MS);
  }

  sub.on('message', () => schedule('wakeup'));
  sub.on('error', (err: Error) => logger.error({ err: err.message }, 'wakeup subscriber connection error'));

  sub
    .subscribe(channel)
    .then(() => logger.info({ channel }, 'wakeup subscriber listening (campaigns enqueue → stream)'))
    .catch((err: Error) => logger.error({ err: err.message, channel }, 'wakeup subscribe failed'));

  // Scan inicial al boot: cubre deliveries encoladas mientras el dispatcher estaba
  // caído / reiniciando (no perdemos el wakeup que se publicó en ese hueco).
  setTimeout(() => void scanAndEnqueue('boot'), 1000);

  return {
    async stop(): Promise<void> {
      stopping = true;
      try {
        await sub.unsubscribe(channel);
      } catch {
        /* ignore */
      }
      sub.disconnect();
    },
  };
}
