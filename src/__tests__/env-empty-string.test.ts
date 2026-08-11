/**
 * El contrato que faltaba y costó un crash-loop en producción (2026-08-10).
 *
 * En este modelo de deploy una env opcional NUNCA llega `undefined`: la lista
 * curada `environment:` del compose la declara como `X: ${X:-}`, así que el
 * container la recibe **presente y vacía**. Todo test que valide el schema con
 * la variable AUSENTE está probando un escenario que no existe en producción.
 *
 * Por eso estos casos setean `''` explícitamente: es el valor real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const BASE: Record<string, string> = {
  REDIS_PASSWORD: 'x',
  APPDB_PASSWORD: 'x',
  META_WA_BEARER_TOKEN: 'x',
  META_WA_APP_SECRET: 'x',
  META_WA_WABA_ID: 'x',
  CLIENT_SLUG: 'palmadevai',
  DOMAIN: 'devpalmawebs.com.ar',
};

/** Carga `src/env.ts` fresco con el entorno dado. */
async function loadEnv(extra: Record<string, string>) {
  const prev = process.env;
  process.env = { ...BASE, ...extra } as NodeJS.ProcessEnv;
  try {
    // `env.ts` valida al importarse, así que hay que descartar el módulo
    // cacheado para que cada caso vuelva a evaluar el schema.
    vi.resetModules();
    const mod = await import('../env.js');
    return mod.env as unknown as Record<string, unknown>;
  } finally {
    process.env = prev;
  }
}

describe('env: los opcionales llegan VACÍOS del compose, no ausentes', () => {
  let exitSpy: { restore: () => void; called: boolean };

  beforeEach(() => {
    const orig = process.exit;
    const state = { called: false };
    // @ts-expect-error firma de test
    process.exit = () => {
      state.called = true;
      throw new Error('process.exit');
    };
    exitSpy = { restore: () => (process.exit = orig), get called() { return state.called; } };
  });
  afterEach(() => exitSpy.restore());

  it('SECRETS_MASTER_KEY_PREVIOUS_VERSION="" NO mata el proceso', async () => {
    // Éste es el caso exacto del incidente: `.min(1).optional()` sobre un
    // coerce hacía 0 → validación fallida → FATAL al boot.
    const env = await loadEnv({
      SECRETS_MASTER_KEY: '',
      SECRETS_MASTER_KEY_PREVIOUS: '',
      SECRETS_MASTER_KEY_PREVIOUS_VERSION: '',
    });
    expect(env.SECRETS_MASTER_KEY_PREVIOUS_VERSION).toBeUndefined();
  });

  it('vacío es "no configurada", NUNCA cero', async () => {
    const env = await loadEnv({ CAMPAIGNS_DEFAULT_DAILY_CAP_OVERRIDE: '' });
    // Un 0 acá significaría «tope diario cero» = bloqueo total de envíos.
    expect(env.CAMPAIGNS_DEFAULT_DAILY_CAP_OVERRIDE).not.toBe(0);
    expect(env.CAMPAIGNS_DEFAULT_DAILY_CAP_OVERRIDE).toBeUndefined();
  });

  it('con valor real, sigue parseando', async () => {
    const env = await loadEnv({
      SECRETS_MASTER_KEY_PREVIOUS_VERSION: '3',
      CAMPAIGNS_DEFAULT_DAILY_CAP_OVERRIDE: '500',
    });
    expect(env.SECRETS_MASTER_KEY_PREVIOUS_VERSION).toBe(3);
    expect(env.CAMPAIGNS_DEFAULT_DAILY_CAP_OVERRIDE).toBe(500);
  });

  it('un valor INVÁLIDO sigue siendo fatal — el fix no aflojó la validación', async () => {
    // La lección no es «aceptar cualquier cosa»: es que vacío ≠ inválido.
    await expect(loadEnv({ SECRETS_MASTER_KEY_PREVIOUS_VERSION: '0' })).rejects.toThrow();
  });

  it('el stack entero arranca con TODOS los opcionales en vacío', async () => {
    // Es literalmente lo que hace el compose de un cliente recién desplegado.
    const env = await loadEnv({
      SECRETS_MASTER_KEY: '',
      SECRETS_MASTER_KEY_PREVIOUS: '',
      SECRETS_MASTER_KEY_PREVIOUS_VERSION: '',
      CAMPAIGNS_DEFAULT_DAILY_CAP_OVERRIDE: '',
      DISPATCHER_SEND_BEARER: '',
      MESSAGING_MCP_BEARER: '',
      MESSAGING_MCP_WRITE_BEARER: '',
      RESEND_API_KEY: '',
      CAMPAIGNS_DEFAULT_FROM_EMAIL: '',
      COCKPIT_INTERNAL_TOKEN: '',
    });
    expect(env.CLIENT_SLUG).toBe('palmadevai');
  });
});
