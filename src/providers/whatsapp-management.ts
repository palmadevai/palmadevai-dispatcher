/**
 * WhatsApp management adapter — Meta Graph API *management* surface (F3/H3.1-H3.2).
 *
 * Wire-level only, mirroring `whatsapp.ts` (the send adapter): this module
 * normalizes Graph responses into result values and NEVER touches the DB or
 * decides business behavior — that lives in `core/management.ts` (§3.4 rule:
 * errores neutrales en el core, mapeo en el adapter).
 *
 * Endpoints covered (moved here from campaign-site `src/lib/campaigns.ts` and
 * the retired n8n `campaigns-template-sync` cron):
 *   GET    /{waba_id}/message_templates          — template mirror source
 *   POST   /{waba_id}/message_templates          — create (Meta reviews async)
 *   DELETE /{waba_id}/message_templates?name=    — delete (Graph deletes by NAME)
 *   GET    /{waba_id}/phone_numbers              — endpoint/quality provisioning
 *   GET    /{phone_number_id}?fields=quality_... — per-phone quality refresh
 *
 * Error policy: management calls are operator-facing and synchronous — no
 * retry layer behind them. Every failure (HTTP 4xx/5xx AND network) is
 * returned as `{ ok: false, error }` so the core can surface it verbatim,
 * matching the historical campaign-site behavior (it never threw for Meta
 * errors except template DELETE, which the core re-creates).
 */
import { request } from 'undici';
import { env } from '../env.js';

const REQUEST_TIMEOUT_MS = 15_000;

export interface GraphTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: Array<Record<string, unknown>>;
  rejected_reason?: string;
  quality_score?: unknown;
}

export interface GraphPhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name?: string;
  quality_rating?: string;
}

export type GraphResult<T> = ({ ok: true } & T) | { ok: false; http_status?: number; error: string };

function graphUrl(pathAndQuery: string): string {
  return `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${pathAndQuery}`;
}

async function graphRequest(
  method: 'GET' | 'POST' | 'DELETE',
  pathAndQuery: string,
  body?: unknown,
): Promise<{ ok: true; status: number; json: unknown } | { ok: false; http_status?: number; error: string }> {
  let res;
  try {
    res = await request(graphUrl(pathAndQuery), {
      method,
      headers: {
        authorization: `Bearer ${env.META_WA_BEARER_TOKEN}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    return { ok: true, status, json: responseBody };
  }

  const errObj = (responseBody as { error?: { message?: string; error_user_msg?: string } })?.error;
  const detail =
    errObj?.error_user_msg ??
    errObj?.message ??
    (typeof responseBody === 'string' ? responseBody.slice(0, 200) : `HTTP ${status}`);
  return { ok: false, http_status: status, error: `HTTP ${status}: ${detail}` };
}

export async function fetchTemplates(
  wabaId: string,
): Promise<GraphResult<{ templates: GraphTemplate[] }>> {
  const fields = 'id,name,language,status,category,components,quality_score,rejected_reason';
  const r = await graphRequest(
    'GET',
    `${encodeURIComponent(wabaId)}/message_templates?fields=${fields}&limit=200`,
  );
  if (!r.ok) return r;
  const data = (r.json as { data?: GraphTemplate[] })?.data ?? [];
  return { ok: true, templates: data };
}

export async function createTemplate(
  wabaId: string,
  payload: {
    name: string;
    language: string;
    category: string;
    components: Array<Record<string, unknown>>;
  },
): Promise<GraphResult<{ id?: string; status?: string }>> {
  const r = await graphRequest('POST', `${encodeURIComponent(wabaId)}/message_templates`, payload);
  if (!r.ok) return r;
  const data = r.json as { id?: string; status?: string };
  return { ok: true, id: data.id, status: data.status };
}

export async function deleteTemplateByName(
  wabaId: string,
  name: string,
): Promise<GraphResult<Record<never, never>>> {
  const r = await graphRequest(
    'DELETE',
    `${encodeURIComponent(wabaId)}/message_templates?name=${encodeURIComponent(name)}`,
  );
  if (!r.ok) return r;
  return { ok: true };
}

export async function fetchPhoneNumbers(
  wabaId: string,
): Promise<GraphResult<{ phones: GraphPhoneNumber[] }>> {
  const fields = 'id,display_phone_number,verified_name,quality_rating';
  const r = await graphRequest(
    'GET',
    `${encodeURIComponent(wabaId)}/phone_numbers?fields=${fields}&limit=50`,
  );
  if (!r.ok) return r;
  const data = (r.json as { data?: GraphPhoneNumber[] })?.data ?? [];
  return { ok: true, phones: data };
}

export async function fetchPhoneQuality(
  phoneNumberId: string,
): Promise<GraphResult<{ quality_rating?: string; messaging_limit_tier?: string }>> {
  const r = await graphRequest(
    'GET',
    `${encodeURIComponent(phoneNumberId)}?fields=quality_rating,messaging_limit_tier`,
  );
  if (!r.ok) return r;
  const data = r.json as { quality_rating?: string; messaging_limit_tier?: string };
  return { ok: true, quality_rating: data.quality_rating, messaging_limit_tier: data.messaging_limit_tier };
}

/** Bundle injected into `core/management.ts` — tests substitute fakes. */
export const graphManagement = {
  fetchTemplates,
  createTemplate,
  deleteTemplateByName,
  fetchPhoneNumbers,
  fetchPhoneQuality,
};
export type GraphManagement = typeof graphManagement;
