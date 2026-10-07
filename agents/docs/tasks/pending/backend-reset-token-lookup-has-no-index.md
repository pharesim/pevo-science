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
