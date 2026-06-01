/**
 * WhatsApp provider — Meta Cloud API `/messages` adapter.
 *
 * POST https://graph.facebook.com/{VERSION}/{phone_number_id}/messages
 *
 * Body (template send):
 *   {
 *     messaging_product: 'whatsapp',
 *     to: <E.164>,
 *     type: 'template',
 *     template: { name, language: {code}, components },
 *     biz_opaque_callback_data: <delivery.client_ref UUID>  // ADR-011
 *   }
 *
 * Error policy (ADR-009):
 *   - 2xx: return { ok: true, message_id }
 *   - 4xx: return { ok: false, error_code, error_message, http_status }
 *     (caller decides terminal vs retry via classifyMetaError)
 *   - 5xx: throw — let BullMQ-style retry layer catch it
 *   - network/timeout: throw
 *
 * NOTE: this function does NOT decide retry semantics. It only normalizes the
 * Meta response shape. classifier.ts owns the decision tree.
 */
import { request } from 'undici';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import type { ProviderSendResult } from './types.js';

export interface WhatsAppSendInput {
  phone_number_id: string;
  to: string;
  template_name: string;
  template_lang: string;
  components: unknown[];
  biz_opaque_callback_data: string;
  /**
   * Fase 9 — token del endpoint emisor fijado (multi-WABA / multi-app). Si se
   * omite, se usa el bearer global del .env (caso single-app / warming pool).
   */
  access_token?: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

interface MetaSuccessResponse {
  messaging_product?: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string; message_status?: string }>;
}

interface MetaErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: number | string;
    error_subcode?: number | string;
    fbtrace_id?: string;
  };
}

export async function sendWhatsApp(input: WhatsAppSendInput): Promise<ProviderSendResult> {
  const url =
    `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/` +
    `${encodeURIComponent(input.phone_number_id)}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to: input.to,
    type: 'template',
    template: {
      name: input.template_name,
      language: { code: input.template_lang },
      components: input.components,
    },
    biz_opaque_callback_data: input.biz_opaque_callback_data,
  };

  let res;
  try {
    res = await request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.access_token ?? env.META_WA_BEARER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    // Network-level failure. Re-throw so retry layer handles it.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { phone_number_id: input.phone_number_id, to_last4: input.to.slice(-4), err: message },
      'Meta API network error — will retry',
    );
    throw err;
  }

  const status = res.statusCode;
  // Try to read JSON; fall back to text. Meta typically returns JSON for both.
  let responseBody: unknown;
  try {
    responseBody = await res.body.json();
  } catch {
    try {
      responseBody = await res.body.text();
    } catch {
      responseBody = null;
    }
  }

  if (status >= 200 && status < 300) {
    const success = responseBody as MetaSuccessResponse;
    const messageId = success.messages?.[0]?.id;
    if (!messageId) {
      logger.warn(
        { status, responseBody },
        'Meta 2xx but no message_id in response — treating as error',
      );
      return {
        ok: false,
        http_status: status,
        error_code: 'no_message_id',
        error_message: 'Meta 2xx response missing message_id',
        raw_response: responseBody,
        raw_request: body,
      };
    }
    return {
      ok: true,
      message_id: messageId,
      http_status: status,
      raw_response: responseBody,
      raw_request: body,
    };
  }

  // 4xx / 5xx
  const errBody = responseBody as MetaErrorResponse;
  const errorCode = errBody.error?.code !== undefined ? String(errBody.error.code) : undefined;
  const errorMessage = errBody.error?.message ?? `HTTP ${status}`;
  const errorSubcode =
    errBody.error?.error_subcode !== undefined ? String(errBody.error.error_subcode) : undefined;
  const errorType = errBody.error?.type;

  if (status >= 500) {
    // Throw so the caller retries.
    const err = new Error(`Meta ${status}: ${errorCode ?? '?'} ${errorMessage}`);
    (err as Error & { http_status?: number; error_code?: string }).http_status = status;
    (err as Error & { http_status?: number; error_code?: string }).error_code = errorCode;
    throw err;
  }

  return {
    ok: false,
    http_status: status,
    error_code: errorCode,
    error_message: errorMessage,
    error_subcode: errorSubcode,
    error_type: errorType,
    raw_response: responseBody,
    raw_request: body,
  };
}
