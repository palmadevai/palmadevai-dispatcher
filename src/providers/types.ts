/**
 * Shared types across all outbound channel providers.
 *
 * Each provider (whatsapp, email, facebook, instagram, sms) implements a send
 * function that returns `ProviderSendResult`. Provider-specific input shapes
 * stay in their own files (e.g. `WhatsAppSendInput` in `whatsapp.ts`).
 *
 * The `Channel` union must stay aligned with the DB CHECK constraint on
 * `bot.campaign_deliveries.channel` (spec §4 schema).
 */

export type Channel = 'whatsapp' | 'email' | 'facebook' | 'instagram' | 'sms';

export interface ProviderSendResult {
  ok: boolean;
  message_id?: string;
  error_code?: string;
  error_message?: string;
  error_subcode?: string;
  error_type?: string;
  http_status?: number;
  raw_response?: unknown;
  raw_request?: unknown;
}

/**
 * Resultado del test de conexión de una credencial (T7.3 / F4).
 *
 * Cada proveedor implementa el suyo en su propio adapter — la URL y los nombres
 * de error son vocabulario del proveedor (R8/R9); el core sólo pregunta «¿esta
 * credencial sirve?» y despacha por id (`CREDENTIAL_VERIFIERS` en
 * `core/provider-cutover.ts`).
 */
export type CredentialCheck =
  | { ok: true; detail: string }
  | { ok: false; error_code: string; error_message: string; http_status: number };

export class ChannelNotImplementedError extends Error {
  readonly code = 'channel_not_implemented';
  constructor(public readonly channel: string) {
    super(`Provider for channel '${channel}' is not implemented`);
    this.name = 'ChannelNotImplementedError';
  }
}
