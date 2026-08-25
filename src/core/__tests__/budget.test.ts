/**
 * H2.2 — core/budget.ts. Domain-pure: fakes for `sql`/`redis` instead of a
 * real DB/Redis (matches the injectable-deps pattern already used in
 * `ports/__tests__/channel-provider.test.ts`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import type { Logger } from '../../lib/logger.js';
import { checkBudget, recordSendUsage, maybeAlert, __resetBudgetCachesForTests } from '../budget.js';

/**
 * `checkBudget` fires exactly 3 sql-tagged-template calls in this fixed
 * order (see `Promise.all` in `checkBudget`): rate card, budget config,
 * campaign spend. `responses[i]` feeds the i-th call.
 */
function makeFakeSql(responses: unknown[][]): Sql {
  let i = 0;
  const fn = ((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const r = responses[i] ?? [];
    i += 1;
    return Promise.resolve(r);
  }) as unknown as Sql;
  return fn;
}

function makeFakeRedis(initial: Record<string, string> = {}): Redis {
  const store = new Map<string, string>(Object.entries(initial));
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

beforeEach(() => {
  __resetBudgetCachesForTests();
});

describe('checkBudget', () => {
  it('allows everything when no messaging_budget config is set (no cap = no enforcement)', async () => {
    const sql = makeFakeSql([[], [], []]); // rate card empty, no config row, no campaign spend
    const redis = makeFakeRedis(); // no /send counter yet
    const logger = makeFakeLogger();

    const result = await checkBudget(sql, redis, logger, 'whatsapp', 'marketing');

    expect(result.allowed).toBe(true);
    expect(result.cap_usd).toBeNull();
    // Fallback rate card kicks in even with no cap — spend is still computed.
    expect(result.spent_usd).toBe(0);
  });

  it('blocks once spend reaches the configured cap and reports the correct pct', async () => {
    const sql = makeFakeSql([
      [{ channel: 'whatsapp', category: 'marketing', country: 'AR', usd_per_message: '1' }], // rate card: $1/msg for easy math
      [{ value: { whatsapp: { marketing: 10 } } }], // cap $10/month
      [{ category: 'marketing', cnt: '12' }], // 12 campaign sends this month = $12
    ]);
    const redis = makeFakeRedis(); // no extra /send usage
    const logger = makeFakeLogger();

    const result = await checkBudget(sql, redis, logger, 'whatsapp', 'marketing');

    expect(result.cap_usd).toBe(10);
    expect(result.spent_usd).toBe(12);
    expect(result.pct).toBe(1.2);
    expect(result.allowed).toBe(false);
  });

  it('adds the /send Redis counter on top of campaign spend from Postgres', async () => {
    const sql = makeFakeSql([
      [{ channel: 'whatsapp', category: 'service', country: 'AR', usd_per_message: '1' }],
      [{ value: { whatsapp: { service: 100 } } }],
      [{ category: 'service', cnt: '5' }], // 5 campaign sends
    ]);
    const redis = makeFakeRedis();
    const logger = makeFakeLogger();

    // Seed the /send counter under the real current-month key (checkBudget
    // computes the key internally from Date.now(), so the fake has to match).
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await redis.set(`msgsvc:sent:${monthKey}:whatsapp:service`, '3');

    const result = await checkBudget(sql, redis, logger, 'whatsapp', 'service');

    // 5 (campaign, Postgres) + 3 (/send, Redis) = 8 messages * $1 = $8, well under $100 cap.
    expect(result.spent_usd).toBe(8);
    expect(result.allowed).toBe(true);
  });

  it('falls back to hardcoded rate card constants when bot.message_rate_card is unqueryable', async () => {
    const sql = (() => Promise.reject(new Error('relation "bot.message_rate_card" does not exist'))) as unknown as Sql;
    const redis = makeFakeRedis();
    const logger = makeFakeLogger();

    const result = await checkBudget(sql, redis, logger, 'whatsapp', 'marketing');

    // No cap configured (config query also failed on the same broken sql) → allowed.
    expect(result.allowed).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('recordSendUsage', () => {
  it('increments the monthly per channel×category counter', async () => {
    const redis = makeFakeRedis();
    const logger = makeFakeLogger();
    await recordSendUsage(redis, logger, 'whatsapp', 'utility');
    await recordSendUsage(redis, logger, 'whatsapp', 'utility');
    expect(redis.incr).toHaveBeenCalledTimes(2);
    expect(redis.expire).toHaveBeenCalledTimes(2);
  });
});

describe('maybeAlert', () => {
  // Cada test arma su propio fake `sql` (resuelve `notify_to`/`email_from`)
  // y su propio `sendAlert` mock — el shape que devuelve `resolveAlertRecipients`
  // internamente no está exportado, así que se mockea vía el `sql` fake, igual
  // que `checkBudget` arriba.
  function makeFakeAlertSql(recipients: string[] | null, emailFrom: string | null): Sql {
    return (async () => [{ recipients, email_from: emailFrom }]) as unknown as Sql;
  }

  function makeFakeSendAlert() {
    return vi.fn(async () => ({ status: 'sent' }));
  }

  const RESULT_80PCT = { allowed: true, spent_usd: 8.5, cap_usd: 10, pct: 0.85 };

  it('does nothing when there is no cap configured', async () => {
    const sql = makeFakeAlertSql(['ops@palmadev.test'], 'alerts@palmadev.test');
    const redis = makeFakeRedis();
    const logger = makeFakeLogger();
    const sendAlert = makeFakeSendAlert();

    await maybeAlert(sql, redis, logger, 'whatsapp', 'marketing', {
      allowed: true,
      spent_usd: 999,
      cap_usd: null,
      pct: 0,
    }, sendAlert);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('sends to each notify_to(messaging) recipient with kind=notification, critical=true and a monthly client_ref', async () => {
    const sql = makeFakeAlertSql(['ops@palmadev.test', 'billing@palmadev.test'], 'alerts@palmadev.test');
    const redis = makeFakeRedis();
    const logger = makeFakeLogger();
    const sendAlert = makeFakeSendAlert();

    await maybeAlert(sql, redis, logger, 'whatsapp', 'marketing', RESULT_80PCT, sendAlert);

    expect(sendAlert).toHaveBeenCalledTimes(2);
    const calls = sendAlert.mock.calls.map((c) => c[0]);
    expect(calls[0].to).toBe('ops@palmadev.test');
    expect(calls[1].to).toBe('billing@palmadev.test');
    for (const call of calls) {
      expect(call.from).toBe('Alertas PalmaDev <alerts@palmadev.test>');
      expect(call.subject).toContain('85%');
      expect(call.clientRef).toMatch(/^budget-alert-\d{6}-whatsapp-marketing-/);
    }
  });

  it('does not send when bot.notify_to(messaging) returns no recipients', async () => {
    const sql = makeFakeAlertSql([], 'alerts@palmadev.test');
    const redis = makeFakeRedis();
    const logger = makeFakeLogger();
    const sendAlert = makeFakeSendAlert();

    await maybeAlert(sql, redis, logger, 'whatsapp', 'marketing', RESULT_80PCT, sendAlert);

    expect(sendAlert).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('does not send when email_from is empty, and warns explicitly', async () => {
    const sql = makeFakeAlertSql(['ops@palmadev.test'], null);
    const redis = makeFakeRedis();
    const logger = makeFakeLogger();
    const sendAlert = makeFakeSendAlert();

    await maybeAlert(sql, redis, logger, 'whatsapp', 'marketing', RESULT_80PCT, sendAlert);

    expect(sendAlert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('email_from'),
    );
  });

  it('does not propagate a sendAlert failure to the caller, and logs the rest of the recipients', async () => {
    const sql = makeFakeAlertSql(['ops@palmadev.test', 'billing@palmadev.test'], 'alerts@palmadev.test');
    const redis = makeFakeRedis();
    const logger = makeFakeLogger();
    const sendAlert = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ status: 'sent' });

    await expect(
      maybeAlert(sql, redis, logger, 'whatsapp', 'marketing', RESULT_80PCT, sendAlert),
    ).resolves.toBeUndefined();

    expect(sendAlert).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it('logs once at >=80% and is deduped via Redis SETNX for the rest of the month (no second send)', async () => {
    const sql = makeFakeAlertSql(['ops@palmadev.test'], 'alerts@palmadev.test');
    const redis = makeFakeRedis();
    const logger = makeFakeLogger();
    const sendAlert = makeFakeSendAlert();

    await maybeAlert(sql, redis, logger, 'whatsapp', 'marketing', RESULT_80PCT, sendAlert);
    await maybeAlert(sql, redis, logger, 'whatsapp', 'marketing', RESULT_80PCT, sendAlert);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });
});
