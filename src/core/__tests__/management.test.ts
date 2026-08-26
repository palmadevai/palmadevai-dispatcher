/**
 * F3 — core/management. Fake sql (sequential responses) + fake Graph adapter
 * + fake `NotifyDeps`: no real Meta/Resend/PG ever touched. The auto-pause
 * flow is the critical absorbed behavior (was the n8n template-sync cron).
 *
 * F7.5 — el aviso ya no se arma acá, así que estos tests dejaron de mirar el
 * mail y miran el LLAMADO: qué feature, qué aviso, con qué `origin_ref`. El
 * destinatario, el remitente y el ref completo son responsabilidad de
 * `core/notify.ts` y se testean ahí (`notify.test.ts`) — duplicar esas
 * aserciones acá volvería a atar este archivo a una mecánica que ya no tiene.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SqlClient } from '../../lib/postgres.js';
import type { Logger } from '../../lib/logger.js';
import type { GraphManagement } from '../../providers/whatsapp-management.js';
import type { NotifyDeps } from '../notify.js';

// `resolveWabaId()` en management.ts llama a `readChannelWhatsAppConfig()`
// (DB real vía lib/postgres.js) — se mockea acá, no la DB, mismo criterio que
// provider-cutover.test.ts para `resolveDefaultFrom`. Default: 'waba-global'
// por 'env' — preserva el comportamiento previo de los tests de abajo, que
// asumían un `deps.wabaId` fijo.
vi.mock('../../lib/providers.js', () => ({
  readChannelWhatsAppConfig: vi.fn(async () => ({
    wabaId: 'waba-global',
    defaultPhoneNumberId: null,
    source: 'env' as const,
  })),
}));

import { readChannelWhatsAppConfig } from '../../lib/providers.js';
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

function makeFakeSql(responses: unknown[][]): {
  sql: SqlClient;
  calls: string[];
  values: unknown[][];
} {
  let i = 0;
  const calls: string[] = [];
  const values: unknown[][] = [];
  const fn = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(strings.join('?').replace(/\s+/g, ' ').trim());
    values.push(vals);
    const r = responses[i] ?? [];
    i += 1;
    return Promise.resolve(r);
  }) as unknown as SqlClient;
  return { sql: fn, calls, values };
}

function makeFakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/**
 * `NotifyDeps` de test. Su `sql` responde, en el orden en que `notify()`
 * pregunta: (1) la declaración del aviso en `config.features.bom`, (2) el
 * branding (remitente + nombre visible), (3) `bot.notify_to(feature)`.
 */
function makeFakeNotify(opts: {
  declared?: boolean;
  emailFrom?: string;
  brandName?: string;
  to?: string[];
} = {}): { notify: NotifyDeps; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => ({ status: 'sent' as const, message_id: 'resend-1' }));
  const { sql } = makeFakeSql([
    [{ declared: opts.declared ?? true }],
    [{ email_from: opts.emailFrom ?? 'noreply@cliente.test', name: opts.brandName ?? 'Cliente SA' }],
    [{ to: opts.to ?? ['admin@example.com'] }],
  ]);
  return {
    notify: { sql, logger: makeFakeLogger(), send } as unknown as NotifyDeps,
    send,
  };
}

function makeDeps(overrides: {
  sqlResponses?: unknown[][];
  graph?: Partial<GraphManagement>;
  notify?: Parameters<typeof makeFakeNotify>[0];
}): {
  deps: ManagementDeps;
  calls: string[];
  values: unknown[][];
  send: ReturnType<typeof vi.fn>;
} {
  const { sql, calls, values } = makeFakeSql(overrides.sqlResponses ?? []);
  const { notify, send } = makeFakeNotify(overrides.notify);
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
      cockpitUrl: 'https://cockpit.example.com',
      notify,
    },
    calls,
    values,
    send,
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

  it('auto-pauses sending campaigns when a template lands rejected, audits and notifies the operator', async () => {
    const rejected = {
      ...approvedTemplate,
      status: 'REJECTED',
      rejected_reason: 'INVALID_FORMAT',
    };
    const { deps, send, calls } = makeDeps({
      sqlResponses: [
        [], // outbound_endpoints WABAs
        [{ id: 'tpl-1', status: 'approved' }], // prev lookup
        [{ id: 'tpl-1', inserted: false }], // upsert
        [{ id: 'camp-1' }, { id: 'camp-2' }], // auto-pause RETURNING
        [], // audit insert camp-1
        [], // audit insert camp-2
      ],
      graph: {
        fetchTemplates: vi.fn(async () => ({ ok: true as const, templates: [rejected] })),
      },
    });
    const r = await syncTemplates(deps);
    expect(r.campaigns_paused).toBe(2);

    // Un solo destinatario en el fake → un solo envío. Lo que este test cuida
    // NO es el fan-out (eso es de notify.ts) sino que el aviso salga con la
    // identidad correcta: la feature dueña y el id declarado en su manifest.
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as {
      to: string;
      from: string;
      content: { subject: string };
      context: { feature: string; client_ref: string; critical?: boolean };
    };
    expect(msg.to).toBe('admin@example.com');
    expect(msg.content.subject).toContain('2 campaña(s) pausada(s)');
    // El remitente sale del branding del CLIENTE. Hasta T4.5 era
    // `onboarding@resend.dev` HARDCODEADO (el sandbox de Resend, que entrega al
    // dueño de la cuenta con un 200 limpio) y hasta F7.5 el nombre visible era
    // «Alertas PalmaDev», el literal del LABORATORIO firmando los avisos de
    // cada fork desde su propio dominio.
    expect(msg.from).toBe('Cliente SA <noreply@cliente.test>');
    expect(msg.from).not.toContain('resend.dev');
    expect(msg.from).not.toContain('PalmaDev');
    expect(msg.context.feature).toBe('campaigns');
    // El ref lo compone el servicio a partir del aviso declarado + el template
    // que lo disparó. El destinatario NO está adentro: la idempotencia es
    // (client_ref, destino) y pegarlo acá rompía justo el dedup que importa.
    expect(msg.context.client_ref).toBe('notify-campaigns-template-auto-pause-tpl-1');
    expect(msg.context.client_ref).not.toContain('admin@example.com');
    expect(calls.some((c) => c.includes('campaign_launches_audit'))).toBe(true);
  });

  // El aviso tiene que estar declarado en el manifest de la feature. No
  // declarado = no hay dónde configurar quién lo recibe, así que mandarlo es
  // prometer una configuración que no existe.
  it('no manda el aviso si la feature no lo declaró en su manifest', async () => {
    const rejected = { ...approvedTemplate, status: 'REJECTED' };
    const { deps, send } = makeDeps({
      sqlResponses: [
        [],
        [{ id: 'tpl-1', status: 'approved' }],
        [{ id: 'tpl-1', inserted: false }],
        [{ id: 'camp-1' }],
        [], // audit
      ],
      graph: {
        fetchTemplates: vi.fn(async () => ({ ok: true as const, templates: [rejected] })),
      },
      notify: { declared: false },
    });
    const r = await syncTemplates(deps);
    expect(r.campaigns_paused).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  // Sin remitente NO se manda, aunque haya destinatarios: mandar desde un
  // remitente equivocado entrega al lugar equivocado con un 200 limpio.
  it('no manda si falta branding.email_from, aunque haya destinatarios', async () => {
    const rejected = { ...approvedTemplate, status: 'REJECTED' };
    const { deps, send } = makeDeps({
      sqlResponses: [
        [],
        [{ id: 'tpl-1', status: 'approved' }],
        [{ id: 'tpl-1', inserted: false }],
        [{ id: 'camp-1' }],
        [], // audit
      ],
      graph: {
        fetchTemplates: vi.fn(async () => ({ ok: true as const, templates: [rejected] })),
      },
      notify: { emailFrom: '' },
    });
    const r = await syncTemplates(deps);
    expect(r.campaigns_paused).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips the alert when notify_to comes back empty (aviso apagado)', async () => {
    const rejected = { ...approvedTemplate, status: 'REJECTED' };
    const { deps, send } = makeDeps({
      sqlResponses: [
        [],
        [{ id: 'tpl-1', status: 'approved' }],
        [{ id: 'tpl-1', inserted: false }],
        [{ id: 'camp-1' }],
        [], // audit
      ],
      graph: {
        fetchTemplates: vi.fn(async () => ({ ok: true as const, templates: [rejected] })),
      },
      notify: { to: [] },
    });
    const r = await syncTemplates(deps);
    expect(r.campaigns_paused).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('persists language RAW (es_AR) — lowercasing it duplicated rows against the UNIQUE', async () => {
    const { deps, values } = makeDeps({
      sqlResponses: [
        [], // outbound_endpoints WABAs
        [], // prev lookup
        [{ id: 'tpl-1', inserted: true }], // upsert
      ],
      graph: {
        fetchTemplates: vi.fn(async () => ({
          ok: true as const,
          templates: [{ ...approvedTemplate, language: 'es_AR' }],
        })),
      },
    });
    await syncTemplates(deps);
    // values[1] = prev lookup (name, language); values[2] = upsert params.
    expect(values[1]).toContain('es_AR');
    expect(values[2]).toContain('es_AR');
    expect(values.flat()).not.toContain('es_ar');
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

describe('WABA sin configurar (ni DB ni env) — el error nombra las dos fuentes', () => {
  it('syncTemplates falla nombrando bot.config y la env', async () => {
    vi.mocked(readChannelWhatsAppConfig).mockResolvedValueOnce({
      wabaId: null,
      defaultPhoneNumberId: null,
      source: 'none',
    });
    const { deps } = makeDeps({});
    const r = await syncTemplates(deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("bot.config['channel_whatsapp'].waba_id");
    expect(r.message).toContain('META_WA_WABA_ID');
  });

  it('createWaTemplate falla sin pegarle a Meta', async () => {
    vi.mocked(readChannelWhatsAppConfig).mockResolvedValueOnce({
      wabaId: null,
      defaultPhoneNumberId: null,
      source: 'none',
    });
    const { deps } = makeDeps({});
    const r = await createWaTemplate(deps, {
      name: 'promo_agosto',
      language: 'es',
      category: 'marketing',
      body_text: 'Hola sin variables',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('META_WA_WABA_ID');
    expect(deps.graph.createTemplate).not.toHaveBeenCalled();
  });
});
