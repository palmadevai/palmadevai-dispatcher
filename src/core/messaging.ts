/**
 * `sendMessage` — el caso de uso de envío del Messaging Service (F5/H5.2).
 *
 * Extraído de `transports/http/send-route.ts`, que hasta F4 era el único
 * dueño de esta secuencia. La regla 1 de §3.4 del doc
 * (`apps/features/messaging/doc/analysis-messaging-service.md`) exige que la
 * tool MCP `send_template` y la ruta `POST /send` llamen al **mismo** método
 * del core: un `if` de negocio dentro de un transport son dos servicios
 * divergiendo. Con las Tier 3 tools de F5 aparece el segundo transport, así
 * que la lógica baja acá y ambos quedan como fachadas finas.
 *
 * Dominio puro (§3.4): sin Fastify, sin MCP SDK. El resultado es una unión
 * neutral (`SendOutcome`) y cada adapter la mapea a su vocabulario — HTTP a
 * códigos de estado, MCP a tool results. Nunca al revés.
 *
 * Orden de las guardas (deliberado, el mismo que tenía la ruta HTTP):
 *   1. combo canal × contenido soportado
 *   2. idempotencia por `client_ref`
 *   3. destino staff-only para `kind='notification'`
 *   4. opt-out contra la BUC
 *   5. ventana de 24h (sólo texto libre de WhatsApp)
 *   6. budget por canal × categoría
 *   7. envío por el ChannelProvider
 *
 * La idempotencia va ANTES de las validaciones caras a propósito: un reintento
 * del mismo `client_ref` no debe re-ejecutar queries ni re-alertar.
 */
import type { Redis } from 'ioredis';
import type { SqlClient } from '../lib/postgres.js';
import type { Logger } from '../lib/logger.js';
import { checkBudget, recordSendUsage, maybeAlert } from './budget.js';
import { getProviderForChannel } from '../ports/channel-provider.js';
import type { OutboundMessage } from './schemas.js';
import type { WhatsAppSendInput } from '../providers/whatsapp.js';
import type { EmailSendInput } from '../providers/email.js';
import type { ProviderSendResult } from '../providers/types.js';

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const EMAIL_SUBJECT_MAX_CHARS = 60;

export interface SendDeps {
  sql: SqlClient;
  redis: Redis;
  logger: Logger;
  /** Histograma de latencia del servicio. Opcional: el MCP no lo inyecta. */
  metrics?: { recordSend(latencyMs: number): void };
  /** `env.STAFF_NOTIFY_ALLOWLIST` parseado (CSV → array trimmeado). */
  staffAllowlist: string[];
  /** `env.META_WA_DEFAULT_PHONE_NUMBER_ID`. Undefined → whatsapp falla. */
  defaultWaPhoneNumberId: string | undefined;
  /** `env.CAMPAIGNS_DEFAULT_FROM_EMAIL` — reusado, sin env nueva para /send. */
  defaultFromEmail: string;
}

/** Motivos de rechazo por guarda — el mensaje NO salió y no es culpa del provider. */
export type SendRejection =
  | 'unsupported_content_type'
  | 'destination_not_allowed'
  | 'opted_out'
  | 'outside_24h_window'
  | 'budget_exceeded';

export type SendOutcome =
  | { status: 'sent'; message_id: string | undefined }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: SendRejection; detail: string }
  | { status: 'failed'; error_code: string; error_message: string };

export function maskDestination(to: string): string {
  return `***${to.slice(-4)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Categoría de budget del mensaje. Texto libre = `service`; template = la
 * categoría con la que Meta lo aprobó.
 *
 * Sin fila en `bot.message_templates` (o si la query falla) se asume
 * `marketing`: es la categoría más cara, así que el error es sobre-contar el
 * gasto, nunca sub-contarlo. Un tope que se dispara de más se sube con un
 * UPDATE; uno que no se dispara se paga.
 */
export async function resolveCategory(
  sql: SqlClient,
  logger: Logger,
  msg: OutboundMessage,
): Promise<string> {
  if (msg.content.type === 'text') return 'service';
  try {
    const rows = await sql<Array<{ category: string }>>`
      SELECT category FROM bot.message_templates
      WHERE channel = ${msg.channel} AND name = ${msg.content.name}
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    return rows[0]?.category ?? 'marketing';
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, channel: msg.channel, template_name: msg.content.name },
      'message_templates category lookup failed — defaulting to marketing (conservative)',
    );
    return 'marketing';
  }
}

/**
 * Ventana de servicio de 24h de WhatsApp: sólo se puede mandar texto libre si
 * el contacto escribió en las últimas 24 horas. Fuera de la ventana hay que
 * usar un template.
 *
 * El doc (§4 Tier 3) pide que **el servicio verifique y rechace**, en vez de
 * dejar que Meta falle: un 4xx de Meta cuesta una llamada, ensucia las
 * métricas y le devuelve al agente un error de vendor en vez de uno accionable.
 *
 * Fuente: `bot.audience_contact_channels.last_seen_at`. La columna existe
 * desde la mig 039 pero nació sin alimentar; F5 la llena desde el webhook de
 * Meta (el único punto que ve el 100% de los entrantes, sin el gate de
 * `ai-stop` que sí afecta a `bot.leads`) vía la función `bot.buc_touch_last_seen`
 * — la BUC sólo se escribe por sus funciones `buc_*` (regla R7).
 *
 * **Sólo rechaza con evidencia positiva.** Si no hay dato (contacto sin fila,
 * `last_seen_at` NULL, o la query falla) hace fail-open y deja que Meta
 * decida, que es el comportamiento previo a F5. La razón: un `last_seen_at`
 * vacío no distingue "este contacto nunca escribió" de "el alimentador todavía
 * no corrió para este contacto", y bloquear envíos legítimos por un dato que
 * todavía se está poblando es peor que pagar un 4xx de Meta.
 *
 * Matching de teléfono: la MISMA canonicalización que usa el escritor
 * (`bot.buc_touch_last_seen`, mig 139, heredada de `buc_upsert_contact`) —
 * el prefijo 9 de los móviles argentinos, `+549XXXX` → `+54XXXX`. Tiene que
 * ser simétrica con la escritura o el lector no encuentra lo que el feeder
 * guardó. Deliberadamente NO se usa "últimos 10 dígitos": es más permisivo y
 * podría matchear un contacto de otro país con la misma terminación, y acá un
 * match equivocado significa rechazar un envío legítimo por la inactividad de
 * otra persona.
 */
export async function isWithin24hWindow(
  sql: SqlClient,
  logger: Logger,
  channel: string,
  to: string,
): Promise<{ within: boolean; known: boolean; lastInboundAt: string | null }> {
  try {
    const rows = await sql<Array<{ last_seen_at: Date | null }>>`
      SELECT ch.last_seen_at
      FROM bot.audience_contact_channels ch
      JOIN bot.audience_contacts c ON c.id = ch.audience_contact_id
      WHERE ch.channel = ${channel}
        AND (CASE WHEN c.phone LIKE '+549%' THEN '+54' || substring(c.phone FROM 5) ELSE c.phone END)
          = (CASE WHEN ${to} LIKE '+549%' THEN '+54' || substring(${to} FROM 5) ELSE ${to} END)
      ORDER BY ch.last_seen_at DESC NULLS LAST
      LIMIT 1
    `;
    const last = rows[0]?.last_seen_at;
    if (!last) {
      // Sin dato ≠ fuera de ventana. Ver el comentario de arriba.
      return { within: true, known: false, lastInboundAt: null };
    }
    const ageMs = Date.now() - new Date(last).getTime();
    return {
      within: ageMs < 24 * 60 * 60 * 1000,
      known: true,
      lastInboundAt: new Date(last).toISOString(),
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, channel },
      '24h window lookup failed — fail-open, Meta decides',
    );
    return { within: true, known: false, lastInboundAt: null };
  }
}

/**
 * Ejecuta el envío con todas las guardas. Es el ÚNICO camino de salida
 * programática de bajo volumen: `POST /send` y las Tier 3 tools del MCP lo
 * llaman igual, así que una guarda agregada acá cubre las dos superficies.
 */
export async function sendMessage(deps: SendDeps, msg: OutboundMessage): Promise<SendOutcome> {
  const { feature, client_ref, kind } = msg.context;

  // ── 1. Combos canal × contenido no soportados (v1) ────────────────────────
  if (msg.channel === 'email' && msg.content.type !== 'text') {
    return {
      status: 'rejected',
      reason: 'unsupported_content_type',
      detail: 'email only supports content.type=text in v1',
    };
  }

  // ── 2. Idempotencia por client_ref ────────────────────────────────────────
  const idemKey = `msgsvc:ref:${client_ref}`;
  let isDuplicate = false;
  try {
    const set = await deps.redis.set(idemKey, '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
    isDuplicate = set !== 'OK';
  } catch (err) {
    // Redis caído: fail-open en idempotencia (mejor un doble envío raro que
    // bloquear todo /send), pero logueado fuerte — esto no es silencioso.
    deps.logger.error(
      { err: (err as Error).message, client_ref },
      'idempotency SET NX failed (Redis unreachable?) — proceeding without dedup guarantee',
    );
  }
  if (isDuplicate) {
    deps.logger.info(
      { feature, kind, channel: msg.channel, client_ref },
      'sendMessage: duplicate client_ref — no-op',
    );
    return { status: 'duplicate' };
  }

  // ── 3. Destino staff-only para notificaciones ─────────────────────────────
  if (kind === 'notification' && !deps.staffAllowlist.includes(msg.to)) {
    deps.logger.warn(
      { feature, channel: msg.channel, to: maskDestination(msg.to) },
      'sendMessage: notification destination not in STAFF_NOTIFY_ALLOWLIST',
    );
    return {
      status: 'rejected',
      reason: 'destination_not_allowed',
      detail: 'destination is not in the staff allowlist',
    };
  }

  // ── 4. Opt-out (whatsapp; las notificaciones van a destinos internos) ─────
  if (msg.channel === 'whatsapp' && kind !== 'notification') {
    try {
      const rows = await deps.sql<Array<{ unsubscribed_at: Date | null }>>`
        SELECT unsubscribed_at FROM bot.audience_contacts WHERE phone = ${msg.to} LIMIT 1
      `;
      if (rows[0]?.unsubscribed_at) {
        return {
          status: 'rejected',
          reason: 'opted_out',
          detail: 'contact opted out of messaging',
        };
      }
      // Contacto ausente en la BUC → sigue (ej. números de staff que nunca se
      // dieron de alta como audience contacts).
    } catch (err) {
      deps.logger.error(
        { err: (err as Error).message, feature },
        'opt-out check query failed — proceeding (fail-open, logged loudly)',
      );
    }
  }

  // ── 5. Ventana de 24h (sólo texto libre de WhatsApp) ──────────────────────
  // Las notificaciones a staff quedan exentas: van a números internos que casi
  // nunca escriben al bot, y bloquearlas rompería las alertas operativas.
  if (msg.channel === 'whatsapp' && msg.content.type === 'text' && kind !== 'notification') {
    const window = await isWithin24hWindow(deps.sql, deps.logger, msg.channel, msg.to);
    if (window.known && !window.within) {
      deps.logger.info(
        { feature, channel: msg.channel, to: maskDestination(msg.to), last_inbound_at: window.lastInboundAt },
        'sendMessage: outside the 24h service window — use a template instead',
      );
      return {
        status: 'rejected',
        reason: 'outside_24h_window',
        // `known === true` garantiza que hay timestamp: la rama sin dato es
        // fail-open y nunca llega acá.
        detail: `last inbound message was ${window.lastInboundAt}; free-form text needs an inbound within the last 24h — send an approved template instead`,
      };
    }
  }

  // ── 6. Budget por canal × categoría ───────────────────────────────────────
  const category = await resolveCategory(deps.sql, deps.logger, msg);
  const budgetResult = await checkBudget(deps.sql, deps.redis, deps.logger, msg.channel, category);
  await maybeAlert(deps.redis, deps.logger, msg.channel, category, budgetResult);

  const criticalBypass = kind === 'notification' && msg.context.critical === true;
  if (!budgetResult.allowed && !criticalBypass) {
    deps.logger.warn(
      { feature, channel: msg.channel, category, ...budgetResult },
      'sendMessage: budget_exceeded',
    );
    return {
      status: 'rejected',
      reason: 'budget_exceeded',
      detail: `monthly budget cap reached for ${msg.channel}/${category}`,
    };
  }

  // ── 7. Envío por el ChannelProvider ───────────────────────────────────────
  let sendInput: WhatsAppSendInput | EmailSendInput;
  if (msg.channel === 'whatsapp') {
    if (!deps.defaultWaPhoneNumberId) {
      return {
        status: 'failed',
        error_code: 'missing_phone_number_id',
        error_message: 'META_WA_DEFAULT_PHONE_NUMBER_ID is not configured',
      };
    }
    sendInput =
      msg.content.type === 'text'
        ? {
            phone_number_id: deps.defaultWaPhoneNumberId,
            to: msg.to,
            biz_opaque_callback_data: client_ref,
            type: 'text',
            body: msg.content.text,
          }
        : {
            phone_number_id: deps.defaultWaPhoneNumberId,
            to: msg.to,
            biz_opaque_callback_data: client_ref,
            type: 'template',
            template_name: msg.content.name,
            template_lang: msg.content.language,
            components: msg.content.components ?? [],
          };
  } else {
    // msg.channel === 'email', msg.content.type === 'text' (guardado arriba)
    const text = msg.content.type === 'text' ? msg.content.text : '';
    sendInput = {
      from: deps.defaultFromEmail,
      to: msg.to,
      subject: text.slice(0, EMAIL_SUBJECT_MAX_CHARS),
      html: `<p>${escapeHtml(text)}</p>`,
      biz_opaque_callback_data: client_ref,
    };
  }

  const provider = getProviderForChannel(msg.channel);
  const startMs = Date.now();
  let result: ProviderSendResult;
  try {
    result = await provider.send(sendInput);
  } catch (err) {
    const e = err as Error & { error_code?: string; http_status?: number };
    deps.logger.error(
      {
        feature,
        kind,
        channel: msg.channel,
        to: maskDestination(msg.to),
        err: e.message,
        http_status: e.http_status,
        error_code: e.error_code,
      },
      'sendMessage: provider.send threw — no retry, caller decides',
    );
    return {
      status: 'failed',
      error_code: e.error_code ?? 'send_threw',
      error_message: e.message,
    };
  }

  if (!result.ok) {
    deps.logger.warn(
      {
        feature,
        kind,
        channel: msg.channel,
        to: maskDestination(msg.to),
        error_code: result.error_code,
        error_message: result.error_message,
      },
      'sendMessage: provider returned non-ok — no retry, caller decides',
    );
    return {
      status: 'failed',
      error_code: result.error_code ?? 'unknown',
      error_message: result.error_message ?? 'provider returned a non-ok result',
    };
  }

  await recordSendUsage(deps.redis, deps.logger, msg.channel, category);
  deps.metrics?.recordSend(Date.now() - startMs);
  deps.logger.info(
    {
      feature,
      kind,
      channel: msg.channel,
      to: maskDestination(msg.to),
      category,
      message_id: result.message_id,
    },
    'sendMessage: sent',
  );
  return { status: 'sent', message_id: result.message_id };
}
