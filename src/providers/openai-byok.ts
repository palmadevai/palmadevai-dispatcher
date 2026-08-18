/**
 * La prueba de USO REAL de una key de OpenAI traída por el cliente (BYOK).
 *
 * Es la «Evidencia A» del gate de cutover (byok §7.12, G1): una completion de
 * verdad — no un `GET /models` — contra la cuenta del cliente. Un 200 de auth
 * no prueba permiso de completions, ni cuota, ni acceso al modelo en SU
 * proyecto; la completion prueba las tres, y además devuelve la identidad de
 * la cuenta que facturó (header `openai-organization`), que es lo que la
 * Evidencia B compara después contra el upstream del gateway.
 *
 * SIEMPRE contra `api.openai.com` — a propósito y distinto de
 * `verifyOpenAiCredential` (lib/ai-personalize), que ejercita la base URL del
 * personalize porque su credencial es la NUESTRA (con gateway, una virtual key
 * de LiteLLM). La credencial BYOK es la cuenta de OpenAI del cliente: probarla
 * contra el gateway respondería «inválida» sobre una key perfectamente buena
 * (medido en el lab: la base del personalize es `http://litellm:4000/v1`).
 *
 * Costo: un token de salida con el modelo barato — fracciones de centavo, y lo
 * paga la key que se está probando, que es lo correcto: es SU prueba.
 */
import { env } from '../env.js';
import type { CredentialCheck } from './types.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const TIMEOUT_MS = 15_000;

/**
 * `max_completion_tokens` y no `max_tokens`: los gpt-5.x rechazan el segundo
 * y los 4o aceptan los dos (gotcha documentado en apps/docs/openai-models.md).
 */
function testModel(): string {
  // `''` cuenta como ausente: la lista curada `environment:` entrega toda env
  // opcional como string vacío, nunca como undefined (incidente 2026-08-10).
  return env.OPENAI_CUTOVER_TEST_MODEL || 'gpt-4o-mini';
}

export type OpenAiRealUseCheck =
  | { ok: true; response_id: string; model: string; organization: string | null }
  | { ok: false; error_code: string; error_message: string; http_status: number };

export async function realOpenAiCompletion(apiKey: string): Promise<OpenAiRealUseCheck> {
  const model = testModel();
  let res: Response;
  try {
    res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping de verificación de titularidad (cutover BYOK)' }],
        max_completion_tokens: 1,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Una caída de red NO es una credencial mala — mismo criterio que los
    // verificadores de Resend, Meta y el de `/models`.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error_code: 'network_error', error_message: message, http_status: 0 };
  }

  if (!res.ok) {
    let errorCode = `http_${res.status}`;
    let errorMessage = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } } | null;
      if (body?.error?.code) errorCode = body.error.code;
      if (body?.error?.message) errorMessage = body.error.message;
    } catch {
      // Sin cuerpo JSON: queda el status pelado, que ya nombra el problema.
    }
    return { ok: false, error_code: errorCode, error_message: errorMessage, http_status: res.status };
  }

  let responseId = '';
  let responseModel = model;
  try {
    const body = (await res.json()) as { id?: string; model?: string } | null;
    responseId = body?.id ?? '';
    if (body?.model) responseModel = body.model;
  } catch {
    // 200 sin JSON no debería pasar; la evidencia queda con el id vacío y el
    // caller decide si le alcanza.
  }
  if (!responseId) {
    return {
      ok: false,
      error_code: 'no_response_id',
      error_message: 'la completion respondió 200 sin id: no hay evidencia que guardar',
      http_status: res.status,
    };
  }

  return {
    ok: true,
    response_id: responseId,
    model: responseModel,
    // La identidad de la cuenta que facturó. Es la mitad de la Evidencia B:
    // el flip a `owned` compara esto contra la organización que reporta el
    // upstream del gateway (header `llm_provider-openai-organization`, G2).
    organization: res.headers.get('openai-organization'),
  };
}

/**
 * El «probar» de la card BYOK de OpenAI (T7.3): un `GET /models` DIRECTO contra
 * `api.openai.com`, con la key del cliente.
 *
 * Existe porque el verificador del personalize (`verifyOpenAiCredential`,
 * lib/ai-personalize) prueba contra la base URL del PERSONALIZE — con gateway,
 * `http://litellm:4000/v1` — porque su credencial es la nuestra (una virtual
 * key). La key BYOK del cliente contra esa base respondería «inválida» siendo
 * perfectamente buena (hallazgo de G1, byok §7.12). Dos credenciales, dos
 * consumidores, dos verificadores.
 *
 * Es el filtro barato, no el gate: no cuesta nada y no prueba permiso de
 * completions ni cuota — eso lo prueba `realOpenAiCompletion` en el cutover.
 */
export async function verifyOpenAiByokKey(apiKey: string): Promise<CredentialCheck> {
  let res: Response;
  try {
    res = await fetch(`${OPENAI_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Una caída de red NO es una credencial mala — mismo criterio que los
    // verificadores de Resend y Meta.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error_code: 'network_error', error_message: message, http_status: 0 };
  }

  if (res.ok) {
    return { ok: true, detail: 'la key autenticó contra api.openai.com' };
  }

  let errorCode = `http_${res.status}`;
  let errorMessage = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } } | null;
    if (body?.error?.code) errorCode = body.error.code;
    if (body?.error?.message) errorMessage = body.error.message;
  } catch {
    // Sin cuerpo JSON: queda el status pelado, que ya nombra el problema.
  }
  return { ok: false, error_code: errorCode, error_message: errorMessage, http_status: res.status };
}

export type GatewaySmokeResult =
  | {
      ok: true;
      response_id: string;
      model: string;
      /** `llm_provider-openai-organization`: la organización que FACTURÓ upstream. */
      organization: string | null;
      /** `x-litellm-model-api-base`: a qué upstream salió el request. */
      api_base: string | null;
    }
  | { ok: false; error_code: string; error_message: string; http_status: number };

/**
 * La «Evidencia B» del cutover BYOK (byok §7.12, G2): una completion A TRAVÉS
 * del gateway LiteLLM, leyendo los headers upstream que el proxy reenvía
 * (`llm_provider-*`, medido en el lab, G0.a). El flip a `owned` sólo se marca
 * si la organización que factura ES la del cliente.
 *
 * Sale por la MISMA puerta que el personalize (base URL + virtual key del
 * cascade F1): el dispatcher ya es consumidor del gateway, así que la prueba no
 * custodia nada nuevo. Sin gateway cableado no hay Evidencia B posible — y el
 * caller lo reporta como su causa, no como una key mala.
 *
 * El modelo es el mismo alias que la prueba directa (`OPENAI_CUTOVER_TEST_MODEL
 * || gpt-4o-mini`): existe como alias passthrough en el gateway Y como modelo
 * real en api.openai.com, así ambas evidencias miden lo mismo. Si el alias
 * rutea a otro proveedor (hallazgo G0: `gpt-chico` del lab va a DeepSeek), el
 * `api_base` lo delata y el caller corta con la causa.
 */
export async function gatewayOpenAiCompletion(): Promise<GatewaySmokeResult> {
  // `''` cuenta como ausente (lista curada del compose, incidente 2026-08-10).
  const base = env.OPENAI_BASE_URL__CAMPAIGNS__DISPATCHER__PERSONALIZE_OPENAI || '';
  const key = env.OPENAI_API_KEY__CAMPAIGNS__DISPATCHER__PERSONALIZE_OPENAI || '';
  if (!base || !key) {
    return {
      ok: false,
      error_code: 'no_gateway',
      error_message:
        'el dispatcher no tiene el gateway cableado (OPENAI_BASE_URL/API_KEY del personalize): ' +
        'sin gateway no hay Evidencia B que correr',
      http_status: 0,
    };
  }

  const model = testModel();
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping de verificación de titularidad (Evidencia B)' }],
        max_completion_tokens: 1,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error_code: 'network_error', error_message: message, http_status: 0 };
  }

  if (!res.ok) {
    let errorCode = `http_${res.status}`;
    let errorMessage = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } } | null;
      if (body?.error?.code) errorCode = body.error.code;
      if (body?.error?.message) errorMessage = body.error.message;
    } catch {
      // Sin cuerpo JSON: queda el status pelado.
    }
    return { ok: false, error_code: errorCode, error_message: errorMessage, http_status: res.status };
  }

  let responseId = '';
  try {
    const body = (await res.json()) as { id?: string } | null;
    responseId = body?.id ?? '';
  } catch {
    // 200 sin JSON: la evidencia queda con id vacío y el caller decide.
  }

  return {
    ok: true,
    response_id: responseId,
    model,
    organization: res.headers.get('llm_provider-openai-organization'),
    api_base: res.headers.get('x-litellm-model-api-base'),
  };
}
