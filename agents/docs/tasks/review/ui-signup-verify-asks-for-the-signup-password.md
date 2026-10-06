# The signup verify page asks for the signup password

**Owner:** ui
**Created:** 2026-10-05
**Priority:** high

The UI half of `backend-signup-verify-requires-the-signup-password`, filed at the user's request
on 2026-10-05. Read that task's Why first: it explains the account takeover this closes.

## Why

`POST /api/auth/verify` will require the password chosen at signup beside the mailed token, and
will answer 400 `VALIDATION_ERROR` without it. Today `pages/signup-verify.js` calls
`verifyToken(emailToken)` from `init()` as soon as the page loads with `?token=`, and
`verifyEmail(token)` in `api.js` sends `{ token }` only. Once the backend change lands, that call
fails and the email signup flow stops at the verify page.

## Scope

1. **`api.js`:** `verifyEmail(token, password)` sends `{ token, password }`.
2. **`pages/signup-verify.js`:** landing with `?token=` shows a password field. It does not verify
   on load. Submitting sends the token and the password.
   - 401 `UNAUTHORIZED` means a wrong password. Show that, keep the form, and keep the token: the
     link stays usable.
   - The 400 `BAD_REQUEST` answers (an unknown, already used or expired token) keep today's
     handling.
   - A 503 from argon saturation shows a retry message.
   - The resume path (`query.resume === RESUME_MARKER`) is unchanged.
3. **Copy:** the prompt says this is the password chosen when signing up for PEvO, and that someone
   who did not sign up should close the page. New strings go through the project's i18n flow.
4. **Specs:** `tests/unit/pages-signup-verify.test.js`, plus whichever of
   `tests/e2e/email-signup.spec.js` and `tests/e2e/seed-phrase.spec.js` drive the verify link,
   enter the signup password. Add a unit spec: a 401 keeps the form and the token, and a retry
   with the right password reaches the `choose` phase.

## Notes

- This can ship before the backend task or with it, never after. The current `/verify` ignores
  the extra `password` field, but the backend change alone breaks the flow.
- The E2E specs need the backend change on the test stack.

## UI implementation signal (2026-10-06, commit e2334dd4)

Landed on main in one commit, verified with
`git merge-base --is-ancestor e2334dd4 main`.

**Scope, item by item:**

1. `api.js`: `verifyEmail(token, password)` posts `{ token, password }`.
   `tests/unit/api.test.js` pins the body.
2. `pages/signup-verify.js`: landing with `?token=` stores the token and
   shows a password form (new phase `password`, which replaces the
   verify-on-load `verifying` spinner). Nothing is sent on load. Submit
   (`handleVerify`) sends the token and the password.
   - 401 `UNAUTHORIZED`: the form and the token stay, with a wrong-password
     message; a retry with the right password reaches `choose`.
   - 400 `BAD_REQUEST`: today's resume form, no message.
   - 503: the form stays, with a retry message.
   - The `?resume=1` path is unchanged.
3. Copy: six new `seedPhrase` keys (`passwordTitle`, `passwordDescription`,
   `passwordButton`, `passwordWrong`, `verifyRetry`, `verifyRateLimited`),
   English stubs in the 15 other locales, one STUBS.md Added sweep (90
   lines). The prompt says the password is the one chosen when signing up
   for PEvO and that someone who did not sign up should close the page.
4. Specs: `pages-signup-verify.test.js` covers landing without a request,
   token plus password sent, the 401-then-retry spec the task asks for,
   400, 503, 429, an unexpected flow and teardown. `email-signup.spec.js`
   and `seed-phrase.spec.js` enter the signup password;
   `email-signup.spec.js` also asserts the `/verify` request body.

**Decisions the task left open:**

1. **429 `RATE_LIMITED` keeps the form with a wait message.** Wrong-password
   retries now count against `verifyLimiter` (10 per hour per IP). The
   resume form cannot help a row the link has not confirmed yet, so
   dropping to it would be a dead end.
2. **Any other failure (500, network, timeout) keeps the form with the
   retry message**, for the same reason. If the confirm landed and only the
   answer was lost, the retry gets 400 and moves to the resume form, which
   then works.
3. **The wrong-password copy names the way out:** "If you forgot it, start
   a new signup with the same email address." The `/signup` upsert's
   `DO UPDATE` rewrites a pending row E's password and token and mails a new
   link. The form also carries the existing "Start a new signup instead"
   link.
4. **The busy state is the button label** (`seedPhrase.verifying`), as the
   resume form on the same page does, rather than a spinner phase that would
   hide the form between attempts.

**Verification:**

- Frontend unit suite: 94 files, 2227 tests, exit 0.
- E2E on the test-mode stack (`./deploy.sh restart`, `test-db-up`,
  `test-up`; dev routing restored with `./deploy.sh up` afterwards):
  `email-signup.spec.js` and `seed-phrase.spec.js` 2/2 passed, `--retries=0`.
  The stack ran the current backend, which ignores `password`, so this run
  proves the new form and request shape, not the 401 branch.
- The 401, 503 and 429 branches were driven in a real browser against the
  rebuilt bundle with `/api/auth/verify` answered by `page.route` (401, then
  503, then 429, then 200 `choose`) at 1280px and 390px wide. Each kept the
  form with its message, every request carried the token and the typed
  password, the last reached `choose`, and nothing overflowed horizontally.

**Also in this commit:** the three bare `form button[type="submit"]`
locators in these two specs (`email-signup` 1, `seed-phrase` 2) are scoped
to `[x-data="signupPage"]` and `[x-data="recoverPage"]`. Before this the
specs failed at those clicks. `ui-e2e-bare-submit-locators-clash-with-reauth-modal`
lists them, and its pickup re-grep will find them gone.

**For deploy:** the backend sibling
(`backend-signup-verify-requires-the-signup-password`) is still in
`pending/`. This commit can ship first: the current `/verify` ignores the
extra field.
