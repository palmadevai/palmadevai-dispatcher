/**
 * F9.6 — la sonda de esquema y la decisión de boot, sin Redis ni Postgres.
 */
import { describe, it, expect } from 'vitest';
import {
  probeRelations,
  probeSchemaState,
  decideBoot,
  MESSAGING_SUBSTRATE,
  CAMPAIGNS_SCHEMA,
  type SchemaState,
} from '../schema-probe.js';
import { buildHealth } from '../health.js';

type Row = { n: string; present: boolean };

/** Simula postgres.js: (strings, ...values) → filas según qué relaciones "existen". */
function fakeSql(existing: Set<string>) {
  return ((_s: TemplateStringsArray, ...values: unknown[]) => {
    const names = values[0] as string[];
    return Promise.resolve(names.map((n): Row => ({ n, present: existing.has(n) })));
  }) as unknown as Parameters<typeof probeRelations>[0];
}

const ALL = new Set<string>([...MESSAGING_SUBSTRATE, ...CAMPAIGNS_SCHEMA]);

describe('probeRelations / probeSchemaState (F9.6)', () => {
  it('esquema completo → messaging y campaigns true, missing vacío', async () => {
    const st = await probeSchemaState(fakeSql(ALL));
    expect(st).toEqual({ messaging: true, campaigns: true, missing: [] });
  });

  it('cliente sin campañas (palmawebs tras la 230) → campaigns false con las tres nombradas', async () => {
    const st = await probeSchemaState(fakeSql(new Set(MESSAGING_SUBSTRATE)));
    expect(st.messaging).toBe(true);
    expect(st.campaigns).toBe(false);
    expect(st.missing).toEqual([...CAMPAIGNS_SCHEMA]);
  });

  it('sin sustrato de messaging → messaging false y las dos relaciones en missing', async () => {
    const st = await probeSchemaState(fakeSql(new Set(CAMPAIGNS_SCHEMA)));
    expect(st.messaging).toBe(false);
    expect(st.missing).toEqual([...MESSAGING_SUBSTRATE]);
  });

  it('una relación que la query no devuelve cuenta como ausente (no como presente)', async () => {
    const sql = ((_s: TemplateStringsArray) => Promise.resolve([] as Row[])) as unknown as Parameters<
      typeof probeRelations
    >[0];
    const present = await probeRelations(sql, ['bot.x']);
    expect(present).toEqual({ 'bot.x': false });
  });
});

describe('decideBoot (F9.6)', () => {
  it('con todo: workers de campañas y sin degradación', () => {
    const d = decideBoot({ messaging: true, campaigns: true, missing: [] });
    expect(d).toEqual({ campaignsWorkers: true, degradedReasons: [] });
  });

  it('sin campañas: los workers no arrancan y NO es degradación (es lo contratado)', () => {
    const d = decideBoot({ messaging: true, campaigns: false, missing: [...CAMPAIGNS_SCHEMA] });
    expect(d.campaignsWorkers).toBe(false);
    expect(d.degradedReasons).toEqual([]);
  });

  it('sin sustrato: degradado con la causa nombrando la migración 230', () => {
    const st: SchemaState = { messaging: false, campaigns: false, missing: [...MESSAGING_SUBSTRATE, ...CAMPAIGNS_SCHEMA] };
    const d = decideBoot(st);
    expect(d.campaignsWorkers).toBe(false);
    expect(d.degradedReasons).toHaveLength(1);
    expect(d.degradedReasons[0]).toContain('bot.outbound_endpoints');
    expect(d.degradedReasons[0]).toContain('230');
  });
});

describe('buildHealth (F9.6)', () => {
  const base = { uptimeMs: 10, stubMode: false, workersCount: 6 };

  it('healthy: infra ok y sin razones → 200, sin `reasons`', () => {
    const r = buildHealth({ ...base, redisOk: true, postgresOk: true, schema: { messaging: true, campaigns: true, missing: [] }, degradedReasons: [] });
    expect(r.code).toBe(200);
    expect(r.body.status).toBe('healthy');
    expect(r.body).not.toHaveProperty('reasons');
    expect(r.body.schema).toEqual({ messaging: true, campaigns: true, missing: [] });
  });

  it('degraded: infra ok pero falta el sustrato → 200 (Docker no reinicia) y `reasons`', () => {
    const r = buildHealth({
      ...base,
      redisOk: true,
      postgresOk: true,
      schema: { messaging: false, campaigns: false, missing: [...MESSAGING_SUBSTRATE] },
      degradedReasons: ['sustrato de messaging ausente'],
    });
    expect(r.code).toBe(200);
    expect(r.body.status).toBe('degraded');
    expect(r.body.reasons).toEqual(['sustrato de messaging ausente']);
  });

  it('sin campañas NO degrada: healthy con schema.campaigns=false', () => {
    const r = buildHealth({ ...base, redisOk: true, postgresOk: true, schema: { messaging: true, campaigns: false, missing: [...CAMPAIGNS_SCHEMA] }, degradedReasons: [] });
    expect(r.body.status).toBe('healthy');
    expect(r.body.schema?.campaigns).toBe(false);
  });

  it('unhealthy manda sobre degraded: Postgres caído → 503, sin `reasons`', () => {
    const r = buildHealth({ ...base, redisOk: true, postgresOk: false, schema: null, degradedReasons: ['x'] });
    expect(r.code).toBe(503);
    expect(r.body.status).toBe('unhealthy');
    expect(r.body).not.toHaveProperty('reasons');
    expect(r.body.schema).toBeNull();
  });
});
