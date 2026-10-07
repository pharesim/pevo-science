# The reset-token lookup reads the whole accounts table

**Owner:** backend
**Created:** 2026-10-07
**Priority:** low

## Why

`POST /api/auth/reset` finds its row with
`SELECT id, reset_token_expires_at FROM accounts WHERE reset_token = $1`
(the `/reset` handler in `backend/src/routes/auth.ts`). `accounts.reset_token`
(`backend/migrations/001_schema.sql`) has no index, so every reset attempt,
including one with an unknown token, scans the accounts table. The cost grows
with the number of accounts.

The implementer of the reset-response change listed this as out of scope; the
user chose at the architect review (2026-10-07) to file it at low priority.

## Scope

1. Add a migration that indexes `accounts.reset_token`, following the
   existing migration conventions.

## Acceptance criteria

1. The migration creates the index and runs cleanly, also when run twice
   (`./deploy.sh migrate`).

## Architect note (2026-10-07): a second column, same migration

Folded in at the archive of `backend-reset-tokens-outlive-email-changes-and-recovery` (its
out-of-scope finding 3, user triage "as recommended"): `accounts.pending_email_token` has no index
either, so the change-flow lookup in `GET /api/settings/email/verify/:token`
(`SELECT id, pending_email_expires_at, email FROM accounts WHERE pending_email_token = $1`) scans
the table on every change-verify click. Index it in the same migration. Acceptance criterion 1
covers both indexes.
