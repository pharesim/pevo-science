# The recovery stop link answers "No change has been made" after the change applied

**Owner:** backend
**Created:** 2026-10-06
**Priority:** low

## Why

`POST /api/auth/recover/dispute` (`backend/src/routes/recover.ts`) answers
every valid token with `message: 'The recovery request has been stopped. No
change has been made to your account.'`. For a token whose swap already
applied (`consumed_at` set), the handler only sets `disputed_at` and writes
the `recovery_dispute` audit row; the swap stays applied, so both sentences
are false. The SPA's stop page shows its own copy and never this message,
but HTTP response strings are user-facing text (root `CLAUDE.md`). The
contract keeps the answer uniform across both outcomes so the link is not a
swap-status oracle (`api-contracts/auth.md` § POST /api/auth/recover/dispute).

Surfaced in the review of `ui-seed-recovery-confirm-and-dispute-pages`.

## Scope

1. Replace the message with one that holds for both outcomes and stays the
   same for both.
2. Update the tests that pin the message. Name the new text in the signal
   block so the architect updates the contract's example.

## Acceptance criteria

1. The dispute answer makes no claim that is false when the swap had
   already applied, and is identical for both outcomes.
