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
      wa_phone_number_id = ${accepted.wa_phone_number_id ?? null}
    WHERE id = ${deliveryId}
      AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond'
                        AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
  `;
}

/**
 * Bump del retry_count tras una falla retriable. NO cambia status — el
 * delivery sigue `pending`, la próxima retry ZSET pop lo procesa de nuevo.
 */
export async function bumpRetryCount(
  sql: SqlOrTx,
  deliveryId: number,
  queuedAt: Date,
): Promise<void> {
  await sql`
    UPDATE bot.campaign_deliveries SET retry_count = retry_count + 1
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
