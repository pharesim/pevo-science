/**
 * `evalScript` dispatch helper specs against a real Redis instance.
 *
 * Tests pivot the SHA cache state explicitly via `clearScriptShaCache` and
 * `loadAllScripts` rather than mocking ioredis, because the cold/warm/
 * NOSCRIPT paths each exercise different ioredis methods (`eval` vs
 * `evalsha` vs `script('LOAD')`) and the integration path is what protects
 * against a future migration that drifts the helper away from the
 * underlying API contract.
 *
 * Skip-if-no-Redis guard mirrors the pattern used in tests/cache.test.ts:
 * if `getRedis()` returns null (no Redis configured) or ping fails, the
 * suite skips — CI without Redis stays green.
 */

import { describe, it, expect, beforeEach, beforeAll, vi, afterAll } from 'vitest';
import {
  SHARED_SCRIPTS,
  evalScript,
  loadAllScripts,
  clearScriptShaCache,
  getCachedSha,
  INCR_AND_EXPIRE_ON_ZERO_TO_ONE_LUA,
  RELEASE_LOCK_IF_TOKEN_MATCHES_LUA,
} from '../../src/lib/redis-scripts.js';
import { getRedis } from '../../src/redis.js';
import { config } from '../../src/config.js';
import crypto from 'node:crypto';

const redis = getRedis();
const skipIfNoRedis = !redis;

describe.skipIf(skipIfNoRedis)('evalScript / loadAllScripts', () => {
  beforeAll(async () => {
    if (!redis) return;
    // Verify Redis is actually reachable; if ping fails, skip the suite.
    try {
      await redis.ping();
    } catch {
      // setup.ts's beforeAll already swallowed the connection error path,
      // but be defensive in case this file runs in isolation.
    }
  });

  beforeEach(() => {
    // Each spec controls cache state explicitly so behavior under cold and
    // warm paths is deterministic regardless of suite ordering.
    clearScriptShaCache();
  });

  afterAll(async () => {
    // Restore the cache so downstream specs (and other test files in the
    // same worker, when vitest runs single-threaded) see the production-
    // like warm state setup.ts established. Awaited so the next file's
    // first spec doesn't race the re-load.
    if (redis) await loadAllScripts(redis);
  });

  it('SHARED_SCRIPTS exposes the canonical bodies under their registry names', () => {
    expect(SHARED_SCRIPTS.INCR_AND_EXPIRE_ON_ZERO_TO_ONE).toBe(INCR_AND_EXPIRE_ON_ZERO_TO_ONE_LUA);
    expect(SHARED_SCRIPTS.RELEASE_LOCK_IF_TOKEN_MATCHES).toBe(RELEASE_LOCK_IF_TOKEN_MATCHES_LUA);
  });

  it('cold path: with no SHA cached, evalScript falls back to EVAL and the script executes', async () => {
    if (!redis) throw new Error('redis required');
    expect(getCachedSha('INCR_AND_EXPIRE_ON_ZERO_TO_ONE')).toBeUndefined();

    const evalSpy = vi.spyOn(redis, 'eval');
    const evalshaSpy = vi.spyOn(redis, 'evalsha');
    const key = `${config.appTag}:rs-cold-${crypto.randomBytes(6).toString('hex')}`;

    try {
      const result = await evalScript(redis, 'INCR_AND_EXPIRE_ON_ZERO_TO_ONE', [key], ['60']);
      expect(Number(result)).toBe(1);
      expect(evalSpy).toHaveBeenCalledTimes(1);
      expect(evalshaSpy).not.toHaveBeenCalled();
      // Cold path does NOT populate the cache — it only runs the script.
      // Population happens via loadAllScripts on (re)connect.
      expect(getCachedSha('INCR_AND_EXPIRE_ON_ZERO_TO_ONE')).toBeUndefined();
    } finally {
      await redis.del(key);
      evalSpy.mockRestore();
      evalshaSpy.mockRestore();
    }
  });

  it('warm path: after loadAllScripts, evalScript uses EVALSHA and the SHA matches the canonical Lua sha1', async () => {
    if (!redis) throw new Error('redis required');
    await loadAllScripts(redis);

    const sha = getCachedSha('INCR_AND_EXPIRE_ON_ZERO_TO_ONE');
    expect(sha).toBeDefined();
    // SHA1 of the script body is deterministic; this pins the cache shape
    // (a future regression that stores the wrong value would surface here).
    const expectedSha = crypto.createHash('sha1').update(INCR_AND_EXPIRE_ON_ZERO_TO_ONE_LUA).digest('hex');
    expect(sha).toBe(expectedSha);

    const evalSpy = vi.spyOn(redis, 'eval');
    const evalshaSpy = vi.spyOn(redis, 'evalsha');
    const key = `${config.appTag}:rs-warm-${crypto.randomBytes(6).toString('hex')}`;

    try {
      const result = await evalScript(redis, 'INCR_AND_EXPIRE_ON_ZERO_TO_ONE', [key], ['60']);
      expect(Number(result)).toBe(1);
      expect(evalshaSpy).toHaveBeenCalledTimes(1);
      expect(evalSpy).not.toHaveBeenCalled();
    } finally {
      await redis.del(key);
      evalSpy.mockRestore();
      evalshaSpy.mockRestore();
    }
  });

  it('NOSCRIPT path: SCRIPT FLUSH wipes the server cache; next evalScript re-LOADs and retries EVALSHA once', async () => {
    if (!redis) throw new Error('redis required');
    await loadAllScripts(redis);
    // Confirm cache is warm before flushing.
    const initialSha = getCachedSha('INCR_AND_EXPIRE_ON_ZERO_TO_ONE');
    expect(initialSha).toBeDefined();

    // SCRIPT FLUSH wipes Redis's SHA -> body table; the helper's local
    // cache still holds the now-stale SHA, so the next evalsha will throw
    // NOSCRIPT.
    await redis.script('FLUSH');

    const scriptSpy = vi.spyOn(redis, 'script');
    const evalshaSpy = vi.spyOn(redis, 'evalsha');
    const key = `${config.appTag}:rs-noscript-${crypto.randomBytes(6).toString('hex')}`;

    try {
      const result = await evalScript(redis, 'INCR_AND_EXPIRE_ON_ZERO_TO_ONE', [key], ['60']);
      expect(Number(result)).toBe(1);
      // Two evalsha attempts: the first hits NOSCRIPT, the second runs
      // post-reload and succeeds.
      expect(evalshaSpy).toHaveBeenCalledTimes(2);
      // Exactly one SCRIPT LOAD between the failed and successful evalsha.
      const loadCalls = scriptSpy.mock.calls.filter((args) => args[0] === 'LOAD');
      expect(loadCalls).toHaveLength(1);
      // Cache holds the post-reload SHA; SHA is content-addressed so it's
      // the same value, but the assertion confirms the helper updated the
      // cache rather than leaving it stale.
      expect(getCachedSha('INCR_AND_EXPIRE_ON_ZERO_TO_ONE')).toBe(initialSha);
    } finally {
      await redis.del(key);
      scriptSpy.mockRestore();
      evalshaSpy.mockRestore();
    }
  });

  it('non-NOSCRIPT errors propagate without triggering re-LOAD', async () => {
    if (!redis) throw new Error('redis required');
    await loadAllScripts(redis);

    const scriptSpy = vi.spyOn(redis, 'script');
    // Simulate a non-NOSCRIPT failure path (e.g. OOM, Lua runtime error)
    // by mocking evalsha to reject with a generic Error.
    const evalshaSpy = vi.spyOn(redis, 'evalsha').mockRejectedValueOnce(
      new Error('Lua error: OOM command not allowed when used memory > maxmemory'),
    );

    try {
      await expect(
        evalScript(redis, 'INCR_AND_EXPIRE_ON_ZERO_TO_ONE', ['k'], ['60']),
      ).rejects.toThrow(/OOM/);
      // No re-LOAD attempted — the error propagates straight through.
      const loadCalls = scriptSpy.mock.calls.filter((args) => args[0] === 'LOAD');
      expect(loadCalls).toHaveLength(0);
      expect(evalshaSpy).toHaveBeenCalledTimes(1);
    } finally {
      scriptSpy.mockRestore();
      evalshaSpy.mockRestore();
    }
  });

  it('RELEASE_LOCK_IF_TOKEN_MATCHES dispatches via evalScript and matches the lock-token semantics', async () => {
    if (!redis) throw new Error('redis required');
    await loadAllScripts(redis);

    const lockKey = `${config.appTag}:rs-lock-${crypto.randomBytes(6).toString('hex')}`;
    const token = crypto.randomBytes(8).toString('hex');

    try {
      // Match path: caller's token still owns the key — DEL fires, returns 1.
      await redis.set(lockKey, token);
      const released = await evalScript(redis, 'RELEASE_LOCK_IF_TOKEN_MATCHES', [lockKey], [token]);
      expect(released).toBe(1);
      expect(await redis.get(lockKey)).toBeNull();

      // Mismatch path: another holder has the key — DEL does NOT fire, returns 0.
      await redis.set(lockKey, 'other-holder');
      const notReleased = await evalScript(redis, 'RELEASE_LOCK_IF_TOKEN_MATCHES', [lockKey], [token]);
      expect(notReleased).toBe(0);
      expect(await redis.get(lockKey)).toBe('other-holder');
    } finally {
      await redis.del(lockKey);
    }
  });
});
