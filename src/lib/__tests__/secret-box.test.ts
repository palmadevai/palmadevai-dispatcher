import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { seal, open, parseMasterKey, sameKey, SecretBoxError, type MasterKeys } from '../secret-box.js';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const keys: MasterKeys = { current: { version: 1, key: k1 } };
const rotating: MasterKeys = { current: { version: 2, key: k2 }, previous: { version: 1, key: k1 } };

const CTX = { clientSlug: 'palmadevai', providerId: 'resend' };
const SECRET = 're_TestKeyThatLooksLikeResend_a3f9';

describe('secret-box', () => {
  it('round-trip: lo que se cifra se recupera igual', () => {
    const sealed = seal({ plaintext: SECRET, ...CTX, keys });
    expect(open({ sealed, ...CTX, keys })).toBe(SECRET);
  });

  it('el plaintext NO aparece en el ciphertext', () => {
    const sealed = seal({ plaintext: SECRET, ...CTX, keys });
    expect(sealed.ciphertext.toString('utf8')).not.toContain('re_');
    expect(sealed.ciphertext.toString('base64')).not.toContain(SECRET);
  });

  it('cifrar dos veces el mismo secreto da ciphertexts distintos (IV aleatorio)', () => {
    // Si el IV fuera fijo, dos filas con la misma key darían el mismo blob y
    // se podría saber que dos clientes usan la misma credencial sin descifrar.
    const a = seal({ plaintext: SECRET, ...CTX, keys });
    const b = seal({ plaintext: SECRET, ...CTX, keys });
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(open({ sealed: a, ...CTX, keys })).toBe(open({ sealed: b, ...CTX, keys }));
  });

  it('guarda last4 en claro y nada más del secreto', () => {
    const sealed = seal({ plaintext: SECRET, ...CTX, keys });
    expect(sealed.last4).toBe('a3f9');
    expect(SECRET).toContain(sealed.last4);
    expect(sealed.last4.length).toBe(4);
  });

  // ── El AAD: el ciphertext está atado a SU fila ────────────────────────────

  it('un blob movido a OTRO provider no abre', () => {
    const sealed = seal({ plaintext: SECRET, ...CTX, keys });
    expect(() => open({ sealed, clientSlug: 'palmadevai', providerId: 'openai', keys })).toThrow(
      SecretBoxError,
    );
  });

  it('un blob movido a la base de OTRO cliente no abre', () => {
    const sealed = seal({ plaintext: SECRET, ...CTX, keys });
    expect(() => open({ sealed, clientSlug: 'palmawebs', providerId: 'resend', keys })).toThrow(
      SecretBoxError,
    );
  });

  it('con la master key equivocada no abre', () => {
    const sealed = seal({ plaintext: SECRET, ...CTX, keys });
    const otra: MasterKeys = { current: { version: 1, key: k2 } };
    expect(() => open({ sealed, ...CTX, keys: otra })).toThrow(SecretBoxError);
  });

  it('un ciphertext manipulado no abre — el tag lo detecta', () => {
    const sealed = seal({ plaintext: SECRET, ...CTX, keys });
    sealed.ciphertext[0] ^= 0xff;
    expect(() => open({ sealed, ...CTX, keys })).toThrow(SecretBoxError);
  });

  it('un auth_tag manipulado no abre', () => {
    const sealed = seal({ plaintext: SECRET, ...CTX, keys });
    sealed.auth_tag[0] ^= 0xff;
    expect(() => open({ sealed, ...CTX, keys })).toThrow(SecretBoxError);
  });

  it('el error no filtra el secreto ni la llave', () => {
    const sealed = seal({ plaintext: SECRET, ...CTX, keys });
    try {
      open({ sealed, clientSlug: 'otro', providerId: 'resend', keys });
      expect.unreachable('tenía que tirar');
    } catch (err) {
      const msg = String(err);
      expect(msg).not.toContain(SECRET);
      expect(msg).not.toContain(k1.toString('base64'));
      expect(msg).toContain('resend'); // sí nombra el proveedor: es lo accionable
    }
  });

  // ── Rotación de master key ────────────────────────────────────────────────

  it('durante una rotación, lo cifrado con la llave vieja sigue abriendo', () => {
    const viejo = seal({ plaintext: SECRET, ...CTX, keys }); // version 1
    expect(open({ sealed: viejo, ...CTX, keys: rotating })).toBe(SECRET);
  });

  it('lo nuevo se cifra SIEMPRE con current, nunca con previous', () => {
    const sealed = seal({ plaintext: SECRET, ...CTX, keys: rotating });
    expect(sealed.key_version).toBe(2);
  });

  it('sin la versión que pide la fila, el error dice qué cargar', () => {
    const viejo = seal({ plaintext: SECRET, ...CTX, keys }); // version 1
    const soloNueva: MasterKeys = { current: { version: 2, key: k2 } };
    expect(() => open({ sealed: viejo, ...CTX, keys: soloNueva })).toThrow(
      /SECRETS_MASTER_KEY_PREVIOUS/,
    );
  });

  // ── Guardas de entrada ────────────────────────────────────────────────────

  it('un algoritmo desconocido se rechaza en vez de intentarse', () => {
    const sealed = seal({ plaintext: SECRET, ...CTX, keys });
    expect(() => open({ sealed: { ...sealed, algo: 'aes-128-cbc' }, ...CTX, keys })).toThrow(
      /algoritmo desconocido/,
    );
  });

  it('no se guarda un secreto vacío', () => {
    expect(() => seal({ plaintext: '', ...CTX, keys })).toThrow(/vacío/);
  });

  it('parseMasterKey exige 32 bytes y dice cómo generarla', () => {
    expect(parseMasterKey(k1.toString('base64'), 'SECRETS_MASTER_KEY')).toEqual(k1);
    // Un base64 corto decodifica SIN error: si no se validara el largo, esto
    // reventaría recién en el primer cifrado, en producción.
    expect(() => parseMasterKey(randomBytes(16).toString('base64'), 'SECRETS_MASTER_KEY')).toThrow(
      /openssl rand -base64 32/,
    );
  });

  it('sameKey detecta una "rotación" que no rotó nada', () => {
    expect(sameKey(k1, Buffer.from(k1))).toBe(true);
    expect(sameKey(k1, k2)).toBe(false);
  });

  it('banca un secreto largo y con unicode (un PEM, por ejemplo)', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${randomBytes(900).toString('base64')}\n-----END PRIVATE KEY-----\nñ á 🔑`;
    const sealed = seal({ plaintext: pem, ...CTX, keys });
    expect(open({ sealed, ...CTX, keys })).toBe(pem);
  });
});
