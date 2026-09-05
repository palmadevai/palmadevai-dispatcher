/**
 * F8.6 (plan WABA) — `resolveWaEndpointAccessToken`: el token por endpoint sólo
 * cuando la fila existe, está viva y lo tiene; y la distinción que importa en
 * la flota: tabla AUSENTE (familia outbound no instalada — palmawebs) es `null`
 * sin ruido, cualquier otro error del SQL lanza.
 */
import { describe, it, expect } from 'vitest';
import { resolveWaEndpointAccessToken } from '../pick-phone.js';

type Row = { access_token: string | null; status: string };

function fakeSql(impl: (values: unknown[]) => Promise<Row[]>) {
  // Simula el tagged template de postgres.js: (strings, ...values).
  return ((_strings: TemplateStringsArray, ...values: unknown[]) => impl(values)) as unknown as Parameters<
    typeof resolveWaEndpointAccessToken
  >[0];
}

describe('resolveWaEndpointAccessToken (F8.6)', () => {
  it('devuelve el token del endpoint cuando la fila existe, está activa y lo tiene', async () => {
    const sql = fakeSql(async (values) => {
      expect(values).toEqual(['1084221031440213']);
      return [{ access_token: 'tok-endpoint', status: 'active' }];
    });
    await expect(resolveWaEndpointAccessToken(sql, '1084221031440213')).resolves.toBe('tok-endpoint');
  });

  it('sin fila → null (el caller cae al piso 1)', async () => {
    const sql = fakeSql(async () => []);
    await expect(resolveWaEndpointAccessToken(sql, 'x')).resolves.toBeNull();
  });

  it('fila con access_token NULL o vacío → null', async () => {
    await expect(
      resolveWaEndpointAccessToken(fakeSql(async () => [{ access_token: null, status: 'active' }]), 'x'),
    ).resolves.toBeNull();
    await expect(
      resolveWaEndpointAccessToken(fakeSql(async () => [{ access_token: '   ', status: 'active' }]), 'x'),
    ).resolves.toBeNull();
  });

  it('endpoint disabled → null aunque tenga token', async () => {
    const sql = fakeSql(async () => [{ access_token: 'tok', status: 'disabled' }]);
    await expect(resolveWaEndpointAccessToken(sql, 'x')).resolves.toBeNull();
  });

  it('tabla ausente (42P01, familia outbound no instalada) → null SIN lanzar', async () => {
    const sql = fakeSql(async () => {
      throw Object.assign(new Error('relation "bot.outbound_endpoints" does not exist'), { code: '42P01' });
    });
    await expect(resolveWaEndpointAccessToken(sql, 'x')).resolves.toBeNull();
  });

  it('cualquier otro error del SQL LANZA (no se traga)', async () => {
    const sql = fakeSql(async () => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    });
    await expect(resolveWaEndpointAccessToken(sql, 'x')).rejects.toThrow('connection refused');
  });
});
