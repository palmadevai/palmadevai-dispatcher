/**
 * F5/H5.2 — `tryAcquireToken`: the non-blocking variant of the Redis token
 * bucket used by MCP Tier 3 tools. Unlike `createRedisRateLimiter().acquire()`
 * (which busy-waits), this returns immediately with `{acquired, waitMs}` so
 * the caller can respond with an actionable error instead of hanging.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { tryAcquireToken } from '../rate-limiter.js';

function makeFakeRedisWithEval(result: [number, number]): Redis {
  return {
    eval: vi.fn(async () => result),
  } as unknown as Redis;
}

function makeThrowingEvalRedis(): Redis {
  return {
    eval: vi.fn(async () => {
      throw new Error('redis eval failed');
    }),
  } as unknown as Redis;
}

describe('tryAcquireToken', () => {
  it('consumes a token when the bucket has one available', async () => {
    const redis = makeFakeRedisWithEval([1, 0]);

    const result = await tryAcquireToken({ redis, key: 'campaigns:rl:global', maxBurst: 5, refillPerSec: 1 });

    expect(result).toEqual({ acquired: true, waitMs: 0 });
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('returns acquired:false with the wait time when the bucket is empty', async () => {
    const redis = makeFakeRedisWithEval([0, 750]);

    const result = await tryAcquireToken({ redis, key: 'campaigns:rl:global', maxBurst: 5, refillPerSec: 1 });

    expect(result).toEqual({ acquired: false, waitMs: 750 });
  });

  it('fails open (acquired:true) when the Redis EVAL throws', async () => {
    const redis = makeThrowingEvalRedis();
    const logger = { warn: vi.fn() };

    const result = await tryAcquireToken({
      redis,
      key: 'campaigns:rl:global',
      maxBurst: 5,
      refillPerSec: 1,
      logger,
    });

    expect(result).toEqual({ acquired: true, waitMs: 0 });
    expect(logger.warn).toHaveBeenCalled();
  });
});
