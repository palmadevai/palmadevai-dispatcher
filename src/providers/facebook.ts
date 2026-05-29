/**
 * Facebook Messenger provider — Meta Graph `/me/messages` adapter.
 *
 * POST https://graph.facebook.com/{VERSION}/me/messages?access_token=<page_token>
 *
 * Body:
 *   {
 *     recipient: { id: <PSID> },                       // Page-Scoped User ID
 *     message:   { text: "<body>" },
 *     messaging_type: "MESSAGE_TAG" | "RESPONSE" | "UPDATE",
 *     tag?: "ACCOUNT_UPDATE" | "POST_PURCHASE_UPDATE" | "CONFIRMED_EVENT_UPDATE",
 *   }
 *
 * Important Meta restriction:
 *   - Outside the 24-hour window, Messenger REQUIRES messaging_type=MESSAGE_TAG
 *     with a valid `tag`. Without it, send fails with code 1545041.
 *   - Marketing broadcasts therefore must use ACCOUNT_UPDATE-style tags or
 *     paid sponsored messages (the latter not modelled here).
 *
 * The dispatcher passes `messaging_tag` from the template body — operator picks
 * the tag when authoring the template (see cockpit Templates FB tab, F5-PR5).
 *
 * Error policy mirrors WhatsApp:
 *   - 2xx → ok=true, message_id = response.message_id.
 *   - 4xx → ok=false (caller classifies via classifyMessengerError).
 *   - 5xx / network → throw to retry layer.
 *
 * Page Access Token comes from bot.outbound_endpoints.access_token — each Page
 * has its own. No env-var cliente-wide.
 */
import { request } from 'undici';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import type { ProviderSendResult } from './types.js';

export interface FacebookSendInput {
  page_access_token: string;
  recipient_psid: string;
  message_text: string;
  messaging_tag?: 'ACCOUNT_UPDATE' | 'POST_PURCHASE_UPDATE' | 'CONFIRMED_EVENT_UPDATE';
  biz_opaque_callback_data: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

interface MetaMessengerSuccess {
  recipient_id?: string;
  message_id?: string;
}

interface MetaMessengerError {
  error?: {
    message?: string;
    type?: string;
    code?: number | string;
    error_subcode?: number | string;
    fbtrace_id?: string;
  };
}

export async function sendFacebookMessenger(input: FacebookSendInput): Promise<ProviderSendResult> {
  const url =
    `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/me/messages` +
    `?access_token=${encodeURIComponent(input.page_access_token)}`;

  const body: Record<string, unknown> = {
    recipient: { id: input.recipient_psid },
    message: { text: input.message_text },
    messaging_type: input.messaging_tag ? 'MESSAGE_TAG' : 'RESPONSE',
  };
  if (input.messaging_tag) {
    body.tag = input.messaging_tag;
  }

  let res;
  try {
    res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { psid_last4: input.recipient_psid.slice(-4), err: message },
      'FB Messenger network error — will retry',
    );
    throw err;
  }

  const status = res.statusCode;
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
    const success = responseBody as MetaMessengerSuccess;
    const messageId = success.message_id;
    if (!messageId) {
      logger.warn({ status, responseBody }, 'FB 2xx but no message_id — treating as error');
      return {
        ok: false,
        http_status: status,
        error_code: 'no_message_id',
        error_message: 'FB Messenger 2xx response missing message_id',
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

  const errBody = responseBody as MetaMessengerError;
  const errorCode = errBody.error?.code !== undefined ? String(errBody.error.code) : undefined;
  const errorMessage = errBody.error?.message ?? `HTTP ${status}`;
  const errorSubcode =
    errBody.error?.error_subcode !== undefined ? String(errBody.error.error_subcode) : undefined;
  const errorType = errBody.error?.type;

  if (status >= 500) {
    const err = new Error(`FB Messenger ${status}: ${errorCode ?? '?'} ${errorMessage}`);
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
