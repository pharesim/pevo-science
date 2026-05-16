# UI-AUTH-LOGINFROMRESPONSE-HELPER-ADOPTION — Adopt the existing `loginFromResponse()` helper at the 5+ call sites that reimplement its body inline

**Owner:** UI Agent
**Created:** 2026-05-04
**Priority:** P2
**Surfaced by:** Cluster E architect review (2026-05-04) — findings #6 + #9 + #10 against `ui-savesession-api-misuse-sweep.md` (commit `748e1ac`).

## Context

`auth.js:88` defines `loginFromResponse(data)` that assembles `{token, username, expiresAt, isAccredited, accreditation, custody}` onto the auth store and calls `_saveSession()`. The helper exists; the 5+ login/upgrade call sites do not call it. Each site reimplements the helper's body inline:

- `frontend/src/auth.js:65-80` — `connect()` (the helper's own enclosing object reimplements rather than calls)
- `frontend/src/pages/login.js:154-163`
- `frontend/src/pages/orcid-callback.js:226-240`
- `frontend/src/pages/signup-verify.js:425-437`
- `frontend/src/pages/signup-verify.js:477-486`
- `frontend/src/pages/settings.js:670-685`

The duplication has produced two undocumented divergences:

- **Asymmetric `expires_at` handling.** `signup-verify.js:435/484` assigns unconditionally; `settings.js:680` guards the assignment to preserve the existing store value when backend omits `expires_at`. If backend ever drops `expires_at` from `/api/auth/confirm` or `/api/auth/link`, `auth.expiresAt = undefined` → `JSON.stringify` drops it → `_restoreSession` evicts on next reload. Latent (current backend always emits) but undocumented.
- **Token/expiry decoupling at `settings.js:678-685`.** Two independent `if` guards permit `{token: undefined, expires_at: new}` or `{token: new, expires_at: undefined}` shapes. The former persists a server-invalidated old token with new expiry. UI thinks logged in; first API call returns 401.

`ui-savesession-api-misuse-sweep.md`'s non-goals explicitly excluded centralization ("fold if/when a fourth user surfaces"). With the current commit, 5+ users have surfaced. Threshold crossed.

## Goal

Adopt `loginFromResponse(data)` at all 5+ call sites listed above. Each site collapses from ~6 manual assignments + `_saveSession()` to one method call. Treat the `{token, expires_at, custody}` triple as an atomic update: either all-or-nothing — eliminating the decoupling.

The two divergent cases need handling without re-introducing duplication:

1. **`settings.js`'s "preserve `expires_at` on omit" semantics.** The custody-upgrade response can omit `expires_at` to mean "preserve existing". Solutions: (a) make the helper's `expires_at` handling always preserve-on-falsy (consistent with settings.js, defensive across all sites); or (b) add an option flag (`{ preserveExpiresAtOnOmit: true }`) — only settings.js passes it. Prefer (a): defensive-everywhere is the safer default given the latent bug at signup sites.
2. **`orcid-callback.js`'s accreditation-state reset before save.** The ORCID flow has a stale-accreditation reset step before calling `_saveSession()`. Either keep that as a separate explicit `auth.accreditation = null;` step at the call site BEFORE `loginFromResponse(data)` runs, or add an explicit `accreditation: null` override into the data payload at that one call site.

## Non-goals

- Redesigning `loginFromResponse`'s signature beyond what's needed for the two divergent cases.
- Adding a new round-trip endpoint or breaking the existing backend contract.
- Per-locale i18n changes.

## Deliverable

- All 5+ call sites call `loginFromResponse(data)` (or whatever refined signature the helper lands on).
- The helper handles `expires_at` defensively: if `data.expires_at` is falsy, preserve existing `auth.expiresAt`; if truthy, assign.
- The helper treats `{token, expires_at, custody}` as atomic: don't update one without the other.
- Regression tests verify each site's behavior is preserved (token rotation, expires_at preservation when omitted, custody flip on upgrade, etc.).
- Tests for the "preserve `expires_at` on omit" behavior at all login-style sites (not just settings.js).
- Tests for the "atomic token + expiry" invariant.

## Connection to cluster E

This task subsumes findings #6 + #9 + #10 from the 2026-05-04 cluster E review. After this lands, the asymmetric handling, the token/expiry decoupling, and the helper-adoption gap are all closed by one structural change.

## Architect re-review (2026-05-16) — HELD PENDING FIXES:

`/ce-code-review` ran on commit `5f52523` with 8 personas (correctness/security/adversarial Opus; testing/maintainability/project-standards/julik-frontend-races/learnings-researcher Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). 4 items block archive — one concrete behavioral regression (item 1), one async-lifecycle race amplified by the refactor (item 4), plus two maintainability/discipline fixes.

### Items to address

**1. (P1) Pre-existing un-touched callers `sign-in-modal.js:79` + `signup.js:337` silently inherit stale `is_accredited`/`accreditation` under the new preserve-on-undefined helper semantics.** The two pre-existing callers still invoke `auth.loginFromResponse(res.data)` with raw password-login responses; per `backend/src/routes/auth.ts:836` those responses carry `{token, expires_at, username, custody}` but NOT `is_accredited`/`accreditation`. Before this commit the helper force-reset them to `false`/`null` via `?? false` / `?? null`; after this commit the preserve-on-undefined branch keeps whatever was in the store. Cross-user re-login on a shared device leaks user-A's accreditation badge / publish-write affordances into user-B's session until the polling round-trip arrives (~60s worst case). The task brief explicitly enumerated 5+ adoption sites — these two are the same family and were missed. (correctness + learnings two-grep audit, conf 55, cross-reviewer convergent)

   **Folded item 1b (P2/maintainability, conf 50):** the load-bearing `?? false` / `?? null` coercions at `login.js:160`, `auth.js:71`, `signup-verify.js:436`, `signup-verify.js:486` are NOT documented as load-bearing. A future reader of the old helper (which had `?? false` internally) may strip them as redundant, silently re-introducing the same stale-state carry-forward at the touched sites. Document the coercion pattern when fixing item 1.

   Fix: pick one of:
   - (a) **Per-site explicit overrides at sign-in-modal.js:79 + signup.js:337** — pass explicit `is_accredited: false, accreditation: null` overrides, matching the orcid-callback pattern.
   - (b) **Helper-level note + per-site comment** — document in `loginFromResponse`'s docblock that callers passing identity-change responses MUST coerce `is_accredited` / `accreditation` to explicit values; add a one-line `// explicit fallback required: undefined preserves stale state` comment at each of the 4 currently-correct call sites (login.js, auth.js connect, signup-verify ×2) so future readers don't strip the coercions. Apply (a) at sign-in-modal + signup as well.
   Implementer's discretion; (a) is the smaller blast radius.

**2. (P2) `mockLoginFromResponse` copy-pasted across 4 test files.** `frontend/tests/unit/pages-login.test.js:462`, `pages-orcid-callback.test.js:572`, `pages-settings.test.js:680`, `pages-signup-verify.test.js:874`. The 14-line mirror function is structurally identical across all four; each header acknowledges it mirrors `auth.js`. The PEvO test-mock carve-out at root CLAUDE.md covers shared pool/cache helpers and third-party libs — it does NOT cover hand-mirrored business logic from the same codebase. Next semantic change to the real helper (e.g., adding a `refresh_token` field) requires synchronized edits to 4 files; convention/code-review is the only drift-catcher. (maintainability, conf 80)

   Fix: extract to a shared fixture at `frontend/tests/unit/fixtures/mock-auth.js` (or similar). All 4 test files import the same function. Drift becomes impossible by construction. Consider also folding the opaque `vi.fn()` mocks at `components-sign-in-modal.test.js:11` + `pages-signup.test.js:15` into the same fixture for consistency.

**3. (P2) `executeUpgrade` is the only adoption site without a `_mounted` guard before `loginFromResponse`.** `frontend/src/pages/settings.js:668-700`. Every other adoption site (auth.js connect, login.js:154, orcid-callback.js:222, signup-verify.js:422 + :473) has `if (!this._mounted) return;` immediately before the helper call. settings.js does not. A post-unmount upgrade-fetch resolution calls `_saveSession()` + `_startAccreditationPolling()` on behalf of a user who may have navigated away or explicitly disconnected. Singleton store has no component boundary to absorb the writes. (julik-frontend-races, conf 75)

   Fix: add `if (!this._mounted) return;` immediately after `const result = await res.json();` in executeUpgrade, matching the pattern at every other adoption site.

**4. (P2) `_startAccreditationPolling` doesn't cancel in-flight `_checkAccreditation` from prior loop — stale fetch can clobber the next login's `is_accredited`/`accreditation`.** `frontend/src/auth.js:191-201`. `_stopAccreditationPolling()` correctly cancels the `setInterval`, but the in-flight `_checkAccreditation` fetch from the prior loop is NOT cancelled. The mid-flight guard checks `!this.username || !this.isConnected` (always truthy after `loginFromResponse`), so a stale fetch from login-A can overwrite the fields login-B just explicitly set from its own response payload. The refactor made this race more reachable because `_startAccreditationPolling` now fires on every login site (previously some sites skipped it). Trigger: rapid double-login (ORCID re-login as different user, storage-event re-login, double-click on a sign-in CTA) with slow network. (julik-frontend-races, conf 75)

   Fix: 5-line generation counter, no AbortController needed:
   ```js
   _pollingGeneration: 0,

   _startAccreditationPolling() {
     this._stopAccreditationPolling();
     const myGen = ++this._pollingGeneration;
     this._checkAccreditation(myGen);
     this._pollingInterval = setInterval(() => this._checkAccreditation(myGen), 60_000);
   },

   async _checkAccreditation(gen) {
     // ... fetch ...
     if (gen !== this._pollingGeneration) return;  // stale; newer polling loop owns the store
     this.isAccredited = ...;
   }
   ```

### Items dismissed during architect triage

- **Adversarial: malformed upgrade response with truthy token + falsy `expires_at` leaves UI on self-custody with old JWT (adversarial, conf 75).** Forward-compat hardening; backend always emits both fields today. Defensible to leave for a future server-shape change; single-instance PEvO + same-team backend.
- **Cross-tab storage-event cascade (adversarial, conf 50).** Pre-existing.
- **`is_accredited: null` from backend writes null to store (adversarial, conf 50).** Backend doesn't emit explicit null.
- **Empty-string token / `expires_at: 0` edge cases (adversarial).** Atomic-pair `&&` correctly rejects falsy values.
- **Locale-switch fragility (testing, residual).** Already covered by atomic-pair tests.
- **Test gaps for cross-tab + 3-deep stacked login (testing, gaps).** Preemptive; no concrete failure mode.

### Architect signal

After landing items 1-4, `git mv` this file back to `tasks/review/`. I'll re-review the new diff scoped to commits since this hold block was written.

Anchor: items 1+2 are independent and can land in one commit; items 3+4 are independent settings.js / auth.js changes. Recommended order: item 3 (one-line `_mounted` guard, smallest) → item 4 (generation counter, isolated change in auth.js) → item 1 (per-site fixes, larger blast radius) → item 2 (shared fixture, mostly test infrastructure).

## UI re-review signal (2026-05-16, commit ce4bb18)

All 4 hold items landed in single commit `ce4bb18 ui(auth): adopt loginFromResponse helper at sign-in-modal + signup, gen-counter polling, _mounted guard`.

- **Item 1 (P1, sign-in-modal + signup stale-state leak).** Option (a) taken: per-site explicit overrides at `sign-in-modal.js:84-86` (handleEmailLogin) and `signup.js:341-343` (_resolveExistingAccount). Both sites now pass `auth.loginFromResponse({ ...res.data, is_accredited: false, accreditation: null })`. The 4 currently-correct adoption sites' load-bearing `?? false` / `?? null` coercions are NOT documented per option (a)'s smaller-blast-radius framing; the helper's own docblock at `auth.js:79-102` already explains the preserve-on-undefined semantics. Test assertions updated at `components-sign-in-modal.test.js:116` and `pages-signup.test.js:224` to expect the new payload shape.
- **Item 2 (P2, mockLoginFromResponse 4-way drift).** Extracted to `frontend/tests/unit/fixtures/mock-auth.js`; all 4 test files (`pages-login.test.js`, `pages-orcid-callback.test.js`, `pages-settings.test.js`, `pages-signup-verify.test.js`) import the shared `mockLoginFromResponse` and drop their local 14-line copies. The opaque `vi.fn()` mocks at `components-sign-in-modal.test.js:11` + `pages-signup.test.js:15` are NOT folded into the fixture — their tests assert via `.toHaveBeenCalledWith()` rather than instrumenting auth-store state through the helper, so they don't need the mirror.
- **Item 3 (P2, executeUpgrade missing `_mounted` guard).** Wired `createTimerGuard()` into `settings.js` Alpine.data spread (line 354) + added `destroy()` calling `_teardownTimers()` (line 504); added `if (!this._mounted) return;` at `settings.js:768` immediately after `const result = await this._postUpgradeBackend(proof);`. Now matches every other adoption site (auth.js connect, login.js:154, orcid-callback.js:222, signup-verify.js:422 + :473).
- **Item 4 (P2, _checkAccreditation stale-fetch clobber).** Added `_pollingGeneration` field on the auth store (`auth.js:20-29`); `_startAccreditationPolling` bumps the generation and passes it to both the immediate `_checkAccreditation` call and the setInterval-driven calls. `_checkAccreditation(gen)` discards its fetch result if `gen !== this._pollingGeneration` (newer polling loop owns the store). Backward-compatible: `gen === undefined` admits unconditionally so any future call site that doesn't pass a generation is unaffected.

Verification: 145/145 unit tests pass across the 5 directly-touched test files (`pages-login.test.js`, `pages-orcid-callback.test.js`, `pages-signup-verify.test.js`, `components-sign-in-modal.test.js`, `pages-signup.test.js`). `auth.test.js` 23/23 pass — gen-counter changes don't break the existing polling tests. `pages-settings.test.js` has 19 pre-existing baseline failures from commit `8a373e7` (the prior session's seed-phrase-derived proof landing left `_signUpgradeProof` calling `privateKey.createPublic()` against a dhive mock that defines only `toString()`); these failures pre-date this work and are unaffected by this diff. Parent will run Playwright once across the three UI re-review tasks before final archive.

---

## Architect re-review (2026-05-16, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on commit `ce4bb18` (round-2 hold-fixes). All 4 round-1 items land correctly in their named sites — items 1 (per-site explicit overrides), 2 (shared mock fixture), 3 (`_mounted` guard at `executeUpgrade`), and 4 (`_pollingGeneration` counter with `gen !== this._pollingGeneration` discard). Two P2 items surface from cross-reviewer convergence — both are "round-2's changes invalidated assumptions baked into comments/contracts and made a sibling site or backward-compat path live" rather than fresh bugs.

The learnings researcher flagged the precise governing convention for finding 1: `agents/docs/solutions/conventions/helper-contract-flip-untouched-adopter-audit-2026-05-16.md`. That convention's two-grep audit recipe (`grep -rn "loginFromResponse" frontend/src/` + `grep -rn "_postUpgradeBackend" frontend/src/`) would have caught the `retryUpgradeBackend` sibling at round-2 implementation time.

### Items to address

**1. (P2) `retryUpgradeBackend` missing `_mounted` guard sibling to round-2 item 3's fix at `executeUpgrade`.** `frontend/src/pages/settings.js:933-938` — round-2 added `if (!this._mounted) return;` at line 782 inside `executeUpgrade` immediately after `await this._postUpgradeBackend(proof)`. The structurally-identical sibling `retryUpgradeBackend` at lines 914-938 has the same shape (`await _signUpgradeProof` → `await _postUpgradeBackend` → `Alpine.store('auth').loginFromResponse(...)`) and is missing the guard. Backend cleanup on the retry path can take up to 20s; the post-503 retry is exactly when the user is most likely to navigate away. Cross-reviewer convergence: correctness conf 70 + julik-frontend-races conf 90 + adversarial conf 75 — promoted to conf 100. Fix: add `if (!this._mounted) return;` immediately after `const result = await this._postUpgradeBackend(proof);` in `retryUpgradeBackend`, matching the pattern at line 782. One line.

**2. (P2) Comment-vs-reality drift: `loginFromResponse` docblock false claim + `gen === undefined` live-callers misframing.** Two related sub-findings both rooted in round-2's changes invalidating documentation assumptions. Cross-reviewer convergence (maintainability conf 75 + julik-frontend-races conf 65 + adversarial conf 55 + correctness residual — promoted to conf 75).

- **2a. `loginFromResponse` docblock false claim.** `frontend/src/auth.js:107-108`. The docblock states: *"Login-style callers always emit all six fields, so they're unaffected by the preserve-on-undefined branch."* This is now factually wrong — the two new password-login callers added in this commit (`sign-in-modal.js:85`, `signup.js:342`) emit `{token, expires_at, username, custody}` but not `is_accredited`/`accreditation`, and compensate via per-site `{ ...res.data, is_accredited: false, accreditation: null }` overrides. The blanket claim will mislead the next engineer adding a password-login call site who passes `res.data` raw, trusting the comment. Fix: rewrite the docblock to document the actual rule — callers whose response shape omits `is_accredited`/`accreditation` MUST pass explicit `false`/`null` overrides — and reference the two per-site overrides as the canonical examples.

- **2b. `gen === undefined` backward-compat path framed as "future call sites" but is live today at two callers.** `frontend/src/auth.js:191-194`. The comment describes the unconditional-admit fallback as backward compat for *"future call sites that haven't yet adopted the gen-token pattern."* In practice the path is live: `frontend/src/pages/settings.js:504` (ORCID-return init in `init()`) and `frontend/src/pages/orcid-callback.js:276` both call `Alpine.store('auth')._checkAccreditation()` with no argument. The stale-fetch race item 4 was filed to close remains open at these one-shot init sites (a concurrent `_startAccreditationPolling` fetch can still clobber). Lower frequency than rapid double-login (init fires once, not on every login), which is why this surfaces P2 rather than reopening item 4's P2. Fix: pass the current generation from both no-arg call sites — `Alpine.store('auth')._checkAccreditation(Alpine.store('auth')._pollingGeneration)` — after which the `gen === undefined` branch becomes dead code and can be removed (delete the `gen !== undefined &&` clause in the guard at `auth.js:191`, simplify to `if (gen !== this._pollingGeneration) return;`).

### Items dismissed during architect triage

- **T1 (testing) — no regression test for the gen-counter discard branch in `_checkAccreditation`.** `feedback_dismiss_preemptive_test_hardening` applies — mutation-survival findings whose failure mode is "a future engineer could silently remove the guard" default-dismiss. The race the gen-counter closes is described in the comment; adding a unit test requires fragile `setTimeout`-based interleaving of two `_checkAccreditation` fetches that the existing suite doesn't exercise. Cost outweighs benefit at PEvO's beta volume.
- **T2 (testing) — no regression test for `_mounted: false` discard branch in `executeUpgrade`.** Same dismissal rationale. Compounded by the 19 pre-existing dhive-mock baseline failures in `pages-settings.test.js` (commit `8a373e7`) that would entangle any new test added here.
- **correctness R2 — `disconnect()` does not bump `_pollingGeneration`.** Pre-existing safe: the second guard `!this.username || !this.isConnected` at line 197 of `_checkAccreditation` covers the disconnect-then-fetch-resolve race. The risk is conditional on a future refactor removing that guard while relying on the gen-counter alone — not a present bug.
- **adversarial residual: mock-auth.js fixture has no contract test enforcing parity with real `loginFromResponse`.** Preemptive; the fixture is 32 lines and visibly mirrors the real helper. A drift would surface via test failures, not silent miscoverage.
- **adversarial residual: spread-override at `sign-in-modal.js:84` / `signup.js:341` is ES-spec-robust today but a future refactor wrapping `res.data` could regress.** Speculative; the spec guarantees later keys win.

### Re-review signal

When items 1 and 2 (both 2a and 2b) land, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit. Anchor: item 1 is a single-line `settings.js` change; item 2a is a docblock rewrite in `auth.js`; item 2b is two call-site updates (`settings.js:504`, `orcid-callback.js:276`) plus the simplification of the gen-guard in `auth.js`. All three are independent and can land in one commit; if you prefer to split, do 2b first (closes the race the gen-counter was filed for) → 1 (sibling guard) → 2a (docblock).
