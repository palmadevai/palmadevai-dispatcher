/**
 * F3 — /management/* transport: auth fail-closed + status mapping. Core is
 * exercised through fakes (no Meta/PG); business behavior is covered in
 * `core/__tests__/management.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SqlClient } from '../../../lib/postgres.js';
import type { Logger } from '../../../lib/logger.js';
import type { GraphManagement } from '../../../providers/whatsapp-management.js';
import type { ManagementDeps } from '../../../core/management.js';
import { registerManagementRoutes } from '../management-routes.js';

function makeFakeSql(responses: unknown[][] = []): SqlClient {
  let i = 0;
  const fn = ((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const r = responses[i] ?? [];
    i += 1;
    return Promise.resolve(r);
  }) as unknown as SqlClient;
  return fn;
}

function makeCore(overrides: {
  sqlResponses?: unknown[][];
  graph?: Partial<GraphManagement>;
} = {}): ManagementDeps {
  const graph: GraphManagement = {
    fetchTemplates: vi.fn(async () => ({ ok: true as const, templates: [] })),
    createTemplate: vi.fn(async () => ({ ok: true as const, id: 'meta-1', status: 'PENDING' })),
    deleteTemplateByName: vi.fn(async () => ({ ok: true as const })),
    fetchPhoneNumbers: vi.fn(async () => ({ ok: true as const, phones: [] })),
    fetchPhoneQuality: vi.fn(async () => ({
      ok: true as const,
      quality_rating: 'GREEN',
      messaging_limit_tier: 'TIER_1K',
    })),
    ...overrides.graph,
  } as GraphManagement;
  return {
    sql: makeFakeSql(overrides.sqlResponses ?? []),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    graph,
    wabaId: 'waba-global',
    sendEmail: vi.fn(async () => ({ ok: true as const, message_id: 'x', http_status: 200 })),
  };
}

async function buildApp(opts: {
  sendBearer?: string | undefined;
  core?: ManagementDeps;
  domains?: import('../../../core/provider-domains.js').DomainsDeps;
} = {}): Promise<FastifyInstance> {
  const app = Fastify();
  registerManagementRoutes(app, {
    core: opts.core ?? makeCore(),
    sendBearer: 'sendBearer' in opts ? opts.sendBearer : 'test-bearer',
    domains: opts.domains,
  });
  await app.ready();
  return app;
}

const auth = { authorization: 'Bearer test-bearer' };

describe('/management auth', () => {
  it('503 management_disabled when the bearer env is unset (fail-closed)', async () => {
    const app = await buildApp({ sendBearer: undefined });
    const res = await app.inject({ method: 'POST', url: '/management/templates/sync' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'management_disabled' });
  });

  it('401 on wrong/missing bearer', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/management/endpoints/sync',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /management/templates/sync', () => {
  it('200 with the sync result shape (campaign-site contract)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/management/templates/sync', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      inserted: 0,
      updated: 0,
      total_fetched: 0,
      campaigns_paused: 0,
      errors: [],
    });
  });
});

describe('POST /management/templates', () => {
  it('400 on schema-invalid body', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/management/templates',
      headers: auth,
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 with the core message on business-invalid input (bad name)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/management/templates',
      headers: auth,
      payload: { name: 'Bad Name', language: 'es', category: 'utility', body_text: 'hola' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('lowercase');
  });

  it('200 on create ok', async () => {
    const core = makeCore({ sqlResponses: [[{ id: 'local-1' }]] });
    const app = await buildApp({ core });
    const res = await app.inject({
      method: 'POST',
      url: '/management/templates',
      headers: auth,
      payload: { name: 'promo_agosto', language: 'es_AR', category: 'utility', body_text: 'hola' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, meta_id: 'meta-1', local_id: 'local-1' });
  });
});

describe('DELETE /management/templates/:id', () => {
  it('200 {deleted:true} on success', async () => {
    const core = makeCore({ sqlResponses: [[{ name: 'bienvenida', waba_id: null }], [{ id: 'tpl-1' }]] });
    const app = await buildApp({ core });
    const res = await app.inject({ method: 'DELETE', url: '/management/templates/tpl-1', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
  });

  it('502 on hard Meta error', async () => {
    const core = makeCore({
      sqlResponses: [[{ name: 'bienvenida', waba_id: null }]],
      graph: {
        deleteTemplateByName: vi.fn(async () => ({
          ok: false as const,
          http_status: 500,
          error: 'HTTP 500: boom',
        })),
      },
    });
    const app = await buildApp({ core });
    const res = await app.inject({ method: 'DELETE', url: '/management/templates/tpl-1', headers: auth });
    expect(res.statusCode).toBe(502);
  });
});

describe('POST /management/endpoints/:id/quality-refresh', () => {
  it('200 with quality + tier on success', async () => {
    const core = makeCore({ sqlResponses: [[{ phone_number_id: 'pn-1' }], []] });
    const app = await buildApp({ core });
    const res = await app.inject({
      method: 'POST',
      url: '/management/endpoints/row-1/quality-refresh',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, updated: { quality_rating: 'green', tier_current: 1 } });
  });

  it('400 when the phone row does not exist', async () => {
    const core = makeCore({ sqlResponses: [[]] });
    const app = await buildApp({ core });
    const res = await app.inject({
      method: 'POST',
      url: '/management/endpoints/nope/quality-refresh',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('phone no encontrado');
  });
});

describe('GET /management/providers/resend/domains (S4.4)', () => {
  it('siempre 200 con el DomainsResult en el body — el contrato viaja en ok/reason', async () => {
    const app = await buildApp({
      domains: {
        resolveKey: vi.fn(async () => ({
          ok: false as const,
          error: 'resend: falta la credencial (RESEND_API_KEY sin valor)',
        })),
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/management/providers/resend/domains',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: false,
      reason: 'no_key',
      detail: 'resend: falta la credencial (RESEND_API_KEY sin valor)',
    });
  });

  it('exige el bearer como todo /management/*', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/management/providers/resend/domains' });
    expect(res.statusCode).toBe(401);
  });
});
