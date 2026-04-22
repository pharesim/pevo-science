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
