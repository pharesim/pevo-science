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

---

## Architect re-review (2026-05-11) — HELD PENDING FIXES

Re-review of commit `04fddee` via `/ce-code-review` invoked directly from the architect context. Reviewer team: correctness, testing, maintainability, project-standards, learnings, security. Sonnet tier for the non-correctness/security personas per the fan-out rule.

### Items held (must fix before archive)

1. **Stale `VITEST` gate cross-reference in `backend/src/lib/argon2-semaphore.ts:495-496`.** The docblock above `drainArgon2Queue` reads:

   > *"Mirrors the `process.env.VITEST` gate at routes/auth.ts:153-160 for the UV_THREADPOOL_SIZE assertion."*

   Commit `04fddee` removed that gate (now a bare block; no `if (!process.env.VITEST)` conditional; no line range 153-160). The cross-reference is rotted documentation introduced by this same cleanup pass.

   Suggested rewrite:

   > *"Mirrors the defense-in-depth UV_THREADPOOL_SIZE startup assertion at routes/auth.ts (the bare-block check immediately before SENTINEL_ARGON2_HASH_PROMISE)."*

   Drop the line numbers — they will rot again on the next edit. Keep the docblock anchored to a stable symbol name (`SENTINEL_ARGON2_HASH_PROMISE`), not line numbers.

   Note: the standalone VITEST guard at `argon2-semaphore.ts:499` (`if (process.env.VITEST || process.env.NODE_ENV === 'test')`) is functionally independent of `routes/auth.ts` and remains intact. Only the docblock cross-reference needs updating.

### Dismissed at triage (recorded for transparency; do not implement)

- **No negative-path test for the UV_THREADPOOL_SIZE startup assertion.** Surfaced by testing + correctness + security reviewers (testing finding T-01, plus testing_gaps on correctness/security). Dismissed: the "every test file fails on a vitest.config.ts regression" property is genuinely strong protection. A child-process startup-assertion test would add spawn isolation, env scrubbing, and CI-worker variance for marginal coverage of a non-runtime path. P3 + low-conviction → not worth adding.

### Advisory items (decided at triage; no action requested)

- **Derivation-chain question (`verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md`).** Cleanup stripped the `16/4=4` arithmetic from BOTH `.env.example` AND the `auth.ts` comment. Judged acceptable: the startup assertion now fails loud at the right moment with a clear message ("UV_THREADPOOL_SIZE must be >= 16 for burnSentinel determinism"). The convention's "Right" example included inline math because no assertion existed at the time; the assertion is the stronger mechanical guarantee.
- **Past-tense "semaphore landed" claim.** Per `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`, claims of universal wrapper coverage should be grep-verified. Verified at re-review: 40 `runWithArgon2Slot` references across `backend/src/`. Claim is grounded.

### Project-standards finding (timeline-corrected, not actionable)

The project-standards reviewer flagged `.env.example` as architect-zone staged under a `backend:` prefix without `[skip-zone-audit]` (anchor 95). Timeline-verified: the commit-zone-audit hook landed in `a8ffb41` on **2026-04-30**, eight days AFTER this commit (`04fddee`, 2026-04-22). The hook did not exist at commit time, so "should have been rejected by the hook" doesn't apply. The cross-zone `.env.example` edit was task-authorized convention before the mechanical backstop existed. Future analogous cross-zone work needs `[skip-zone-audit]`.

When item 1 lands, `git mv` this file back to `tasks/review/` for re-review and archive.

---

## Architect coordination note (2026-05-11) — please commit a re-review signal block

Backend agent: commit `ff3ed4f` landed the M-01 fix on `backend/src/lib/argon2-semaphore.ts` (anchor docblock to `SENTINEL_ARGON2_HASH_PROMISE` per the suggested rewrite) AND moved this file from `pending/` back to `review/`. That alone is the protocol-mandated re-review signal (rule #8: "the move itself is the re-review signal").

However: I noticed an earlier draft of a "## Backend re-review signal (2026-05-11, main)" block was left unstaged in the working tree alongside `ff3ed4f` and was lost when the architect re-reviewed adjacent state. Please append a fresh signal block summarizing:
- The M-01 fix shape that landed (file:line, the suggested rewrite applied)
- Whether `SENTINEL_ARGON2_HASH_PROMISE` was verified as the stable anchor symbol
- Confirmation that `argon2-semaphore.ts:499`'s standalone VITEST guard was left untouched
- Verification commands run (typically `npx tsc --noEmit`, relevant vitest paths)

Pattern reference: the original "## Backend re-review signal (2026-04-22, worktree agent-a1adad05)" block above is the structural template.

Once committed, architect re-reviews the diff at `ff3ed4f` against the M-01 fix shape + the signal block context, then archives.
