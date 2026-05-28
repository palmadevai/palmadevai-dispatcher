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
import { logger } from '../lib/logger.js';
import type { ProviderSendResult } from './types.js';

export interface EmailSendInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
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
  if (!env.RESEND_API_KEY) {
    // Treat as terminal config error — operator forgot the env var.
    // Returning ok=false (not throwing) lets the retry layer ack and the
    // classifier mark it failed without retry cycles.
    return {
      ok: false,
      http_status: 0,
      error_code: 'resend_api_key_missing',
      error_message: 'RESEND_API_KEY is not configured in the dispatcher env',
    };
  }

  const body = {
    from: input.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    ...(input.text ? { text: input.text } : {}),
    tags: [
      { name: 'client_ref', value: input.biz_opaque_callback_data },
    ],
  };

  let res;
  try {
    res = await request(RESEND_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
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
