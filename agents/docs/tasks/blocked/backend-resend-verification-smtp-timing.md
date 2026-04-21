# BE-RESEND-VERIFICATION-SMTP-TIMING — Close the SMTP-latency timing oracle on `/api/auth/resend-verification`

**Owner:** backend
**Created:** 2026-04-21 (surfaced by SEC-LOGIN-UNKNOWN-USER-TIMING adversarial review 2026-04-21)
**Priority:** P2

## Context

SEC-LOGIN-UNKNOWN-USER-TIMING (commit `6c9a1e0`) closed the argon2-vs-noargon2 timing oracle on `/api/auth/resend-verification` by burning `SENTINEL_ARGON2_HASH_PROMISE` on the unknown-email path. This closed the ~1ms vs ~50ms delta on the password-equalization axis.

A separate timing oracle remains: the happy-path success case `await nodemailer.sendMail(...)` synchronously in the request handler at `auth.ts:330`. SMTP latency varies 200-2000ms depending on provider and deliverability. So:

- **Unknown email:** ~50ms (sentinel burn, no real work, no SMTP).
- **Known email, pending verification:** argon2.verify (~50ms) + DB UPDATE (~2ms) + **`sendMail` (~200-2000ms)** = 250-2050ms total.

An attacker distinguishes the two branches by response-time distribution. Response body and status are identical per the commit's uniform-message design. Rate limiting at 3/hr per-IP bounds the attack rate but does not close the signal.

This was accepted as out-of-scope by the SEC-LOGIN-UNKNOWN-USER-TIMING commit because closing it requires an architectural change, not a one-line sentinel addition. Filed here for follow-up.

## Goal

Decouple `sendMail` latency from the HTTP response. Options (pick one during implementation):

1. **Fire-and-forget + 202 Accepted.** Return 202 immediately after the DB UPDATE, queue `sendMail` via `setImmediate` / `process.nextTick` / a bounded worker pool. Response time becomes argon2-only (~50ms) matching the unknown-email path. Caveat: SMTP failures no longer surface to the caller; need a dead-letter or retry log for operator visibility. Matches the pattern already used for `/reset-request` (which the commit notes as uniform 200 SMTP-dominated).

2. **Artificial delay padding.** Compute a bounded random delay (e.g. sampled from a truncated distribution matching typical SMTP range) and sleep the unknown-email path before responding. Caveat: wastes attacker's rate budget but raises the backend cost floor for legitimate unknown-email probes; every invalid-email typo now costs the server 200-2000ms. Not recommended.

3. **Async send + synchronous enqueue ack.** Enqueue to an internal job queue (Redis list, pg-queue, BullMQ), respond immediately. Same latency profile as option 1; worker handles SMTP + retries + dead-letters separately.

## Non-goals

Closing SMTP-provider-level timing leaks (DNS, TLS handshake differentials across destinations — not PEvO's concern). Closing the status-code oracle (intentional per SEC-LOGIN-UNKNOWN-USER-TIMING: status code stays 200 for both branches).

## Acceptance

- Timing test: known-pending-verification and unknown-email response wall-times are within 50ms of each other across 10 samples per branch, with SMTP mocked to have a synthetic 500ms delay.
- Operator-visible log or metric when `sendMail` fails (the fire-and-forget mode removes response-path visibility; something must replace it).
- No regression on `/reset-request` or `/login` timing tests.

## [TODO Architect]

Pick shape (1/2/3) and decide on the operator-visibility story for async-send failures before implementer starts.
