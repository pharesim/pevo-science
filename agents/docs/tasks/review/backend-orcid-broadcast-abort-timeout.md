# BE-ORCID-BROADCAST-ABORT-TIMEOUT — Wrap hiveClient.broadcast.json calls in an explicit AbortSignal so the ORCID binding lock's 35s TTL has a real safety margin

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ORCID-TOCTOU-LOCK round-2 review 2026-04-22)
**Priority:** P1

## Context

`BE-ORCID-TOCTOU-LOCK` raised the ORCID binding lock TTL from 10s to 35s on the stated rationale of "above the 30s dhive broadcast timeout." Re-review verified in `@hiveio/dhive/lib/client.js:166-170` that **this timeout does not exist**:

```js
let fetchTimeout;
if (!isBroadcast) {
    fetchTimeout = (tries) => (tries + 1) * 500;
}
```

For broadcast calls (`isBroadcast = true`), `fetchTimeout` is left undefined. `node-fetch` defaults `timeout` to `0` (no timeout) when the field is absent. The `Client` `timeout: 10_000` at `backend/src/hive.ts:9` is applied only as the retryingFetch wall-clock guard for READ ops; broadcasts have no per-request timeout.

The round-1 architect hold-block's 5s-margin claim (35s TTL minus 30s dhive timeout) was false. The round-2 commit's in-code comment at `backend/src/routes/orcid.ts:40` ("dhive's 30s broadcast timeout") is also wrong. Chain-of-reasoning failure propagated from hold-block → commit message → inline comment without anyone verifying dhive's actual broadcast behavior.

## Why this matters

The Redlock nonce + Lua CAS in round-2 correctly closes the DEL-stomp window (A's expired finally cannot delete B's lock). But it does NOT close the **execution-stomp** window: a slow-but-alive Hive node can hold `broadcast.json` open indefinitely. After 35s the lock auto-expires, B acquires a new lock with a new nonce and broadcasts, A's broadcast eventually completes, A's finally runs a no-op CAS (nonce mismatch → correct), but **both A and B broadcast the same custom_json for the same orcid_id**. The very race the lock was designed to prevent.

Slow Hive nodes are a realistic pre-beta failure mode (variable node health, occasional multi-minute stalls). The fix is the missing piece that makes the 35s TTL's margin real.

## Goal

Wrap every `hiveClient.broadcast.json(...)` call with an explicit `AbortSignal.timeout(30_000)` (or manual AbortController pattern) so broadcasts fail-fast at 30s instead of hanging indefinitely.

1. Audit every `hiveClient.broadcast.json` call site in `backend/src/`. Expected sites: `orcid.ts` (handleAccredit + handleLink), possibly `accreditation.ts`, `bridge.ts`, `digest.ts`, `anonymousReview.ts`, `custody.ts`, any other chain-broadcast path.
2. Introduce a helper (`broadcastWithTimeout(op, timeoutMs = 30_000)`) in `src/hive.ts` or a new `src/lib/broadcast-timeout.ts` that wraps dhive's broadcast with a `Promise.race` on an `AbortController`-backed timeout, and throws a distinguishable error on timeout (e.g., `BroadcastTimeoutError extends Error`).
3. Swap each call site to use the helper.
4. Update the inline comment at `backend/src/routes/orcid.ts:40` to describe the actual mechanism (helper-enforced 30s abort, not a non-existent dhive timeout).
5. Add one integration-style test that mocks a hanging broadcast (e.g., returns a promise that never resolves) and asserts the handler returns a 500 / `BROADCAST_TIMEOUT` error within ~30s + epsilon. Real-HAF not required (dhive behavior is the unit under test).

## Non-goals

- Changing the 35s lock TTL (stays as-is; is correct given the 30s broadcast timeout this task enforces).
- Reducing the number of broadcast call sites (separate hygiene task if warranted).
- Retrying broadcasts on timeout (caller-level concern; this task surfaces timeout as an error, doesn't recover).

## Acceptance

- All `hiveClient.broadcast.json` call sites go through the timeout helper.
- Grep for `hiveClient.broadcast.json` outside the helper returns zero matches.
- The inline comment at orcid.ts:40 (and any sibling comments citing the 30s dhive timeout) is corrected.
- One test per helper covering: (a) happy path passes through, (b) slow broadcast times out at ~30s, (c) broadcast error propagates.
- Full backend vitest clean; `npx tsc --noEmit` clean.

## [TODO Architect]

- Broadcast timeout value (30_000ms) chosen to preserve the BE-ORCID-TOCTOU-LOCK 5s margin against the 35s lock TTL. Architect should confirm this is the right knob before the task merges — if other broadcast sites have different latency profiles (e.g. batch accreditation custom_json ops), the helper may need a caller-provided override rather than a single constant.
