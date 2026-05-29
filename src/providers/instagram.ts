/**
 * Instagram DM provider — Meta Graph `/me/messages` (Instagram Messaging API).
 *
 * POST https://graph.facebook.com/{VERSION}/me/messages?access_token=<page_token>
 *
 * Body:
 *   {
 *     recipient: { id: <IGSID> },                  // Instagram-Scoped User ID
 *     message:   { text: "<body>" },
 *     messaging_type: "MESSAGE_TAG" | "RESPONSE" | "UPDATE",
 *     tag?: "HUMAN_AGENT"                         // único tag aceptado por IG
 *   }
 *
 * Importante:
 *   - IG comparte endpoint /me/messages con FB Messenger pero usa IGSIDs en
 *     vez de PSIDs y requiere que la Page que envía tenga conectada una
 *     IG Business/Creator account.
 *   - El access_token es el Page Access Token de la Page conectada — Meta
 *     consume el contexto IG desde la connection Page↔IG.
 *   - Outside ventana 24h: solo `HUMAN_AGENT` tag es válido para IG, y
 *     requiere app review approved del permiso Human Agent. Sin él, IG
 *     responde 24h-window-required (code 10903).
 *   - NO existen ACCOUNT_UPDATE / POST_PURCHASE_UPDATE / CONFIRMED_EVENT_UPDATE
 *     para IG — son solo FB Messenger. IG es más restrictivo.
 *
 * Error policy idéntica WA/FB (2xx→ok, 4xx→ok=false, 5xx/net→throw).
 */
import { request } from 'undici';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import type { ProviderSendResult } from './types.js';

export interface InstagramSendInput {
  page_access_token: string;
  recipient_igsid: string;
  message_text: string;
  /** Solo HUMAN_AGENT acepta IG. Omitir = mensaje solo dentro de 24h window. */
  messaging_tag?: 'HUMAN_AGENT';
  biz_opaque_callback_data: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

interface MetaIgSuccess {
  recipient_id?: string;
  message_id?: string;
}

interface MetaIgError {
  error?: {
    message?: string;
    type?: string;
    code?: number | string;
    error_subcode?: number | string;
    fbtrace_id?: string;
  };
}

export async function sendInstagramDm(input: InstagramSendInput): Promise<ProviderSendResult> {
  const url =
    `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/me/messages` +
    `?access_token=${encodeURIComponent(input.page_access_token)}`;

  const body: Record<string, unknown> = {
    recipient: { id: input.recipient_igsid },
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
      { igsid_last4: input.recipient_igsid.slice(-4), err: message },
      'IG DM network error — will retry',
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
    const success = responseBody as MetaIgSuccess;
    const messageId = success.message_id;
    if (!messageId) {
      logger.warn({ status, responseBody }, 'IG 2xx but no message_id — treating as error');
      return {
        ok: false,
        http_status: status,
        error_code: 'no_message_id',
        error_message: 'IG DM 2xx response missing message_id',
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

  const errBody = responseBody as MetaIgError;
  const errorCode = errBody.error?.code !== undefined ? String(errBody.error.code) : undefined;
  const errorMessage = errBody.error?.message ?? `HTTP ${status}`;
  const errorSubcode =
    errBody.error?.error_subcode !== undefined ? String(errBody.error.error_subcode) : undefined;
  const errorType = errBody.error?.type;

  if (status >= 500) {
    const err = new Error(`IG DM ${status}: ${errorCode ?? '?'} ${errorMessage}`);
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
