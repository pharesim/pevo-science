# Two concurrent recovery confirmations both apply

**Owner:** backend
**Created:** 2026-10-06
**Priority:** low

## Why

`POST /api/auth/recover/verify` (`backend/src/routes/recover.ts`) reads the
staging row with a plain `SELECT` and checks `consumed_at`, `disputed_at` and
the expiry on that read. Its transaction then updates the account and runs
`UPDATE pending_recovery SET consumed_at = NOW() WHERE id = $1`, with no
`consumed_at IS NULL` guard. Two concurrent posts of the same token both pass
the checks and both apply the swap. Each sets `sessions_invalidated_at` and
returns its own reissued session, so the later one revokes the session the
earlier one returned. A dispute recorded between the `SELECT` and the
transaction is not seen either. The SPA's in-flight guard serializes one tab
only.

Surfaced in the review of `ui-seed-recovery-confirm-and-dispute-pages`.

## Scope

1. Make the consume conditional inside the transaction (a guarded `UPDATE`
   on `consumed_at IS NULL AND disputed_at IS NULL`, or a `SELECT ... FOR
   UPDATE` re-check), and run the account update only when that consume
   matched the row.
2. A request that loses gets the same refusal as an already-used or
   disputed link.
3. A test that forces two overlapping confirmations and shows one applies
   and the other is refused.

## Acceptance criteria

1. One staging row applies at most once, however many confirmations race.
2. A dispute recorded before the consume commits stops the swap.

## Architect note (2026-10-08)

The apply UPDATE in `POST /api/auth/recover/verify` gains `email_changed_at = NOW()`
(`backend-email-changed-at-stamp-and-displaced-address-notice`) and NULLs for
`pending_email_hold_until`, `pending_email_confirmed_at` and `pending_delete_at`
(`backend-email-change-hold-and-owner-notice`, `backend-password-proven-deletion-is-held-and-announced`).
Whichever lands second merges the SET-list lines; this task's acceptance stands.
