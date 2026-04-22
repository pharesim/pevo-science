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

## Backend re-review signal (2026-04-22, worktree agent-aa1bf969):

Round-2 hold items landed:

1. **P2 — ORCID-only confirmed-state TypeError oracle** — landed. Added null-guard burn before `argon2.verify` in `/resume-signup` (`backend/src/routes/signup-verify.ts`): when `account.password_hash` is null (ORCID-only confirmed-state), the route now `await burnSentinel(password)` then returns the uniform `400 BAD_REQUEST 'Invalid email or password'`. SQL result type annotation widened `password_hash: string` → `string | null` on the `/resume-signup` `pool.query<...>(...)` generic. Also hoisted the hash into a non-null local (`const passwordHash = account.password_hash`) so the argon2.verify call typechecks without a cast.

2. **P3 elevated — Parametrize timing test across 3 scenarios** — landed. Converted the single unknown-email timing spec in `backend/tests/routes/signup-verify.test.ts` into a 3-scenario `it.each` under `describe.skipIf(!dbReachable)('BE-AUTH-RESUME-SIGNUP-TIMING-GUARD: /resume-signup burns sentinel on all non-verify-path branches', ...)`: (a) unknown-email (no row), (b) non-confirmed-state (row exists, raw 64-hex `verify_token`, real-looking argon2 `password_hash`), (c) ORCID-only confirmed (row with `verify_token = 'confirmed:…'` and `password_hash = NULL`). `beforeAll` seeds (b) and (c) directly via `INSERT INTO accounts`; `afterAll` cleans up. Each scenario clears `signup-resume` rate limit, warms the sentinel-hash lazy promise with one unknown-email request, then measures a second request and asserts `elapsed ≥ TIMING_ORACLE_FLOOR_MS` (35ms). All 3 pass locally at ~50ms each; full `signup-verify.test.ts` → 5/5 pass, `recover.test.ts` → 28/28 pass.

Verification: `npx tsc --noEmit` clean; `npm run lint` clean (0 errors; 6 preexisting warnings in unrelated files).
