---
title: "Chain-write timeout is an ambiguous outcome, not a confirmed failure"
date: 2026-04-22
last_updated: 2026-04-29
category: conventions
module: backend
problem_type: convention
component: authentication
severity: high
applies_when:
  - A broadcast (or any durable remote write) is wrapped with a wall-clock timeout or AbortController
  - A handler returns a non-2xx after a broadcast timeout and the caller can retry
  - A retry path re-acquires a distributed lock and re-broadcasts the same custom_json
  - A lock TTL is sized to bound execution time on a chain-write path
  - Reviewing any backend route that writes to Hive (ORCID binding, accreditation, anonymousReview, papers, signup-verify, wot cascades, claims)
tags:
  - "chain-write"
  - "broadcast-timeout"
  - "ambiguous-outcome"
  - "idempotency"
  - "orcid"
  - "hive"
  - "distributed-lock"
  - "toctou"
  - "retry-safety"
  - "partial-execution-ambiguity"
  - "single-use-state"
  - "retriable-discriminator"
---

# Chain-write timeout is an ambiguous outcome, not a confirmed failure

## Context

Commit `6211190` (`BE-ORCID-BROADCAST-ABORT-TIMEOUT`) wrapped `hiveClient.broadcast.json` with a 30s wall-clock timeout via `broadcastJsonWithTimeout` in `backend/src/hive.ts`. Context: dhive has no native broadcast timeout (see the sibling learning `verify-library-claims-before-load-bearing-security-margins-2026-04-22.md`); a slow Hive node could hold the socket open past the `BE-ORCID-TOCTOU-LOCK` 35s lock TTL, defeating the execution-stomp guarantee. The helper throws `BroadcastTimeoutError` on timer fire.

Architect first-review surfaced a consequence the task scope explicitly excluded: **a 30s timer fire says nothing about whether the broadcast reached the chain.** The HTTP response is hanging. The broadcast may already be accepted. Four possible states from the thrower's perspective:

| Timer state | Chain state | Response state | Correct retry behavior |
|---|---|---|---|
| Not fired | Accepted | 200 received | No retry; happy path. |
| Not fired | Rejected | Error received | Safe to retry with corrected payload. |
| **Fired** | **Accepted** | **Response hanging** | **DO NOT retry — would duplicate on-chain.** |
| Fired | Rejected or never reached node | Response hanging | Safe to retry. |

States 3 and 4 are **indistinguishable** from the caller. Both look like "broadcast didn't return." Collapsing `BroadcastTimeoutError` into a naive `500 INTERNAL_ERROR → user retries` re-opens the exact race that `BE-ORCID-TOCTOU-LOCK` was built to eliminate:

1. Request A acquires the binding lock and calls `broadcastJsonWithTimeout`.
2. Timer fires at 30s. `BroadcastTimeoutError` thrown.
3. `finally` runs `releaseBindingLock` (CAS passes — caller's own nonce). Lock is freed.
4. `cacheOrcidBinding()` + `updateAccountOrcid()` were AFTER the broadcast → never reached. Cache stays cold.
5. Request B (user retry) acquires a fresh lock. HAF hasn't indexed the potentially-accepted tx (3–120s lag window). `findAccreditedAccountWithOrcid` sees neither cache nor chain. Duplicate-guard passes.
6. Request B broadcasts. Both A and B land on-chain.

The `BE-ORCID-TOCTOU-LOCK` protection guards **concurrent** requests, not sequential retries after an uncertain outcome. This gap was surfaced in `handleAccredit` + `handleLink`; the same structural risk sits in every other broadcast caller (`accreditation.ts`, `anonymousReview.ts`, `papers.ts`, `signup-verify.ts`, `wot.ts`, `claims.ts`).

Hive does not expose built-in idempotency keys for `custom_json` operations; a duplicate bind or duplicate accreditation on-chain is irreversible without an admin-signed revoke. "Just retry" is unsafe by default for any write crossing this boundary.

The open implementation task is `backend-orcid-broadcast-timeout-outcome-handling.md` (tracked in `agents/docs/tasks/`). The frontend companion (`ui-orcid-callback-retriable-branch.md`) plumbs the `retriable` + `retry_after_seconds` signal for consumers.

## Guidance

**Rule: a timeout on a durable remote write is an uncertain outcome, not a failure. Treat `BroadcastTimeoutError` (and any analogous class) as a distinct error class with `retriable: false` by default until the application can prove the write did not land.**

Four design options, ordered by cost:

### A.2 — `retriable: false` + "verify manually" (recommended default)

Return `504 BROADCAST_TIMEOUT` with `{ retriable: false, outcome: 'uncertain', verify_before_retry: true }`. Frontend surfaces "broadcast pending — verify your ORCID linkage at `/settings` before retrying." Cheapest; no new infra; matches the task's original "surface timeout as an error, don't recover" posture.

### A.1 — Lock-TTL-extension-on-timeout

On `BroadcastTimeoutError`, before releasing the lock, extend its TTL to ~120s (HAF indexing window). Retries during the extended window return `409 ORCID_ALREADY_LINKED` with `retriable: true, retry_after_seconds: <remaining>`. Closes the race structurally; user waits up to 2 minutes for a retry decision.

### A.3 — Background verify-before-retry reconciliation

Spawn a background job polling HAF/Hive for the tx by operation fingerprint. Updates cache + DB once visible; blocks retries during reconciliation. Requires a persistent task queue (not in the stack today).

### A.4 — Idempotent-broadcast key

Include `sha256(orcid_id + mode + account)` as an `idempotency_key` in the `custom_json` payload. Post-broadcast HAF check (or per-key guard at ingest time) rejects second attempts. Requires `custom_json` schema change + new HAF query. Biggest surface area; most durable long-term.

### The naive path to never use

```ts
// WRONG — collapses ambiguous-outcome into the same bucket as definite failure:
} catch (err) {
  if (err instanceof BroadcastTimeoutError) {
    sendError(res, 500, 'INTERNAL_ERROR', 'Broadcast timed out');
    return;   // User retries → HAF lag window open → duplicate on-chain
  }
  throw err;
}
```

The timeout-to-500 collapse is what silently defeats the lock. It looks innocuous and matches every other error handler in the codebase, which is exactly why it has to be called out as a named anti-pattern.

## Why This Matters

A blockchain write is append-only and irreversible. A duplicate bind / accreditation `custom_json` on-chain:

- Cannot be "rolled back" — only overridden by a subsequent `revoke` signed by the admin account.
- Pollutes the on-chain representation that HAF indexes and downstream consumers rely on.
- Breaks the invariant `BE-ORCID-TOCTOU-LOCK` was specifically built to hold: "at most one successful bind per (account, orcid) pair."

The naive timeout handler produces this state for every transient Hive-node slowness event. Any attacker observing the HTTP 500 and retrying is unknowingly attacking the integrity of their own binding; any legitimate user hitting a slow node during a real-world deploy gets the same outcome.

The review-level consequence is subtler. The `broadcastJsonWithTimeout` wrapper looks like a complete fix because it closes the lock-expiration race that the original task named. A reviewer reading the commit sees: timer, AbortController, `finally`-release, test with a mocked hanging broadcast. Nothing in that picture signals "what if the broadcast already landed before the timer fired?" The fix attests to its own completeness without exercising the question. That's exactly the dynamic the sibling `verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` describes for a claim layer up (the dhive timeout that didn't exist), reappearing one layer down (the timer we added has ambiguous semantics).

## When to Apply

1. Any call to `broadcastJsonWithTimeout` (or any future broadcast-wrapper) in PEvO backend code.
2. Any operation whose post-broadcast side effects (cache write, DB write, 200 response) must be conditioned on definite broadcast success.
3. Any retry path triggered by a timeout-class error on a write to an external system without native idempotency keys.
4. Specifically today: `handleAccredit` + `handleLink` in `backend/src/routes/orcid.ts`. Extension to `accreditation.ts`, `anonymousReview.ts`, `papers.ts`, `signup-verify.ts`, `wot.ts`, `claims.ts` if the chosen option is reusable.
   - **Ordering axis (added 2026-04-28):** when a migration site has post-response cleanup inside the same catch block (the `accreditation.ts /verify` shape: `handleBroadcastError → if (outcome === 'failure') await deleteToken(token)`), the helper extraction can invert the response/cleanup ordering and produce a separate `ERR_HTTP_HEADERS_SENT` regression on Express 5 if the cleanup rejects. See `helper-extraction-express5-response-ordering-2026-04-28.md` for the call-site audit checklist. Sites without post-response cleanup (current `orcid.ts`, `papers.ts`, `claims.ts`) are unaffected.
5. Not applicable to read operations (`hiveClient.database.*`, HAF queries) or to writes where a definite error response was received from the node before the timer fired.

## Examples

### Wrong — naive timeout collapse

```ts
// Inside withOrcidBindingLock's fn callback:
try {
  const result = await broadcastJsonWithTimeout(payload, key);
  await cacheOrcidBinding(orcidId, username);    // only reached on success
  await updateAccountOrcid(username, orcidId);   // only reached on success
  sendOk(res, { tx_id: result.id /* ... */ });
} catch (err) {
  // BroadcastTimeoutError reaches the outer /callback catch → 500 INTERNAL_ERROR
  // User retries → cache cold, HAF lag window open → duplicate broadcast
  throw err;
}
```

### Right — Option A.2 (retriable:false + uncertain envelope)

```ts
import { BroadcastTimeoutError, broadcastJsonWithTimeout } from '../hive.js';

// Inside withOrcidBindingLock's fn callback:
let result: BroadcastJsonResult;
try {
  result = await broadcastJsonWithTimeout(payload, key);
} catch (err) {
  if (err instanceof BroadcastTimeoutError) {
    // DO NOT cache. DO NOT write DB. We don't know if the broadcast landed.
    res.status(504).json({
      status: 'error',
      error: {
        code: 'BROADCAST_TIMEOUT',
        message: 'Broadcast did not confirm in time. The write may have landed on-chain.',
        details: {
          retriable: false,
          outcome: 'uncertain',
          verify_before_retry: true,
        },
      },
    });
    return;
  }
  throw err;  // definite node errors re-throw for outer 500
}
// Only reached on confirmed broadcast success:
await cacheOrcidBinding(orcidId, username);
await updateAccountOrcid(username, orcidId);
sendOk(res, { tx_id: result.id /* ... */ });
```

The `BroadcastTimeoutError` MUST be caught **inside** the `fn` callback passed to `withOrcidBindingLock`, not in the outer `/callback` try/catch — the outer catch maps unrecognized errors to 500 INTERNAL_ERROR which has the wrong status code and wrong retriable semantics.

### Right — Option A.2, unavailable-branch extension

The A.2 envelope also applies to the lock-wrapper's `'unavailable'` branch (Redis outage OR lock-nonce-shape invariant drift). In that branch `fn` runs WITHOUT a lock, so there is no lock-TTL margin to bound a retry race. Every throw escaping `fn` on this path is outcome-ambiguous — the broadcast may already be on-chain without the caller being able to reconcile the cache/DB state — so the wrapper catches throws in the `'unavailable'` branch and emits the same 504 envelope, even for non-`BroadcastTimeoutError` throws.

The shape was iterated in two rounds; this section reflects the round-2 hold-fix landed at commit `0a5c890`, which is the canonical pattern. The helper interface is a discriminated union (`AmbiguousOutcomeFields`) so a caller cannot set `forceAmbiguousOutcome: true` without also providing `ambiguousMsg` (the round-1 `?? failMsg` silent-regression class is structurally impossible at compile time). The wrapper takes the narrowed `HandleBroadcastErrorAmbiguousOpts` (required, not optional) and routes throws through a dedicated `handleBroadcastErrorAmbiguous` entry point so the wrapper code never references the helper's internal flag name. `fn` receives the resolved `lockState` so non-`BroadcastTimeoutError` broadcast errors on the `'unavailable'` branch can re-throw out to the wrapper's outer catch (single source of truth for the ambiguous envelope), while the same error class on the `'acquired'` branch keeps its inner-catch 502 `BROADCAST_FAILED` semantics:

```ts
// Helper interface — discriminated union enforces the correlated invariant.
type AmbiguousOutcomeFields =
  | { forceAmbiguousOutcome?: false; ambiguousMsg?: never }
  | { forceAmbiguousOutcome: true; ambiguousMsg: string };
export type HandleBroadcastErrorOpts = BaseHandleBroadcastErrorOpts & AmbiguousOutcomeFields;
export type HandleBroadcastErrorAmbiguousOpts = Extract<
  HandleBroadcastErrorOpts,
  { forceAmbiguousOutcome: true }
>;

// Wrapper signature — narrowed type required, no optional.
async function withOrcidBindingLock(
  res: Response,
  orcidId: string,
  fn: (lockState: 'acquired' | 'unavailable') => Promise<{ skipRelease?: boolean } | void>,
  ambiguousOutcomeOpts: HandleBroadcastErrorAmbiguousOpts,
): Promise<void> {
  const lock = await acquireBindingLock(orcidId);
  // ...'held' / 'acquired' branches unchanged...
  else if (lock.state === 'unavailable') {
    try {
      await fn('unavailable');
    } catch (err) {
      handleBroadcastErrorAmbiguous(res, err, ambiguousOutcomeOpts);
    }
  }
}

// Caller — split opts: base for the inner-catch 502 path, ambiguous variant for the wrapper outer catch.
const accreditErrorOpts: HandleBroadcastErrorOpts = {
  routeLabel: 'orcid.handleAccredit',
  timeoutMsg: 'Hive broadcast timed out while linking ORCID.',
  failMsg: 'Failed to broadcast ORCID accreditation to Hive.',
  verifyLocation: '/settings',
  logContext: { username, orcid: orcidId, mode: 'accredit' },
};
const accreditAmbiguousOpts: HandleBroadcastErrorAmbiguousOpts = {
  ...accreditErrorOpts,
  forceAmbiguousOutcome: true,
  ambiguousMsg: 'Broadcast outcome uncertain. Verify your ORCID linkage at /settings before retrying.',
};

// Inner-catch on fn discriminates by lockState — non-timeout broadcast errors
// on 'unavailable' re-throw to the wrapper's outer catch (single source of
// truth for the ambiguous envelope); on 'acquired' they take the inner-catch
// 502 BROADCAST_FAILED path (lock + binding-cache provide the dedup signal a
// retry would need to be safe). BroadcastTimeoutError stays in fn's inner
// catch on BOTH branches because the lock-TTL-extend side effect (Option A.1)
// is load-bearing on 'acquired' and a no-op on 'unavailable'.
try {
  const result = await broadcastJsonWithTimeout(op, accreditErrorOpts);
  // ...post-broadcast cascade...
} catch (err) {
  if (err instanceof BroadcastTimeoutError) {
    if (lockState === 'acquired') {
      await redis.expire(orcidBindingLockKey(orcidId), 120);
    }
    handleBroadcastError(res, err, accreditErrorOpts);
    return { skipRelease: true };
  }
  if (lockState === 'unavailable') throw err;  // route to wrapper outer catch → 504 ambiguous
  handleBroadcastError(res, err, accreditErrorOpts);  // 'acquired': 502 BROADCAST_FAILED
  return;
}
```

On the `forceAmbiguousOutcome` branch, `BroadcastTimeoutError` emits the envelope with `timeout_ms` (from `err.timeoutMs`); non-timeout throws emit the same envelope WITHOUT `timeout_ms` (the throw did not originate from the timer, so reporting a fabricated value would mislead consumers keying retry-backoff off that field).

**`verify_location: '/settings'`** is the UI hint surfaced on the 504 envelope for both ORCID binding callers (`handleAccredit`, `handleLink`). It points the user at the page where their ORCID link status is visible, so they can verify whether the broadcast landed before attempting a retry. Other timeout-wrapped broadcast callers MAY adopt a different `verifyLocation` appropriate to their surface (accreditation profile, paper post page, etc.) or omit it entirely if there is no user-facing verify surface. The field is optional; envelopes without it remain spec-compliant.

### Symmetric-branch convention — catch on EVERY execution branch of the lock wrapper

`withOrcidBindingLock` (and any future lock wrapper that fronts a chain-write) MUST carry an outer try/catch on every branch where `fn` runs — both `'acquired'` and `'unavailable'` today. **One branch with a catch and the other without is an anti-pattern.** A pre-broadcast SYNC throw or post-broadcast ASYNC throw escaping the un-guarded branch reaches the outer route handler's catch as 500 INTERNAL_ERROR, with the OAuth state token already consumed at dispatch — the user is hard-blocked on a 500 page and must restart OAuth. This is the same consumed-state-token + 500 + no-recovery class the wrapper exists to prevent; the asymmetry just relocates it.

The 504 ambiguous-outcome envelope (or, after `PostBroadcastWriteError` discrimination, the 502 POST_BROADCAST_FAILED envelope) is what the wrapper trades for that 500. Skipping the catch on a branch trades the ambiguous-outcome safety net for a hard block on user-influenceable inputs (Redis flap timing, admin-key shape, network mid-broadcast). Always wrap.

Concretely on `withOrcidBindingLock` today:

```ts
} else if (lock.state === 'acquired') {
  let skipRelease = false;
  try {
    const result = await fn('acquired');
    if (result?.skipRelease) skipRelease = true;
  } catch (err) {
    handleBroadcastErrorAmbiguous(res, err, ambiguousOutcomeOpts);
    // Do NOT set skipRelease — release the lock so a subsequent retry
    // (after the user verifies state at /settings) can acquire it.
  } finally {
    if (!skipRelease) {
      await releaseBindingLock(orcidId, lock.nonce);
    }
  }
}
```

The `'unavailable'` branch shape is structurally identical (one less `finally` because there is no lock to release).

### Ambiguous outcome vs post-broadcast write failure (discrimination pattern)

A throw escaping `fn` after the broadcast SUCCEEDED is **not** an ambiguous outcome. The chain op IS confirmed; the throw is a downstream cascade failure (cache write, persistent row update, secondary index update). Surfacing the same 504 `outcome:'uncertain'` envelope as a real broadcast timeout misroutes operator alerts to broadcast-on-call when the actual root cause is downstream of the broadcast, and tells the user to "verify before retrying" when there is nothing for the user to verify.

Discriminate at the catch boundary using a tagged error class. The pattern landed for ORCID in commit `d8b9b75` (BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION) and is reusable across any chain-write caller that has a post-broadcast cascade.

```ts
// Tagged error class — defined once in the broadcast-error helper module.
export class PostBroadcastWriteError extends Error {
  constructor(
    public readonly txId: string,
    public readonly cause: unknown,
    public readonly failedStep: 'cache_write' | 'account_update' | 'reputation_seed' /* per-resource */,
  ) {
    super(`Post-broadcast write failed at step '${failedStep}' (tx ${txId})`, { cause });
    this.name = 'PostBroadcastWriteError';
  }
}

// Caller — wrap the post-broadcast cascade and tag throws with the failed step.
let currentStep: 'cache_write' | 'account_update' | 'reputation_seed' = 'cache_write';
try {
  const result = await broadcastJsonWithTimeout(op, errorOpts);
  try {
    await cacheOrcidBinding(orcidId, username);
    currentStep = 'account_update';
    await updateAccountOrcid(username, orcidId);
    currentStep = 'reputation_seed';
    await seedAccreditationBonus(username);
    sendOk(res, { tx_id: result.id /* ... */ });
  } catch (postErr) {
    throw new PostBroadcastWriteError(result.id, postErr, currentStep);
  }
} catch (err) {
  if (err instanceof BroadcastTimeoutError) { /* ... lock-TTL extend, 504 ... */ }
  // ... non-timeout handling, re-throw on 'unavailable' to wrapper outer catch ...
}
```

The wrapper's outer catch (and the helper) discriminate by `instanceof PostBroadcastWriteError` **first**, before the `BroadcastTimeoutError` and `forceAmbiguousOutcome` branches. The order matters: `PostBroadcastWriteError`'s `cause` may itself be a `BroadcastTimeoutError` (e.g., a post-broadcast call internally hits a timeout). The chain op IS confirmed regardless; the over-cautious 504 envelope would be wrong. Pin the order with a regression test that constructs `new PostBroadcastWriteError(txId, new BroadcastTimeoutError(30_000), 'cache_write')` and asserts the response is 502 `POST_BROADCAST_FAILED`, not 504.

The discrimination produces a different envelope:

```ts
// 502 POST_BROADCAST_FAILED — chain op confirmed; backend cascade failed.
res.status(502).json({
  status: 'error',
  error: {
    code: 'POST_BROADCAST_FAILED',
    message: opts.postBroadcastFailedMsg(failedStep),  // resource-specific user message
    details: {
      retriable: false,
      outcome: 'confirmed',           // <-- key discriminator vs 'uncertain'
      tx_id: err.txId,                // <-- chain op id for postmortem correlation
      failed_step: err.failedStep,    // <-- routes operator alert to the right on-call
    },
  },
});
```

Note: **NO** `verify_before_retry` and **NO** `verify_location`. The chain op is the source of truth; nothing for the user to verify. Operators see `failed_step` and route to the on-call owning that subsystem (cache, app DB, reputation pipeline).

A fourth stable log-message suffix anchors the operator alert pipeline — `<routeLabel> broadcast confirmed but post-broadcast write failed` (logger.error, PostBroadcastWriteError discrimination path). It belongs alongside the three suffixes the helper already documents (`broadcast timed out`, `broadcast failed on ambiguous-outcome path`, `broadcast failed`).

**Caveat — discrimination is only as live as the cascade fns.** If `cacheOrcidBinding` / `updateAccountOrcid` / `seedAccreditationBonus` swallow their async errors internally (logger.warn / logger.error and return successfully), the cascade try/catch never fires and `PostBroadcastWriteError` never gets thrown. The discrimination machinery becomes dead-defensive: structurally correct but unreachable in production. Audit each cascade fn before wiring discrimination — either re-throw critical errors so discrimination fires, or document explicitly that the swallow is by design and that the discrimination is reserved for future cascade fns that propagate.

**Reconciliation per failed step is per-resource and per-step.** Don't promise blanket "HAF will reconcile" in user-facing messages. Some steps reconcile via the next request populating a cache; others via a scheduled batch job; some require manual re-execution because the failed write is a denormalized projection with no replay path. Document the recovery semantics for each `failed_step` in the resource contract, and shape the user-facing message to match.

### Right — Option A.1 (extend lock TTL instead of releasing)

The naive shape — `redis.expire` followed by `res.status(504).json(...)` and a bare `return` — is the anti-pattern, not the implementation. `withOrcidBindingLock`'s `finally` calls `releaseBindingLock(orcidId, nonce)` and the CAS matches the caller's own nonce → the lock is **deleted** in the finally regardless of what the catch did to its TTL. The premature release silently undoes the fix. Two pieces are required: a return-value signal from `fn` to the wrapper, and a wrapper restructure that respects it.

**Caller side (handleAccredit / handleLink) — `redis.expire` BEFORE response-write, then signal skipRelease:**

```ts
} catch (err) {
  if (err instanceof BroadcastTimeoutError) {
    // Order matters: extend the lock BEFORE handleBroadcastError writes the
    // response. If a malicious caller terminated the connection mid-write,
    // the extend must already be persisted. Response-write happens last so
    // a connection drop cannot escape fn before the extend lands.
    if (redis && isRedisAvailable()) {
      try {
        await redis.expire(orcidBindingLockKey(orcidId), HAF_INDEXING_LAG_CEILING_SECONDS);
      } catch (expireErr) {
        logger.error({ err: expireErr, orcidId }, '<routeLabel> redis.expire on BroadcastTimeoutError failed — A.1 protection degraded');
      }
    }
    handleBroadcastError(res, err, accreditErrorOpts);
    return { skipRelease: true };
  }
  throw err;  // non-timeout throws still release (unchanged)
}
```

**Wrapper side (`withOrcidBindingLock` `'acquired'` branch) — `let skipRelease = false` declared above try, mutated on the explicit signal, read in finally:**

```ts
} else if (lock.state === 'acquired') {
  let skipRelease = false;
  try {
    const result = await fn('acquired');
    if (result?.skipRelease) skipRelease = true;
  } catch (err) {
    handleBroadcastErrorAmbiguous(res, err, ambiguousOutcomeOpts);
    // Do NOT set skipRelease — release the lock so a subsequent retry
    // (after the user verifies state at /settings) can acquire it.
  } finally {
    if (!skipRelease) {
      await releaseBindingLock(orcidId, lock.nonce);
    }
  }
}
```

The `let skipRelease = false` declared **above** the try is load-bearing. `finally` cannot read variables from the try's scope; the closure-mutation pattern is the canonical Node idiom for this. A throw from `fn` flows past the `skipRelease = true` line, leaves `skipRelease` at its initial `false`, and `finally` releases as before — preserving the throw-path release. Only an explicit `{ skipRelease: true }` return path skips release.

**`fn` signature — widen to allow the skipRelease return:**

```ts
fn: (lockState: 'acquired' | 'unavailable') => Promise<void | { skipRelease: true }>
```

The `'unavailable'` branch silently ignores any returned `skipRelease` (no lock to extend, no lock to release). Document this inline in the wrapper so a future implementer doesn't try to plumb A.1 onto the unavailable branch.

**Operational hardening worth applying alongside A.1** — the naive shape above silently fails on three Redis edge cases that the test suite cannot easily reach:

1. **`redis.expire` returns 0** (key already deleted between SETNX and EXPIRE — operator FLUSHDB, eviction, AOF-rewrite stall). No exception, code returns `{skipRelease:true}` anyway, lock is gone, A.1 protection bypassed silently. Check the return value: if 0, log at `error` and proceed with the 504; the wrapper's `skipRelease:true` is now a no-op (no lock to skip releasing).
2. **`redis.expire` succeeds silently with no log.** Operators cannot alert on extension-event frequency or correlate against HAF-lag spikes. Emit `logger.warn` on the success path so the safety extension is observable.
3. **Redis completely absent at BroadcastTimeoutError time** (`if (redis && isRedisAvailable())` guard short-circuits). The expire is skipped silently. Log at `error` so operators see the degraded mode, and accept that A.1 is a no-op when Redis is down (the convention's `'unavailable'` branch handles the no-lock case via the ambiguous-outcome envelope).

### Sibling principle — `retriable: true` is meaningless when state is single-use

Before adding a `retriable: true` discriminator to a non-2xx envelope, audit the path the client takes on retry. The discriminator promises "the same request body, replayed, will succeed once the transient cause clears." That promise requires the request body to remain valid across retries — it is BROKEN if any field is single-use and was already consumed when the discriminator emitted.

The 2026-04-29 ORCID lock-contention case (architect decision: ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409, archived 2026-04-29). The same-tick contention 409 inside `withOrcidBindingLock` carried `retriable: true` + `retry_after_seconds: 10`. The frontend consumed the discriminator, ran a countdown, replayed `POST /api/orcid/callback` with the same `{code, state}`. Result: 400 BAD_REQUEST. Reason: `routes/orcid.ts` consumes `state` at the top of `/callback` (eager replay protection — `redis.del(stateKey)` at the post-auth checkpoint) BEFORE dispatching to the handler that runs the lock acquisition. By the time the lock-contention 409 emits, the state token is gone. The retriable promise was theatre. Resolution: drop the discriminator from this 409 entirely — the contention case is genuinely terminal at the wire layer; clients restart OAuth.

Audit checklist before stamping `retriable: true` on any envelope:

1. **What single-use values does the request carry?** OAuth state tokens, signup nonces, idempotency keys whose first use mints a row, anti-replay nonces, time-windowed signed bodies. List them.
2. **At what point in the handler does each become consumed/invalid?** Trace from request entry to the discriminator's emission site. If consumption happens BEFORE the discriminator can fire, the discriminator is unreachable in practice.
3. **Does the retry path mint fresh values or replay the same body?** Frontend countdown-and-retry typically replays the same body. If the body must change to be valid on retry, `retriable: true` is the wrong shape — the right shape is either a non-retriable 4xx with a "restart the flow" UX, or a 2xx-with-pending-state envelope that the client polls separately.
4. **If you keep `retriable: true`, can you defer the single-use consumption past the discriminator's emission point?** Sometimes yes (e.g., consume after lock acquisition rather than before — accepts a narrow replay window in exchange). Sometimes no (e.g., authentication checks that GUARD the consumption, where deferral opens a real attack surface). When deferral is unsafe, drop the discriminator.

This sibling principle applies wherever the codebase emits a non-2xx that signals retry-with-same-body: not just chain-write timeouts. It pairs naturally with the timeout convention because both failure modes get tempting `retriable: true` annotations that quietly violate the contract — timeouts because outcome is ambiguous (retry may double-write), single-use-state because the retry's body is already invalid (retry can't even reach the original handler).

## Related

- `agents/docs/solutions/conventions/chain-primitive-proxy-prefer-deletion-2026-04-28.md` — **scope predecessor.** Before designing reconciliation logic for a DB table that mirrors a chain primitive, audit whether the table earns its keep at all. If the chain handles the failure mode the table was meant to defend against, drop the table — the reconcile-design options below (A.1-A.4) become moot for that path. This doc applies once the audit has confirmed the DB write is wanted.
- `agents/docs/solutions/conventions/verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` — **causal predecessor.** That doc covers layer 1: the dhive "30s broadcast timeout" claim didn't exist, so we added `broadcastJsonWithTimeout`. This doc covers layer 2: the timer we added has ambiguous outcome semantics when its error is collapsed to 500. Same task chain, two lessons.
- `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` — **structural parallel.** SMTP `sendMail` throws after the token is written → 500 reveals "email exists in DB." Broadcast timer fires after the tx may be accepted → 500 causes double-broadcast. Same failure shape (partial-execution error collapsed to generic status code), different domain.
- `agents/docs/solutions/runtime-errors/helper-extraction-express5-response-ordering-2026-04-28.md` — **second failure mode on the same helper.** This doc covers the timeout-outcome ambiguity that `handleBroadcastError` was designed to handle. The runtime-errors doc covers a separate regression: when a migration site has post-response cleanup, helper extraction inverts the response/cleanup ordering and produces `ERR_HTTP_HEADERS_SENT` on Express 5 if the cleanup rejects. Future broadcast-helper extensions should consider both axes (idempotency on ambiguous outcomes AND ordering parity on cleanup failure).
- `agents/docs/solutions/runtime-errors/constructor-throw-in-settimeout-escapes-as-uncaught-exception-2026-05-01.md` — **third failure mode on the same helper family.** A constructor-time guard added to `BroadcastTimeoutError` (round-4 of `BACKEND-HANDLE-BROADCAST-ERROR-HELPER`) fires inside `setTimeout(() => reject(new BroadcastTimeoutError(...)))` and escapes as Node `uncaughtException` instead of rejecting the broadcast Promise — strictly worse than the wire-shape regression it was meant to prevent. Round-5 fix: validate at the wrapper entry (`assertFinitePositiveTimeoutMs` as the first executable statement of `broadcastJsonWithTimeout` / `broadcastSendOperationsWithTimeout`), where `async` function semantics convert the throw into a normal Promise rejection. Same broadcast-helper file family; complements the ambiguous-outcome envelope work above with a defense-in-depth lesson about throw-site call frames.
- `backend-orcid-broadcast-timeout-outcome-handling.md` (in `agents/docs/tasks/`) — open task implementing the chosen option.
- `ui-orcid-callback-retriable-branch.md` (in `agents/docs/tasks/`) — frontend companion consuming the `retriable` + `retry_after_seconds` envelope.
- `backend/src/hive.ts` — `broadcastJsonWithTimeout`, `BroadcastTimeoutError`.
- `backend/src/routes/orcid.ts` — `handleAccredit`, `handleLink`, `withOrcidBindingLock`, `releaseBindingLock` (Lua CAS).
