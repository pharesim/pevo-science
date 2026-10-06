# The signup page is silent on a duplicate e-mail, and the accreditation page shows server English

**Owner:** ui
**Created:** 2026-10-06
**Priority:** low

Found while grounding `architect-accreditation-mailbox-binding-design`. Triage: user, "as
recommended".

## Why

`frontend/src/pages/signup.js` handles the 409 `DUPLICATE` from `POST /api/auth/signup` by trying
to log in with the typed credentials and otherwise redirecting to `/login` with no message; on the
ORCID branch it falls to the generic `signup.submitFailed`. No locale string says the address is
already registered. `frontend/src/pages/accreditation.js` renders `res.data.message` (the server's
English sentence with the masked address) on success, an exception to the 16-locale convention
and to the rule of never binding server text into the DOM; the server string must then also stay
emdash-free, which nothing enforces.

## Scope

1. Signup: a specific, translated message for `DUPLICATE` on both branches ("This e-mail is already
   registered. Sign in or reset your password.") with the sign-in link; keep the silent login
   attempt only if the product wants it, and say so in the signal block. Note the sibling
   `ui-accreditation-binding-refusal-states`: a bound mailbox with no account row answers like a
   normal signup by design, so this message appears only for the 409.
2. Accreditation request success: compose the sentence client-side from `res.data.email_masked`
   (or the field the response carries) and a locale string; stop rendering `res.data.message`.
3. New strings in `en.json`, stubbed in the 15 other locales, recorded in `STUBS.md`; no emdash.

## Acceptance criteria

1. A 409 `DUPLICATE` on signup shows the message and the sign-in link; no redirect without text.
2. The accreditation success state contains no server-composed sentence.
3. Unit tests for both branches.
