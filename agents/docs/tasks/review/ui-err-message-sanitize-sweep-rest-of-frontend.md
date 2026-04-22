# FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND — Apply generic-message + console.warn pattern to the remaining 21 `err.message` DOM bindings

**Owner:** ui
**Created:** 2026-04-22 (surfaced by FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP grep pass 2026-04-21)
**Priority:** P3

## Context

FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP (commit `c42c34a`, merged 2026-04-21) hardened the 4 remaining catch blocks in `frontend/src/pages/settings.js`. The task's grep sweep (`= err.message` across `frontend/src/`) surfaced **21 additional sites across 15 files** that still bind raw error messages to DOM-visible fields. Per that task's non-goals rule, they were deliberately not fixed in the settings pass and filed for follow-up here.

Prior art (pattern to apply):

```js
} catch (err) {
  console.warn('[<handler-name>]', err);
  this.<field>Error = this.$t('<handler>.<errorKey>');
}
```

See `executeUpgrade()` (commit `fd116e4`) and the 4 settings handlers hardened in `c42c34a` for worked examples.

## Why this matters

- The invariant "no raw `err.message` in user-visible text" is only partially enforced today. Key material, token shapes, internal error text, and PII can reach the DOM on unrelated code paths if those catch blocks ever handle sensitive data.
- Pattern consistency reduces cognitive load — a reviewer spotting `= err.message` in a PR should treat it as a red flag; today they can't, because it's the status quo in 15 files.
- Future expansion of any of these handlers could introduce sensitive data without a visible warning.

## In-scope files (21 sites across 15 files)

Per the grep surfaced by the settings sweep. Re-run the grep to confirm line numbers before starting:

```
frontend/src/components/sign-in-modal.js
frontend/src/components/comment-composer.js
frontend/src/components/vouch-section.js
frontend/src/pages/accreditation-verify.js
frontend/src/pages/signup-verify.js
frontend/src/pages/settings-verify-email.js
frontend/src/pages/bridge.js
frontend/src/pages/reset-password.js
frontend/src/pages/login.js
frontend/src/pages/signup.js
frontend/src/pages/accreditation.js
frontend/src/pages/recover.js
frontend/src/pages/publish.js
frontend/src/pages/orcid-callback.js
frontend/src/pages/review.js
frontend/src/pages/edit.js
```

(16 files — the settings sweep's summary counted `settings.js` in its "touched" list before carve-out; the grep surfaced 15 external files + 1 already-fixed. Treat the list above as authoritative and re-grep to reconcile.)

## Goal

For each site:

1. Replace `this.<field>Error = err.message` with the sanitization pattern.
2. Add an i18n key for the handler's generic error, namespaced under the page/component (e.g. `publish.broadcastFailed`, `login.loginFailed`).
3. Stub the key across 15 locales with English placeholders per the existing `docs-locale-stub-convention.md` convention.
4. Add one unit test per handler asserting (a) the generic key is bound to the DOM field and (b) the raw error reaches `console.warn`.

**Semantic-code carve-out:** where a catch branch checks `err.code === 'SOME_CODE'` and renders a code-specific message before falling through to `err.message`, keep the code branch as-is and only sanitize the fallback. Pattern matches the `DUPLICATE` carve-out in `handleEmailSubmit`.

## Non-goals

- Changing error semantics or introducing new error codes.
- Refactoring handlers beyond the catch block.
- Shared-helper extraction. Each call site is 3 lines; inline keeps the diff readable and matches the prior convention.
- Fan-out to parallel worktrees — too many of these files are shared across pages and co-edited, so serial execution avoids merge noise. If it becomes clear a subset is genuinely disjoint, fan out that subset.

## Acceptance

- All 21 sites use the generic-message + `console.warn` pattern.
- i18n keys exist in `en.json` + stubbed across 15 locales.
- One test per handler asserts no raw error message reaches the DOM-bound field.
- Full frontend unit suite passes; `npm run build` clean.
- `grep -rn '= err\.message' frontend/src/` returns zero matches (or only matches that are clearly not DOM bindings — comment them explicitly).

## [TODO Architect]

Consider whether the "no raw `err.message` in DOM" invariant belongs in `agents/docs/ARCHITECTURE.md` (or a small `docs/solutions/conventions/` entry) once this sweep lands, so a future grep has a linked rationale.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commits `56fb4f1` + `9e8ca0f` + `0a20f61` + merge `b474a4d` (8 personas: correctness, testing, maintainability, project-standards, security, julik-frontend-races, ce-agent-native, ce-learnings-researcher). Sweep's core invariant shape is **strong** across all 21 tested sites: exact `toBe(leaky)` object identity on the raw error + `'deadbeef'` sentinel check on the DOM-bound field + i18n key match. 15-locale stub coverage complete via `STUBS.md`. But the review surfaced 5 hold items — two serious enough to block archive.

**TODO Architect answered.** The canonical convention already lives at `agents/docs/solutions/conventions/frontend-error-sanitization-2026-04-21.md`. Rather than duplicate in `ARCHITECTURE.md`, cross-link from the UI agent's CLAUDE.md Internationalization / Error Handling sections at a future point. No action in this hold — the convention doc is sufficient as the grep-linked rationale.

Hold-block items below:

1. **P2 — Acceptance-criterion violation + carve-out misapplied on login.js PENDING_UNVERIFIED + SIGNUP_EXPIRED** (project-standards PS-001 0.85 + security SEC-SANITIZE-01 0.95 + julik JFR-005 0.72 + maintainability MAINT-01 0.75 — 4-reviewer convergence). `grep -rn '= err\.message' frontend/src/` returns two matches at `frontend/src/pages/login.js:173` and `:178` — violates the task's acceptance criterion ("zero matches OR only matches that are clearly not DOM bindings — comment them explicitly"). Block-level comment at line 157 explains intent but doesn't satisfy per-line requirement. Additionally: the task's semantic-code carve-out is for branches that render code-specific **localized** messages (like the DUPLICATE case in `handleEmailSubmit` which returns `this.$t('signup.duplicate')`). The PENDING_UNVERIFIED + SIGNUP_EXPIRED branches preserve **raw server text**, which is not what the carve-out allows. The sibling `UNAUTHORIZED` branch in the same catch already uses `$t()`, so the diff is internally inconsistent. Fix: apply the standard 3-line pattern to both branches — `console.warn('[login submit pending]', err); this.error = this.$t('login.pendingUnverified');` and `console.warn('[login submit expired]', err); this.error = this.$t('login.signupExpired');`. Add 2 new i18n keys to `en.json`, stub across 14 non-English locales, append entries to `STUBS.md`. Update the block comment at line 157 to drop the "semantic-code carve-out preserved" language. Add 2 test-site additions to `pages-login.test.js` matching the existing invariant shape (i18n key bound + raw err reaches console.warn + sanitization asserts no server text in DOM).

2. **P2 — `console.warn` fires BEFORE semantic-code branch checks in signup.js + orcid-callback.js** (correctness COR-001 0.95). The existing convention doc `agents/docs/solutions/conventions/frontend-error-sanitization-2026-04-21.md` carries a sub-rule: "`console.warn` fires only in the unexpected `else` branch, not before the `if`. Emitting a warn on every routine `DUPLICATE` submission is log noise." `frontend/src/pages/signup.js:302` places `console.warn('[signup submit]', err)` BEFORE the DUPLICATE + VALIDATION_ERROR branch checks — every expected DUPLICATE attempt emits a spurious warn. Same pattern in `frontend/src/pages/orcid-callback.js:131` (warn before VALIDATION_ERROR). The correct model is `frontend/src/pages/settings.js handleEmailSubmit`, which places the warn inside the final `else` branch only. Fix: restructure both catch blocks so `console.warn` appears only on the generic-fallback path, not on semantic-code branches. Practical reshaping: hoist the error-code dispatch BEFORE the warn, with warn inside the `else` fall-through. Preserves all existing semantic-code-branch behavior; removes the log noise.

3. **P2 — signup.js handleOrcidSignup sanitized but untested** (correctness COR-002 0.90 + testing T-1 0.97). Commit `9e8ca0f` sanitized both `handleOrcidVerify` AND `handleOrcidSignup` in `frontend/src/pages/signup.js`. Commit `0a20f61` added a test for `handleOrcidVerify` only. `handleOrcidSignup` has its own independent catch block. If it reverts to `this.error = err.message`, no test catches the regression. Part of the 29-vs-21 count discrepancy reviewers flagged. Fix: add a `describe('handleOrcidSignup')` block to `pages-signup.test.js` mirroring the `handleOrcidVerify` test shape (stub `mockStartOrcid.mockRejectedValue(leaky)`, call `comp.handleOrcidSignup()`, assert `comp.error === 'signup.orcidStartFailed'`, assert `comp.error` doesn't contain the sentinel, assert `warnSpy.mock.calls[0][1] === leaky`).

4. **P3 — 8 test files lack `afterEach(vi.restoreAllMocks())` safety net** (testing T-2 0.82). `pages-review.test.js`, `pages-accreditation-verify.test.js`, `pages-edit.test.js`, `components-vouch-section.test.js`, `pages-bridge.test.js`, `pages-publish.test.js`, `pages-accreditation.test.js`, `components-comment-composer.test.js` — each uses inline `warnSpy.mockRestore()` at test-body end with no afterEach safety net. If an assertion throws before the restore, the spy leaks. Subsequent tests calling `vi.clearAllMocks()` in beforeEach clear call history but don't restore console.warn — suppressed-warn behavior silently leaks. `pages-settings.test.js` has `vi.restoreAllMocks()` in `afterEach` (the correct pattern). Fix: add `restoreMocks: true` to `frontend/vitest.config.js` for global coverage (one-line change — the globally-scoped fix is less work than retrofitting 8 files individually). Rerun the full suite after to confirm no tests relied on spy-leak behavior.

5. **P3 — `console.warn` prefix naming convention split** (maintainability MAINT-02 0.70). 7 of the 29 sites use hyphenated file-name tags (`[reset-password request]`, `[signup-verify create account]`, `[sign-in email login]`) while the other 22 use space-separated concept names (`[login submit]`, `[publish broadcast]`). Two conventions coexist undocumented. DevTools filtering and grep are inconsistent. Fix: normalize to majority space-separated form (`[reset password request]`, `[signup verify create account]`, `[sign in email login]`). 7 comment-level edits across 3 files. Add a one-liner at the top of `frontend-error-sanitization-2026-04-21.md` naming the convention: "`console.warn('[<page> <handler concept>]', err)` — space-separated words, no filename-hyphens."

**Dismissed from round-1 findings (architect triage):**
- **P3** `handleOrcidVerify` vs `handleOrcidSignup` use different warn tags but share one i18n key (maintainability MAINT-03 info 0.85): harmless today; fix naturally when the handlers diverge.
- **P3** login.js semantic-code carve-outs bypass i18n pre-existing (correctness COR-005 info 0.80): subsumed by hold item #1 (the fix puts both branches on i18n keys).

**Filed as separate Pending tasks (out of scope for this hold):**
- `ui-async-continuation-teardown-guard-sweep.md` (P2) — 8 broadcast-heavy files (publish/edit/review/accreditation/bridge/comment-composer/vouch-section/accreditation-verify) + paper-feed.js + search.js = 10 files with unguarded async catch continuations. Uses existing `createTimerGuard()` helper. Bundles the same class of finding from REV-2.
- `ui-err-message-sanitize-toast-and-handleconnect-sites.md` (P3) — 8 sites (vote-buttons, handleConnect copies across header/publish/review/accreditation/bridge, contact.js, accreditation.js:287) maintaining the raw `err.message` pattern the sweep eliminates in DOM fields but allows in toast and handleConnect copy-paste sites. Extends the invariant to the missed rendering paths.
- `architect-stubs-md-sweep-headers.md` (P3) — retroactively segment `STUBS.md` into date-scoped sections so translators can prioritize and stale entries become detectable. Architect-owned housekeeping.

**Past solutions relevant (ce-learnings-researcher):**
- `conventions/frontend-error-sanitization-2026-04-21.md` — the canonical convention this sweep implements. Contains the ordering rule behind hold item #2, plus sub-rules about `err.message` + `err.data` + template-interpolation all needing sanitization (acceptance grep catches only the literal assignment).
- `conventions/object-shape-fix-every-reset-site-2026-04-21.md` — the sweep meta-pattern. Hold item #1 is an instance of "fix missed two sites in the manifestation-closer locale."
- The task spec references a non-existent `docs-locale-stub-convention.md`. The actual convention is in `agents/ui/CLAUDE.md` Internationalization. Low-signal noise; no action — future task specs should reference the UI CLAUDE.md directly.

**Path to re-archive:** (1) UI applies items #1-5 on this task. (2) UI re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review` and archives on clean. Filed follow-up tasks archive independently.

---

**UI re-review signal (2026-04-22, merge commit `494038d`, worktree `worktree-agent-a185be24` → main):**

All 5 hold items landed. Full frontend unit suite 869/869 pass post-merge; `npm run build` clean.

1. **P2 login.js carve-out misuse (item #1)** — PENDING_UNVERIFIED + SIGNUP_EXPIRED branches now use the standard 3-line sanitize pattern with `console.warn('[login submit pending]', err)` / `[login submit expired]` and i18n keys `login.pendingUnverified` / `login.signupExpired`. Block comment at `login.js:157` reworded to drop "semantic-code carve-out preserved" language. **Deviation flagged:** `login.pendingUnverified` already existed in `en.json` + all 15 locales with real native-language translations; only `login.signupExpired` is truly new. Adding `pendingUnverified` to STUBS.md would have demoted real translations to stubs, which is wrong. Net: 1 new en key + 14 locale stubs + 14 `STUBS.md` entries (not 28 as the hold item specified). 2 test-site additions to `pages-login.test.js` match the full invariant shape.

2. **P2 warn ordering (item #2)** — `signup.js:302` and `orcid-callback.js:120` restructured so `console.warn` fires only on the generic-fallback `else` branch, not before the semantic-code branch checks. Mirrors `settings.js handleEmailSubmit`. All existing semantic-code-branch behavior preserved.

3. **P2 handleOrcidSignup test gap (item #3)** — added `describe('handleOrcidSignup')` block to `pages-signup.test.js` with the full invariant shape: i18n key `signup.orcidStartFailed` bound, sentinel absent, raw err reaches `warnSpy.mock.calls[0][1]`, `localStorage.removeItem('pevo_orcid_mode')` called on failure.

4. **P3 restoreMocks (item #4)** — `vitest.config.js` gains `restoreMocks: true` globally. Full suite 869/869 pass afterward — no tests depended on spy-leak behavior.

5. **P3 prefix normalization (item #5)** — 7 hyphenated warn prefixes normalized to space-separated across `reset-password.js` (2), `sign-in-modal.js` (2), `signup-verify.js` (3). One-liner convention added to the top of `agents/docs/solutions/conventions/frontend-error-sanitization-2026-04-21.md`.

Commit: `5bbd357 ui: apply architect hold fixes on err-message-sanitize-sweep (5 items)`, merged to main via `494038d`.
