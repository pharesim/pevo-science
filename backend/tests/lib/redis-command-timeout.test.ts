/**
 * Constructor-options canary for the ioredis client.
 *
 * Pins that `getRedis()` constructs its `ioredis.Redis` client with
 * `commandTimeout` set to a finite, positive number. The production
 * concern: every command inherits the absence of a per-command timeout
 * otherwise, and a Redis server that accepts the connection but stalls
 * on an individual command (Lua cache pressure under OOM, half-open
 * socket, NOSCRIPT recovery against a flushed scripts cache) hangs the
 * awaiting caller indefinitely. `maxRetriesPerRequest` governs
 * connection-level retry, not per-command timeout.
 *
 * Mocking justification (carve-out clause-(c)): inducing a real
 * stalled-but-connected Redis is impractical in the dev-mode Docker
 * container — the failure mode requires Lua-cache-OOM or a half-open
 * socket that the real container does not produce on demand. The
 * options-shape canary at constructor time is the deterministic proof
 * that the production code passes `commandTimeout` to ioredis. The
 * mock target is the ioredis constructor only; no auth/permission
 * middleware is involved at this layer. Companion real-path coverage
 * for ioredis command-rejection routing (the OOM-rejection spec in
 * accreditation.test.ts) exercises the catch handler that absorbs the
 * timeout error class when it fires in production.
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
  beforeEach(() => {
    constructorCalls = [];
    vi.resetModules();
  });

  afterEach(async () => {
    // Tear down the cached client between tests so the next test's
    // `vi.resetModules()` produces a fresh constructor call.
    const mod = await import('../../src/redis.js');
    await mod.disconnectRedis();
  });

  it('passes a finite positive commandTimeout to new Redis(...)', async () => {
    const { getRedis } = await import('../../src/redis.js');
    const client = getRedis();

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
    const { getRedis } = await import('../../src/redis.js');
    getRedis();

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
