/**
 * El custodio (F2) — lo que se prueba acá es sobre todo lo que NO tiene que
 * pasar: que el secreto no vuelva por la API, que no se loguee, y que un
 * `owned` ilegible NO caiga a la credencial nuestra.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

const KEY_B64 = randomBytes(32).toString('base64');

// El módulo de master keys lee el env al cargarse; se inyecta una llave real
// para ejercitar el cifrado de verdad (no un mock del cripto).
vi.mock('../../env.js', () => ({
  env: {
    SECRETS_MASTER_KEY: KEY_B64,
    SECRETS_MASTER_KEY_VERSION: 1,
    SECRETS_MASTER_KEY_PREVIOUS: undefined,
    SECRETS_MASTER_KEY_PREVIOUS_VERSION: undefined,
    CLIENT_SLUG: 'palmadevai',
  },
}));

const logged: unknown[] = [];
const logger = {
  info: (o: unknown) => logged.push(o),
  warn: (o: unknown) => logged.push(o),
  error: (o: unknown) => logged.push(o),
  debug: (o: unknown) => logged.push(o),
} as never;

const {
  storeProviderCredential,
  getProviderCredentialInfo,
  deleteProviderCredential,
  loadProviderCredential,
} = await import('../provider-credentials.js');

const SECRET = 're_ClienteTraeLaSuya_9f2c';

/** SQL falso con una tablita en memoria: alcanza para fijar el contrato. */
function fakeSql() {
  const providers = new Set(['resend']);
  const secrets = new Map<string, Record<string, unknown>>();
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join(' ');
    if (q.includes('FROM config.providers')) {
      return Promise.resolve(providers.has(String(vals[0])) ? [{ id: vals[0] }] : []);
    }
    if (q.includes('INSERT INTO config.client_provider_secrets')) {
      const [provider_id, key_version, algo, iv, auth_tag, ciphertext, last4, created_by] = vals;
      secrets.set(String(provider_id), {
        provider_id, key_version, algo, iv, auth_tag, ciphertext, last4, created_by,
        created_at: new Date('2026-08-11T12:00:00Z'),
      });
      return Promise.resolve([]);
    }
    if (q.includes('DELETE FROM config.client_provider_secrets')) {
      const had = secrets.delete(String(vals[0]));
      return Promise.resolve(had ? [{ provider_id: vals[0] }] : []);
    }
    if (q.includes('FROM config.client_provider_secrets')) {
      const row = secrets.get(String(vals[0]));
      return Promise.resolve(row ? [row] : []);
    }
    throw new Error('query inesperada: ' + q);
  }) as never;
  return { sql, secrets };
}

describe('custodio de credenciales del cliente', () => {
  beforeEach(() => (logged.length = 0));

  it('round-trip: se guarda cifrada y se recupera igual', async () => {
    const { sql } = fakeSql();
    const deps = { sql, logger, clientSlug: 'palmadevai' };
    const stored = await storeProviderCredential(deps, 'resend', SECRET, 'carlos');
    expect(stored).toMatchObject({ ok: true, last4: '9f2c', key_version: 1 });

    const loaded = await loadProviderCredential(deps, 'resend');
    expect(loaded).toEqual({ ok: true, credential: SECRET });
  });

  it('lo que se guarda en la fila NO contiene el plaintext', async () => {
    const { sql, secrets } = fakeSql();
    await storeProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, 'resend', SECRET, null);
    const row = secrets.get('resend')!;
    expect(Buffer.isBuffer(row.ciphertext)).toBe(true);
    expect(JSON.stringify(row)).not.toContain('re_ClienteTraeLaSuya');
    expect(row.last4).toBe('9f2c'); // lo único en claro, y son 4 chars
  });

  it('el secreto NO aparece en ningún log', async () => {
    const { sql } = fakeSql();
    await storeProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, 'resend', SECRET, 'carlos');
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(JSON.stringify(logged)).toContain('9f2c'); // last4 sí: identifica sin revelar
  });

  it('la lectura de info NUNCA devuelve el valor — es write-only', async () => {
    const { sql } = fakeSql();
    const deps = { sql, logger, clientSlug: 'palmadevai' };
    await storeProviderCredential(deps, 'resend', SECRET, 'carlos');
    const info = await getProviderCredentialInfo(deps, 'resend');
    expect(info).toMatchObject({ has_key: true, last4: '9f2c', key_version: 1, created_by: 'carlos' });
    expect(JSON.stringify(info)).not.toContain(SECRET);
    expect(Object.keys(info)).not.toContain('credential');
  });

  it('sin credencial cargada, `has_key: false` y nada más', async () => {
    const { sql } = fakeSql();
    expect(await getProviderCredentialInfo({ sql, logger, clientSlug: 'palmadevai' }, 'resend')).toEqual({
      has_key: false,
    });
  });

  it('un proveedor desconocido da error nombrando el id, no una violación de FK', async () => {
    const { sql } = fakeSql();
    const r = await storeProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, 'inventado', SECRET, null);
    expect(r).toMatchObject({ ok: false, code: 'unknown_provider' });
    expect((r as { message: string }).message).toContain('inventado');
  });

  it('guardar dos veces reemplaza, y el segundo valor es el que abre', async () => {
    const { sql } = fakeSql();
    const deps = { sql, logger, clientSlug: 'palmadevai' };
    await storeProviderCredential(deps, 'resend', SECRET, null);
    await storeProviderCredential(deps, 'resend', 're_LaSegunda_0001', null);
    expect(await loadProviderCredential(deps, 'resend')).toEqual({ ok: true, credential: 're_LaSegunda_0001' });
  });

  it('borrar es idempotente: dos veces no es un error', async () => {
    const { sql } = fakeSql();
    const deps = { sql, logger, clientSlug: 'palmadevai' };
    await storeProviderCredential(deps, 'resend', SECRET, null);
    expect(await deleteProviderCredential(deps, 'resend')).toEqual({ deleted: true });
    expect(await deleteProviderCredential(deps, 'resend')).toEqual({ deleted: false });
    expect(await loadProviderCredential(deps, 'resend')).toMatchObject({ ok: false, code: 'absent' });
  });

  it('un ciphertext de OTRO cliente no abre — el AAD lo ata a su base', async () => {
    const { sql } = fakeSql();
    await storeProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, 'resend', SECRET, null);
    // El mismo blob, leído con el slug de otro cliente.
    const otro = await loadProviderCredential({ sql, logger, clientSlug: 'palmawebs' }, 'resend');
    expect(otro).toMatchObject({ ok: false, code: 'undecryptable' });
    expect(JSON.stringify(otro)).not.toContain(SECRET);
  });
});
