/**
 * F4 — core/messaging-reads (Tier 1). Fake sql (sequential) + fake redis:
 * no PG/Redis real. `getMessagingCosts` reusa `checkBudget` — se resetean sus
 * caches entre tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { SqlClient } from '../../lib/postgres.js';
import type { Logger } from '../../lib/logger.js';
import { __resetBudgetCachesForTests } from '../budget.js';
import {
  listChannels,
  getChannelHealth,
  listTemplates,
  getTemplate,
  getDeliveryStatus,
  getMessagingCosts,
  type ReadDeps,
} from '../messaging-reads.js';

function makeDeps(sqlResponses: unknown[][], redisGets: Record<string, string> = {}): ReadDeps {
  let i = 0;
  const sql = ((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const r = sqlResponses[i] ?? [];
    i += 1;
    return Promise.resolve(r);
  }) as unknown as SqlClient;
  const redis = {
    get: vi.fn(async (key: string) => redisGets[key] ?? null),
  } as unknown as Redis;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  return { sql, redis, logger };
}

beforeEach(() => {
  __resetBudgetCachesForTests();
});

describe('listChannels', () => {
  it('aggregates endpoint counts per channel over the known provider set', async () => {
    const deps = makeDeps([
      [
        { channel: 'whatsapp', status: 'active', cnt: '2' },
        { channel: 'whatsapp', status: 'warming', cnt: '1' },
      ],
    ]);
    const r = await listChannels(deps);
    const wa = r.channels.find((c) => c.channel === 'whatsapp');
    expect(wa).toMatchObject({
      provider_implemented: true,
      endpoints_total: 3,
      endpoints_active: 2,
      endpoints_warming: 1,
    });
    expect(r.channels.map((c) => c.channel)).toEqual(
      expect.arrayContaining(['whatsapp', 'email', 'facebook', 'instagram']),
    );
  });

  it('survives a missing outbound_endpoints table (providers only)', async () => {
    const deps = makeDeps([]);
    (deps.sql as unknown as { mockRejected?: boolean }).mockRejected = true;
    const failingSql = (() => Promise.reject(new Error('relation does not exist'))) as unknown as SqlClient;
    const r = await listChannels({ ...deps, sql: failingSql });
    expect(r.channels).toHaveLength(4);
    expect(r.channels.every((c) => c.endpoints_total === 0)).toBe(true);
  });
});

describe('getChannelHealth', () => {
  it('returns current state plus last snapshots per phone', async () => {
    const deps = makeDeps([
      [
        {
          id: 'p1',
          display_phone: '+54 9 11 0000-0000',
          quality_rating: 'green',
          tier_current: 250,
          status: 'active',
          last_quality_check_at: new Date('2026-08-02T19:41:31Z'),
        },
      ],
      [{ snapshot_at: '2026-08-01', quality_rating: 'green', messaging_limit_tier: 250 }],
    ]);
    const r = await getChannelHealth(deps);
    expect(r.phones).toHaveLength(1);
    expect(r.phones[0]).toMatchObject({
      quality_rating: 'green',
      messaging_limit_tier: 250,
      status: 'active',
    });
    expect(r.phones[0].history_7d).toHaveLength(1);
  });
});

describe('listTemplates / getTemplate', () => {
  it('lists templates with ISO last_synced_at', async () => {
    const deps = makeDeps([
      [
        {
          name: 'bienvenida',
          channel: 'whatsapp',
          language: 'es_AR',
          category: 'utility',
          status: 'approved',
          waba_id: 'w1',
          rejection_reason: null,
          last_synced_at: new Date('2026-08-02T00:00:00Z'),
        },
      ],
    ]);
    const r = await listTemplates(deps, {});
    expect(r.templates[0].last_synced_at).toBe('2026-08-02T00:00:00.000Z');
  });

  it('getTemplate reports found:false for unknown names', async () => {
    const deps = makeDeps([[]]);
    const r = await getTemplate(deps, { name: 'nope' });
    expect(r).toEqual({ found: false });
  });
});

describe('getDeliveryStatus', () => {
  it('requires at least one identifier', async () => {
    const deps = makeDeps([]);
    const r = await getDeliveryStatus(deps, {});
    expect(r).toEqual({ found: false });
  });

  it('maps the delivery row with ISO timestamps and neutral failure_reason', async () => {
    const deps = makeDeps([
      [
        {
          id: 'd1',
          client_ref: 'ref-1',
          campaign_id: 'c1',
          campaign_name: 'Campaña test',
          channel: 'whatsapp',
          status: 'failed',
          queued_at: new Date('2026-08-02T10:00:00Z'),
          sent_at: null,
          delivered_at: null,
          read_at: null,
          failed_at: new Date('2026-08-02T10:00:05Z'),
          error_code: '131047',
          error_message: 'Re-engagement message',
          failure_reason: 'provider_freq_cap',
          retry_count: 0,
        },
      ],
    ]);
    const r = await getDeliveryStatus(deps, { client_ref: 'ref-1' });
    expect(r.found).toBe(true);
    expect(r.delivery).toMatchObject({
      status: 'failed',
      failure_reason: 'provider_freq_cap',
      campaign_name: 'Campaña test',
      queued_at: '2026-08-02T10:00:00.000Z',
    });
  });
});

describe('getMessagingCosts', () => {
  it('reports one row per configured channel × category pair using checkBudget', async () => {
    const budgetCfg = { whatsapp: { marketing: 5, service: 5 } };
    const deps = makeDeps([
      [{ value: budgetCfg }], // pairs desde bot.config
      // checkBudget: rate card, budget config, db spend (por canal, cacheado)
      [{ channel: 'whatsapp', category: 'marketing', country: 'AR', usd_per_message: '0.0618' }],
      [{ value: budgetCfg }],
      [],
    ]);
    const r = await getMessagingCosts(deps);
    expect(r.month).toMatch(/^\d{4}-\d{2}$/);
    expect(r.costs).toHaveLength(2);
    expect(r.costs[0]).toMatchObject({ channel: 'whatsapp', category: 'marketing', cap_usd: 5 });
  });

  it('falls back to the standard pairs when config is missing', async () => {
    const deps = makeDeps([[], [], [], []]);
    const r = await getMessagingCosts(deps);
    expect(r.costs.map((c) => `${c.channel}/${c.category}`)).toEqual(
      expect.arrayContaining(['whatsapp/marketing', 'whatsapp/service', 'email/service']),
    );
  });
});
