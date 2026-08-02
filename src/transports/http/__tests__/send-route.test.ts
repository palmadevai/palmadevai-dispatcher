/**
 * H2.1 — POST /send. Uses Fastify's built-in `.inject()` (no real network
 * listener) + fakes for sql/redis + a mocked `ports/channel-provider.js` so
 * no real Meta/Resend HTTP call ever fires from tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import type { Logger } from '../../../lib/logger.js';
import { MetricsCollector } from '../../../observability/metrics-collector.js';
import { __resetBudgetCachesForTests } from '../../../core/budget.js';
import type { ProviderSendResult } from '../../../providers/types.js';

const mockSend = vi.fn<(input: unknown) => Promise<ProviderSendResult>>();

vi.mock('../../../ports/channel-provider.js', () => ({
  getProviderForChannel: vi.fn(() => ({ channel: 'whatsapp', send: mockSend })),
}));

// vitest hoists `vi.mock(...)` above imports, so this static import already
// resolves to the mocked module.
import { registerSendRoute } from '../send-route.js';

function makeFakeSql(responses: unknown[][] = []): Sql {
  let i = 0;
  const fn = ((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const r = responses[i] ?? [];
    i += 1;
    return Promise.resolve(r);
  }) as unknown as Sql;
  return fn;
}

function makeFakeRedis(): Redis {
  const store = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...rest: unknown[]) => {
      if (rest.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      const v = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(v));
      return v;
    }),
    expire: vi.fn(async () => 1),
  };
  return redis as unknown as Redis;
}

function makeFakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

// Empty rate card + no budget config + no campaign spend → checkBudget always allows.
const NO_BUDGET_CAP_SQL_RESPONSES: unknown[][] = [[], [], []];

async function buildApp(overrides: {
  sendBearer?: string | undefined;
  staffAllowlist?: string[];
  defaultWaPhoneNumberId?: string | undefined;
  sqlResponses?: unknown[][];
} = {}): Promise<{ app: FastifyInstance; redis: Redis; sql: Sql }> {
  const app = Fastify();
  const sql = makeFakeSql(overrides.sqlResponses ?? NO_BUDGET_CAP_SQL_RESPONSES);
  const redis = makeFakeRedis();
  registerSendRoute(app, {
    sql,
    redis,
    logger: makeFakeLogger(),
    metricsCollector: new MetricsCollector(),
    sendBearer: 'sendBearer' in overrides ? overrides.sendBearer : 'test-bearer',
    staffAllowlist: overrides.staffAllowlist ?? ['+5491111111111'],
    defaultWaPhoneNumberId: overrides.defaultWaPhoneNumberId ?? '1234567890',
    defaultFromEmail: 'ops@example.com',
  });
  await app.ready();
  return { app, redis, sql };
}

const notificationBody = {
  channel: 'whatsapp',
  to: '+5491111111111',
  content: { type: 'text', text: 'hola' },
  context: { feature: 'test-feature', client_ref: 'ref-1', kind: 'notification' },
};

beforeEach(() => {
  __resetBudgetCachesForTests();
  mockSend.mockReset();
});

describe('POST /send — auth', () => {
  it('responds 503 send_disabled when DISPATCHER_SEND_BEARER is not configured', async () => {
    const { app } = await buildApp({ sendBearer: undefined });
    const res = await app.inject({ method: 'POST', url: '/send', payload: notificationBody });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'send_disabled' });
  });

  it('responds 401 unauthorized when the bearer header is missing/wrong', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/send',
      headers: { authorization: 'Bearer wrong-token' },
      payload: notificationBody,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /send — idempotency', () => {
  it('returns duplicate without calling the provider when client_ref was already seen', async () => {
    const { app, redis } = await buildApp();
    await redis.set('msgsvc:ref:ref-1', '1');

    const res = await app.inject({
      method: 'POST',
      url: '/send',
      headers: { authorization: 'Bearer test-bearer' },
      payload: notificationBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'duplicate' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('POST /send — notification allowlist', () => {
  it('403s when the destination is not in STAFF_NOTIFY_ALLOWLIST', async () => {
    const { app } = await buildApp({ staffAllowlist: ['+5492222222222'] });
    const res = await app.inject({
      method: 'POST',
      url: '/send',
      headers: { authorization: 'Bearer test-bearer' },
      payload: notificationBody, // to: +5491111111111, not in allowlist
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'destination_not_allowed' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('POST /send — happy path', () => {
  it('sends a text message through the provider and returns 200 sent', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-123' });
    const { app, redis } = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/send',
      headers: { authorization: 'Bearer test-bearer' },
      payload: notificationBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'sent', message_id: 'wamid-123' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendInput = mockSend.mock.calls[0]![0] as { phone_number_id: string; to: string; type: string; body: string };
    expect(sendInput).toMatchObject({
      phone_number_id: '1234567890',
      to: '+5491111111111',
      type: 'text',
      body: 'hola',
    });
    // recordSendUsage incremented the monthly counter.
    expect(redis.incr).toHaveBeenCalled();
  });

  it('returns 502 with the provider error when the send fails (no retry)', async () => {
    mockSend.mockResolvedValue({ ok: false, error_code: 'meta_400', error_message: 'bad request' });
    const { app } = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/send',
      headers: { authorization: 'Bearer test-bearer' },
      payload: { ...notificationBody, context: { ...notificationBody.context, client_ref: 'ref-2' } },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ status: 'failed', error_code: 'meta_400', error_message: 'bad request' });
  });
});

describe('POST /send — budget', () => {
  it('bypasses budget_exceeded only for kind=notification + critical=true', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-critical' });
    const exceededBudgetSqlResponses: unknown[][] = [
      [{ channel: 'whatsapp', category: 'service', country: 'AR', usd_per_message: '1' }],
      [{ value: { whatsapp: { service: 1 } } }], // $1 cap
      [{ category: 'service', cnt: '999' }], // already way over
    ];
    const { app } = await buildApp({ sqlResponses: exceededBudgetSqlResponses });

    const res = await app.inject({
      method: 'POST',
      url: '/send',
      headers: { authorization: 'Bearer test-bearer' },
      payload: {
        ...notificationBody,
        context: { ...notificationBody.context, client_ref: 'ref-critical', critical: true },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('429s with budget_exceeded for a non-critical send once the cap is reached', async () => {
    const exceededBudgetSqlResponses: unknown[][] = [
      [{ channel: 'whatsapp', category: 'service', country: 'AR', usd_per_message: '1' }],
      [{ value: { whatsapp: { service: 1 } } }],
      [{ category: 'service', cnt: '999' }],
    ];
    const { app } = await buildApp({ sqlResponses: exceededBudgetSqlResponses });

    const res = await app.inject({
      method: 'POST',
      url: '/send',
      headers: { authorization: 'Bearer test-bearer' },
      payload: {
        ...notificationBody,
        context: { ...notificationBody.context, client_ref: 'ref-noncritical' },
      },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ status: 'failed', error_code: 'budget_exceeded' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
