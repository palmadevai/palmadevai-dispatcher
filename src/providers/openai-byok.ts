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
