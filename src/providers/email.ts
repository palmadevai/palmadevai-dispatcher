/**
 * Email provider — Resend HTTPS REST adapter.
 *
 * POST https://api.resend.com/emails
 *
 * Body (per Resend API):
 *   {
 *     from: "Display Name <ops@example.com>" | "ops@example.com",
 *     to: ["jane@example.com"],
 *     subject: "...",
 *     html: "<p>...</p>",
 *     text: "..."             // optional plain-text fallback
 *     tags: [{name, value}]   // delivery tracking, max 10 keys
 *   }
 *
 * Error policy (mirrors WhatsApp adapter — ADR-009):
 *   - 2xx: return { ok: true, message_id: <resend id> }
 *   - 4xx: return { ok: false, error_code, error_message, http_status }
 *     (caller maps via classifyResendError)
 *   - 5xx: throw — let retry layer catch it
 *   - network/timeout: throw
 *
 * Footer unsubscribe is injected by the caller (`renderEmailBody`), not here —
 * keeps this adapter focused on the wire-level send, mirrors `whatsapp.ts`.
 */
import { request } from 'undici';
import { env } from '../env.js';
import { resolveProviderKey } from '../lib/providers.js';
import { logger } from '../lib/logger.js';
import { classifyResendError } from '../classify/email-error-classifier.js';
import type { DeliveryContext } from '../dispatch/audience-resolver.js';
import type { ChannelProvider, PrepareOutcome } from '../ports/channel-provider.js';
import type { ProviderSendResult } from './types.js';

export interface EmailSendInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Adjuntos en vocabulario NEUTRO (T9.1 / R8). El mapeo a los nombres de
   * Resend vive abajo, en el armado del body — que es el único lugar de este
   * archivo que puede saber de Resend.
   */
  attachments?: { filename: string; content_base64: string; content_type?: string }[];
  biz_opaque_callback_data: string;
}

const RESEND_API_URL = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 15_000;

interface ResendSuccessResponse {
  id?: string;
}

interface ResendErrorResponse {
  name?: string;
  message?: string;
  statusCode?: number;
}

export async function sendEmail(input: EmailSendInput): Promise<ProviderSendResult> {
  // La credencial se resuelve por llamada (T5.4): `ownership` puede cambiar en
  // caliente (BYOK) y con lectura en module-load un cutover no tomaba efecto
  // hasta reiniciar el contenedor. El resolver cachea 30 s.
  const key = await resolveProviderKey('resend');
  if (!key.ok) {
    // Error de config TERMINAL: se devuelve ok=false en vez de tirar, para que
    // la capa de retry ackee y el clasificador lo marque failed sin ciclos.
    return {
      ok: false,
      http_status: 0,
      error_code: 'resend_api_key_missing',
      error_message: key.error,
    };
  }

  const body = {
    from: input.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    ...(input.text ? { text: input.text } : {}),
    // ↓ ÚNICO punto donde el vocabulario neutro se traduce al del proveedor
    // (R8). Resend llama `content` al base64 y `content_type` al MIME; si
    // mañana el proveedor cambia, cambia esta línea y nada más.
    ...(input.attachments?.length
      ? {
          attachments: input.attachments.map((a) => ({
            filename: a.filename,
            content: a.content_base64,
            ...(a.content_type ? { content_type: a.content_type } : {}),
          })),
        }
      : {}),
    tags: [
      { name: 'client_ref', value: input.biz_opaque_callback_data },
    ],
  };

  let res;
  try {
    res = await request(RESEND_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { to_domain: input.to.split('@')[1], err: message },
      'Resend API network error — will retry',
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
    const success = responseBody as ResendSuccessResponse;
    const messageId = success.id;
    if (!messageId) {
      logger.warn(
        { status, responseBody },
        'Resend 2xx but no id in response — treating as error',
      );
      return {
        ok: false,
        http_status: status,
        error_code: 'no_message_id',
        error_message: 'Resend 2xx response missing id',
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

  const errBody = responseBody as ResendErrorResponse;
  const errorCode = errBody.name ?? `http_${status}`;
  const errorMessage = errBody.message ?? `HTTP ${status}`;

  if (status >= 500) {
    const err = new Error(`Resend ${status}: ${errorCode} ${errorMessage}`);
    (err as Error & { http_status?: number; error_code?: string }).http_status = status;
    (err as Error & { http_status?: number; error_code?: string }).error_code = errorCode;
    throw err;
  }

  return {
    ok: false,
    http_status: status,
    error_code: errorCode,
    error_message: errorMessage,
    raw_response: responseBody,
    raw_request: body,
  };
}

/**
 * Build the email HTML+subject for a delivery from the template.body jsonb and
 * the contact/binding variables. Inlines the unsubscribe footer.
 *
 * Template body shape (for `body_format='mjml_html'`):
 *   {
 *     subject: "Hola {{name}}",
 *     html: "<html>...{{name}}...</html>",
 *     text?: "plain-text fallback"
 *   }
 *
 * Variable substitution: simple `{{key}}` replacement, in priority order:
 *   1. delivery.template_variables (per-row overrides)
 *   2. aiResolvedBindings (Fase 4 AI body)
 *   3. campaign.template_variable_bindings (campaign-wide defaults)
 *   4. {{name}} → contact.display_name
 *
 * Unknown placeholders are left literal — same policy as WhatsApp components.
 *
 * NOTE: MJML compilation (mjml source → html) is NOT done here yet. Templates
 * stored as MJML are expected to have been pre-compiled at create time in
 * cockpit. Server-side mjml compile is a follow-up.
 */
export interface RenderEmailInput {
  templateBody: Record<string, unknown>;
  contactDisplayName: string | null;
  contactId: string;
  perRowBindings: Record<string, unknown> | null;
  campaignBindings: Record<string, unknown> | null;
  aiResolvedBindings: Record<string, unknown> | null;
  unsubscribeBaseUrl: string;
}

export interface RenderEmailOutput {
  subject: string;
  html: string;
  text?: string;
}

export function renderEmailBody(input: RenderEmailInput): RenderEmailOutput {
  const subject = String(input.templateBody.subject ?? '');
  const html = String(input.templateBody.html ?? '');
  const text =
    typeof input.templateBody.text === 'string' ? (input.templateBody.text as string) : undefined;

  const vars: Record<string, string> = {};
  if (input.contactDisplayName) vars.name = input.contactDisplayName;
  for (const [k, v] of Object.entries(input.campaignBindings ?? {})) {
    if (v != null) vars[k] = String(v);
  }
  for (const [k, v] of Object.entries(input.aiResolvedBindings ?? {})) {
    if (v != null) vars[k] = String(v);
  }
  for (const [k, v] of Object.entries(input.perRowBindings ?? {})) {
    if (v != null) vars[k] = String(v);
  }

  const interpolate = (s: string): string =>
    s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
      const v = vars[key];
      return v !== undefined ? v : match;
    });

  const renderedSubject = interpolate(subject);
  const renderedHtmlCore = interpolate(html);
  const renderedText = text ? interpolate(text) : undefined;

  const unsubUrl = `${input.unsubscribeBaseUrl.replace(/\/$/, '')}/u/${input.contactId}`;
  const footer =
    `<hr style="border:none;border-top:1px solid #ddd;margin-top:24px"/>` +
    `<p style="font-size:12px;color:#666;text-align:center;margin-top:12px">` +
    `Si no querés recibir más mensajes, ` +
    `<a href="${unsubUrl}" style="color:#666">date de baja acá</a>.` +
    `</p>`;

  const renderedHtml = renderedHtmlCore.includes('</body>')
    ? renderedHtmlCore.replace('</body>', `${footer}</body>`)
    : `${renderedHtmlCore}${footer}`;

  return {
    subject: renderedSubject,
    html: renderedHtml,
    ...(renderedText ? { text: renderedText } : {}),
  };
}

// ─── ChannelProvider (H1.1) ─────────────────────────────────────────────────

/**
 * Moved from `workers/dispatcher.ts` (the old `ctx.delivery.channel ===
 * 'email'` branch, pre-`acquireToken()` half): destination validation +
 * body rendering. Email has no `bot.outbound_endpoints` row (no picker), so
 * `prepare()` needs no injectable deps and ignores `tx`.
 */
export async function prepareEmail(
  _tx: unknown,
  ctx: DeliveryContext,
  aiResolvedBindings: Record<string, unknown>,
): Promise<PrepareOutcome> {
  if (!ctx.contact.email) {
    return {
      kind: 'terminal',
      error_code: 'no_email',
      error_message: 'audience contact has no email for email channel',
      failure_reason: 'email_invalid',
    };
  }

  const unsubBase = env.CAMPAIGNS_UNSUBSCRIBE_BASE_URL ?? `https://${env.DOMAIN}/unsubscribe`;
  const rendered = renderEmailBody({
    templateBody: ctx.template.body,
    contactDisplayName: ctx.contact.display_name,
    contactId: ctx.delivery.audience_contact_id,
    perRowBindings: ctx.delivery.template_variables,
    campaignBindings: ctx.campaign.template_variable_bindings,
    aiResolvedBindings,
    unsubscribeBaseUrl: unsubBase,
  });

  // Remitente de CAMPAÑAS: lo define la aplicación (el template, o el default
  // configurado de campañas), no el messaging service. Sin remitente no se
  // manda: el sandbox de Resend entregaba al dueño de la cuenta, así que una
  // campaña se reportaba enviada y no llegaba a nadie.
  const fromOverride =
    typeof ctx.template.body.from === 'string'
      ? (ctx.template.body.from as string)
      : env.CAMPAIGNS_DEFAULT_FROM_EMAIL;

  if (!fromOverride) {
    // Terminal, no retry: reintentar sin remitente da exactamente lo mismo.
    return {
      kind: 'terminal',
      error_code: 'email_from_missing',
      error_message:
        'sin remitente: ni template.body.from, ni bot.config[branding].email_from, ni CAMPAIGNS_DEFAULT_FROM_EMAIL',
      failure_reason: 'payload_invalid',
    };
  }

  const sendInput: EmailSendInput = {
    from: fromOverride,
    to: ctx.contact.email,
    subject: rendered.subject,
    html: rendered.html,
    ...(rendered.text ? { text: rendered.text } : {}),
    biz_opaque_callback_data: ctx.delivery.client_ref,
  };

  return {
    kind: 'ready',
    sendInput,
    endpointRowId: null,
    acceptedExtra: {},
    errorLogFields: { to_domain: ctx.contact.email.split('@')[1] },
  };
}

export const emailProvider: ChannelProvider = {
  channel: 'email',
  prepare: prepareEmail,
  send: (input: unknown) => sendEmail(input as EmailSendInput),
  classify: (result, attemptsMade, maxAttempts) => classifyResendError(result, attemptsMade, maxAttempts),
};
