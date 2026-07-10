/**
 * Tagged-SQL helpers para los UPDATEs de `bot.campaign_deliveries` que el
 * dispatcher hace en distintos puntos del pipeline. Cada call site repetía
 * el mismo `WHERE id = ${id} AND queued_at BETWEEN ${q}::timestamptz - 1ms
 * AND ${q}::timestamptz + 1ms` — el ±1ms es necesario por el drift entre
 * postgres.js (ms precision) y `now()` default (µs precision). Centralizar
 * acá:
 *   - garantiza que el predicate WHERE es idéntico en todas las rutas
 *     (defensive contra olvidar el BETWEEN en un futuro hot path);
 *   - reduce ruido visual en `workers/dispatcher.ts` (5+ call sites);
 *   - facilita agregar nuevos terminal paths cuando entren providers
 *     facebook/instagram/sms en Fase 5 Items 2-3.
 *
 * Estos helpers asumen que ya estás dentro de una `sql.begin(tx => ...)` —
 * el caller pasa la `tx` o `pgPool`. No abren TX propia.
 *
 * Ref bug histórico: techdebt-dispatcher-smoke-bugs-2026-05-27 (queued_at
 * exact match drift).
 */
import type { Sql, TransactionSql } from 'postgres';

type SqlOrTx = Sql | TransactionSql;

export interface TerminalFailure {
  error_code: string;
  error_message: string;
  failure_reason: string;
}

export interface AcceptedDelivery {
  message_id: string;
  /** Solo para channel='whatsapp'. Null/undefined para email/IG/FB. */
  wa_phone_number_id?: string | null;
}

/**
 * Marcar delivery como `status='failed'` terminal (no retry). Usado por:
 *  - Phone-missing en WA (`failure_reason='phone_invalid'`)
 *  - Email-missing en email (`failure_reason='email_invalid'`)
 *  - Channel-not-implemented (provider guard)
 *  - 131049 frequency cap (WA-only, dedicated post-send branch)
 *  - Post-send classifier.terminal=true (errores 4xx terminales)
 */
export async function markDeliveryTerminal(
  sql: SqlOrTx,
  deliveryId: number,
  queuedAt: Date,
  failure: TerminalFailure,
): Promise<void> {
  await sql`
    UPDATE bot.campaign_deliveries SET
      status = 'failed', failed_at = now(),
      error_code = ${failure.error_code},
      error_message = ${failure.error_message},
      failure_reason = ${failure.failure_reason}
    WHERE id = ${deliveryId}
      AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond'
                        AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
  `;
}

/**
 * Marcar delivery como `status='suppressed'`. Usado por:
 *  - Campaign paused/canceled entre enqueue y dispatch (failure_reason='campaign_paused'|'campaign_canceled')
 *  - Contact opt-out (failure_reason='opt_out')
 *  - Cualquier supresión soft (no retry, no DLQ, ack-only).
 */
export async function markDeliverySuppressed(
  sql: SqlOrTx,
  deliveryId: number,
  queuedAt: Date,
  failureReason: string,
): Promise<void> {
  await sql`
    UPDATE bot.campaign_deliveries SET
      status = 'suppressed', suppressed_at = now(),
      failure_reason = ${failureReason}
    WHERE id = ${deliveryId}
      AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond'
                        AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
  `;
}

/**
 * Marcar delivery como `status='accepted'` (Meta/Resend OK 2xx, esperando
 * delivered/read webhooks).
 *
 * `wa_phone_number_id` se setea solo para channel='whatsapp'. email/FB/IG
 * pasan undefined → NULL en DB. Esa columna queda WA-specific por ahora;
 * cuando entre `bot.outbound_endpoints` (Fase 5 Item 2) habrá un
 * `outbound_endpoint_id` genérico.
 */
export async function markDeliveryAccepted(
  sql: SqlOrTx,
  deliveryId: number,
  queuedAt: Date,
  accepted: AcceptedDelivery,
): Promise<void> {
  await sql`
    UPDATE bot.campaign_deliveries SET
      status = 'accepted',
      accepted_at = now(),
      meta_message_id = ${accepted.message_id},
      wa_phone_number_id = ${accepted.wa_phone_number_id ?? null},
      -- Limpiar el error del último intento fallido (si reintentó y ahora salió OK)
      -- para no mostrar un motivo stale sobre un delivery aceptado.
      error_code = NULL, error_message = NULL, failure_reason = NULL
    WHERE id = ${deliveryId}
      AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond'
                        AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
  `;
}

/**
 * Bump del retry_count tras una falla retriable. NO cambia status — el delivery
 * sigue `pending`, la próxima retry ZSET pop lo procesa de nuevo. Persiste el
 * último error (code/message/reason) para que la UI muestre POR QUÉ está pending
 * (reintentando) en vez de un pending mudo. Se limpia en markDeliveryAccepted si
 * el retry termina OK.
 */
export async function bumpRetryCount(
  sql: SqlOrTx,
  deliveryId: number,
  queuedAt: Date,
  lastError?: { error_code?: string; error_message?: string; failure_reason?: string },
): Promise<void> {
  await sql`
    UPDATE bot.campaign_deliveries SET
      retry_count = retry_count + 1,
      error_code = ${lastError?.error_code ?? null},
      error_message = ${lastError?.error_message ?? null},
      failure_reason = ${lastError?.failure_reason ?? null}
    WHERE id = ${deliveryId}
      AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond'
                        AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
  `;
}

/**
 * Variante UNDELIVERED para la branch 131049 (Meta frequency cap WA-only).
 * Mismos campos terminales pero `status='undelivered'` + `undelivered_at`.
 * Cockpit /campaigns/[id] reporta undelivered≠failed en el funnel.
 */
export async function markDeliveryUndelivered(
  sql: SqlOrTx,
  deliveryId: number,
  queuedAt: Date,
  failure: TerminalFailure,
): Promise<void> {
  await sql`
    UPDATE bot.campaign_deliveries SET
      status = 'undelivered',
      undelivered_at = now(),
      failed_at = now(),
      error_code = ${failure.error_code},
      error_message = ${failure.error_message},
      failure_reason = ${failure.failure_reason}
    WHERE id = ${deliveryId}
      AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond'
                        AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
  `;
}

/**
 * Lifecycle de la campaña: queued → sending → done.
 *
 * El enqueue deja la campaña en `queued` (estado canónico que consume el
 * scheduler). Nadie la avanzaba a `sending`/`done` → el funnel del dashboard
 * quedaba siempre en queued y los WHERE status='sending' del dispatcher eran
 * código muerto (bug B1, detectado en smoke E2E 2026-05-31).
 *
 * - `markCampaignSending`: al empezar a procesar la primera delivery, sube
 *   queued→sending (idempotente: solo si está queued; no toca paused/done/etc).
 *   SOLO one_off/recurring: trigger_based y drip NO se mueven a 'sending' —
 *   deben quedar en 'queued' porque el scheduler solo re-evalúa status='queued';
 *   si pasan a 'sending' el motor deja de enrolar y dispara una sola vez
 *   (bug del smoke funcional P0#3, 2026-07-10).
 * - `maybeMarkCampaignDone`: tras un terminal de delivery, si NO quedan
 *   deliveries 'pending' de esa campaña, baja sending→done. Idempotente.
 *   SOLO one_off (guard kind): drip/trigger_based siguen enrolando, no se cierran.
 */
export async function markCampaignSending(
  sql: SqlOrTx,
  campaignId: string,
): Promise<void> {
  // Guard de kind simétrico con maybeMarkCampaignDone: trigger_based/drip son
  // continuas y viven en 'queued' (el scheduler las consume ahí). Solo las
  // batch-style (one_off/recurring-children) transicionan a 'sending'.
  await sql`
    UPDATE bot.campaigns
       SET status = 'sending'
     WHERE id = ${campaignId} AND status = 'queued'
       AND kind NOT IN ('trigger_based', 'drip')
  `;
}

export async function maybeMarkCampaignDone(
  sql: SqlOrTx,
  campaignId: string,
): Promise<boolean> {
  // Solo cierra one_off/recurring-children: las campañas drip/trigger_based
  // siguen enrolando (no se cierran por "no pending"). Guard: kind='one_off'.
  const rows = await sql<Array<{ id: string }>>`
    UPDATE bot.campaigns c
       SET status = 'done', done_at = now()
     WHERE c.id = ${campaignId}
       AND c.status = 'sending'
       AND c.kind = 'one_off'
       AND NOT EXISTS (
         SELECT 1 FROM bot.campaign_deliveries d
          WHERE d.campaign_id = c.id AND d.status = 'pending'
       )
    RETURNING c.id::text AS id
  `;
  return rows.length > 0;
}
