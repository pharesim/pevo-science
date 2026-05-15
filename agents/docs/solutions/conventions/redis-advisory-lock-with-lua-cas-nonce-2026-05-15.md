---
title: Redis advisory lock with Lua CAS release on per-acquisition nonce — primitive for serializing read-then-write paths
date: 2026-05-15
category: conventions
module: backend
problem_type: convention
component: authentication
severity: high
applies_when:
  - Designing a route that needs to serialize concurrent same-resource requests across the Express process (or across replicas, if PEvO ever runs multi-instance)
  - Adding a duplicate-prevention lock on a HAF-backed read-then-write path
  - Adding a lock on any path where two concurrent same-key requests must not both reach the final mutating step
  - Reviewing an existing handler that uses `SET NX EX` for advisory locking — verify the release-side uses Lua CAS, not naive `DEL`
  - Implementing operator-visibility on lock-TTL-exceeded cascades (slow downstream, broadcast stall, external API hang)
tags:
  - "redis"
  - "distributed-lock"
  - "setnx"
  - "lua-cas"
  - "nonce"
  - "ttl"
  - "advisory-lock"
  - "concurrency"
  - "operator-visibility"
---

# Redis advisory lock with Lua CAS release on per-acquisition nonce — primitive for serializing read-then-write paths

## Context

PEvO's backend needs a same-process and (potentially) cross-replica primitive to serialize concurrent requests for the same resource. Redis `SET NX EX` is the standard tool, but the obvious release pattern (`DEL <key>` in `finally`) has a subtle TTL race: if the lock holder's wall-clock exceeds the TTL, the lock self-expires, a sibling acquires under a fresh nonce, and the original holder's `DEL` removes the SIBLING's lock — silently breaking the very serialization the lock was added to provide.

The mitigation is Lua-script-based compare-and-swap (CAS) on the lock value: release ONLY if the stored value matches the caller's per-acquisition nonce. Lua runs atomically inside Redis, so the `GET → compare → DEL` cycle cannot interleave with another acquisition.

This pattern has been implemented at least twice in PEvO independently (`backend/src/routes/orcid.ts` `withOrcidBindingLock`; `backend/src/routes/bridge.ts` `acquireBridgeLock`/`releaseBridgeLock`). Both implementations diverged on minor details (TTL value, release-side logging, helper-vs-inline shape) before converging on the same fundamentals. Capturing the canonical primitive so the third implementation lands without re-derivation.

## Guidance

### Lock acquisition (`SET NX EX` with random nonce)

```ts
const LOCK_TTL_SECONDS = 35;
const LOCK_NONCE_RE = /^[0-9a-f]{32}$/;

type LockState =
  | { state: 'acquired'; nonce: string; acquiredAtMs: number }
  | { state: 'held' }
  | { state: 'unavailable' };

async function acquireLock(lockKey: string): Promise<LockState> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return { state: 'unavailable' };

  const nonce = crypto.randomBytes(16).toString('hex');

  // Sanity-check the nonce encoding. Lua CAS does byte-for-byte equality;
  // a future refactor changing the nonce away from printable-ASCII hex
  // would silently never match. Cheap; forecloses drift.
  if (!LOCK_NONCE_RE.test(nonce)) {
    logger.error({ lockKey, event: 'lock.nonce_drift' }, 'lock nonce shape invariant violated');
    return { state: 'unavailable' };
  }

  try {
    const result = await redis.set(lockKey, nonce, 'EX', LOCK_TTL_SECONDS, 'NX');
    if (result === 'OK') return { state: 'acquired', nonce, acquiredAtMs: Date.now() };
    return { state: 'held' };
  } catch (err) {
    logger.error({ err, lockKey, event: 'lock.redis_outage' }, 'lock acquisition failed');
    return { state: 'unavailable' };
  }
}
```

Key points:
- **Discriminated-union return**: `'acquired'` / `'held'` / `'unavailable'`. The three states have three distinct caller-response policies (proceed under lock / surface 409 LOCK_HELD / degrade to unlocked path). An `assertNever` guard on the trailing else of the switch protects against a future 4th variant slipping through silently.
- **Per-acquisition nonce**: 16 random bytes → 32 hex chars, generated FRESH per acquisition. The nonce is the proof-of-ownership token that survives into the release path.
- **TTL > broadcast wall-clock + headroom**: Currently 35s for bridge and orcid; that's `DEFAULT_BROADCAST_TIMEOUT_MS` (30s) + 5s margin. If the protected wall-clock changes, update the TTL. Worst-case in-lock IO MUST comfortably fit; otherwise the TTL-exceeded cascade case dominates.
- **'unavailable' → degrade gracefully, not 503**: Redis flap is rare; a Redis-down 503 on every request would be more user-hostile than the rare duplicate during a flap. Surface a structured log so operators see the degrade, but let the request proceed under the unlocked path. (This is the orcid + bridge convention; routes with stricter requirements can fail-closed instead.)

### Lock release (Lua CAS on the per-acquisition nonce)

```ts
const RELEASE_LOCK_LUA =
  `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

async function releaseLock(
  lockKey: string,
  nonce: string,
  acquiredAtMs: number,
  routeLabel: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    const ret = await redis.eval(RELEASE_LOCK_LUA, 1, lockKey, nonce);
    if (ret === 0) {
      // TTL expired or sibling re-acquired under a new nonce. Operator
      // visibility on TTL-exceeded cascades: the broadcast outlasted the
      // lock TTL (likely slow downstream, broadcast stall, or external IO
      // hang inside the lock window). wallClockMs lets the dashboard
      // correlate against LOCK_TTL_SECONDS without rebuilding from logs.
      logger.warn(
        {
          lockKey,
          route: routeLabel,
          wallClockMs: Date.now() - acquiredAtMs,
          ttlSeconds: LOCK_TTL_SECONDS,
          event: 'lock.release_no_op',
        },
        'lock release no-op: TTL expired or sibling re-acquired',
      );
    }
  } catch (err) {
    logger.warn({ err, lockKey, event: 'lock.release_failed' }, 'failed to release lock');
  }
}
```

Key points:
- **Lua CAS, not naive `DEL`**: Lua runs atomically inside Redis. Without it, the `GET → compare → DEL` cycle in TypeScript can interleave with another acquisition and you delete the wrong lock.
- **Inspect the eval return**: `1` = matched-and-deleted (clean release). `0` = no-op (key absent or held a different nonce — TTL-exceeded cascade signal). Always log the `0` case as a structured warn; operator dashboards key on `event: '<domain>.lock.release_no_op'` for TTL-cascade alerts.
- **`wallClockMs` in the no-op log**: Computed from `acquiredAtMs` (set on acquire) to the release-time `Date.now()`. Lets the dashboard correlate against the configured TTL without rebuilding the timeline from other logs. (Note: `Date.now()` is wall-clock; on rare clock-skew events `wallClockMs` could be negative — accepted at PEvO's single-instance topology. If observability becomes a real concern, swap to `performance.now()`.)
- **Best-effort on `redis.eval` throw**: The lock self-expires at `LOCK_TTL_SECONDS` so a missed release is bounded. Don't let a release failure mask the original error.

### Caller invariants

- The `'acquired'` state MUST be matched by a `releaseLock(...)` in `finally`. The state machine is binary at that level: if you acquired, you release; if you got `'held'` or `'unavailable'`, you do NOT release.
- The lock window must be tight. Any external IO (HTTP calls, external API lookups, slow DB queries that aren't part of the protected pre-condition check) MUST be hoisted out before lock acquisition. See `read-then-write-races-on-haf-backed-routes-2026-05-15.md` for the canonical example (the bridge `/register` round-2 hoist of `lookupPreprint` out of the lock window).
- For wrapper helpers (`withOrcidBindingLock` in orcid.ts), the caller passes a callback that runs inside the lock. The wrapper owns acquire + finally + release; the caller owns only the protected work. Prefer this shape when the lock is reused across multiple handlers on the same domain.

## Why This Matters

The TTL race is non-obvious and the failure mode is silent: `DEL <key>` in `finally` works correctly in 99%+ of paths (anywhere the broadcast finishes under TTL), and fails silently in exactly the cases where the lock is most needed (slow downstream, sustained load, TTL-exceeded cascade). The 1% that breaks is the 1% where serialization correctness matters most.

Per-acquisition nonces + Lua CAS make the race impossible at the Redis level. The cost is one extra `redis.eval` round-trip per release (negligible vs the broadcast wall-clock) and ~12 lines of code per implementation.

The `lock.release_no_op` log emission is the operational complement: it surfaces the case the lock CAN'T prevent (the broadcast itself outran the TTL, so a sibling could legitimately re-acquire). Without that signal, operators have no visibility into the very condition that motivates TTL-sizing decisions.

## When to Apply

- Designing a route that serializes concurrent same-resource requests under a service-account broadcast
- Migrating an inline `SET NX EX` lock from naive `DEL` release to Lua CAS — this is the standard upgrade once an existing route enters serious code review
- Building a new domain-specific wrapper helper (`withFooLock(resourceId, callback)`) — reach for this shape when the lock is reused across multiple handlers
- Reviewing a route during `/ce-code-review` — verify acquire-side discriminated union with `assertNever`, release-side Lua CAS, `wallClockMs` instrumentation, and `${config.appTag}:` Redis key prefix

## Examples

### Canonical exemplars in the PEvO codebase

- `backend/src/routes/bridge.ts` — `BRIDGE_LOCK_TTL_SECONDS`, `BRIDGE_LOCK_NONCE_RE`, `BRIDGE_RELEASE_LOCK_LUA`, `bridgeRegisterLockKey`, `acquireBridgeLock`, `releaseBridgeLock`. Inline shape. Per-permlink keying. The `wallClockMs` instrumentation landed in round-2 of `backend-bridge-write-haf-lag-and-retry-amplification.md`.

- `backend/src/routes/orcid.ts` — `withOrcidBindingLock(orcidId, callback)`. Wrapper shape; the callback runs inside the lock. Per-ORCID-ID keying. Predates the bridge instance; the bridge implementation adopted the same Lua script verbatim and added `wallClockMs` instrumentation that orcid does not yet have (filed as a separate follow-up).

### Redis key prefix

All lock keys MUST be prefixed with `${config.appTag}:` per PEvO project memory `reference_redis_app_tag.md`. The full key shape is `${config.appTag}:<lock_domain>:<resource-id>`, e.g.:

- `${config.appTag}:bridge_register_lock:${permlink}`
- `${config.appTag}:orcid_binding_lock:${orcidId}`

This isolates lock keys from other Redis tenants (caches, rate limits, tokens) and from other PEvO deployments sharing a Redis instance.

### Anti-example — naive DEL release

```ts
// BAD — TTL race silently breaks serialization.
async function releaseLockNaive(lockKey: string): Promise<void> {
  await getRedis().del(lockKey);  // deletes whatever's there, including a sibling's lock
}
```

If the original holder's broadcast outruns TTL:
1. Holder's lock self-expires.
2. Sibling acquires fresh lock under a new nonce.
3. Original holder finishes broadcast, enters `finally`, calls `redis.del(lockKey)` — deletes SIBLING's lock.
4. A third request now acquires, sibling's broadcast was unprotected for its tail.

The Lua CAS variant fails-safe in this case (returns 0; no-op; logs the cascade). The naive variant fails-unsafe (returns 1; deletes the wrong key; no signal).

## Related

- `agents/docs/solutions/conventions/read-then-write-races-on-haf-backed-routes-2026-05-15.md` — the lock-around-the-read-AND-broadcast pattern that depends on this primitive.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — broadcast timeout semantics that motivate the `wallClockMs` instrumentation and the TTL-sizing constraint.
- `agents/docs/solutions/conventions/correlated-options-discriminated-union-2026-04-28.md` — the `assertNever` exhaustiveness rule that applies to the `'acquired'` / `'held'` / `'unavailable'` discriminated union.
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` — when documenting future enhancements to this primitive (e.g., orcid `wallClockMs` parity, lock-TTL extension on `BroadcastTimeoutError`), anchor on behavioral conditions rather than task slugs.
- Canonical exemplars in code: `backend/src/routes/bridge.ts`, `backend/src/routes/orcid.ts`.
