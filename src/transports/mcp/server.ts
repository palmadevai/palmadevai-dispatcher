/**
 * Messaging MCP — Tier 1 read-only tools (F4/H4.1, doc §4).
 *
 * Transport rule (§3.4): las tools son fachada 1:1 sobre `core/messaging-reads`
 * — cero lógica de negocio acá. Un `McpServer` NUEVO por conexión SSE (el SDK
 * ata un server a un transport); las 6 tools son stateless.
 *
 * Audit (H4.1): toda invocación deja fila en `bot.staff_audit` con identidad
 * de servicio (`session_key='messaging-mcp'`, `staff_role='service'`,
 * `channel='mcp'`) hasta que H5.4 traiga identidad per-usuario. Fail-open,
 * mismo criterio que chat-site `lib/agent/audit.ts`: si el INSERT falla se
 * loguea y la tool responde igual — nunca bloquear la respuesta por el audit.
 *
 * Tier 2/3 (writes) NO viven acá — son F5, gated por sus guardas (doc §9).
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

const SERVER_INFO = { name: 'palmadevai-messaging-mcp', version: '0.1.0' };

async function audit(
  deps: ReadDeps,
  toolName: string,
  toolArgs: unknown,
  latencyMs: number,
  error: string | null,
): Promise<void> {
  try {
    await deps.sql`
      INSERT INTO bot.staff_audit
        (session_key, staff_role, tool_name, tool_args, modality, latency_ms, error, channel)
      VALUES ('messaging-mcp', 'service', ${toolName}, ${JSON.stringify(toolArgs ?? {})}::jsonb,
              'text', ${latencyMs}, ${error}, 'mcp')
    `;
  } catch (err) {
    deps.logger.warn(
      { err: (err as Error).message, tool: toolName },
      'messaging-mcp: staff_audit INSERT failed (fail-open, tool response unaffected)',
    );
  }
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/** Ejecuta la lectura + audita. Errores → tool result de error accionable (§3.4 regla 3). */
async function run(
  deps: ReadDeps,
  toolName: string,
  toolArgs: unknown,
  fn: () => Promise<unknown>,
): Promise<ToolResult> {
  const startMs = Date.now();
  try {
    const data = await fn();
    void audit(deps, toolName, toolArgs, Date.now() - startMs, null);
    return jsonResult(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void audit(deps, toolName, toolArgs, Date.now() - startMs, msg);
    deps.logger.error({ err: msg, tool: toolName }, 'messaging-mcp tool failed');
    return {
      content: [{ type: 'text', text: `La consulta falló (${toolName}): ${msg}. Reintentá o revisá el dispatcher.` }],
      isError: true,
    };
  }
}

export function buildMessagingMcpServer(deps: ReadDeps): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.tool(
    'list_channels',
    'Canales de mensajería de la plataforma: cuáles tienen provider implementado y el estado de sus endpoints registrados (active/warming/suspended).',
    {},
    async () => run(deps, 'list_channels', {}, () => listChannels(deps)),
  );

  server.tool(
    'get_channel_health',
    'Salud del canal WhatsApp por número emisor: quality rating de Meta, messaging limit tier, estado de warming y los últimos 7 snapshots de calidad.',
    {},
    async () => run(deps, 'get_channel_health', {}, () => getChannelHealth(deps)),
  );

  server.tool(
    'list_templates',
    'Templates de mensajería sincronizados desde Meta (bot.message_templates), filtrables por canal, idioma y estado (approved/pending/rejected/disabled).',
    {
      channel: z.string().optional().describe("Filtro por canal, ej. 'whatsapp'"),
      status: z.string().optional().describe("Filtro por estado Meta, ej. 'approved' o 'rejected'"),
      language: z.string().optional().describe("Filtro por idioma tal como lo guarda Meta, ej. 'es_AR'"),
    },
    async (args) => run(deps, 'list_templates', args, () => listTemplates(deps, args)),
  );

  server.tool(
    'get_template',
    'Detalle de un template por nombre: componentes del body, variables esperadas ({{1}}, {{2}}…), categoría, estado Meta y motivo de rechazo si lo hay.',
    {
      name: z.string().min(1).describe('Nombre exacto del template'),
      language: z.string().optional().describe("Idioma, ej. 'es_AR' (opcional si el nombre es único)"),
      channel: z.string().optional().describe("Canal, default cualquiera"),
    },
    async (args) => run(deps, 'get_template', args, () => getTemplate(deps, args)),
  );

  server.tool(
    'get_delivery_status',
    'Estado de un envío por client_ref o id de delivery: timeline (queued/sent/delivered/read/failed), código y categoría de error neutral (provider_*) si falló.',
    {
      client_ref: z.string().optional().describe('client_ref del envío (biz_opaque_callback_data)'),
      delivery_id: z.string().optional().describe('id de bot.campaign_deliveries'),
    },
    async (args) => run(deps, 'get_delivery_status', args, () => getDeliveryStatus(deps, args)),
  );

  server.tool(
    'get_messaging_costs',
    'Consumido vs tope del mes en USD por canal × categoría (mismo cálculo que el enforcement de budget del servicio), con porcentaje usado.',
    {},
    async () => run(deps, 'get_messaging_costs', {}, () => getMessagingCosts(deps)),
  );

  return server;
}
