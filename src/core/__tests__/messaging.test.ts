/**
 * F5 — tests for `sendMessage()` / `isWithin24hWindow()`, extracted from
 * `transports/http/send-route.ts` (see `../messaging.ts` for the guard order
 * this exercises). Mocking style cloned from
 * `transports/http/__tests__/send-route.test.ts`: fake sql/redis/logger +
 * `vi.mock` on the provider port. `../budget.js` is ALSO mocked here (unlike
 * the send-route test) so budget scenarios don't need to reconstruct rate
 * card / config / spend query fixtures — we only care that `sendMessage`
 * reacts correctly to whatever `checkBudget` returns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { SqlClient } from '../../lib/postgres.js';
import type { Logger } from '../../lib/logger.js';
import type { OutboundMessage } from '../schemas.js';
import type { ProviderSendResult } from '../../providers/types.js';
import type { SendDeps } from '../messaging.js';

const mockSend = vi.fn<(input: unknown) => Promise<ProviderSendResult>>();
const mockGetProviderForChannel = vi.fn((_channel: string) => ({ channel: 'whatsapp', send: mockSend }));

vi.mock('../../ports/channel-provider.js', () => ({
  getProviderForChannel: (channel: string) => mockGetProviderForChannel(channel),
}));

const mockCheckBudget = vi.fn();
const mockRecordSendUsage = vi.fn();
const mockMaybeAlert = vi.fn();

vi.mock('../budget.js', () => ({
  checkBudget: (...args: unknown[]) => mockCheckBudget(...args),
  recordSendUsage: (...args: unknown[]) => mockRecordSendUsage(...args),
  maybeAlert: (...args: unknown[]) => mockMaybeAlert(...args),
}));

// vitest hoists vi.mock(...) above imports, so these static imports already
// resolve against the mocked modules.
import { sendMessage, isWithin24hWindow } from '../messaging.js';

function makeFakeSql(responses: unknown[][] = []): SqlClient {
  let i = 0;
  const fn = ((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const r = responses[i] ?? [];
    i += 1;
    return Promise.resolve(r);
  }) as unknown as SqlClient;
  return fn;
}

function makeThrowingSql(): SqlClient {
  return (async () => {
    throw new Error('db down');
  }) as unknown as SqlClient;
}

function makeFakeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string, ...rest: unknown[]) => {
      if (rest.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  } as unknown as Redis;
}

function makeThrowingSetRedis(): Redis {
  return {
    set: vi.fn(async () => {
      throw new Error('redis unreachable');
    }),
  } as unknown as Redis;
}

function makeFakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeDeps(overrides: Partial<SendDeps> = {}): SendDeps {
  return {
    sql: makeFakeSql(),
    redis: makeFakeRedis(),
    logger: makeFakeLogger(),
    staffAllowlist: ['+5491111111111'],
    defaultWaPhoneNumberId: '1234567890',
    defaultFromEmail: 'ops@example.com',
    ...overrides,
  };
}

let refCounter = 0;
function nextRef(): string {
  refCounter += 1;
  return `ref-${refCounter}`;
}

function makeMsg(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channel: 'whatsapp',
    to: '+5493511111111',
    content: { type: 'text', text: 'hola' },
    context: { feature: 'test-feature', client_ref: nextRef() },
    ...overrides,
  } as OutboundMessage;
}

beforeEach(() => {
  refCounter = 0;
  mockSend.mockReset();
  mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-default' });
  mockGetProviderForChannel.mockClear();
  mockCheckBudget.mockReset();
  mockCheckBudget.mockResolvedValue({ allowed: true, spent_usd: 0, cap_usd: null, pct: 0 });
  mockRecordSendUsage.mockReset();
  mockRecordSendUsage.mockResolvedValue(undefined);
  mockMaybeAlert.mockReset();
  mockMaybeAlert.mockResolvedValue(undefined);
});

describe('sendMessage — happy path', () => {
  it('sends a whatsapp template through the provider and records budget usage', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-123' });
    // opt-out check (empty = no unsubscribe row), resolveCategory lookup.
    const sql = makeFakeSql([[], [{ category: 'marketing' }]]);
    const deps = makeDeps({ sql });
    const msg = makeMsg({
      content: { type: 'template', name: 'welcome', language: 'es' },
      context: { feature: 'f', client_ref: 'ref-happy' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-123' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockRecordSendUsage).toHaveBeenCalledWith(deps.redis, deps.logger, 'whatsapp', 'marketing');
  });
});

describe('sendMessage — idempotency', () => {
  it('returns duplicate and never calls the provider when client_ref repeats', async () => {
    const deps = makeDeps();
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'dup-ref' } });

    await sendMessage(deps, msg);
    mockSend.mockClear();
    const second = await sendMessage(deps, msg);

    expect(second).toEqual({ status: 'duplicate' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('proceeds with the send when the idempotency SET NX throws (fail-open)', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-failopen' });
    const redis = makeThrowingSetRedis();
    const logger = makeFakeLogger();
    const deps = makeDeps({ redis, logger });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-failopen' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-failopen' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('sendMessage — staff allowlist', () => {
  it('rejects destination_not_allowed for a notification outside STAFF_NOTIFY_ALLOWLIST', async () => {
    const deps = makeDeps({ staffAllowlist: ['+5492222222222'] });
    const msg = makeMsg({
      to: '+5491111111111',
      context: { feature: 'f', client_ref: 'ref-allow', kind: 'notification' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'destination_not_allowed',
      detail: 'destination is not in the staff allowlist',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('sendMessage — opt-out', () => {
  it('rejects opted_out when the contact has unsubscribed_at set', async () => {
    const sql = makeFakeSql([[{ unsubscribed_at: new Date('2026-01-01') }]]);
    const deps = makeDeps({ sql });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-optout' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'opted_out',
      detail: 'contact opted out of messaging',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('proceeds when the contact is absent from the BUC (no opt-out row)', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-noopt' });
    const sql = makeFakeSql([[]]); // opt-out query returns no row
    const deps = makeDeps({ sql });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-noopt' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-noopt' });
  });
});

describe('sendMessage — budget', () => {
  it('rejects budget_exceeded when checkBudget disallows the send', async () => {
    mockCheckBudget.mockResolvedValue({ allowed: false, spent_usd: 10, cap_usd: 5, pct: 2 });
    const deps = makeDeps();
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-budget' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'budget_exceeded',
      detail: 'monthly budget cap reached for whatsapp/service',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('bypasses budget_exceeded only for kind=notification + critical=true', async () => {
    mockCheckBudget.mockResolvedValue({ allowed: false, spent_usd: 10, cap_usd: 5, pct: 2 });
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-critical' });
    const deps = makeDeps();
    const msg = makeMsg({
      to: '+5491111111111', // in the default staffAllowlist
      context: { feature: 'f', client_ref: 'ref-critical', kind: 'notification', critical: true },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-critical' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('sendMessage — 24h service window (free-form whatsapp text)', () => {
  it('sends free-form text when the contact wrote within the last 24h', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-within' });
    const sql = makeFakeSql([[], [{ last_inbound_at: twoHoursAgo }]]);
    const deps = makeDeps({ sql });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-within' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-within' });
  });

  it('rejects outside_24h_window for free-form text after 24h, and points to a template', async () => {
    const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const sql = makeFakeSql([[], [{ last_inbound_at: thirtyHoursAgo }]]);
    const deps = makeDeps({ sql });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-outside' } });

    const result = await sendMessage(deps, msg);

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toBe('outside_24h_window');
      expect(result.detail).toMatch(/template/i);
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('fail-opens (sends) when there is no last_inbound_at data at all', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-nodata' });
    const sql = makeFakeSql([[], []]); // opt-out empty, window query empty
    const deps = makeDeps({ sql });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-nodata' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-nodata' });
  });

  it('fail-opens (sends) when the 24h window query throws', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-qerr' });
    let call = 0;
    const sql = (async () => {
      call += 1;
      if (call === 2) throw new Error('db down');
      return [];
    }) as unknown as SqlClient;
    const logger = makeFakeLogger();
    const deps = makeDeps({ sql, logger });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-qerr' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-qerr' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('sends a notification kind text even outside the window (staff exemption)', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-notif' });
    const deps = makeDeps(); // default sql never returns a last_inbound_at row anyway
    const msg = makeMsg({
      to: '+5491111111111',
      context: { feature: 'f', client_ref: 'ref-notif-window', kind: 'notification' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-notif' });
  });

  it('sends a template regardless of the 24h window (guard only applies to free-form text)', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-tmpl' });
    const sql = makeFakeSql([[], [{ category: 'marketing' }]]); // opt-out, resolveCategory
    const deps = makeDeps({ sql });
    const msg = makeMsg({
      content: { type: 'template', name: 'reminder', language: 'es' },
      context: { feature: 'f', client_ref: 'ref-tmpl-window' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-tmpl' });
  });
});

describe('sendMessage — content/channel combos', () => {
  it('rejects unsupported_content_type for email + template content', async () => {
    const deps = makeDeps();
    const msg = makeMsg({
      channel: 'email',
      to: 'someone@example.com',
      content: { type: 'template', name: 'x', language: 'es' },
      context: { feature: 'f', client_ref: 'ref-email-bad' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'unsupported_content_type',
      detail: 'email only supports content.type=text in v1',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('sendMessage — provider failures', () => {
  it('returns failed when provider.send throws', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('network blew up'), { error_code: 'econnreset' }));
    const deps = makeDeps();
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-throw' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'failed', error_code: 'econnreset', error_message: 'network blew up' });
  });

  it('returns failed when the provider resolves ok:false', async () => {
    mockSend.mockResolvedValue({ ok: false, error_code: 'meta_400', error_message: 'bad request' });
    const deps = makeDeps();
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-notok' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'failed', error_code: 'meta_400', error_message: 'bad request' });
    expect(mockRecordSendUsage).not.toHaveBeenCalled();
  });
});

describe('sendMessage — missing configuration', () => {
  it('fails with missing_phone_number_id when whatsapp has no default phone number id configured', async () => {
    const deps = makeDeps({ defaultWaPhoneNumberId: undefined });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-nophone' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({
      status: 'failed',
      error_code: 'missing_phone_number_id',
      error_message: 'META_WA_DEFAULT_PHONE_NUMBER_ID is not configured',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('isWithin24hWindow', () => {
  it('returns within=true known=true for a recent last_inbound_at', async () => {
    const sql = makeFakeSql([[{ last_inbound_at: new Date(Date.now() - 60 * 60 * 1000) }]]);
    const logger = makeFakeLogger();

    const result = await isWithin24hWindow(sql, logger, 'whatsapp', '+5491111111111');

    expect(result.within).toBe(true);
    expect(result.known).toBe(true);
  });

  it('returns within=false known=true for a stale last_inbound_at', async () => {
    const sql = makeFakeSql([[{ last_inbound_at: new Date(Date.now() - 25 * 60 * 60 * 1000) }]]);
    const logger = makeFakeLogger();

    const result = await isWithin24hWindow(sql, logger, 'whatsapp', '+5491111111111');

    expect(result.within).toBe(false);
    expect(result.known).toBe(true);
  });

  it('fail-opens (within=true known=false) with no matching row', async () => {
    const sql = makeFakeSql([[]]);
    const logger = makeFakeLogger();

    const result = await isWithin24hWindow(sql, logger, 'whatsapp', '+5491111111111');

    expect(result).toEqual({ within: true, known: false, lastInboundAt: null });
  });

  it('fail-opens when the query throws', async () => {
    const sql = makeThrowingSql();
    const logger = makeFakeLogger();

    const result = await isWithin24hWindow(sql, logger, 'whatsapp', '+5491111111111');

    expect(result).toEqual({ within: true, known: false, lastInboundAt: null });
    expect(logger.warn).toHaveBeenCalled();
  });
});
