/**
 * F4 — /mcp/messaging-v0: auth fail-closed + sesiones. El handshake SSE
 * completo se smokea en el lab (deployado ≠ funcionando); acá se cubre lo que
 * responde ANTES del hijack: 503/401/404. Las tools se cubren en
 * `core/__tests__/messaging-reads.test.ts` + el registro en `server`.
 *
 * F5 — se agrega el modelo de identidad/scopes: qué catálogo de tools ve cada
 * bearer. Que una conexión read-only NO vea las tools de envío es la guarda,
 * no una cuestión estética: si aparecen en `tools/list`, el agente las va a
 * intentar.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import type { SqlClient } from '../../../lib/postgres.js';
import type { Logger } from '../../../lib/logger.js';
import { registerMcpRoutes } from '../routes.js';
import { buildMessagingMcpServer, type McpToolDeps } from '../server.js';
import { resolveIdentity } from '../identity.js';
import type { ManagementDeps } from '../../../core/management.js';
import type { SendDeps } from '../../../core/messaging.js';

function makeReads() {
  return {
    sql: ((_s: TemplateStringsArray) => Promise.resolve([])) as unknown as SqlClient,
    redis: { get: vi.fn(async () => null) } as unknown as Redis,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
  };
}

/** Deps completas: los tres cores presentes, para que el scope sea lo único que decida. */
function makeToolDeps(): McpToolDeps {
  const reads = makeReads();
  return {
    reads,
    management: {} as unknown as ManagementDeps,
    send: {} as unknown as SendDeps,
  };
}

async function buildApp(bearers: { read?: string; write?: string }) {
  const app = Fastify();
  registerMcpRoutes(app, {
    tools: makeToolDeps(),
    bearers: { read: bearers.read, write: bearers.write },
  });
  await app.ready();
  return app;
}

function toolNames(server: ReturnType<typeof buildMessagingMcpServer>): string[] {
  const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  return Object.keys(registered).sort();
}

const TIER_1 = [
  'get_channel_health',
  'get_delivery_status',
  'get_messaging_costs',
  'get_template',
  'list_channels',
  'list_templates',
];
const TIER_2 = ['create_template', 'sync_endpoints', 'sync_templates'];
const TIER_3 = ['send_internal_notification', 'send_message', 'send_template'];

describe('/mcp/messaging-v0 auth', () => {
  it('503 mcp_disabled cuando no hay ningún bearer configurado (fail-closed)', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/mcp/messaging-v0' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'mcp_disabled' });
    const post = await app.inject({ method: 'POST', url: '/mcp/messaging-v0/messages', payload: {} });
    expect(post.statusCode).toBe(503);
  });

  it('401 con bearer inválido en GET y POST', async () => {
    const app = await buildApp({ read: 'secret' });
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

  it('401 sin header Authorization', async () => {
    const app = await buildApp({ read: 'secret' });
    const res = await app.inject({ method: 'GET', url: '/mcp/messaging-v0' });
    expect(res.statusCode).toBe(401);
  });

  it('404 unknown_session en POST sin sesión SSE abierta', async () => {
    const app = await buildApp({ read: 'secret' });
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/messaging-v0/messages?sessionId=zzz',
      headers: { authorization: 'Bearer secret' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('el MCP sigue vivo con SOLO el bearer de writes configurado', async () => {
    const app = await buildApp({ write: 'w' });
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/messaging-v0/messages?sessionId=zzz',
      headers: { authorization: 'Bearer w' },
      payload: {},
    });
    expect(res.statusCode).toBe(404); // pasó auth, murió por sesión inexistente
  });
});

describe('resolveIdentity', () => {
  const bearers = { read: 'r', write: 'w' };

  it('el bearer read-only resuelve a identidad de servicio con scope read', () => {
    const res = resolveIdentity('Bearer r', bearers);
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.identity.id).toBe('messaging-mcp');
    expect(res.identity.role).toBe('service');
    expect([...res.identity.scopes]).toEqual(['read']);
  });

  it('el bearer de writes resuelve a identidad staff con read+manage+send', () => {
    const res = resolveIdentity('Bearer w', bearers);
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.identity.id).toBe('messaging-mcp-staff');
    expect(res.identity.role).toBe('staff');
    expect([...res.identity.scopes].sort()).toEqual(['manage', 'read', 'send']);
  });

  it('sin ningún bearer configurado el MCP está deshabilitado', () => {
    expect(resolveIdentity('Bearer r', { read: undefined, write: undefined }).kind).toBe('disabled');
  });

  it('un bearer que no matchea es unauthorized, nunca una identidad por defecto', () => {
    expect(resolveIdentity('Bearer otro', bearers).kind).toBe('unauthorized');
    expect(resolveIdentity(undefined, bearers).kind).toBe('unauthorized');
    // Sin el prefijo `Bearer ` tampoco pasa.
    expect(resolveIdentity('r', bearers).kind).toBe('unauthorized');
  });
});

describe('buildMessagingMcpServer — catálogo por scope', () => {
  const readIdentity = { id: 'messaging-mcp', role: 'service', scopes: new Set(['read'] as const) };
  const staffIdentity = {
    id: 'messaging-mcp-staff',
    role: 'staff',
    scopes: new Set(['read', 'manage', 'send'] as const),
  };

  it('la identidad read-only ve exactamente las 6 tools Tier 1 del doc §4', () => {
    const server = buildMessagingMcpServer(makeToolDeps(), readIdentity);
    expect(toolNames(server)).toEqual(TIER_1);
  });

  it('la identidad read-only NO ve ninguna tool de escritura', () => {
    const names = toolNames(buildMessagingMcpServer(makeToolDeps(), readIdentity));
    for (const write of [...TIER_2, ...TIER_3]) {
      expect(names).not.toContain(write);
    }
  });

  it('la identidad staff ve Tier 1 + Tier 2 + Tier 3', () => {
    const server = buildMessagingMcpServer(makeToolDeps(), staffIdentity);
    expect(toolNames(server)).toEqual([...TIER_1, ...TIER_2, ...TIER_3].sort());
  });

  it('sin core de envío inyectado, las tools Tier 3 no se registran aunque el scope alcance', () => {
    const deps = makeToolDeps();
    delete deps.send;
    const names = toolNames(buildMessagingMcpServer(deps, staffIdentity));
    for (const t of TIER_3) expect(names).not.toContain(t);
    for (const t of TIER_2) expect(names).toContain(t);
  });

  it('sin core de management inyectado, las tools Tier 2 no se registran', () => {
    const deps = makeToolDeps();
    delete deps.management;
    const names = toolNames(buildMessagingMcpServer(deps, staffIdentity));
    for (const t of TIER_2) expect(names).not.toContain(t);
    for (const t of TIER_3) expect(names).toContain(t);
  });
});
