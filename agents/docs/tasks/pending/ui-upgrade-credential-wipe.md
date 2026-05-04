# FE-UPGRADE-CREDENTIAL-WIPE

**Owner:** UI Agent
**Priority:** P1
**Created:** 2026-04-21

## Status

Landed at commit `dfece3e`. New `_clearSensitiveUpgradeState()` helper zeros `oldSeedPhrase`, `newSeedPhrase`, `newSeedWords`, `confirmInputs`, `upgradePassword`. Called on both success (before `upgradePhase = 'done'`) and error paths. `resetUpgrade()` refactored to use the same helper. Unit + E2E tests assert all 5 sensitive fields are empty post-upgrade. Sensitive-state audit: no other holders on the page need the wipe (handleSetPassword already zeroes on both paths).

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

## Architect re-review (2026-04-21d) — HELD PENDING FIXES

Review (manual-synthesis pass) surfaced two P2 findings. User triage 2026-04-21d: fix the wipe-ordering bug in place; file closure-wipe as separate defense-in-depth follow-up.

1. **P2 — `settings.js:651-658` error-path wipe-before-upgradeError ordering.** The catch block invokes `_clearSensitiveUpgradeState()` then immediately does `this.upgradeError = err.message`, which is x-text'd into the DOM. If `err.message` ever embeds key material (dhive throw, library swap, future error shape), the wiped state is effectively un-wiped via a DOM-visible error message. Fix: surface a generic localized message to the user (e.g., `t('custody_upgrade_failed')`) and `console.warn(err)` for debugging. Simpler than whitelisting known-safe error shapes. Add a test asserting `upgradeError` after an injected key-material-shaped throw does NOT contain the injected substring.

2. **P2 split to Pending: FE-UPGRADE-CLOSURE-WIPE.** Closure-captured derivatives (`oldSeed`, `oldKeys`, `newSeed`, `newKeys`, `newPubKeys`, `ownerKey`, `wifPosting`) live until GC — the wipe only covers reactive Alpine state. Defense-in-depth, no concrete exploit today, requires non-trivial refactoring. Filed as a separate P3 Pending task.

**Path to archive:** (1) UI agent applies finding #1. (2) UI agent appends a re-review signal block. (3) Architect re-reviews and archives.

## UI re-review signal (2026-04-21, commit `fd116e4`)

Finding #1 landed. Ready for architect re-review.

- `frontend/src/pages/settings.js` catch block in `executeUpgrade()` now does `console.warn('[custody upgrade]', err); this.upgradeError = this.$t('upgrade.failed')` instead of `this.upgradeError = err.message`. Raw error stays in the console for debugging; user-visible text is a generic localized message.
- New i18n key `upgrade.failed` added to `frontend/public/messages/en.json` ("Account upgrade failed. Please try again. If the problem persists, contact support."). Stubbed with the English string across the 15 other locales (`ar, cs, da, de, es, fa, fr, he, it, nl, pl, pt, sv, tr, zh`) pending translation.
- `frontend/tests/unit/pages-settings.test.js`: new test "does not leak key-material from err.message into upgradeError" injects a throw whose `err.message` contains a 64-char hex blob + 12-word BIP39-shaped seed list; asserts the generic key reaches `upgradeError` and the raw error reaches `console.warn`.
- Verified: full frontend unit suite 837/837 pass; `npm run build` clean.

## Architect re-review (2026-04-21) — HELD PENDING FIXES

Round-2 `/ce-code-review` on commit `fd116e4`. The round-1 hold (generic localized message + `console.warn` instead of raw `err.message` in `executeUpgrade()` catch) landed correctly. Round-2 surfaced one P2 sibling-catch gap (same bug in `startUpgrade`) and two P3 test-hardening items.

1. **P2 — `startUpgrade()` catch at `settings.js:542` still binds `err.message` to `upgradeError`** (correctness COR-01, 0.85). The round-1 fix hardened `executeUpgrade()`'s catch but the sibling catch in `startUpgrade()` still does `this.upgradeError = err.message || this.$t('upgrade.generationFailed')`. `upgradeError` is x-text'd into the DOM at line 38. Immediate risk is low (generateMnemonic is a pure local BIP39 call, unlikely to embed key material in its error) but the invariant round-1 established — "upgradeError never carries `err.message`" — is broken by this sibling catch. Any future expansion of `startUpgrade()`'s try block that calls into a library reintroduces the vulnerability without a visible red flag. Fix: apply the same pattern. `console.warn('[custody upgrade:generate]', err); this.upgradeError = this.$t('upgrade.generationFailed')`. Verify `upgrade.generationFailed` key exists in `en.json` (add + stub across 15 locales if missing). Add one test asserting `startUpgrade` failure does not leak `err.message` contents into `upgradeError`.

2. **P3 — `$t` stub in unit tests returns key verbatim; doesn't guard the `$t('key') || err.message` regression class** (correctness COR-02, 0.82). The stub `comp.$t = (key) => key` never returns falsy, so a future refactor changing the catch to `this.upgradeError = this.$t('upgrade.failed') || err.message` passes the current test. In production, any locale where `$t` returns `''` for a missing key would cause `upgradeError` to fall through to `err.message` (leak). Fix: change the stub to return a distinguishable non-empty marker (e.g. `comp.$t = (key) => 't:' + key`) and assert `expect(comp.upgradeError).toMatch(/^t:/)`. A regression using the OR-fallback pattern would fall through to `err.message` (which does NOT start with `t:`) and fail the new matcher.

3. **P3 — `console.warn` assertion pins `calls[0]` without filtering on `[custody upgrade]` prefix** (correctness COR-03, 0.90). `warnSpy.mock.calls[0]` grabs the FIRST warn. If any code path inside `executeUpgrade()` or its mocks emits a warn before the catch block (e.g. a mock throws a React-style warning), `calls[0]` is that earlier warn, and the `expect(warnedStr).toContain(leakHex)` assertion runs against the wrong error object. Fix: filter `warnSpy.mock.calls` by `c[0] === '[custody upgrade]'` before extracting the error object. Refactor-stable.

**Dismissed from round-2 findings:**
- **P3 4 other catch blocks (`handleSetPassword`, `handleEmailSubmit`, `handleEmailDelete`, `handleOrcidLink`) still bind err.message to DOM** (RR-01). Filed as separate Pending task (below). Lower risk than the upgrade flow (no key material in those code paths) but pattern-consistency matters.
- **P3 console.warn not stripped in production bundle** (RR-02). Correct by design — Vite config does not `drop:['console']`, and the warn is intended for production operator diagnostics.
- **P3 15 non-English locale stubs contain English placeholder** (RR-03). Accepted beta pattern per commit message. Translation follow-up is continuous, not gated on this task.

**Filed as separate Pending tasks (out of scope for this hold):**
- `frontend-settings-error-message-sanitize-sweep.md` — P3. Audit `handleSetPassword`, `handleEmailSubmit`, `handleEmailDelete`, `handleOrcidLink` (and any other `this.<field>Error = err.message` patterns across `frontend/src/`) for the same pattern; apply the generic-localized-message + console.warn fix uniformly.
- `docs-locale-stub-convention.md` — P3 tooling/convention. Neither root `CLAUDE.md` nor `agents/ui/CLAUDE.md` documents a locale-stub convention (marker format, tracking mechanism). Future contributors have no signal that English-in-non-English-locale strings need translation. Standardize.

**Path to re-archive:** (1) UI agent applies items #1-3. (2) UI agent re-review signal block. (3) Architect re-reviews round-3 with `/ce-code-review` and archives.

## Architect re-review pass (2026-04-28) — HELD PENDING FIXES (items #2 + #3 still open)

Status of round-2 hold items against current code (no `/ce-code-review` invocation — the `fd116e4..HEAD` diff is cross-task wide, 273 files / 28k lines; the round-2 hold's lens is narrow enough to verify directly):

1. **Item #1 (P2 — `startUpgrade()` catch sanitize)** — **FIXED.** Landed as collateral of commit `9e8ca0f` ("sanitize err.message DOM bindings across remaining frontend (29 sites)"), not via a task-targeted commit. `frontend/src/pages/settings.js:567-568` now does `console.warn('[custody upgrade start]', err); this.upgradeError = this.$t('upgrade.generationFailed')`. The `upgrade.generationFailed` i18n key exists in `en.json` and was stubbed across the 15 non-English locales as part of `56fb4f1`.

2. **Item #2 (P3 — `$t` stub returns key verbatim; doesn't guard `$t('key') || err.message` regression class)** — **NOT FIXED.** `frontend/tests/unit/pages-settings.test.js:105` still has `comp.$t = (key) => key;`. The leakage test at `:470` asserts `expect(comp.upgradeError).toBe('upgrade.failed')` against the verbatim-key form, which would still pass under a regressed `this.$t('upgrade.failed') || err.message` if `$t` returned empty for a missing key. The regression-class guard round-2 specified is absent.

3. **Item #3 (P3 — `warnSpy.mock.calls[0]` not filtered on `[custody upgrade]` prefix)** — **NOT FIXED.** `pages-settings.test.js:478` still does `const warnArgs = warnSpy.mock.calls[0];` with no `.find(c => c[0] === '[custody upgrade]')` filter. A future intermediate `console.warn` call inside `executeUpgrade` (or its mocks) would shift `[0]` to a different entry and the leakage assertion would target the wrong error object.

`git mv`'d back to `tasks/pending/`. Items #2 and #3 are pure test improvements (no production code change). Implementer should be able to land both in a single small commit, then `git mv` back to `tasks/review/`. At that point the architect runs round-4 with a narrowly-scoped `/ce-code-review` (e.g., `base:<commit-prior-to-fix>` on `pages-settings.test.js`) before archive per the mandate.

**Path to re-archive (refreshed):** (1) UI agent applies items #2 + #3. (2) `git mv` to `tasks/review/`. (3) Architect runs `/ce-code-review` round-4 on the test-file delta and archives.

## UI re-review signal (2026-04-28, working tree)

Items #2 and #3 landed in `frontend/tests/unit/pages-settings.test.js`. Pure test improvements; no production code changed. Ready for architect round-4.

- **Item #2 (sentinel `$t` stub):** `createComponent()` helper now stubs `comp.$t = (key) => 't:' + key` instead of returning the key verbatim. The leak-guard test at the executeUpgrade `does not leak key-material` case now asserts both `expect(comp.upgradeError).toBe('t:upgrade.failed')` AND `expect(comp.upgradeError).toMatch(/^t:/)` — the matcher is the regression-class guard. A future refactor to `$t('upgrade.failed') || err.message` that returned `''` from `$t()` for a missing key would fall through to `err.message` (which does NOT start with `t:`) and the matcher fails. The 10 sibling assertions across the suite (`emailMessage`/`emailError`/`orcidError`/`upgradeError`/`passwordError`/`upgradeWarnings`) were updated to the prefixed form.
- **Item #3 (warnSpy filter):** the leak-guard test now does `warnSpy.mock.calls.find((c) => c[0] === '[custody upgrade]')` instead of `warnSpy.mock.calls[0]`, with a `toBeDefined()` sanity check before extracting the error object. Refactor-stable against any earlier intermediate `console.warn` call inside `executeUpgrade` or its mocks.
- Verified: `npx vitest run tests/unit/pages-settings.test.js` → 41/41; full frontend unit suite 993/993; `npm run build` clean.

## Architect re-review (2026-05-04) — HELD PENDING FIXES

Round-3 `/ce-code-review` on commit `9af76fd`. The two test improvements (sentinel `$t` stub + warnSpy prefix filter) landed cleanly and items #2/#3 from the round-2 hold are addressed. But the round-3 hold's stated value for item #2 (regression-class guard against `$t('key') || err.message`) isn't fully delivered, and the sentinel form introduced a sibling-test-file divergence.

1. **P2 — `.toMatch(/^t:/)` is vacuous under the current sentinel stub** (testing + learnings, anchor 100). The round-2 hold item #2 explicitly stated: "the matcher is the regression-class guard. A future refactor to `$t('upgrade.failed') || err.message` that returned `''` from `$t()` for a missing key would fall through to `err.message` and the matcher fails." With `(key) => 't:' + key` the stub never returns falsy, so the OR-fallback never short-circuits — the matcher cannot fail under the named regression. Both `.toBe('t:upgrade.failed')` and `.toMatch(/^t:/)` pass whether code is safe or regressed via the OR-fallback pattern. The matcher only catches a *direct bypass* mutation (`upgradeError = err.message` with no `$t` call) which `.toBe` already kills. Fix: add a focused test case that temporarily stubs `$t` to return `''` for the specific key, then exercises the leak path:
   ```js
   it('does not leak key-material when $t returns empty for upgrade.failed', async () => {
     const comp = createComponent();
     comp.$t = (key) => key === 'upgrade.failed' ? '' : 't:' + key;  // simulate missing translation
     // ... inject same key-material-shaped throw as the existing leak-guard test ...
     await comp.executeUpgrade();
     // If production code uses `$t(key) || err.message`, upgradeError now contains err.message → contains the leak.
     expect(comp.upgradeError).not.toContain(leakHex);
     expect(comp.upgradeError).not.toMatch(/<bip39-shape>/);
   });
   ```
   This test actually exercises the OR-fallback path. The existing `.toMatch(/^t:/)` matcher becomes redundant once the focused test is in place — see item #2.

2. **P2 — Divergent `$t` stub form vs ~20 sibling test files in `frontend/tests/unit/`** (maintainability, anchor 75). After round-3, `pages-settings.test.js` is the lone outlier with `(key) => 't:' + key`; sibling files use `(key) => key`. Future copy-paste cross-pollination breaks assertions in either direction. With the focused empty-`$t` test from item #1 carrying the regression-class guard load, the sentinel form is no longer load-bearing. Fix: revert `pages-settings.test.js`'s `comp.$t` stub to `(key) => key` (matching siblings); revert the 12 sibling assertions from `'t:<key>'` back to `'<key>'`; delete the now-redundant `.toMatch(/^t:/)` matcher. The focused empty-`$t` test from item #1 takes over the regression-class guard role.

   Net effect: round-3 item #2's intent (catch the OR-fallback regression class) is delivered via item #1's focused test, with no convention drift in the test suite.

**Path to re-archive:** (1) UI agent applies items #1 + #2. (2) `git mv` to `tasks/review/`. (3) Architect runs round-4 `/ce-code-review` on the test-file delta and archives.
