/**
 * `/mcp/messaging-v0` — Fastify wiring del Messaging MCP (F4/H4.1).
 *
 * Transport HTTP+SSE del SDK (`SSEServerTransport`), el MISMO protocolo que
 * exponen los MCP de n8n (`mcpTrigger`) y que chat-site ya consume con
 * `SSEClientTransport` + bearer + heartbeat de 25s:
 *   GET  /mcp/messaging-v0            → stream SSE (announce del endpoint POST)
 *   POST /mcp/messaging-v0/messages   → mensajes JSON-RPC (query ?sessionId=)
 *
 * Auth: bearer PROPIO `MESSAGING_MCP_BEARER` — deliberadamente distinto de
 * `DISPATCHER_SEND_BEARER`: chat-site sólo porta la credencial read-only del
 * MCP, nunca la que autoriza writes en /send y /management (least privilege).
 * Fail-closed: env ausente → 503 en ambas rutas.
 *
 * Red: docker interna, sin ruta Traefik (H4.1 — la exposición pública es
 * H5.4, gated por JWT per-usuario del cockpit IdP).
 *
 * Ping SSE cada 20s (comentario `: ping`) — el SDK no manda keep-alives y un
 * stream idle puede ser cortado por timeouts intermedios; espejo del
 * heartbeat de 25s que el cliente ya hace por su lado.
 */
import type { FastifyInstance } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { ReadDeps } from '../../core/messaging-reads.js';
import { buildMessagingMcpServer } from './server.js';

export interface McpRouteDeps {
  reads: ReadDeps;
  /** `env.MESSAGING_MCP_BEARER`. Undefined → rutas siempre 503 (fail-closed). */
  mcpBearer: string | undefined;
}

const SSE_PATH = '/mcp/messaging-v0';
const MESSAGES_PATH = '/mcp/messaging-v0/messages';
const PING_INTERVAL_MS = 20_000;

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  const transports = new Map<string, SSEServerTransport>();
  const { logger } = deps.reads;

  function authorized(authHeader: string | undefined): 'ok' | 'disabled' | 'unauthorized' {
    if (!deps.mcpBearer) return 'disabled';
    if (authHeader !== `Bearer ${deps.mcpBearer}`) return 'unauthorized';
    return 'ok';
  }

  app.get(SSE_PATH, async (request, reply) => {
    const auth = authorized(request.headers['authorization']);
    if (auth === 'disabled') return reply.code(503).send({ error: 'mcp_disabled' });
    if (auth === 'unauthorized') return reply.code(401).send({ error: 'unauthorized' });

    // SSE long-lived: Fastify no maneja el response — raw socket del SDK.
    reply.hijack();
    const transport = new SSEServerTransport(MESSAGES_PATH, reply.raw);
    transports.set(transport.sessionId, transport);

    const ping = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, PING_INTERVAL_MS);

    request.raw.on('close', () => {
      clearInterval(ping);
      transports.delete(transport.sessionId);
      logger.info({ session_id: transport.sessionId }, 'messaging-mcp: SSE session closed');
    });

    const server = buildMessagingMcpServer(deps.reads);
    await server.connect(transport);
    logger.info({ session_id: transport.sessionId }, 'messaging-mcp: SSE session opened');
  });

  app.post<{ Querystring: { sessionId?: string } }>(MESSAGES_PATH, async (request, reply) => {
    const auth = authorized(request.headers['authorization']);
    if (auth === 'disabled') return reply.code(503).send({ error: 'mcp_disabled' });
    if (auth === 'unauthorized') return reply.code(401).send({ error: 'unauthorized' });

    const sessionId = request.query.sessionId;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      return reply.code(404).send({ error: 'unknown_session', detail: 'abrí la sesión con GET /mcp/messaging-v0 primero' });
    }
    reply.hijack();
    await transport.handlePostMessage(request.raw, reply.raw, request.body);
  });
}
