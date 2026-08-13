/**
 * S4.4 — listado de dominios de Resend desde el custodio. El contrato que se
 * fija acá es el que la card del cockpit ya dibuja: un error NUNCA es «no hay
 * dominios» (`reason` distingue no_key / forbidden / error).
 */
import { describe, it, expect, vi } from 'vitest';
import { listResendDomains, type DomainsDeps } from '../provider-domains.js';

function deps(overrides: Partial<DomainsDeps> = {}): DomainsDeps {
  return {
    resolveKey: vi.fn(async () => ({ ok: true as const, apiKey: 're_test', source: 'env' as const })),
    fetchImpl: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    ...overrides,
  };
}

describe('listResendDomains', () => {
  it('sin credencial → no_key con la causa del resolver (no es lista vacía)', async () => {
    const d = deps({
      resolveKey: vi.fn(async () => ({
        ok: false as const,
        error: 'resend: falta la credencial (RESEND_API_KEY sin valor)',
      })),
    });
    const r = await listResendDomains(d);
    expect(r).toEqual({
      ok: false,
      reason: 'no_key',
      detail: 'resend: falta la credencial (RESEND_API_KEY sin valor)',
    });
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('200 → mapea data[] a {name,status,region} con defaults defensivos', async () => {
    const d = deps({
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { name: 'palmawebs.com', status: 'verified', region: 'us-east-1' },
              { status: 'pending' },
            ],
          }),
          { status: 200 },
        ),
      ),
    });
    const r = await listResendDomains(d);
    expect(r).toEqual({
      ok: true,
      domains: [
        { name: 'palmawebs.com', status: 'verified', region: 'us-east-1' },
        { name: '(sin nombre)', status: 'pending', region: null },
      ],
    });
  });

  it('401/403 → forbidden (menor privilegio T1.1, distinto de una falla real)', async () => {
    for (const status of [401, 403]) {
      const d = deps({ fetchImpl: vi.fn(async () => new Response('', { status })) });
      const r = await listResendDomains(d);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('forbidden');
    }
  });

  it('5xx → error con el status nombrado', async () => {
    const d = deps({ fetchImpl: vi.fn(async () => new Response('', { status: 502 })) });
    const r = await listResendDomains(d);
    expect(r).toEqual({ ok: false, reason: 'error', detail: 'Resend respondió 502' });
  });

  it('falla de red → error, sin excepción hacia arriba', async () => {
    const d = deps({
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const r = await listResendDomains(d);
    expect(r).toEqual({ ok: false, reason: 'error', detail: 'no se pudo consultar a Resend' });
  });

  it('la key resuelta viaja como Bearer a Resend', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await listResendDomains(deps({ fetchImpl }));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/domains');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
  });
});
