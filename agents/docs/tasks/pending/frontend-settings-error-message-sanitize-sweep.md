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
