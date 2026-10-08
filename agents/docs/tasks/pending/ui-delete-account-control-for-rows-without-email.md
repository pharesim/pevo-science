# Settings: an account with no email has no delete-account control

**Owner:** ui
**Created:** 2026-10-08
**Priority:** normal

Filed at the architect review of `ui-state-d-session-settings-critical-actions` (from the
implementer's "seen, not traced" list), confirmed against the code. User triage: "as
recommended".

## Why

`DELETE /api/settings/email` erases the whole account row (ARCHITECTURE.md § 6.4, "Delete
account data / right-to-erasure") and does not require the row to hold an email. The settings page
renders the delete control only in the verified-email and unverified-email states of the email
section. An account row with no email, such as a state C account from an ORCID-only signup, has
no way to delete the account from settings.

## Scope

1. Offer the delete-account control, with its confirmation and warning, to every account that has
   a row, whether or not the row holds an email. A caller with no row must not see it (the
   handler answers 401).
2. Decide from the `GET /api/settings/email` response how to tell a row from no row. If it
   cannot be told reliably for a `'self'` session with no email, move this task to `blocked/`
   with `[BLOCKED by Architect]` naming the field you need.
3. Tests: a light row without an email, a self-custody row without an email, and no row.

## Acceptance criteria

1. Every row state without an email shows the control; a caller with no row does not.
2. Frontend unit suite green; `npm run build` clean.

## Architect note (2026-10-08)

`ui-settings-shows-held-deletion-with-cancel` (blocked behind the backend held-deletion task)
changes the same delete handler to treat `{ deleted: false, effectiveAt }` as a queued deletion.
Whichever lands second merges.
