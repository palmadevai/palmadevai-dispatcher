/**
 * F9.6.b — el `degraded` no sobrevive a su causa.
 *
 * Lo que se prueba es sobre todo lo que NO tiene que pasar: que un cliente sano
 * pague un sondeo, que el watch siga corriendo para siempre, y que la
 * recuperación se anuncie como `healthy` cuando en realidad quedaron workers
 * sin arrancar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const probeSchemaState = vi.fn();

vi.mock('../schema-probe.js', async () => {
  const real = await vi.importActual<typeof import('../schema-probe.js')>('../schema-probe.js');
  return { ...real, probeSchemaState };
});

const { startSchemaWatch, RESTART_PENDING } = await import('../schema-watch.js');

const logged: unknown[] = [];
const logger = {
  info: (o: unknown) => logged.push(o),
  warn: (o: unknown) => logged.push(o),
  error: (o: unknown) => logged.push(o),
  debug: (o: unknown) => logged.push(o),
} as never;

const sql = (() => Promise.resolve([])) as never;

const SIN_SUSTRATO = {
  messaging: false,
  campaigns: false,
  missing: ['bot.outbound_endpoints', 'bot.message_templates', 'bot.campaigns'],
};
const COMPLETO = { messaging: true, campaigns: true, missing: [] };
const SOLO_MESSAGING = { messaging: true, campaigns: false, missing: ['bot.campaigns'] };

beforeEach(() => {
  logged.length = 0;
  probeSchemaState.mockReset();
});

describe('schema-watch (F9.6.b)', () => {
  it('un proceso sano no arma ningún timer ni sondea', async () => {
    const w = startSchemaWatch({
      sql,
      logger,
      initial: COMPLETO,
      campaignsWorkersStarted: true,
      intervalMs: 1000,
    });
    expect(w.current().degradedReasons).toEqual([]);
    // Nadie llamó al sondeo: el watch existe sólo para salir del degradado.
    expect(probeSchemaState).not.toHaveBeenCalled();
    w.stop();
  });

  it('degradado → cuando el sustrato aparece, /health se recupera SIN reinicio', async () => {
    // El caso de palmawebs: container arriba 19:00 sin sustrato, mig 230 a las
    // 19:25, y el health en rojo hasta que alguien reinició a mano.
    const w = startSchemaWatch({
      sql,
      logger,
      initial: SIN_SUSTRATO,
      campaignsWorkersStarted: false,
      intervalMs: 0, // sin timer: se dispara a mano, sin esperar
    });
    expect(w.current().degradedReasons.length).toBeGreaterThan(0);
    expect(w.current().schema?.messaging).toBe(false);

    probeSchemaState.mockResolvedValueOnce(SOLO_MESSAGING);
    await w.probeOnce();

    expect(w.current().degradedReasons).toEqual([]);
    expect(w.current().schema?.messaging).toBe(true);
  });

  it('si lo que apareció es el esquema de CAMPAÑAS, lo dice en vez de fingir salud', async () => {
    // Los cuatro workers de campañas no arrancan en caliente. Un `healthy` acá
    // sería la misma mentira con otro color.
    const w = startSchemaWatch({
      sql,
      logger,
      initial: SIN_SUSTRATO,
      campaignsWorkersStarted: false,
      intervalMs: 0,
    });

    probeSchemaState.mockResolvedValueOnce(COMPLETO);
    await w.probeOnce();

    expect(w.current().degradedReasons).toEqual([RESTART_PENDING]);
  });

  it('mientras el sustrato siga faltando, la razón sigue puesta', async () => {
    const w = startSchemaWatch({
      sql,
      logger,
      initial: SIN_SUSTRATO,
      campaignsWorkersStarted: false,
      intervalMs: 0,
    });
    const antes = w.current().degradedReasons;

    probeSchemaState.mockResolvedValueOnce(SIN_SUSTRATO);
    await w.probeOnce();

    expect(w.current().degradedReasons).toEqual(antes);
  });

  it('un sondeo que falla no borra lo que ya se sabía', async () => {
    // La DB caída no es una novedad sobre el ESQUEMA — y /health ya lo dice por
    // su propio ping. Tragarse el estado acá sería inventar una recuperación.
    const w = startSchemaWatch({
      sql,
      logger,
      initial: SIN_SUSTRATO,
      campaignsWorkersStarted: false,
      intervalMs: 0,
    });
    const antes = w.current();

    probeSchemaState.mockRejectedValueOnce(new Error('connection refused'));
    await w.probeOnce();

    expect(w.current()).toEqual(antes);
  });
});
