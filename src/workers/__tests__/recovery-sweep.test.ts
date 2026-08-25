/**
 * F3.1 — sweepStuckCampaigns (workers/recovery.ts, paso 4 del recovery).
 * Domain-pure: fake de `sql` secuencial, mismo patrón que budget.test.ts.
 *
 * El orden de llamadas del sweep es fijo: (1) UPDATE de reconciliación
 * paused_at→'paused' (+ un INSERT de audit POR fila reparada), (2) UPDATE de
 * cierre one_off sin pendientes. `responses[i]` alimenta la i-ésima llamada.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { Logger } from '../../lib/logger.js';
import { sweepStuckCampaigns } from '../recovery.js';

function makeFakeSql(responses: Array<unknown[] | Error>): { sql: Sql; queries: string[] } {
  let i = 0;
  const queries: string[] = [];
  const fn = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    queries.push(strings.join('?'));
    const r = responses[i] ?? [];
    i += 1;
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  }) as unknown as Sql;
  return { sql: fn, queries };
}

function makeFakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

describe('sweepStuckCampaigns', () => {
  it("reconcilia 'sending'+paused_at → 'paused' con audit row y warn", async () => {
    const { sql, queries } = makeFakeSql([
      [{ id: 'c1', pause_reason: 'auto_template_rejected' }], // (a) repara 1
      [], // audit insert de c1
      [], // (b) nada que cerrar
    ]);
    const logger = makeFakeLogger();

    await sweepStuckCampaigns(sql, logger);

    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("SET status = 'paused'");
    // La señal es «pausada después del último resume», no paused_at a secas —
    // sin esta condición el sweep re-pausaría campañas legítimamente reanudadas.
    expect(queries[0]).toContain('resumed_at < c.paused_at');
    expect(queries[1]).toContain('campaign_launches_audit');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("cierra one_off en 'sending' sin pendientes hace >6h, sin audit (como el cierre normal)", async () => {
    const { sql, queries } = makeFakeSql([
      [], // (a) nada que reconciliar
      [{ id: 'c2' }], // (b) cierra 1
    ]);
    const logger = makeFakeLogger();

    await sweepStuckCampaigns(sql, logger);

    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("SET status = 'done'");
    expect(queries[1]).toContain("kind = 'one_off'");
    expect(queries[1]).toContain("interval '6 hours'");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('sin zombies: dos queries y silencio', async () => {
    const { sql, queries } = makeFakeSql([[], []]);
    const logger = makeFakeLogger();

    await sweepStuckCampaigns(sql, logger);

    expect(queries).toHaveLength(2);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('un audit insert que falla no aborta el resto del sweep', async () => {
    const { sql, queries } = makeFakeSql([
      [
        { id: 'c1', pause_reason: 'manual' },
        { id: 'c2', pause_reason: null },
      ],
      new Error('audit boom'), // audit de c1 falla
      [], // audit de c2 sigue corriendo igual
      [], // (b) también corre
    ]);
    const logger = makeFakeLogger();

    await sweepStuckCampaigns(sql, logger);

    expect(queries).toHaveLength(4);
    expect(logger.error).toHaveBeenCalledTimes(1); // el fallo del audit, logueado
    expect(logger.warn).toHaveBeenCalledTimes(2); // las dos reparaciones, avisadas
  });

  it('tabla ausente (cliente sin campaigns) → announceOnce, no error', async () => {
    const missing = Object.assign(new Error('relation "bot.campaigns" does not exist'), {
      code: '42P01',
    });
    const { sql } = makeFakeSql([missing]);
    const logger = makeFakeLogger();

    await sweepStuckCampaigns(sql, logger);

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled(); // announceOnce dice el estado esperado una vez
  });
});
