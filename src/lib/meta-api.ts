/**
 * Meta WhatsApp Cloud API — thin facade.
 *
 * Real implementation lives in `src/dispatch/send-whatsapp.ts`. This module
 * keeps the historical `createMetaApiClient(logger)` interface so callers
 * (index.ts, tests, future channels) stay imports-stable. The dispatcher
 * worker calls `sendWhatsApp` directly for the hot path.
 *
 * `ping()` is a healthcheck stub. Real Meta connectivity check would GET
 * /{phone_number_id} but that requires picking a phone_number_id first; we
 * don't want /health to depend on per-client config. Returns true unconditionally;
 * the dispatcher worker discovers Meta issues on the actual send path and
 * surfaces them via classifyMetaError + /admin/observability metrics.
 */
import { env } from '../env.js';
import type { Logger } from './logger.js';
import {
  sendWhatsApp as sendWhatsAppReal,
  type SendWhatsAppInput,
  type SendWhatsAppResult,
} from '../dispatch/send-whatsapp.js';

export interface SendMessageInput {
  to_phone_e164: string;
  from_phone_number_id: string;
  client_ref: string;
  template_name: string;
  language: string;
  components: unknown[];
}

export interface SendMessageResult {
  ok: boolean;
  message_id?: string;
  error_code?: string;
  error_message?: string;
  http_status?: number;
}

export interface MetaApiClient {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  ping(): Promise<boolean>;
}

function adapt(result: SendWhatsAppResult): SendMessageResult {
  return {
    ok: result.ok,
    message_id: result.message_id,
    error_code: result.error_code,
    error_message: result.error_message,
    http_status: result.http_status,
  };
}

export function createMetaApiClient(logger: Logger): MetaApiClient {
  logger.debug(
    { api_version: env.META_GRAPH_API_VERSION },
    'meta-api facade initialized',
  );

  return {
    async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
      const payload: SendWhatsAppInput = {
        phone_number_id: input.from_phone_number_id,
        to: input.to_phone_e164,
        template_name: input.template_name,
        template_lang: input.language,
        components: input.components,
        biz_opaque_callback_data: input.client_ref,
      };
      const result = await sendWhatsAppReal(payload);
      return adapt(result);
    },
    async ping(): Promise<boolean> {
      return true;
    },
  };
}

export type MetaApi = ReturnType<typeof createMetaApiClient>;
