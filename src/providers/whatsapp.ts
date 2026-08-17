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
import type { TransactionSql } from 'postgres';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { resolveProviderKey } from '../lib/providers.js';
import { resolvePinnedWaEndpoint, pickPhoneForContact } from '../dispatch/pick-phone.js';
import { resolveTemplateComponents } from '../dispatch/audience-resolver.js';
import type { DeliveryContext } from '../dispatch/audience-resolver.js';
import { classifyMetaError } from '../classify/error-classifier.js';
import type { ChannelProvider, PrepareOutcome, TerminalOverride } from '../ports/channel-provider.js';
import type { ProviderSendResult } from './types.js';

export interface WhatsAppSendInput {
  phone_number_id: string;
  to: string;
  biz_opaque_callback_data: string;
  /**
   * Fase 9 — token del endpoint emisor fijado (multi-WABA / multi-app). Si se
   * omite, se usa el bearer global del .env (caso single-app / warming pool).
   */
  access_token?: string;
  /**
   * H2.1 (messaging-service `POST /send`) — discriminant. Optional +
   * defaults to the template wire shape so every existing call site (the
   * campaign worker via `prepareWhatsApp`, which never sets this field)
   * keeps compiling and behaving unchanged. Only `/send` sets `type: 'text'`.
   */
  type?: 'template' | 'text';
  // ── type: 'template' (default) ──────────────────────────────────────────
  template_name?: string;
  template_lang?: string;
  components?: unknown[];
  // ── type: 'text' ─────────────────────────────────────────────────────────
  // v1 limitation (H2.1): the Meta 24h customer-service window is NOT
  // validated here — Meta rejects out-of-window text sends on its own and we
  // surface that error transparently (error_code/message from the 4xx body)
  // rather than pre-checking `bot.campaign_deliveries`/Chatwoot conversation
  // state for a window that only applies to this one send path.
  body?: string;
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
  // S5.1 (ADR-005) — la guarda del canal: la credencial de Meta se resuelve
  // por el piso 1 (vault→db→env, mismo resolver que resend) y su AUSENCIA es
  // una falla de ESTE envío con la causa nombrada — nunca del boot (regla del
  // incidente META_WA_APP_SECRET). `access_token` explícito (BYOK por endpoint)
  // sigue teniendo prioridad, como siempre.
  let bearer = input.access_token ?? null;
  if (!bearer) {
    const key = await resolveProviderKey('meta');
    if (!key.ok) {
      logger.error(
        { phone_number_id: input.phone_number_id, to_last4: input.to.slice(-4), err: key.error },
        'canal WhatsApp sin credencial — envío no intentado',
      );
      return {
        ok: false,
        error_code: 'missing_credential',
        error_message: key.error,
      };
    }
    bearer = key.apiKey;
  }

  const url =
    `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/` +
    `${encodeURIComponent(input.phone_number_id)}/messages`;

  const body =
    input.type === 'text'
      ? {
          messaging_product: 'whatsapp',
          to: input.to,
          type: 'text',
          text: { body: input.body ?? '' },
          biz_opaque_callback_data: input.biz_opaque_callback_data,
        }
      : {
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
        authorization: `Bearer ${bearer}`,
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

// ─── ChannelProvider (H1.1) ─────────────────────────────────────────────────

/**
 * Injectable deps for `prepare()` — defaults to the real DB pickers /
 * component resolver. Tests substitute fakes here instead of mocking `tx`
 * query-by-query.
 */
export interface WhatsAppPrepareDeps {
  resolvePinnedWaEndpoint: typeof resolvePinnedWaEndpoint;
  pickPhoneForContact: typeof pickPhoneForContact;
  resolveTemplateComponents: typeof resolveTemplateComponents;
}

const defaultWhatsAppPrepareDeps: WhatsAppPrepareDeps = {
  resolvePinnedWaEndpoint,
  pickPhoneForContact,
  resolveTemplateComponents,
};

/**
 * Moved from `workers/dispatcher.ts` (the old `ctx.delivery.channel ===
 * 'whatsapp'` branch, pre-`acquireToken()` half): destination validation,
 * pinned-endpoint → auto-pick endpoint resolution (Fase 9 multi-WABA), and
 * template component resolution.
 */
export async function prepareWhatsApp(
  tx: TransactionSql,
  ctx: DeliveryContext,
  aiResolvedBindings: Record<string, unknown>,
  deps: WhatsAppPrepareDeps = defaultWhatsAppPrepareDeps,
): Promise<PrepareOutcome> {
  if (!ctx.contact.phone) {
    return {
      kind: 'terminal',
      error_code: 'no_phone',
      error_message: 'audience contact has no phone for whatsapp channel',
      failure_reason: 'phone_invalid',
    };
  }

  // Fase 9 — emisor: si la campaña fijó un endpoint (multi-WABA), usar ESE
  // número + su token. Si no, auto-pick legacy (sticky + warming pool).
  let phone: { id: string; phone_number_id: string } | null = null;
  let waAccessToken: string | undefined;
  if (ctx.campaign.outbound_endpoint_id) {
    const pinned = await deps.resolvePinnedWaEndpoint(tx, ctx.campaign.outbound_endpoint_id);
    if (pinned) {
      phone = { id: pinned.id, phone_number_id: pinned.phone_number_id };
      waAccessToken = pinned.access_token ?? undefined;
    } else {
      logger.warn(
        {
          deliveryId: ctx.delivery.id,
          campaign_id: ctx.delivery.campaign_id,
          outbound_endpoint_id: ctx.campaign.outbound_endpoint_id,
        },
        'pinned outbound_endpoint no usable (missing/disabled) — fallback a auto-pick',
      );
    }
  }
  if (!phone) {
    phone = await deps.pickPhoneForContact(tx, ctx.delivery.audience_contact_id);
  }
  if (!phone) {
    return { kind: 'no_endpoint', throwMessage: 'NoAvailablePhonesError' };
  }

  const components = deps.resolveTemplateComponents(
    ctx.template,
    ctx.contact,
    ctx.delivery.template_variables,
    aiResolvedBindings,
  );

  const sendInput: WhatsAppSendInput = {
    phone_number_id: phone.phone_number_id,
    to: ctx.contact.phone,
    template_name: ctx.template.name,
    template_lang: ctx.template.language,
    components,
    biz_opaque_callback_data: ctx.delivery.client_ref,
    ...(waAccessToken ? { access_token: waAccessToken } : {}),
  };

  return {
    kind: 'ready',
    sendInput,
    endpointRowId: phone.id,
    acceptedExtra: { wa_phone_number_id: phone.id },
    errorLogFields: {
      to_last4: ctx.contact.phone.slice(-4),
      phone_number_id: phone.phone_number_id,
    },
  };
}

/** 131049 (cross-brand 2/24h frequency cap) — terminal undelivered, NOT DLQ. WA-only. */
export function whatsAppTerminalOverride(result: ProviderSendResult): TerminalOverride | null {
  if ((result.error_code ?? '') !== '131049') return null;
  return {
    markAs: 'undelivered',
    error_code: '131049',
    error_message: 'Meta frequency cap (cross-brand 2/24h)',
    failure_reason: 'provider_freq_cap',
    metricsKey: 'freq_cap_131049',
  };
}

export const whatsappProvider: ChannelProvider = {
  channel: 'whatsapp',
  prepare: prepareWhatsApp,
  send: (input: unknown) => sendWhatsApp(input as WhatsAppSendInput),
  classify: (result, attemptsMade, maxAttempts) => classifyMetaError(result, attemptsMade, maxAttempts),
  terminalOverride: whatsAppTerminalOverride,
};

// ─── Read receipts ──────────────────────────────────────────────────────────

export interface WhatsAppMarkReadInput {
  phone_number_id: string;
  /** `wamid.…` del mensaje ENTRANTE que se marca leído. */
  message_id: string;
  /** BYOK por endpoint (multi-WABA), igual que en el envío. */
  access_token?: string;
}

export interface MarkReadResult {
  ok: boolean;
  http_status?: number;
  error_code?: string;
  error_message?: string;
}

/**
 * `POST /{phone_number_id}/messages` con `status: 'read'` — el tilde azul.
 *
 * POR QUÉ VIVE ACÁ Y NO EN n8n (R8, «cero Graph fuera del dispatcher»)
 *
 * Hasta 2026-08-17 el nodo `Mark as Read WA` de `whatsapp-bot-core` le pegaba
 * DIRECTO a graph.facebook.com, y para eso n8n necesitaba su propia copia del
 * número (`META_WA_PHONE_NUMBER_ID`) además del bearer. Esa env era la única
 * razón por la que el número del cliente vivía en dos nombres distintos: acá
 * `META_WA_DEFAULT_PHONE_NUMBER_ID` (con validación, tests y override por
 * mensaje) y allá una copia sin nada de eso, que en palmawebs estaba **vacía**
 * — el mark-as-read armaba `graph.facebook.com/v24.0//messages` y fallaba en
 * silencio (`neverError: true`) sin un error en ningún log.
 *
 * ERROR POLICY: DISTINTA a la del envío, a propósito. Un envío que falla se
 * reintenta y se clasifica porque el mensaje importa; un read receipt es
 * cosmético. Acá NUNCA se lanza —ni en 5xx ni en error de red— y no hay retry:
 * el peor caso aceptable es que un mensaje quede sin tilde azul. Lanzar haría
 * que una caída de Meta ensuciara el log del bot por algo que no afecta a nadie.
 */
export async function markReadWhatsApp(input: WhatsAppMarkReadInput): Promise<MarkReadResult> {
  let bearer = input.access_token ?? null;
  if (!bearer) {
    const key = await resolveProviderKey('meta');
    if (!key.ok) {
      logger.warn(
        { phone_number_id: input.phone_number_id, err: key.error },
        'mark-read sin credencial de Meta — no se intenta',
      );
      return { ok: false, error_code: 'missing_credential', error_message: key.error };
    }
    bearer = key.apiKey;
  }

  const url =
    `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/` +
    `${encodeURIComponent(input.phone_number_id)}/messages`;

  try {
    const res = await request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: input.message_id,
      }),
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    });

    const status = res.statusCode;
    if (status >= 200 && status < 300) {
      // El cuerpo se descarta a propósito (`{success:true}`), pero se CONSUME:
      // undici filtra si nadie lee el body y el socket queda colgado.
      await res.body.dump();
      return { ok: true, http_status: status };
    }

    let body: unknown = null;
    try {
      body = await res.body.json();
    } catch {
      body = null;
    }
    const err = (body as MetaErrorResponse | null)?.error;
    const result: MarkReadResult = {
      ok: false,
      http_status: status,
      error_code: err?.code !== undefined ? String(err.code) : undefined,
      error_message: err?.message ?? `HTTP ${status}`,
    };
    logger.warn(
      { phone_number_id: input.phone_number_id, ...result },
      'mark-read rechazado por Meta — sin retry (es cosmético)',
    );
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(
      { phone_number_id: input.phone_number_id, err: message },
      'mark-read: error de red — sin retry (es cosmético)',
    );
    return { ok: false, error_code: 'network_error', error_message: message };
  }
}
