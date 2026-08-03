/**
 * `POST /send` — H2.1 (messaging-service Fase 2). Camino sincrónico de bajo
 * volumen: notificaciones a staff, alertas de features, cualquier consumidor
 * de un mensaje suelto que no quiera pasar por el stream de campañas (doc
 * `apps/features/messaging/doc/analysis-messaging-service.md` §3.1).
 *
 * Desde F5 este archivo es una **fachada fina** (§3.4 regla 1): valida el
 * body, llama a `core/messaging.sendMessage()` y traduce el `SendOutcome`
 * neutral a códigos HTTP. Toda la lógica —idempotencia, allowlist de staff,
 * opt-out, ventana de 24h, budget, envío— vive en el core, que las tools MCP
 * Tier 3 (H5.2) llaman igual. Cero `if` de negocio acá.
 *
 * v1 (H2.1): whatsapp + email; `content.type` text|template (whatsapp) o
 * text-only (email). facebook/instagram entran cuando se defina su payload.
 */
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Logger } from '../../lib/logger.js';
import type { SqlClient } from '../../lib/postgres.js';
import type { MetricsCollector } from '../../observability/metrics-collector.js';
import { OutboundMessageSchema } from '../../core/schemas.js';
import { sendMessage, type SendRejection } from '../../core/messaging.js';

export interface SendRouteDeps {
  sql: SqlClient;
  redis: Redis;
  logger: Logger;
  metricsCollector: MetricsCollector;
  /** `env.DISPATCHER_SEND_BEARER`. Undefined → la ruta siempre 503 (fail-closed). */
  sendBearer: string | undefined;
  /** `env.STAFF_NOTIFY_ALLOWLIST` parseado (CSV → array trimmeado). */
  staffAllowlist: string[];
  /** `env.META_WA_DEFAULT_PHONE_NUMBER_ID`. Undefined → whatsapp da 502. */
  defaultWaPhoneNumberId: string | undefined;
  /** `env.CAMPAIGNS_DEFAULT_FROM_EMAIL` — reusado, sin env nueva para `/send`. */
  defaultFromEmail: string;
}

/**
 * Rechazo del core → código HTTP. Los códigos 400/403/422/429 son contrato ya
 * smokeado en F2, así que el mapeo se mantiene tal cual; `outside_24h_window`
 * es nuevo de F5 y entra como 422, la misma familia que `opted_out` (el
 * pedido es válido pero no se puede procesar en ese estado).
 */
const REJECTION_HTTP_STATUS: Record<SendRejection, number> = {
  unsupported_content_type: 400,
  destination_not_allowed: 403,
  opted_out: 422,
  outside_24h_window: 422,
  budget_exceeded: 429,
};

/**
 * Los rechazos que nacieron en F2 responden `{error}` a secas; los que llevan
 * diagnóstico accionable (budget, ventana) responden con la forma
 * `{status:'failed', error_code, error_message}` con la que ya se smokeó el
 * budget. Cambiar cualquiera de las dos rompería consumidores vivos.
 */
const REJECTIONS_WITH_DIAGNOSTIC: ReadonlySet<SendRejection> = new Set<SendRejection>([
  'budget_exceeded',
  'outside_24h_window',
]);

export function registerSendRoute(app: FastifyInstance, deps: SendRouteDeps): void {
  app.post('/send', async (request, reply) => {
    // ── Auth ────────────────────────────────────────────────────────────────
    if (!deps.sendBearer) {
      return reply.code(503).send({ error: 'send_disabled' });
    }
    if (request.headers['authorization'] !== `Bearer ${deps.sendBearer}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // ── Body (única fuente de verdad del shape: core/schemas.ts) ────────────
    const parsed = OutboundMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    // ── Core ────────────────────────────────────────────────────────────────
    const outcome = await sendMessage(
      {
        sql: deps.sql,
        redis: deps.redis,
        logger: deps.logger,
        metrics: deps.metricsCollector,
        staffAllowlist: deps.staffAllowlist,
        defaultWaPhoneNumberId: deps.defaultWaPhoneNumberId,
        defaultFromEmail: deps.defaultFromEmail,
      },
      parsed.data,
    );

    // ── Outcome neutral → HTTP ──────────────────────────────────────────────
    switch (outcome.status) {
      case 'sent':
        return reply.code(200).send({ status: 'sent', message_id: outcome.message_id });

      case 'duplicate':
        return reply.code(200).send({ status: 'duplicate' });

      case 'rejected': {
        const code = REJECTION_HTTP_STATUS[outcome.reason];
        if (REJECTIONS_WITH_DIAGNOSTIC.has(outcome.reason)) {
          return reply.code(code).send({
            status: 'failed',
            error_code: outcome.reason,
            error_message: outcome.detail,
          });
        }
        if (outcome.reason === 'unsupported_content_type') {
          return reply.code(code).send({ error: outcome.reason, detail: outcome.detail });
        }
        return reply.code(code).send({ error: outcome.reason });
      }

      case 'failed':
        return reply.code(502).send({
          status: 'failed',
          error_code: outcome.error_code,
          error_message: outcome.error_message,
        });
    }
  });
}
