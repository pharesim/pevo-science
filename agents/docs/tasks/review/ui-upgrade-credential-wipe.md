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
