# A reset link survives further reset requests, and a reset to the current password is refused

**Owner:** backend
**Created:** 2026-10-08
**Priority:** normal

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). Contract: `api-contracts/auth.md`, the "decided 2026-10-08"
sentences under `POST /api/auth/reset-request` and `POST /api/auth/reset`.

## Why

The password reset is the veto the held email change and the held deletion rely on
(ARCHITECTURE.md § 6.3). Two gaps weaken it. `POST /api/auth/reset-request` replaces the row's
reset token on every request that matches its lookup, and the token is stored in plaintext, so a
party who knows the owner's address can keep overwriting the link the owner holds from several
IPs; the owner must open the newest mail before the next arrives. `POST /api/auth/reset` accepts
the current password as the new one, so an owner who follows a notice and "resets" to the
password they already use rotates nothing.

## Scope

1. In `POST /api/auth/reset-request`, when the selected row holds a `reset_token` whose
   `reset_token_expires_at` is in the future, mail that token again and write nothing; otherwise
   mint and write as today. The response and its timing posture are unchanged.
2. In `POST /api/auth/reset`, after the token checks and before the hash, refuse a password that
   verifies against the row's current `password_hash` with 400 `VALIDATION_ERROR`
   `Choose a password that differs from your current one.`; the token is not spent by the
   refusal.
3. Tests in the reset suites on real routes: two reset requests for one address mail the same
   token and the first link still resets; a reset to the current password answers 400 and leaves
   the hash and the token in place; a reset to a new password still succeeds.

## Acceptance criteria

1. A reset link mailed to an address stays valid for its full hour however many reset requests
   follow for that address.
2. A reset to the current password changes nothing and answers 400; no emdash.

## Notes

- Co-edits the handlers `backend-reset-refuses-orcid-path-and-unverified-signup-rows` (high) and
  `backend-password-reset-link-has-no-page` (high) edit; whichever lands second merges.
- `architect-password-reset-gate-docs` records the reset behaviour; the architect appends these
  two rules to it.
- Leave a `[TODO Architect]` in the signal block for `api-contracts/auth.md` if the behaviour
  differs from the contract's sentences.
