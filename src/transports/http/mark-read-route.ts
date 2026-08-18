/**
 * `POST /mark-read` — el tilde azul de un mensaje entrante de WhatsApp.
 *
 * POR QUÉ EXISTE (R8, «cero Graph fuera del dispatcher»)
 *
 * Hasta 2026-08-17 el nodo `Mark as Read WA` de `whatsapp-bot-core` le pegaba
 * DIRECTO a `graph.facebook.com`. Para eso n8n necesitaba su propia copia del
 * número del cliente en `META_WA_PHONE_NUMBER_ID`, y ésa era la única razón por
 * la que ese número vivía bajo DOS nombres en la flota: acá
 * `META_WA_DEFAULT_PHONE_NUMBER_ID` —con validación de env, tests y override por
 * mensaje— y en n8n una copia sin nada de eso.
 *
 * En palmawebs esa copia estaba **vacía**: el nodo armaba
 * `graph.facebook.com/v24.0//messages` y, con `neverError: true`, fallaba en
 * silencio. Ningún WhatsApp se marcaba como leído y no había un error en ningún
 * log. Lo encontró `audit-fork-readiness.py` R2 (2026-08-16).
 *
 * Fachada fina, igual que `/send` (§3.4 regla 1): auth, valida el body, llama al
 * provider y traduce el resultado a HTTP. Cero `if` de negocio.
 */
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../lib/logger.js';
import { MarkReadSchema } from '../../core/schemas.js';
import { markReadWhatsApp } from '../../providers/whatsapp.js';

export interface MarkReadRouteDeps {
  logger: Logger;
  /** `env.DISPATCHER_SEND_BEARER` — el mismo de `/send`, sin env nueva. */
  sendBearer: string | undefined;
  /**
   * DB `bot.config['channel_whatsapp'].default_phone_number_id` → env
   * `META_WA_DEFAULT_PHONE_NUMBER_ID` (mismo resolver que `/send`). `null` →
   * 502 con las DOS fuentes nombradas.
   */
  resolveDefaultPhoneNumberId: () => Promise<string | null>;
}

export function registerMarkReadRoute(app: FastifyInstance, deps: MarkReadRouteDeps): void {
  app.post('/mark-read', async (request, reply) => {
    // ── Auth (idéntica a /send, mismo bearer) ───────────────────────────────
    if (!deps.sendBearer) {
      return reply.code(503).send({ error: 'send_disabled' });
    }
    if (request.headers['authorization'] !== `Bearer ${deps.sendBearer}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = MarkReadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    // El número por el que entró el mensaje. Explícito gana (multi-WABA); si no,
    // el default del cliente. Su ausencia es 502 CON LA CAUSA NOMBRADA y no un
    // 500 mudo — es el mismo criterio que /send.
    const phoneNumberId = parsed.data.phone_number_id ?? (await deps.resolveDefaultPhoneNumberId());
    if (!phoneNumberId) {
      return reply.code(502).send({
        status: 'failed',
        error_code: 'missing_phone_number_id',
        error_message:
          "falta bot.config['channel_whatsapp'].default_phone_number_id y la env " +
          'META_WA_DEFAULT_PHONE_NUMBER_ID',
      });
    }

    const result = await markReadWhatsApp({
      phone_number_id: phoneNumberId,
      message_id: parsed.data.message_id,
    });

    if (result.ok) {
      return reply.code(200).send({ status: 'read' });
    }

    // 502 y no un 200 optimista: el llamador se enteró de que no se marcó. Que
    // el tilde azul sea cosmético justifica NO reintentar (ver la error policy
    // de `markReadWhatsApp`), no justifica mentirle a quien llamó — ése fue
    // exactamente el bug del `neverError: true` que este endpoint reemplaza.
    return reply.code(502).send({
      status: 'failed',
      error_code: result.error_code,
      error_message: result.error_message,
    });
  });
}
