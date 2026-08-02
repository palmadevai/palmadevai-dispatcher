/**
 * Resend error → ClassificationOutcome (parallel to error-classifier.ts WA).
 *
 * Resend error shapes (https://resend.com/docs/errors):
 *   - validation_error (422)       → payload_invalid, terminal, no retry
 *   - invalid_api_key (401)        → auth_failed, terminal, pause campaign
 *   - missing_api_key (401)        → auth_failed, terminal, pause campaign
 *   - rate_limit_exceeded (429)    → provider_5xx_exhausted-style, retry until exhausted
 *   - internal_server_error (5xx)  → throws inside sendEmail, lands here only
 *                                    after retries exhausted → provider_5xx_exhausted
 *   - resend_api_key_missing       → synthetic from adapter: payload_invalid, terminal
 *   - else / unknown 4xx           → provider_content_rejected (generic permanent-ish)
 *
 * The classifier reuses the WA ErrorCategory taxonomy for now — the cockpit DLQ
 * filters by category and adding a parallel email taxonomy is premature. If
 * categories diverge later (e.g. resend-specific 'recipient_bounced' permanent),
 * add to the union in error-classifier.ts.
 */
import type { ProviderSendResult } from '../providers/types.js';
import type { ClassificationOutcome } from './error-classifier.js';

const RESEND_PAYLOAD_INVALID_CODES = new Set([
  'validation_error',
  'invalid_from_address',
  'invalid_to_address',
  'invalid_attachment',
  'resend_api_key_missing',
]);

const RESEND_AUTH_CODES = new Set(['invalid_api_key', 'missing_api_key', 'restricted_api_key']);

export function classifyResendError(
  result: ProviderSendResult,
  attemptsMade: number,
  maxAttempts: number,
): ClassificationOutcome {
  const code = result.error_code ?? '';
  const status = result.http_status ?? 0;

  if (RESEND_AUTH_CODES.has(code) || status === 401 || status === 403) {
    return {
      category: 'auth_failed',
      terminal: true,
      shouldPauseCampaign: true,
      pauseReason: 'auto_quality_degraded',
    };
  }

  if (RESEND_PAYLOAD_INVALID_CODES.has(code) || status === 422) {
    return { category: 'payload_invalid', terminal: true, shouldPauseCampaign: false };
  }

  const exhausted = attemptsMade >= maxAttempts;

  if (status === 429) {
    return {
      category: 'provider_5xx_exhausted',
      terminal: exhausted,
      shouldPauseCampaign: false,
    };
  }

  if (status >= 500) {
    return {
      category: 'provider_5xx_exhausted',
      terminal: exhausted,
      shouldPauseCampaign: false,
    };
  }

  if (status >= 400 && status < 500) {
    return {
      category: 'provider_content_rejected',
      terminal: exhausted,
      shouldPauseCampaign: false,
    };
  }

  return { category: 'unknown', terminal: exhausted, shouldPauseCampaign: false };
}
