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
