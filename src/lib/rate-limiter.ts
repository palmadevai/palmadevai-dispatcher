/**
 * Fase 7 item 10 — Redis-coordinated token bucket rate limiter.
 *
 * Reemplaza el bucket in-memory por uno coordinado via Redis EVAL Lua
 * script. Atómico (refill + decrement en una sola eval). Coordina
 * múltiples réplicas dispatcher contra la misma key.
 *
 * Diseño key:
 *   campaigns:rl:<scope>
 *
 * scope típicamente 'global' (un bucket global por dispatcher fleet) o
 * por phone_number_id ('phone:<id>') si querés rate limit per-phone.
 * MVP: scope='global' única — alinea con CAMPAIGNS_DEFAULT_RATE_BURST_MPS.
 *
 * Algoritmo (Lua):
 *   1. GET <key> → JSON {tokens, last_refill_ms} (o defaults).
 *   2. now = TIME.
 *   3. elapsed_ms = now - last_refill_ms.
 *   4. tokens += elapsed_ms * (refill_per_sec / 1000), clamped a max_burst.
 *   5. Si tokens >= 1: tokens -= 1, SET <key> {tokens, last_refill_ms=now},
 *      return {acquired: true}.
 *   6. Si no: SET <key> {tokens, last_refill_ms=now}, return
 *      {acquired: false, wait_ms = ceil((1 - tokens) * (1000 / refill_per_sec))}.
 *
 * Caller hace busy-sleep wait_ms + reintenta. Si Redis caído > N retries,
 * log warn y degrade graceful (return inmediato — equivale a sin rate
 * limit; preferible a deadlock dispatcher).
 */

import type { Redis } from 'ioredis';

/**
 * Lua script atómico. Recibe:
 *   KEYS[1] = redis key
 *   ARGV[1] = max_burst (integer)
 *   ARGV[2] = refill_per_sec (integer)
 *   ARGV[3] = now_ms (integer, client-provided para evitar drift)
 *
 * Devuelve cjson array [acquired (0|1), wait_ms (0 si acquired=1)].
 *
 * Storage: simple HASH con campos tokens (float string) + last_refill_ms.
 */
const LUA_SCRIPT = `
local key = KEYS[1]
local max_burst = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])

local state = redis.call('HMGET', key, 'tokens', 'last_refill_ms')
local tokens = tonumber(state[1])
local last_refill_ms = tonumber(state[2])

if tokens == nil then
  tokens = max_burst
  last_refill_ms = now_ms
end

local elapsed_ms = now_ms - last_refill_ms
if elapsed_ms < 0 then elapsed_ms = 0 end

local refilled = (elapsed_ms / 1000.0) * refill_per_sec
tokens = tokens + refilled
if tokens > max_burst then tokens = max_burst end

local acquired = 0
local wait_ms = 0

if tokens >= 1 then
  tokens = tokens - 1
  acquired = 1
else
  -- Cuánto hay que esperar para 1 token: (1 - tokens) / refill_per_sec * 1000
  wait_ms = math.ceil((1.0 - tokens) * 1000.0 / refill_per_sec)
end

-- TTL defensivo: 60s. Si nadie usa la key por 1min, se limpia.
redis.call('HSET', key, 'tokens', tostring(tokens), 'last_refill_ms', tostring(now_ms))
redis.call('PEXPIRE', key, 60000)

return {acquired, wait_ms}
`;

export interface RateLimiterConfig {
  redis: Redis;
  keyPrefix: string;          // ej 'campaigns:rl'
  scope: string;               // ej 'global' o 'phone:123'
  maxBurst: number;            // burst máximo (token cap)
  refillPerSec: number;        // refill rate
  fallbackOnError: boolean;    // si true, errors de Redis no bloquean (degrade)
  logger?: { warn: (obj: object, msg: string) => void };
}

export interface RateLimiter {
  acquire(stoppingCheck: () => boolean): Promise<void>;
}

/**
 * Variante NO bloqueante del mismo bucket, para el rate limit por emisor de
 * las tools MCP Tier 3 (F5/H5.2).
 *
 * El `acquire()` de arriba espera hasta tener token: es lo correcto para el
 * worker de campañas, que quiere pacing y no pérdida. Una tool MCP es lo
 * contrario — el agente está esperando la respuesta, así que pasarse del
 * límite se responde al toque con un error accionable ("esperá N ms") en vez
 * de colgar la llamada.
 *
 * Fail-open ante Redis caído, igual que el resto de las guardas de
 * infraestructura del servicio: el techo de gasto real lo pone el budget
 * enforcement (que además persiste en Postgres), este limitador es la segunda
 * línea contra un agente en loop.
 */
export async function tryAcquireToken(cfg: {
  redis: Redis;
  key: string;
  maxBurst: number;
  refillPerSec: number;
  logger?: { warn: (obj: object, msg: string) => void };
}): Promise<{ acquired: boolean; waitMs: number }> {
  try {
    const result = (await cfg.redis.eval(
      LUA_SCRIPT,
      1,
      cfg.key,
      String(cfg.maxBurst),
      String(cfg.refillPerSec),
      String(Date.now()),
    )) as [number, number];
    return { acquired: result[0] === 1, waitMs: Number(result[1]) || 0 };
  } catch (err) {
    cfg.logger?.warn(
      { err: (err as Error).message, key: cfg.key },
      'tryAcquireToken: Redis EVAL failed — fail-open (budget sigue siendo el techo real)',
    );
    return { acquired: true, waitMs: 0 };
  }
}

export function createRedisRateLimiter(cfg: RateLimiterConfig): RateLimiter {
  const key = `${cfg.keyPrefix}:${cfg.scope}`;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  async function tryAcquireOnce(): Promise<{ acquired: boolean; waitMs: number }> {
    const now = Date.now();
    const result = (await cfg.redis.eval(
      LUA_SCRIPT,
      1,
      key,
      String(cfg.maxBurst),
      String(cfg.refillPerSec),
      String(now),
    )) as [number, number];
    const acquired = result[0] === 1;
    const waitMs = Number(result[1]) || 0;
    return { acquired, waitMs };
  }

  return {
    async acquire(stoppingCheck: () => boolean): Promise<void> {
      // Loop: try acquire, sleep wait_ms, retry.
      let attempts = 0;
      while (!stoppingCheck()) {
        try {
          const { acquired, waitMs } = await tryAcquireOnce();
          consecutiveErrors = 0;
          if (acquired) return;
          // No token; sleep + retry.
          const sleepMs = Math.min(Math.max(waitMs, 5), 1000); // clamp [5, 1000]
          await new Promise((resolve) => setTimeout(resolve, sleepMs));
          attempts += 1;
          if (attempts > 200) {
            // 200 retries (≈10s típico) sin token — probable bug del bucket.
            cfg.logger?.warn(
              { key, attempts },
              'rate limiter: 200 retries sin token — abandono y permito (degrade)',
            );
            return;
          }
        } catch (err) {
          consecutiveErrors += 1;
          cfg.logger?.warn(
            { err: (err as Error).message, key, consecutiveErrors },
            'rate limiter: Redis EVAL failed',
          );
          if (cfg.fallbackOnError && consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            cfg.logger?.warn(
              { key, consecutiveErrors },
              'rate limiter: degrade — permito request sin gating',
            );
            return;
          }
          // Retry after short backoff.
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    },
  };
}
