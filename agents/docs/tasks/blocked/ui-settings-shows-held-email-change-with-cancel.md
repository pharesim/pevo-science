# Settings shows a held email change, its date and a cancel; the verify page tells confirm from apply

**Owner:** ui
**Created:** 2026-10-08
**Priority:** normal

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). Backend half: `backend-email-change-hold-and-owner-notice`.
Contract: `api-contracts/settings.md` (`pendingEmailChange`, the verify response's `applied`,
`POST /api/settings/email/cancel-change`, `PENDING_CHANGE`, the own-address 400). Design:
ARCHITECTURE.md § 6.3 and § 6.4.

## Why

The backend will hold a password-proven email change for 72 hours, report it on
`GET /api/settings/email`, accept an in-app cancel with the proof the change needs, and the
verify link will confirm without applying during the hold. The settings page reads none of that
today (its email section keys on `hasEmail` and `verified` only, and nothing in the SPA reads
`pendingChange`), and the verify page shows one success heading for every 200.

## Scope

1. The settings email section reads `pendingEmailChange` and, when present, shows above the
   change form the masked pending address, either that it is waiting for the new address to
   confirm or the date it takes effect, a warning that a new request replaces it, a Cancel button
   that acquires a `change_email` proof through the existing settings fresh-auth orchestration
   and calls the cancel route, and the line that someone who did not request it should reset
   their password because cancelling alone signs nobody out.
2. The change form's description on a light session says the change takes effect no earlier than
   72 hours after the request and that the current address is told; a self-custody session keeps
   today's text.
3. After a change request the page re-reads the status and, when no pending change is recorded,
   shows that the request could not be recorded and to try again later, instead of the sent line
   (the uniform 200 hides a failed verification send from the API; the authenticated status is
   the caller's own).
4. The own-address 400 and the `PENDING_CHANGE` 409 map to their own strings (today every
   non-DUPLICATE error renders the generic update-failed string).
5. The verify page shows the existing success heading when the response's `applied` is true and,
   when false, that the address is confirmed, that the change takes effect after the waiting
   period unless it is cancelled before then, and that Settings shows the date.
6. New strings in all sixteen locales per the STUBS.md convention; no emdash.
7. Unit specs for the pending states, the not-recorded line, the two error strings and the two
   verify outcomes. The e2e settings spec's password-path change asserts `applied: false` and an
   unchanged email, then sets `pending_email_hold_until` in the past through the test database
   and re-opens the link within the token's life, asserting the success heading and the flipped
   email (Playwright has no entry point into the backend process, so it cannot run a sweep pass).

## Acceptance criteria

1. A signed-in owner with a queued change sees it and its date without reading the API and can
   cancel it with the same re-auth the change needed.
2. The verify page never shows the success heading for a confirmation that did not apply.
3. Every new string exists in all sixteen locales.

## Notes

- `ui-settings-verify-email-posts-on-load` (low) adds a confirm button to the same verify page;
  whichever lands second merges.
- `ui-settings-offers-the-orcid-factor-beside-the-password` (blocked) adds an ORCID option to
  the same prompts; whichever lands second merges.

## [BLOCKED by Architect] (2026-10-08): sequenced behind the backend hold task

Waits for `backend-email-change-hold-and-owner-notice` to be archived: until then the status has
no `pendingEmailChange`, the verify response has no `applied`, and the cancel route does not
exist. The architect moves this file to `pending/` when that task is archived.
