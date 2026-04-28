# FE-ORCID-CALLBACK-FIXES

**Owner:** UI Agent
**Priority:** P1
**Created:** 2026-04-21

## Status

Landed at commit `0951fef`. `_saveSession` 6-arg misuse fixed in `orcid-callback.js:148` AND `login.js:152` (same bug); `auth.expiresAt = data.expires_at` set before `_saveSession()`. `pevo_orcid_mode` removeItem moved into success handler of `completeOrcid`. New tests in `pages-orcid-callback.test.js` + `pages-login.test.js`. **Flagged follow-up:** same `_saveSession` 6-arg pattern still exists at `signup-verify.js:412/457` and `settings.js:550` — candidate for a `FE-SAVESESSION-API-MISUSE-SWEEP` task.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

## Architect re-review (2026-04-21d) — HELD PENDING FIXES

Review (manual-synthesis pass — see commit `e40d9dc` on why `/ce-code-review` fan-out was unavailable to the dispatched subagents, now fixed in architect CLAUDE.md) surfaced three P2 findings. User triage 2026-04-21d: fix first two in place; file third as separate sweep.

1. **P2 — `orcid-callback.js:146-159` `_handleLogin` stale-state write-window.** The old 6-arg `_saveSession(username, custody, postingKey, memoKey, false, null)` hard-coded `isAccredited=false` and `accreditation=null`. The new no-arg `_saveSession()` reads those fields from the Alpine store — which may carry values from a prior session via `_restoreSession`. Result: a ~50-200ms write-window where `localStorage.pevo_session` holds the new ORCID-logged-in username paired with the PREVIOUS account's `isAccredited` + `accreditation`. `_checkAccreditation()` self-heals via a second `_saveSession()`, but a concurrent tab's storage event or service worker reads the stale pairing in the interim. Fix: set `auth.isAccredited = false; auth.accreditation = null;` before `_saveSession()` in `_handleLogin` (matching the old hard-coded behavior).

2. **P2 — `pages-orcid-callback.test.js:9-16` test-harness gap that hides finding #1.** `mockAuthStore` declares only `{ username, isConnected, orcidVerified }` — no `isAccredited`, no `accreditation`. The fix for #1 is invisible to the test suite. Extend the mock to include both fields defaulting to post-disconnect safe values (`isAccredited: false`, `accreditation: null`), AND add a regression test: seed `mockAuthStore.isAccredited = true; mockAuthStore.accreditation = { type: 'email' }`, invoke ORCID `_handleLogin`, assert both are cleared before `_saveSession()` fires.

3. **P2 split to Pending: FE-SAVESESSION-API-MISUSE-SWEEP.** The same `_saveSession(6 args)` misuse the original commit fixed still exists at `signup-verify.js:412, :457` and `settings.js:636`. `settings.js:636` additionally passes `null` as old `expires_at`. Implementer already flagged this in the commit report; filed as a separate P2 Pending task.

**Path to archive:** (1) UI agent applies findings #1 + #2 on this task. (2) UI agent appends a re-review signal block. (3) Architect re-reviews (`/ce-code-review` directly from architect context per the updated protocol) and archives.

## UI re-review signal (2026-04-21, commit `c078940`)

Findings #1 + #2 landed. Ready for architect re-review.

- Finding #1 (stale-state write-window): `frontend/src/pages/orcid-callback.js` `_handleLogin` now sets `auth.isAccredited = false; auth.accreditation = null;` immediately before `auth._saveSession()` so the no-arg save doesn't carry stale store values into `localStorage.pevo_session`. Comment notes the synchronous reset is required because `_checkAccreditation` is async.
- Finding #2 (test-harness gap): `frontend/tests/unit/pages-orcid-callback.test.js` `mockAuthStore` extended with `isAccredited: false` + `accreditation: null` defaults. New regression test "ORCID login clears stale accreditation state BEFORE _saveSession() fires" seeds stale values, uses `mockImplementationOnce` on `_saveSession` to snapshot store state at call-time, and asserts both fields are already cleared at that instant.
- Verified: 25/25 pass in `pages-orcid-callback.test.js`; full frontend unit suite 837/837 pass; `npm run build` clean.

## Architect re-review (2026-04-21) — HELD PENDING FIXES

Round-2 `/ce-code-review` on commit `c078940` (correctness + testing + julik-frontend-races personas). The round-1 hold-block requirements (clear stale accreditation state before `_saveSession`, extend mockAuthStore + regression test) landed correctly ("BOTH HOLD-BLOCK REQUIREMENTS MET" per correctness reviewer). Round-2 surfaced an adjacent P2 asymmetry with other login paths and several test-hygiene items.

1. **P2 — `_handleLogin` uses bare `_checkAccreditation()` instead of `_startAccreditationPolling()`** (julik-frontend-races JR-2, 0.88; merged with JR-3 0.85). Sibling login paths `loginFromResponse` and `connect` in `frontend/src/auth.js` both call `_startAccreditationPolling()` after writing session state; this provides the 60s retry loop so a transient accreditation-fetch failure doesn't leave a non-accredited-looking store permanently. `_handleLogin` on the ORCID callback path calls only `_checkAccreditation()` — a single fetch. If the fetch fails transiently (network flap, backend slow), the store stays at `isAccredited=false` / `accreditation=null` forever (or until manual reload). Fix: replace `auth._checkAccreditation()` with `auth._startAccreditationPolling()` at `frontend/src/pages/orcid-callback.js:~166`. One-line change; matches the pattern other login paths use. Add one test asserting `_startAccreditationPolling` is called exactly once post-ORCID-login. Closes JR-2 and JR-3 together.

2. **P3 — Regression test snapshots in-memory store, not actual localStorage payload** (julik-frontend-races JR-5, 0.80). The new "clears stale accreditation state BEFORE _saveSession" test uses `mockImplementationOnce` on `_saveSession` to capture store state at call-time. It does NOT assert that the actual `localStorage.setItem('pevo_session', ...)` payload reflects the cleared state. A broken `_saveSession` that reads the wrong store fields would pass this test. Fix: after the existing `snapshotAtSave` assertions, add `expect(JSON.parse(localStorage.getItem('pevo_session'))).toMatchObject({ isAccredited: false, accreditation: null })` to cover the end-to-end persistence claim. (The real `_saveSession` is mocked in this test, so this assertion requires either un-mocking _saveSession for this one spec or pinning the test at a level where the real localStorage write happens. Implementer picks the shape; either is fine.)

3. **P3 — No call-count assertion on `_saveSession`** (testing T1, 0.95). Neither the existing "handles login mode" test nor the new stale-state test asserts `toHaveBeenCalledTimes(1)`. A refactor introducing a second `_saveSession` call (double-save) would pass. Fix: add `expect(mockAuthStore._saveSession).toHaveBeenCalledTimes(1)` to both tests. 2 lines.

4. **P3 — Dead `vi.useFakeTimers()` in the new stale-state test** (testing T2, 0.90). The test calls `vi.useFakeTimers()` at top and `vi.useRealTimers()` at the end but never advances timers, never asserts navigation, never depends on any setTimeout behavior. Noise. Fix: remove both calls.

**Dismissed from round-2 findings:**
- **P2 Transient `_checkAccreditation` failure leaves store permanently false** (julik-frontend-races JR-3, 0.85). **Subsumed by item #1**: starting the polling loop provides the retry path. Once #1 lands, JR-3 dissolves.
- **P3 500ms redirect setTimeout not canceled on component teardown** (julik-frontend-races JR-4, 0.75). Latent bug for page-destroy races. Filed as separate Pending task `frontend-orcid-callback-teardown-cleanup.md` — affects other setTimeout call sites in the callback flow, not just this one.
- **P3 Pre-existing `_saveSession` 6-arg misuse at `signup-verify.js` and `settings.js`**. Already filed as `FE-SAVESESSION-API-MISUSE-SWEEP` per the original task's split-to-Pending decision.
- **P3 Storage-event two-write gap** (julik-frontend-races JR-1). Not a defect — storing `false` while the fetch is in flight is strictly safer than the prior behavior of storing stale `true`. Gap is bounded to one network round trip.

**Filed as separate Pending task (out of scope for this hold):**
- `frontend-orcid-callback-teardown-cleanup.md` — P3. Audit all setTimeout / setInterval / pending-promise call sites in `orcid-callback.js` for component-destroy cleanup. Store IDs in component state, clear in `destroy()`. Small scope but touches more than just the one site flagged.

**Path to re-archive:** (1) UI agent applies items #1-4. (2) UI agent re-review signal block. (3) Architect re-reviews round-3 with `/ce-code-review` and archives.
