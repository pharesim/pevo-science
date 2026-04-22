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

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `e627dcf` (security + correctness personas). The two burns on unknown-email (line 113) and non-confirmed-state (line 124) are structurally correct; imports, password narrowing, and the 35ms floor calibration are clean. One P2 finding closes a sibling oracle the task set out to eliminate but missed. One testing gap folds into the same fix commit.

1. **P2 — ORCID-only confirmed-state account triggers `argon2.verify(null, ...)` TypeError → 500 in ~0ms** (security SEC-RESUME-NULL-PWHASH-500 0.90). `backend/src/routes/signup-verify.ts:~129` reads `account.password_hash` which the SQL result type declares as `string` (wrong — should be `string | null`). An ORCID-only account with `password_hash = NULL` and `verify_token LIKE 'confirmed:%'` passes the non-confirmed-state burn guard at :123-126, reaches `argon2.verify(null, password)`, throws TypeError synchronously, bubbles to the catch at :142, returns 500 INTERNAL_ERROR in ~0ms. Attacker probes any email, distinguishes ORCID-only-confirmed accounts by distinctive ~0ms 500 vs ~50ms 400. Same oracle class the task was filed to close. Fix: before `argon2.verify`, check `if (!account.password_hash) { await burnSentinel(password); return sendError(res, 400, 'BAD_REQUEST', 'Invalid email or password'); }`. Also fix the SQL result type annotation `password_hash: string` → `password_hash: string | null`.

2. **P3 elevated — Line-124 burnSentinel has no timing test; mutation "delete burnSentinel at :124" survives** (correctness CORRECTNESS-T3-008 0.88). Fold with #1 above: parametrize the existing unknown-email timing test across three scenarios — (a) unknown-email (existing), (b) non-confirmed-state with `verify_token = <raw 64-hex>`, (c) ORCID-only-confirmed (the item-#1 new burn). All three assert elapsed ≥ TIMING_ORACLE_FLOOR_MS. Kills all three mutations in one shape.

**Dismissed from round-1 findings (architect triage):**
- 503 pool-null early return + VALIDATION_ERROR early return have ~0ms fast paths (low 0.72-0.76): consistent with auth.ts convention; these are not account-existence signals. Accepted.
- No test for happy path of /resume-signup: out of scope for timing-guard task; file follow-up if operator demand.

**Path to re-archive:** (1) Backend applies items #1-2 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2 — security + correctness mandatory. Archives on clean.
