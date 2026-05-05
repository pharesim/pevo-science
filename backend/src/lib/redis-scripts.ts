/**
 * Shared Redis Lua scripts.
 *
 * These scripts are loaded as constants and replayed via `redis.eval(...)`
 * at the call site. Centralizing them here lets tests import the canonical
 * script body rather than duplicating it verbatim, avoiding drift between
 * the route's runtime script and the test that asserts its on-disk
 * invariants.
 */

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
