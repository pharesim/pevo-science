/**
 * Shared Redis Lua scripts and the SCRIPT LOAD + EVALSHA dispatch helper.
 *
 * Call shared scripts via `evalScript(redis, '<NAME>', keys, args)` rather
 * than `redis.eval(BODY, ...)` directly. The helper sends the cached SHA
 * via EVALSHA when available, falls back to EVAL on cache miss, and on
 * NOSCRIPT (server flushed scripts after FLUSHALL or restart) it re-loads
 * the body and retries EVALSHA once. SHA registration happens in
 * `redis.ts`'s `ready` handler via `loadAllScripts(redis)`, which fires
 * on every (re)connect.
 *
 * Direct `redis.eval` is reserved for ad-hoc one-off scripts that aren't
 * worth registry membership; shared scripts MUST go through `evalScript`.
 */

import type Redis from 'ioredis';

/**
 * Atomic INCR-with-conditional-EXPIRE Lua script. Returns the post-
 * increment count. Sets EXPIRE in the same round trip when the post-INCR
 * count is exactly 1 — i.e. on every transition from 0 → 1.
 *
 * Operator invariant: EXPIRE fires on every transition-to-1
 * (count==0 → count==1), NOT only on the very first write to the key.
 * After a pre-INCR + DECR-on-timeout cycle the counter sits at 0 and a
 * subsequent INCR re-primes EXPIRE; safety is preserved because the TTL
 * anchor (`pending.expires_at`) monotonically shrinks across cycles, so
 * the counter cannot outlive the token it gates.
 *
 * Re-priming TTL on every INCR (irrespective of count) would let an
 * attacker indefinitely extend the counter past the token's natural
 * expiration; the conditional gate keeps the counter's lifetime bounded
 * by the token, even across decrement-and-retry cycles.
 *
 * The atomic wrapper closes the two-RTT race in a separate INCR + EXPIRE
 * pair: a crash or connection drop between the two could leave a TTL-
 * less counter stranded past the token's 24h life and lock the
 * legitimate user out for 24h with no automatic recovery.
 */
export const INCR_AND_EXPIRE_ON_ZERO_TO_ONE_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
` as const;

/**
 * Compare-token DEL for distributed locks.
 *
 * KEYS[1] = lock key path
 * ARGV[1] = token the caller wrote at SET-NX time
 *
 * Returns 1 if the lock was held by the caller and was released; 0 if the
 * lock had already expired (different token, or absent). Required for
 * multi-instance safety — a naive `redis.del(lockKey)` from inside the
 * caller's `finally` would happily release a lock another instance acquired
 * after this caller's TTL elapsed.
 */
export const RELEASE_LOCK_IF_TOKEN_MATCHES_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
` as const;

/**
 * Registry of shared Lua scripts dispatched via `evalScript`. The registry
 * key is the canonical short name; the value is the script body. Adding a
 * new entry here is the entire registration step — `loadAllScripts` picks
 * it up automatically on the next Redis (re)connect.
 */
export const SHARED_SCRIPTS = {
  INCR_AND_EXPIRE_ON_ZERO_TO_ONE: INCR_AND_EXPIRE_ON_ZERO_TO_ONE_LUA,
  RELEASE_LOCK_IF_TOKEN_MATCHES: RELEASE_LOCK_IF_TOKEN_MATCHES_LUA,
} as const;

export type SharedScriptName = keyof typeof SHARED_SCRIPTS;

const scriptShaCache = new Map<SharedScriptName, string>();

export function getCachedSha(name: SharedScriptName): string | undefined {
  return scriptShaCache.get(name);
}

export function clearScriptShaCache(): void {
  scriptShaCache.clear();
}

/**
 * Load every shared script into Redis and cache its SHA. Called from
 * `redis.ts` on the `ready` event so SHAs are warm by the time the first
 * `evalScript` call hits. Re-runs on every reconnect because Redis SCRIPTS
 * are wiped on FLUSHALL or restart.
 */
export async function loadAllScripts(redis: Redis): Promise<void> {
  const entries = Object.entries(SHARED_SCRIPTS) as [SharedScriptName, string][];
  await Promise.all(
    entries.map(async ([name, body]) => {
      const sha = (await redis.script('LOAD', body)) as string;
      scriptShaCache.set(name, sha);
    }),
  );
}

function isNoScriptError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('NOSCRIPT');
}

/**
 * Dispatch a shared script via EVALSHA with NOSCRIPT-fallback. Falls back
 * to EVAL when the SHA cache is cold (e.g. first call before
 * `loadAllScripts` ran, or after `clearScriptShaCache` in tests).
 *
 * Errors other than NOSCRIPT propagate unchanged so callers can keep their
 * existing catch semantics.
 */
export async function evalScript(
  redis: Redis,
  name: SharedScriptName,
  keys: string[],
  args: string[],
): Promise<unknown> {
  const body = SHARED_SCRIPTS[name];
  const sha = scriptShaCache.get(name);
  if (!sha) {
    return redis.eval(body, keys.length, ...keys, ...args);
  }
  try {
    return await redis.evalsha(sha, keys.length, ...keys, ...args);
  } catch (err) {
    if (isNoScriptError(err)) {
      const reloadedSha = (await redis.script('LOAD', body)) as string;
      scriptShaCache.set(name, reloadedSha);
      return redis.evalsha(reloadedSha, keys.length, ...keys, ...args);
    }
    throw err;
  }
}
