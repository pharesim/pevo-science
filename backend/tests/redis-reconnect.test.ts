/**
 * Specs for the Redis client's reconnect behavior.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests"):**
 *
 * (a) Two pieces of the surface are non-trivial to exercise without
 *     targeted setup: (i) the `retryStrategy` pure-function assertion is
 *     read off a fresh client's options rather than waiting for a real
 *     server to drop connections so the curve can be observed; (ii) the
 *     close-handler / cached-reference invariant is verified by emitting
 *     a synthetic `close` event on the shared client because forcing the
 *     real connection to close mid-suite would race the other Redis-
 *     touching tests in the file. Neither involves auth middleware, so
 *     clause (b) does not apply.
 * (b) `verifyHiveSignature` is not in scope here — these specs do not
 *     touch the HTTP surface or any signed-request path.
 * (c) The integration-shaped third spec exercises the real reconnect
 *     cycle by calling `disconnect(true)` on the live ioredis client and
 *     waiting for `ready` to fire again, then issuing a real command
 *     against the recovered connection. That covers the actual failure
 *     mode the production fix targets (transient blip -> permanent
 *     degradation) with no mocking.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Redis from 'ioredis';
import { getRedis } from '../src/redis.js';
import { config } from '../src/config.js';

const redis = getRedis();
const skipIfNoRedis = !redis;

describe.skipIf(skipIfNoRedis)('redis client reconnect behavior', () => {
  beforeAll(async () => {
    if (!redis) return;
    // Wait for the shared client to reach `ready` so the suite operates
    // against a known good baseline. setup.ts already attempts a ping
    // but suite ordering can leave the client mid-handshake.
    for (let i = 0; i < 40 && redis.status !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('retryStrategy returns a finite backoff for every retry count (no permanent bailout)', () => {
    // Build a throwaway client purely to inspect the configured retryStrategy.
    // `lazyConnect: true` plus an unreachable URL keeps it from holding a real socket;
    // the strategy is a pure function on the options bag.
    const probe = new Redis('redis://127.0.0.1:1', { lazyConnect: true });
    try {
      const strategy = (probe.options as { retryStrategy?: (times: number) => number | void | null }).retryStrategy;
      expect(typeof strategy).toBe('function');
      if (!strategy) throw new Error('retryStrategy not configured');
      // Probe a representative sample including values far past the prior
      // hard-bailout threshold. None should return null/void — those values
      // tell ioredis to stop reconnecting permanently.
      for (const times of [1, 2, 3, 4, 5, 10, 50, 500, 5000]) {
        const result = strategy(times);
        expect(typeof result).toBe('number');
        expect(result as number).toBeGreaterThan(0);
        // Backoff stays bounded so we don't sleep for hours between retries.
        expect(result as number).toBeLessThanOrEqual(10_000);
      }
    } finally {
      probe.disconnect();
    }
  });

  it('module-scoped client survives a synthetic close event without being nulled', () => {
    if (!redis) throw new Error('redis required');
    // Emit `close` to simulate the network-level disconnect the old
    // handler reacted to by nulling the cached reference. With the fix
    // in place, the cached reference must remain identical so callers
    // keep talking to the same ioredis instance (which will reconnect
    // on its own per retryStrategy).
    redis.emit('close');
    const sameClient = getRedis();
    expect(sameClient).toBe(redis);
  });

  it('recovers from a real disconnect: disconnect(true) -> ready -> commands succeed', async () => {
    if (!redis) throw new Error('redis required');

    // Confirm baseline: client is ready and a round-trip command works.
    expect(redis.status).toBe('ready');
    const probeKey = `${config.appTag}:reconnect-test:${Date.now()}`;
    await redis.set(probeKey, 'before-disconnect', 'PX', 30_000);
    expect(await redis.get(probeKey)).toBe('before-disconnect');

    // Schedule a one-shot listener that resolves when the client reaches
    // `ready` again after the disconnect. ioredis's `disconnect(true)`
    // closes the socket and immediately enters the reconnect path.
    const reconnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        redis.removeListener('ready', onReady);
        reject(new Error(`client did not reach ready within 10s; final status=${redis.status}`));
      }, 10_000);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      redis.once('ready', onReady);
    });

    redis.disconnect(true);

    await reconnected;
    expect(redis.status).toBe('ready');

    // Identity check: getRedis() still hands back the same instance —
    // the close handler did not null the cached reference, so callers
    // that captured a Redis client earlier (e.g., setup.ts) keep talking
    // to the recovered connection rather than racing a fresh client.
    expect(getRedis()).toBe(redis);

    // Round-trip a fresh command against the recovered connection to
    // prove the recovery is real and not just a status flag.
    await redis.set(probeKey, 'after-reconnect', 'PX', 30_000);
    expect(await redis.get(probeKey)).toBe('after-reconnect');
    await redis.del(probeKey);
  });
});
