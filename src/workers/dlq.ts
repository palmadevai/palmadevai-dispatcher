/**
 * DLQ — Dead Letter Queue helper (ADR-009).
 *
 * Invoked from dispatcher.ts when retries are exhausted (or immediately for
 * terminal classifications: phone_invalid, payload_invalid, auth_failed,
 * template_rejected).
 *
 * Actions:
 *   1. INSERT bot.campaign_dlq with full payload + response + classification.
 *   2. UPDATE bot.campaign_deliveries SET status='failed' (idempotent — only
 *      if not already terminal).
 *   3. Compute auto-pause: if recent DLQ rate per campaign > AUTO_PAUSE_RATIO,
 *      UPDATE bot.campaigns SET status='paused', pause_reason='auto_quality_degraded'.
 *      Only triggers if status='sending' (don't restart-pause a draft).
 */
import type { Sql } from 'postgres';
import type { Logger } from '../lib/logger.js';
import type { ErrorCategory } from '../classify/error-classifier.js';
import { env } from '../env.js';
import { sendEmail } from '../providers/email.js';

const AUTO_PAUSE_RATIO = 0.2; // 20 %
const AUTO_PAUSE_WINDOW_MIN = 1; // last 1 minute of attempts
const AUTO_PAUSE_MIN_SAMPLE = 10; // require at least 10 attempts before triggering

// Escape mínimo para interpolar el nombre de campaña (operator-set) en el HTML
// del email de alerta.
const escapeHtml = (s: string): string =>
  s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));

export interface DLQEntry {
  deliveryId: number;
  queuedAt: Date;
  campaignId: string;
  errorCategory: ErrorCategory;
  errorCode?: string;
  errorMessage?: string;
  fullPayload?: unknown;
  fullResponse?: unknown;
  attemptsMade: number;
  firstFailedAt: Date;
}

export async function moveToDLQ(
  sql: Sql,
  logger: Logger,
  entry: DLQEntry,
): Promise<void> {
  // 1. INSERT DLQ. Idempotency note: bot.campaign_dlq has no unique constraint
  // on delivery_id so concurrent inserts could create duplicates. The dispatcher
  // only calls this once per exhausted job, and recovery.ts only after PEL > 1h.
  // Acceptable risk; operator UI dedups by delivery_id on display if needed.
  await sql`
    INSERT INTO bot.campaign_dlq (
      delivery_id, delivery_queued_at, campaign_id,
      error_category, error_code, error_message,
      full_payload, full_response,
      attempts_made, first_failed_at, last_failed_at, resolution
    ) VALUES (
      ${entry.deliveryId},
      ${entry.queuedAt},
      ${entry.campaignId},
      ${entry.errorCategory},
      ${entry.errorCode ?? null},
      ${entry.errorMessage ?? null},
      ${entry.fullPayload !== undefined ? sql.json(entry.fullPayload as Parameters<typeof sql.json>[0]) : null},
      ${entry.fullResponse !== undefined ? sql.json(entry.fullResponse as Parameters<typeof sql.json>[0]) : null},
      ${entry.attemptsMade},
      ${entry.firstFailedAt},
      now(),
      'pending'
    )
  `;

  // 2. UPDATE delivery → failed (idempotent: do NOT overwrite terminal
  // positive states delivered/read/replied — those are reached via webhook
  // before/after worker. We only mark failed if still pending/accepted/sent.)
  await sql`
    UPDATE bot.campaign_deliveries
    SET status = 'failed',
        failed_at = COALESCE(failed_at, now()),
        error_code = COALESCE(error_code, ${entry.errorCode ?? null}),
        error_message = COALESCE(error_message, ${entry.errorMessage ?? null}),
        failure_reason = COALESCE(failure_reason, ${entry.errorCategory})
    WHERE id = ${entry.deliveryId}
      AND queued_at BETWEEN ${entry.queuedAt}::timestamptz - INTERVAL '1 millisecond'
                        AND ${entry.queuedAt}::timestamptz + INTERVAL '1 millisecond'
      AND status IN ('pending', 'suppressed', 'accepted', 'sent')
  `;

  // 3. Auto-pause logic. Window-based DLQ rate.
  try {
    const rateRow = await sql<
      Array<{ recent_failures: number; recent_total: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM bot.campaign_dlq
           WHERE campaign_id = ${entry.campaignId}
             AND last_failed_at > now() - (${AUTO_PAUSE_WINDOW_MIN}::int * INTERVAL '1 minute')
        ) AS recent_failures,
        (SELECT count(*)::int FROM bot.campaign_deliveries
           WHERE campaign_id = ${entry.campaignId}
             AND COALESCE(
                   accepted_at, sent_at, failed_at, undelivered_at, queued_at
                 ) > now() - (${AUTO_PAUSE_WINDOW_MIN}::int * INTERVAL '1 minute')
        ) AS recent_total
    `;

    const stats = rateRow[0];
    if (
      stats &&
      stats.recent_total >= AUTO_PAUSE_MIN_SAMPLE &&
      stats.recent_failures / Math.max(stats.recent_total, 1) >= AUTO_PAUSE_RATIO
    ) {
      const pauseResult = await sql<Array<{ id: string; name: string | null }>>`
        UPDATE bot.campaigns
        SET status = 'paused',
            paused_at = now(),
            pause_reason = 'auto_quality_degraded',
            paused_by = 'dispatcher_auto'
        WHERE id = ${entry.campaignId}
          AND status = 'sending'
        RETURNING id::text AS id, name
      `;
      if (pauseResult.length > 0) {
        logger.warn(
          {
            campaign_id: entry.campaignId,
            recent_failures: stats.recent_failures,
            recent_total: stats.recent_total,
          },
          'auto-paused campaign — DLQ rate exceeded threshold',
        );
        // Aviso al operador por email (Resend), best-effort: que NO se entere por
        // sorpresa al entrar al cockpit. Antes esto era solo un logger.warn que
        // nadie ve (y el POST a /api/notifications apuntaba a un endpoint
        // inexistente). Si falta CAMPAIGNS_ALERT_EMAIL o RESEND_API_KEY, no-op.
        if (env.CAMPAIGNS_ALERT_EMAIL && env.RESEND_API_KEY) {
          const name = pauseResult[0].name ?? entry.campaignId;
          const ratePct = Math.round(
            (stats.recent_failures / Math.max(stats.recent_total, 1)) * 100,
          );
          const link = env.COCKPIT_URL
            ? `${env.COCKPIT_URL}/campaigns/${entry.campaignId}`
            : '';
          void sendEmail({
            from: env.CAMPAIGNS_DEFAULT_FROM_EMAIL,
            to: env.CAMPAIGNS_ALERT_EMAIL,
            subject: `Campaña pausada automáticamente: ${name}`,
            html:
              `<p>La campaña <b>${escapeHtml(name)}</b> se <b>pausó automáticamente</b> por ` +
              `calidad degradada: ${ratePct}% de fallos en el último minuto ` +
              `(${stats.recent_failures}/${stats.recent_total}).</p>` +
              `<p>No se enviaron más mensajes. Revisá el motivo en el DLQ antes de reanudar.</p>` +
              (link ? `<p>Campaña: <a href="${link}">${link}</a></p>` : ''),
            text:
              `Campaña pausada automáticamente: ${name}\n` +
              `Calidad degradada: ${ratePct}% de fallos (${stats.recent_failures}/${stats.recent_total}) en el último minuto.\n` +
              `No se enviaron más mensajes. Revisá el DLQ antes de reanudar.` +
              (link ? `\n${link}` : ''),
            biz_opaque_callback_data: `ops-alert:auto_quality_degraded:${entry.campaignId}`,
          }).catch((err: unknown) =>
            logger.error(
              { err: (err as Error).message, campaign_id: entry.campaignId },
              'auto-pause email notify failed',
            ),
          );
        }
      }
    }
  } catch (err) {
    // Auto-pause failure must not break DLQ insertion.
    logger.error(
      { err: (err as Error).message, campaign_id: entry.campaignId },
      'auto-pause check failed',
    );
  }
}
