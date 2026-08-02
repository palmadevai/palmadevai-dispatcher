/**
 * `ChannelProvider` port — H1.1 (messaging-service Fase 1, ports & adapters).
 *
 * Replaces the ~285-line if/else branch that used to live in
 * `workers/dispatcher.ts` (one branch per channel: destination validation,
 * endpoint picking, payload construction, send, and error classification).
 * Each channel now implements this interface in its own `providers/<channel>.ts`
 * file; the worker becomes channel-agnostic and only orchestrates the
 * lifecycle (TX, retry/DLQ, metrics, SSE).
 *
 * See `apps/features/messaging/doc/analysis-messaging-service.md` §3.4 for the
 * target layout (`core/ports/providers/transports`) this port is the first
 * piece of, and §9 Fase 1 (H1.1) for the migration plan.
 *
 * Design notes:
 *   - `prepare()` does everything that used to run BEFORE `acquireToken()` in
 *     the worker: destination validation (terminal outcome on missing
 *     phone/email/psid/igsid), endpoint picking (pinned WA endpoint →
 *     fallback auto-pick, or the generic FB/IG picker), and payload
 *     construction (template components / rendered email body / interpolated
 *     plain text). It runs INSIDE the delivery TX (same `tx` the worker
 *     already has open) so it can SELECT endpoints with the same visibility
 *     as before.
 *   - `send()` just forwards to the channel's existing send function
 *     (`sendWhatsApp`/`sendEmail`/`sendFacebookMessenger`/`sendInstagramDm`),
 *     untouched — this refactor does not touch wire-level behavior.
 *   - `classify()` forwards to the channel's existing classifier — category
 *     names (`meta_*`) are NOT renamed here (that's H1.2, a separate PR).
 *   - `terminalOverride()` is the one channel-specific short-circuit that ran
 *     BEFORE classification in the old worker (WA's 131049 frequency-cap
 *     branch). Only WhatsApp implements it.
 */
import type { TransactionSql } from 'postgres';
import type { Channel, ProviderSendResult } from '../providers/types.js';
import type { DeliveryContext } from '../dispatch/audience-resolver.js';
import type { ClassificationOutcome } from '../classify/error-classifier.js';
import {
  assertProviderAvailable,
  ChannelNotImplementedError,
} from '../providers/index.js';

/** The TX the worker already has open for the current delivery job. */
export type TxLike = TransactionSql;

/** Same shape `resolveAiBindings()` returns — kept structural to avoid an import cycle. */
export type AiBindings = Record<string, unknown>;

export type PrepareOutcome =
  | { kind: 'terminal'; error_code: string; error_message: string; failure_reason: string }
  | { kind: 'no_endpoint'; throwMessage: string }
  | {
      kind: 'ready';
      /** Provider-specific send input, cast to the real type inside the provider's own send(). */
      sendInput: unknown;
      /** `bot.outbound_endpoints.id` to bump `sent_today` on accept. Null for channels with no endpoint row (email). */
      endpointRowId: string | null;
      /** Extra fields merged into `markDeliveryAccepted`'s `accepted` arg (WA: `wa_phone_number_id`). */
      acceptedExtra: { wa_phone_number_id?: string };
      /** Channel-specific fields merged into the worker's `logger.error` call on a thrown send(). */
      errorLogFields: Record<string, unknown>;
    };

export interface TerminalOverride {
  markAs: 'undelivered';
  error_code: string;
  error_message: string;
  failure_reason: string;
  /** Passed to `metricsCollector.recordError()` instead of a classifier category. */
  metricsKey: string;
}

export interface ChannelProvider {
  readonly channel: Channel;
  prepare(tx: TxLike, ctx: DeliveryContext, aiResolvedBindings: AiBindings): Promise<PrepareOutcome>;
  send(input: unknown): Promise<ProviderSendResult>;
  classify(result: ProviderSendResult, attemptsMade: number, maxAttempts: number): ClassificationOutcome;
  /** Corto-circuito terminal channel-specific ANTES de classify (hoy solo WA 131049). */
  terminalOverride?(result: ProviderSendResult): TerminalOverride | null;
}

// Lazy imports (not at module top) would create a cycle risk if a provider
// ever imported back from ports/ — they don't today, but importing the
// concrete providers here (the registry) is exactly the "factory" the
// analysis doc §3.4 describes, so it's fine to import them directly.
import { whatsappProvider } from '../providers/whatsapp.js';
import { emailProvider } from '../providers/email.js';
import { facebookProvider } from '../providers/facebook.js';
import { instagramProvider } from '../providers/instagram.js';

const REGISTRY: Partial<Record<Channel, ChannelProvider>> = {
  whatsapp: whatsappProvider,
  email: emailProvider,
  facebook: facebookProvider,
  instagram: instagramProvider,
};

/**
 * Resolve the `ChannelProvider` for a delivery's channel. Throws
 * `ChannelNotImplementedError` for unimplemented channels (today: `sms`) —
 * same error the worker's pre-existing `assertProviderAvailable()` guard
 * throws, so callers that already handle that error type don't need a new
 * catch branch.
 */
export function getProviderForChannel(channel: string): ChannelProvider {
  assertProviderAvailable(channel);
  const provider = REGISTRY[channel];
  if (!provider) {
    // Defensive — assertProviderAvailable and REGISTRY should never disagree.
    throw new ChannelNotImplementedError(channel);
  }
  return provider;
}

export { ChannelNotImplementedError };
