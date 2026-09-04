/**
 * R8 — `POST /mark-read`: auth fail-closed, resolución del número y traducción
 * del resultado a HTTP. El provider se mockea (no se habla con Meta).
 *
 * Los dos casos que fijan el BUG que este endpoint reemplaza:
 *   - el número ausente da 502 CON LA CAUSA, no un 500 mudo;
 *   - un rechazo de Meta da 502, no un 200 optimista. El nodo n8n que había
 *     antes usaba `neverError: true` y devolvía éxito siempre: en palmawebs el
 *     mark-as-read no funcionó por meses sin un solo error en el log.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from '../../../lib/logger.js';

const markReadWhatsApp = vi.fn();
vi.mock('../../../providers/whatsapp.js', () => ({
  markReadWhatsApp: (...args: unknown[]) => markReadWhatsApp(...args),
}));

const { registerMarkReadRoute } = await import('../mark-read-route.js');

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

async function build(deps: {
  sendBearer?: string | undefined;
  defaultWaPhoneNumberId?: string | undefined;
  /** F8.6 — lo que devuelve la lectura de `bot.outbound_endpoints.access_token`. */
  resolveEndpointAccessToken?: (phoneNumberId: string) => Promise<string | null>;
  logger?: Logger;
}): Promise<FastifyInstance> {
  const app = Fastify();
  const resolvedPhone =
    'defaultWaPhoneNumberId' in deps ? (deps.defaultWaPhoneNumberId ?? null) : '1234567890';
  registerMarkReadRoute(app, {
    logger: deps.logger ?? makeLogger(),
    sendBearer: 'sendBearer' in deps ? deps.sendBearer : 'secreto',
    resolveDefaultPhoneNumberId: async () => resolvedPhone,
    resolveEndpointAccessToken: deps.resolveEndpointAccessToken ?? (async () => null),
  });
  await app.ready();
  return app;
}

const OK_BODY = { channel: 'whatsapp', message_id: 'wamid.ABC' };
const AUTH = { authorization: 'Bearer secreto' };

describe('POST /mark-read', () => {
  beforeEach(() => {
    markReadWhatsApp.mockReset();
    markReadWhatsApp.mockResolvedValue({ ok: true, http_status: 200 });
  });

  it('sin DISPATCHER_SEND_BEARER la ruta es fail-closed (503)', async () => {
    const app = await build({ sendBearer: undefined });
    const res = await app.inject({ method: 'POST', url: '/mark-read', payload: OK_BODY });
    expect(res.statusCode).toBe(503);
    expect(markReadWhatsApp).not.toHaveBeenCalled();
  });

  it('sin authorization da 401 y NO llama a Meta', async () => {
    const app = await build({});
    const res = await app.inject({ method: 'POST', url: '/mark-read', payload: OK_BODY });
    expect(res.statusCode).toBe(401);
    expect(markReadWhatsApp).not.toHaveBeenCalled();
  });

  it('con bearer equivocado da 401', async () => {
    const app = await build({});
    const res = await app.inject({
      method: 'POST',
      url: '/mark-read',
      headers: { authorization: 'Bearer otro' },
      payload: OK_BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(markReadWhatsApp).not.toHaveBeenCalled();
  });

  it('body sin message_id da 400', async () => {
    const app = await build({});
    const res = await app.inject({
      method: 'POST',
      url: '/mark-read',
      headers: AUTH,
      payload: { channel: 'whatsapp' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
  });

  it('usa el número DEFAULT del cliente cuando el body no lo manda', async () => {
    const app = await build({});
    const res = await app.inject({
      method: 'POST',
      url: '/mark-read',
      headers: AUTH,
      payload: OK_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'read' });
    expect(markReadWhatsApp).toHaveBeenCalledWith({
      phone_number_id: '1234567890',
      message_id: 'wamid.ABC',
    });
  });

  it('el phone_number_id explícito GANA sobre el default (multi-WABA)', async () => {
    const app = await build({});
    await app.inject({
      method: 'POST',
      url: '/mark-read',
      headers: AUTH,
      payload: { ...OK_BODY, phone_number_id: '999' },
    });
    expect(markReadWhatsApp).toHaveBeenCalledWith({
      phone_number_id: '999',
      message_id: 'wamid.ABC',
    });
  });

  it('sin número configurado da 502 NOMBRANDO la causa, no un 500 mudo', async () => {
    const app = await build({ defaultWaPhoneNumberId: undefined });
    const res = await app.inject({
      method: 'POST',
      url: '/mark-read',
      headers: AUTH,
      payload: OK_BODY,
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error_code).toBe('missing_phone_number_id');
    // El mensaje nombra las DOS fuentes (seguimiento channel-whatsapp-config):
    // DB `bot.config['channel_whatsapp'].default_phone_number_id` y env
    // `META_WA_DEFAULT_PHONE_NUMBER_ID`.
    expect(body.error_message).toContain("bot.config['channel_whatsapp'].default_phone_number_id");
    expect(body.error_message).toContain('META_WA_DEFAULT_PHONE_NUMBER_ID');
    // Y no se intenta el request: sin número, la URL sería `/v24.0//messages`,
    // que es exactamente el bug que traía el nodo de n8n en palmawebs.
    expect(markReadWhatsApp).not.toHaveBeenCalled();
  });

  it('un rechazo de Meta da 502 — NUNCA un 200 optimista', async () => {
    markReadWhatsApp.mockResolvedValue({
      ok: false,
      http_status: 400,
      error_code: '131047',
      error_message: 'Message expired',
    });
    const app = await build({});
    const res = await app.inject({
      method: 'POST',
      url: '/mark-read',
      headers: AUTH,
      payload: OK_BODY,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      status: 'failed',
      error_code: '131047',
      error_message: 'Message expired',
    });
  });

  // ── F8.6 / F6.8.b — el token fijado al número (multi-app / multi-WABA) ────

  it('F8.6: usa el token PROPIO del endpoint cuando bot.outbound_endpoints lo tiene', async () => {
    markReadWhatsApp.mockResolvedValue({ ok: true, http_status: 200, token_source: 'endpoint' });
    const resolveEndpointAccessToken = vi.fn().mockResolvedValue('tok-del-endpoint');
    const app = await build({ resolveEndpointAccessToken });
    const res = await app.inject({
      method: 'POST',
      url: '/mark-read',
      headers: AUTH,
      payload: { ...OK_BODY, phone_number_id: '999' },
    });
    expect(res.statusCode).toBe(200);
    // Se busca por el número por el que ENTRÓ el mensaje, no por el default.
    expect(resolveEndpointAccessToken).toHaveBeenCalledWith('999');
    expect(markReadWhatsApp).toHaveBeenCalledWith({
      phone_number_id: '999',
      message_id: 'wamid.ABC',
      access_token: 'tok-del-endpoint',
    });
    // Y la respuesta DICE de dónde salió el token: es lo que lee el smoke.
    expect(res.json()).toEqual({ status: 'read', token_source: 'endpoint' });
  });

  it('F8.6: sin token en la fila NO manda access_token — el provider cae al piso 1', async () => {
    markReadWhatsApp.mockResolvedValue({ ok: true, http_status: 200, token_source: 'vault' });
    const app = await build({ resolveEndpointAccessToken: async () => null });
    const res = await app.inject({ method: 'POST', url: '/mark-read', headers: AUTH, payload: OK_BODY });
    expect(res.statusCode).toBe(200);
    expect(markReadWhatsApp).toHaveBeenCalledWith({
      phone_number_id: '1234567890',
      message_id: 'wamid.ABC',
    });
    expect(res.json().token_source).toBe('vault');
  });

  it('F8.6: si la lectura del endpoint LANZA, se avisa y se marca igual con el global', async () => {
    const logger = makeLogger();
    const app = await build({
      logger,
      resolveEndpointAccessToken: async () => {
        throw new Error('relation "bot.outbound_endpoints" does not exist');
      },
    });
    const res = await app.inject({ method: 'POST', url: '/mark-read', headers: AUTH, payload: OK_BODY });
    // Un tilde azul no justifica un 500: se cae al global y se deja rastro.
    expect(res.statusCode).toBe(200);
    expect(markReadWhatsApp).toHaveBeenCalledWith({
      phone_number_id: '1234567890',
      message_id: 'wamid.ABC',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('outbound_endpoints') }),
      expect.stringContaining('token del endpoint'),
    );
  });

  it('F8.6: el 502 también dice con qué token se intentó', async () => {
    markReadWhatsApp.mockResolvedValue({
      ok: false,
      http_status: 401,
      error_code: '190',
      error_message: 'Invalid OAuth access token',
      token_source: 'endpoint',
    });
    const app = await build({ resolveEndpointAccessToken: async () => 'tok-vencido' });
    const res = await app.inject({ method: 'POST', url: '/mark-read', headers: AUTH, payload: OK_BODY });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      status: 'failed',
      error_code: '190',
      error_message: 'Invalid OAuth access token',
      token_source: 'endpoint',
    });
  });

  it('un canal que no es whatsapp da 400 (no hay read receipts en otros)', async () => {
    const app = await build({});
    const res = await app.inject({
      method: 'POST',
      url: '/mark-read',
      headers: AUTH,
      payload: { channel: 'instagram', message_id: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(markReadWhatsApp).not.toHaveBeenCalled();
  });
});
