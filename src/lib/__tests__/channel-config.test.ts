/**
 * `readChannelWhatsAppConfig()` (dispatcher feat-channel-whatsapp-config) —
 * `META_WA_WABA_ID` / `META_WA_DEFAULT_PHONE_NUMBER_ID` dejan de ser SÓLO env:
 * pasan a poder vivir en `bot.config['channel_whatsapp']` (jsonb), que el
 * cockpit va a editar sin redeploy.
 *
 * Mismo patrón de mock que `providers-owned.test.ts`: se mockea `postgres.js`
 * y `env.js`, nunca una DB real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let rows: Array<{ waba_id: string | null; default_phone_number_id: string | null }> = [];
let sqlCalls = 0;
let sqlShouldThrow = false;

vi.mock('../postgres.js', () => ({
  sql: (() => {
    sqlCalls += 1;
    if (sqlShouldThrow) return Promise.reject(new Error('bot.config no existe'));
    return Promise.resolve([...rows]);
  }) as never,
}));

// Regla del repo: las envs opcionales llegan '' EXPLÍCITO, nunca undefined.
const envMock = {
  META_WA_WABA_ID: '',
  META_WA_DEFAULT_PHONE_NUMBER_ID: '',
};
vi.mock('../../env.js', () => ({ env: envMock }));

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const { readChannelWhatsAppConfig, invalidateChannelWhatsAppCache, __resetProviderCache } =
  await import('../providers.js');

function setRow(row: { waba_id: string | null; default_phone_number_id: string | null } | null) {
  rows = row ? [row] : [];
}

describe('readChannelWhatsAppConfig', () => {
  beforeEach(() => {
    sqlCalls = 0;
    sqlShouldThrow = false;
    envMock.META_WA_WABA_ID = '';
    envMock.META_WA_DEFAULT_PHONE_NUMBER_ID = '';
    setRow(null);
    __resetProviderCache();
  });

  it('DB con ambos campos gana sobre el env', async () => {
    envMock.META_WA_WABA_ID = 'waba-env';
    envMock.META_WA_DEFAULT_PHONE_NUMBER_ID = 'phone-env';
    setRow({ waba_id: 'waba-db', default_phone_number_id: 'phone-db' });

    const cfg = await readChannelWhatsAppConfig();
    expect(cfg).toEqual({ wabaId: 'waba-db', defaultPhoneNumberId: 'phone-db', source: 'db' });
  });

  it('fallback POR CAMPO: DB da waba_id pero no el phone → el phone cae al env', async () => {
    envMock.META_WA_DEFAULT_PHONE_NUMBER_ID = 'phone-env';
    setRow({ waba_id: 'waba-db', default_phone_number_id: '' });

    const cfg = await readChannelWhatsAppConfig();
    expect(cfg.wabaId).toBe('waba-db');
    expect(cfg.defaultPhoneNumberId).toBe('phone-env');
    // Al menos un campo resolvió por DB → source 'db', aunque el otro venga de env.
    expect(cfg.source).toBe('db');
  });

  it('default_phone_number_id: DB trae phone → gana sobre env (dispatcher#feat-channel-whatsapp-config seguimiento)', async () => {
    envMock.META_WA_DEFAULT_PHONE_NUMBER_ID = 'phone-env';
    setRow({ waba_id: null, default_phone_number_id: 'phone-db' });

    const cfg = await readChannelWhatsAppConfig();
    expect(cfg.defaultPhoneNumberId).toBe('phone-db');
    expect(cfg.source).toBe('db');
  });

  it('DB con string vacío = AUSENTE (no valor)', async () => {
    envMock.META_WA_WABA_ID = 'waba-env';
    setRow({ waba_id: '', default_phone_number_id: null });

    const cfg = await readChannelWhatsAppConfig();
    expect(cfg.wabaId).toBe('waba-env');
    expect(cfg.source).toBe('env');
  });

  it('sin fila en la DB — cae entero al env', async () => {
    envMock.META_WA_WABA_ID = 'waba-env';
    envMock.META_WA_DEFAULT_PHONE_NUMBER_ID = 'phone-env';
    setRow(null);

    const cfg = await readChannelWhatsAppConfig();
    expect(cfg).toEqual({ wabaId: 'waba-env', defaultPhoneNumberId: 'phone-env', source: 'env' });
  });

  it('env vacío (\'\' explícito) y sin fila en DB → none, ambos null', async () => {
    setRow(null);
    const cfg = await readChannelWhatsAppConfig();
    expect(cfg).toEqual({ wabaId: null, defaultPhoneNumberId: null, source: 'none' });
  });

  it('error de DB (tabla/columna inexistente) no tira — cae al env como T5.6', async () => {
    sqlShouldThrow = true;
    envMock.META_WA_WABA_ID = 'waba-env';

    const cfg = await readChannelWhatsAppConfig();
    expect(cfg.wabaId).toBe('waba-env');
    expect(cfg.source).toBe('env');
  });

  it('cachea 30s: dos llamadas seguidas pegan una sola vez a la DB', async () => {
    setRow({ waba_id: 'waba-db', default_phone_number_id: null });
    await readChannelWhatsAppConfig();
    await readChannelWhatsAppConfig();
    expect(sqlCalls).toBe(1);
  });

  it('invalidateChannelWhatsAppCache fuerza un re-read', async () => {
    setRow({ waba_id: 'waba-db-1', default_phone_number_id: null });
    const first = await readChannelWhatsAppConfig();
    expect(first.wabaId).toBe('waba-db-1');

    setRow({ waba_id: 'waba-db-2', default_phone_number_id: null });
    invalidateChannelWhatsAppCache();
    const second = await readChannelWhatsAppConfig();
    expect(second.wabaId).toBe('waba-db-2');
    expect(sqlCalls).toBe(2);
  });

  it('__resetProviderCache también limpia este cache (mismo estilo que el resto)', async () => {
    setRow({ waba_id: 'waba-db-1', default_phone_number_id: null });
    await readChannelWhatsAppConfig();
    setRow({ waba_id: 'waba-db-2', default_phone_number_id: null });
    __resetProviderCache();
    const cfg = await readChannelWhatsAppConfig();
    expect(cfg.wabaId).toBe('waba-db-2');
  });
});
