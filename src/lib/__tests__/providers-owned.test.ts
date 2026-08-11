/**
 * El paso 1 del resolver (F2): la credencial del cliente.
 *
 * Lo que estos casos fijan no es «funciona el BYOK» — es **cuándo NO se usa** y
 * **qué pasa cuando falla**, que es donde estaba el riesgo:
 *
 *  - en `pending_verification` la credencial nueva está guardada y NO se usa;
 *  - un `owned` ilegible NO cae a la credencial nuestra.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const rows: { key_ref: string | null; status: string | null; ownership: string | null }[] = [];
let loadResult: unknown = { ok: false, code: 'absent', message: 'sin credencial' };

vi.mock('../postgres.js', () => ({
  sql: (() => Promise.resolve([...rows])) as never,
}));
vi.mock('../../env.js', () => ({
  env: { CLIENT_SLUG: 'palmadevai', RESEND_API_KEY: 're_NUESTRA_managed' },
}));
vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
vi.mock('../../core/provider-credentials.js', () => ({
  loadProviderCredential: () => Promise.resolve(loadResult),
}));

const { resolveProviderKey, __resetProviderCache } = await import('../providers.js');

function modelRow(ownership: string | null, key_ref: string | null = null) {
  rows.length = 0;
  rows.push({ key_ref, status: 'ok', ownership });
  __resetProviderCache();
}

describe('resolver — paso 1 (BYOK)', () => {
  beforeEach(() => {
    loadResult = { ok: false, code: 'absent', message: 'sin credencial' };
  });

  it('con ownership=owned usa la credencial del CLIENTE', async () => {
    modelRow('owned');
    loadResult = { ok: true, credential: 're_DEL_CLIENTE' };
    expect(await resolveProviderKey('resend')).toEqual({
      ok: true,
      apiKey: 're_DEL_CLIENTE',
      source: 'vault',
    });
  });

  it('en pending_verification NO se usa la del cliente — sigue la nuestra', async () => {
    // Es la mitad del gate del cutover: la key ya está cargada pero el correo
    // sigue saliendo con la credencial managed hasta que T7 complete el flip.
    // Sin esto, una key mal copiada cortaría el correo en el mismo click.
    modelRow('managed');
    loadResult = { ok: true, credential: 're_DEL_CLIENTE' };
    expect(await resolveProviderKey('resend')).toEqual({
      ok: true,
      apiKey: 're_NUESTRA_managed',
      source: 'env',
    });
  });

  it('owned + credencial ILEGIBLE falla cerrado — NO cae a la nuestra', async () => {
    // Caer al env acá significaría emitir el correo del cliente DESDE NUESTRA
    // CUENTA, que es exactamente lo que el BYOK existe para evitar.
    modelRow('owned');
    loadResult = { ok: false, code: 'undecryptable', message: 'no autentica' };
    const r = await resolveProviderKey('resend');
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('owned');
    expect(JSON.stringify(r)).not.toContain('re_NUESTRA_managed');
  });

  it('owned SIN credencial cargada también falla cerrado', async () => {
    modelRow('owned');
    loadResult = { ok: false, code: 'absent', message: 'sin credencial cargada' };
    expect((await resolveProviderKey('resend')).ok).toBe(false);
  });

  it('owned sin master key: el error nombra la env que falta', async () => {
    modelRow('owned');
    loadResult = { ok: false, code: 'no_master_key', message: 'falta SECRETS_MASTER_KEY en el .env' };
    const r = await resolveProviderKey('resend');
    expect((r as { error: string }).error).toContain('SECRETS_MASTER_KEY');
  });

  it('sin fila del modelo sigue el camino de siempre (T5.6)', async () => {
    rows.length = 0;
    __resetProviderCache();
    expect(await resolveProviderKey('resend')).toEqual({
      ok: true,
      apiKey: 're_NUESTRA_managed',
      source: 'env',
    });
  });
});
