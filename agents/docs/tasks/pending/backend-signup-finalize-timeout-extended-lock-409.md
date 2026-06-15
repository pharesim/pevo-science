# Signup-finalize broadcast timeout extends the ORCID binding lock, turning a legitimate retry into a misleading terminal 409 (backend)

**Owner:** backend
**Created:** 2026-06-15

From the 2026-06-15 architect code review of `backend-signup-confirm-orcid-binding-guard`
(adversarial-reviewer finding, confidence 75; the reliability reviewer concurred as a
residual risk).

## Problem

On the signup-finalize accreditation broadcast path (`broadcastAccreditationAndSeed`,
`backend/src/routes/signup-verify.ts`), when the Hive broadcast raises
`BroadcastTimeoutError` on the binding lock's `'acquired'` branch, the shared
`withOrcidBindingLock` wrapper extends the ORCID binding-lock TTL to the HAF-indexing-lag
ceiling (120s) and returns `{ skipRelease: true }`, so the lock is held across the
HAF-lag window. That part is correct for the chain layer: it prevents a duplicate bind
while the timed-out (possibly-landed) broadcast indexes. The user receives a 504 whose
message tells them they may retry `POST /api/auth/confirm`.

If the user retries within that ~120s window, the retry's `acquireBindingLock` fails the
SETNX (the lock is still held) and the wrapper's `'held'` branch returns
`409 ORCID_ALREADY_LINKED`. That code is deliberately wire-indistinguishable from the
durable cross-account binding 409 (see the comment at the durable-binding `sendError` in
`routes/orcid.ts`), so a client treats it as terminal: "the ORCID is taken, restart the
flow."

The terminal framing is correct for the `/orcid/callback` caller, whose OAuth state token
is consumed on the attempt. It is WRONG for the signup caller: the signup `auth_token` is
NOT consumed on a 504, and retry is the documented recovery. So a user who follows the
504's "retry" instruction inside the 120s window gets a confusing terminal 409 for their
OWN in-flight bind.

## Why this is not urgent (triage context)

- Reachable only on a broadcast TIMEOUT (rare), never on the normal path.
- Self-healing: once the 120s lock TTL expires, a retry either succeeds or the resume
  HAF-probe sees the now-indexed accreditation and finalizes idempotently.
- The timed-out broadcast may have actually landed, in which case the user is already
  accredited and just needs to log in.

So this is a confusing 504-then-409 sequence inside a ~2-minute window on a rare timeout,
not a data-integrity bug.

## Acceptance criteria

1. Implement a signup-caller distinction so a self-held lock (the user's own in-flight
   bind from a timed-out attempt) does not surface as the terminal cross-account
   `409 ORCID_ALREADY_LINKED`. Candidate shapes (pick one WITH the architect):
   (a) a retriable response carrying `retriable: true` + `Retry-After` ~= residual lock
   TTL for the self-held case on the signup path; (b) store the username alongside the
   lock nonce so the `'held'` branch can tell self-held from cross-account-held;
   (c) have the signup caller translate `'held'` into the ambiguous / verify-before-retry
   envelope rather than the terminal 409. **Confirm the wire-shape choice with the
   architect before landing** -- it interacts with the deliberate wire-indistinguishability
   of the durable-binding 409 (documented in `routes/orcid.ts`) and the contracts in
   `api-contracts/orcid.md` and `api-contracts/auth.md`.
2. Do NOT regress the `/orcid/callback` callers, whose terminal-409-on-`'held'` is correct
   (their state token is consumed). Scope the fix to the signup-finalize caller's token
   semantics.
3. Real-path test: a signup finalize whose first attempt times out (broadcast timeout,
   lock extended) and is retried within the lock window receives the chosen
   retriable/ambiguous shape, not the terminal cross-account 409.

## Out of scope

- The duplicate-bind protection itself (the lock + extend-on-timeout) is correct and stays.
- The cross-account durable-binding 409 wire shape is unchanged.
