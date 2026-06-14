---
title: "Sanitize caught errors before surfacing them to the DOM"
date: 2026-04-21
category: conventions
module: frontend/src/pages
problem_type: convention
component: frontend_stimulus
severity: medium
applies_when:
  - "Writing a `catch (err)` block in an Alpine component that binds an error field via `x-text`"
  - "Any code path that assigns a caught error (`err.message`, `err.data`, or a string built from `err`) to a component state field rendered in the DOM"
  - "Adding a new API helper whose rejections will be caught and surfaced to the user"
  - "Extending an error-code branch with field-level detail (e.g. `err.data.hint`) you want to show the user"
related_components:
  - authentication
  - documentation
tags: [frontend, security, info-disclosure, error-handling, i18n, alpine, console-warn]
---

# Sanitize caught errors before surfacing them to the DOM

**Warn-tag convention:** `console.warn('[<page> <handler concept>]', err)` — space-separated words, no filename-hyphens (e.g. `[reset password request]`, not `[reset-password request]`).

## Context

PEvO's frontend catches backend errors at handler boundaries (API rejections, Hive broadcast failures, local validation throws) and renders them to the user via `x-text` bindings on component state fields (`passwordError`, `emailError`, `orcidError`, `upgradeError`, etc.). The straightforward shape — `this.emailError = err.message || this.$t('common.connectionFailed')` — leaks whatever the error happened to embed into the DOM. Backend 5xx bodies, Postgres error text, library-internal diagnostics, and future crypto-material mentions all travel through `err.message` unless the caller sanitizes.

`x-text` itself is XSS-safe (it renders via `textContent`, not `innerHTML`), so the concern is **information disclosure**, not script injection. DOM-visible text is reachable by over-the-shoulder viewers, screenshots, screen-sharing, browser extensions, and pre-render accessibility tooling.

This convention was applied to `frontend/src/pages/settings.js` in two passes (`fd116e4` for `executeUpgrade`, `c42c34a` for four more catches). A rest-of-frontend sweep task (`frontend-err-message-sanitize-sweep-rest-of-frontend.md`) extends it to ~30 more call sites across the frontend.

## Guidance

**The shape:**

```js
} catch (err) {
  console.warn('[<handler-scope>]', err);        // raw err to devtools only
  this.<field>Error = this.$t('<domain>.<errorKey>');  // generic localized key to DOM
}
```

Raw `err` goes to `console.warn` for developer diagnostics; the DOM-bound field takes a generic localized key. One new i18n key per handler (e.g. `settings.passwordUpdateFailed`, `settings.emailUpdateFailed`) — per-handler keys, not a shared `common.updateFailed`, so copy can differentiate affordance and localizers can adjust grammar per context.

**What's untrusted on the error object:**

- `err.message` — the obvious leak.
- `err.data` — `ApiRequestError` carries a `data` field populated from the backend's error-body `data` object. Same threat class as `err.message`, less obvious.
- Any string interpolation — `` `Error: ${err.code}` `` or `` `${err.message} (${err.status})` `` assigned to a DOM-bound field is untrusted.
- `err.code` — semantic enum from the backend. **Safe to branch on** (`if (err.code === 'DUPLICATE')`), unsafe to x-text into the DOM as a raw label.

**Exemption for benign semantic codes:**

Predictable user-error branches (e.g. `DUPLICATE`, `VALIDATION_ERROR`) should drive dedicated localized keys without the generic-message fallback. The raw `err` should still reach `console.warn` only on the **unexpected** branch — emitting a warn for every routine duplicate-email submission is log noise. Keep the warn after the semantic branch, not before:

```js
} catch (err) {
  if (err.code === 'DUPLICATE') {
    this.emailError = this.$t('settings.emailAlreadyInUse');
  } else {
    console.warn('[email submit]', err);  // unexpected failures only
    this.emailError = this.$t('settings.emailUpdateFailed');
  }
}
```

**Password-handler specific:** zero plaintext inputs (`this.newPasswordInput = ''`) **before** `console.warn` fires so the password does not linger in Alpine reactive state while the error is shown, and does not appear inside the logged error object if the backend ever echoes `req.body`. (The backend currently does not, verified for `/api/settings/set-password`, but the local zero is defense-in-depth regardless.)

**Exemption — operator-facing admin console structured-error passthrough (added 2026-06-15):**

The admin console (`frontend/src/pages/admin.js` `_errorMessage`) is permitted to surface an enveloped backend `error.message` directly to its DOM-bound error fields (`actionError`, `loadError`), rather than mapping each `error.code` to a localized key. Three conditions scope the exemption:

1. **Operator-only surface.** The admin console renders only for accounts in the chain-derived admin roster; the audience is a trusted operator, not an end user. The information-disclosure threat model above (over-the-shoulder, screenshot, screen-share) is weaker for a privileged operator already authorized for the action whose error they see.
2. **The message IS the feature.** Operator moderation needs the specific backend reason ("Account is not in the admin roster", "Paper is already retracted", a bad-enum 400) to act; a generic localized "Action failed" defeats the purpose. This is the explicit requirement that produced `_errorMessage`.
3. **Backend obligation (load-bearing).** Admin-route (`/api/admin/*`) error messages MUST be static developer-authored operator copy. They must NOT interpolate end-user input, raw DB / library strings, or upstream Hive-node error text into `error.message`. The exemption rests on this; a future admin route that echoes untrusted text into its message breaks it, and that route must map to a localized key instead (or sanitize the message backend-side).

The synthetic `INTERNAL_ERROR` code that `api.js` `request()` mints for non-enveloped responses is explicitly EXCLUDED from the passthrough (`err.code !== 'INTERNAL_ERROR'`): it carries an untranslated transport string, not a backend reason, so it falls through to the localized fallback. Rendering is via `x-text` (auto-escaped), so there is no XSS sink regardless.

The exemption is narrow: it does NOT extend to end-user-facing pages, which keep the code-to-localized-key shape above. The audience distinction (trusted operator vs end user) is the line.

## Why This Matters

**`console.warn` is safe to log raw errors into today, but the invariant is load-bearing.** PEvO has no error-telemetry sink: no Sentry, Rollbar, Bugsnag, or `navigator.sendBeacon` usage. The only global listener is `frontend/src/error-tracking.js`'s `unhandledrejection` hook, which writes to `console.error` and is not reachable from a caught-and-handled error. A future decision to add telemetry must re-audit every `console.warn('[scope]', err)` call site — the full error object is assumed to be local-only at write time.

**The DOM is the uncontrolled sink.** Alpine's `x-text` binding renders `textContent`, which is XSS-safe. But the contents of that textContent are visible to every actor with DOM access — screenshots, extensions, accessibility tools, screen-share. What reaches the DOM is effectively public.

**Pattern consistency reduces cognitive load during the next expansion.** Once every catch in `frontend/src/pages/` follows the shape, a new author adding a handler has one template to copy and one rule to remember. Divergent shapes (some using `err.message` fallback, some using generic, some interpolating) make future refactor an archaeology exercise.

## When to Apply

- **Every new `catch (err)` block in a frontend page or component that renders an error field.** No exceptions for "this API doesn't leak anything today" — backend error shapes are not contracts and will drift.
- **Extending an existing branch to surface more detail.** If you want to show a DUPLICATE user "this email was registered 2 hours ago", do **not** read `err.data.hint`. Add a new i18n key and use the code to drive which one.
- **Adding a new API helper.** Assume rejections will embed diagnostic text the caller can't audit.

## Examples

**Before — raw `err.message` to DOM:**

```js
async handleEmailSubmit() {
  try {
    await submitEmail(this.newEmail.trim());
    // ...
  } catch (err) {
    if (err.code === 'DUPLICATE') {
      this.emailError = this.$t('settings.emailAlreadyInUse');
    } else {
      this.emailError = err.message || this.$t('common.connectionFailed');
    }
  }
}
```

**After — generic message to DOM, raw err to `console.warn`:**

```js
async handleEmailSubmit() {
  try {
    await submitEmail(this.newEmail.trim());
    // ...
  } catch (err) {
    if (err.code === 'DUPLICATE') {
      this.emailError = this.$t('settings.emailAlreadyInUse');
    } else {
      console.warn('[email submit]', err);
      this.emailError = this.$t('settings.emailUpdateFailed');
    }
  }
}
```

**Test shape (add one per sanitized handler):**

```js
it('sanitizes generic error: generic message to DOM, raw err to console.warn', async () => {
  const leaky = new Error('server error with hex=deadbeefcafebabe');
  mockSubmitEmail.mockRejectedValue(leaky);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const comp = createComponent();
  comp.newEmail = 'x@x.com';

  await comp.handleEmailSubmit();

  expect(comp.emailError).toBe('settings.emailUpdateFailed');
  expect(comp.emailError).not.toContain('deadbeef');   // canary
  expect(warnSpy).toHaveBeenCalled();
  expect(warnSpy.mock.calls[0][1]).toBe(leaky);
});
```

The `deadbeef` canary catches regressions via concatenation (`` `${generic} ${err.message}` ``) or template-string re-introduction. The identity check (`toBe(leaky)`) confirms the full error object reaches `console.warn`, not a wrapper or a stringified form.

**Don't do this:**

```js
// ❌ Raw err.message to DOM-bound field (literal or optional-chained):
this.emailError = err.message;
this.emailError = err.message || this.$t('common.connectionFailed');
this.emailError = err?.message || this.$t('common.connectionFailed');
this.$store.toast.show(err?.message || this.$t('...'), 'error');

// ❌ Raw err.data to DOM-bound field:
this.emailError = this.$t('...') + ' ' + err.data.hint;

// ❌ Raw err.code x-text'd as a label:
this.emailError = `Error code: ${err.code}`;

// ❌ console.warn on every branch, including benign semantic codes:
catch (err) {
  console.warn('[handler]', err);   // fires on routine DUPLICATE too
  if (err.code === 'DUPLICATE') { ... }
  else { ... }
}

// ❌ Forgetting to zero plaintext inputs before warn-logging the error object:
catch (err) {
  console.warn('[set password]', err);   // err may embed HTTP body with password
  this.newPasswordInput = '';            // too late — already logged
  this.passwordError = this.$t('...');
}
```

## Acceptance grep

The canonical grep for enforcing this convention is:

```bash
grep -rnE '= err\??\.message|err\??\.message \|\|' frontend/src/
```

This catches both literal-assignment forms (`this.x = err.message`, `this.x = err.message || …`) and **optional-chained** forms (`err?.message || …`, `this.x = err?.message`) — the earlier form of this doc specified only the literal shape, which caused `UI-ERR-MESSAGE-SANITIZE-PAPER-DETAIL-SURVIVORS` (2026-04-22): 9 `err?.message || $t(...)` toast/DOM bindings in `paper-detail.js` plus 5 more in sibling pages slipped past the original gate. Zero matches expected across `frontend/src/`, or only semantic-code-branch carve-outs with an inline justification comment (e.g. the `NOT_FOUND` branch in `paper-detail.js` loader).

**Grep gap + the admin-console exemption:** the admin console's `_errorMessage` returns the message via a bare `return err.message` statement, which the grep above does NOT match (it targets the `= err.message` / `err.message ||` forms). So the operator-console passthrough is out of the grep's scope, not a false-clean — it is the sanctioned exemption documented under Guidance, justified by the trusted-operator audience and the backend's static-message obligation. If the grep is ever widened to catch the `return`/`return …` forms, exclude the admin `_errorMessage` site explicitly so the exemption does not read as a violation.

## Related

- `agents/ui/CLAUDE.md` § Internationalization — new generic-message keys stub across 15 non-English locales and register one line per stub in `frontend/public/messages/STUBS.md`.
- `agents/docs/tasks/ui-err-message-sanitize-sweep-rest-of-frontend.md` — extends this pattern to ~30 remaining call sites.
- `STUBS.md` bootstrapping: `frontend/public/messages/STUBS.md` was seeded + populated by commit `97ac495` (FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP hold-block fix, 2026-04-22); the earlier `ui-locale-stubs-md-seed` prerequisite task was retired as subsumed.
- Reference implementation: `frontend/src/pages/settings.js` catches in `executeUpgrade`, `handleOrcidLink`, `handleEmailSubmit`, `handleSetPassword`, `handleEmailDelete`.
