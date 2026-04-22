# BE-P3-CLEANUP-SWEEP — Five P3 comment/test-hygiene items across tasks 1, 7, 9

**Owner:** backend
**Created:** 2026-04-22 (architect review pass aggregation)
**Priority:** P3

## Context

Architect review on 2026-04-22 surfaced 5 low-priority cleanup items across tasks that otherwise archived cleanly (BE-ARGON2-CONCURRENCY-CAP, SEC-002-TOCTOU-LOCK, BE-SIGNUP-INSTITUTIONAL-GATE-ORDERING). Bundled here so their parent tasks can archive without carrying trivial residuals.

## Items

1. **Stale comment in `backend/src/routes/auth.ts`** — the comment block above `SENTINEL_ARGON2_HASH_PROMISE` says "The semaphore (when landed) will relax this to advisory." The semaphore (`lib/argon2-semaphore.ts`, via commit 3e6f093) IS landed. Rewrite the sentence past tense, or drop the "when landed" conditional.

2. **`.env.example` UV_THREADPOOL_SIZE arithmetic disclosure** — current comment exposes the saturation math: "argon2 parallelism=4 holds 4 threads per call; 16/4 = 4 concurrent argon2 ops." Soften: `"libuv thread pool size; see backend/src/routes/auth.ts for derivation. Default 16 meets the startup assertion."` Reduces attacker reconnaissance value while keeping operator guidance.

3. **VITEST gate → `vitest.config.ts`** — current gate on the startup assertion at `backend/src/routes/auth.ts:~136` uses `if (!process.env.VITEST) { ... }`. Cleaner: set `UV_THREADPOOL_SIZE=16` in `vitest.config.ts` `env:` block, remove the VITEST conditional. Removes the env-injection bypass class (VITEST=true at deploy-time suppressing the guard) and keeps production behavior identical.

4. **"10 chars" nonce comment in `backend/tests/routes/orcid.test.ts`** (SEC-002-TOCTOU-LOCK round-5 nonce-drift test) — the comment says "10 chars" for the short hex buffer but it's actually 20 hex characters (10 bytes × 2 from `.toString('hex')`). Fix to "20 chars" or rewrite as "10 bytes → 20 hex chars, fails 32-hex regex."

5. **Missing `afterAll` in `backend/tests/routes/recover.test.ts`** (BE-SIGNUP-INSTITUTIONAL-GATE-ORDERING 422 fast-return block) — the warmup email `signup_422_warmup_*@mit.edu` inserts a valid pending institutional-signup row that the global cleanup (which matches `username LIKE 'recover_%'`) doesn't remove. Orphan rows accumulate across CI runs. Add an `afterAll(() => pool.query("DELETE FROM accounts WHERE username LIKE 'signup_422_%'"))` to the describe block.

## Non-goals

- Extending the lint rule set (separate task: `backend-enable-eslint-ts-rules`).
- Rewriting the `.env.example` more broadly.

## Acceptance

- All 5 items applied.
- `npx tsc --noEmit` clean.
- Full backend vitest passes.
- Startup behavior unchanged in production + docker-compose; dev-Docker + bare-metal also unchanged.

## [TODO Architect]

None — cosmetic/hygiene sweep.

## Backend re-review signal (2026-04-22, worktree agent-a1adad05):

All 5 items landed:

1. `backend/src/routes/auth.ts` — rewrote the comment block above `SENTINEL_ARGON2_HASH_PROMISE`. The "semaphore (when landed) will relax this to advisory" conditional is gone; the comment now states past-tense that the semaphore landed at `lib/argon2-semaphore.ts` and enforces the deterministic JS-level cap, with the env check as defense-in-depth libuv headroom. Did NOT touch any `runWithArgon2Slot` call sites.

2. `.env.example` — softened the `UV_THREADPOOL_SIZE` comment. Dropped the "argon2 parallelism=4 holds 4 threads per call; 16/4 = 4 concurrent argon2 ops" arithmetic disclosure. New comment points at `backend/src/routes/auth.ts` for derivation and states "Default 16 meets the startup assertion." Env var line preserved.

3. `backend/src/routes/auth.ts` + `backend/vitest.config.ts` — removed the `if (!process.env.VITEST)` wrapper around the startup assertion (now a bare block). `backend/vitest.config.ts` now sets `UV_THREADPOOL_SIZE: '16'` inside the `env:` block (merged with `loadEnv(...)` spread). Verified with `env -u UV_THREADPOOL_SIZE npx vitest run tests/routes/auth-concurrency.test.ts` — the assertion fires and passes via the vitest-injected value alone.

4. `backend/tests/routes/orcid.test.ts` — fixed the "10 chars" comment in the SEC-002-TOCTOU-LOCK nonce-drift test to "Short buffer (10 bytes → 20 hex chars via .toString('hex')) fails the 32-hex regex."

5. `backend/tests/routes/recover.test.ts` — added `afterAll` to the `BE-SIGNUP-INSTITUTIONAL-GATE-ORDERING: 422 on non-duplicate unaccredited email is fast` describe block. Note: the architect's suggested SQL (`username LIKE 'signup_422_%'`) would not match because the signup insert sets `email` but not `username` (username is assigned later on verify). Changed the cleanup to `email LIKE 'signup_422_%'` to actually delete the orphan warmup rows. Consistent with the sibling SMTP describe block at line ~1262 which also cleans by email.

Verification:
- `npx tsc --noEmit` clean (no errors).
- `npm run lint` clean (2 pre-existing unrelated `no-explicit-any` warnings in `seed-phrase.ts`).
- `tests/routes/auth.test.ts` 20/20 pass.
- `tests/routes/orcid.test.ts` + `tests/routes/auth-concurrency.test.ts` 39/39 pass.
- `tests/routes/recover.test.ts` 30/30 pass (including new afterAll block).
- `env -u UV_THREADPOOL_SIZE npx vitest run tests/routes/auth-concurrency.test.ts` passes — confirms vitest.config.ts env injection is authoritative and the unwrapped assertion behaves correctly under test.
