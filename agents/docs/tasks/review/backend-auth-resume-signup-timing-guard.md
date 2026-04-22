# BE-AUTH-RESUME-SIGNUP-TIMING-GUARD — Close the unknown-email timing oracle on /api/auth/resume-signup

**Owner:** backend
**Created:** 2026-04-22 (surfaced by SEC-LOGIN-UNKNOWN-USER-TIMING round-3 review)
**Priority:** P2

## Context

`SEC-LOGIN-UNKNOWN-USER-TIMING` audited `/api/auth/*` for unknown-account timing oracles and closed them on `/login`, `/signup`, `/resend-verification`, `/recover`, `/reset-request`. The round-3 architect review surfaced one sibling endpoint outside the original audit scope that has the identical oracle shape: `POST /api/auth/resume-signup`.

At `backend/src/routes/signup-verify.ts:105-119`:

- Unknown email → early 400 BAD_REQUEST in ~1ms (no argon2).
- Known email in confirmed-signup state → proceeds to `argon2.verify` (~50ms).

Same pattern the prior audit closed across auth.ts. An attacker probing `/resume-signup` can enumerate which emails exist in confirmed-signup state (~50ms) vs. which don't (~1ms).

Security 0.68 confidence. See `.context/compound-engineering/ce-code-review/aggregated/02-backend-login-unknown-user-timing.md` § F2.3.

## Goal

Apply the standard `await burnSentinel(password)` pattern on the unknown-email 400 branch of `/api/auth/resume-signup`, matching the three sibling sites in auth.ts.

## Non-goals

- Changing the 400 status code.
- Reshaping `/resume-signup`'s contract.

## Acceptance

- `backend/src/routes/signup-verify.ts` unknown-email branch: `await burnSentinel(password)` before the 400 early-return.
- Timing test in the appropriate test file (same shape as the 3 sibling tests in `recover.test.ts`).
- `npx tsc --noEmit` clean; full backend vitest passes.

## [TODO Architect]

None — matches established pattern. No contract update needed.
