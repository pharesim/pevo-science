## UI-PASSWORD-POLICY-HARMONIZE (archived 2026-04-29) — round-1 clean ✓

UI side of cross-stack password-policy harmonization. Adds a `Keep in sync with backend/src/lib/password-policy.ts` pointer comment to `frontend/src/password-policy.js`, citing the backend CI drift-check test as the gate. Lands alongside the backend half (`backend-password-policy-harmonize`, currently held in pending/ on round-1 for two test-coverage hardening items). UI half passed `/ce-code-review` (6 personas: correctness, testing, maintainability, project-standards, agent-native, learnings) with zero findings on the comment-only diff. Implementer commit: `0b73a53`.

The pair (BE drift-check test + FE pointer comment) implements the agreed cross-stack harmonization shape: two independent helper implementations, one CI gate that loads both and asserts behavioral agreement on a labelled test-vector grid, plus reciprocal pointer comments so a future unilateral edit has a visible nudge to update the other side. The drift-check test (`backend/tests/lib/password-policy-drift.test.ts`) is the audit surface; the pointer comments are the editor-visible nudges.

---

## BACKEND-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING (archived 2026-04-29) — round-4 clean ✓

Architect decision Option A.2 (504 + retriable:false + verify_before_retry envelope) for ORCID-binding broadcast paths whose 30s timer fires while outcome is genuinely uncertain. Closes the ambiguous-outcome window the prior round-3 sweep left open: when chain-write timer fires, the broadcast may or may not have landed; client must verify before retry to avoid duplicate-bind.

Implementation landed in commit `0a5c890` (round-2 hold-fix) and `a0f121d` (round-3 hold-fix) on `backend/src/lib/broadcast-error.ts` and `backend/src/routes/orcid.ts`. Round-3 added a mutation-kill spec for the lockState='unavailable' non-timeout broadcast error path (rejects broadcastJsonMock with non-timeout `Error('synthetic ...')`, asserts 504 ambiguous-outcome envelope with no `details.timeout_ms`, `/uncertain/i` message, ambiguous-outcome operator-alert log suffix, all via the existing `describe.each([accredit, link])` matrix). Item #2 added `errorSpy` named-local capture in `tests/lib/broadcast-error.test.ts` to pin the operator-alert log suffix at unit-layer. Item #3 swapped `MockBroadcastTimeoutError` cause to a generic `Error('synthetic db cascade failure')` in the post-broadcast seam test for semantic clarity.

Architect-applied in-place fixes during round-3: 4th log-suffix added to docblock (`PostBroadcastWriteError` discrimination path), stale "forceAmbiguousOutcome above" comment replaced, `HandleBroadcastErrorAmbiguousOpts` re-derived via `Extract<>`-narrowed type for mechanical sync with `AmbiguousOutcomeFields`, convention-doc round-2 example block rewritten to reflect the discriminated-union shape.

Round-4 review (all 6 commits since round-3 architect review): correctness + testing + adversarial all confirm mutation-kill rigor lands. P3 polish items (hardcoded line numbers in test comments, redundant `not.toHaveProperty` after exact-match `toEqual`, integration-layer log-filter substring vs unit-layer exact match) all dismissed as below action threshold.

Convention docs: `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`, `inner-catch-shadows-outer-catch-in-route-tests-2026-04-28.md`, `correlated-options-discriminated-union-2026-04-28.md`, `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` all directly govern the work.

Full history: see commits `0a5c890`, `df264d7`, `27befcf`, `0d0c156`, `d8b9b75`, `a0f121d` and the task file body via `git show HEAD~N:agents/docs/tasks/review/backend-orcid-broadcast-timeout-outcome-handling.md`.

---

## BACKEND-ORCID-ACQUIRED-BRANCH-THROW-GUARD (archived 2026-04-29) — round-2 clean ✓

Filed by architect during BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING round-2 re-review (finding #2). The lock-acquired branch of `withOrcidBindingLock` previously had no outer try/catch — sync throws (e.g. `PrivateKey.fromString` on malformed admin key) escaped to the outer `/callback` catch and emitted 500 INTERNAL_ERROR with state token consumed (a hard-block class). Implementation in commit `0d0c156` added the symmetric outer try/catch routing through `handleBroadcastErrorAmbiguous`, producing the 504 ambiguous-outcome envelope. The post-broadcast cascade (`updateAccountOrcid`) is the live integration coverage; pre-broadcast SYNC throws on the acquired branch were filed separately as `backend-pevo-admin-key-startup-validation.md` (a startup-time validation guard makes the production trigger unreachable).

Round-1 architect review held one P3 item (matcher tightening from `toBeGreaterThanOrEqual(1)` to `toBe(1)` at `tests/routes/orcid.test.ts:1340` and `:1441` for the operator-alert log assertions). Round-2 hold-fix in commit `acae57e` landed exactly the 2-line tightening. Mutation-kill verified: a regression that double-emits the operator-alert log (e.g. a misplaced retry that re-throws from the catch block) now flips green-to-red, matching the stated intent in the surrounding spec comments. Lines 2008/2132 (unavailable branch + state-replay scope) deliberately left at `>=1` per architect scope.

Architect-applied in-place fixes during round-1: JSDoc 'acquired' bullet rewrite, NB comment update post-`d8b9b75` discrimination, convention-doc symmetric-branch paragraph addition, `agents/docs/api-contracts/orcid.md` 504 BROADCAST_TIMEOUT entry rewritten to enumerate three trigger paths with `details.timeout_ms` presence rule, `agents/docs/api-contracts/common.md` POST_BROADCAST_FAILED row added.

Full history: see commits `0d0c156`, `acae57e`, `53da6c9` and the task file body via git.

---

## UI-ORCID-CALLBACK-RETRIABLE-BRANCH (archived 2026-04-29) — round-3 clean ✓ (machinery now being removed)

Frontend consumer of the lock-contention 409 retriable surface. Round-2 hold-fix bundle (commit `f996d37`) landed 5 items: upper-bound clamp on `Retry-After` (`Math.max(1, Math.min(300, err.retryAfterSeconds ?? 10))` defending against backend emitting `Retry-After: 99999` which would pin the user for ~28 hours), stale `_retryCount` comment fragment dropped, "single self-triggered retry" prose reworded to "up to MAX_RETRIES self-triggered retries" at two sites, redundant `comp._mounted = true` deleted from a timer-based test (createTimerGuard already initializes it), `expect(comp._retryCount).toBe(0)` invariant added to the undefined-retryAfter test.

Special context: a parallel architect task `ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409` (archived 2026-04-29 — Option B chosen) determined the retriable-branch contract is **unreachable by design** — backend consumes the OAuth state token at `orcid.ts:299` BEFORE dispatching to the lock-contention branch, so the SPA's `_retryVerify` always lands on 400 BAD_REQUEST first. The follow-on task `ui-orcid-callback-retriable-machinery-remove.md` strips the `_retryCount`/`MAX_RETRIES`/countdown machinery this round just polished. Per the round-2 architect note "independent and does not block this archive", the polish-then-remove order is acceptable.

Round-3 review: correctness + testing + julik-frontend-races + adversarial all confirm the 5 items land. One vacuous-`_retryCount=0`-assertion finding dismissed as "polish on dead-code-pending" — the surfaces are being torn out anyway by the machinery-removal task.

Full history: see commits `fbe8578`, `f996d37`, `9b2f774` and the task file body via git.

---

## ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409 (archived 2026-04-29) — Option B chosen ✓

# ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409 — Resolve the unreachable-by-design retriable-409 contract

**Owner:** architect (product decision needed before backend or UI implementation)
**Created:** 2026-04-29 (architect, surfaced by adversarial reviewer adv-1 during round-2 review of `UI-ORCID-CALLBACK-RETRIABLE-BRANCH` commit `fbe8578`)
**Priority:** P1
**Source:** `agents/docs/tasks/pending/ui-orcid-callback-retriable-branch.md` round-2 review (architect 2026-04-29) — adversarial conf 85.

## Problem

The `ORCID_ALREADY_LINKED` 409 envelope's `retriable: true` discriminator on the same-tick lock-contention branch is **unreachable by design** — backend consumes the OAuth state token before the contention is detectable, and the frontend's retry path then fails with 400 BAD_REQUEST instead of the retried operation succeeding.

Concrete trace:

1. `POST /api/orcid/callback` with `{code, state}`.
2. `backend/src/routes/orcid.ts:282-302` — backend reads `stateKey`, validates auth (for AUTHENTICATED_MODES), then **deletes `stateKey` at line 299** (`redis.del(stateKey)` / `orcidStates.delete(state)`). Comment at line 297 is explicit: "Auth passed (or mode is public). Consume state now so it can't be replayed."
3. `:335` switch routes to `handleAccredit` / `handleLink`.
4. Inside the handler, `withOrcidBindingLock` runs and may emit the 409 ORCID_ALREADY_LINKED with `retriable: true` + `Retry-After: 10` from its `'held'` branch.
5. Frontend (`frontend/src/pages/orcid-callback.js:288` `_retryVerify`) replays the same `{code, state}` after the countdown.
6. Backend `:282` state-check fires FIRST: `if (!storedMode) { sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired state parameter'); return; }`. Returns 400, not the retried-and-succeeding operation.
7. Frontend's catch block hits the generic-fallback branch (no special handling for 400 BAD_REQUEST after a retriable retry) and renders `orcid.verificationFailed`.

The retriable-discriminator infrastructure is structurally correct on each side (backend signals retriable+Retry-After; frontend consumes and counts down then retries) but the composition fails: the user never reaches the lock-contended retry that the contract promises. `MAX_RETRIES=1` (the round-1 hold-fix safety cap on this task) just bounds how many times the wrong outcome repeats.

This is **pre-existing** — the issue dates to whenever backend's lock-contention 409 first signaled `retriable: true`. UI-ORCID-CALLBACK-RETRIABLE-BRANCH (consumer side) shipped over an already-broken contract.

## Why this matters

- **The retriable-discriminator UX is silently lying to users.** A user hits the same-tick contention, sees a "retrying in 10 seconds" countdown, watches it fire, then sees a generic verification-failed message with no actionable signal. They restart OAuth and (most likely) succeed because the contention is transient. The countdown was theatre.
- **Operator alerts on retriable-409 are undercounted.** The frontend's 400 BAD_REQUEST after retry is indistinguishable from a normal state-token-replay attempt; operators reviewing 400 rates can't separate "user retried our retriable promise" from "actual replay attack."
- **Silent contract drift erodes trust in the retriable discriminator going forward.** If we ship A.1's lock-TTL-extension envelope on `BroadcastTimeoutError` (separate task, already shipped via 81795fd) and operators or future contributors look at the existing retriable-409 as a reference, they'll model new retriable contracts on a broken precedent.

## Three product directions (architect to decide)

### Option A — Backend: defer state consumption until after lock acquisition

Move the `redis.del(stateKey)` from `:299` (pre-dispatch) to inside the handler, AFTER `withOrcidBindingLock` returns successfully (or signals a non-retriable failure). The retriable-409 then preserves the state token, the frontend retry succeeds.

**Cost:** opens a state-replay attack window during the lock-acquisition + broadcast window (3-30s). An attacker who steals the state token between OAuth redirect and our consume-now point can race a parallel `/callback` request, both hitting different `handleAccredit` invocations against the same state. Today this is closed by the eager `redis.del`; deferring opens it.

**Mitigation:** the lock itself is keyed on `orcid_id`, so two concurrent `/callback`s with the same state would race for the same lock — one wins, the other gets `'held'` 409 retriable. The retry-with-same-state would then succeed (lock free) for whichever client retries first. The "attack" reduces to "attacker can force the legitimate user into a single retriable-409 round-trip" — UX nuisance, not auth compromise. The state token is still single-use *eventually* (consumed after the successful broadcast).

This is the cleanest architectural fix.

### Option B — Backend: drop `retriable: true` from lock-contention 409

Keep the eager state-consume. Acknowledge that the same-tick contention case is genuinely terminal from the user's perspective (state is gone; restart OAuth). Drop the `retriable: true` and `retry_after_seconds` from this specific 409 emission. Frontend continues to receive a `ORCID_ALREADY_LINKED` 409 but treats it as durable.

**Cost:** the user retry flow on contention is "restart full OAuth" instead of "wait 10s." Acceptable at PEvO's scale (contention is rare); same-tick contention typically clears before the user restarts.

This is the simplest fix. Honest to the actual contract.

### Option C — Frontend: treat `retriable: true` as informational

Keep both sides. Frontend renders the countdown but does NOT auto-retry — instead shows "another request is in progress; try again in N seconds" and lets the user manually click retry once N passes. A manual retry restarts OAuth (new state token) rather than replaying the consumed one.

**Cost:** kills the value-add of UI-ORCID-CALLBACK-RETRIABLE-BRANCH (auto-retry was the point). Defeats the round-1 hold's `_retryCount` + `MAX_RETRIES` machinery (no auto-retry to cap).

Defensible only if Option A's replay-window cost is judged unacceptable AND Option B's "drop the discriminator" feels like a contract regression we don't want to advertise.

## Recommendation (architect, leaning)

**Option B.** Same-tick lock contention is a rare edge case at PEvO's scale (tens of signups/day). The retriable-discriminator's value is on the lock-extended-on-`BroadcastTimeoutError` path (Option A.1, already shipped via `81795fd`) — and that path doesn't have the state-consumption-order problem because the timeout fires *after* the state was consumed by a successful broadcast acceptance. Dropping the same-tick `retriable: true` honestly aligns the contract with reality and removes the broken-by-design surface entirely.

If chosen, the follow-on UI work is to remove the now-unused `_retryCount` / `MAX_RETRIES` / countdown machinery from `orcid-callback.js` (or repurpose it for the BroadcastTimeoutError envelope, which DOES have a working retriable contract on the backend side).

## Decision (architect, 2026-04-29)

**Option B chosen.** Drop the `retriable: true` discriminator from the same-tick lock-contention 409. The case is genuinely terminal from the user's perspective (state is consumed before lock acquisition can run, so any same-`{code, state}` retry returns 400 BAD_REQUEST) — the discriminator was promising a retry path that never reached the handler.

Rationale:

- Same-tick contention is rare at PEvO scale (tens of signups/day).
- The retriable-discriminator's actual value is on the lock-TTL-extended `BroadcastTimeoutError` path (already shipped via `81795fd`) — and that path is correctly `retriable: false` with `verify_before_retry: true`. State has been consumed by the time the timer fires, so retry isn't expected.
- Option B aligns the contract with reality and removes the broken-by-design surface entirely. Option A's deferred-state-consume would have opened a (narrow, mitigated) replay window for an edge case that's already rare; the cost-benefit doesn't justify the change.

Follow-on tasks filed:

- `backend-orcid-droplockcontention-retriable.md` — strip `retriable: true` + `retry_after_seconds` + `Retry-After` from the `'held'`-branch 409 in `withOrcidBindingLock`.
- `ui-orcid-callback-retriable-machinery-remove.md` — remove `_retryCount`, `MAX_RETRIES`, `retryCountdown`, `_retryVerify`, `_lastVerifyArgs`, the `alreadyLinkedRetriable` template branch, and the `orcid.alreadyLinkedRetriable` locale key.

Doc updates landed alongside this decision:

- `agents/docs/api-contracts/orcid.md` — same-tick contention 409 documented as non-retriable; convention paragraph updated; degraded-mode-success tail-sentence reference to retriable-409 retry agents removed.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — appended a "Sibling principle: `retriable: true` is meaningless when state is single-use" section with audit checklist; tags + last_updated bumped.

## Acceptance

A separate `backend-orcid-...` task implements the chosen option once architect decides. This task closes when the decision is recorded in this file (or the file moves to archive) and the implementation task is filed.

## Coordination

- Pairs with `tasks-archive.md` BACKEND-ORCID-LOCK-TTL-EXTEND-ON-TIMEOUT entry — that task's `retriable: false` 504 envelope on `BroadcastTimeoutError` (Option A.2 in the chain-write convention doc) is the OTHER retriable-vs-not signal in this surface, and IS correctly shaped (state has been consumed by the time the timer fires; the user is told to verify before retry, not auto-retry). The current task only resolves the same-tick contention path, not the timer-fire path.
- Convention doc `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — would benefit from a paragraph on "retriable=true is meaningless if state is single-use" once a decision is recorded.

## Source

- `agents/docs/tasks/pending/ui-orcid-callback-retriable-branch.md` round-2 architect review (2026-04-29) — adversarial finding adv-1 (P1 conf 85, "composition failure: state token consumed before retriable 409 emits").
- `backend/src/routes/orcid.ts:282-302` — state validate + consume.
- `backend/src/routes/orcid.ts:1027-1036` — lock-contention 409 with `retriable: true`.
- `frontend/src/pages/orcid-callback.js:288` — `_retryVerify`.
- `agents/docs/api-contracts/orcid.md:188` — same-tick lock-contention contract description.

## BE-503-REASON-DISCRIMINATION (archived 2026-04-29) — Round-1 clean ✓

# BE-503-REASON-DISCRIMINATION — Add `details.reason` to argon2-503 envelopes so canary monitors can branch on shutdown vs queue-saturation

**Owner:** backend
**Created:** 2026-04-28 (surfaced by cluster A `/ce-code-review` of `backend-argon2-semaphore-shutdown-drain.md`, agent-native persona reframed as ops observability per root `CLAUDE.md` "API Consumer Surface")
**Priority:** P2
**Final commit:** `7b20b6a` ("feat(503): add details.reason discriminator to argon2 503 envelopes") with test-side reconcile in `5586f9f` ("backend(argon2): reconcile task1 (details.reason) into task3 (shared mocks) + skip /reset-request shutdown branch")

## What landed

Wire envelope on `503 SERVICE_UNAVAILABLE` from argon2-bound endpoints (auth, custody, settings, signup-verify) now carries `details.reason: 'queue_full' | 'shutdown_drain'`. Status, error code, message, and Retry-After remain identical between the two branches; the discriminator is the only field that distinguishes them. HTTP-only consumers (synthetic canaries, status-page probes, browser-side telemetry) can branch on it without log-stream correlation.

Source-of-truth values pinned in `backend/src/lib/argon2-error-handler.ts` as `ARGON_REASON_QUEUE_FULL = 'queue_full' as const` and `ARGON_REASON_SHUTDOWN_DRAIN = 'shutdown_drain' as const`. The helper `handleArgonError` is the single emission site; all 4 routes funnel through it. `ArgonAbortError` silent-return path is unchanged (no envelope written; no `details.reason`). Pool-unavailable 503 paths (`getAppPool() === null`) intentionally do NOT emit the field — out-of-scope per task non-goals.

Lib-level test in `backend/tests/lib/argon2-error-handler.test.ts` asserts the full envelope via `toHaveBeenCalledWith` exact deep match including `details: { reason: ARGON_REASON_QUEUE_FULL }` for both branches, plus sentinel pins (`expect(ARGON_REASON_QUEUE_FULL).toBe('queue_full')`) that catch both rename (import would fail) and silent value drift. Route-level translation tests in 4 files assert `body.error?.details?.reason` with `toBe('queue_full')` / `toBe('shutdown_drain')` on both branches — `toBe` with a literal fails closed against `undefined`, so dropping the field from the helper would fail every route test.

## Architect re-review (2026-04-29) — clean ✓

`/ce-code-review` ran on commit `7b20b6a` (+ test-side parts of `5586f9f`) with 7 personas (correctness, testing, maintainability, project-standards, agent-native, api-contract). Implementation lands cleanly across all 7 lenses; no findings at anchor>=50 from any persona except the doc-side and follow-up items below. Verified:

- Discriminator constants exported `as const` with correct spelling.
- Helper-based single emission point; no per-route duplication.
- Abort silent-return path correctly does NOT emit the field.
- Pool-unavailable 503 paths correctly do NOT emit the field (out-of-scope guarantee holds via `sendError`'s conditional `details` assignment).
- Tests pin both lib-level exact-match envelope AND route-level integration-level field via `toBe` (mutation-resilient).

## Architect-side action landed during this pass

The task's `[TODO Architect]` block carved out the `agents/docs/api-contracts/common.md` update. **Done in the same architect commit that produced this clean signal**: SERVICE_UNAVAILABLE row updated to reference the discriminator; new "Note on `503 SERVICE_UNAVAILABLE` and `details.reason`" prose added with the example envelope, source-of-truth pointer to the constants, and the explicit "consumers MUST treat absence as a third bucket" caveat for non-argon2 503 paths.

## Items dismissed during architect triage (do NOT address)

- **Asymmetric vs `HandleArgonErrorResult` — no exported `ArgonReason` union type alongside the constants.** YAGNI today; one production caller (the helper itself), one test asserting the values, no external consumer to enforce against. Revisit when a third reason value lands (e.g. the deferred `pool_unavailable` from the non-goals, or a sibling 503 task).
- **No negative test that pool-unavailable 503 paths do NOT emit `details.reason`.** Out-of-scope per task non-goals; absence-of-mutation is sufficient until a future change risks routing pool-null through `handleArgonError`.

## Cluster-A drift surfaced (filed separately, NOT held against this task)

- `auth-signup-dup-saturated.test.ts` lines 141, 172 hardcode the literals `'queue_full'` / `'shutdown_drain'` instead of importing the constants — captured in `backend-argon2-test-mocks-migrate-pre-existing.md` (new task), bundled with the synthetic-mock-class drift in the same two pre-existing test files.

## Files of record

- `backend/src/lib/argon2-error-handler.ts` — `ARGON_REASON_QUEUE_FULL` / `ARGON_REASON_SHUTDOWN_DRAIN` exports + `handleArgonError` `details.reason` emission
- `backend/tests/lib/argon2-error-handler.test.ts` — lib-level exact-match assertions + sentinel pins
- `backend/tests/routes/{auth,custody-upgrade,settings-set-password,signup-verify-resume}-argon-error-translation.test.ts` — route-level `toBe(...)` assertions
- `backend/tests/routes/auth-signup-dup-saturated.test.ts` — extended with `details.reason` assertions (literal strings; migration captured in `backend-argon2-test-mocks-migrate-pre-existing.md`)
- `agents/docs/api-contracts/common.md` — SERVICE_UNAVAILABLE row + new note describing the discriminator and the example envelope

---

## FE-ORCID-CALLBACK-FIXES (archived 2026-04-29) — Round-3 clean ✓

# FE-ORCID-CALLBACK-FIXES — Stale-state write-window + login-path polling parity on the ORCID callback

**Owner:** UI Agent
**Created:** 2026-04-21
**Priority:** P1
**Final commit:** `1c28b39` (round-2 hold-fix re-application after a 2026-04-28 architect intake found the round-2 items had not landed despite the prior signal)
**Lineage commits:** `0951fef` (round-1: `_saveSession` 6-arg misuse fix at `orcid-callback.js:148` + `login.js:152`, `pevo_orcid_mode` removeItem moved into success handler), `c078940` (round-1 hold-fix: clear stale `isAccredited` + `accreditation` before `_saveSession`, mockAuthStore extension + regression test), `1c28b39` (round-2 hold-fix: `_handleLogin` swap to `_startAccreditationPolling`, localStorage payload assertion, `toHaveBeenCalledTimes(1)`, dead fake-timers removed)

## What landed across the rounds

**Round-1 (`0951fef`).** Fixed the `_saveSession(6 args)` misuse on the ORCID callback path and the symmetric site at `login.js:152`. Set `auth.expiresAt = data.expires_at` before `_saveSession()`. Moved `pevo_orcid_mode` removeItem into the success handler of `completeOrcid`. Filed `FE-SAVESESSION-API-MISUSE-SWEEP` for the same pattern at `signup-verify.js:412/457` and `settings.js:550`.

**Round-1 hold + fix (`c078940`).** Round-1 architect review surfaced (1) a stale-state write-window where the new no-arg `_saveSession()` reads `isAccredited` and `accreditation` from a store that may carry values from a prior session via `_restoreSession`, and (2) a test-harness gap (`mockAuthStore` had no `isAccredited`/`accreditation` fields, hiding the fix). Implementer set `auth.isAccredited = false; auth.accreditation = null;` before `_saveSession()` in `_handleLogin`, extended the mock with safe defaults, and added a regression test that snapshots store state at `_saveSession` call-time.

**Round-2 hold (julik-frontend-races + testing).** Surfaced (1) `_handleLogin` used bare `_checkAccreditation()` while sibling `loginFromResponse`/`connect` paths use `_startAccreditationPolling()` — a transient fetch failure could pin the store at `isAccredited=false` permanently; (2) the regression test snapshots in-memory store, not actual localStorage payload — a broken `_saveSession` would pass; (3) no `toHaveBeenCalledTimes(1)` assertion on `_saveSession` — double-save regressions undetected; (4) dead `vi.useFakeTimers()` / `vi.useRealTimers()` in the new test. Filed `frontend-orcid-callback-teardown-cleanup.md` (P3, separate task) for the unrelated 500ms setTimeout cleanup gap.

**Round-2 hold-fix (`1c28b39`).** All 4 items landed — `_handleLogin` polling parity, localStorage payload assertion via mock-implementation extension that writes the full session shape, call-count assertions on both `_saveSession` and `_startAccreditationPolling`, dead fake timers removed. Test-harness `mockAuthStore` extended with `_startAccreditationPolling: vi.fn()`. The post-teardown direct-call test now asserts `_startAccreditationPolling not called` alongside `_checkAccreditation not called` (belt-and-suspenders for the self-mounted-guard contract). 41/41 pass in `pages-orcid-callback.test.js`; full frontend unit suite 987 pass.

## Round-3 architect review (2026-04-29) — clean

`/ce-code-review` on commit `1c28b39` (9 personas; adversarial skipped per below-50-line threshold; julik-frontend-races covers the race-condition adversarial axis). Verified all 4 round-2 items landed correctly:
- Item #1 surgical (`_handleLogin` swapped, `_handleAccredit` at line 347 still uses `_checkAccreditation()` per spec — `_handleAccredit` is the accreditation-success path, not a login path).
- Item #2 localStorage assertion meaningful (mock writes session shape that mirrors real `_saveSession` six fields).
- Item #3 call-count assertions present at lines 224 + 229 (login-mode test) and 271 (stale-state test).
- Item #4 fake timers cleanly removed.

JR-2 / JR-3 closed; JR-5 substantially closed.

**Suppressed P3 advisories (dismissed during round-3 triage; not held):**
- Mock `_saveSession` field set is a hand-rolled copy of the real implementation's six fields. Identical today; silent divergence risk if real `_saveSession` adds a key (testing T-01 + learnings convergence). Documented in `object-shape-fix-every-reset-site-2026-04-21.md` convention.
- Redundant assertion pairing `toHaveBeenCalled()` + `toHaveBeenCalledTimes(1)` at `pages-orcid-callback.test.js:223-224` and `:270-271` (maintainability M-001). The first is subsumed by the second; reader confusion. 2-line cleanup, not blocking.
- Polling generates ~1 request/min to `/api/accreditations/:username` for unaccredited sessions (agent-native AN-1, observation). Backend operators may see step-function increase. Document in deploy notes when canary observability matures.

**Pre-existing in `frontend/src/auth.js` (NOT in this commit's scope; surfaced for visibility):** one spurious fetch at T+60s when the immediate `_checkAccreditation` resolves true before the first interval tick (REL-001); concurrent tabs arm independent polling intervals with no cross-tab dedup (REL-002); no SPA-navigation teardown path for the polling interval (only `beforeunload`); Tab-B storage-event triggers redundant fetch even when `isAccredited=true` was just restored. Worth a `frontend-auth-store-polling-cleanup.md` follow-up if observed in production.

## Files of record

- `frontend/src/pages/orcid-callback.js` — `_handleLogin` swap (line 335), `_handleAccredit` left untouched (line 347).
- `frontend/src/pages/login.js` — symmetric `_saveSession` 6-arg fix from round-1.
- `frontend/tests/unit/pages-orcid-callback.test.js` — 41 specs total.
- `agents/docs/tasks/pending/frontend-orcid-callback-teardown-cleanup.md` — round-2 spinoff for the 500ms setTimeout cleanup.
- `FE-SAVESESSION-API-MISUSE-SWEEP` — round-1 spinoff for the same `_saveSession(6 args)` pattern at `signup-verify.js` and `settings.js`.

---

## BE-PROFILE-PAPER-DISCIPLINE-CANON (archived 2026-04-28) — Round-2 clean ✓
