/**
 * `notify()` — la MECÁNICA de un aviso, escrita UNA vez (F7.5, ADR
 * `apps/features/messaging/doc/analysis-messaging-service.md` §ADR `POST /notify`).
 *
 * R1c/T4.5 dejó la **resolución** escrita una vez (`bot.notify_to()` en SQL,
 * `resolveNotifyTarget()` de este lado). Lo que seguía copiado en cada emisor
 * era todo lo demás: armar destinatarios, elegir remitente, fan-out un envío
 * por destinatario, componer el `client_ref`, leer el resultado y decidir si un
 * `duplicate` cuenta como éxito. Cada copia se equivocó en algo distinto —
 * remitente hardcodeado (`onboarding@resend.dev`), remitente de marketing en un
 * aviso de ops (`CAMPAIGNS_DEFAULT_FROM_EMAIL`), ref con destinatario pegado
 * que colisiona en idempotencia.
 *
 * El emisor manda **qué pasó**; este módulo resuelve **todo lo demás**. Lo que
 * deja de ser posible está en la tabla del ADR; lo que importa acá es que
 * ninguna de esas cinco decisiones vuelve a escribirse en un llamador.
 *
 * ⚠ **El fan-out sale por `sendMessage`**, no por `sendEmail` directo. Los dos
 * emisores de `campaigns` mandaban por el provider crudo, así que no pasaban
 * por la idempotencia `(client_ref, destino)`, ni por la guarda de destino, ni
 * se contaban en el presupuesto: eran gasto invisible. El sender se INYECTA
 * (`deps.send`) por dos motivos, no por gusto: `workers/dlq.ts` y
 * `core/management.ts` no tienen `redis` ni la allowlist para armar `SendDeps`,
 * y `core/budget.ts` no puede importar `messaging.ts` sin cerrar el ciclo
 * `budget → notify → messaging → budget`.
 */
import type { SqlClient } from '../lib/postgres.js';
import type { Logger } from '../lib/logger.js';
import type { OutboundMessage } from './schemas.js';
import type { SendOutcome } from './messaging.js';
import { resolveNotifyTarget, notifyBlockedReason } from './notify-to.js';
import { isMissingRelation, announceOnce } from '../lib/pg-errors.js';

/** Un envío suelto, tal como lo ejecuta `core/messaging.ts sendMessage()`. */
export type NotifySender = (msg: OutboundMessage) => Promise<SendOutcome>;

export interface NotifyDeps {
  sql: SqlClient;
  logger: Logger;
  send: NotifySender;
}

/**
 * Lo ÚNICO que aporta el emisor: qué pasó. Ni destinatarios, ni remitente, ni
 * `client_ref` por destinatario — esos tres son exactamente los campos donde
 * cada copia de la mecánica se equivocó de una forma distinta.
 */
export interface NotifyRequest {
  /** Feature dueña del aviso — la que declara `notify_to:` en su manifest. */
  feature: string;
  /** `id` del aviso dentro de esa declaración. No declarado → 422, no se manda. */
  aviso: string;
  subject: string;
  text?: string;
  html?: string;
  /**
   * Pasa tal cual a `sendMessage`. Sólo tiene efecto combinado con
   * `kind: 'notification'` (que este módulo pone siempre) y su único efecto es
   * el bypass de presupuesto: un aviso de que algo se rompió no debería quedar
   * mudo porque el tope de mensajería se llenó.
   */
  critical?: boolean;
  /**
   * Ref del EVENTO, sin destinatario. Entra al `client_ref` final para que dos
   * ocurrencias distintas del mismo aviso no se dedupliquen entre sí. El
   * destinatario NO va acá: la idempotencia es `(client_ref, destino)` desde
   * 2026-08-19 y pegarlo al ref lo único que hace es romper el dedup real.
   */
  origin_ref?: string;
}

/** Un destinatario que NO recibió el aviso, con la causa del proveedor o de la guarda. */
export interface NotifyFailure {
  to: string;
  error_code: string;
  error_message: string;
}

export type NotifyOutcome =
  | {
      status: 'ok';
      /** Salió de verdad en este llamado. */
      sent: string[];
      /** Ya había salido para ese destinatario (cuenta como éxito — T10.6). */
      duplicate: string[];
      /** El resto de los destinatarios SÍ se intentó. */
      failed: NotifyFailure[];
      /** No había con qué mandar (sin destinatarios o sin remitente). */
      blocked_reason: string | null;
    }
  | { status: 'undeclared'; detail: string };

/**
 * ¿La feature declaró este aviso en su manifest?
 *
 * La declaración vive en `config.features.bom->'notify_to'` — el modelo de
 * features ya la carga desde el manifest en los 3 clientes, así que este gate
 * no necesita leer YAML en runtime. **Es un gate, no documentación**: un aviso
 * que ninguna feature declaró no aparece en «Seguridad → Avisos», o sea que el
 * operador no tiene dónde elegir quién lo recibe. Mandarlo igual es prometer
 * una configuración que no existe.
 *
 * ⚠ El fallback cuando la TABLA no existe es fail-OPEN, y la asimetría es
 * deliberada: `config.features` la crea el modelo de features, que no todos los
 * clientes tienen todavía. Un aviso no declarado es un error del llamador y se
 * rechaza; una base sin el modelo de features es un cliente sin esa capa, y
 * apagarle TODOS los avisos por eso convierte un hueco de datos en un incidente
 * mudo — el mismo modo de falla que T5.6 desarmó en `resolveNotifyTarget`.
 */
async function isAvisoDeclared(
  sql: SqlClient,
  logger: Logger,
  feature: string,
  aviso: string,
): Promise<boolean> {
  try {
    const rows = await sql<Array<{ declared: boolean }>>`
      SELECT EXISTS (
        SELECT 1
          FROM config.features f
          CROSS JOIN LATERAL jsonb_array_elements(
            COALESCE(f.bom->'notify_to', '[]'::jsonb)
          ) AS a
         WHERE f.id = ${feature}
           AND a->>'id' = ${aviso}
      ) AS declared
    `;
    return rows[0]?.declared === true;
  } catch (err) {
    if (isMissingRelation(err)) {
      announceOnce(
        logger,
        'notify:config.features',
        { feature, aviso },
        'config.features no existe en esta base (cliente sin el modelo de features) — el gate de declaración de avisos queda abierto',
      );
      return true;
    }
    logger.warn(
      { err: (err as Error).message, feature, aviso },
      'notify: no se pudo leer la declaración del aviso — se deja pasar (la resolución de destinatarios sigue siendo el gate real)',
    );
    return true;
  }
}

/**
 * El `client_ref` lo compone el SERVICIO, nunca el emisor.
 *
 * Sin destinatario adentro, a propósito: la clave de idempotencia es
 * `(client_ref, destino)`, así que agregarlo acá no protege de nada y sí rompe
 * el caso que importa —un reintento del mismo evento re-mandándole el mail a
 * todo el mundo—. El `origin_ref` es lo que separa dos ocurrencias distintas
 * del mismo aviso (dos meses, dos campañas); sin él, el segundo evento del
 * mismo aviso se deduplica contra el primero durante la ventana.
 */
function composeClientRef(req: NotifyRequest): string {
  const base = `notify-${req.feature}-${req.aviso}`;
  return req.origin_ref ? `${base}-${req.origin_ref}` : base;
}

/**
 * Manda un aviso declarado. NUNCA tira: los avisos cuelgan de un hecho que ya
 * ocurrió (un auto-pause, un tope cruzado) y que falle el mail no puede
 * deshacerlo ni volver al camino que lo disparó.
 */
export async function notify(deps: NotifyDeps, req: NotifyRequest): Promise<NotifyOutcome> {
  const { sql, logger } = deps;

  if (!(await isAvisoDeclared(sql, logger, req.feature, req.aviso))) {
    const detail = `aviso '${req.aviso}' no declarado por la feature '${req.feature}'`;
    logger.warn({ feature: req.feature, aviso: req.aviso }, `notify: ${detail} — no se envía`);
    return { status: 'undeclared', detail };
  }

  const target = await resolveNotifyTarget(sql, logger, req.feature);
  const blocked = notifyBlockedReason(target);
  if (blocked) {
    logger.warn(
      { feature: req.feature, aviso: req.aviso, reason: blocked },
      'notify: el aviso no se envía',
    );
    return { status: 'ok', sent: [], duplicate: [], failed: [], blocked_reason: blocked };
  }

  // El nombre visible sale del branding del CLIENTE. Un literal acá —y hubo
  // uno, «Alertas PalmaDev»— es el nombre del laboratorio firmando los avisos
  // de ops de todos los forks.
  const from = target.fromName ? `${target.fromName} <${target.from}>` : target.from;
  const clientRef = composeClientRef(req);

  const sent: string[] = [];
  const duplicate: string[] = [];
  const failed: NotifyFailure[] = [];

  // Un envío POR DESTINATARIO, acumulando en vez de cortar en el primero: que a
  // uno le rebote no es razón para que los otros no se enteren.
  for (const to of target.to) {
    try {
      const outcome = await deps.send({
        channel: 'email',
        to,
        from,
        content: { type: 'mail', subject: req.subject, text: req.text, html: req.html },
        context: {
          feature: req.feature,
          client_ref: clientRef,
          kind: 'notification',
          critical: req.critical === true,
        },
      });
      switch (outcome.status) {
        case 'sent':
          sent.push(to);
          break;
        // T10.6: «ya salió» ES éxito. La semántica se decide UNA vez, acá, en
        // vez de que cada llamador vuelva a interpretar el mismo status.
        case 'duplicate':
          duplicate.push(to);
          break;
        case 'rejected':
          failed.push({ to, error_code: outcome.reason, error_message: outcome.detail });
          break;
        case 'failed':
          failed.push({
            to,
            error_code: outcome.error_code,
            error_message: outcome.error_message,
          });
          break;
      }
    } catch (err) {
      failed.push({
        to,
        error_code: 'notify_send_threw',
        error_message: (err as Error).message,
      });
    }
  }

  if (failed.length > 0) {
    logger.error(
      { feature: req.feature, aviso: req.aviso, failed, sent_count: sent.length },
      'notify: uno o más destinatarios no recibieron el aviso',
    );
  }

  return { status: 'ok', sent, duplicate, failed, blocked_reason: null };
}
