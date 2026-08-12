/**
 * El pase de re-cifrado (F5) — lo que fija este archivo:
 *   - una rotación en curso (current v2 + previous v1) migra las filas v1 y
 *     deja intactas las v2;
 *   - una fila que NO abre se reporta y NO se toca (re-escribirla destruiría
 *     el único ciphertext que quizá abra con una llave que sigue en BW);
 *   - el UPDATE es optimista: si el cliente reemplazó la credencial en el
 *     medio, el pase no la pisa;
 *   - `status` dice si cada fila abre SIN devolver jamás el plaintext.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

const KEY_V1 = randomBytes(32);
const KEY_V2 = randomBytes(32);

vi.mock('../../env.js', () => ({
  env: {
    SECRETS_MASTER_KEY: KEY_V2.toString('base64'),
    SECRETS_MASTER_KEY_VERSION: 2,
    SECRETS_MASTER_KEY_PREVIOUS: KEY_V1.toString('base64'),
    SECRETS_MASTER_KEY_PREVIOUS_VERSION: 1,
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

const { seal, open } = await import('../../lib/secret-box.js');
const { secretsStatus, reencryptSecrets } = await import('../secret-reencrypt.js');

const SLUG = 'palmadevai';
const SECRET = 're_LaKeyDelCliente_77aa';

type Row = Record<string, unknown>;

/** Tablita en memoria con el mismo contrato que las queries reales. */
function fakeSql(rows: Map<string, Row>) {
  return ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join(' ');
    if (q.includes('SELECT provider_id')) {
      return Promise.resolve([...rows.values()].map((r) => ({ ...r })));
    }
    if (q.includes('UPDATE config.client_provider_secrets')) {
      const [key_version, iv, auth_tag, ciphertext, provider_id, oldIv] = vals;
      const row = rows.get(String(provider_id));
      if (!row || !(row.iv as Buffer).equals(oldIv as Buffer)) return Promise.resolve([]);
      Object.assign(row, { key_version, iv, auth_tag, ciphertext });
      return Promise.resolve([{ provider_id }]);
    }
    throw new Error('query inesperada: ' + q);
  }) as never;
}

function sealedRow(providerId: string, version: 1 | 2, plaintext = SECRET): Row {
  const key = version === 1 ? KEY_V1 : KEY_V2;
  const sealed = seal({
    plaintext,
    clientSlug: SLUG,
    providerId,
    keys: { current: { version, key } },
  });
  return {
    provider_id: providerId,
    ...sealed,
    created_at: new Date('2026-08-11T12:00:00Z'),
    created_by: 'carlos',
    rotated_at: null,
  };
}

describe('reencryptSecrets', () => {
  beforeEach(() => (logged.length = 0));

  it('migra las filas v1 a v2 y el secreto sigue abriendo igual', async () => {
    const rows = new Map<string, Row>([
      ['resend', sealedRow('resend', 1)],
      ['openai', sealedRow('openai', 2, 'sk-otra-cosa-1234')],
    ]);
    const deps = { sql: fakeSql(rows), logger, clientSlug: SLUG };

    const result = await reencryptSecrets(deps);
    expect(result).toMatchObject({
      ok: true,
      current_version: 2,
      total: 2,
      already_current: 1,
      reencrypted: ['resend'],
      raced: [],
      failed: [],
    });

    // La fila migrada abre con la llave NUEVA sola (sin previous).
    const migrated = rows.get('resend')!;
    expect(migrated.key_version).toBe(2);
    const plaintext = open({
      sealed: migrated as never,
      clientSlug: SLUG,
      providerId: 'resend',
      keys: { current: { version: 2, key: KEY_V2 } },
    });
    expect(plaintext).toBe(SECRET);
    // last4 y audit no se tocan: la credencial no cambió, cambió la llave.
    expect(migrated.last4).toBe(SECRET.slice(-4));
    expect(migrated.rotated_at).toBeNull();
  });

  it('es idempotente: la segunda corrida no toca nada', async () => {
    const rows = new Map<string, Row>([['resend', sealedRow('resend', 1)]]);
    const deps = { sql: fakeSql(rows), logger, clientSlug: SLUG };

    await reencryptSecrets(deps);
    const second = await reencryptSecrets(deps);
    expect(second).toMatchObject({ ok: true, already_current: 1, reencrypted: [] });
  });

  it('una fila que no abre se reporta y NO se toca', async () => {
    const corrupt = sealedRow('resend', 1);
    corrupt.ciphertext = randomBytes((corrupt.ciphertext as Buffer).length);
    const originalIv = corrupt.iv as Buffer;
    const rows = new Map<string, Row>([['resend', corrupt]]);
    const deps = { sql: fakeSql(rows), logger, clientSlug: SLUG };

    const result = await reencryptSecrets(deps);
    expect(result.ok).toBe(false);
    if (!('total' in result)) throw new Error('unreachable');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].provider_id).toBe('resend');
    // Intacta: mismo iv, misma versión.
    expect((rows.get('resend')!.iv as Buffer).equals(originalIv)).toBe(true);
    expect(rows.get('resend')!.key_version).toBe(1);
  });

  it('una fila reemplazada en el medio (iv distinto) cuenta como raced, no como error', async () => {
    const row = sealedRow('resend', 1);
    const rows = new Map<string, Row>([['resend', row]]);
    // SELECT devuelve una copia; el "cliente" reemplaza la fila después del read.
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join(' ');
      if (q.includes('SELECT provider_id')) {
        const snapshot = [{ ...row }];
        Object.assign(row, sealedRow('resend', 2, 're_reemplazada_zz99'));
        return Promise.resolve(snapshot);
      }
      return fakeSql(rows)(strings, ...vals);
    }) as never;

    const result = await reencryptSecrets({ sql, logger, clientSlug: SLUG });
    expect(result).toMatchObject({ ok: true, raced: ['resend'], reencrypted: [] });
    expect(rows.get('resend')!.last4).toBe('zz99');
  });
});

describe('secretsStatus', () => {
  it('reporta decryptable por fila, con las dos llaves de la rotación', async () => {
    const corrupt = sealedRow('meta', 1);
    corrupt.auth_tag = randomBytes(16);
    const rows = new Map<string, Row>([
      ['resend', sealedRow('resend', 1)],
      ['openai', sealedRow('openai', 2)],
      ['meta', corrupt],
    ]);
    const result = await secretsStatus({ sql: fakeSql(rows), logger, clientSlug: SLUG });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.current_version).toBe(2);
    expect(result.previous_version).toBe(1);

    const byId = Object.fromEntries(result.rows.map((r) => [r.provider_id, r]));
    expect(byId.resend.decryptable).toBe(true);
    expect(byId.openai.decryptable).toBe(true);
    expect(byId.meta.decryptable).toBe(false);
    expect(byId.meta.error).toContain('no autentica');

    // El status JAMÁS lleva el secreto ni el ciphertext.
    const dumped = JSON.stringify(result);
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain('ciphertext');
  });
});
