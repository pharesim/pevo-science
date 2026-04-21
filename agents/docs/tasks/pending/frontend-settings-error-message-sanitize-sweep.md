# FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP — Apply generic-message pattern to remaining settings catch blocks

**Owner:** ui
**Created:** 2026-04-21 (surfaced by FE-UPGRADE-CREDENTIAL-WIPE round-2 review 2026-04-21)
**Priority:** P3

## Context

FE-UPGRADE-CREDENTIAL-WIPE (commit `fd116e4`) hardened `executeUpgrade()`'s catch so raw `err.message` no longer reaches the DOM — instead, a generic localized message is shown and the raw error goes to `console.warn` for diagnostics. The round-2 re-review (architect hold) extends this to `startUpgrade()`'s catch for pattern consistency.

Four other catch blocks in `frontend/src/pages/settings.js` still bind `err.message` to DOM-visible error fields:

- `handleSetPassword` — `passwordError = err.message`
- `handleEmailSubmit` — `emailError = err.message`
- `handleEmailDelete` — `emailError = err.message`
- `handleOrcidLink` — `orcidError = err.message`

Each is x-text'd into the DOM. These paths don't currently handle key material, so the immediate risk is low, but:
- The invariant "no raw `err.message` in user-visible text" is broken across the file if we harden only the upgrade path.
- Future expansion of any of these handlers could introduce key material or other sensitive data without a visible red flag.
- Pattern consistency reduces cognitive load for future authors.

## Goal

Audit the 4 catch blocks above plus any other `this.<field>Error = err.message` patterns across `frontend/src/` (grep -r `= err.message` in the frontend). Apply the same pattern to each:

```js
} catch (err) {
  console.warn('[<handler-name>]', err);
  this.<field>Error = this.$t('<handler>.<errorKey>');
}
```

Add i18n keys for each handler's generic error message (e.g. `settings.passwordUpdateFailed`, `settings.emailUpdateFailed`, `settings.emailDeleteFailed`, `settings.orcidLinkFailed`). Stub across 15 locales with English placeholders pending translation (existing convention, separate `docs-locale-stub-convention.md` follow-up).

Add one test per handler asserting the generic message is shown and the raw error reaches `console.warn`.

## Non-goals

Changing the underlying error semantics or adding new error codes. This is a sanitization-consistency pass.

Hardening error bindings outside `frontend/src/pages/settings.js` unless the grep surfaces them. Filed separately if so.

## Acceptance

- All 4 named catch blocks use the generic-message + console.warn pattern.
- i18n keys exist in `en.json` + stubbed across 15 locales.
- One test per handler asserts no raw error message reaches the DOM-bound field.
- Full frontend unit suite passes.

## [TODO Architect]

None — self-contained consistency pass. Architect reviews at archive.

## Architect re-review (2026-04-21) — HELD PENDING FIXES:

Code-reviewed via `/ce-code-review` on commit `c42c34a`. The four target handlers are sanitized correctly: no raw `err.message` reaches the DOM-bound `passwordError`/`emailError`/`orcidError` fields, `x-text` binding is textContent (no XSS surface), `console.warn` is local-only (no telemetry sink exists in this app), password plaintext inputs are zeroed before the warn fires, and the backend does not echo password material in any error branch. The following items block archive:

1. **Create `frontend/public/messages/STUBS.md` and register all pending stub entries.** The UI-agent CLAUDE.md § Internationalization (line 53+) mandates stub tracking for stubs added from 2026-04-21 onward. This commit is dated 2026-04-21 and adds 4 keys × 15 non-English locales = 60 stubs with no STUBS.md registration. Resolving this should also close `agents/docs/tasks/pending/ui-locale-stubs-md-seed.md` (seed with the earlier `upgrade.failed` stubs from commit `fd116e4` plus the 4 new keys from this commit, for a total of ~75 pending entries). Archive blocked on STUBS.md existing with the full pending list.

2. **Sanitize the 5th catch: `startUpgrade()` at `frontend/src/pages/settings.js:557`.** Currently `this.upgradeError = err.message || this.$t('upgrade.generationFailed')`. `upgradeError` is x-text'd into the DOM at line 38. Apply the same pattern the other 4 catches now use: `console.warn('[seed generation]', err); this.upgradeError = this.$t('upgrade.generationFailed');`. Add one unit test matching the shape of the other 5 sanitize tests (raw err to console.warn, generic i18n key to DOM, deadbeef canary assertion). The commit message claimed "4 remaining catches" but missed this one inside the same file — same threat class, same file. (adversarial/security/testing agreement, 0.95 confidence.)

3. **Move `console.warn` inside the `else` branch in `handleEmailSubmit` at `frontend/src/pages/settings.js:476-481`.** Current code warn-logs every DUPLICATE attempt (benign user UX), which contradicts the comment at line 473 that says "All *other* failures take the … console.warn … path". Target shape:
   ```js
   if (err.code === 'DUPLICATE') {
     this.emailError = this.$t('settings.emailAlreadyInUse');
   } else {
     console.warn('[email submit]', err);
     this.emailError = this.$t('settings.emailUpdateFailed');
   }
   ```

4. **Add `warnSpy` negative assertion to the DUPLICATE test at `frontend/tests/unit/pages-settings.test.js:172`.** Once warn is moved inside `else` (item 3), assert `expect(warnSpy).not.toHaveBeenCalled()` on the DUPLICATE path. Locks in the DUPLICATE-exempt invariant so a future refactor can't silently reintroduce the noise.

5. **Add `vi.restoreAllMocks()` to `afterEach` in `frontend/tests/unit/pages-settings.test.js`.** Current per-test `warnSpy.mockRestore()` leaks console.warn suppression if any assertion throws before reaching the restore call. File-local hygiene fix; broader `restoreMocks: true` vitest policy is a separate decision.

6. **Add `expect(warnSpy).toHaveBeenCalled()` guard in the "rejects invalid redirect URL" test at `frontend/tests/unit/pages-settings.test.js:278-279`** before reading `warnSpy.mock.calls[0][1]`. Matches the guard used by all 5 sibling sanitize tests. Without it, a regression currently throws `TypeError` instead of a clear assertion failure.

Deferred / dismissed during triage (no action required on this task):
- `err.data` compositional risk — architect is invoking `/ce-compound` to capture the full sanitization contract (all untrusted error fields, why `console.warn` is safe, DOM-surface generic-i18n rule) as a `docs/solutions/` entry. Inline comments in this file can stay terse and point at the doc once it exists.
- Brittle `// Sanitization pattern (see handleOrcidLink).` cross-reference comments at `settings.js:511, 535` — the rest-of-frontend sweep task will replace with a pointer to the solutions doc once it lands.
