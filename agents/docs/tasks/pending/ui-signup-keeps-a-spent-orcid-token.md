# Signup keeps resubmitting an ORCID token the backend has refused

**Owner:** ui
**Created:** 2026-10-07
**Priority:** normal

Filed at the architect review of `backend-signup-verify-requires-the-signup-password` (archived
2026-10-07), from that task's follow-up 1. User triage: "as recommended".

## Why

`POST /api/auth/signup` now answers 400 `BAD_REQUEST` "Your ORCID verification is no longer
valid. Please verify your ORCID again." when an `orcid_token` is present and does not resolve:
it expired, or an earlier submit spent it. The backend deletes the nonce on its first lookup,
before the ORCID branch's own refusals such as the duplicate-email 409, so a resubmit after any
of those also gets this 400.

`handleSubmit` in `frontend/src/pages/signup.js` has no branch for it. On the ORCID branch it
shows the generic `signup.submitFailed`, keeps the spent `orcidToken` and leaves `canSubmit`
true, so every resubmit gets the same 400. The only way out is the clear-ORCID button. Comments
in `signup.js` still say a same-`orcid_token` resubmit yields a 422.

## Scope

1. On this 400 on the ORCID branch, drop the spent token (with any stored copy) and tell the user
   to verify their ORCID again, with the action that starts it. The copy goes through i18n like
   the rest of the page.
2. Correct the comments that say a same-token resubmit yields a 422.
3. Leave the `/signup/verify` wrong-password copy pointing at a new signup with the same address,
   not at password reset. Reset would let an address owner finish a signup someone else started,
   with that person's name and institution, and
   `backend-reset-refuses-orcid-path-and-unverified-signup-rows` withdraws reset from such rows.

## Acceptance criteria

1. A unit spec drives the 400 on the ORCID branch: the token is gone, the re-verify message and
   action show, and a resubmit with the spent token is not possible.
2. The comments match the backend's answer.
3. No emdash in the new copy.
