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
 * worth registry membership; shared scripts should go through `evalScript`.
 * There is no lint backstop on this, so two lock-release CAS scripts still
 * call `redis.eval` directly — `routes/orcid.ts` RELEASE_LOCK_LUA and
 * `routes/bridge.ts` BRIDGE_RELEASE_LOCK_LUA — even though they duplicate the
 * registered RELEASE_LOCK_IF_TOKEN_MATCHES semantic. Migrating them is a
 * separate task; until then "should" is the accurate strength, not "MUST".
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
 * Atomic cycle swap for batch reputation. Renames every staging key into its
 * production counterpart, advances `cycle:last`, and DELs the in-progress
 * sentinel inside a single server-side execution so readers see either the
 * full new cycle or none of it.
 *
 * KEYS[1..N-1] = staging key paths
 * KEYS[N]      = in-progress sentinel key (DEL'd inside the script after the
 *                cycle:last advance, so a surviving sentinel on the next
 *                startup proves the crash happened BEFORE the script executed)
 * ARGV[1]      = new cycle number (string)
 * ARGV[2]      = cycle:last key path
 * ARGV[3]      = staging substring to strip (e.g. ':batch:staging:')
 * ARGV[4]      = prod substring to inject (e.g. ':batch:')
 *
 * The substrings are passed as ARGV instead of hard-coded so the Lua side and
 * the TS-side constructors share a single source of truth in the caller
 * (`reputation-batch.ts`); the staging-vs-prod naming is a reputation-batch
 * concern, not a redis-scripts concern, which is why the substring constants
 * stay at the caller.
 */
export const CYCLE_SWAP_LUA = `
local nKeys = #KEYS
local stagingCount = nKeys - 1
local sentinel = KEYS[nKeys]
for i = 1, stagingCount do
  local staging = KEYS[i]
  local prod = string.gsub(staging, ARGV[3], ARGV[4])
  redis.call('RENAME', staging, prod)
end
redis.call('SET', ARGV[2], ARGV[1])
redis.call('DEL', sentinel)
return stagingCount
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
  CYCLE_SWAP: CYCLE_SWAP_LUA,
} as const;

export type SharedScriptName = keyof typeof SHARED_SCRIPTS;

/**
 * Static contract for each script's return type. Used by `evalScript<N>`
 * so callers receive `ScriptReturn[N]` instead of `unknown` and don't need
 * a load-bearing `as` cast at the call site. `_SCRIPT_RETURN_SHAPE` below
 * is a stand-in value whose object-literal shape carries the per-script
 * return types; `ScriptReturn = typeof _SCRIPT_RETURN_SHAPE` then re-exports
 * that shape as the public type. Compile-time exhaustiveness is enforced
 * by the `satisfies Record<SharedScriptName, unknown>` clause on the value
 * — drift in either direction is a definition-site error:
 *   - A script added to SHARED_SCRIPTS without a shape entry → the Record's
 *     required-keys check rejects the literal ("Property 'X' is missing").
 *   - A stale shape entry whose script was removed → satisfies-on-an-
 *     object-literal applies the excess-property check ("Object literal
 *     may only specify known properties, and 'X' does not exist in type
 *     'Record<SharedScriptName, unknown>'").
 *
 * This is the convention's canonical `satisfies`-on-a-value form — see
 * `agents/docs/solutions/conventions/satisfies-record-for-mapped-type-and-set-completeness-2026-05-17.md`.
 * Replaces the prior `_NoMissingReturn`/`_NoExtraReturn` pair, which was
 * mechanically correct but diverged from the documented repo-wide pattern
 * for the same exhaustiveness invariant.
 *
 * Note: this is a STATIC contract, not a runtime guarantee. ioredis returns
 * `unknown` from `eval`/`evalsha` and the cast lives at the boundary inside
 * `evalScript`. The placeholder values inside `_SCRIPT_RETURN_SHAPE` are
 * never read at runtime; only the literal's shape matters for the
 * `typeof`-derived type. Callers that depend on the array/numeric shape
 * should add runtime narrowing — see the defensive check in `rateLimit.ts`.
 */
const _SCRIPT_RETURN_SHAPE = {
  INCR_AND_EXPIRE_ON_ZERO_TO_ONE: 0 as number,
  RELEASE_LOCK_IF_TOKEN_MATCHES: 0 as 0 | 1,
  RATE_LIMIT_CHECK_AND_CONSUME: [0, 0] as [number, number],
  CYCLE_SWAP: 0 as number,
} satisfies Record<SharedScriptName, unknown>;
export type ScriptReturn = typeof _SCRIPT_RETURN_SHAPE;

const scriptShaCache = new Map<SharedScriptName, string>();

/**
 * @internal Test-only accessor for the SHA cache. Production code reads the
 * cache through `evalScript`; nothing in the production surface needs this.
 */
export function getCachedSha(name: SharedScriptName): string | undefined {
  return scriptShaCache.get(name);
}

/**
 * @internal Test-only cache reset (drives the cold-cache EVAL-fallback and
 * NOSCRIPT-recovery branches). Not a production reset API — a production
 * caller would silently degrade every `evalScript` call to the EVAL fallback
 * with no log or signal.
 */
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
  // Couples to ioredis passing Redis's server-reply error through with its
  // `NOSCRIPT ...` prefix intact. A major ioredis upgrade that rewraps
  // server errors with a different message shape would silently break the
  // NOSCRIPT-recovery retry below; revisit this match at ioredis upgrades.
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
