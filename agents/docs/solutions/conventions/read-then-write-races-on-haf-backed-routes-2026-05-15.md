---
title: Read-then-write races on HAF-backed routes — lock around the read AND the broadcast; hoist external IO out; fail-closed on writes
date: 2026-05-15
category: conventions
module: backend
problem_type: convention
component: authentication
severity: high
applies_when:
  - Designing a route that reads HAF (or any asynchronously-replicated index of chain state) and then broadcasts a write under a service account
  - Adding a duplicate-check before a broadcast that creates a top-level post or attestation
  - A route that mutates Hive state based on a HAF-derived pre-condition (version counter, existence check, prior-state lookup)
  - Reviewing a write route that could legitimately receive two concurrent requests for the same resource (admin tools, batch importers, retry-after-timeout flows)
  - A route's worst-case in-lock wall-clock approaches or exceeds the lock TTL
tags:
  - "haf"
  - "haf-lag"
  - "distributed-lock"
  - "redis-setnx"
  - "lua-cas"
  - "fail-closed"
  - "fail-open"
  - "broadcast"
  - "duplicate-prevention"
  - "ttl-cascade"
---

# Read-then-write races on HAF-backed routes — lock around the read AND the broadcast; hoist external IO out; fail-closed on writes

## Context

PEvO's backend reads chain state via HAF SQL (an asynchronously-replicated PostgreSQL index over Hive's blockchain). HAF lags chain by ~1-3 seconds typically, more on node restarts or forks. Any route that reads HAF and then broadcasts a write under a service account is susceptible to a read-then-write race in the HAF-replication window:

- Request A reads HAF, sees no duplicate, broadcasts.
- Concurrent Request B reads HAF (still replicating A's broadcast), sees no duplicate, broadcasts a duplicate.
- Both ops land on chain.

The race window is bounded by HAF lag, not by lock TTL — the lock alone (around the broadcast call) is insufficient because the duplicate-check read happens before the lock.

This race has appeared on at least three independent PEvO surfaces in code review (ORCID `/callback` bind flow, bridge `/register`, bridge `/update` before it was retired). The third instance arrived without warning. Capturing the canonical mitigation so the fourth instance has a documented pattern to land on Day 1.

## Guidance

### 1. Lock around the **read** AND the broadcast, not just the broadcast

Acquire a per-resource Redis advisory lock (`SET NX EX` on a deterministic key derived from the resource identifier) BEFORE the HAF duplicate-check read. Hold the lock until the broadcast resolves. Release in `finally` under Lua CAS on a per-acquisition nonce (see `agents/docs/solutions/conventions/redis-advisory-lock-with-lua-cas-nonce-2026-05-15.md` for the lock primitive).

Concurrent requests for the same resource serialize on the lock; the second one either waits and re-reads HAF after the first releases (now seeing the first's write) OR fails fast with a retriable 409 `LOCK_HELD` discriminator that lets the client decide.

### 2. Hoist external IO OUT of the lock window

External IO (CrossRef, PubMed, DOI scrape, third-party metadata lookups, etc.) MUST live BEFORE lock acquisition. The lock window must contain only: the HAF duplicate-check (~100ms) plus the broadcast call (`DEFAULT_BROADCAST_TIMEOUT_MS = 30s` in `hive.ts`). Worst-case in-lock wall-clock must remain comfortably under the lock TTL (currently 35s on bridge and orcid).

If external IO runs INSIDE the lock window and its wall-clock can blow through the TTL, the TTL expires mid-broadcast, a sibling acquires under a new nonce, and you get exactly the duplicate-broadcast the lock was added to prevent. The chain's `tx_duplicate` rejection is the LAST line of defense — exactly the dependency the lock was added to remove.

The hoisted IO does NOT need lock protection: it's a pure read against external systems with no chain-state side-effects. The lock protects the HAF-read-then-broadcast cycle, not the metadata fetch.

### 3. Fail-closed on write paths; fail-open on read-only probes

When the HAF duplicate-check throws (HAF outage, query error), the route's response policy must differ by intent:

- **Write paths** (`/register`, `/update`, `/callback` bind): **fail-closed**. Return 503 `SERVICE_UNAVAILABLE` with `details.retriable: true`. Do NOT broadcast — a successful broadcast under a HAF outage could create a duplicate top-level post that no future duplicate-check can detect (because HAF was down when the original was written; the duplicate-check returns "no duplicate" forever via TOCTOU lag). Bridge writes are infrequent and a HAF outage is operationally significant; failing closed surfaces it.

- **Read-only probes** (`/check`, `/lookup`): **fail-open**. Return 200 with `{exists: false, …}` and a structured warn log. The consequence of a spurious "no duplicate" answer on a probe is bounded: the client sees stale data for a few seconds. The consequence of the same answer on the write path licenses a duplicate broadcast.

The discriminated return shape of `checkExistingBridge` (`{status: 'ok'} | {status: 'haf_unavailable'}`) lets both callers branch correctly: `/register` maps `haf_unavailable` → 503 + no broadcast; `/check` maps it → `{exists: false}` + log. An `assertNever` guard at the trailing else of each switch makes a future third variant a compile error rather than a silent fall-through to the broadcast or ok branch.

### 4. Skip caching of failure sentinels

If the HAF read is wrapped by a cache (`QueryCache.getOrSet` etc.), the cache MUST write through ONLY the success variant. Caching `{status: 'haf_unavailable'}` poisons the cache for the full TTL — every subsequent `/check` returns the cached "no duplicate" answer mapped to fail-open, hiding the fact that HAF has recovered. Resolve the function call OUTSIDE `getOrSet` and write only the `'ok'` variant into the cache.

### 5. Discriminate the two 409 contracts at the response level

Two failure modes look superficially similar but mean different things to clients:

- **`LOCK_HELD` (409, retriable)**: A concurrent same-resource request is in flight. The holder will finish within the broadcast wall-clock bound; the client can retry. `details.retriable: true`.
- **`DUPLICATE` (409, terminal)**: The resource already permanently exists on chain. Retrying produces the same answer. `details.retriable` absent.

Sharing the same code (`DUPLICATE`) for both forces clients to parse the message string to discriminate — a load-bearing wire-contract surface that breaks on the next message-text refactor. Use distinct codes; document both in `agents/docs/api-contracts/common.md`.

## Why This Matters

The race is real, the failure mode is severe (duplicate top-level posts on chain that no future duplicate-check can detect via HAF), and the canonical mitigation has been independently re-derived on at least three PEvO routes before this convention was written. Each re-derivation:
- Took multiple code-review rounds to converge (bridge cluster: round-1 surfaced 9 items including this class; round-2 landed the lock + hoist + fail-closed; round-3 still finishing polish).
- Risked landing a partial fix (lock around the broadcast only, missing the read; cache wrapping the haf_unavailable sentinel; lookupPreprint left inside the lock window).
- Had test coverage that asserted the wrong axis (response shape without cache-key-absence assertion).

Documenting the full pattern lets the next HAF-backed write route land Day-1-correct rather than going through the same multi-round convergence.

The cost of doing this wrong: a duplicate broadcast under a service account is not user-recoverable. The bridge account `pevo.admin` posts a top-level paper post; a duplicate creates TWO entries on chain at distinct permlinks, both attributed to the bridge. Cleanup requires admin coordination and explicit chain ops. The HAF index never converges to a "single canonical" answer because BOTH posts are valid chain state.

## When to Apply

- Designing a new route that reads HAF state and then writes to chain under any service account
- Adding a duplicate-check before any broadcast that creates a top-level post or a chain-side attestation
- Reviewing a write route during `/ce-code-review` — verify lock placement around the read, IO hoist, fail-closed/fail-open policy, cache write-through filter, and the 409 discrimination
- Migrating an existing route from "no advisory lock" to "advisory-locked" — the lock pattern alone is insufficient if the read is outside the lock window

## Examples

### Canonical exemplar — `backend/src/routes/bridge.ts` `/register` after round-2

The handler structure that landed in commit `8f81492` and round-3 polish:

```ts
router.post('/register', verifyHiveSignature, registerLimiter, async (req, res) => {
  // 1. Parse + validate request → identifier in canonical form
  const identifier = await resolveToCanonical(rawIdentifier);

  // 2. EXTERNAL IO OUTSIDE THE LOCK (item 2 of round-2 hold).
  //    CrossRef 15s + DOI scrape 10s + PubMed ~15s.
  //    Lock cannot bound this; it must finish before lock acquisition.
  let meta;
  try {
    meta = await lookupPreprint(identifier);
  } catch (err) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch preprint metadata from source');
  }
  if (!meta) {
    return sendError(res, 400, 'BAD_REQUEST', 'No preprint found for the given identifier');
  }

  // 3. ACQUIRE THE LOCK BEFORE THE HAF READ.
  //    Per-permlink SET NX EX with random nonce. Held until broadcast resolves.
  const permlink = makeBridgePermlink(meta);
  const lockKey = bridgeRegisterLockKey(permlink);
  const lock = await acquireBridgeLock(lockKey);
  if (lock.state === 'held') {
    return res.status(409).json({
      status: 'error',
      error: {
        code: 'LOCK_HELD',          // distinct from DUPLICATE (item 1 of round-2 hold)
        message: '…',
        details: { retriable: true },
      },
    });
  }
  if (lock.state === 'unavailable') { /* Redis down; degrade gracefully */ }

  try {
    // 4. HAF READ INSIDE THE LOCK WINDOW.
    const existing = await checkExistingBridge(identifier, parsed, 'bridge.register');
    if (existing.status === 'haf_unavailable') {
      // 5. FAIL-CLOSED on the write path.
      return sendError(res, 503, 'SERVICE_UNAVAILABLE',
        'Bridge duplicate-check is temporarily unavailable. Please retry shortly.',
        { retriable: true });
    } else if (existing.status === 'ok') {
      if (existing.exists) {
        return res.status(409).json({
          status: 'error',
          error: { code: 'DUPLICATE', /* terminal; retriable absent */ … },
        });
      }
    } else {
      // Exhaustiveness guard. A future 3rd variant becomes a compile error
      // here, not a silent fall-through to the broadcast.
      return assertNever(existing);
    }

    // 6. BROADCAST INSIDE THE LOCK WINDOW.
    const tx = await broadcastSendOperationsWithTimeout(/* … */);
    // …
  } finally {
    // 7. RELEASE under Lua CAS on the per-acquisition nonce.
    //    Logs no-op return for operator visibility on TTL-exceeded cascade.
    await releaseBridgeLock(lockKey, lock.nonce, lock.acquiredAtMs, 'bridge.register', permlink);
  }
});
```

### Sibling exemplar — `backend/src/routes/orcid.ts` `withOrcidBindingLock`

The ORCID `/callback` bind flow uses the same shape via a wrapper helper (`withOrcidBindingLock`) rather than inline lock acquire/release. Same invariants: lock around the read AND broadcast, IO hoist (the OAuth-code exchange happens before the lock), `assertNever` exhaustiveness, distinct codes for lock-held vs already-bound.

### The companion `/check` read-only probe path

Same `checkExistingBridge` function; same discriminated return; **different policy** at the wire boundary:

```ts
router.get('/check', async (req, res) => {
  const identifier = await resolveToCanonical(rawIdentifier);
  // Resolved OUTSIDE hafCache.getOrSet so the haf_unavailable sentinel
  // bypasses caching entirely (item 2 of round-2 hold).
  const result = await checkExistingBridge(identifier, parsed, 'bridge.check');

  if (result.status === 'haf_unavailable') {
    // FAIL-OPEN on the read-only probe.
    return sendOk(res, { exists: false, author: null, permlink: null, /* … */ });
  } else if (result.status === 'ok') {
    return sendOk(res, result);
  } else {
    return assertNever(result);
  }
});
```

The `callerLabel` parameter (`'bridge.register' | 'bridge.check'`) threads route context into the structured warn log so a `/check` HAF blip doesn't false-alert on the `bridge.register` operator dashboard. Drop the parameter's default value; force the compiler to enforce explicit labeling at every call site.

## Related

- `agents/docs/solutions/conventions/redis-advisory-lock-with-lua-cas-nonce-2026-05-15.md` — the lock primitive this convention depends on (per-acquisition nonce, Lua CAS release, 0-return TTL-exceeded semantics).
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — broadcast timeout is an ambiguous outcome, not a confirmed failure; the retry-side counterpart to this convention's concurrent-request-side mitigation.
- `agents/docs/solutions/conventions/caching-wrapper-discriminated-union-poisoning-2026-05-11.md` — the cache-write-through filter rule for discriminated-union returns; applies directly to step 4 above.
- `agents/docs/solutions/conventions/correlated-options-discriminated-union-2026-04-28.md` — the `assertNever` exhaustiveness rule on the discriminated-union switch.
- Canonical exemplar in code: `backend/src/routes/bridge.ts` `/register` and `/check` handlers.
- Sibling exemplar in code: `backend/src/routes/orcid.ts` `withOrcidBindingLock` wrapper and `/callback` bind handler.
