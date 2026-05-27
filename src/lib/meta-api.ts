/**
 * Meta WhatsApp Cloud API wrapper.
 *
 * F1.2.a (skeleton): STUB — no hace llamadas reales. Retorna mock success
 * para que el dispatcher worker pueda ser invocado en smoke tests sin
 * tocar la cuota Meta del cliente.
 *
 * F1.2.b (próximo PR): implementación real con undici dispatcher pool +
 * biz_opaque_callback_data (ADR-011 idempotency) + multi-phone picker
 * (ADR-013) + classifyError() (ADR-009 DLQ).
 *
 * Ver spec.md §5.3 (dispatch worker pseudocode) + decisions.md ADR-011.
 */
import { env } from '../env.js';
import type { Logger } from './logger.js';

/**
 * Payload mínimo para el send (lo que el dispatcher pasa).
 * Extender en F1.2.b con: template_name, language, components[].variables,
 * media_id, etc.
 */
export interface SendMessageInput {
  to_phone_e164: string;     // ej "+5491150000000"
  from_phone_number_id: string; // Meta phone_number_id (sticky o default)
  client_ref: string;        // delivery.client_ref, va en biz_opaque_callback_data
  template_name?: string;
  language?: string;
  // body real va acá — placeholder hasta F1.2.b
  payload?: Record<string, unknown>;
}

/**
 * Respuesta del send. F1.2.b real shape:
 * { ok: true, message_id: 'wamid.XXX', accepted_at: ISO }
 * O bien: { ok: false, error_code: number, error_subcode?, error_message }
 */
export interface SendMessageResult {
  ok: boolean;
  message_id?: string;
  error_code?: number;
  error_subcode?: number;
  error_message?: string;
  http_status?: number;
}

export interface MetaApiClient {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  /** Healthcheck stub — F1.2.b chequea Meta connectivity con GET /v17.0/me */
  ping(): Promise<boolean>;
}

export function createMetaApiClient(logger: Logger): MetaApiClient {
  const apiVersion = env.META_GRAPH_API_VERSION;
  const baseUrl = `https://graph.facebook.com/${apiVersion}`;

  // TODO F1.2.b: undici pool con keep-alive, retries por categoría de error,
  // rate-limit aware via Meta retry-after headers.
  void baseUrl;

  return {
    async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
      // STUB: log + retorna mock success. NO toca la API de Meta.
      logger.warn(
        {
          stub: true,
          to: input.to_phone_e164,
          from_phone: input.from_phone_number_id,
          client_ref: input.client_ref,
        },
        'STUB sendMessage — no real Meta API call (F1.2.b will implement)',
      );
      // Mock message_id usa el prefijo "stub_" para que sea trivial filtrarlos
      // de bot.message_events en post-mortems.
      return {
        ok: true,
        message_id: `stub_${input.client_ref}_${Date.now()}`,
        http_status: 200,
      };
    },

    async ping(): Promise<boolean> {
      // STUB: en F1.2.b haremos GET /v17.0/{phone_number_id} con timeout 2s.
      return true;
    },
  };
}

export type MetaApi = ReturnType<typeof createMetaApiClient>;
