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
import { providerForChannel, recordProviderOutcome } from './provider-status.js';
import { toE164, normalizeAllowlist } from '../lib/phone.js';
import { isMissingRelation, announceOnce } from '../lib/pg-errors.js';
import { getProviderForChannel } from '../ports/channel-provider.js';
import type { OutboundMessage } from './schemas.js';
import type { WhatsAppSendInput } from '../providers/whatsapp.js';
import type { EmailSendInput } from '../providers/email.js';
import type { ProviderSendResult } from '../providers/types.js';

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface SendDeps {
  sql: SqlClient;
  redis: Redis;
  logger: Logger;
  /** Histograma de latencia del servicio. Opcional: el MCP no lo inyecta. */
  metrics?: { recordSend(latencyMs: number): void };
  /** `env.STAFF_NOTIFY_ALLOWLIST` parseado (CSV → array trimmeado). */
  staffAllowlist: string[];
  /**
   * Resolver inyectado (§3.4: el core no toca DB) — DB
   * `bot.config['channel_whatsapp'].default_phone_number_id` → env
   * `META_WA_DEFAULT_PHONE_NUMBER_ID`, mismo patrón `deps.resolveKey ??
   * resolveProviderKey` de `provider-domains.ts`. `null` → whatsapp falla con
   * la causa nombrando LAS DOS fuentes.
   */
  resolveDefaultPhoneNumberId: () => Promise<string | null>;
  /** `env.CAMPAIGNS_DEFAULT_FROM_EMAIL` — reusado, sin env nueva para /send. */
  /** Fallback de transición (T5.6). La fuente real es bot.config[branding].email_from. */
  defaultFromEmail: string | undefined;
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

/**
 * Registra el resultado del proveedor si ese canal tiene uno con card de
 * servicio. Se llama SÓLO en los tres puntos donde ya se sabe cómo respondió el
 * proveedor de verdad — nunca desde las guardas, que rechazan antes de llegar.
 */
async function recordOutcomeIfProvider(
  deps: SendDeps,
  channel: string,
  outcome: Parameters<typeof recordProviderOutcome>[3],
): Promise<void> {
  const providerId = providerForChannel(channel);
  if (!providerId) return;
  await recordProviderOutcome(deps.sql, deps.logger, providerId, outcome);
}

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
  // T9.2 — categoría propia para lo transaccional. Un comprobante fiscal no
  // es `service` ni `marketing`: es una obligación con el cliente final, y
  // mezclarlo con el resto haría que compita por el mismo tope de US$5/mes que
  // fijó la mig 137 para mensajería.
  //
  // Se decide por `context.kind`, que ya existía en el schema y estaba sin
  // usar del lado del budget: es una declaración de la app que llama, no algo
  // que este servicio pueda deducir del contenido.
  if (msg.context.kind === 'transactional') return 'transactional';

  // T9.8 — categoría propia para auth, por el mismo criterio que la anterior y
  // con un motivo distinto. `transactional` existe porque un comprobante es una
  // obligación con el cliente final; `auth` existe porque un tope de mensajería
  // no puede ser lo que decide si alguien PUEDE ENTRAR a la plataforma. Meterla
  // dentro de `transactional` ahorraría cinco líneas y perdería justo el dato
  // que hace falta cuando se investiga por qué nadie pudo loguearse.
  if (msg.context.kind === 'auth') return 'auth';

  // Sólo un `template` tiene categoría que mirar. `text` y —desde T9.1—
  // `mail` son conversacionales: no hay fila en `message_templates` que
  // consultar. Se chequea la variante que SÍ la tiene, en vez de asumir que
  // "lo que no es text es template" — que es lo que se rompió al sumar la
  // tercera.
  if (msg.content.type !== 'template') return 'service';
  const template = msg.content;
  try {
    const rows = await sql<Array<{ category: string }>>`
      SELECT category FROM bot.message_templates
      WHERE channel = ${msg.channel} AND name = ${template.name}
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    return rows[0]?.category ?? 'marketing';
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, channel: msg.channel, template_name: template.name },
      'message_templates category lookup failed — defaulting to marketing (conservative)',
    );
    return 'marketing';
  }
}

/**
 * Direcciones de staff del cliente, para la guarda de destino de las
 * notificaciones por **email**.
 *
 * Son DOS fuentes, y las dos son configuración del cliente en la DB (frontera
 * del handbook: "¿habría que rotarlo si se filtra?" → no):
 *
 *   1. `bot.config['branding'].admin_email` — el buzón de administración.
 *   2. `bot.config['notify_to']` — los destinatarios que el operador cargó por
 *      feature desde *Seguridad → Avisos* (R1c / T4.5). **Todas las features
 *      juntas**, no la del mensaje: ver abajo.
 *
 * ⚠ **Sin la fuente 2, T4.5 quedaba rota y de la peor forma.** Cuatro de los
 * cinco emisores migrados mandan con `kind: 'notification'`, así que esta
 * guarda los alcanza: con la allowlist en una sola dirección, cargar un segundo
 * destinatario lo dejaba en `403 destination_not_allowed`. La configuración
 * habría aceptado la dirección y el mail no habría llegado nunca — exactamente
 * el modo de falla que el plan de email viene desarmando. El comentario que
 * había acá lo anticipaba (*"si mañana hacen falta varias, la lista va en una
 * key propia de bot.config con ésta como default"*); esto es ese día.
 *
 * **Por qué TODAS las features y no la del mensaje.** La pregunta que contesta
 * la guarda es *"¿esta dirección es de adentro?"*, y una dirección que el
 * operador cargó para recibir avisos automáticos es del staff del cliente sin
 * importar qué feature dispare. Scopear por feature agregaría precisión contra
 * una amenaza marginal (un aviso del gateway llegando al buzón que se cargó
 * para facturación — las dos del mismo cliente) al precio de acoplar la guarda
 * a que el `context.feature` esté bien puesto, y de un modo de falla confuso:
 * la misma dirección aceptada para un emisor y 403 para otro.
 *
 * **Fail-closed**: sin dato, o con la query rota, devuelve vacío y la
 * notificación se rechaza. Es una guarda de destino; fallar abierta la anula.
 */
export async function resolveStaffEmails(sql: SqlClient, logger: Logger): Promise<Set<string>> {
  try {
    // Una sola vuelta a la base: la guarda corre en el camino de envío.
    const rows = await sql<Array<{ admin_email: string | null; notify_to: string[] | null }>>`
      SELECT (SELECT value->>'admin_email' FROM bot.config WHERE key = 'branding') AS admin_email,
             COALESCE(
               (SELECT array_agg(DISTINCT btrim(addr))
                  FROM bot.config c,
                       LATERAL jsonb_each(c.value) AS f(feature, list),
                       LATERAL jsonb_array_elements_text(f.list) AS addr
                 WHERE c.key = 'notify_to'
                   AND jsonb_typeof(f.list) = 'array'
                   AND btrim(addr) <> ''),
               '{}'::text[]
             ) AS notify_to
    `;
    const out = new Set<string>();
    const add = (v: unknown) => {
      if (typeof v === 'string' && v.trim()) out.add(v.trim().toLowerCase());
    };
    add(rows[0]?.admin_email);
    for (const addr of rows[0]?.notify_to ?? []) add(addr);
    return out;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'staff email allowlist lookup failed — rejecting the notification (fail-closed)',
    );
    return new Set();
  }
}

/**
 * ¿El destino de una notificación es un destino de **staff**?
 *
 * La pregunta es la misma para los dos canales —«¿esto va para adentro?»— pero
 * **el identificador no**: un teléfono se compara en E.164 y una dirección de
 * mail se compara como dirección.
 *
 * ⚠ Hasta acá esto era una sola rama de teléfonos que corría para **todo**
 * canal, así que una notificación por mail daba `403` **siempre**: `toE164()`
 * sobre una dirección devuelve `null`, y `null` no está en ninguna lista. No es
 * que la lista estuviera vacía — es que el canal email no tenía lista. Se
 * descubrió al migrar los emisores del cockpit (T9.4) y frenaba T9.5, porque
 * los avisos a staff de los seis workflows caen justo acá.
 *
 * La rama de teléfono queda igual, incluido el porqué de normalizar de los DOS
 * lados: la allowlist se carga a mano en un `.env` y el destino viene de
 * `bot.agents.phone_e164`, así que comparar literal hace que `549…` y `+549…`
 * —el mismo número— no coincidan. Eso rechazó cada notificación de ai-recovery
 * el 2026-08-03. Se normaliza acá y no sólo en el wiring para que la guarda sea
 * correcta venga de donde venga el `deps` (el MCP arma el suyo).
 */
async function isStaffDestination(deps: SendDeps, msg: OutboundMessage): Promise<boolean> {
  if (msg.channel === 'email') {
    const staff = await resolveStaffEmails(deps.sql, deps.logger);
    return staff.has(msg.to.trim().toLowerCase());
  }
  const toCanonical = toE164(msg.to);
  if (!toCanonical) return false;
  return new Set(normalizeAllowlist(deps.staffAllowlist).allowed).has(toCanonical);
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
 * Fuente: `bot.audience_contact_channels.last_inbound_at` (mig 140), que
 * escribe **sólo** el feeder del webhook de Meta — el único punto que ve el
 * 100% de los entrantes, sin el gate de `ai-stop` que sí afecta a `bot.leads` —
 * vía `bot.buc_touch_last_inbound` (la BUC se escribe únicamente por sus
 * funciones `buc_*`, regla R7).
 *
 * **NO se usa `last_seen_at`**, que es la trampa obvia: esa columna nace
 * `NOT NULL DEFAULT now()` y `buc_upsert_contact` la pisa en cada upsert, así
 * que significa "última vez que tocamos el registro", no "el contacto nos
 * escribió". Siempre tiene valor y casi siempre es viejo: leerla como
 * evidencia haría que el servicio rechazara texto libre a todos los contactos.
 * Un dato que siempre existe pero no significa lo que se le pide es peor que
 * no tener dato.
 *
 * **Sólo rechaza con evidencia positiva.** Sin dato (`last_inbound_at` NULL,
 * contacto sin fila, o la query falla) hace fail-open y deja que Meta decida,
 * que es el comportamiento previo a F5: un NULL no distingue "nunca escribió"
 * de "el feeder todavía no vio a este contacto", y bloquear envíos legítimos
 * por un dato que recién se está poblando es peor que pagar un 4xx de Meta.
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
    const rows = await sql<Array<{ last_inbound_at: Date | null }>>`
      SELECT ch.last_inbound_at
      FROM bot.audience_contact_channels ch
      JOIN bot.audience_contacts c ON c.id = ch.audience_contact_id
      WHERE ch.channel = ${channel}
        AND (CASE WHEN c.phone LIKE '+549%' THEN '+54' || substring(c.phone FROM 5) ELSE c.phone END)
          = (CASE WHEN ${to} LIKE '+549%' THEN '+54' || substring(${to} FROM 5) ELSE ${to} END)
      ORDER BY ch.last_inbound_at DESC NULLS LAST
      LIMIT 1
    `;
    const last = rows[0]?.last_inbound_at;
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
    if (isMissingRelation(err)) {
      // Mismo caso que el opt-out: sin BUC no hay `last_inbound_at` que mirar,
      // y quien decide si el mensaje entra en la ventana pasa a ser Meta — que
      // es el fallback de siempre cuando el dato falta.
      announceOnce(
        logger,
        'missing:audience_contact_channels:24h',
        { channel },
        'sin bot.audience_contact_channels (cliente sin la feature campaigns): la ventana de 24 h la decide Meta. Estado esperado, se dice una vez.',
      );
    } else {
      logger.warn(
        { err: (err as Error).message, channel },
        '24h window lookup failed — fail-open, Meta decides',
      );
    }
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
  if (msg.channel === 'email' && msg.content.type !== 'mail') {
    return {
      status: 'rejected',
      reason: 'unsupported_content_type',
      detail: 'email requiere content.type=mail (subject + html/text, adjuntos opcionales)',
    };
  }
  // El simétrico, que faltaba: `mail` es contenido de correo y no existe en
  // whatsapp. Sin esta guarda un `whatsapp` + `mail` pasaba de largo hasta el
  // armado del payload — o sea, un 500 por un body que el servicio puede
  // rechazar con un 400 y un motivo.
  if (msg.channel === 'whatsapp' && msg.content.type === 'mail') {
    return {
      status: 'rejected',
      reason: 'unsupported_content_type',
      detail: 'whatsapp no soporta content.type=mail (usá text o template)',
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
  if (kind === 'notification' && !(await isStaffDestination(deps, msg))) {
    deps.logger.warn(
      { feature, channel: msg.channel, to: maskDestination(msg.to) },
      'sendMessage: notification destination is not a staff destination',
    );
    return {
      status: 'rejected',
      reason: 'destination_not_allowed',
      detail:
        msg.channel === 'email'
          ? "destination is not a staff address (bot.config['notify_to'] o ['branding'].admin_email)"
          : 'destination is not in the staff allowlist',
    };
  }

  // ── 4. Opt-out ────────────────────────────────────────────────────────────
  //
  // T9.3 — **el criterio es el TIPO de mensaje, no el canal.**
  //
  // Antes la condición era `channel === 'whatsapp' && kind !== 'notification'`,
  // así que todo el email quedaba exento **por omisión**: no porque se hubiera
  // decidido, sino porque la guarda nunca lo miraba. Con F6 metiendo *todo* el
  // correo por acá, esa exención accidental pasaría a cubrir también las
  // campañas por email — que son exactamente lo que el opt-out existe para
  // frenar. La baja de la BUC es sobre **marketing**.
  //
  // Las TRES exenciones quedan EXPLÍCITAS y cada una por motivo propio:
  //   `notification`  → destinos internos de staff, que no están en la BUC.
  //   `transactional` → nadie se da de baja de su propia factura (T9.2/T9.3).
  //   `auth`          → nadie se da de baja de poder entrar a la plataforma
  //                     (T9.8). Y la baja de la BUC es sobre marketing: un
  //                     contacto que se dio de baja de las campañas y despues
  //                     es dado de alta como usuario tiene que poder recibir
  //                     su invitacion, o queda sin acceso por una decision que
  //                     tomo sobre otra cosa.
  //
  // Un `kind` ausente NO está exento: el default es chequear. Si mañana entra
  // un emisor que se olvida de declararlo, el error es de más y no de menos.
  const optOutExempt = kind === 'notification' || kind === 'transactional' || kind === 'auth';
  if (!optOutExempt) {
    try {
      // El identificador del contacto depende del canal: teléfono para
      // whatsapp, dirección para email. Es la misma pregunta —«¿este contacto
      // se dio de baja?»— hecha por la columna que corresponde.
      const rows =
        msg.channel === 'email'
          ? await deps.sql<Array<{ unsubscribed_at: Date | null }>>`
              SELECT unsubscribed_at FROM bot.audience_contacts
               WHERE lower(email) = lower(${msg.to}) LIMIT 1
            `
          : await deps.sql<Array<{ unsubscribed_at: Date | null }>>`
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
      if (isMissingRelation(err)) {
        // Cliente sin la feature `campaigns`: no hay BUC, así que no hay dónde
        // registrar una baja — y por lo tanto no hay ninguna que respetar. No
        // se está ignorando el opt-out de nadie: el mecanismo no existe en este
        // cliente. El día que contrate campañas, la tabla aparece y esta guarda
        // empieza a funcionar sola, sin tocar código.
        announceOnce(
          deps.logger,
          'missing:audience_contacts:optout',
          { feature },
          'sin bot.audience_contacts (cliente sin la feature campaigns): no hay BUC, así que no hay baja que chequear. Estado esperado, se dice una vez.',
        );
      } else {
        deps.logger.error(
          { err: (err as Error).message, feature },
          'opt-out check query failed — proceeding (fail-open, logged loudly)',
        );
      }
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

  // T9.2 — lo transaccional SE CUENTA PERO NO SE BLOQUEA.
  //
  // Contar y capar son cosas distintas, y acá se separan a propósito: un
  // comprobante fiscal es una obligación con el cliente final, así que un tope
  // de mensajería no puede ser lo que decida si sale. Pero el gasto se registra
  // igual (`recordSendUsage` corre después del envío, fuera de esta guarda) y
  // **la alerta sigue disparando**, así que si el volumen se dispara se ve —
  // simplemente no se traduce en un mail no enviado.
  //
  // ⚠ Es distinto del bypass `critical`, que es una excepción puntual de
  // `safety-trigger`. Esto es una CATEGORÍA con semántica propia, y por eso no
  // hereda el tope de US$5/mes de la mig 137: hasta que tenga uno pensado, no
  // tener tope es más honesto que heredar uno que se eligió para otra cosa.
  //
  // T9.8 — `auth` va por el mismo camino, con un motivo mas fuerte todavia: si
  // un tope de mensajeria bloquea un reset de contrasena, el resultado no es
  // "se gasto de mas", es que **nadie puede entrar** — y el camino para
  // arreglarlo pasa por entrar. Se cuenta igual, en su propia categoria, asi
  // que un pico de mails de auth (alta masiva, o alguien golpeando el reset) se
  // ve en el gasto y dispara la alerta.
  const countedNotCapped = category === 'transactional' || category === 'auth';

  if (!budgetResult.allowed && !criticalBypass && !countedNotCapped) {
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
    const defaultWaPhoneNumberId = await deps.resolveDefaultPhoneNumberId();
    if (!defaultWaPhoneNumberId) {
      return {
        status: 'failed',
        error_code: 'missing_phone_number_id',
        error_message:
          "falta bot.config['channel_whatsapp'].default_phone_number_id y la env " +
          'META_WA_DEFAULT_PHONE_NUMBER_ID',
      };
    }
    sendInput =
      msg.content.type === 'text'
        ? {
            phone_number_id: defaultWaPhoneNumberId,
            to: msg.to,
            biz_opaque_callback_data: client_ref,
            type: 'text',
            body: msg.content.text,
          }
        : msg.content.type !== 'template'
          ? // `mail` en whatsapp no existe: lo rechaza la guarda 1. El caso está
            // acá para que el compilador no tenga que adivinar, no porque pueda
            // pasar — y si algún día pasa, falla ruidoso en vez de mandar vacío.
            (() => {
              throw new Error(`content.type=${msg.content.type} no es válido para whatsapp`);
            })()
          : {
            phone_number_id: defaultWaPhoneNumberId,
            to: msg.to,
            biz_opaque_callback_data: client_ref,
            type: 'template',
            template_name: msg.content.name,
            template_lang: msg.content.language,
            components: msg.content.components ?? [],
          };
  } else {
    // msg.channel === 'email', msg.content.type === 'mail' (guardado arriba)
    const mail = msg.content.type === 'mail' ? msg.content : null;
    if (!mail) {
      return {
        status: 'failed',
        error_code: 'email_content_invalid',
        error_message: 'contenido de mail ausente tras la validación',
      };
    }
    // ⚠ El remitente lo define LA APLICACIÓN QUE LLAMA, no este servicio (R9).
    // El messaging service ejecuta el envío y aporta la credencial de la
    // cuenta; con qué dirección sale es decisión de negocio de quien llama —
    // `onboarding@` para acceso, `noreply@` para transaccional (T12).
    //
    // `deps.defaultFromEmail` queda como fallback de transición y NO como
    // default de producto: un default fue lo que hizo que el sandbox de Resend
    // y el dominio del laboratorio se colaran como remitente de clientes
    // reales. Cuando todos los emisores declaren `from` (T9.4/T9.5), se saca.
    const from = msg.from ?? deps.defaultFromEmail;
    if (!from) {
      return {
        status: 'failed',
        error_code: 'email_from_missing',
        error_message: 'sin remitente: la aplicación que llama tiene que declararlo',
      };
    }
    sendInput = {
      from,
      to: msg.to,
      subject: mail.subject,
      // Uno de los dos existe (lo garantiza el schema). Si sólo vino texto
      // plano se envuelve para tener cuerpo HTML, pero el texto viaja igual
      // como `text` — no se pierde el original ni se inventa formato.
      html: mail.html ?? `<p>${escapeHtml(mail.text ?? '')}</p>`,
      ...(mail.text ? { text: mail.text } : {}),
      ...(mail.attachments?.length ? { attachments: mail.attachments } : {}),
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
    // Llegó al proveedor y no volvió bien: cuenta como estado del proveedor
    // (T6.5). Una caída de red o un 5xx de Resend es un problema de la cuenta
    // tanto como un 403 — `last_checked_at` dice cuándo, y ahí se ve si es
    // transitorio o no.
    await recordOutcomeIfProvider(deps, msg.channel, {
      ok: false,
      error_code: e.error_code ?? 'send_threw',
      error_message: e.message,
    });
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
    await recordOutcomeIfProvider(deps, msg.channel, {
      ok: false,
      error_code: result.error_code ?? 'unknown',
      error_message: result.error_message ?? 'provider returned a non-ok result',
    });
    return {
      status: 'failed',
      error_code: result.error_code ?? 'unknown',
      error_message: result.error_message ?? 'provider returned a non-ok result',
    };
  }

  await recordOutcomeIfProvider(deps, msg.channel, { ok: true });
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
