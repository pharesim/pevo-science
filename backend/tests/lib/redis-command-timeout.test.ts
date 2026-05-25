/**
 * Constructor-options canary for the ioredis client.
 *
 * Pins that `getRedis()` constructs its `ioredis.Redis` client with a
 * finite, positive `commandTimeout`, and keeps `maxRetriesPerRequest`
 * alongside it.
 *
 * Carve-out clause-(a) (mocking justification): inducing a real
 * stalled-but-connected Redis is impractical in the dev-mode Docker
 * container — that failure mode does not occur on demand. So the
 * deterministic proof that production passes `commandTimeout` to ioredis
 * is an options-shape assertion at constructor time. The mock target is
 * the ioredis constructor only; no auth/permission middleware runs here.
 *
 * Carve-out clause-(c) (real-path companion): the accreditation `/verify`
 * Redis-rejection spec — which asserts a 503 SERVICE_UNAVAILABLE when the
 * pre-INCR cap-enforcement script rejects — exercises, against the
 * integrated route, the catch handler that absorbs the command-rejection
 * error class (including a timeout) when it fires in production.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let constructorCalls: Array<{ url: string; options: Record<string, unknown> }> = [];

vi.mock('ioredis', () => {
  // Minimal stand-in. Production callers only use a small surface
  // through `getRedis()`; the canary itself only asserts on the
  // constructor's options arg.
  class MockRedis {
    status = 'wait';
    constructor(url: string, options: Record<string, unknown>) {
      constructorCalls.push({ url, options });
    }
    on() { return this; }
    connect() { return Promise.resolve(); }
    quit() { return Promise.resolve('OK'); }
  }
  return { default: MockRedis };
});

vi.mock('../../src/lib/redis-scripts.js', () => ({
  loadAllScripts: vi.fn(() => Promise.resolve()),
}));

describe('redis.ts constructor options', () => {
  // The exact module instance the test imported and built a client on.
  // Captured so teardown disconnects that client rather than a fresh
  // registry lookup that would have no client to release.
  let redisModule: typeof import('../../src/redis.js') | null = null;

  beforeEach(() => {
    constructorCalls = [];
    redisModule = null;
    vi.resetModules();
  });

  afterEach(async () => {
    if (redisModule) await redisModule.disconnectRedis();
  });

  it('passes a finite positive commandTimeout to new Redis(...)', async () => {
    redisModule = await import('../../src/redis.js');
    const client = redisModule.getRedis();

    expect(client).not.toBeNull();
    expect(constructorCalls).toHaveLength(1);
    const options = constructorCalls[0]!.options;
    expect(options).toHaveProperty('commandTimeout');
    expect(typeof options.commandTimeout).toBe('number');
    expect(options.commandTimeout).toBeGreaterThan(0);
    // Bound the ceiling so a mutation that pushes the value to e.g.
    // Number.MAX_SAFE_INTEGER (functionally equivalent to no timeout)
    // is caught. 30s is generous vs. any plausible operational choice
    // (Redis hot paths complete in <100ms; 30s is enough to swallow
    // every reasonable hiccup) while still finite.
    expect(options.commandTimeout).toBeLessThanOrEqual(30_000);
  });

  it('keeps maxRetriesPerRequest alongside commandTimeout (defense in depth)', async () => {
    redisModule = await import('../../src/redis.js');
    redisModule.getRedis();

    expect(constructorCalls).toHaveLength(1);
    const options = constructorCalls[0]!.options;
    // The two bounds serve different purposes — `commandTimeout`
    // bounds per-command latency, `maxRetriesPerRequest` bounds
    // connection-level retry on individual commands. A mutation that
    // drops one in favor of the other regresses the case the dropped
    // bound covers. Pin both.
    expect(options).toHaveProperty('maxRetriesPerRequest');
    expect(typeof options.maxRetriesPerRequest).toBe('number');
    expect(options.maxRetriesPerRequest).toBeGreaterThan(0);
  });
});
