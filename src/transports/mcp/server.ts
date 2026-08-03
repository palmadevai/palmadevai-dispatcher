/**
 * Messaging MCP — tools Tier 1 (F4/H4.1) + Tier 2/3 (F5/H5.1-H5.2), doc §4.
 *
 * Transport rule (§3.4): las tools son fachada 1:1 sobre el core
 * (`core/messaging-reads`, `core/management`, `core/messaging`) — cero lógica
 * de negocio acá. `send_template` y `POST /send` llaman al MISMO
 * `sendMessage()`, así que una guarda nueva cubre las dos superficies.
 *
 * **Registro por scope** (ver `identity.ts`): una conexión read-only no ve las
 * tools de escritura en su `tools/list`. Un `McpServer` NUEVO por conexión SSE
 * (el SDK ata un server a un transport), así que el catálogo se arma con la
 * identidad ya resuelta.
 *
 * Audit (H4.1 → H5.2): toda invocación deja fila en `bot.staff_audit` con la
 * identidad resuelta del bearer (`session_key`/`staff_role`), `channel='mcp'`.
 * Fail-open, mismo criterio que chat-site `lib/agent/audit.ts`: si el INSERT
 * falla se loguea y la tool responde igual — nunca bloquear por el audit.
 *
 * Las cuatro guardas que H5.2 exige como precondición de merge para Tier 3:
 *   1. budget              → dentro de `core/messaging.sendMessage()`
 *   2. opt-out pre-encolado → ídem (contra la BUC, antes de tocar al provider)
 *   3. rate limit por emisor → acá, `enforceSendRateLimit()` (bucket por identidad)
 *   4. audit por identidad   → acá, con la identidad del bearer
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ReadDeps } from '../../core/messaging-reads.js';
import {
  listChannels,
  getChannelHealth,
  listTemplates,
  getTemplate,
  getDeliveryStatus,
  getMessagingCosts,
} from '../../core/messaging-reads.js';
import type { ManagementDeps } from '../../core/management.js';
import { syncTemplates, syncEndpoints, createWaTemplate } from '../../core/management.js';
import type { SendDeps, SendOutcome } from '../../core/messaging.js';
import { sendMessage } from '../../core/messaging.js';
import { tryAcquireToken } from '../../lib/rate-limiter.js';
import type { McpIdentity } from './identity.js';

const SERVER_INFO = { name: 'palmadevai-messaging-mcp', version: '0.2.0' };

/**
 * Rate limit por emisor de las tools de envío (guarda 3 de H5.2).
 *
 * Deliberadamente bajo: el caso de uso legítimo es "el staff agent manda UN
 * mensaje puntual", no un bulk — el masivo tiene su objeto (campaña: audiencia,
 * opt-out, pacing) y su UI, y el doc §4 lo excluye explícitamente del catálogo
 * de tools. Un burst de 5 cubre al operador que corrige y reintenta; el refill
 * de 1/min corta en seco a un agente en loop.
 */
const SEND_RATE_MAX_BURST = 5;
const SEND_RATE_REFILL_PER_SEC = 1 / 60;

export interface McpToolDeps {
  reads: ReadDeps;
  /** Core de management — habilita Tier 2. Ausente → esas tools no se registran. */
  management?: ManagementDeps;
  /** Core de envío — habilita Tier 3. Ausente → esas tools no se registran. */
  send?: SendDeps;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

async function audit(
  deps: ReadDeps,
  identity: McpIdentity,
  toolName: string,
  toolArgs: unknown,
  latencyMs: number,
  error: string | null,
): Promise<void> {
  try {
    await deps.sql`
      INSERT INTO bot.staff_audit
        (session_key, staff_role, tool_name, tool_args, modality, latency_ms, error, channel)
      VALUES (${identity.id}, ${identity.role}, ${toolName}, ${JSON.stringify(toolArgs ?? {})}::jsonb,
              'text', ${latencyMs}, ${error}, 'mcp')
    `;
  } catch (err) {
    deps.logger.warn(
      { err: (err as Error).message, tool: toolName },
      'messaging-mcp: staff_audit INSERT failed (fail-open, tool response unaffected)',
    );
  }
}

/**
 * Ejecuta la tool + audita, y traduce la excepción a un tool result accionable
 * (§3.4 regla 3). `fn` devuelve el `ToolResult` ya armado, así que las tools
 * de lectura envuelven su dato con `jsonResult` y las de envío devuelven su
 * propia forma sin quedar serializadas dos veces.
 */
async function run(
  deps: ReadDeps,
  identity: McpIdentity,
  toolName: string,
  toolArgs: unknown,
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const startMs = Date.now();
  try {
    const result = await fn();
    void audit(deps, identity, toolName, toolArgs, Date.now() - startMs, null);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void audit(deps, identity, toolName, toolArgs, Date.now() - startMs, msg);
    deps.logger.error({ err: msg, tool: toolName }, 'messaging-mcp tool failed');
    return errorResult(`La operación falló (${toolName}): ${msg}. Reintentá o revisá el dispatcher.`);
  }
}

/** Azúcar para las tools cuyo `fn` devuelve datos planos a serializar. */
function readTool(fn: () => Promise<unknown>): () => Promise<ToolResult> {
  return async () => jsonResult(await fn());
}

/** Guarda 3 de H5.2 — bucket por identidad, no bloqueante. */
async function enforceSendRateLimit(
  deps: ReadDeps,
  identity: McpIdentity,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { acquired, waitMs } = await tryAcquireToken({
    redis: deps.redis,
    key: `msgsvc:rl:mcp:${identity.id}`,
    maxBurst: SEND_RATE_MAX_BURST,
    refillPerSec: SEND_RATE_REFILL_PER_SEC,
    logger: deps.logger,
  });
  if (acquired) return { ok: true };
  const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
  deps.logger.warn({ identity: identity.id, wait_ms: waitMs }, 'messaging-mcp: send rate limit hit');
  return {
    ok: false,
    message:
      `Límite de envío alcanzado para ${identity.id}: esperá ~${waitSeconds}s antes de mandar otro mensaje. ` +
      'Si hay que llegarle a muchos contactos, eso es una campaña (audiencia, opt-out, pacing), no envíos sueltos.',
  };
}

/**
 * Resultado neutral de `sendMessage()` → tool result. Los rechazos NO son
 * errores de la herramienta: son respuestas legítimas que el agente tiene que
 * poder explicarle al humano, así que van sin `isError` pero con el motivo y
 * el detalle accionable.
 */
function sendOutcomeResult(outcome: SendOutcome): ToolResult {
  switch (outcome.status) {
    case 'sent':
      return jsonResult({ status: 'sent', message_id: outcome.message_id });
    case 'duplicate':
      return jsonResult({
        status: 'duplicate',
        note: 'Ya se había enviado un mensaje con ese client_ref en las últimas 24h — no se reenvió.',
      });
    case 'rejected':
      return jsonResult({ status: 'rejected', reason: outcome.reason, detail: outcome.detail });
    case 'failed':
      return jsonResult({
        status: 'failed',
        error_code: outcome.error_code,
        error_message: outcome.error_message,
      });
  }
}

export function buildMessagingMcpServer(deps: McpToolDeps, identity: McpIdentity): McpServer {
  const server = new McpServer(SERVER_INFO);
  const { reads } = deps;

  // ══ Tier 1 — read-only (sin costo, sin efectos) ═══════════════════════════

  server.tool(
    'list_channels',
    'Canales de mensajería de la plataforma: cuáles tienen provider implementado y el estado de sus endpoints registrados (active/warming/suspended).',
    {},
    async () => run(reads, identity, 'list_channels', {}, readTool(() => listChannels(reads))),
  );

  server.tool(
    'get_channel_health',
    'Salud del canal WhatsApp por número emisor: quality rating de Meta, messaging limit tier, estado de warming y los últimos 7 snapshots de calidad.',
    {},
    async () => run(reads, identity, 'get_channel_health', {}, readTool(() => getChannelHealth(reads))),
  );

  server.tool(
    'list_templates',
    'Templates de mensajería sincronizados desde Meta (bot.message_templates), filtrables por canal, idioma y estado (approved/pending/rejected/disabled).',
    {
      channel: z.string().optional().describe("Filtro por canal, ej. 'whatsapp'"),
      status: z.string().optional().describe("Filtro por estado Meta, ej. 'approved' o 'rejected'"),
      language: z.string().optional().describe("Filtro por idioma tal como lo guarda Meta, ej. 'es_AR'"),
    },
    async (args) => run(reads, identity, 'list_templates', args, readTool(() => listTemplates(reads, args))),
  );

  server.tool(
    'get_template',
    'Detalle de un template por nombre: componentes del body, variables esperadas ({{1}}, {{2}}…), categoría, estado Meta y motivo de rechazo si lo hay.',
    {
      name: z.string().min(1).describe('Nombre exacto del template'),
      language: z.string().optional().describe("Idioma, ej. 'es_AR' (opcional si el nombre es único)"),
      channel: z.string().optional().describe('Canal, default cualquiera'),
    },
    async (args) => run(reads, identity, 'get_template', args, readTool(() => getTemplate(reads, args))),
  );

  server.tool(
    'get_delivery_status',
    'Estado de un envío por client_ref o id de delivery: timeline (queued/sent/delivered/read/failed), código y categoría de error neutral (provider_*) si falló.',
    {
      client_ref: z.string().optional().describe('client_ref del envío (biz_opaque_callback_data)'),
      delivery_id: z.string().optional().describe('id de bot.campaign_deliveries'),
    },
    async (args) => run(reads, identity, 'get_delivery_status', args, readTool(() => getDeliveryStatus(reads, args))),
  );

  server.tool(
    'get_messaging_costs',
    'Consumido vs tope del mes en USD por canal × categoría (mismo cálculo que el enforcement de budget del servicio), con porcentaje usado.',
    {},
    async () => run(reads, identity, 'get_messaging_costs', {}, readTool(() => getMessagingCosts(reads))),
  );

  // ══ Tier 2 — writes de management (reversibles, no tocan clientes finales) ═

  const management = deps.management;
  if (management && identity.scopes.has('manage')) {
    server.tool(
      'sync_templates',
      'Sincroniza los templates desde Meta a la base local (idempotente). Devuelve cuántos se insertaron/actualizaron y si alguna campaña quedó auto-pausada por un template rechazado.',
      {},
      async () => run(reads, identity, 'sync_templates', {}, readTool(() => syncTemplates(management))),
    );

    server.tool(
      'sync_endpoints',
      'Sincroniza los números emisores de WhatsApp desde Meta al registro de endpoints (idempotente). No pisa los overrides manuales de prioridad ni de tope diario.',
      {},
      async () => run(reads, identity, 'sync_endpoints', {}, readTool(() => syncEndpoints(management))),
    );

    server.tool(
      'create_template',
      'Da de alta un template de WhatsApp en Meta y lo espeja localmente. Meta lo revisa de forma asíncrona (24-48h): queda en pending hasta que el sync levante el estado final. El nombre sólo admite minúsculas, números y guiones bajos.',
      {
        name: z.string().min(1).describe('Nombre del template (regex /^[a-z0-9_]+$/)'),
        language: z.string().min(1).describe("Idioma tal como lo espera Meta, ej. 'es_AR'"),
        category: z.string().min(1).describe('MARKETING, UTILITY o AUTHENTICATION'),
        body_text: z.string().min(1).describe('Cuerpo del mensaje; las variables van como {{1}}, {{2}}…'),
        body_example_values: z.array(z.string()).optional().describe('Valores de ejemplo de cada variable del cuerpo (Meta los exige si hay variables)'),
        header_text: z.string().optional().describe('Encabezado de texto opcional'),
        header_example_values: z.array(z.string()).optional().describe('Valores de ejemplo de las variables del encabezado'),
        footer_text: z.string().optional().describe('Pie de mensaje opcional'),
      },
      async (args) =>
        run(reads, identity, 'create_template', args, readTool(() => createWaTemplate(management, args))),
    );
  }

  // ══ Tier 3 — writes de envío (plata + clientes finales) ═══════════════════

  const send = deps.send;
  if (send && identity.scopes.has('send')) {
    /** Las 3 tools de envío comparten guarda de frecuencia + audit + core. */
    const sendTool = (
      toolName: string,
      args: Record<string, unknown>,
      build: () => Parameters<typeof sendMessage>[1],
    ): Promise<ToolResult> =>
      (async () => {
        const limited = await enforceSendRateLimit(reads, identity);
        if (!limited.ok) {
          void audit(reads, identity, toolName, args, 0, 'rate_limited');
          return errorResult(limited.message);
        }
        return run(reads, identity, toolName, args, async () =>
          sendOutcomeResult(await sendMessage(send, build())),
        );
      })();

    server.tool(
      'send_template',
      'Envía un template aprobado a UN contacto. Es la única forma de iniciar contacto fuera de la ventana de 24h. Pasa por las mismas guardas que el resto del servicio: presupuesto, opt-out, idempotencia por client_ref y límite de frecuencia. Para llegarle a muchos contactos se usa una campaña, no esta herramienta.',
      {
        to: z.string().min(1).describe('Destinatario (teléfono en formato E.164 para WhatsApp)'),
        template_name: z.string().min(1).describe('Nombre del template aprobado'),
        language: z.string().min(1).describe("Idioma del template, ej. 'es_AR'"),
        components: z.array(z.unknown()).optional().describe('Componentes de Meta con los valores de las variables'),
        client_ref: z.string().min(1).describe('Identificador único del envío: repetirlo dentro de 24h no reenvía (idempotencia)'),
        feature: z.string().min(1).default('staff-agent').describe('Qué origina el envío, para métricas y auditoría'),
      },
      async (args) =>
        sendTool('send_template', args, () => ({
          channel: 'whatsapp',
          to: args.to,
          content: {
            type: 'template',
            name: args.template_name,
            language: args.language,
            components: args.components,
          },
          context: { feature: args.feature, client_ref: args.client_ref },
        })),
    );

    server.tool(
      'send_message',
      'Envía texto libre a UN contacto. Sólo funciona dentro de la ventana de 24h desde su último mensaje entrante: fuera de la ventana el servicio lo rechaza y hay que usar send_template. Mismas guardas que send_template.',
      {
        to: z.string().min(1).describe('Destinatario (teléfono en formato E.164 para WhatsApp)'),
        text: z.string().min(1).describe('Texto del mensaje'),
        client_ref: z.string().min(1).describe('Identificador único del envío: repetirlo dentro de 24h no reenvía (idempotencia)'),
        feature: z.string().min(1).default('staff-agent').describe('Qué origina el envío, para métricas y auditoría'),
      },
      async (args) =>
        sendTool('send_message', args, () => ({
          channel: 'whatsapp',
          to: args.to,
          content: { type: 'text', text: args.text },
          context: { feature: args.feature, client_ref: args.client_ref },
        })),
    );

    server.tool(
      'send_internal_notification',
      'Manda un aviso a un número de staff (el mismo camino que usan las notificaciones internas del sistema). Sólo acepta destinos de la lista de staff configurada: no sirve para escribirle a un cliente.',
      {
        to: z.string().min(1).describe('Número de staff; tiene que estar en la allowlist del servicio'),
        text: z.string().min(1).describe('Texto del aviso'),
        client_ref: z.string().min(1).describe('Identificador único del aviso (idempotencia dentro de 24h)'),
        feature: z.string().min(1).default('staff-agent').describe('Qué origina el aviso, para métricas y auditoría'),
      },
      async (args) =>
        sendTool('send_internal_notification', args, () => ({
          channel: 'whatsapp',
          to: args.to,
          content: { type: 'text', text: args.text },
          context: { feature: args.feature, client_ref: args.client_ref, kind: 'notification' },
        })),
    );
  }

  return server;
}
