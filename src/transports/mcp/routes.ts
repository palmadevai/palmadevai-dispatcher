/**
 * `/mcp/messaging-v0` — Fastify wiring del Messaging MCP (F4/H4.1, ampliado
 * con las tools de escritura en F5/H5.1-H5.2).
 *
 * Transport HTTP+SSE del SDK (`SSEServerTransport`), el MISMO protocolo que
 * exponen los MCP de n8n (`mcpTrigger`) y que chat-site ya consume con
 * `SSEClientTransport` + bearer + heartbeat de 25s:
 *   GET  /mcp/messaging-v0            → stream SSE (announce del endpoint POST)
 *   POST /mcp/messaging-v0/messages   → mensajes JSON-RPC (query ?sessionId=)
 *
 * Auth: dos bearers PROPIOS del MCP, deliberadamente distintos de
 * `DISPATCHER_SEND_BEARER` — `MESSAGING_MCP_BEARER` (read-only, el que porta
 * chat-site) y `MESSAGING_MCP_WRITE_BEARER` (read + management + send). El
 * bearer resuelve la identidad y sus scopes (`identity.ts`), y el catálogo de
 * tools se arma según eso: una conexión read-only ni siquiera ve las tools de
 * escritura. Fail-closed: sin ningún bearer configurado, 503 en ambas rutas.
 *
 * La identidad se resuelve en el **GET** (apertura de la sesión SSE) y queda
 * atada a ese transport: el catálogo de tools del server se fija en ese
 * momento, así que el POST de mensajes no puede escalar privilegios cambiando
 * de bearer a mitad de sesión — igual valida su propio bearer para no aceptar
 * mensajes de un tercero que adivine el sessionId.
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
import { buildMessagingMcpServer, type McpToolDeps } from './server.js';
import { resolveIdentity, type McpBearers } from './identity.js';

export interface McpRouteDeps {
  tools: McpToolDeps;
  /** `MESSAGING_MCP_BEARER` / `MESSAGING_MCP_WRITE_BEARER`. Ambos ausentes → 503. */
  bearers: McpBearers;
}

const SSE_PATH = '/mcp/messaging-v0';
const MESSAGES_PATH = '/mcp/messaging-v0/messages';
const PING_INTERVAL_MS = 20_000;

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  const transports = new Map<string, SSEServerTransport>();
  const { logger } = deps.tools.reads;

  app.get(SSE_PATH, async (request, reply) => {
    const auth = resolveIdentity(request.headers['authorization'], deps.bearers);
    if (auth.kind === 'disabled') return reply.code(503).send({ error: 'mcp_disabled' });
    if (auth.kind === 'unauthorized') return reply.code(401).send({ error: 'unauthorized' });

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

    const server = buildMessagingMcpServer(deps.tools, auth.identity);
    await server.connect(transport);
    logger.info(
      { session_id: transport.sessionId, identity: auth.identity.id, scopes: [...auth.identity.scopes] },
      'messaging-mcp: SSE session opened',
    );
  });

  app.post<{ Querystring: { sessionId?: string } }>(MESSAGES_PATH, async (request, reply) => {
    const auth = resolveIdentity(request.headers['authorization'], deps.bearers);
    if (auth.kind === 'disabled') return reply.code(503).send({ error: 'mcp_disabled' });
    if (auth.kind === 'unauthorized') return reply.code(401).send({ error: 'unauthorized' });

    const sessionId = request.query.sessionId;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      return reply.code(404).send({ error: 'unknown_session', detail: 'abrí la sesión con GET /mcp/messaging-v0 primero' });
    }
    reply.hijack();
    await transport.handlePostMessage(request.raw, reply.raw, request.body);
  });
}
