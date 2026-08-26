import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── La cadena de resolución del remitente email (F7.3 + F7.4) ───────────────
//
// pin → template.body.from → auto-pick endpoint → config['campaigns'].email_from
// → env.CAMPAIGNS_DEFAULT_FROM_EMAIL → terminal `email_from_missing`.
//
// Lo que se fija acá es el ORDEN (quién le gana a quién) y el accounting:
// `endpointRowId` sólo se setea cuando un endpoint fue la identidad usada —
// es lo que hace que el worker bumpee `sent_today` parejo con WA/FB/IG.

vi.mock('../../env.js', () => ({
  env: {
    DOMAIN: 'test.local',
    CAMPAIGNS_DEFAULT_FROM_EMAIL: undefined as string | undefined,
    CAMPAIGNS_UNSUBSCRIBE_BASE_URL: 'https://test.local/unsubscribe',
  },
}));

import { env } from '../../env.js';
import { prepareEmail, type EmailPrepareDeps } from '../email.js';
import type { DeliveryContext } from '../../dispatch/audience-resolver.js';

const FAKE_TX = {} as never;

function makeCtx(overrides?: {
  templateFrom?: string;
  outboundEndpointId?: string | null;
}): DeliveryContext {
  return {
    delivery: {
      id: 1,
      queued_at: new Date('2026-08-25T00:00:00Z'),
      campaign_id: 'c0000000-0000-0000-0000-000000000001',
      audience_contact_id: 'a0000000-0000-0000-0000-000000000001',
      channel: 'email',
      client_ref: 'ref-1',
      template_variables: null,
      status: 'pending',
      retry_count: 0,
      variant_label: null,
      drip_step: null,
      drip_template_id: null,
    },
    contact: {
      id: 'a0000000-0000-0000-0000-000000000001',
      phone: null,
      email: 'dest@example.com',
      display_name: 'Dest',
      unsubscribed_at: null,
      consent_status: 'confirmed',
      meta: {},
      language: null,
    },
    template: {
      id: 't0000000-0000-0000-0000-000000000001',
      name: 'tpl',
      language: 'es',
      category: 'utility',
      body_format: 'mjml_html',
      body: {
        subject: 'Hola {{name}}',
        html: '<html><body><p>Hola {{name}}</p></body></html>',
        ...(overrides?.templateFrom ? { from: overrides.templateFrom } : {}),
      },
      variables: [],
    },
    campaign: {
      id: 'c0000000-0000-0000-0000-000000000001',
      name: 'camp',
      status: 'sending',
      rate_limit_mps: 10,
      template_variable_bindings: {},
      paused_at: null,
      pause_reason: null,
      ai_personalization_enabled: false,
      ai_personalization_config: null,
      language_routing: null,
      outbound_endpoint_id: overrides?.outboundEndpointId ?? null,
    },
  };
}

function makeDeps(overrides?: Partial<EmailPrepareDeps>): EmailPrepareDeps {
  return {
    resolvePinnedEmailEndpoint: vi.fn(async () => null),
    pickEmailEndpoint: vi.fn(async () => null),
    readCampaignsEmailFrom: vi.fn(async () => null),
    ...overrides,
  };
}

function readyFrom(out: Awaited<ReturnType<typeof prepareEmail>>): {
  from: string;
  endpointRowId: string | null;
} {
  expect(out.kind).toBe('ready');
  if (out.kind !== 'ready') throw new Error('unreachable');
  return {
    from: (out.sendInput as { from: string }).from,
    endpointRowId: out.endpointRowId,
  };
}

beforeEach(() => {
  (env as { CAMPAIGNS_DEFAULT_FROM_EMAIL?: string }).CAMPAIGNS_DEFAULT_FROM_EMAIL = undefined;
});

describe('prepareEmail — cadena de resolución del remitente', () => {
  it('el endpoint pinneado le gana a todo (elección explícita del operador)', async () => {
    const deps = makeDeps({
      resolvePinnedEmailEndpoint: vi.fn(async () => ({
        id: 'row-pin',
        endpoint_id: 'Ventas <ventas@cliente.com>',
      })),
    });
    const out = await prepareEmail(
      FAKE_TX,
      makeCtx({ templateFrom: 'tpl@cliente.com', outboundEndpointId: 'row-pin' }),
      {},
      deps,
    );
    const r = readyFrom(out);
    expect(r.from).toBe('Ventas <ventas@cliente.com>');
    expect(r.endpointRowId).toBe('row-pin'); // sent_today se contabiliza en el pin
    expect(deps.pickEmailEndpoint).not.toHaveBeenCalled();
  });

  it('pin inutilizable (inactivo/borrado) → cae al template, con warning y sin romper', async () => {
    const deps = makeDeps(); // resolvePinned devuelve null
    const out = await prepareEmail(
      FAKE_TX,
      makeCtx({ templateFrom: 'tpl@cliente.com', outboundEndpointId: 'row-gone' }),
      {},
      deps,
    );
    const r = readyFrom(out);
    expect(r.from).toBe('tpl@cliente.com');
    expect(r.endpointRowId).toBeNull(); // el from no salió de una fila: nada que contar
  });

  it('template.body.from le gana al auto-pick (override por template, semántica F5)', async () => {
    const deps = makeDeps({
      pickEmailEndpoint: vi.fn(async () => ({ id: 'row-auto', endpoint_id: 'auto@cliente.com' })),
    });
    const out = await prepareEmail(FAKE_TX, makeCtx({ templateFrom: 'tpl@cliente.com' }), {}, deps);
    const r = readyFrom(out);
    expect(r.from).toBe('tpl@cliente.com');
    expect(deps.pickEmailEndpoint).not.toHaveBeenCalled();
  });

  it('sin pin ni template → auto-pick del endpoint (el default del modelo F7.4)', async () => {
    const deps = makeDeps({
      pickEmailEndpoint: vi.fn(async () => ({ id: 'row-auto', endpoint_id: 'auto@cliente.com' })),
    });
    const out = await prepareEmail(FAKE_TX, makeCtx(), {}, deps);
    const r = readyFrom(out);
    expect(r.from).toBe('auto@cliente.com');
    expect(r.endpointRowId).toBe('row-auto');
  });

  it("sin endpoints → bot.config['campaigns'].email_from (F7.3)", async () => {
    const deps = makeDeps({
      readCampaignsEmailFrom: vi.fn(async () => 'config@cliente.com'),
    });
    const out = await prepareEmail(FAKE_TX, makeCtx(), {}, deps);
    const r = readyFrom(out);
    expect(r.from).toBe('config@cliente.com');
    expect(r.endpointRowId).toBeNull();
  });

  it('último fallback: env.CAMPAIGNS_DEFAULT_FROM_EMAIL (transitorio, expand/contract)', async () => {
    (env as { CAMPAIGNS_DEFAULT_FROM_EMAIL?: string }).CAMPAIGNS_DEFAULT_FROM_EMAIL =
      'env@cliente.com';
    const out = await prepareEmail(FAKE_TX, makeCtx(), {}, makeDeps());
    const r = readyFrom(out);
    expect(r.from).toBe('env@cliente.com');
    expect(r.endpointRowId).toBeNull();
  });

  it('sin remitente por NINGUNA vía → terminal email_from_missing, sin retry', async () => {
    const out = await prepareEmail(FAKE_TX, makeCtx(), {}, makeDeps());
    expect(out.kind).toBe('terminal');
    if (out.kind !== 'terminal') throw new Error('unreachable');
    expect(out.error_code).toBe('email_from_missing');
    expect(out.failure_reason).toBe('payload_invalid');
  });

  it('contacto sin email sigue siendo terminal ANTES de resolver remitente', async () => {
    const ctx = makeCtx();
    ctx.contact.email = null;
    const deps = makeDeps();
    const out = await prepareEmail(FAKE_TX, ctx, {}, deps);
    expect(out.kind).toBe('terminal');
    if (out.kind !== 'terminal') throw new Error('unreachable');
    expect(out.error_code).toBe('no_email');
    expect(deps.resolvePinnedEmailEndpoint).not.toHaveBeenCalled();
  });
});
