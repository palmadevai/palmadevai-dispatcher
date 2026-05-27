/**
 * Meta error → DLQ category (ADR-009).
 *
 * Decision tree:
 *   - 131049 (cross-brand 2/24h frequency cap) → terminal undelivered, NO retry,
 *     NOT DLQ. Caller handles via dedicated branch (failure_reason='meta_freq_cap_131049').
 *   - 131000 / 131056 (tier exceeded) → DLQ + pause campaign (caller).
 *   - 132000–132016 (template params invalid / template not found) →
 *     payload_invalid. Immediate DLQ — retrying won't fix a bad payload.
 *   - 131005 / 131026 / 131051 (phone invalid / contact not on WA) →
 *     phone_invalid. Immediate DLQ.
 *   - 132047 (template paused/rejected mid-flight) → meta_template_rejected
 *     + pause campaign (caller).
 *   - 190 (auth token expired) → auth_failed + pause campaign.
 *   - http_status 401/403 → auth_failed.
 *   - http_status >= 500 with retries exhausted → meta_5xx_exhausted.
 *   - http_status 4xx with retries exhausted → meta_template_rejected
 *     (generic permanent-ish bucket; operator triages in /campaigns/dlq).
 *   - else → unknown.
 *
 * The classifier is invoked ONLY when sendWhatsApp returned ok=false (i.e.
 * Meta gave us a 4xx response body). 5xx throws inside sendWhatsApp; those
 * land here only via the retry layer after exhaustion.
 */
import type { SendWhatsAppResult } from '../dispatch/send-whatsapp.js';

export type ErrorCategory =
  | 'meta_template_rejected'
  | 'meta_5xx_exhausted'
  | 'payload_invalid'
  | 'phone_invalid'
  | 'auth_failed'
  | 'worker_crash_loop'
  | 'unknown';

export interface ClassificationOutcome {
  category: ErrorCategory;
  /** Terminal codes never retry. */
  terminal: boolean;
  /** Caller should pause the campaign (auth issues, template rejection mid-flight). */
  shouldPauseCampaign: boolean;
  /** pause_reason value for bot.campaigns.pause_reason. */
  pauseReason?:
    | 'auto_quality_degraded'
    | 'auto_meta_tier_hit'
    | 'auto_template_rejected'
    | 'auto_no_available_phones'
    | 'manual';
}

const FREQ_CAP_CODES = new Set(['131049']);
const TIER_EXCEEDED_CODES = new Set(['131000', '131056']);
const PHONE_INVALID_CODES = new Set(['131005', '131026', '131051']);
const TEMPLATE_REJECTED_CODES = new Set(['132047']);
const AUTH_CODES = new Set(['190']);

function isPayloadInvalidCode(code: string): boolean {
  // 132000–132016 inclusive
  if (!/^\d+$/.test(code)) return false;
  const n = Number(code);
  return n >= 132000 && n <= 132016;
}

export function classifyMetaError(
  result: SendWhatsAppResult,
  attemptsMade: number,
  maxAttempts: number,
): ClassificationOutcome {
  const code = result.error_code ?? '';
  const status = result.http_status ?? 0;

  // 131049 is handled by caller directly (dedicated branch), but be defensive.
  if (FREQ_CAP_CODES.has(code)) {
    return { category: 'unknown', terminal: true, shouldPauseCampaign: false };
  }

  if (TIER_EXCEEDED_CODES.has(code)) {
    return {
      category: 'meta_template_rejected',
      terminal: true,
      shouldPauseCampaign: true,
      pauseReason: 'auto_meta_tier_hit',
    };
  }

  if (PHONE_INVALID_CODES.has(code)) {
    return { category: 'phone_invalid', terminal: true, shouldPauseCampaign: false };
  }

  if (TEMPLATE_REJECTED_CODES.has(code)) {
    return {
      category: 'meta_template_rejected',
      terminal: true,
      shouldPauseCampaign: true,
      pauseReason: 'auto_template_rejected',
    };
  }

  if (AUTH_CODES.has(code) || status === 401 || status === 403) {
    return {
      category: 'auth_failed',
      terminal: true,
      shouldPauseCampaign: true,
      pauseReason: 'auto_quality_degraded',
    };
  }

  if (isPayloadInvalidCode(code)) {
    return { category: 'payload_invalid', terminal: true, shouldPauseCampaign: false };
  }

  const exhausted = attemptsMade >= maxAttempts;

  if (status >= 500) {
    return {
      category: 'meta_5xx_exhausted',
      terminal: exhausted,
      shouldPauseCampaign: false,
    };
  }

  if (status >= 400 && status < 500) {
    return {
      category: 'meta_template_rejected',
      terminal: exhausted,
      shouldPauseCampaign: false,
    };
  }

  return { category: 'unknown', terminal: exhausted, shouldPauseCampaign: false };
}
