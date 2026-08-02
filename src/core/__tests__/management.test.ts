/**
 * F3 — core/management. Fake sql (sequential responses) + fake Graph adapter
 * + fake email sender: no real Meta/Resend/PG ever touched. The auto-pause
 * flow is the critical absorbed behavior (was the n8n template-sync cron).
 */
import { describe, it, expect, vi } from 'vitest';
import type { SqlClient } from '../../lib/postgres.js';
import type { Logger } from '../../lib/logger.js';
import type { GraphManagement } from '../../providers/whatsapp-management.js';
import type { ProviderSendResult } from '../../providers/types.js';
import {
  extractBodyVariables,
  validateCreateTemplateInput,
  endpointStatusFromQuality,
  parseMessagingTier,
  syncTemplates,
  deleteWaTemplate,
  createWaTemplate,
  type ManagementDeps,
} from '../management.js';

function makeFakeSql(responses: unknown[][]): { sql: SqlClient; calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  const fn = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    calls.push(strings.join('?').replace(/\s+/g, ' ').trim());
    const r = responses[i] ?? [];
    i += 1;
    return Promise.resolve(r);
  }) as unknown as SqlClient;
  return { sql: fn, calls };
}

function makeFakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

const okSend: ProviderSendResult = { ok: true, message_id: 'resend-1', http_status: 200 };

function makeDeps(overrides: {
  sqlResponses?: unknown[][];
  graph?: Partial<GraphManagement>;
  sendEmail?: (input: unknown) => Promise<ProviderSendResult>;
}): { deps: ManagementDeps; calls: string[]; sendEmail: ReturnType<typeof vi.fn> } {
  const { sql, calls } = makeFakeSql(overrides.sqlResponses ?? []);
  const sendEmail = vi.fn(overrides.sendEmail ?? (async () => okSend));
  const graph: GraphManagement = {
    fetchTemplates: vi.fn(async () => ({ ok: true as const, templates: [] })),
    createTemplate: vi.fn(async () => ({ ok: true as const, id: 'meta-1', status: 'PENDING' })),
    deleteTemplateByName: vi.fn(async () => ({ ok: true as const })),
    fetchPhoneNumbers: vi.fn(async () => ({ ok: true as const, phones: [] })),
    fetchPhoneQuality: vi.fn(async () => ({ ok: true as const, quality_rating: 'GREEN' })),
    ...overrides.graph,
  } as GraphManagement;
  return {
    deps: {
      sql,
      logger: makeFakeLogger(),
      graph,
      wabaId: 'waba-global',
      cockpitUrl: 'https://cockpit.example.com',
      sendEmail: sendEmail as unknown as ManagementDeps['sendEmail'],
    },
    calls,
    sendEmail,
  };
}

describe('pure helpers', () => {
  it('extractBodyVariables dedupes numbered placeholders', () => {
    expect(extractBodyVariables('Hola {{1}}, {{2}} y de nuevo {{1}}')).toEqual(['{{1}}', '{{2}}']);
    expect(extractBodyVariables('sin variables')).toEqual([]);
  });

  it('endpointStatusFromQuality maps quality → status (NCS 14e criteria)', () => {
    expect(endpointStatusFromQuality('GREEN')).toEqual({ quality: 'green', status: 'active' });
    expect(endpointStatusFromQuality('yellow')).toEqual({ quality: 'yellow', status: 'active' });
    expect(endpointStatusFromQuality('RED')).toEqual({ quality: 'red', status: 'suspended' });
    expect(endpointStatusFromQuality(undefined)).toEqual({ quality: 'unknown', status: 'warming' });
  });

  it('parseMessagingTier extracts the numeric tier', () => {
    expect(parseMessagingTier('TIER_1K')).toBe(1);
    expect(parseMessagingTier('TIER_10K')).toBe(10);
    expect(parseMessagingTier(undefined)).toBeNull();
    expect(parseMessagingTier('TIER_UNKNOWN')).toBeNull();
  });

  it('validateCreateTemplateInput rejects bad names, categories and missing examples', () => {
    const base = { name: 'promo_agosto', language: 'es_AR', category: 'utility', body_text: 'Hola' };
    expect(validateCreateTemplateInput({ ...base, name: 'Promo Agosto' }).ok).toBe(false);
    expect(validateCreateTemplateInput({ ...base, category: 'spam' }).ok).toBe(false);
    expect(validateCreateTemplateInput({ ...base, body_text: '' }).ok).toBe(false);
    expect(validateCreateTemplateInput({ ...base, body_text: 'Hola {{1}}' }).ok).toBe(false);
    const withExamples = validateCreateTemplateInput({
      ...base,
      body_text: 'Hola {{1}}',
      body_example_values: ['Carlos'],
      footer_text: 'Baja: respondé BAJA',
    });
    expect(withExamples.ok).toBe(true);
    if (withExamples.ok) {
      expect(withExamples.category).toBe('UTILITY');
      expect(withExamples.components.map((c) => c.type)).toEqual(['BODY', 'FOOTER']);
      expect(withExamples.components[0].example).toEqual({ body_text: [['Carlos']] });
    }
  });
});

describe('syncTemplates', () => {
  const approvedTemplate = {
    id: 'ext-1',
    name: 'bienvenida',
    language: 'es',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hola {{1}}' }],
  };

  it('upserts fetched templates and reports counters', async () => {
    const { deps } = makeDeps({
      sqlResponses: [
        [], // outbound_endpoints WABAs
        [], // prev lookup
        [{ id: 'tpl-1', inserted: true }], // upsert
      ],
      graph: {
        fetchTemplates: vi.fn(async () => ({ ok: true as const, templates: [approvedTemplate] })),
      },
    });
    const r = await syncTemplates(deps);
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.total_fetched).toBe(1);
    expect(r.campaigns_paused).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('auto-pauses sending campaigns when a template lands rejected, audits and emails the operator', async () => {
    const rejected = {
      ...approvedTemplate,
      status: 'REJECTED',
      rejected_reason: 'INVALID_FORMAT',
    };
    const { deps, sendEmail, calls } = makeDeps({
      sqlResponses: [
        [], // outbound_endpoints WABAs
        [{ id: 'tpl-1', status: 'approved' }], // prev lookup
        [{ id: 'tpl-1', inserted: false }], // upsert
        [{ id: 'camp-1' }, { id: 'camp-2' }], // auto-pause RETURNING
        [], // audit insert camp-1
        [], // audit insert camp-2
        [{ admin_email: 'admin@example.com' }], // bot.config branding
      ],
      graph: {
        fetchTemplates: vi.fn(async () => ({ ok: true as const, templates: [rejected] })),
      },
    });
    const r = await syncTemplates(deps);
    expect(r.campaigns_paused).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const emailInput = sendEmail.mock.calls[0][0] as { to: string; subject: string };
    expect(emailInput.to).toBe('admin@example.com');
    expect(emailInput.subject).toContain('2 campaña(s) pausada(s)');
    expect(calls.some((c) => c.includes('campaign_launches_audit'))).toBe(true);
  });

  it('skips the alert (with a warning) when admin_email is not configured', async () => {
    const rejected = { ...approvedTemplate, status: 'REJECTED' };
    const { deps, sendEmail } = makeDeps({
      sqlResponses: [
        [],
        [{ id: 'tpl-1', status: 'approved' }],
        [{ id: 'tpl-1', inserted: false }],
        [{ id: 'camp-1' }],
        [], // audit
        [{ admin_email: null }], // branding without admin_email
      ],
      graph: {
        fetchTemplates: vi.fn(async () => ({ ok: true as const, templates: [rejected] })),
      },
    });
    const r = await syncTemplates(deps);
    expect(r.campaigns_paused).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('collects per-WABA fetch errors without aborting the sync', async () => {
    const { deps } = makeDeps({
      sqlResponses: [[]],
      graph: {
        fetchTemplates: vi.fn(async () => ({ ok: false as const, error: 'HTTP 401: bad token' })),
      },
    });
    const r = await syncTemplates(deps);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual(['WABA waba-global: HTTP 401: bad token']);
    expect(r.total_fetched).toBe(0);
  });
});

describe('createWaTemplate', () => {
  it('returns the validation message without hitting Meta when input is invalid', async () => {
    const { deps } = makeDeps({});
    const r = await createWaTemplate(deps, {
      name: 'Bad Name',
      language: 'es',
      category: 'utility',
      body_text: 'Hola',
    });
    expect(r.ok).toBe(false);
    expect(deps.graph.createTemplate).not.toHaveBeenCalled();
  });

  it('creates in Meta then mirrors locally', async () => {
    const { deps } = makeDeps({ sqlResponses: [[{ id: 'local-1' }]] });
    const r = await createWaTemplate(deps, {
      name: 'promo_agosto',
      language: 'es_AR',
      category: 'marketing',
      body_text: 'Hola sin variables',
    });
    expect(r.ok).toBe(true);
    expect(r.meta_id).toBe('meta-1');
    expect(r.local_id).toBe('local-1');
    expect(deps.graph.createTemplate).toHaveBeenCalledWith(
      'waba-global',
      expect.objectContaining({ name: 'promo_agosto', category: 'MARKETING' }),
    );
  });
});

describe('deleteWaTemplate', () => {
  it('deletes in Meta (template WABA wins over global) and then locally', async () => {
    const { deps } = makeDeps({
      sqlResponses: [
        [{ name: 'bienvenida', waba_id: 'waba-otro' }],
        [{ id: 'tpl-1' }], // local delete RETURNING
      ],
    });
    const r = await deleteWaTemplate(deps, 'tpl-1');
    expect(r).toEqual({ ok: true, deleted: true });
    expect(deps.graph.deleteTemplateByName).toHaveBeenCalledWith('waba-otro', 'bienvenida');
  });

  it('keeps the local delete with a warning on Meta #100 (foreign WABA)', async () => {
    const { deps } = makeDeps({
      sqlResponses: [[{ name: 'bienvenida', waba_id: null }], [{ id: 'tpl-1' }]],
      graph: {
        deleteTemplateByName: vi.fn(async () => ({
          ok: false as const,
          http_status: 400,
          error: 'HTTP 400: (#100) Need permission',
        })),
      },
    });
    const r = await deleteWaTemplate(deps, 'tpl-1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.deleted).toBe(true);
      expect(r.meta_warning).toContain('WhatsApp Manager');
    }
  });

  it('surfaces other Meta errors without touching the local row', async () => {
    const { deps, calls } = makeDeps({
      sqlResponses: [[{ name: 'bienvenida', waba_id: null }]],
      graph: {
        deleteTemplateByName: vi.fn(async () => ({
          ok: false as const,
          http_status: 500,
          error: 'HTTP 500: boom',
        })),
      },
    });
    const r = await deleteWaTemplate(deps, 'tpl-1');
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.startsWith('DELETE FROM'))).toBe(false);
  });

  it('returns deleted:false for an unknown id', async () => {
    const { deps } = makeDeps({ sqlResponses: [[]] });
    const r = await deleteWaTemplate(deps, 'nope');
    expect(r).toEqual({ ok: true, deleted: false });
  });
});
