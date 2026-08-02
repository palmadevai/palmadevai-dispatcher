/**
 * Facebook Messenger error → ClassificationOutcome (mirrors WA classifier).
 *
 * Meta Messenger error codes (https://developers.facebook.com/docs/messenger-platform/error-codes):
 *   - 100         invalid parameter (payload_invalid)
 *   - 190         OAuth token invalid/expired (auth_failed + pause campaign)
 *   - 200         permissions error (auth_failed + pause campaign)
 *   - 230         banned/duplicate message (provider_content_rejected, terminal)
 *   - 551         cannot send (24h window expired without valid tag) — payload_invalid
 *   - 1545041     messaging_type=MESSAGE_TAG required — payload_invalid
 *   - 10          app permission denied — auth_failed + pause
 *   - http 401/403 — auth_failed + pause
 *   - 5xx — provider_5xx_exhausted via retry exhaustion
 *
 * Reuses ErrorCategory enum from WA classifier — same cockpit DLQ taxonomy.
 */
import type { ProviderSendResult } from '../providers/types.js';
import type { ClassificationOutcome } from './error-classifier.js';

const FB_AUTH_CODES = new Set(['190', '200', '10']);
const FB_PAYLOAD_INVALID_CODES = new Set(['100', '551', '1545041']);
const FB_BANNED_OR_DUP_CODES = new Set(['230']);

export function classifyMessengerError(
  result: ProviderSendResult,
  attemptsMade: number,
  maxAttempts: number,
): ClassificationOutcome {
  const code = result.error_code ?? '';
  const status = result.http_status ?? 0;

  if (FB_AUTH_CODES.has(code) || status === 401 || status === 403) {
    return {
      category: 'auth_failed',
      terminal: true,
      shouldPauseCampaign: true,
      pauseReason: 'auto_quality_degraded',
    };
  }

  if (FB_PAYLOAD_INVALID_CODES.has(code)) {
    return { category: 'payload_invalid', terminal: true, shouldPauseCampaign: false };
  }

  if (FB_BANNED_OR_DUP_CODES.has(code)) {
    return { category: 'provider_content_rejected', terminal: true, shouldPauseCampaign: false };
  }

  const exhausted = attemptsMade >= maxAttempts;

  if (status >= 500) {
    return { category: 'provider_5xx_exhausted', terminal: exhausted, shouldPauseCampaign: false };
  }

  if (status >= 400 && status < 500) {
    return { category: 'provider_content_rejected', terminal: exhausted, shouldPauseCampaign: false };
  }

  return { category: 'unknown', terminal: exhausted, shouldPauseCampaign: false };
}
