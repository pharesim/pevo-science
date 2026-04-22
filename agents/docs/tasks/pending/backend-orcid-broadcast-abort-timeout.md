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

---

**Backend re-review signal (2026-04-22 round-2, worktree branch `worktree-agent-aa48f4ea`):**

All 4 round-1 hold items landed. `npx tsc --noEmit` clean. Per-route test files modified all pass: `backend/tests/routes/claims.test.ts` 20/20, `backend/tests/routes/orcid.test.ts` 31/31, `backend/tests/routes/signup-verify.test.ts` 2/2, `backend/tests/routes/accreditation.test.ts` + `papers.test.ts` + `anonymousReview.test.ts` clean, `backend/tests/hive-broadcast-timeout.test.ts` 3/3. Full vitest suite NOT re-run per parent instruction.

**[TODO Architect]** API contract updates needed before archive (backend cannot edit `agents/docs/api-contracts/*.md`):
- Add `BROADCAST_TIMEOUT` to the error-code table in `agents/docs/api-contracts/common.md` (or whichever file owns the ErrorCode list). Semantics: HTTP 504, `details.retriable: true`, `details.timeout_ms: number`. Returned when `broadcastJsonWithTimeout` throws `BroadcastTimeoutError` at the 30s wall-clock bound.
- Document `BROADCAST_FAILED` now actively returned at HTTP 502 (not 500) with `details.retriable: false` for chain-rejection broadcast failures. Prior to this task the code was declared but never emitted.
- Affected endpoints that can now return 502/504 per the above: `POST /api/orcid/callback` (modes accredit + link), `POST /api/accreditation/verify`, `POST /api/papers/:author/:permlink/retract`, `POST /api/papers/:author/:permlink/claims/:claimer/approve` (bridge-branch), `POST /api/papers/:author/:permlink/claims/:claimer/revoke` (bridge-admin + native-admin branches). Total 7 response surfaces across the `orcid.md`, `accreditation.md`, and `papers.md` contract files (plus a claims.md section if one exists; otherwise under papers.md).

1. **P1 claims.ts try/catch** (item #1). Added narrow try/catch around all 3 `broadcastJsonWithTimeout` call sites in `backend/src/routes/claims.ts`:
   - `~214` (approve bridge-branch): wraps broadcast + post-broadcast `hafCache.invalidate` + `sendOk`. On timeout: 504 `BROADCAST_TIMEOUT` with `{retriable:true, timeout_ms}`. On other error: `logger.error({err, paperAuthor, paperPermlink, claimer, username}, 'claims.approve broadcast failed')` + 502 `BROADCAST_FAILED` with `{retriable:false}`.
   - `~299` (revoke bridge-admin): same pattern, context adds `signer:'bridge'`, message "Broadcasting bridge-paper revocation timed out" / "Failed to broadcast authorship revocation to Hive".
   - `~319` (revoke admin-on-native): same pattern, context adds `signer:'admin'`.
   Before: `BroadcastTimeoutError` bubbled to Express default handler → generic 500, no route context logged. After: route context logged, typed envelope returned.

2. **P1 `BroadcastTimeoutError` discrimination at all HTTP-surface catch sites** (item #2). Added `BROADCAST_TIMEOUT` to `backend/src/types/api.ts` ErrorCode union alongside the existing `BROADCAST_FAILED`. Applied the 504/502 discrimination pattern at 7 HTTP-response catch sites:
   - `backend/src/routes/orcid.ts` handleAccredit + handleLink — introduced narrow try/catch around `broadcastJsonWithTimeout` (outer `/callback` try/catch still covers non-broadcast errors as 500 INTERNAL_ERROR). Messages are mode-specific ("Broadcasting ORCID accreditation timed out" vs "Broadcasting ORCID link timed out"). Log context includes `{err, username, orcid, mode}`.
   - `backend/src/routes/accreditation.ts` `/verify` — replaced existing 500 INTERNAL_ERROR catch with the discrimination pattern. Log context `{err, username, email}`.
   - `backend/src/routes/papers.ts` `/retract` — replaced existing 500 INTERNAL_ERROR catch. Log context `{err, author, permlink}`.
   - `backend/src/routes/claims.ts` x3 — per item #1 above.
   Status codes: 504 = timeout (retriable), 502 = chain rejection (not retriable), 500 reserved for our bugs. The `retriable` flag is the programmatic-consumer discriminator.

3. **P2 signup-verify.ts structured logging** (item #3). `backend/src/routes/signup-verify.ts` `/confirm` (~265) and `/link` (~384): replaced `{err: (accErr as Error).message}` with `{err: accErr, email, username, orcid}` so operators see the `BroadcastTimeoutError` class + `timeoutMs` property in logs when the best-effort accreditation broadcast fails. Response still returns 200 (best-effort contract unchanged — account creation succeeds regardless of accreditation broadcast outcome). Same structured-log shape applied to both sites.

4. **P2 route test timeout coverage + mock-stub `timeoutMs` ctor fix** (item #4 + dismissed P3 T4-04).
   - `backend/tests/routes/orcid.test.ts` + `claims.test.ts` + `signup-verify.test.ts`: replaced stub `BroadcastTimeoutError extends Error {}` with a class that mirrors the real ctor signature (`constructor(timeoutMs: number)` + public readonly `timeoutMs` property). Hoisted via `vi.hoisted` so the same class identity is shared between the vi.mock factory and test bodies that stage `mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000))`.
   - `orcid.test.ts`: added `'broadcast timeout → 504 BROADCAST_TIMEOUT, no cache write, lock released'` spec inside the existing `describe.each([{mode:'accredit'},{mode:'link'}])` block (2 specs total). Asserts 504 envelope with `{retriable:true, timeout_ms:30000}`, asserts `redis.get(cacheKey)` is null (no cache write), asserts `redis.get(lockKey)` is null (finally released under nonce CAS). Updated the existing `'releases the lock via nonce CAS when broadcast throws mid-request (finally)'` spec — assertion changed from 500 INTERNAL_ERROR to 502 BROADCAST_FAILED with `{retriable:false}` since non-timeout broadcast errors now hit the new narrow try/catch rather than the outer /callback catch.
   - `claims.test.ts`: added `BE-ORCID-BROADCAST-ABORT-TIMEOUT — claims timeout discrimination` describe block with 4 specs covering approve (timeout + non-timeout) + revoke-bridge + revoke-native. Asserts 504/502 envelope shapes and that the broadcast mock was called exactly once before the error (proves no retry happens in the handler).
   - `signup-verify.test.ts`: ctor-fix only (test bodies don't assert timeout-specific behavior since `/confirm` + `/link` treat accreditation broadcast as best-effort — swallowed, no 504 surface). Inline comment in the mock factory documents why no per-route timeout spec applies here and notes the ctor-mirror exists to protect against latent false-confidence.

**Inline comment fix:** `backend/src/routes/orcid.ts:~617` — the `ORCID_BINDING_LOCK_TTL_SECONDS` block-comment line citing "30s dhive timeout" has been updated to reference the helper-enforced wall-clock bound in `hive.ts`. The task file noted orcid.ts:40 originally; the line drifted to ~617 during the SEC-002-TOCTOU-LOCK round-2 refactor but the inaccurate prose was the same.

**Out of scope (filed as separate Pending tasks per architect's round-1 hold):** `backend-orcid-broadcast-timeout-outcome-handling.md` (ambiguous-outcome + retry semantics), `backend-wot-broadcast-timeout-handling.md` (wot.ts library-level discrimination + cascade wall-clock cap), `backend-broadcast-sendoperations-wrap.md` (unwrapped `broadcast.sendOperations` sites in bridge/custody/anonymousReview/signup-verify).

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES (round 2):**

Round-2 `/ce-code-review` on commit `618e024` (10 personas: correctness, testing, maintainability, project-standards, kieran-typescript, api-contract, reliability, adversarial, agent-native, learnings-researcher). All 4 round-1 hold items are present in code; two P1 issues block archive and several P2 polish items collapse into the same hold-fix commit. Full per-persona artifacts at `.context/compound-engineering/ce-code-review/20260422-124330-25bdd0c4/`.

1. **P1 — `retriable:true` on `/api/orcid/callback` 504 is factually false and contradicts the existing convention** (adversarial ADV-R2-001 0.93 + learnings-researcher convergence, 2-reviewer). The OAuth `state` is unconditionally deleted at `backend/src/routes/orcid.ts:~253` BEFORE dispatch to `handleAccredit`/`handleLink`. On 504 timeout the response advertises `retriable:true`; a client retry with the same `{code, state}` hits the state-check at `orcid.ts:~245` and returns 400 BAD_REQUEST "Invalid or expired state parameter." The retry physically cannot succeed. Also: `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` already mandates `retriable:false + outcome:'uncertain' + verify_before_retry:true` for this exact pattern — the round-1 hold's `retriable:true` spec contradicted a load-bearing convention doc.

   **Fix at both `handleAccredit` and `handleLink` timeout catches:**
   ```ts
   sendError(res, 504, 'BROADCAST_TIMEOUT', '<mode-specific message>', {
     retriable: false,
     outcome: 'uncertain',
     verify_before_retry: true,
     verify_location: '/settings',
     timeout_ms: err.timeoutMs,
   });
   ```
   Apply the same `retriable:false + outcome:'uncertain' + verify_before_retry:true` envelope at the 5 other 504 sites (`accreditation.ts /verify`, `papers.ts /retract`, `claims.ts` x3) for consistency — a broadcast abort is ambiguous-outcome at every surface, not just `/callback`. The contract doc (`agents/docs/api-contracts/common.md` Standard Error Codes table, updated by architect during this review pass) is the new source of truth for the `BROADCAST_TIMEOUT` envelope shape.

   Update the 504 `orcid.test.ts` specs to assert the new envelope (`retriable:false, outcome:'uncertain', verify_before_retry:true, timeout_ms:30000`). The 5 non-orcid sites also need their 504 envelope updated + test coverage (see item #2).

   Coordination: `ui-orcid-callback-retriable-branch.md` (currently in `review/`, blocked on this round) will be re-reviewed AFTER this task's round-3 fixes land so its retriable-consumer logic matches the corrected backend envelope.

2. **P1 — `accreditation.ts /verify` and `papers.ts /retract` ship 504/502 discrimination with ZERO test coverage** (testing TEST-002 + TEST-003 0.95 each). Round-1 hold P2 item #4 required per-route timeout specs at all 7 migrated surfaces. Delivered: `orcid.test.ts` (2 specs), `claims.test.ts` (4 specs). Missing: `accreditation.test.ts` and `retract.test.ts` — both files cover only short-circuit paths (400/401/404/422) with no `vi.mock` for `broadcastJsonWithTimeout`, so a regression reverting the `instanceof BroadcastTimeoutError` check or changing the 504 code to 500 passes all tests green.

   Add per-file:
   - `accreditation.test.ts` — 2 specs: (a) 504 BROADCAST_TIMEOUT envelope + token NOT deleted (token survives for retry after chain-state verify); (b) 502 BROADCAST_FAILED envelope + token IS deleted (see item #3).
   - `retract.test.ts` — 2 specs: (a) 504 envelope + no post-broadcast state writes; (b) 502 envelope. Mirror the orcid/claims pattern (vi.hoisted MockBroadcastTimeoutError, vi.mock broadcastJsonWithTimeout, mockRejectedValueOnce).

3. **P2 — `accreditation.ts /verify` token survives the 502 path** (correctness COR-001 0.87). `deleteToken(token)` is inside the try block after a successful broadcast. On 502 (chain-rejected, `retriable:false`) the token survives its 24h TTL and can be reused, contradicting the `retriable:false` advertisement. Fix: call `deleteToken(token)` before the 502 `sendError` (but NOT on 504 — the 504 path is retriable-after-verify, so the token must survive). Pair the token-lifecycle change with the `accreditation.test.ts` specs from item #2.

4. **P2 — All 7 `BroadcastTimeoutError` catch branches emit no server-side log** (reliability R2-001 0.95). The non-timeout (`else`) branch at every site logs with `logger.error`; the timeout branch has no log call. Operators cannot detect slow-node events via log aggregation or alerting; a sustained degraded-Hive-node period silently drops broadcasts with no pager signal. Fix at each of the 7 sites: add `logger.warn({err, timeoutMs: err.timeoutMs, ...routeCtx}, '<route> broadcast timed out')` before the `sendError` call. `logger.warn` is the right tier (expected degraded-node event, not a code bug).

5. **P3 — `BroadcastTimeoutError` missing `Error.captureStackTrace`** (kieran-typescript KT-R2-1 0.92). `backend/src/hive.ts:33` — add `Error.captureStackTrace(this, BroadcastTimeoutError)` in the constructor so stack traces point to the broadcast call site instead of the Promise timeout closure. One-liner fold into the hold-fix commit; touches every 504 log across all 8 catch sites (7 routes + wot.ts).

6. **P3 — `claims.test.ts` describe-block comment asserts `hafCache.invalidate` NOT called on timeout, but no assertion enforces it** (testing TEST-001 0.92). `backend/tests/routes/claims.test.ts:~388`. Add a `vi.spyOn(hafCache, 'invalidate')` + `expect(invalidateSpy).not.toHaveBeenCalled()` to each of the 4 claims timeout specs so a future refactor that moves `invalidate` outside the try surfaces as a failing test. Same describe-block opportunity.

**Dismissed from round-2 findings (architect triage):**
- **P3** AC-008 Retry-After header absent on 504 (0.88): intentional — the 504 is ambiguous-outcome, not a simple "wait N seconds and retry," so `Retry-After` would mislead. Document via item #1's `verify_before_retry` field instead.
- **P3** AC-009 `BROADCAST_FAILED` emits two HTTP statuses (500 bridge/custody, 502 the 7 migrated surfaces): subsumed by the new follow-up task `backend-bridge-custody-broadcast-discrimination.md` (filed below).
- **P3** ADV-R2-002 `/verify` double-broadcast risk: subsumed by item #1 (504 `retriable:false` closes the naive-retry window) + item #3 (token deletion on 502).
- **P3** COR-002 comment/assertion `toBe(1)` vs `toHaveLength(1)` cosmetic.
- **P3** COR-003 `sendOk` inside try block emits false 502 on client-disconnect: low likelihood; opportunistic fix if easy, not blocking.
- **P3** KT-R2-3 `(err as Error).message` pattern in `bridge.ts`: pre-existing; subsumed by the new bridge/custody follow-up.
- **P3** KT-R2-4 `as never` test casts: pre-existing stylistic.
- **P3** MAINT-005 dead `if (timer)` guard: cosmetic.

**Filed as separate Pending tasks (out of scope for this hold):**
- `backend-handle-broadcast-error-helper.md` (new P3) — extract the 7-site try/catch discrimination pattern into a `handleBroadcastError(res, err, opts)` helper (MAINT-001 0.88). Purely a DRY refactor; does not block archive of THIS task.
- `backend-bridge-custody-broadcast-discrimination.md` (new P2) — migrate `bridge.ts` (`/register`, `/update`) + `custody.ts` (`/broadcast`) `broadcastSendOperationsWithTimeout` catch blocks to the 504/502 discrimination pattern; remove `err.message` / `jse_shortmsg` interpolation from bridge response bodies (MAINT-002 + KT-R2-2 + KT-R2-3 convergence). Depends on the helper from the previous task.
- `backend-log-pii-email-hash.md` (new P2) — replace plaintext `email` log fields with truncated SHA-256 hashes at `signup-verify.ts`, `accreditation.ts`, and any sibling sites (MAINT-004 0.80). PEvO privacy-by-design vs persistent error logs.

**Architect-owned fix-in-place (applied in this review pass):**
- `agents/docs/api-contracts/common.md` — Standard Error Codes table updated: `BROADCAST_FAILED` → HTTP 502, `details.retriable:false`; `BROADCAST_TIMEOUT` → HTTP 504 with the `{retriable:false, outcome:'uncertain', verify_before_retry:true, timeout_ms:number}` envelope per the convention doc. Closes AC-001 + AC-002 + AC-007.
- `agents/docs/api-contracts/orcid.md` — `/callback` errors list extended with 502 BROADCAST_FAILED and 504 BROADCAST_TIMEOUT entries including the `verify_location:'/settings'` hint. Closes AC-004.
- `agents/docs/api-contracts/accreditation.md` — `/verify` errors list extended. Closes AC-003.
- `agents/docs/api-contracts/papers.md` — `/retract` + claims `/approve` + claims `/revoke` errors lists extended. Closes AC-005 + AC-006.

**Path to re-archive:** (1) Backend applies items #1-6 on this task. The contract-file shape (common.md BROADCAST_TIMEOUT envelope) is now the source of truth — backend code must match. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-3 with `/ce-code-review` (adversarial + reliability + testing mandatory given P1 scope); archives on clean. Filed follow-up tasks archive independently.
