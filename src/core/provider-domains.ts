/**
 * Dominios del proveedor de email — S4.4 del plan de seguridad / T6.2 del plan
 * de email (decisión c, infra#308): los dominios los sirve el Messaging
 * Service, que es el ÚNICO custodio de la credencial de Resend. El cockpit
 * pregunta por `/management/providers/resend/domains` y nunca ve la key —
 * `RESEND_API_KEY` sale de su compose con esta pieza.
 *
 * El contrato es el que `resend-domains.ts` del cockpit fijó y sus vistas ya
 * respetan: **un error NUNCA se convierte en «no hay dominios»**. Devolver la
 * lista vacía ante una falla sería afirmar que el cliente no tiene ningún
 * dominio verificado — una respuesta plausible y falsa. `reason` distingue:
 *
 *   - `no_key`    → el resolver no tiene credencial para este cliente (estado
 *                   normal de un cliente sin Resend, no una falla).
 *   - `forbidden` → la key vigente no puede listar dominios (menor privilegio
 *                   T1.1: una key `sending_access` da 401/403 en `/domains`).
 *   - `error`     → falla real (timeout, 5xx, red).
 *
 * Sin cache acá: el cockpit ya cachea 5 min en proceso (mismo patrón que su
 * introspección de n8n), y duplicar TTLs sólo agrega estados viejos.
 */
import { resolveProviderKey, type ResolvedKey } from '../lib/providers.js';

const RESEND_DOMAINS_URL = 'https://api.resend.com/domains';
const TIMEOUT_MS = 4000;

export interface ResendDomain {
  name: string;
  status: string; // 'verified' | 'pending' | 'failed' | 'not_started'
  region: string | null;
}

export type DomainsResult =
  | { ok: true; domains: ResendDomain[] }
  | { ok: false; reason: 'no_key' | 'forbidden' | 'error'; detail: string };

/** Inyectables para tests — defaults reales en runtime. */
export interface DomainsDeps {
  resolveKey?: (id: 'resend') => Promise<ResolvedKey>;
  fetchImpl?: typeof fetch;
}

export async function listResendDomains(deps: DomainsDeps = {}): Promise<DomainsResult> {
  const resolve = deps.resolveKey ?? resolveProviderKey;
  const doFetch = deps.fetchImpl ?? fetch;

  const key = await resolve('resend');
  if (!key.ok) {
    // El resolver ya nombra la causa (env faltante / credencial owned que no
    // abre) — es lo único accionable en un log.
    return { ok: false, reason: 'no_key', detail: key.error };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(RESEND_DOMAINS_URL, {
      headers: { Authorization: `Bearer ${key.apiKey}` },
      signal: ctl.signal,
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: 'forbidden',
        detail:
          'la key vigente es de sólo envío y no puede listar dominios (menor privilegio, T1.1)',
      };
    }
    if (!res.ok) {
      return { ok: false, reason: 'error', detail: `Resend respondió ${res.status}` };
    }

    const json = (await res.json()) as { data?: unknown };
    const raw = Array.isArray(json.data) ? json.data : [];
    const domains: ResendDomain[] = raw.map((d) => {
      const o = (d ?? {}) as Record<string, unknown>;
      return {
        name: typeof o.name === 'string' ? o.name : '(sin nombre)',
        status: typeof o.status === 'string' ? o.status : 'unknown',
        region: typeof o.region === 'string' ? o.region : null,
      };
    });
    return { ok: true, domains };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      reason: 'error',
      detail: aborted ? `Resend no respondió en ${TIMEOUT_MS} ms` : 'no se pudo consultar a Resend',
    };
  } finally {
    clearTimeout(timer);
  }
}
