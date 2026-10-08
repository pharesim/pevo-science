# The ORCID link confirm page sends its token from a button; settings shows a link awaiting the mailbox

**Owner:** ui
**Created:** 2026-10-08
**Priority:** normal

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). Backend half:
`backend-password-proven-orcid-link-completes-from-current-mailbox`. Contract:
`api-contracts/orcid.md` ("Password-proven link and accredit complete from the current mailbox"
and `POST /api/orcid/link/confirm`).

## Why

A password-proven ORCID link will complete only when a token mailed to the current address is
presented back. The token must be sent from a button, as the recovery pages do, so a mail
scanner that opens the link does not complete a link the owner did not request; and the settings
page must show a link that is waiting for the mailbox instead of a linked ORCID.

## Scope

1. New route `/settings/orcid-link` reading the token from the query. The page stores the token
   on init and sends it only from a confirm button; a done state on 200, a generic
   cannot-be-used state on 400, and a short line that someone who did not request the link
   should reset their password instead.
2. The settings ORCID section treats the callback's `pending_confirmation: true` as waiting for
   confirmation from the account's email address, not as a linked ORCID, and maps the
   settled-address 422 to its own string.
3. Strings in all sixteen locales per the STUBS.md convention; no emdash.
4. Unit specs: opening the page sends nothing; the button sends the token once; the pending
   state renders for `pending_confirmation`.

## Acceptance criteria

1. Opening the mailed link performs no request; pressing the button posts the token once.
2. The settings page never shows a pending link as linked.
3. Every new string exists in all sixteen locales.

## Notes

- `ui-orcid-link-and-accredit-acquire-fresh-auth` (blocked) owns the link flow's proof
  acquisition; this task owns its pending outcome. Whichever lands second merges.

## [BLOCKED by Architect] (2026-10-08): sequenced behind the backend confirm task

Waits for `backend-password-proven-orcid-link-completes-from-current-mailbox` to be archived.
The architect moves this file to `pending/` when that task is archived.
