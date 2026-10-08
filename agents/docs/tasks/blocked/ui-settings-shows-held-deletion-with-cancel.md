# Settings shows a held deletion, its date and a cancel

**Owner:** ui
**Created:** 2026-10-08
**Priority:** normal

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). Backend half: `backend-password-proven-deletion-is-held-and-announced`.
Contract: `api-contracts/settings.md` (`pendingDeletion`, the `{ deleted: false, effectiveAt }`
response, `POST /api/settings/email/cancel-delete`).

## Why

The backend will hold a password-proven deletion for 72 hours and answer
`{ deleted: false, effectiveAt }` instead of `{ deleted: true }`. The settings page's delete
handler shows the deleted state on any 200 today, so without this task a queued deletion renders
as done.

## Scope

1. The delete handler treats `{ deleted: false, effectiveAt }` as a queued deletion and shows a
   pending block instead of the deleted state: the date the deletion takes effect, a Cancel
   button that acquires a `delete_account` proof through the existing settings fresh-auth
   orchestration and calls the cancel route, and the line that someone who did not request it
   should reset their password because cancelling alone signs nobody out.
2. The settings page reads `pendingDeletion` on load and shows the same block when it is set.
3. The delete confirmation on a light session says the deletion takes effect no earlier than
   72 hours after the request and that the current address is told; a self-custody session keeps
   today's text.
4. New strings in all sixteen locales per the STUBS.md convention; no emdash.
5. Unit specs for the queued outcome, the block on load and the cancel.

## Acceptance criteria

1. A queued deletion never renders as a completed one; a signed-in owner sees its date and can
   cancel it with the same re-auth the deletion needed.
2. Every new string exists in all sixteen locales.

## Notes

- `ui-delete-account-control-for-rows-without-email` (normal) edits the same delete control;
  whichever lands second merges.
- Builds on `ui-settings-shows-held-email-change-with-cancel`'s pending block pattern when that
  task lands first.

## [BLOCKED by Architect] (2026-10-08): sequenced behind the backend held-deletion task

Waits for `backend-password-proven-deletion-is-held-and-announced` to be archived. The architect
moves this file to `pending/` when that task is archived.
