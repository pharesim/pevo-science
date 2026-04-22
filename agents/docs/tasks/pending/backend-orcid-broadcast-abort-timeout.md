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

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `6211190` (11 personas including adversarial + reliability + agent-native). The 30s abort-timer helper is correctly implemented and all 9 `broadcast.json` call sites are migrated. Three architectural-impact items block archive. The ambiguous-outcome semantic question and the missing `broadcast.sendOperations` coverage are filed as separate new tasks (both explicitly out of this task's stated scope per its Non-goals).

1. **P1 — `claims.ts` 3 `broadcastJsonWithTimeout` call sites lack try/catch; unhandled rejection → Express default 500** (reliability R4-001 0.92). `backend/src/routes/claims.ts:~214` (/approve bridge), `~299`, `~319` (/revoke admin). Every other migrated call site (accreditation/orcid/papers/anonymousReview/signup-verify/wot) has route-specific try/catch with contextual `logger.error` + `sendError(res, 500, ...)`. claims.ts was missed. On timeout, `BroadcastTimeoutError` propagates to Express default handler: generic 500, no route context in logs, no operator signal. Fix: wrap all 3 sites with try/catch mirroring the pattern used at the 6 sibling sites in the same commit.

2. **P1 — `BroadcastTimeoutError` is exported for discrimination but never caught by name at any of 8 call sites** (adversarial ADV-BCAST-003 0.91 + agent-native Finding 1 0.95 + kieran KT-4 0.78, 3-reviewer convergence). All callers do generic `catch (err)` → 500 `INTERNAL_ERROR` with a static string. Programmatic consumers cannot distinguish timeout (retry-with-verify) from chain rejection (safe-retry-with-fix) from auth error (don't-retry). The dead `BROADCAST_FAILED` ErrorCode in `backend/src/types/api.ts:32` is the intended carrier and goes unused. Fix at each catch: `if (err instanceof BroadcastTimeoutError) { sendError(res, 504, 'BROADCAST_TIMEOUT', '<contextual message>', { retriable: true, timeout_ms: err.timeoutMs }); } else { logger.error({ err, ... }, '<route> broadcast failed'); sendError(res, 502, 'BROADCAST_FAILED', '<contextual message>', { retriable: false }); }`. Status codes 504 (timeout) / 502 (bad gateway from chain) / 500 (our bug) plus the `retriable` flag give programmatic callers the signal they need. Coordinates with the pending `ui-orcid-callback-retriable-branch.md` which will consume the envelope.

3. **P2 — `signup-verify.ts` logs `err.message` not full error; `BroadcastTimeoutError` vs chain failure indistinguishable in logs** (reliability R2-5 0.80). `(accErr as Error).message` drops the `BroadcastTimeoutError` class + `timeoutMs` property, leaving an operator unable to determine from the log whether a manual re-accreditation is needed or whether the op will appear on-chain shortly. Fix: log the full error object via `logger.error({ err: accErr, email, orcid }, '<contextual>')` or equivalent structured shape. Applies as a one-liner per site once hold #2's discrimination lands — likely folds into the same commit.

4. **P2 — Route tests bypass helper via pass-through mocks; no route-level timeout coverage** (adversarial ADV-BCAST-005 0.93). `orcid.test.ts`, `claims.test.ts`, `signup-verify.test.ts` all replace `broadcastJsonWithTimeout` with `(...args) => broadcastJson(...args)`. No route-level test exercises the `BroadcastTimeoutError` path or asserts absence of post-broadcast state writes (no `cacheOrcidBinding`, no `updateAccountOrcid`, etc.) on timeout. This is exactly the gap that `backend-orcid-broadcast-timeout-outcome-handling.md` (new task) will need to test, but this task should land at least one per-route timeout spec so future refactors surface regressions. Fix: per migrated route, add a spec that mocks a hanging broadcast, asserts the 504 envelope (after hold #2 lands), and asserts the side-effects that must NOT fire (cache writes, DB updates).

**Dismissed from round-1 findings (architect triage):**
- **P3** Orphaned in-flight dhive fetch after timeout (correctness RR + reliability R4-004 0.82 + kieran RR-1): JSDoc acknowledges the trade-off as accepted; true AbortController-based cancellation is a future refactor, not this task.
- **P3** Timeout test uses real 200ms delay not fake timers (testing T4-01 0.62): non-blocking improvement.
- **P3** Timeout test doesn't assert `err.timeoutMs === 200` (testing T4-02 0.82): low-value addition; fold opportunistically while in the file.
- **P3** Route test mock stubs declare `class BroadcastTimeoutError extends Error {}` without `timeoutMs` ctor (testing T4-04 0.70): latent false-confidence; will surface naturally when route tests start discriminating (hold #2 + #4).
- **P3** `BroadcastTimeoutError` missing `Error.captureStackTrace` (kieran KT-1 0.72): cosmetic stack cleanliness.
- **P3** `as never` assertions in test file (kieran KT-2 0.65): use typed local `const hang: Promise<TransactionConfirmation> = new Promise(() => {})` instead.
- **P3** Mock carve-out header silent on condition (c) real-HAF variant (project-standards PS-1 0.65): add a one-liner in the test-file header acknowledging "no real-HAF variant possible because this wrapper has no HAF surface."
- **P3** Dead `if (timer)` guard in finally + two unrelated timeout concepts in hive.ts (maintainability): cosmetic.

**Filed as separate Pending tasks (out of scope for this hold):**
- `backend-orcid-broadcast-timeout-outcome-handling.md` (new P1) — resolve the ambiguous-outcome window (broadcast accepted on-chain but response hangs → retry produces duplicate broadcast). Explicitly excluded by this task's Non-goals. Coordinates with `ui-orcid-callback-retriable-branch.md`.
- `backend-wot-broadcast-timeout-handling.md` (new P2) — `wot.ts` `broadcastWotAccreditation` silently drops accreditations on timeout; `cascadeRevocation` loops with no aggregate wall-clock cap.
- `backend-broadcast-sendoperations-wrap.md` (new P2) — 5 `broadcast.sendOperations` call sites (account-creation, anonymousReview, bridge, custody, +1) still unwrapped; same no-timeout hazard as pre-helper `broadcast.json`.

**Path to re-archive:** (1) Backend applies items #1-4 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review` (adversarial + reliability mandatory given the P1 items); archives on clean. Filed follow-up tasks archive independently.
