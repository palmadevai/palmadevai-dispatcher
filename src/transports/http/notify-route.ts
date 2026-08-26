/**
 * `POST /notify` — la puerta HTTP de los avisos (F7.5, ADR
 * `apps/features/messaging/doc/analysis-messaging-service.md`).
 *
 * Fachada fina, igual que `/send` (§3.4 regla 1): valida el body, llama a
 * `core/notify.ts notify()` y traduce el outcome a HTTP. Cero `if` de negocio
 * acá — la misma función la llaman los tres emisores propios del dispatcher
 * (tanda 0) SIN pasar por HTTP, que es la prueba de que el contrato alcanza.
 *
 * Auth: el mismo bearer que `/send` (`DISPATCHER_SEND_BEARER`). No hay un
 * secreto nuevo porque no hay un permiso nuevo: quien puede mandar un mensaje
 * puede mandar un aviso, y los avisos tienen MENOS grados de libertad (no
 * eligen destino ni remitente).
 */
import type { FastifyInstance } from 'fastify';
import { NotifyRequestSchema } from '../../core/schemas.js';
import { notify, type NotifyDeps } from '../../core/notify.js';

export interface NotifyRouteDeps extends NotifyDeps {
  /** `env.DISPATCHER_SEND_BEARER`. Undefined → la ruta siempre 503 (fail-closed). */
  sendBearer: string | undefined;
}

export function registerNotifyRoute(app: FastifyInstance, deps: NotifyRouteDeps): void {
  app.post('/notify', async (request, reply) => {
    if (!deps.sendBearer) {
      return reply.code(503).send({ error: 'notify_disabled' });
    }
    if (request.headers['authorization'] !== `Bearer ${deps.sendBearer}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = NotifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    const outcome = await notify(deps, parsed.data);

    // 422 y no 400: el body es válido, lo que no existe es el aviso. Es la
    // misma familia que `opted_out` en `/send` — el pedido está bien formado
    // pero no se puede procesar en ese estado.
    if (outcome.status === 'undeclared') {
      return reply.code(422).send({ error: outcome.detail });
    }

    // 200 incluso con `blocked_reason`: que el cliente no haya cargado
    // destinatarios NO es un error del llamador, es la configuración diciendo
    // «este aviso está apagado». El motivo va en el body para que se pueda ver
    // sin abrir la base — «no se envió» sin causa es lo que obliga a hacerlo.
    return reply.code(200).send({
      sent: outcome.sent,
      duplicate: outcome.duplicate,
      failed: outcome.failed,
      blocked_reason: outcome.blocked_reason,
    });
  });
}
