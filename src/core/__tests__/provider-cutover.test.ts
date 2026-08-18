/**
 * El cutover (F3/T7) — lo que se prueba acá es sobre todo lo que NO tiene que
 * pasar: el flip a `owned` no se marca hecho sin un mail real, un fallo del
 * envío de prueba deja al cliente en `managed` (nunca a mitad de camino), y el
 * plaintext no se filtra ni al log ni a la respuesta de ninguna función.
 *
 * `provider-credentials.js` NO se mockea: se usa de verdad para guardar y leer
 * el ciphertext, así el cutover ejercita la misma credencial descifrada que
 * usaría en producción. Lo que sí se mockea es todo lo que sale a la red
 * (`providers/email.js`) y el resolver de remitente/caché (`lib/providers.js`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

const KEY_B64 = randomBytes(32).toString('base64');

// Mismo patrón que provider-credentials.test.ts: llave real para ejercitar el
// cripto de verdad, no un mock del cifrado.
vi.mock('../../env.js', () => ({
  env: {
    SECRETS_MASTER_KEY: KEY_B64,
    SECRETS_MASTER_KEY_VERSION: 1,
    SECRETS_MASTER_KEY_PREVIOUS: undefined,
    SECRETS_MASTER_KEY_PREVIOUS_VERSION: undefined,
    CLIENT_SLUG: 'palmadevai',
  },
}));

// Lo único que sale a la red — se mockea, nunca se llama de verdad.
vi.mock('../../providers/email.js', () => ({
  sendEmail: vi.fn(),
  verifyEmailCredential: vi.fn(),
}));

// Los otros dos verificadores del dispatch per-proveedor: misma política.
vi.mock('../../providers/whatsapp-management.js', () => ({
  verifyMetaCredential: vi.fn(),
}));
vi.mock('../../lib/ai-personalize.js', () => ({
  verifyOpenAiCredential: vi.fn(),
}));

// La prueba de USO real del BYOK OpenAI (G1): sale a api.openai.com — se
// mockea, nunca se llama de verdad.
vi.mock('../../providers/openai-byok.js', () => ({
  realOpenAiCompletion: vi.fn(),
}));

// El resolver de remitente y el invalidador de cache: decisiones del core, no
// del proveedor, pero tampoco son lo que este módulo prueba.
vi.mock('../../lib/providers.js', () => ({
  resolveDefaultFrom: vi.fn(),
  invalidateProviderCache: vi.fn(),
}));

const logged: unknown[] = [];
const logger = {
  info: (o: unknown) => logged.push(o),
  warn: (o: unknown) => logged.push(o),
  error: (o: unknown) => logged.push(o),
  debug: (o: unknown) => logged.push(o),
} as never;

const { storeProviderCredential } = await import('../provider-credentials.js');
const { checkProviderCredential, cutoverProviderToOwned, revertProviderToManaged } = await import(
  '../provider-cutover.js'
);
const { sendEmail, verifyEmailCredential } = await import('../../providers/email.js');
const { verifyMetaCredential } = await import('../../providers/whatsapp-management.js');
const { verifyOpenAiCredential } = await import('../../lib/ai-personalize.js');
const { realOpenAiCompletion } = await import('../../providers/openai-byok.js');
const { resolveDefaultFrom, invalidateProviderCache } = await import('../../lib/providers.js');

const SECRET = 're_ClienteTraeLaSuya_9f2c';
const FROM = 'ops@cliente.example';
const VERIFY_TO = 'admin@cliente.example';

interface ProviderState {
  id: string;
  name: string;
  ownership: string;
  ownership_flippable: boolean;
  status: string;
  statusDetail?: string | null;
}

interface StateWrite {
  provider_id: unknown;
  ownership: unknown;
  status: unknown;
  statusDetail: unknown;
  changedBy: unknown;
  changedFrom: unknown;
  notes: unknown;
}

/**
 * Orden real de eventos (escritura de estado vs. llamadas a la red), para el
 * test T7.1's "pending_verification antes de la red". Se resetea en cada test.
 */
let callOrder: string[] = [];

/**
 * SQL falso con tablitas en memoria — el mismo patrón que
 * `provider-credentials.test.ts`, extendido con `config.v_client_providers` y
 * `config.client_providers` (lo que agrega el cutover).
 */
function fakeSql(seed: Partial<ProviderState> = {}) {
  const providersCatalog = new Set(['resend', 'meta', 'openai', 'arca']);
  const secrets = new Map<string, Record<string, unknown>>();
  const stateWrites: StateWrite[] = [];
  const providerState: ProviderState = {
    id: 'resend',
    name: 'Resend',
    ownership: 'managed',
    ownership_flippable: true,
    status: 'ok',
    ...seed,
  };

  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join(' ');

    if (q.includes('FROM config.v_client_providers')) {
      return Promise.resolve(String(vals[0]) === providerState.id ? [{ ...providerState }] : []);
    }
    // El outcome de un chequeo FALLIDO escribe estado sin audit, y por eso su
    // SQL lleva `'failed'` literal en vez de pasarlo como parámetro. Va antes
    // del write genérico: los dos son INSERT sobre la misma tabla.
    if (q.includes('INSERT INTO config.client_providers') && q.includes("'failed'")) {
      callOrder.push('state:check-failed');
      providerState.status = 'failed';
      providerState.statusDetail = String(vals[2]);
      return Promise.resolve([]);
    }
    if (q.includes('INSERT INTO config.client_providers')) {
      const [provider_id, ownership, status, statusDetail, changedBy, changedFrom, notes] = vals;
      stateWrites.push({ provider_id, ownership, status, statusDetail, changedBy, changedFrom, notes });
      callOrder.push(`state:${String(status)}`);
      providerState.ownership = String(ownership);
      providerState.status = String(status);
      return Promise.resolve([]);
    }
    if (q.includes('UPDATE config.client_providers')) {
      // El update acotado del check exitoso: limpia el fallo anterior y NO
      // toca el audit (`changed_by`/`changed_from` son del último cambio real).
      callOrder.push('state:clear');
      if (providerState.status === 'failed') providerState.status = 'ok';
      providerState.statusDetail = null;
      return Promise.resolve([]);
    }
    if (q.includes('FROM config.providers')) {
      return Promise.resolve(providersCatalog.has(String(vals[0])) ? [{ id: vals[0] }] : []);
    }
    if (q.includes('INSERT INTO config.client_provider_secrets')) {
      const [provider_id, key_version, algo, iv, auth_tag, ciphertext, last4, created_by] = vals;
      secrets.set(String(provider_id), {
        provider_id, key_version, algo, iv, auth_tag, ciphertext, last4, created_by,
        created_at: new Date('2026-08-11T12:00:00Z'),
      });
      return Promise.resolve([]);
    }
    if (q.includes('FROM config.client_provider_secrets')) {
      const row = secrets.get(String(vals[0]));
      return Promise.resolve(row ? [row] : []);
    }
    throw new Error('query inesperada: ' + q);
  }) as never;

  return { sql, secrets, stateWrites, providerState };
}

/** Deja la credencial cargada (F2 de verdad) antes de ejercitar el cutover. */
async function seedCredential(sql: never, secret = SECRET, providerId = 'resend') {
  await storeProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, providerId, secret, 'carlos');
}

beforeEach(() => {
  logged.length = 0;
  callOrder = [];
  vi.mocked(sendEmail).mockReset();
  vi.mocked(verifyEmailCredential).mockReset();
  vi.mocked(verifyMetaCredential).mockReset();
  vi.mocked(verifyOpenAiCredential).mockReset();
  vi.mocked(realOpenAiCompletion).mockReset();
  vi.mocked(resolveDefaultFrom).mockReset();
  vi.mocked(invalidateProviderCache).mockReset();
});

describe('checkProviderCredential (T7.3) — no toca ownership', () => {
  it('el proveedor rechaza: status=failed, ownership sin cambios', async () => {
    const { sql, providerState } = fakeSql();
    vi.mocked(verifyEmailCredential).mockResolvedValue({
      ok: false,
      error_code: 'invalid_api_key',
      error_message: 'API key is invalid',
      http_status: 401,
    });
    await seedCredential(sql);

    const r = await checkProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, 'resend');
    expect(r).toMatchObject({ ok: false, code: 'credential_rejected' });
    expect(providerState.ownership).toBe('managed');
    expect(providerState.status).toBe('failed');
  });

  it('el chequeo que falla NO pisa el audit del último cambio real', async () => {
    // Encontrado en el smoke de F3 contra el lab: un chequeo fallido escribía
    // `changed_by = NULL`. Probar una credencial no es un cambio de
    // titularidad, y el audit es lo único que después contesta «¿quién puso a
    // este cliente en owned?».
    const { sql, stateWrites, providerState } = fakeSql();
    vi.mocked(verifyEmailCredential).mockResolvedValue({
      ok: false,
      error_code: 'invalid_api_key',
      error_message: 'API key is invalid',
      http_status: 401,
    });
    await seedCredential(sql);

    await checkProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, 'resend');

    expect(providerState.status).toBe('failed');
    // Ninguna escritura con audit: el estado se movió por la vía que no lo toca.
    expect(stateWrites).toHaveLength(0);
    expect(callOrder).toContain('state:check-failed');
  });

  it('el chequeo que sale bien LIMPIA el failed anterior', async () => {
    // Sin esto, el operador arregla la key, prueba, ve «ok» en la respuesta y
    // la card sigue en rojo con el error viejo — peor que no mostrar nada.
    const { sql, providerState, stateWrites } = fakeSql({ status: 'failed' });
    providerState.statusDetail = 'Resend rechazó la credencial (invalid_api_key: …)';
    vi.mocked(verifyEmailCredential).mockResolvedValue({ ok: true, detail: 'autenticó' });
    await seedCredential(sql);

    const r = await checkProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, 'resend');

    expect(r).toMatchObject({ ok: true });
    expect(providerState.status).toBe('ok');
    expect(providerState.statusDetail).toBeNull();
    // Y no escribe audit: probar no es un cambio de titularidad, así que
    // `changed_by`/`changed_from` tienen que seguir siendo los del último
    // cambio real.
    expect(stateWrites).toHaveLength(0);
  });
});

describe('cutoverProviderToOwned (T7.1 / T9.8.3) — casos negativos', () => {
  it('1. sin credencial cargada → no_credential, ownership sin cambios', async () => {
    const { sql, providerState, stateWrites } = fakeSql();
    const r = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );
    expect(r).toMatchObject({ ok: false, code: 'no_credential' });
    expect(providerState.ownership).toBe('managed');
    expect(stateWrites).toHaveLength(0);
  });

  it('2. ownership_flippable=false → not_flippable, sin escrituras ni llamadas al proveedor', async () => {
    const { sql, providerState, stateWrites } = fakeSql({ ownership_flippable: false });
    await seedCredential(sql);

    const r = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );
    expect(r).toMatchObject({ ok: false, code: 'not_flippable' });
    expect(providerState.ownership).toBe('managed');
    expect(stateWrites).toHaveLength(0);
    expect(verifyEmailCredential).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('3. el proveedor rechaza la credencial → managed/failed, con panel + aclaración, sin mandar mail', async () => {
    const { sql, providerState } = fakeSql();
    await seedCredential(sql);
    vi.mocked(resolveDefaultFrom).mockResolvedValue(FROM);
    vi.mocked(verifyEmailCredential).mockResolvedValue({
      ok: false,
      error_code: 'invalid_api_key',
      error_message: 'API key is invalid',
      http_status: 401,
    });

    const r = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );
    expect(r).toMatchObject({ ok: false, code: 'credential_rejected' });
    expect(providerState.ownership).toBe('managed');
    expect(providerState.status).toBe('failed');
    const message = (r as { message: string }).message;
    expect(message).toContain('Resend');
    expect(message).toContain('https://resend.com/domains');
    expect(message).toContain('sigue saliendo con nuestra cuenta');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('4. el envío de prueba falla → sigue en managed/failed con la causa (el gate central)', async () => {
    const { sql, providerState } = fakeSql();
    await seedCredential(sql);
    vi.mocked(resolveDefaultFrom).mockResolvedValue(FROM);
    vi.mocked(verifyEmailCredential).mockResolvedValue({ ok: true, detail: 'autenticó' });
    vi.mocked(sendEmail).mockResolvedValue({
      ok: false,
      error_code: 'validation_error',
      error_message: 'domain not verified',
      http_status: 422,
    });

    const r = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );
    expect(r).toMatchObject({ ok: false, code: 'send_failed' });
    expect(providerState.ownership).toBe('managed');
    expect(providerState.status).toBe('failed');
    expect((r as { message: string }).message).toContain('validation_error');
  });

  it('5. restricted_api_key NO es un fallo: con envío OK el cutover completa', async () => {
    const { sql, providerState } = fakeSql();
    await seedCredential(sql);
    vi.mocked(resolveDefaultFrom).mockResolvedValue(FROM);
    vi.mocked(verifyEmailCredential).mockResolvedValue({
      ok: true,
      detail: 'la credencial es de permiso restringido (sólo envío)',
    });
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, message_id: 'msg_restricted_1', http_status: 200 });

    const r = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );
    expect(r).toMatchObject({ ok: true, ownership: 'owned', message_id: 'msg_restricted_1' });
    expect(providerState.ownership).toBe('owned');
  });

  it('6. sin remitente → no_sender, no se llega a mandar nada', async () => {
    const { sql, providerState, stateWrites } = fakeSql();
    await seedCredential(sql);
    vi.mocked(resolveDefaultFrom).mockResolvedValue(null);

    const r = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );
    expect(r).toMatchObject({ ok: false, code: 'no_sender' });
    expect(providerState.ownership).toBe('managed');
    expect(stateWrites).toHaveLength(0);
    expect(verifyEmailCredential).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('7. el plaintext no se filtra: ni en logs ni en la respuesta de ninguna de las tres funciones', async () => {
    const { sql } = fakeSql();
    await seedCredential(sql);

    // Un check que rechaza.
    vi.mocked(verifyEmailCredential).mockResolvedValueOnce({
      ok: false,
      error_code: 'invalid_api_key',
      error_message: 'nope',
      http_status: 401,
    });
    const checked = await checkProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, 'resend');

    // Un cutover que falla en el envío.
    vi.mocked(resolveDefaultFrom).mockResolvedValue(FROM);
    vi.mocked(verifyEmailCredential).mockResolvedValueOnce({ ok: true, detail: 'ok' });
    vi.mocked(sendEmail).mockResolvedValueOnce({ ok: false, error_code: 'validation_error', http_status: 422 });
    const failedCutover = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );

    // Un cutover que completa.
    vi.mocked(verifyEmailCredential).mockResolvedValueOnce({ ok: true, detail: 'ok' });
    vi.mocked(sendEmail).mockResolvedValueOnce({ ok: true, message_id: 'msg_ok', http_status: 200 });
    const okCutover = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );

    // Un revert.
    const reverted = await revertProviderToManaged(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { changedBy: 'carlos' },
    );

    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(JSON.stringify(checked)).not.toContain(SECRET);
    expect(JSON.stringify(failedCutover)).not.toContain(SECRET);
    expect(JSON.stringify(okCutover)).not.toContain(SECRET);
    expect(JSON.stringify(reverted)).not.toContain(SECRET);
  });
});

describe('cutoverProviderToOwned — camino feliz y orden', () => {
  it('8. cutover completo: owned/ok, sin detail, notes con message_id, audit changed_from', async () => {
    const { sql, providerState, stateWrites } = fakeSql();
    await seedCredential(sql);
    vi.mocked(resolveDefaultFrom).mockResolvedValue(FROM);
    vi.mocked(verifyEmailCredential).mockResolvedValue({ ok: true, detail: 'autenticó' });
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, message_id: 'msg_happy_1', http_status: 200 });

    const r = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );
    expect(r).toEqual({ ok: true, ownership: 'owned', message_id: 'msg_happy_1', verified_to: VERIFY_TO });
    expect(providerState.ownership).toBe('owned');
    expect(providerState.status).toBe('ok');

    const last = stateWrites[stateWrites.length - 1];
    expect(last.statusDetail).toBeNull();
    expect(String(last.notes)).toContain('msg_happy_1');
    expect(last.changedFrom).toBe('managed');
    expect(last.changedBy).toBe('carlos');
  });

  it('9. pending_verification se escribe ANTES de salir a la red', async () => {
    const { sql, stateWrites } = fakeSql();
    await seedCredential(sql);
    vi.mocked(resolveDefaultFrom).mockResolvedValue(FROM);
    vi.mocked(verifyEmailCredential).mockImplementation(async () => {
      callOrder.push('verify');
      return { ok: true, detail: 'autenticó' };
    });
    vi.mocked(sendEmail).mockImplementation(async () => {
      callOrder.push('send');
      return { ok: true, message_id: 'msg_order_1', http_status: 200 };
    });

    await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );

    expect(stateWrites[0].status).toBe('pending_verification');
    expect(callOrder).toEqual(['state:pending_verification', 'verify', 'send', 'state:ok']);
  });

  it('10. el mail de verificación va con la credencial descifrada, no con la del env', async () => {
    const { sql } = fakeSql();
    await seedCredential(sql, SECRET);
    vi.mocked(resolveDefaultFrom).mockResolvedValue(FROM);
    vi.mocked(verifyEmailCredential).mockResolvedValue({ ok: true, detail: 'autenticó' });
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, message_id: 'msg_key_1', http_status: 200 });

    await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ api_key: SECRET, to: VERIFY_TO, from: FROM }));
    // Y el filtro barato de conexión también usó la misma credencial.
    expect(verifyEmailCredential).toHaveBeenCalledWith(SECRET);
  });

  it('11. invalidateProviderCache se llama sólo cuando el cutover completa', async () => {
    const { sql: sqlOk } = fakeSql();
    await seedCredential(sqlOk);
    vi.mocked(resolveDefaultFrom).mockResolvedValue(FROM);
    vi.mocked(verifyEmailCredential).mockResolvedValue({ ok: true, detail: 'autenticó' });
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, message_id: 'msg_cache_1', http_status: 200 });
    await cutoverProviderToOwned(
      { sql: sqlOk, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );
    expect(invalidateProviderCache).toHaveBeenCalledTimes(1);
    expect(invalidateProviderCache).toHaveBeenCalledWith('resend');

    vi.mocked(invalidateProviderCache).mockClear();
    const { sql: sqlFail } = fakeSql();
    await seedCredential(sqlFail);
    vi.mocked(verifyEmailCredential).mockResolvedValue({
      ok: false,
      error_code: 'invalid_api_key',
      error_message: 'nope',
      http_status: 401,
    });
    await cutoverProviderToOwned(
      { sql: sqlFail, logger, clientSlug: 'palmadevai' },
      'resend',
      { verifyTo: VERIFY_TO, changedBy: 'carlos' },
    );
    expect(invalidateProviderCache).not.toHaveBeenCalled();
  });
});

describe('revertProviderToManaged (T7.5)', () => {
  it('12. owned → managed: audit changed_from=owned y el ciphertext NO se borra', async () => {
    const { sql, providerState, secrets } = fakeSql({ ownership: 'owned', status: 'ok' });
    await seedCredential(sql);
    expect(secrets.has('resend')).toBe(true);

    const r = await revertProviderToManaged({ sql, logger, clientSlug: 'palmadevai' }, 'resend', {
      changedBy: 'carlos',
      reason: 'prueba de revert',
    });
    expect(r).toEqual({ ok: true, ownership: 'managed', was: 'owned' });
    expect(providerState.ownership).toBe('managed');
    // El ciphertext sigue ahí — revertir es ruteo, no borrado.
    expect(secrets.has('resend')).toBe(true);
    expect(secrets.get('resend')).toBeDefined();
  });

  it('13. revert sobre un proveedor que no está en owned → not_owned, sin escrituras', async () => {
    const { sql, stateWrites } = fakeSql({ ownership: 'managed' });
    const r = await revertProviderToManaged({ sql, logger, clientSlug: 'palmadevai' }, 'resend', {
      changedBy: 'carlos',
    });
    expect(r).toMatchObject({ ok: false, code: 'not_owned' });
    expect(stateWrites).toHaveLength(0);
  });

  it('18. revert sobre un proveedor que NACE del cliente → not_flippable, sin escrituras', async () => {
    // Meta es owned de nacimiento: no existe una «cuenta administrada» a la
    // cual volver. La UI ofrece el botón sobre cualquier card owned; la
    // autoridad tiene que ser el servicio.
    const { sql, providerState, stateWrites } = fakeSql({
      id: 'meta',
      name: 'Meta',
      ownership: 'owned',
      ownership_flippable: false,
    });
    const r = await revertProviderToManaged({ sql, logger, clientSlug: 'palmadevai' }, 'meta', {
      changedBy: 'carlos',
    });
    expect(r).toMatchObject({ ok: false, code: 'not_flippable' });
    expect(providerState.ownership).toBe('owned');
    expect(stateWrites).toHaveLength(0);
  });
});

describe('check per-proveedor (TD S5.1 → S1.1) — cada credencial contra SU proveedor', () => {
  it('14. meta usa el verificador de Meta, nunca el de Resend', async () => {
    const { sql } = fakeSql({
      id: 'meta',
      name: 'Meta',
      ownership: 'owned',
      ownership_flippable: false,
    });
    await seedCredential(sql, 'EAAG_token_meta_nuevo', 'meta');
    vi.mocked(verifyMetaCredential).mockResolvedValue({
      ok: true,
      detail: 'la credencial autenticó contra Meta y accede a la WABA «Lab»',
    });

    const r = await checkProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, 'meta');

    expect(r).toMatchObject({ ok: true, detail: expect.stringContaining('WABA') });
    expect(verifyMetaCredential).toHaveBeenCalledWith('EAAG_token_meta_nuevo');
    // El TD que esto cierra: el botón «probar» de la card de Meta respondía el
    // 401 de Resend sobre un token perfectamente bueno.
    expect(verifyEmailCredential).not.toHaveBeenCalled();
  });

  it('15. openai rechazada → failed con el texto de SU proveedor y SU panel', async () => {
    const { sql, providerState } = fakeSql({ id: 'openai', name: 'OpenAI' });
    await seedCredential(sql, 'sk-proj-mala', 'openai');
    vi.mocked(verifyOpenAiCredential).mockResolvedValue({
      ok: false,
      error_code: 'invalid_api_key',
      error_message: 'Incorrect API key provided',
      http_status: 401,
    });

    const r = await checkProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, 'openai');

    expect(r).toMatchObject({ ok: false, code: 'credential_rejected' });
    expect(providerState.status).toBe('failed');
    const message = (r as { message: string }).message;
    expect(message).toContain('OpenAI');
    expect(message).toContain('https://platform.openai.com/api-keys');
    expect(verifyEmailCredential).not.toHaveBeenCalled();
  });

  it('16. proveedor sin verificador propio → check_unsupported, sin red y sin escrituras', async () => {
    const { sql, stateWrites, providerState } = fakeSql({ id: 'arca', name: 'ARCA' });

    const r = await checkProviderCredential({ sql, logger, clientSlug: 'palmadevai' }, 'arca');

    expect(r).toMatchObject({ ok: false, code: 'check_unsupported' });
    expect(providerState.status).toBe('ok');
    expect(stateWrites).toHaveLength(0);
    expect(verifyEmailCredential).not.toHaveBeenCalled();
    expect(verifyMetaCredential).not.toHaveBeenCalled();
    expect(verifyOpenAiCredential).not.toHaveBeenCalled();
  });

  it('17. cutover de resend SIN verify_to → no_verify_to, sin escribir nada', async () => {
    const { sql, providerState, stateWrites } = fakeSql();
    await seedCredential(sql);

    const r = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'resend',
      { changedBy: 'carlos' },
    );

    expect(r).toMatchObject({ ok: false, code: 'no_verify_to' });
    expect(providerState.ownership).toBe('managed');
    expect(stateWrites).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('cutover OpenAI (G1, byok §7.12) — Evidencia A, sin flip', () => {
  const OPENAI_SEED = {
    id: 'openai',
    name: 'OpenAI',
    ownership: 'managed',
    ownership_flippable: true,
  };
  const OPENAI_KEY = 'sk-proj-DelClienteDeVerdad_4u7q';

  it('18. la key verificada con uso real deja pending_verification, NUNCA owned', async () => {
    const { sql, providerState, stateWrites } = fakeSql(OPENAI_SEED);
    await seedCredential(sql, OPENAI_KEY, 'openai');
    vi.mocked(realOpenAiCompletion).mockImplementation(async () => {
      callOrder.push('net:openai-completion');
      return {
        ok: true,
        response_id: 'chatcmpl-abc123',
        model: 'gpt-4o-mini',
        organization: 'org-cliente-xyz',
      };
    });

    const r = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'openai',
      { changedBy: 'carlos' },
    );

    // El resultado es el estado honesto: verificada, pero el gateway sigue
    // siendo nuestro — `owned` recién con la Evidencia B (G2).
    expect(r).toMatchObject({
      ok: true,
      ownership: 'pending_verification',
      evidence: {
        response_id: 'chatcmpl-abc123',
        model: 'gpt-4o-mini',
        organization: 'org-cliente-xyz',
      },
    });
    expect(providerState.ownership).toBe('managed');
    expect(providerState.status).toBe('pending_verification');
    // pending_verification se escribió ANTES de salir a la red (T7.1).
    expect(callOrder.indexOf('state:pending_verification')).toBeLessThan(
      callOrder.indexOf('net:openai-completion'),
    );
    // La evidencia queda en notes; el flip no invalida ningún cache porque no
    // hubo flip.
    const last = stateWrites[stateWrites.length - 1];
    expect(String(last.notes)).toContain('chatcmpl-abc123');
    expect(String(last.notes)).toContain('org-cliente-xyz');
    expect(invalidateProviderCache).not.toHaveBeenCalled();
    // El gate de mail no participa: es de Resend.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(verifyEmailCredential).not.toHaveBeenCalled();
  });

  it('19. la completion rechazada deja failed + credential_rejected, ownership intacto', async () => {
    const { sql, providerState } = fakeSql(OPENAI_SEED);
    await seedCredential(sql, OPENAI_KEY, 'openai');
    vi.mocked(realOpenAiCompletion).mockResolvedValue({
      ok: false,
      error_code: 'insufficient_quota',
      error_message: 'You exceeded your current quota',
      http_status: 429,
    });

    const r = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'openai',
      { changedBy: 'carlos' },
    );

    expect(r).toMatchObject({ ok: false, code: 'credential_rejected' });
    expect(r.ok ? '' : r.message).toContain('insufficient_quota');
    expect(providerState.ownership).toBe('managed');
    expect(providerState.status).toBe('failed');
    expect(invalidateProviderCache).not.toHaveBeenCalled();
  });

  it('20. el plaintext de la key no se filtra ni al log ni al estado', async () => {
    const { sql, stateWrites } = fakeSql(OPENAI_SEED);
    await seedCredential(sql, OPENAI_KEY, 'openai');
    vi.mocked(realOpenAiCompletion).mockResolvedValue({
      ok: true,
      response_id: 'chatcmpl-x',
      model: 'gpt-4o-mini',
      organization: null,
    });

    await cutoverProviderToOwned({ sql, logger, clientSlug: 'palmadevai' }, 'openai', {
      changedBy: 'carlos',
    });

    expect(JSON.stringify(logged)).not.toContain(OPENAI_KEY);
    expect(JSON.stringify(stateWrites)).not.toContain(OPENAI_KEY);
  });

  it('21. sin credencial cargada → no_credential, sin llamar a OpenAI', async () => {
    const { sql, stateWrites } = fakeSql(OPENAI_SEED);

    const r = await cutoverProviderToOwned(
      { sql, logger, clientSlug: 'palmadevai' },
      'openai',
      { changedBy: 'carlos' },
    );

    expect(r).toMatchObject({ ok: false, code: 'no_credential' });
    expect(stateWrites).toHaveLength(0);
    expect(realOpenAiCompletion).not.toHaveBeenCalled();
  });
});
