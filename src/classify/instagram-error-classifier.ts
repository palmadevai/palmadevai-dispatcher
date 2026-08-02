/**
 * Instagram DM error → ClassificationOutcome (mirrors FB classifier).
 *
 * Códigos relevantes IG Messaging:
 *   - 10903 / 551 — outside-24h-window (sin HUMAN_AGENT). payload_invalid.
 *   - 100         — invalid parameter. payload_invalid.
 *   - 190         — OAuth token invalid. auth_failed + pause.
 *   - 200         — permissions denied. auth_failed + pause.
 *   - 10          — app permission denied (Human Agent permission missing).
 *                   auth_failed + pause (necesita Meta App Review).
 *   - 230         — banned/duplicate. provider_content_rejected (terminal).
 *   - 5xx         — retry path, provider_5xx_exhausted al agotarse.
 *
 * Reusa ErrorCategory enum compartido — cockpit DLQ taxonomy unchanged.
 */
import type { ProviderSendResult } from '../providers/types.js';
import type { ClassificationOutcome } from './error-classifier.js';

const IG_AUTH_CODES = new Set(['190', '200', '10']);
const IG_PAYLOAD_INVALID_CODES = new Set(['100', '551', '10903']);
const IG_BANNED_OR_DUP_CODES = new Set(['230']);

export function classifyInstagramError(
  result: ProviderSendResult,
  attemptsMade: number,
  maxAttempts: number,
): ClassificationOutcome {
  const code = result.error_code ?? '';
  const status = result.http_status ?? 0;

  if (IG_AUTH_CODES.has(code) || status === 401 || status === 403) {
    return {
      category: 'auth_failed',
      terminal: true,
      shouldPauseCampaign: true,
      pauseReason: 'auto_quality_degraded',
    };
  }

  if (IG_PAYLOAD_INVALID_CODES.has(code)) {
    return { category: 'payload_invalid', terminal: true, shouldPauseCampaign: false };
  }

  if (IG_BANNED_OR_DUP_CODES.has(code)) {
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
