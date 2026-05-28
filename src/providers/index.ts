/**
 * Outbound provider registry — Fase 5 Item 4 (canal-agnostic refactor).
 *
 * Single entry point that the dispatcher uses to validate that a delivery's
 * channel has an implemented adapter before constructing the provider-specific
 * payload. Each channel adds its own send function in subsequent Fase 5 PRs:
 *
 *   - PR0 (current): whatsapp only — others throw ChannelNotImplementedError.
 *   - PR2: email (Resend SMTP adapter).
 *   - PR-FB: facebook Messenger (Meta Graph Page).
 *   - PR-IG: instagram DM (Meta Graph IG).
 *
 * The dispatcher.ts worker calls `assertProviderAvailable(channel)` after
 * resolving the delivery context and before building the send input. A
 * `ChannelNotImplementedError` is terminal — classifier maps it to a `failed`
 * delivery with `failure_reason='channel_not_implemented'` (no retry).
 */

import { sendWhatsApp, type WhatsAppSendInput } from './whatsapp.js';
import { sendEmail, renderEmailBody, type EmailSendInput, type RenderEmailInput, type RenderEmailOutput } from './email.js';
import { ChannelNotImplementedError, type Channel, type ProviderSendResult } from './types.js';

export { sendWhatsApp, sendEmail, renderEmailBody };
export type {
  WhatsAppSendInput,
  EmailSendInput,
  RenderEmailInput,
  RenderEmailOutput,
  Channel,
  ProviderSendResult,
};
export { ChannelNotImplementedError };

const IMPLEMENTED_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(['whatsapp', 'email']);

export function isChannelImplemented(channel: string): channel is Channel {
  return IMPLEMENTED_CHANNELS.has(channel as Channel);
}

export function assertProviderAvailable(channel: string): asserts channel is Channel {
  if (!isChannelImplemented(channel)) {
    throw new ChannelNotImplementedError(channel);
  }
}
