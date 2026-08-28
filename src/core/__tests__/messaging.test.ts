/**
 * F5 — tests for `sendMessage()` / `isWithin24hWindow()`, extracted from
 * `transports/http/send-route.ts` (see `../messaging.ts` for the guard order
 * this exercises). Mocking style cloned from
 * `transports/http/__tests__/send-route.test.ts`: fake sql/redis/logger +
 * `vi.mock` on the provider port. `../budget.js` is ALSO mocked here (unlike
 * the send-route test) so budget scenarios don't need to reconstruct rate
 * card / config / spend query fixtures — we only care that `sendMessage`
 * reacts correctly to whatever `checkBudget` returns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { SqlClient } from '../../lib/postgres.js';
import type { Logger } from '../../lib/logger.js';
import type { OutboundMessage } from '../schemas.js';
import type { ProviderSendResult } from '../../providers/types.js';
import type { SendDeps } from '../messaging.js';

const mockSend = vi.fn<(input: unknown) => Promise<ProviderSendResult>>();
const mockGetProviderForChannel = vi.fn((_channel: string) => ({ channel: 'whatsapp', send: mockSend }));

vi.mock('../../ports/channel-provider.js', () => ({
  getProviderForChannel: (channel: string) => mockGetProviderForChannel(channel),
}));

const mockCheckBudget = vi.fn();
const mockRecordSendUsage = vi.fn();
const mockMaybeAlert = vi.fn();

vi.mock('../budget.js', () => ({
  checkBudget: (...args: unknown[]) => mockCheckBudget(...args),
  recordSendUsage: (...args: unknown[]) => mockRecordSendUsage(...args),
  maybeAlert: (...args: unknown[]) => mockMaybeAlert(...args),
}));

// vitest hoists vi.mock(...) above imports, so these static imports already
// resolve against the mocked modules.
import { sendMessage, isWithin24hWindow } from '../messaging.js';
import { resetAnnouncedForTests } from '../../lib/pg-errors.js';

function makeFakeSql(responses: unknown[][] = []): SqlClient {
  let i = 0;
  const fn = ((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const r = responses[i] ?? [];
    i += 1;
    return Promise.resolve(r);
  }) as unknown as SqlClient;
  return fn;
}

function makeThrowingSql(): SqlClient {
  return (async () => {
    throw new Error('db down');
  }) as unknown as SqlClient;
}

/** Postgres cuando la tabla no existe: SQLSTATE 42P01 (cliente sin `campaigns`). */
function makeMissingRelationSql(): SqlClient {
  return (async () => {
    throw Object.assign(new Error('relation "bot.personas" does not exist'), {
      code: '42P01',
    });
  }) as unknown as SqlClient;
}

function makeFakeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string, ...rest: unknown[]) => {
      if (rest.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  } as unknown as Redis;
}

function makeThrowingSetRedis(): Redis {
  return {
    set: vi.fn(async () => {
      throw new Error('redis unreachable');
    }),
  } as unknown as Redis;
}

function makeFakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeDeps(overrides: Partial<SendDeps> = {}): SendDeps {
  return {
    sql: makeFakeSql(),
    redis: makeFakeRedis(),
    logger: makeFakeLogger(),
    staffAllowlist: ['+5491111111111'],
    resolveDefaultPhoneNumberId: async () => '1234567890',
    defaultFromEmail: 'ops@example.com',
    ...overrides,
  };
}

let refCounter = 0;
function nextRef(): string {
  refCounter += 1;
  return `ref-${refCounter}`;
}

function makeMsg(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channel: 'whatsapp',
    to: '+5493511111111',
    content: { type: 'text', text: 'hola' },
    context: { feature: 'test-feature', client_ref: nextRef() },
    ...overrides,
  } as OutboundMessage;
}

beforeEach(() => {
  refCounter = 0;
  mockSend.mockReset();
  mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-default' });
  mockGetProviderForChannel.mockClear();
  mockCheckBudget.mockReset();
  mockCheckBudget.mockResolvedValue({ allowed: true, spent_usd: 0, cap_usd: null, pct: 0 });
  mockRecordSendUsage.mockReset();
  mockRecordSendUsage.mockResolvedValue(undefined);
  mockMaybeAlert.mockReset();
  mockMaybeAlert.mockResolvedValue(undefined);
});

describe('sendMessage — happy path', () => {
  it('sends a whatsapp template through the provider and records budget usage', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-123' });
    // opt-out check (empty = no unsubscribe row), resolveCategory lookup.
    const sql = makeFakeSql([[], [{ category: 'marketing' }]]);
    const deps = makeDeps({ sql });
    const msg = makeMsg({
      content: { type: 'template', name: 'welcome', language: 'es' },
      context: { feature: 'f', client_ref: 'ref-happy' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-123' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockRecordSendUsage).toHaveBeenCalledWith(deps.redis, deps.logger, 'whatsapp', 'marketing');
  });
});

describe('sendMessage — idempotency', () => {
  it('returns duplicate and never calls the provider when client_ref repeats', async () => {
    const deps = makeDeps();
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'dup-ref' } });

    await sendMessage(deps, msg);
    mockSend.mockClear();
    const second = await sendMessage(deps, msg);

    expect(second).toEqual({ status: 'duplicate' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ── La clave incluye el DESTINO (2026-08-19) ──────────────────────────────
  //
  // La idempotencia existe para no entregar dos veces el mismo mensaje a la
  // MISMA persona. Deduplicar entre destinatarios distintos no es idempotencia:
  // es perdida de datos, y silenciosa, porque `duplicate` cuenta como «salio»
  // rio arriba (T10.6).
  //
  // Caso testigo: con `notify_to` (R1c/T4.5) aparecieron emisores que mandan a
  // una LISTA con un ref por ejecucion. Del 2do destinatario en adelante no se
  // mandaba NADA y la ejecucion cerraba en verde.
  it('el mismo client_ref a OTRO destinatario SI se manda (no es un duplicado)', async () => {
    const deps = makeDeps();
    const ref = 'fanout-ref';

    const a = await sendMessage(deps, makeMsg({ to: '+5493511111111', context: { feature: 'f', client_ref: ref } }));
    const b = await sendMessage(deps, makeMsg({ to: '+5493512222222', context: { feature: 'f', client_ref: ref } }));

    expect(a.status).toBe('sent');
    expect(b.status).toBe('sent');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('el mismo client_ref al MISMO destinatario sigue siendo duplicado', async () => {
    // La garantia de siempre no se afloja: con un solo destinatario, (ref, to)
    // es 1:1 con ref y el reintento se deduplica igual.
    const deps = makeDeps();
    const ref = 'mismo-destino-ref';

    await sendMessage(deps, makeMsg({ to: '+5493511111111', context: { feature: 'f', client_ref: ref } }));
    mockSend.mockClear();
    const second = await sendMessage(deps, makeMsg({ to: '+5493511111111', context: { feature: 'f', client_ref: ref } }));

    expect(second).toEqual({ status: 'duplicate' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('normaliza el destino: mayusculas y espacios no abren una clave nueva', async () => {
    // Un reintento con diferencias cosmeticas tiene que caer en la misma clave,
    // o el dedup deja de proteger justo en el reintento.
    const deps = makeDeps();
    const ref = 'normaliza-ref';
    const msg = { channel: 'email' as const, from: 'noreply@x.test',
                  content: { type: 'mail' as const, subject: 's', text: 't' } };

    await sendMessage(deps, makeMsg({ ...msg, to: 'Ops@Ejemplo.TEST', context: { feature: 'f', client_ref: ref, kind: 'transactional' } }));
    mockSend.mockClear();
    const second = await sendMessage(deps, makeMsg({ ...msg, to: '  ops@ejemplo.test ', context: { feature: 'f', client_ref: ref, kind: 'transactional' } }));

    expect(second).toEqual({ status: 'duplicate' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('proceeds with the send when the idempotency SET NX throws (fail-open)', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-failopen' });
    const redis = makeThrowingSetRedis();
    const logger = makeFakeLogger();
    const deps = makeDeps({ redis, logger });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-failopen' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-failopen' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('sendMessage — staff allowlist', () => {
  it('acepta el mismo numero cargado sin `+` en la allowlist (incidente 2026-08-03)', async () => {
    // `bot.agents.phone_e164` guarda `+549…`; la allowlist del `.env` se cargó
    // como `549…`. Es el MISMO número: la comparación va en E.164 canónico.
    const deps = makeDeps({ staffAllowlist: ['5491145402018'] });
    const msg = makeMsg({
      to: '+5491145402018',
      context: { feature: 'f', client_ref: 'ref-allow-e164', kind: 'notification' },
    });

    const result = await sendMessage(deps, msg);

    expect(result.status).not.toBe('rejected');
  });

  it('un destino que no es un teléfono válido no se cuela', async () => {
    const deps = makeDeps({ staffAllowlist: ['+5491145402018'] });
    const msg = makeMsg({
      to: 'no-soy-un-telefono',
      context: { feature: 'f', client_ref: 'ref-allow-junk', kind: 'notification' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toMatchObject({ status: 'rejected', reason: 'destination_not_allowed' });
  });

  it('rejects destination_not_allowed for a notification outside STAFF_NOTIFY_ALLOWLIST', async () => {
    const deps = makeDeps({ staffAllowlist: ['+5492222222222'] });
    const msg = makeMsg({
      to: '+5491111111111',
      context: { feature: 'f', client_ref: 'ref-allow', kind: 'notification' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'destination_not_allowed',
      detail: 'destination is not in the staff allowlist',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// La guarda de destino de una notificación por MAIL. Antes de esto la rama de
// teléfonos corría para todo canal, así que `kind:'notification'` +
// `channel:'email'` daba 403 SIEMPRE (`toE164()` sobre una dirección devuelve
// `null`). No era una lista vacía: era que el canal email no tenía lista.
describe('sendMessage — staff allowlist por mail', () => {
  function mailNotification(to: string, ref: string): OutboundMessage {
    return makeMsg({
      channel: 'email',
      to,
      from: 'noreply@ejemplo.test',
      content: { type: 'mail', subject: 'aviso', text: 'cuerpo' },
      context: { feature: 'f', client_ref: ref, kind: 'notification' },
    });
  }

  it('una notificación a la admin_email del cliente SALE (antes daba 403 siempre)', async () => {
    const sql = makeFakeSql([[{ admin_email: 'ops@ejemplo.test' }]]);
    const deps = makeDeps({ sql });

    const result = await sendMessage(deps, mailNotification('ops@ejemplo.test', 'ref-mail-ok'));

    expect(result.status).not.toBe('rejected');
    expect(mockSend).toHaveBeenCalled();
  });

  it('compara sin distinguir mayúsculas ni espacios de los dos lados', async () => {
    // Es un dato cargado a mano desde la UI: exigir coincidencia literal repite
    // el incidente del 2026-08-03 con otro identificador.
    const sql = makeFakeSql([[{ admin_email: '  OPS@Ejemplo.TEST ' }]]);
    const deps = makeDeps({ sql });

    const result = await sendMessage(deps, mailNotification(' ops@ejemplo.test ', 'ref-mail-case'));

    expect(result.status).not.toBe('rejected');
  });

  it('rechaza cualquier otra dirección, y el detail dice DÓNDE se configura', async () => {
    const sql = makeFakeSql([[{ admin_email: 'ops@ejemplo.test' }]]);
    const deps = makeDeps({ sql });

    const result = await sendMessage(deps, mailNotification('ajeno@otro.test', 'ref-mail-no'));

    expect(result).toEqual({
      status: 'rejected',
      reason: 'destination_not_allowed',
      detail:
        "destination is not a staff address (bot.config['notify_to'] o ['branding'].admin_email)",
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ── T4.5: la allowlist son DOS fuentes ────────────────────────────────────
  //
  // Sin esto, cargar un segundo destinatario en Seguridad → Avisos lo dejaba en
  // 403: cuatro de los cinco emisores migrados mandan con kind='notification',
  // asi que esta guarda los alcanza. La config habria aceptado la direccion y el
  // mail no habria llegado nunca.
  it('una direccion cargada en notify_to TAMBIEN es staff (T4.5)', async () => {
    const sql = makeFakeSql([
      [{ admin_email: 'ops@ejemplo.test', notify_to: ['conta@ejemplo.test'] }],
    ]);
    const deps = makeDeps({ sql });

    const result = await sendMessage(deps, mailNotification('conta@ejemplo.test', 'ref-nt-1'));

    expect(result.status).not.toBe('rejected');
    expect(mockSend).toHaveBeenCalled();
  });

  it('vale la de CUALQUIER feature, no solo la del mensaje', async () => {
    // La guarda contesta "esta direccion es de adentro?", y una direccion que el
    // operador cargo para recibir avisos es del staff del cliente dispare quien
    // dispare. Scopear por feature acoplaria la guarda a que context.feature
    // este bien puesto, y daria el modo de falla confuso de la misma direccion
    // aceptada para un emisor y 403 para otro.
    const sql = makeFakeSql([
      [{ admin_email: null, notify_to: ['a@ejemplo.test', 'b@ejemplo.test'] }],
    ]);
    const deps = makeDeps({ sql });

    const result = await sendMessage(deps, mailNotification('b@ejemplo.test', 'ref-nt-2'));

    expect(result.status).not.toBe('rejected');
  });

  it('notify_to no afloja la guarda: una direccion ajena sigue en 403', async () => {
    const sql = makeFakeSql([
      [{ admin_email: 'ops@ejemplo.test', notify_to: ['conta@ejemplo.test'] }],
    ]);
    const deps = makeDeps({ sql });

    const result = await sendMessage(deps, mailNotification('ajeno@otro.test', 'ref-nt-3'));

    expect(result).toMatchObject({ status: 'rejected', reason: 'destination_not_allowed' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sin admin_email cargada NO se manda (fail-closed, no fail-open)', async () => {
    const sql = makeFakeSql([[{ admin_email: null }]]);
    const deps = makeDeps({ sql });

    const result = await sendMessage(deps, mailNotification('ops@ejemplo.test', 'ref-mail-vacia'));

    expect(result).toMatchObject({ status: 'rejected', reason: 'destination_not_allowed' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('con la query rota tampoco se manda: es una guarda de destino', async () => {
    // El opt-out falla ABIERTO a propósito (§4); esto no. Fallar abierta una
    // guarda de destino la anula justo cuando la base no puede desmentirte.
    const deps = makeDeps({ sql: makeThrowingSql() });

    const result = await sendMessage(deps, mailNotification('ops@ejemplo.test', 'ref-mail-dbdown'));

    expect(result).toMatchObject({ status: 'rejected', reason: 'destination_not_allowed' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('un mail SIN kind:notification no pasa por esta guarda', async () => {
    // La guarda es de notificaciones. Un comprobante va a un tercero por
    // diseño: si esto lo filtrara, no saldría ninguna factura.
    const sql = makeFakeSql([[], []]); // opt-out vacío
    const deps = makeDeps({ sql });
    const msg = makeMsg({
      channel: 'email',
      to: 'cliente-final@otro.test',
      from: 'noreply@ejemplo.test',
      content: { type: 'mail', subject: 'factura', text: 'cuerpo' },
      context: { feature: 'facturacion', client_ref: 'ref-mail-tx', kind: 'transactional' },
    });

    const result = await sendMessage(deps, msg);

    expect(result.status).not.toBe('rejected');
  });
});

// ── T9.8 — la clase `auth` ───────────────────────────────────────────────────
//
// Invitacion, primer acceso y reset de contrasena. Comparte la FORMA de
// `transactional` (se cuenta, no bloquea) y no su motivo: aca el modo de falla
// que se evita no es "se gasto de mas", es que nadie pueda entrar — y el camino
// para arreglarlo pasa por entrar.
describe('sendMessage — clase auth (T9.8)', () => {
  function authMail(to: string, ref: string): OutboundMessage {
    return makeMsg({
      channel: 'email',
      to,
      from: 'onboarding@ejemplo.test',
      content: { type: 'mail', subject: 'Configura tu acceso', text: 'link' },
      context: { feature: 'cockpit-auth', client_ref: ref, kind: 'auth' },
    });
  }

  it('NO pasa por la allowlist de staff: va a quien se esta dando de alta', async () => {
    // Es la diferencia con `notification`. Un invitado no es staff todavia —
    // por definicion, es alguien que aun no tiene acceso.
    const deps = makeDeps({ sql: makeThrowingSql() }); // ninguna guarda debe consultar la DB
    const result = await sendMessage(deps, authMail('flamante@otro.test', 'ref-auth-dest'));

    expect(result.status).not.toBe('rejected');
    expect(mockSend).toHaveBeenCalled();
  });

  it('esta exento de opt-out: la baja de la BUC es sobre marketing', async () => {
    // Un contacto que se dio de baja de las campanas y despues es dado de alta
    // como usuario tiene que recibir su invitacion igual, o queda sin acceso
    // por una decision que tomo sobre otra cosa.
    const sql = makeFakeSql([[{ unsubscribed_at: new Date('2026-01-01') }]]);
    const deps = makeDeps({ sql });

    const result = await sendMessage(deps, authMail('dado-de-baja@otro.test', 'ref-auth-optout'));

    expect(result.status).not.toBe('rejected');
  });

  it('tiene categoria propia, no se disuelve en transactional', async () => {
    // Sin categoria propia, el gasto de auth queda mezclado justo cuando hay
    // que investigar por que nadie pudo loguearse.
    mockCheckBudget.mockResolvedValue({ allowed: true, spent_usd: 0, cap_usd: null, pct: 0 });
    const deps = makeDeps();

    await sendMessage(deps, authMail('quien.sea@otro.test', 'ref-auth-cat'));

    expect(mockCheckBudget).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), 'email', 'auth',
    );
  });

  it('SE CUENTA PERO NO BLOQUEA: con el tope pasado, el mail sale igual', async () => {
    mockCheckBudget.mockResolvedValue({ allowed: false, spent_usd: 99, cap_usd: 5, pct: 20 });
    mockSend.mockResolvedValue({ ok: true, message_id: 'auth-1' });
    const deps = makeDeps();

    const result = await sendMessage(deps, authMail('quien.sea@otro.test', 'ref-auth-budget'));

    expect(result).toEqual({ status: 'sent', message_id: 'auth-1' });
    // La alerta dispara igual: se cuenta, no se tapa.
    expect(mockMaybeAlert).toHaveBeenCalled();
  });

  it('el default NO hereda la exencion: sin kind, el tope sigue capando', async () => {
    mockCheckBudget.mockResolvedValue({ allowed: false, spent_usd: 99, cap_usd: 5, pct: 20 });
    const sql = makeFakeSql([[]]); // opt-out vacio
    const deps = makeDeps({ sql });
    const msg = makeMsg({
      channel: 'email',
      to: 'quien.sea@otro.test',
      from: 'noreply@ejemplo.test',
      content: { type: 'mail', subject: 'x', text: 'y' },
      context: { feature: 'f', client_ref: 'ref-sin-kind-budget' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toMatchObject({ status: 'rejected', reason: 'budget_exceeded' });
  });
});

// ── T6.5 — el estado REAL del proveedor se registra desde el envío ──────────
//
// El schema y la card existen desde T6; lo que faltaba era el escritor. Estos
// casos fijan la parte que importa: **qué cuenta como estado del proveedor y
// qué no**. Si una guarda nuestra —opt-out, tope— pintara la card de rojo, el
// estado volvería a mentir, ahora en la otra dirección.
describe('sendMessage — estado del proveedor (T6.5)', () => {
  function capturingSql(responses: unknown[][] = []) {
    const seen: string[] = [];
    let i = 0;
    const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      seen.push(strings.join(' ? ') + ' :: ' + JSON.stringify(values));
      const r = responses[i] ?? [];
      i += 1;
      return Promise.resolve(r);
    }) as unknown as SqlClient;
    return { sql: fn, writes: () => seen.filter((q) => /client_providers/.test(q)) };
  }

  const mail = (ref: string): OutboundMessage =>
    makeMsg({
      channel: 'email',
      to: 'quien.sea@otro.test',
      from: 'noreply@ejemplo.test',
      content: { type: 'mail', subject: 's', text: 't' },
      context: { feature: 'f', client_ref: ref, kind: 'transactional' },
    });

  it('un envío OK deja el proveedor en ok', async () => {
    const c = capturingSql();
    await sendMessage(makeDeps({ sql: c.sql }), mail('ref-ps-ok'));
    const w = c.writes();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"ok"');
  });

  it('un fallo del proveedor deja failed CON el detalle', async () => {
    mockSend.mockResolvedValue({
      ok: false, http_status: 403,
      error_code: 'validation_error', error_message: 'domain is not verified',
    });
    const c = capturingSql();
    await sendMessage(makeDeps({ sql: c.sql }), mail('ref-ps-fail'));
    const w = c.writes();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"failed"');
    // El detalle es lo unico accionable de la card: sin el, dice "algo anda mal".
    expect(w[0]).toContain('validation_error: domain is not verified');
  });

  it('un rechazo de NUESTRAS guardas no toca el estado del proveedor', async () => {
    // El tope no dice nada de la salud de la cuenta. Pintar la card de rojo por
    // un mensaje que decidimos no mandar seria el mismo estado mentiroso que
    // este escritor viene a arreglar, en la otra direccion.
    mockCheckBudget.mockResolvedValue({ allowed: false, spent_usd: 10, cap_usd: 5, pct: 2 });
    const c = capturingSql([[]]);
    const msg = mail('ref-ps-budget');
    msg.context.kind = undefined; // sin exencion: el tope aplica
    const r = await sendMessage(makeDeps({ sql: c.sql }), msg);
    expect(r).toMatchObject({ status: 'rejected', reason: 'budget_exceeded' });
    expect(c.writes()).toHaveLength(0);
  });

  it('whatsapp no escribe estado: no tiene card de servicio', async () => {
    const c = capturingSql([[], [{ category: 'marketing' }]]);
    await sendMessage(makeDeps({ sql: c.sql }), makeMsg({ context: { feature: 'f', client_ref: 'ref-ps-wa' } }));
    expect(c.writes()).toHaveLength(0);
  });

  it('si el registro falla, el envío igual cuenta como enviado', async () => {
    // El mail ya salio. Un error escribiendo metadata no puede convertirse en
    // un envio perdido.
    mockSend.mockResolvedValue({ ok: true, message_id: 'msg-ps' });
    const r = await sendMessage(makeDeps({ sql: makeThrowingSql() }), mail('ref-ps-dbdown'));
    expect(r).toEqual({ status: 'sent', message_id: 'msg-ps' });
  });
});

describe('sendMessage — opt-out', () => {
  it('rejects opted_out when the contact has unsubscribed_at set', async () => {
    const sql = makeFakeSql([[{ unsubscribed_at: new Date('2026-01-01') }]]);
    const deps = makeDeps({ sql });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-optout' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'opted_out',
      detail: 'contact opted out of messaging',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('proceeds when the contact is absent from the BUC (no opt-out row)', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-noopt' });
    const sql = makeFakeSql([[]]); // opt-out query returns no row
    const deps = makeDeps({ sql });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-noopt' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-noopt' });
  });

  // Cliente SIN la feature `campaigns`: la tabla de la BUC no existe. El envío
  // tiene que salir igual —no hay baja que respetar donde no hay dónde
  // registrarla— pero SIN un `error` por mensaje: eso convertía el log de esos
  // clientes en ruido permanente. Ver `lib/pg-errors.ts`.
  it('la tabla ausente (42P01) no es una falla: manda igual y NO loguea error', async () => {
    resetAnnouncedForTests();
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-sin-buc' });
    const deps = makeDeps({ sql: makeMissingRelationSql() });
    const logger = deps.logger as unknown as { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };

    const result = await sendMessage(deps, makeMsg({ context: { feature: 'f', client_ref: 'ref-sin-buc' } }));

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-sin-buc' });
    expect(logger.error).not.toHaveBeenCalled();
    // El anuncio va en info y una sola vez. Se filtra por mensaje porque
    // `sendMessage` loguea otras cosas en info durante un envío normal.
    const anuncios = logger.info.mock.calls.filter(([, msg]) =>
      String(msg).includes('sin bot.personas'),
    );
    expect(anuncios).toHaveLength(1);
  });

  // La contracara, que es la que hace que el cambio no sea una mordaza: si la
  // query falla por OTRA cosa —permiso revocado, base caída— sigue siendo un
  // error y se grita igual que antes.
  it('un fallo real de la query sigue gritando en error', async () => {
    resetAnnouncedForTests();
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-db-down' });
    const deps = makeDeps({ sql: makeThrowingSql() });
    const logger = deps.logger as unknown as { error: ReturnType<typeof vi.fn> };

    const result = await sendMessage(deps, makeMsg({ context: { feature: 'f', client_ref: 'ref-db-down' } }));

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-db-down' });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('sendMessage — budget', () => {
  it('rejects budget_exceeded when checkBudget disallows the send', async () => {
    mockCheckBudget.mockResolvedValue({ allowed: false, spent_usd: 10, cap_usd: 5, pct: 2 });
    const deps = makeDeps();
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-budget' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'budget_exceeded',
      detail: 'monthly budget cap reached for whatsapp/service',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('bypasses budget_exceeded only for kind=notification + critical=true', async () => {
    mockCheckBudget.mockResolvedValue({ allowed: false, spent_usd: 10, cap_usd: 5, pct: 2 });
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-critical' });
    const deps = makeDeps();
    const msg = makeMsg({
      to: '+5491111111111', // in the default staffAllowlist
      context: { feature: 'f', client_ref: 'ref-critical', kind: 'notification', critical: true },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-critical' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
  // ── T9.2 — la categoria transaccional ─────────────────────────────────────
  it('un comprobante NO se bloquea por el tope de mensajeria', async () => {
    // Contar y capar son cosas distintas: un comprobante fiscal es una
    // obligacion con el cliente final, asi que el tope no puede decidir si sale.
    mockCheckBudget.mockResolvedValue({ allowed: false, spent_usd: 10, cap_usd: 5, pct: 2 });
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-tx' });
    const deps = makeDeps();
    const msg = makeMsg({
      to: '+5491111111111',
      context: { feature: 'facturacion', client_ref: 'ref-tx', kind: 'transactional' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-tx' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('pero SI se cuenta: la alerta de budget sigue mirandolo', async () => {
    // El bypass es sobre el bloqueo, no sobre la visibilidad. Si el volumen
    // transaccional se dispara tiene que verse.
    mockCheckBudget.mockResolvedValue({ allowed: false, spent_usd: 10, cap_usd: 5, pct: 2 });
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-tx2' });
    const deps = makeDeps();
    const msg = makeMsg({
      to: '+5491111111111',
      context: { feature: 'facturacion', client_ref: 'ref-tx2', kind: 'transactional' },
    });

    await sendMessage(deps, msg);

    expect(mockMaybeAlert).toHaveBeenCalled();
    // Y con su categoria propia, no mezclado en `service`.
    expect(mockCheckBudget).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), 'whatsapp', 'transactional',
    );
  });
});

describe('opt-out — el criterio es el TIPO de mensaje, no el canal (T9.3)', () => {
  it('un comprobante NO se frena por la baja de la BUC', async () => {
    // Nadie se da de baja de su propia factura. La exencion es EXPLICITA por
    // `kind`, no un efecto de que la guarda no mirara el canal email.
    mockSend.mockResolvedValue({ ok: true, message_id: 'id-tx-optout' });
    const deps = makeDeps();
    // sql devolveria una baja, pero ni se consulta.
    const msg = makeMsg({
      to: '+5491111111111',
      context: { feature: 'facturacion', client_ref: 'ref-tx-optout', kind: 'transactional' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'id-tx-optout' });
  });

  it('sin `kind` declarado SE CHEQUEA: el default es no estar exento', async () => {
    // Si un emisor se olvida de declarar el kind, el error tiene que ser de
    // mas (chequear) y no de menos (colarse).
    const deps = makeDeps();
    deps.sql = makeFakeSql([[{ unsubscribed_at: new Date() }]]) as unknown as SqlClient;
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-noKind' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'opted_out',
      detail: 'contact opted out of messaging',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('sendMessage — 24h service window (free-form whatsapp text)', () => {
  it('sends free-form text when the contact wrote within the last 24h', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-within' });
    const sql = makeFakeSql([[], [{ last_inbound_at: twoHoursAgo }]]);
    const deps = makeDeps({ sql });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-within' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-within' });
  });

  it('rejects outside_24h_window for free-form text after 24h, and points to a template', async () => {
    const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const sql = makeFakeSql([[], [{ last_inbound_at: thirtyHoursAgo }]]);
    const deps = makeDeps({ sql });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-outside' } });

    const result = await sendMessage(deps, msg);

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toBe('outside_24h_window');
      expect(result.detail).toMatch(/template/i);
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('fail-opens (sends) when there is no last_inbound_at data at all', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-nodata' });
    const sql = makeFakeSql([[], []]); // opt-out empty, window query empty
    const deps = makeDeps({ sql });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-nodata' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-nodata' });
  });

  it('fail-opens (sends) when the 24h window query throws', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-qerr' });
    let call = 0;
    const sql = (async () => {
      call += 1;
      if (call === 2) throw new Error('db down');
      return [];
    }) as unknown as SqlClient;
    const logger = makeFakeLogger();
    const deps = makeDeps({ sql, logger });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-qerr' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-qerr' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('sends a notification kind text even outside the window (staff exemption)', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-notif' });
    const deps = makeDeps(); // default sql never returns a last_inbound_at row anyway
    const msg = makeMsg({
      to: '+5491111111111',
      context: { feature: 'f', client_ref: 'ref-notif-window', kind: 'notification' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-notif' });
  });

  it('sends a template regardless of the 24h window (guard only applies to free-form text)', async () => {
    mockSend.mockResolvedValue({ ok: true, message_id: 'wamid-tmpl' });
    const sql = makeFakeSql([[], [{ category: 'marketing' }]]); // opt-out, resolveCategory
    const deps = makeDeps({ sql });
    const msg = makeMsg({
      content: { type: 'template', name: 'reminder', language: 'es' },
      context: { feature: 'f', client_ref: 'ref-tmpl-window' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'sent', message_id: 'wamid-tmpl' });
  });
});

describe('sendMessage — content/channel combos', () => {
  it('rejects unsupported_content_type for email + template content', async () => {
    const deps = makeDeps();
    const msg = makeMsg({
      channel: 'email',
      to: 'someone@example.com',
      content: { type: 'template', name: 'x', language: 'es' },
      context: { feature: 'f', client_ref: 'ref-email-bad' },
    });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'unsupported_content_type',
      detail: 'email requiere content.type=mail (subject + html/text, adjuntos opcionales)',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('sendMessage — provider failures', () => {
  it('returns failed when provider.send throws', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('network blew up'), { error_code: 'econnreset' }));
    const deps = makeDeps();
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-throw' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'failed', error_code: 'econnreset', error_message: 'network blew up' });
  });

  it('returns failed when the provider resolves ok:false', async () => {
    mockSend.mockResolvedValue({ ok: false, error_code: 'meta_400', error_message: 'bad request' });
    const deps = makeDeps();
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-notok' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({ status: 'failed', error_code: 'meta_400', error_message: 'bad request' });
    expect(mockRecordSendUsage).not.toHaveBeenCalled();
  });
});

describe('sendMessage — missing configuration', () => {
  it('fails with missing_phone_number_id when whatsapp has no default phone number id configured', async () => {
    const deps = makeDeps({ resolveDefaultPhoneNumberId: async () => null });
    const msg = makeMsg({ context: { feature: 'f', client_ref: 'ref-nophone' } });

    const result = await sendMessage(deps, msg);

    expect(result).toEqual({
      status: 'failed',
      error_code: 'missing_phone_number_id',
      error_message:
        "falta bot.config['channel_whatsapp'].default_phone_number_id y la env " +
        'META_WA_DEFAULT_PHONE_NUMBER_ID',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('isWithin24hWindow', () => {
  it('returns within=true known=true for a recent last_inbound_at', async () => {
    const sql = makeFakeSql([[{ last_inbound_at: new Date(Date.now() - 60 * 60 * 1000) }]]);
    const logger = makeFakeLogger();

    const result = await isWithin24hWindow(sql, logger, 'whatsapp', '+5491111111111');

    expect(result.within).toBe(true);
    expect(result.known).toBe(true);
  });

  it('returns within=false known=true for a stale last_inbound_at', async () => {
    const sql = makeFakeSql([[{ last_inbound_at: new Date(Date.now() - 25 * 60 * 60 * 1000) }]]);
    const logger = makeFakeLogger();

    const result = await isWithin24hWindow(sql, logger, 'whatsapp', '+5491111111111');

    expect(result.within).toBe(false);
    expect(result.known).toBe(true);
  });

  it('fail-opens (within=true known=false) with no matching row', async () => {
    const sql = makeFakeSql([[]]);
    const logger = makeFakeLogger();

    const result = await isWithin24hWindow(sql, logger, 'whatsapp', '+5491111111111');

    expect(result).toEqual({ within: true, known: false, lastInboundAt: null });
  });

  it('fail-opens when the query throws', async () => {
    const sql = makeThrowingSql();
    const logger = makeFakeLogger();

    const result = await isWithin24hWindow(sql, logger, 'whatsapp', '+5491111111111');

    expect(result).toEqual({ within: true, known: false, lastInboundAt: null });
    expect(logger.warn).toHaveBeenCalled();
  });
});
