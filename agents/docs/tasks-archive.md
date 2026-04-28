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

# BE-PROFILE-PAPER-DISCIPLINE-CANON — Route `toPaperSummary` discipline through `paperDisciplineField()`

**Owner:** backend
**Created:** 2026-04-28 (surfaced by BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME review, correctness + maintainability cross-reviewer)
**Priority:** P2

## Context

BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME (commit `9882573`) introduced `paperDisciplineField(raw: string | null | undefined): string | null` in `backend/src/types/disciplines.ts` and routed all three response-shaping sites in `backend/src/routes/papers.ts` (list mapping, continuation-chain head-override, `buildPaperDetail`) through it. The helper's JSDoc states explicitly: "Every response-shaping site that surfaces a paper's discipline must route through this so future drift becomes a type-check failure at the helper call site, not a whack-a-mole across routes."

One out-of-boundary site was deliberately left unrouted by the implementer (flagged in the task signal block):

- `backend/src/helpers.ts:98` — `toPaperSummary()` builds `discipline: (pevo.discipline as string) || ''`.
- Consumer at `backend/src/routes/profile.ts:238` — `/api/profile/:account` papers list.

After this commit, `/api/papers` list+detail return canon_name lowercased. `/api/profile/:account/papers` still surfaces on-chain casing. Same field name, divergent normalization. A client round-tripping a paper's `discipline` back through `?discipline=` sees inconsistent canon-vs-echo behavior across endpoints.

## Goal

Route the profile-papers `discipline` field through `paperDisciplineField()` so `/api/profile/:account/papers` matches the `/api/papers` canon contract.

Mechanical blocker: `PaperSummary.discipline` is typed `string` (not `string | null`). Two fix shapes:

- **(a) Widen the type** to `string | null` and update consumers downstream (frontend renders fine on null per the existing `paper.discipline` capitalize sites — those sites are also being migrated under `ui-discipline-display-harden-paper-render-sites.md`).
- **(b) Coalesce at the boundary** — `discipline: paperDisciplineField(pevo.discipline) ?? ''` keeps `string`; preserves the historical "absent → empty string" shape.

## Recommendation

**(b) Coalesce at the boundary.** Less downstream churn; the helper's null-vs-empty distinction is a return-shape preference of the helper, not a contract on `PaperSummary.discipline`. Frontend + bridge consumers already treat `''` as absent.

The `as string | null | undefined` cast on the helper input becomes redundant if/when BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2 hold #2 (widen helper to `unknown`) lands; coordinate.

## Tests

Real-HAF spec in `backend/tests/routes/profile.test.ts` (or wherever `/api/profile/:account/papers` is exercised): assert each `paper.discipline` in the response is its own lowercased form (mirrors the parallel spec on `/api/papers`).

Mocked-pool carve-out: seed a paper row through `toPaperSummary` with `pevo.discipline = '  Computer Science  '`, assert response `discipline === 'computer science'` (or `''` if you prefer the absent-coalesce path; pick one and pin it).

## Acceptance

- `toPaperSummary` routes `pevo.discipline` through `paperDisciplineField()`.
- `/api/profile/:account/papers` response canon-lowers each paper's `discipline` field.
- Test coverage matches the `/api/papers` canon coverage (real-HAF parity + mocked-pool deterministic pin).
- `agents/docs/api-contracts/profile.md` (if it exists) gets a parallel field note. (Architect-owned; flag via `[TODO Architect]` if needed.)

---

