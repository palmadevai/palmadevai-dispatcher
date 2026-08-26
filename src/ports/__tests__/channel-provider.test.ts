/**
 * H1.1 — minimal-but-real coverage of the `ChannelProvider` port + adapters.
 * Not a full worker suite (that's a follow-up test-author PR) — this covers:
 *   - registry resolution (implemented channels + ChannelNotImplementedError)
 *   - prepare() terminal outcomes (missing destination) per channel
 *   - prepare() ready outcome shape for WhatsApp (via injected deps, no real tx)
 *   - WA terminalOverride for 131049
 */
import { describe, it, expect, vi } from 'vitest';
import type { TransactionSql } from 'postgres';
import { getProviderForChannel } from '../channel-provider.js';
import { ChannelNotImplementedError } from '../../providers/index.js';
import { prepareWhatsApp, whatsAppTerminalOverride, type WhatsAppSendInput } from '../../providers/whatsapp.js';
import { prepareEmail, type EmailSendInput } from '../../providers/email.js';
import { prepareFacebook } from '../../providers/facebook.js';
import { prepareInstagram } from '../../providers/instagram.js';
import type { DeliveryContext } from '../../dispatch/audience-resolver.js';
import type { ProviderSendResult } from '../../providers/types.js';

// tx is unused by every provider's prepare() in this suite once deps are
// injected (WA/FB/IG) or not needed at all (email) — a typed stub is enough.
const fakeTx = {} as TransactionSql;

function makeCtx(overrides: {
  channel?: string;
  phone?: string | null;
  email?: string | null;
  meta?: Record<string, unknown>;
  outboundEndpointId?: string | null;
  templateBody?: Record<string, unknown>;
} = {}): DeliveryContext {
  return {
    delivery: {
      id: 1,
      queued_at: new Date('2026-08-01T00:00:00Z'),
      campaign_id: 'campaign-1',
      audience_contact_id: 'contact-1',
      channel: overrides.channel ?? 'whatsapp',
      client_ref: 'client-ref-1',
      template_variables: null,
      status: 'pending',
      retry_count: 0,
      variant_label: null,
      drip_step: null,
      drip_template_id: null,
    },
    contact: {
      id: 'contact-1',
      phone: overrides.phone === undefined ? '+5491111111111' : overrides.phone,
      email: overrides.email === undefined ? 'jane@example.com' : overrides.email,
      display_name: 'Jane',
      unsubscribed_at: null,
      consent_status: 'granted',
      meta: overrides.meta ?? {},
      language: null,
    },
    template: {
      id: 'template-1',
      name: 'hello_template',
      language: 'es',
      category: 'MARKETING',
      body_format: 'plain_text',
      body: overrides.templateBody ?? { text: 'Hola {{name}}' },
      variables: [],
    },
    campaign: {
      id: 'campaign-1',
      name: 'Test campaign',
      status: 'sending',
      rate_limit_mps: 10,
      template_variable_bindings: {},
      paused_at: null,
      pause_reason: null,
      ai_personalization_enabled: false,
      ai_personalization_config: null,
      language_routing: null,
      outbound_endpoint_id: overrides.outboundEndpointId ?? null,
    },
  };
}

describe('getProviderForChannel', () => {
  it('resolves the correct provider per implemented channel', () => {
    expect(getProviderForChannel('whatsapp').channel).toBe('whatsapp');
    expect(getProviderForChannel('email').channel).toBe('email');
    expect(getProviderForChannel('facebook').channel).toBe('facebook');
    expect(getProviderForChannel('instagram').channel).toBe('instagram');
  });

  it('throws ChannelNotImplementedError for channels without a provider (sms)', () => {
    expect(() => getProviderForChannel('sms')).toThrow(ChannelNotImplementedError);
  });
});

describe('prepareWhatsApp', () => {
  it('returns a terminal outcome when the contact has no phone', async () => {
    const ctx = makeCtx({ phone: null });
    const outcome = await prepareWhatsApp(fakeTx, ctx, {});
    expect(outcome).toEqual({
      kind: 'terminal',
      error_code: 'no_phone',
      error_message: 'audience contact has no phone for whatsapp channel',
      failure_reason: 'phone_invalid',
    });
  });

  it('returns no_endpoint when no phone can be picked', async () => {
    const ctx = makeCtx();
    const outcome = await prepareWhatsApp(fakeTx, ctx, {}, {
      resolvePinnedWaEndpoint: vi.fn().mockResolvedValue(null),
      pickPhoneForContact: vi.fn().mockResolvedValue(null),
      resolveTemplateComponents: vi.fn().mockReturnValue([]),
    });
    expect(outcome).toEqual({ kind: 'no_endpoint', throwMessage: 'NoAvailablePhonesError' });
  });

  it('returns a ready outcome with a well-formed sendInput on the auto-pick path', async () => {
    const ctx = makeCtx();
    const pickPhoneForContact = vi.fn().mockResolvedValue({
      id: 'endpoint-1',
      phone_number_id: '1234567890',
      daily_cap_remaining: 100,
    });
    const resolveTemplateComponents = vi.fn().mockReturnValue([{ type: 'body', parameters: [] }]);
    const outcome = await prepareWhatsApp(fakeTx, ctx, {}, {
      resolvePinnedWaEndpoint: vi.fn(),
      pickPhoneForContact,
      resolveTemplateComponents,
    });
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error('unreachable');
    const sendInput = outcome.sendInput as WhatsAppSendInput;
    expect(sendInput.phone_number_id).toBe('1234567890');
    expect(sendInput.to).toBe('+5491111111111');
    expect(sendInput.template_name).toBe('hello_template');
    expect(sendInput.components).toEqual([{ type: 'body', parameters: [] }]);
    expect(sendInput.access_token).toBeUndefined();
    expect(outcome.endpointRowId).toBe('endpoint-1');
    expect(outcome.acceptedExtra).toEqual({ wa_phone_number_id: 'endpoint-1' });
    expect(outcome.errorLogFields).toEqual({ to_last4: '1111', phone_number_id: '1234567890' });
  });

  it('prefers the pinned endpoint over auto-pick when the campaign has one', async () => {
    const ctx = makeCtx({ outboundEndpointId: 'pinned-endpoint' });
    const resolvePinnedWaEndpoint = vi.fn().mockResolvedValue({
      id: 'pinned-endpoint',
      phone_number_id: '999',
      access_token: 'pinned-token',
    });
    const pickPhoneForContact = vi.fn();
    const outcome = await prepareWhatsApp(fakeTx, ctx, {}, {
      resolvePinnedWaEndpoint,
      pickPhoneForContact,
      resolveTemplateComponents: vi.fn().mockReturnValue([]),
    });
    expect(pickPhoneForContact).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error('unreachable');
    expect((outcome.sendInput as WhatsAppSendInput).access_token).toBe('pinned-token');
  });
});

describe('whatsAppTerminalOverride', () => {
  it('returns the 131049 frequency-cap override', () => {
    const result: ProviderSendResult = { ok: false, error_code: '131049' };
    const override = whatsAppTerminalOverride(result);
    expect(override).toEqual({
      markAs: 'undelivered',
      error_code: '131049',
      error_message: 'Meta frequency cap (cross-brand 2/24h)',
      failure_reason: 'provider_freq_cap',
      metricsKey: 'freq_cap_131049',
    });
  });

  it('returns null for any other error code', () => {
    const result: ProviderSendResult = { ok: false, error_code: '131000' };
    expect(whatsAppTerminalOverride(result)).toBeNull();
  });
});

describe('prepareEmail', () => {
  it('returns a terminal outcome when the contact has no email', async () => {
    const ctx = makeCtx({ email: null });
    const outcome = await prepareEmail(fakeTx, ctx, {});
    expect(outcome).toEqual({
      kind: 'terminal',
      error_code: 'no_email',
      error_message: 'audience contact has no email for email channel',
      failure_reason: 'email_invalid',
    });
  });

  it('sin remitente declarado por la aplicación, el outcome es terminal', async () => {
    // No hay default de remitente en ninguna capa, a propósito: el messaging
    // service ejecuta el envío, pero CON QUÉ DIRECCIÓN SALE lo define la
    // aplicación que llama. Un default hace que "no configurado" se vea igual
    // que "configurado" y falle en silencio.
    const ctx = makeCtx({
      templateBody: { subject: 'Hola', html: '<p>Hola</p>' },
    });
    // Deps inyectadas en null: sin endpoints (F7.4) ni config (F7.3), la cadena
    // entera queda vacía — el ladder completo se fija en email-from-resolution.test.ts.
    const outcome = await prepareEmail(fakeTx, ctx, {}, {
      resolvePinnedEmailEndpoint: async () => null,
      pickEmailEndpoint: async () => null,
      readCampaignsEmailFrom: async () => null,
    });
    expect(outcome.kind).toBe('terminal');
    if (outcome.kind !== 'terminal') throw new Error('unreachable');
    expect(outcome.error_code).toBe('email_from_missing');
    // Terminal, no retry: reintentar sin remitente da exactamente lo mismo.
    expect(outcome.failure_reason).toBe('payload_invalid');
  });

  it('returns a ready outcome with rendered subject/html and no endpoint row', async () => {
    // El `from` lo declara LA APLICACIÓN. Antes este test pasaba sin declararlo
    // porque el schema de env traía `onboarding@resend.dev` como default de
    // zod — o sea que el test dependía del bug: el sandbox sólo entrega al
    // dueño de la cuenta, así que una campaña se reportaba enviada y no
    // llegaba a nadie.
    const ctx = makeCtx({
      templateBody: {
        subject: 'Hola {{name}}',
        html: '<p>Hola {{name}}</p>',
        from: 'campanas@ejemplo.com',
      },
    });
    const outcome = await prepareEmail(fakeTx, ctx, {});
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error('unreachable');
    const sendInput = outcome.sendInput as EmailSendInput;
    expect(sendInput.to).toBe('jane@example.com');
    expect(sendInput.subject).toBe('Hola Jane');
    expect(sendInput.html).toContain('Hola Jane');
    expect(outcome.endpointRowId).toBeNull();
    expect(outcome.acceptedExtra).toEqual({});
    expect(outcome.errorLogFields).toEqual({ to_domain: 'example.com' });
  });
});

describe('prepareFacebook', () => {
  it('returns a terminal outcome when the contact has no facebook_psid', async () => {
    const ctx = makeCtx({ meta: {} });
    const outcome = await prepareFacebook(fakeTx, ctx, {});
    expect(outcome).toEqual({
      kind: 'terminal',
      error_code: 'no_psid',
      error_message: 'audience contact has no facebook_psid in meta',
      failure_reason: 'facebook_psid_invalid',
    });
  });

  it('returns no_endpoint when no FB endpoint is available', async () => {
    const ctx = makeCtx({ meta: { facebook_psid: 'psid-1' } });
    const outcome = await prepareFacebook(fakeTx, ctx, {}, {
      pickEndpointForChannel: vi.fn().mockResolvedValue(null),
    });
    expect(outcome).toEqual({ kind: 'no_endpoint', throwMessage: 'NoAvailableFacebookEndpointError' });
  });

  it('interpolates the plain-text template and returns a ready outcome', async () => {
    const ctx = makeCtx({ meta: { facebook_psid: 'psid-1' }, templateBody: { text: 'Hola {{name}}' } });
    const pickEndpointForChannel = vi.fn().mockResolvedValue({
      id: 'fb-endpoint-1',
      endpoint_id: 'page-1',
      access_token: 'page-token',
      daily_cap_remaining: 100,
    });
    const outcome = await prepareFacebook(fakeTx, ctx, {}, { pickEndpointForChannel });
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error('unreachable');
    const sendInput = outcome.sendInput as { message_text: string; recipient_psid: string; page_access_token: string };
    expect(sendInput.message_text).toBe('Hola Jane');
    expect(sendInput.recipient_psid).toBe('psid-1');
    expect(sendInput.page_access_token).toBe('page-token');
    expect(outcome.endpointRowId).toBe('fb-endpoint-1');
    expect(outcome.acceptedExtra).toEqual({});
  });
});

describe('prepareInstagram', () => {
  it('returns a terminal outcome when the contact has no instagram_user_id', async () => {
    const ctx = makeCtx({ meta: {} });
    const outcome = await prepareInstagram(fakeTx, ctx, {});
    expect(outcome).toEqual({
      kind: 'terminal',
      error_code: 'no_igsid',
      error_message: 'audience contact has no instagram_user_id in meta',
      failure_reason: 'instagram_igsid_invalid',
    });
  });

  it('returns a ready outcome for a valid igsid', async () => {
    const ctx = makeCtx({ meta: { instagram_user_id: 'igsid-1' }, templateBody: { text: 'Hola {{name}}' } });
    const pickEndpointForChannel = vi.fn().mockResolvedValue({
      id: 'ig-endpoint-1',
      endpoint_id: 'ig-page-1',
      access_token: 'ig-token',
      daily_cap_remaining: 100,
    });
    const outcome = await prepareInstagram(fakeTx, ctx, {}, { pickEndpointForChannel });
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error('unreachable');
    const sendInput = outcome.sendInput as { message_text: string; recipient_igsid: string };
    expect(sendInput.message_text).toBe('Hola Jane');
    expect(sendInput.recipient_igsid).toBe('igsid-1');
    expect(outcome.endpointRowId).toBe('ig-endpoint-1');
  });
});
