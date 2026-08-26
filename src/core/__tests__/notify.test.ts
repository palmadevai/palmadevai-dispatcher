/**
 * F7.5 — `core/notify.ts`. Acá vive lo que ANTES estaba copiado en cada
 * emisor, así que acá se testea una sola vez: el gate de declaración, la
 * resolución de destinatarios y remitente, el fan-out, la composición del ref
 * y la lectura del resultado.
 *
 * El `sql` fake responde en el orden exacto en que `notify()` pregunta:
 *   1. `config.features.bom->'notify_to'` — ¿la feature declaró este aviso?
 *   2. `bot.config['branding']` — remitente + nombre visible.
 *   3. `bot.notify_to(feature)` — destinatarios.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SqlClient } from '../../lib/postgres.js';
import type { Logger } from '../../lib/logger.js';
import type { SendOutcome } from '../messaging.js';
import { notify, type NotifyDeps } from '../notify.js';
import { resetAnnouncedForTests } from '../../lib/pg-errors.js';

function makeFakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeFakeSql(responses: unknown[][], throwOn?: { index: number; err: unknown }): SqlClient {
  let i = 0;
  return ((): Promise<unknown[]> => {
    const current = i;
    i += 1;
    if (throwOn && throwOn.index === current) return Promise.reject(throwOn.err);
    return Promise.resolve(responses[current] ?? []);
  }) as unknown as SqlClient;
}

function makeDeps(
  opts: {
    declared?: boolean;
    emailFrom?: string;
    brandName?: string;
    to?: string[];
    outcomes?: SendOutcome[];
    throwOn?: { index: number; err: unknown };
  } = {},
): { deps: NotifyDeps; send: ReturnType<typeof vi.fn>; logger: Logger } {
  const outcomes = opts.outcomes;
  let n = 0;
  const send = vi.fn(async () => {
    const o = outcomes?.[n] ?? ({ status: 'sent', message_id: `m${n}` } as SendOutcome);
    n += 1;
    return o;
  });
  const logger = makeFakeLogger();
  const sql = makeFakeSql(
    [
      [{ declared: opts.declared ?? true }],
      [
        {
          email_from: opts.emailFrom ?? 'no-reply@cliente.test',
          name: opts.brandName ?? 'Cliente SA',
        },
      ],
      [{ to: opts.to ?? ['ops@cliente.test'] }],
    ],
    opts.throwOn,
  );
  return { deps: { sql, logger, send } as unknown as NotifyDeps, send, logger };
}

const REQ = {
  feature: 'campaigns',
  aviso: 'template-auto-pause',
  subject: 'Template bloqueante',
  text: 'cuerpo',
};

describe('notify — el gate de declaración', () => {
  it('rechaza un aviso que la feature no declaró, y NO manda nada', async () => {
    const { deps, send } = makeDeps({ declared: false });
    const outcome = await notify(deps, REQ);
    expect(outcome.status).toBe('undeclared');
    if (outcome.status === 'undeclared') {
      expect(outcome.detail).toContain('template-auto-pause');
      expect(outcome.detail).toContain('campaigns');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('acepta un aviso declarado', async () => {
    const { deps, send } = makeDeps({ declared: true });
    const outcome = await notify(deps, REQ);
    expect(outcome.status).toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
  });

  // Asimetría deliberada: un aviso no declarado es un error del llamador; una
  // base SIN `config.features` es un cliente sin el modelo de features, y
  // apagarle todos los avisos por eso convierte un hueco de datos en un
  // incidente mudo.
  it('deja pasar si config.features no existe en esta base (42P01)', async () => {
    resetAnnouncedForTests();
    const { deps, send } = makeDeps({
      throwOn: { index: 0, err: Object.assign(new Error('relation does not exist'), { code: '42P01' }) },
    });
    const outcome = await notify(deps, REQ);
    expect(outcome.status).toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('notify — resolución de destinatarios y remitente', () => {
  it('no manda sin destinatarios y devuelve el motivo (no un error)', async () => {
    const { deps, send } = makeDeps({ to: [] });
    const outcome = await notify(deps, REQ);
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.sent).toEqual([]);
      expect(outcome.blocked_reason).toContain('destinatarios');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('no manda sin remitente — un remitente equivocado entrega mal con un 200 limpio', async () => {
    const { deps, send } = makeDeps({ emailFrom: '' });
    const outcome = await notify(deps, REQ);
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.blocked_reason).toContain('email_from');
    expect(send).not.toHaveBeenCalled();
  });

  it('firma con el nombre del branding del CLIENTE, no con un literal del template', async () => {
    const { deps, send } = makeDeps({ brandName: 'Egeria Travel', emailFrom: 'no-reply@egeria.test' });
    await notify(deps, REQ);
    const msg = send.mock.calls[0][0] as { from: string };
    expect(msg.from).toBe('Egeria Travel <no-reply@egeria.test>');
    expect(msg.from).not.toContain('PalmaDev');
  });

  it('sin nombre de branding manda con la dirección pelada', async () => {
    const { deps, send } = makeDeps({ brandName: '' });
    await notify(deps, REQ);
    const msg = send.mock.calls[0][0] as { from: string };
    expect(msg.from).toBe('no-reply@cliente.test');
  });
});

describe('notify — fan-out y ref', () => {
  it('manda UNO por destinatario: que a uno le rebote no deja sin aviso a los otros', async () => {
    const { deps, send } = makeDeps({
      to: ['ops@cliente.test', 'conta@cliente.test', 'dueno@cliente.test'],
      outcomes: [
        { status: 'failed', error_code: 'bounced', error_message: 'mailbox full' },
        { status: 'sent', message_id: 'm1' },
        { status: 'duplicate' },
      ],
    });
    const outcome = await notify(deps, REQ);
    expect(send).toHaveBeenCalledTimes(3);
    if (outcome.status !== 'ok') throw new Error('esperaba ok');
    expect(outcome.sent).toEqual(['conta@cliente.test']);
    // T10.6 — «ya salió» ES éxito, y esa lectura se decide UNA vez, acá.
    expect(outcome.duplicate).toEqual(['dueno@cliente.test']);
    expect(outcome.failed).toEqual([
      { to: 'ops@cliente.test', error_code: 'bounced', error_message: 'mailbox full' },
    ]);
  });

  it('el ref lo compone el servicio y NO lleva el destinatario', async () => {
    const { deps, send } = makeDeps({ to: ['a@x.test', 'b@x.test'] });
    await notify(deps, { ...REQ, origin_ref: 'tpl-1' });
    const refs = (send.mock.calls as Array<[{ context: { client_ref: string } }]>).map(
      (c) => c[0].context.client_ref,
    );
    // El MISMO ref para los dos: la idempotencia es (client_ref, destino), así
    // que el destino ya es parte de la clave. Pegarlo al ref rompía el dedup
    // real —un reintento del mismo evento re-mandándole el mail a todos— sin
    // proteger de nada.
    expect(refs).toEqual([
      'notify-campaigns-template-auto-pause-tpl-1',
      'notify-campaigns-template-auto-pause-tpl-1',
    ]);
    expect(refs[0]).not.toContain('@');
  });

  it('sin origin_ref el ref es feature+aviso (dos ocurrencias se deduplican, que es lo declarado)', async () => {
    const { deps, send } = makeDeps();
    await notify(deps, REQ);
    const msg = send.mock.calls[0][0] as { context: { client_ref: string } };
    expect(msg.context.client_ref).toBe('notify-campaigns-template-auto-pause');
  });

  it('siempre email + kind notification, y el critical viaja tal cual', async () => {
    const { deps, send } = makeDeps();
    await notify(deps, { ...REQ, critical: true });
    const msg = send.mock.calls[0][0] as {
      channel: string;
      content: { type: string; subject: string; text?: string };
      context: { kind: string; critical: boolean; feature: string };
    };
    expect(msg.channel).toBe('email');
    expect(msg.content.type).toBe('mail');
    expect(msg.content.subject).toBe('Template bloqueante');
    expect(msg.context.kind).toBe('notification');
    expect(msg.context.critical).toBe(true);
    expect(msg.context.feature).toBe('campaigns');
  });

  it('critical es false por defecto — el bypass de presupuesto se pide, no se hereda', async () => {
    const { deps, send } = makeDeps();
    await notify(deps, REQ);
    const msg = send.mock.calls[0][0] as { context: { critical: boolean } };
    expect(msg.context.critical).toBe(false);
  });

  // Los avisos cuelgan de un hecho que YA ocurrió (un auto-pause, un tope
  // cruzado). Que falle el mail no puede deshacerlo ni volver al camino que lo
  // disparó.
  it('nunca tira: un send que explota queda registrado como failed', async () => {
    const logger = makeFakeLogger();
    const send = vi.fn().mockRejectedValue(new Error('redis down'));
    const sql = makeFakeSql([
      [{ declared: true }],
      [{ email_from: 'no-reply@cliente.test', name: 'Cliente SA' }],
      [{ to: ['ops@cliente.test'] }],
    ]);
    const deps = { sql, logger, send } as unknown as NotifyDeps;

    const outcome = await notify(deps, REQ);
    if (outcome.status !== 'ok') throw new Error('esperaba ok');
    expect(outcome.failed).toEqual([
      { to: 'ops@cliente.test', error_code: 'notify_send_threw', error_message: 'redis down' },
    ]);
    expect(logger.error).toHaveBeenCalled();
  });
});
