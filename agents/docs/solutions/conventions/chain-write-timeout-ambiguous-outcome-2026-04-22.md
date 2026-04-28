---
title: "Chain-write timeout is an ambiguous outcome, not a confirmed failure"
date: 2026-04-22
last_updated: 2026-04-28
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

The A.2 envelope also applies to the lock-wrapper's `'unavailable'` branch (Redis outage OR lock-nonce-shape invariant drift). In that branch `fn` runs WITHOUT a lock, so there is no lock-TTL margin to bound a retry race. Every throw escaping `fn` on this path is outcome-ambiguous — the broadcast may already be on-chain without the caller being able to reconcile the cache/DB state — so the wrapper catches throws in the `'unavailable'` branch and emits the same 504 envelope, even for non-`BroadcastTimeoutError` throws. Implemented via a `forceAmbiguousOutcome: true` option on `handleBroadcastError` in `backend/src/lib/broadcast-error.ts`:

```ts
async function withOrcidBindingLock(
  res: Response,
  orcidId: string,
  fn: () => Promise<void>,
  ambiguousOutcomeOpts?: HandleBroadcastErrorOpts,
): Promise<void> {
  const lock = await acquireBindingLock(orcidId);
  // ...'held' / 'acquired' branches unchanged...
  else if (lock.state === 'unavailable') {
    if (ambiguousOutcomeOpts) {
      try {
        await fn();
      } catch (err) {
        handleBroadcastError(res, err, {
          ...ambiguousOutcomeOpts,
          forceAmbiguousOutcome: true,
        });
      }
    } else {
      await fn();  // legacy: propagate to outer /callback catch as 500
    }
  }
}
```

On the `forceAmbiguousOutcome` branch, `BroadcastTimeoutError` emits the envelope with `timeout_ms` (from `err.timeoutMs`); non-timeout throws emit the same envelope WITHOUT `timeout_ms` (the throw did not originate from the timer, so reporting a fabricated value would mislead consumers keying retry-backoff off that field).

**`verify_location: '/settings'`** is the UI hint surfaced on the 504 envelope for both ORCID binding callers (`handleAccredit`, `handleLink`). It points the user at the page where their ORCID link status is visible, so they can verify whether the broadcast landed before attempting a retry. Other timeout-wrapped broadcast callers MAY adopt a different `verifyLocation` appropriate to their surface (accreditation profile, paper post page, etc.) or omit it entirely if there is no user-facing verify surface. The field is optional; envelopes without it remain spec-compliant.

### Right — Option A.1 (extend lock TTL instead of releasing)

```ts
if (err instanceof BroadcastTimeoutError) {
  await redis.expire(orcidBindingLockKey(orcidId), 120); // HAF-indexing upper bound
  res.setHeader('Retry-After', '120');
  res.status(504).json({
    status: 'error',
    error: {
      code: 'BROADCAST_TIMEOUT',
      message: 'Broadcast confirmation pending.',
      details: { retriable: false, outcome: 'uncertain', retry_after_seconds: 120 },
    },
  });
  return;
}
```

Note on lock interaction: `withOrcidBindingLock`'s `finally` calls `releaseBindingLock(orcidId, nonce)` unconditionally. For Option A.1 to be correct, the wrapper needs a "don't release" signal OR `fn` must clear the nonce before returning. Otherwise the finally-CAS still matches and deletes the lock, defeating the TTL extension. Design this carefully; premature release silently undoes the fix.

## Related

- `agents/docs/solutions/conventions/verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` — **causal predecessor.** That doc covers layer 1: the dhive "30s broadcast timeout" claim didn't exist, so we added `broadcastJsonWithTimeout`. This doc covers layer 2: the timer we added has ambiguous outcome semantics when its error is collapsed to 500. Same task chain, two lessons.
- `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` — **structural parallel.** SMTP `sendMail` throws after the token is written → 500 reveals "email exists in DB." Broadcast timer fires after the tx may be accepted → 500 causes double-broadcast. Same failure shape (partial-execution error collapsed to generic status code), different domain.
- `agents/docs/solutions/runtime-errors/helper-extraction-express5-response-ordering-2026-04-28.md` — **second failure mode on the same helper.** This doc covers the timeout-outcome ambiguity that `handleBroadcastError` was designed to handle. The runtime-errors doc covers a separate regression: when a migration site has post-response cleanup, helper extraction inverts the response/cleanup ordering and produces `ERR_HTTP_HEADERS_SENT` on Express 5 if the cleanup rejects. Future broadcast-helper extensions should consider both axes (idempotency on ambiguous outcomes AND ordering parity on cleanup failure).
- `backend-orcid-broadcast-timeout-outcome-handling.md` (in `agents/docs/tasks/`) — open task implementing the chosen option.
- `ui-orcid-callback-retriable-branch.md` (in `agents/docs/tasks/`) — frontend companion consuming the `retriable` + `retry_after_seconds` envelope.
- `backend/src/hive.ts` — `broadcastJsonWithTimeout`, `BroadcastTimeoutError`.
- `backend/src/routes/orcid.ts` — `handleAccredit`, `handleLink`, `withOrcidBindingLock`, `releaseBindingLock` (Lua CAS).
