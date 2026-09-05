/**
 * F9.6 — el cuerpo de `/health`, como función pura para poder testearlo.
 *
 * Tres estados, no dos:
 *   - `healthy`   — Redis y Postgres responden y el esquema está completo
 *                   para lo que el cliente contrató.
 *   - `degraded`  — Redis y Postgres responden, pero falta el SUSTRATO del
 *                   servicio (mig 230). El proceso sirve `/send` y `/notify`
 *                   igual; lo que no puede hacer (sync de números, mirror de
 *                   plantillas, token por endpoint) queda dicho en `reasons`.
 *                   **HTTP 200**: es un hueco de provisioning, no una caída —
 *                   un 503 haría que Docker reinicie el container en loop por
 *                   algo que el runtime no puede arreglar.
 *   - `unhealthy` — Redis o Postgres no responden. HTTP 503, como siempre.
 *
 * Que a un cliente le falte el esquema de CAMPAÑAS no degrada nada: es lo
 * esperado sin esa feature, y se informa en `schema.campaigns` sin adjetivo.
 */
import type { SchemaState } from './schema-probe.js';

export interface HealthInput {
  redisOk: boolean;
  postgresOk: boolean;
  schema: SchemaState | null;
  degradedReasons: string[];
  uptimeMs: number;
  stubMode: boolean;
  /** Workers efectivamente arrancados (F1.2.b contaba 3 fijos). */
  workersCount: number;
}

export interface HealthBody {
  status: 'healthy' | 'degraded' | 'unhealthy';
  redis_ok: boolean;
  postgres_ok: boolean;
  bullmq_workers_count: number;
  uptime_ms: number;
  stub_mode: boolean;
  schema: { messaging: boolean; campaigns: boolean; missing: string[] } | null;
  reasons?: string[];
}

export function buildHealth(input: HealthInput): { code: 200 | 503; body: HealthBody } {
  const infraOk = input.redisOk && input.postgresOk;
  const degraded = infraOk && input.degradedReasons.length > 0;
  const status: HealthBody['status'] = !infraOk ? 'unhealthy' : degraded ? 'degraded' : 'healthy';
  const body: HealthBody = {
    status,
    redis_ok: input.redisOk,
    postgres_ok: input.postgresOk,
    bullmq_workers_count: input.workersCount,
    uptime_ms: input.uptimeMs,
    stub_mode: input.stubMode,
    schema: input.schema
      ? { messaging: input.schema.messaging, campaigns: input.schema.campaigns, missing: input.schema.missing }
      : null,
    ...(degraded ? { reasons: input.degradedReasons } : {}),
  };
  return { code: infraOk ? 200 : 503, body };
}
