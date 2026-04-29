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

---

## Backend re-review signal (2026-04-22, worktree agent-aa1bf969):

Round-2 hold items landed:

1. **P2 — ORCID-only confirmed-state TypeError oracle** — landed. Added null-guard burn before `argon2.verify` in `/resume-signup` (`backend/src/routes/signup-verify.ts`): when `account.password_hash` is null (ORCID-only confirmed-state), the route now `await burnSentinel(password)` then returns the uniform `400 BAD_REQUEST 'Invalid email or password'`. SQL result type annotation widened `password_hash: string` → `string | null` on the `/resume-signup` `pool.query<...>(...)` generic. Also hoisted the hash into a non-null local (`const passwordHash = account.password_hash`) so the argon2.verify call typechecks without a cast.

2. **P3 elevated — Parametrize timing test across 3 scenarios** — landed. Converted the single unknown-email timing spec in `backend/tests/routes/signup-verify.test.ts` into a 3-scenario `it.each` under `describe.skipIf(!dbReachable)('BE-AUTH-RESUME-SIGNUP-TIMING-GUARD: /resume-signup burns sentinel on all non-verify-path branches', ...)`: (a) unknown-email (no row), (b) non-confirmed-state (row exists, raw 64-hex `verify_token`, real-looking argon2 `password_hash`), (c) ORCID-only confirmed (row with `verify_token = 'confirmed:…'` and `password_hash = NULL`). `beforeAll` seeds (b) and (c) directly via `INSERT INTO accounts`; `afterAll` cleans up. Each scenario clears `signup-resume` rate limit, warms the sentinel-hash lazy promise with one unknown-email request, then measures a second request and asserts `elapsed ≥ TIMING_ORACLE_FLOOR_MS` (35ms). All 3 pass locally at ~50ms each; full `signup-verify.test.ts` → 5/5 pass, `recover.test.ts` → 28/28 pass.

Verification: `npx tsc --noEmit` clean; `npm run lint` clean (0 errors; 6 preexisting warnings in unrelated files).

---

## Architect re-review (2026-04-29) — HELD PENDING FIXES (round 2)

`/ce-code-review` ran on commit `9710713` (the round-1 hold-fix: null-guard burn for `password_hash = NULL` accounts + 3-scenario timing test parametrization) with 10 personas (correctness, testing, maintainability, project-standards, agent-native, learnings, security, reliability, adversarial, kieran-typescript). Round-1 hold items 1 (P2 ORCID-only confirmed-state TypeError oracle) and 2 (P3-elevated parametrize timing test) verified landed correctly: the null-guard branch closes the oracle (verified via `argon2.verify(passwordHash, password)` typing through after the closure-local hoist), the 3-scenario `it.each` covers (a) unknown-email, (b) non-confirmed-state, (c) ORCID-only-confirmed under `describe.skipIf(!dbReachable)`, and the seeding logic correctly exercises distinct branches.

The bulk of round-2's findings are sibling-site `password_hash` typing-rigor issues — those have been filed as a separate audit task (`backend-password-hash-null-typing-audit.md` in `tasks/pending/`, P1) covering custody.ts:175,194, auth.ts:626 + 677, signup-verify.ts:209 + 341, auth.ts:539 (replace `!` with hoist), and the canonical hoist comment at `signup-verify.ts:139`. That task does NOT block this archive — the round-2 fix is correct on its own scope.

One round-2 hold item below — a test-side polish item on the `TIMING_ORACLE_FLOOR_MS` constant.

### Items to address

**1. (P3) Extract `TIMING_ORACLE_FLOOR_MS` to a shared test-support constant**

- Files: `backend/tests/routes/signup-verify.test.ts:284` and `backend/tests/routes/recover.test.ts:70`
- Both files declare `const TIMING_ORACLE_FLOOR_MS = 35` as a local constant. The comment at `auth.ts:210` documents the intentional split, but if the argon2 options change and the floor needs adjustment, a maintainer must update both files. A missed update silently weakens or strengthens the mutation-kill threshold in one file only.
- Fix: extract to `backend/tests/support/timing-constants.ts` (new file) and import in both. The new file's comment should cite the floor's relation to `ARGON2_OPTIONS.memoryCost` so a future tuning of the argon2 params has the visibility nudge. Update the comment at `auth.ts:210` to point at the new shared constant location instead of reiterating the duplication rationale.

### Items dismissed during architect triage (do NOT address)

- **kieran-typescript KT-001 through KT-004 (P1/P2): `password_hash: string` typing audit across custody.ts:175,194, auth.ts:626 + 677, signup-verify.ts:209 + 341, auth.ts:539** — filed as new task `backend-password-hash-null-typing-audit.md` (P1) in `tasks/pending/`. Cluster-completion work; does NOT block this round-2 archive.
- **maintainability M-01 (P2): hoist comment missing on `signup-verify.ts:139`** — folded into `backend-password-hash-null-typing-audit.md` (the canonical hoist site); the audit task adds the canonical comment shared by all sibling migrations.
- **maintainability M-02 (P3): `ResumeTimingScenario` type alias has only one consumer** — cosmetic; both inline + named-alias shapes are equally readable. A future 3rd field would benefit from the named type.
- **adversarial residual: empty-string `password_hash` burns silently without corruption log** (reliability R-001) — data-quality concern (DB corruption signal); the existing `!account.password_hash` guard handles both null and empty-string identically (security correct: both reject uniformly with burn). An explicit `password_hash === ''` check + `logger.error` with account id would surface DB corruption, but adding it to this task is scope creep. Re-file if observed in production.
- **adversarial + reliability TG-002: `describe.skipIf(!dbReachable)` silently bypasses** — pre-existing constraint of the timing-test strategy. Any CI tier without DB skips all real-DB tests; the property is on the skipping mechanism, not introduced by this diff.
- **reliability RR-002: TOCTOU between SELECT and `argon2.verify` on `password_hash`** — concurrent-mutation window on a rarely-mutated column; architecturally acceptable for a Hive-pace mutation rate.
- **testing R-01: empty-string password_hash not directly tested** — the parametrized test covers `null`; empty-string would route through the same `!account.password_hash` guard. Implicit coverage acceptable.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

## Backend re-review signal (2026-04-29, working tree)

Round-2 hold item 1 (P3) landed. Created `backend/tests/support/timing-constants.ts` exporting `TIMING_ORACLE_FLOOR_MS = 35` (and `TIMING_ORACLE_CEILING_MS = 150`, which was previously single-site in `recover.test.ts` — kept next to FLOOR so both thresholds and their argon2-tuning rationale live together). The new file's header documents the relation to `ARGON2_OPTIONS.memoryCost` / `time` and the visibility nudge to revisit the floor if those tune.

Migrated three duplication sites to import from the shared module:
- `backend/tests/routes/recover.test.ts` (FLOOR + CEILING)
- `backend/tests/routes/signup-verify.test.ts` (FLOOR)
- `backend/tests/routes/auth-concurrency.test.ts` (FLOOR) — third site beyond the two listed in the hold block; same duplication-rationale applies

Replaced the local `const` declarations with short comments pointing at `tests/support/timing-constants.ts`. Updated the comment block at `backend/src/routes/auth.ts:210` to reference the shared constant rather than naming `recover.test.ts` as the home.

Verification:
- `npm run lint` — clean (only pre-existing accepted `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts`).
- `npx vitest run tests/routes/{auth-concurrency,signup-verify,recover}.test.ts` — 3 files / 37 tests passed against real Postgres + Redis.
