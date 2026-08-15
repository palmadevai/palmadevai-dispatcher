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
import { resolveProviderKey } from '../lib/providers.js';
import type { CredentialCheck } from './types.js';

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
  // S5.1: mismo resolver del piso 1 que el canal de envío. Sin credencial, el
  // management de WhatsApp responde su error con la causa — el resto del plano
  // (Resend, credenciales, dominios) sigue operativo.
  const key = await resolveProviderKey('meta');
  if (!key.ok) {
    return { ok: false, error: `whatsapp management sin credencial — ${key.error}` };
  }
  let res;
  try {
    res = await request(graphUrl(pathAndQuery), {
      method,
      headers: {
        authorization: `Bearer ${key.apiKey}`,
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

/**
 * Test de conexión de una credencial de Meta (T7.3 / F4), sin mandar nada.
 *
 * Va con el bearer CANDIDATO —el que el operador acaba de cargar en el vault—
 * y no con el que entrega el resolver: lo que se prueba es la credencial nueva.
 *
 * `GET /{waba_id}` y no `/me` a propósito: leer la WABA contesta las DOS cosas
 * que el botón «probar» tiene que contestar en una rotación (S1.1) — que el
 * token autentica Y que accede a la WABA de ESTE cliente. Un token válido de
 * otro Business Manager autentica igual contra `/me`, y aceptarlo repetiría el
 * modo de falla del token compartido que la rotación viene a separar.
 */
export async function verifyMetaCredential(bearer: string): Promise<CredentialCheck> {
  // Guarda EN EL CANAL de `META_WA_WABA_ID` (ver el bloque en env.ts): sin WABA
  // id no hay contra qué verificar. Se contesta con la causa NOMBRADA en vez de
  // pegarle a la Graph API con un id vacío, que devolvería un 400 genérico y
  // haría parecer que el token está mal cuando lo que falta es la config.
  if (!env.META_WA_WABA_ID) {
    return {
      ok: false,
      error_code: 'waba_id_missing',
      error_message:
        'META_WA_WABA_ID no está configurada: el canal WhatsApp de este cliente todavía no está cableado. ' +
        'No es un problema del token.',
      http_status: 400,
    };
  }
  let res;
  try {
    res = await request(graphUrl(`${encodeURIComponent(env.META_WA_WABA_ID)}?fields=id,name`), {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    // Una caída de red NO es una credencial mala — mismo criterio que el
    // verificador de Resend: el llamador decide, y lo que decide es no aceptar.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error_code: 'network_error', error_message: message, http_status: 0 };
  }

  const status = res.statusCode;
  let body: unknown = null;
  try {
    body = await res.body.json();
  } catch {
    body = null;
  }

  if (status >= 200 && status < 300) {
    const name = (body as { name?: string } | null)?.name;
    return {
      ok: true,
      detail: name
        ? `la credencial autenticó contra Meta y accede a la WABA «${name}»`
        : 'la credencial autenticó contra Meta y accede a la WABA del cliente',
    };
  }

  const errObj = (body as { error?: { message?: string; code?: number; type?: string } } | null)
    ?.error;
  return {
    ok: false,
    error_code: errObj?.type ?? `http_${status}`,
    error_message: errObj?.message ?? `HTTP ${status}`,
    http_status: status,
  };
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
