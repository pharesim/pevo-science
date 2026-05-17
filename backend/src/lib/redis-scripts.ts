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
 * Atomic rate-limit check-and-consume Lua script.
 *
 * KEYS[1] = redis key for this (limiter-name, account/ip) bucket
 * ARGV[1] = max (decimal string)
 * ARGV[2] = windowMs (decimal string; PEXPIRE argument)
 *
 * Returns: { passed (1|0), pttlMs }
 *
 * On entry:
 *   1. INCR the counter (atomic; first INCR returns 1).
 *   2. If new count > max: DECR back (slot not consumed) and return
 *      {0, currentPttl} → caller sends 429 with Retry-After.
 *   3. If new count ≤ max: PEXPIRE unconditionally and return {1, 0} →
 *      caller passes through.
 *
 * The PEXPIRE is unconditional — not "only on count==1" — to close a
 * permanent-lockout bug. Under skipFailedRequests=true, a deferred-INCR
 * pattern where PEXPIRE only fired on count==1 would, under concurrent
 * post-success INCRs, leave the key at count>1 with no TTL ever. The key
 * never expires, every subsequent request sees count > max, the user is
 * permanently locked out until the Redis key is manually deleted.
 * Re-priming PEXPIRE on every successful pass costs one extra command and
 * eliminates the failure mode entirely.
 *
 * Refund of failed responses (status >= 400 under skipFailedRequests) is
 * a separate one-command DECR fired in the `res.on('finish')` /
 * `res.on('close')` callbacks; the atomic limit-check Lua doesn't know
 * the response outcome at entry time and doesn't need to — the refund
 * path is a single round-trip.
 *
 * Window semantic: the unconditional PEXPIRE makes this a ROLLING window
 * (TTL refreshed on every successful entry), not a fixed window. A bucket
 * pinned just under `max` by a steady stream of in-bound INCRs keeps its
 * TTL refreshed indefinitely; the window effectively follows the most
 * recent successful pass. This is the intended trade-off vs. the
 * permanent-lockout bug it replaces. For IP-keyed limiters on routes
 * shared via NAT or carrier proxies, this means an attacker storming a
 * NAT'd IP can keep that bucket non-expiring; legitimate users sharing
 * the IP see sustained 429s instead of fixed-window recovery. The bound
 * remains `max` requests within any rolling 60s; the difference is when
 * the count resets. Counter-rejects (DECR-on-overflow) do NOT refresh
 * PEXPIRE, so under sustained over-`max` storms the bucket still expires
 * on the original windowMs from the last successful in-bound INCR.
 */
export const RATE_LIMIT_CHECK_AND_CONSUME_LUA = `
local count = redis.call('INCR', KEYS[1])
local max = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
if count > max then
  redis.call('DECR', KEYS[1])
  local pttl = redis.call('PTTL', KEYS[1])
  if pttl < 0 then pttl = windowMs end
  return {0, pttl}
end
redis.call('PEXPIRE', KEYS[1], windowMs)
return {1, 0}
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
  RATE_LIMIT_CHECK_AND_CONSUME: RATE_LIMIT_CHECK_AND_CONSUME_LUA,
} as const;

export type SharedScriptName = keyof typeof SHARED_SCRIPTS;

/**
 * Static contract for each script's return type. Used by `evalScript<N>`
 * so callers receive `ScriptReturn[N]` instead of `unknown` and don't need
 * a load-bearing `as` cast at the call site. The mapping must be kept in
 * sync with the Lua return statements above; a future script added to
 * `SHARED_SCRIPTS` without an entry here is a compile error.
 *
 * The mapped-type also makes future script additions automatically type-
 * safe (a `Promise<unknown>` return forced every caller to invent their
 * own ad-hoc cast, where a typo silently bypassed runtime checks).
 *
 * Note: this is a STATIC contract, not a runtime guarantee. ioredis returns
 * `unknown` from `eval`/`evalsha` and the cast lives at the boundary inside
 * `evalScript`. Callers that depend on the array/numeric shape should add
 * runtime narrowing — see the defensive check in `rateLimit.ts` for the
 * pattern.
 */
export type ScriptReturn = {
  INCR_AND_EXPIRE_ON_ZERO_TO_ONE: number;
  RELEASE_LOCK_IF_TOKEN_MATCHES: 0 | 1;
  RATE_LIMIT_CHECK_AND_CONSUME: [number, number];
};

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
export async function evalScript<N extends SharedScriptName>(
  redis: Redis,
  name: N,
  keys: string[],
  args: string[],
): Promise<ScriptReturn[N]> {
  const body = SHARED_SCRIPTS[name];
  const sha = scriptShaCache.get(name);
  if (!sha) {
    return (await redis.eval(body, keys.length, ...keys, ...args)) as ScriptReturn[N];
  }
  try {
    return (await redis.evalsha(sha, keys.length, ...keys, ...args)) as ScriptReturn[N];
  } catch (err) {
    if (isNoScriptError(err)) {
      const reloadedSha = (await redis.script('LOAD', body)) as string;
      scriptShaCache.set(name, reloadedSha);
      return (await redis.evalsha(reloadedSha, keys.length, ...keys, ...args)) as ScriptReturn[N];
    }
    throw err;
  }
}
