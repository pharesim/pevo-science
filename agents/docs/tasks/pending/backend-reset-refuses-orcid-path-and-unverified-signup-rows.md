# Password reset finishes signups that someone else started

**Owner:** backend
**Created:** 2026-10-07
**Priority:** high

Filed at the architect review of `backend-signup-verify-requires-the-signup-password` (archived
2026-10-07). It merges the security reviewer's pre-existing P1 with that task's follow-up 3 (should
reset serve pending rows at all). User triage: "as recommended".

## Why

Two pending signup rows can be reset by the owner of an address that someone else signed up
with. The owner then finishes a signup the other person started and still partly controls.

**An ORCID-path row F with a password.** `POST /api/auth/signup` with an `orcid_token` that
resolves writes a row F (`confirmed:` token) straight away, carrying the signer's ORCID, the
submitted address and, when the request sends one, a password. The ORCID branch does not mail the
address. The SPA sends no password on that branch, so this row comes only from a hand-built
request. The address owner's own `/signup` answers 409 "Email already verified. Please log in to
continue." `POST /api/auth/reset-request` selects
`password_hash IS NOT NULL AND (username IS NULL OR verify_token IS NULL)`, so the owner can reset
the row's password, log in (409 `PENDING_SIGNUP`), call `/resume-signup` and finalize. `/confirm`
and `/link` keep the row's `orcid`, so the signer can then use ORCID login on the owner's
account. The security reviewer probed this on real Postgres and Redis up to `/resume-signup`.
`/confirm` was not run because it broadcasts. The reset gate archived on 2026-10-05 was meant to
refuse ORCID-path F rows, because their address was never proven, but it tests for a password,
so it refuses only the passwordless ones.

**A row E.** `/verify` now requires the row's password, so an address owner can confirm a row E
that someone else started only by resetting its password first. The signup the owner then
finishes carries the other person's `full_name`, `institution` and `field`, and `/confirm`
publishes them on-chain in the accreditation `custom_json`. A signer who forgot their own
password before verifying does not need reset. Signing up again with the same address rewrites
row E (password and profile) through the upsert's `DO UPDATE` and mails a new link.

## Scope

1. `POST /api/auth/reset-request` and `POST /api/auth/reset` refuse:
   - a pending row that carries an ORCID (`username IS NULL AND orcid IS NOT NULL`), with or
     without a password;
   - a row E (`username IS NULL` and a `verify_token` that is not `confirmed:`).

   Put the condition in every reset predicate: the reset-request SELECT, its token-write UPDATE
   and the `/reset` UPDATE. Grep `routes/auth.ts` for any other statement that issues or redeems
   a reset token, and list what you found in the signal block. A refused row gets what a
   passwordless row gets today: the unknown-email answer and no token at reset-request, and at
   `/reset` the current answers for a token already on the row, with no password written.
2. An email-path row F (`username IS NULL`, `confirmed:` token, `orcid` NULL, a password) keeps
   reset. It is that row's only forgot-password route back to `/resume-signup`.
3. Exits for the refused rows, to check against the code:
   - Row E, signer who forgot the password: sign up again with the same address.
   - Row E, address owner: sign up with the address; the upsert's `DO UPDATE` on E takes it over.
   - ORCID-path row F, signer: `/resume-signup` with the password when the row has one; otherwise
     the ORCID resume path `backend-orcid-path-f-resume` adds.
   - ORCID-path row F, address owner: none until signup cleanup reaps the row. That block is
     `architect-orcid-path-signup-holds-an-unproven-address`, not this task.

## Acceptance criteria

1. Route specs against real Postgres. For an ORCID-path row F with a password, an ORCID-path row
   F without one, and a row E: reset-request issues no token and gives the unknown-email answer,
   and a token planted on the row does not rotate the password at `/reset`, with the row
   unchanged. An email-path row F still rotates. The ORCID-path-with-password and row E cases
   fail against the current code.
2. `backend/tests/routes/auth-reset-account-state.test.ts` pins row E and the ORCID-path row F
   with a password as refused.
3. The refusal lives in the SQL predicates, as the password test does, so a refused row takes
   the unknown-email path and adds no registration-status signal.
4. No new error code.

## Notes

- **[TODO Architect] at review:** ARCHITECTURE.md § 6.3's Forgot-password block and
  `api-contracts/auth.md` (reset-request, reset), through `architect-password-reset-gate-docs`.
- Learnings checkpoint at archive: a candidate `/ce-compound` entry. The 2026-10-05 gate tested a
  column that usually goes with the property it meant (a password present, for "the address was
  proven"), and missed the rows where the two differ.
