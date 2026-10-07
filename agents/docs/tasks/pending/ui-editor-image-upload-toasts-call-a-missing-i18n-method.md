# Editor image-upload toasts call an i18n store method that does not exist

**Owner:** ui
**Created:** 2026-10-07
**Priority:** normal

Filed from the architect review of `ui-revoked-session-e2e-real-path` (archived 2026-10-07), where
the adversarial reviewer found it as a pre-existing issue. The user approved filing it.

## Why

Two toast calls in the editor's image-upload path in `frontend/src/editor.js` look up their copy
with `Alpine.store('i18n')?.t(...)`:

- the signed-out branch: `Alpine.store('i18n')?.t('signIn.signInToContinue') || 'Sign in to continue'`
- the catch branch, for every `describeUploadError` key other than `common.uploadFailed`:
  `Alpine.store('i18n')?.t(key) || this._t('imageUploadFailed')`

The store registered in `frontend/src/i18n.js` has no `t` method. `t` exists only as the `$t`
magic (`Alpine.magic('t', ...)`). The optional chain stops at a missing store, not at a missing
method, so each call throws a `TypeError` before the `||` fallback runs. The surrounding
`catch { /* toast unavailable */ }` swallows it. So a signed-out paste, and every upload failure
that maps to a key other than `common.uploadFailed`, ends with no message: the image just does
not appear.

Before 2026-10-07 no toast rendered anywhere, so this was invisible. Toasts render now, which
makes the missing message a visible gap next to the ones that do work.

## Scope

Look the key up the way `editor.js` already does elsewhere, from `Alpine.store('i18n')?.messages`,
keeping each call's existing English fallback. The `messages` reads elsewhere in `editor.js` show
the pattern. Cover both branches with unit tests that read the real i18n store shape (no store
mock that adds a `t` method), so a reintroduced `.t(` call fails.

Note: other sessions have uncommitted work in `frontend/src/lib/ipfs-upload.js`
(`describeUploadError` lives in that area). Re-read it before starting and keep this change to
the editor's lookup.

## Acceptance criteria

1. A signed-out image paste shows the localized "sign in to continue" toast.
2. An upload failure whose `describeUploadError` key is not `common.uploadFailed` and not `null`
   shows that key's localized copy.
3. A unit test fails if either call goes back to a `t` method the store does not have.
