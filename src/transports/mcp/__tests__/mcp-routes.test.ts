/**
 * F4 — /mcp/messaging-v0: auth fail-closed + sesiones. El handshake SSE
 * completo se smokea en el lab (deployado ≠ funcionando); acá se cubre lo que
 * responde ANTES del hijack: 503/401/404. Las tools se cubren en
 * `core/__tests__/messaging-reads.test.ts` + el registro en `server`.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import type { SqlClient } from '../../../lib/postgres.js';
import type { Logger } from '../../../lib/logger.js';
import { registerMcpRoutes } from '../routes.js';
import { buildMessagingMcpServer } from '../server.js';

function makeReads() {
  return {
    sql: ((_s: TemplateStringsArray) => Promise.resolve([])) as unknown as SqlClient,
    redis: { get: vi.fn(async () => null) } as unknown as Redis,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
  };
}

async function buildApp(mcpBearer: string | undefined) {
  const app = Fastify();
  registerMcpRoutes(app, { reads: makeReads(), mcpBearer });
  await app.ready();
  return app;
}

describe('/mcp/messaging-v0 auth', () => {
  it('503 mcp_disabled cuando MESSAGING_MCP_BEARER no está seteado (fail-closed)', async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({ method: 'GET', url: '/mcp/messaging-v0' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'mcp_disabled' });
    const post = await app.inject({ method: 'POST', url: '/mcp/messaging-v0/messages', payload: {} });
    expect(post.statusCode).toBe(503);
  });

  it('401 con bearer inválido en GET y POST', async () => {
    const app = await buildApp('secret');
    const res = await app.inject({
      method: 'GET',
      url: '/mcp/messaging-v0',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
    const post = await app.inject({
      method: 'POST',
      url: '/mcp/messaging-v0/messages',
      headers: { authorization: 'Bearer nope' },
      payload: {},
    });
    expect(post.statusCode).toBe(401);
  });

  it('404 unknown_session en POST sin sesión SSE abierta', async () => {
    const app = await buildApp('secret');
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/messaging-v0/messages?sessionId=zzz',
      headers: { authorization: 'Bearer secret' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('buildMessagingMcpServer', () => {
  it('registra exactamente las 6 tools Tier 1 del doc §4', () => {
    const server = buildMessagingMcpServer(makeReads());
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registered).sort()).toEqual([
      'get_channel_health',
      'get_delivery_status',
      'get_messaging_costs',
      'get_template',
      'list_channels',
      'list_templates',
    ]);
  });
});
