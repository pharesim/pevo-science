# BACKEND-CONFIRM-CONCURRENT-ACTIVATION-LOCK — Serialize concurrent /confirm (and /link) activation so one auth_token cannot double-fire account creation

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by `/ce-code-review` of the signup-binding range — adversarial P2, conf 50, pre-existing)
**Priority:** P3 (pre-existing; not introduced by the signup-binding work)

## Context

`POST /api/auth/confirm` (`backend/src/routes/signup-verify.ts`) reads the pending-signup row by `auth_token`, then activates the account (`createClaimedAccount` broadcast + pg activation). The read and the activation are not serialized: two concurrent `/confirm` requests carrying the same valid `auth_token` (+ binding cookie) can both pass the lookup and both proceed to activation, risking a double `createClaimedAccount` broadcast. `/link` has the structurally similar activation step.

Flagged as pre-existing during the signup-binding review; the binding work neither introduced nor fixed it. Low likelihood (requires two near-simultaneous requests with the same token+cookie), but the failure mode is a wasted/duplicated on-chain account-creation attempt.

## Goal

Serialize the confirm/link activation so a single `auth_token` activates at most once under concurrency. Options (implementer's call):

- Wrap the lookup + activation in a transaction with `SELECT ... FOR UPDATE` on the `accounts` row, or
- A pg advisory lock keyed on the username / auth_token for the activation critical section.

The chosen mechanism should make the second concurrent request observe the row already consumed (verify_token cleared) and return the normal "already used / invalid" path rather than re-broadcasting.

## Acceptance

- Two concurrent `/confirm` requests with the same valid `auth_token` + cookie result in exactly one activation (one 200, the other a clean rejection); `createClaimedAccount` is invoked at most once.
- Equivalent coverage for `/link` activation.
- Test exercises the concurrent case (real Postgres per the project test convention).

## Non-goals

- Reworking the binding mechanism (separate, in `backend-auth-token-session-binding`).
- Broader idempotency for unrelated routes.
