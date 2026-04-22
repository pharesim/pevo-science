# BE-ENABLE-ESLINT-TS-RULES — Add minimal ESLint config enforcing no-floating-promises and no-explicit-any where narrow is feasible

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-LOGIN-UNKNOWN-USER-TIMING round-2 review 2026-04-22)
**Priority:** P3

## Context

Re-review on BE-LOGIN-UNKNOWN-USER-TIMING round-2 surfaced two infrastructure gaps:

1. **Dead eslint-disable comments in production code** — `backend/src/routes/auth.ts:47` carries `// eslint-disable-next-line @typescript-eslint/no-explicit-any` despite the repo having **no ESLint configuration at any level**. The rule doesn't exist; the suppress comment misleads reviewers into thinking it's silencing a real check.

2. **`Promise<void>` doesn't enforce await at call sites** — `burnSentinel()` returns `Promise<void>`. TypeScript accepts callers that forget `await` (fire-and-forget). A future implementer adding a burn site without `await` silently reopens the timing oracle the helper exists to close. `@typescript-eslint/no-floating-promises` would catch this at lint time; without the rule, the only defense is code review.

These are latent infrastructure debts. Adding a minimal ESLint config closes both with a one-file change.

## Goal

1. Add `eslint.config.js` (flat config) at repo root (or `backend/eslint.config.js` if scoped to backend).
2. Enable the minimum viable rule set for safety-critical patterns this codebase relies on:
   - `@typescript-eslint/no-floating-promises`: error
   - `@typescript-eslint/no-explicit-any`: warn (not error — the codebase has justified `any` at Express/dhive boundaries; make it visible without blocking)
   - `@typescript-eslint/no-unused-vars`: error with `argsIgnorePattern: '^_'`
   - `no-console`: off (pino handles logging; console is fine in tests)
3. Install `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` + `eslint`.
4. Add `npm run lint` + `npm run lint:fix` scripts to `backend/package.json`.
5. Fix all existing violations in `backend/src/` (expected small count given the codebase's discipline; delete the dead `eslint-disable-next-line` comment in auth.ts:47 as part of this pass).
6. Document in `backend/README.md` (or `CLAUDE.md`) that lint runs before commit / in CI.

## Non-goals

- Full airbnb / standard / opinionated config. Minimal safety-focused rule set only.
- Frontend ESLint. UI agent owns `frontend/`; file a separate UI task if wanted.
- Prettier. Not a linting concern.
- Strict `@typescript-eslint/strict` / `strictNullChecks` enforcement. Tightening the tsconfig is a separate larger task.

## Acceptance

- `npm run lint` from `backend/` exits 0 on a clean checkout.
- `no-floating-promises` catches a deliberate test case: add `burnSentinel('test')` without `await` in a scratch file, lint fails; remove, lint passes.
- Dead `eslint-disable` comments across `backend/src/` are either backed by a real rule (now active) or removed.
- CI-relevant hook: if the repo uses husky / lint-staged / pre-commit hooks, wire lint in. If not, file a separate task.

## [TODO Architect]

- Decide config location (repo-root vs backend-scoped). Repo-root simpler if frontend eventually adopts; backend-scoped keeps lanes clean today.
- Confirm `@typescript-eslint/no-explicit-any` should be warn (not error) given codebase pragmatics.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `f888312` (correctness, reliability, maintainability, project-standards). The lint config is minimal and focused; 5 of 6 `void` sites are correctly fire-and-forget with internal error handling; all 8 import removals + 4 `_err` renames are clean. Two hold items on reliability + maintainability; P3 residuals dismissed.

1. **P2 — `claimAccountTokens` trailing query outside try/catch; transient DB failure → unhandledRejection → `process.exit(1)`** (reliability REL-001 0.85). `backend/src/account-creation.ts:~60-63` — `claimAccountTokens` is voided at the call site. The `while` loop (line ~44) has an inner catch, but the trailing `pool.query('SELECT COUNT(*) FROM ...')` at line ~60 is outside any try/catch. If that query throws after a successful claim batch, the rejection escapes the function entirely. With `process.on('unhandledRejection')` in `index.ts` calling `process.exit(1)`, a transient DB blip at that one spot after successful claims would crash the process with no contextual log before the throw; the operator gets only the fatal `unhandledRejection` signal. Fix: wrap lines ~60-63 in try/catch with `logger.warn({ err }, 'claimAccountTokens trailing count query failed')`, mirroring the pattern in `cleanupExpiredSignups`.

2. **P3 → elevated — Test-files opt-out block in `backend/eslint.config.mjs` is dead config** (maintainability M1 0.82). The override block at lines ~47-54 disables all 4 rules for `tests/**/*.ts`, but both `lint` and `lint:fix` scripts target `eslint src/` only. Tests are never linted. The block creates future traps: (a) a developer reading the config infers tests were reviewed and deliberately exempted (not true — they were never evaluated); (b) widening lint target to `.` silently swallows `no-floating-promises` across 40+ test files. Fix options: (a) delete the dead opt-out block entirely (tests out of scope, no override needed), OR (b) widen `lint`/`lint:fix` target to `.` and keep the opt-out, documenting explicitly in a comment why tests opt out of each rule. Prefer (a) — simpler, removes misleading signal. If the team wants tests linted in future, land (b) as a separate commit.

**Dismissed from round-1 findings (architect triage):**
- **P3** Blanket tests opt-out disables `no-unused-vars` unnecessarily (maintainability M2 0.65): moot once hold #2 lands as (a).
- **P3** `no-console: off` decision not mentioned in CLAUDE.md lint section (maintainability RR 0.55): add a one-line note in `agents/backend/CLAUDE.md` § Lint/Tooling.
- **P3** `verifyHiveSignature` void: residual hang scenario if sendError itself throws (correctness C1 0.55): architecturally intended per comment; `res.once('close')` is fallback.

**Path to re-archive:** (1) Backend applies items #1-2 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2; archives on clean.

---

**Backend re-review signal (2026-04-22, worktree branch `worktree-agent-a6312774`):**

Both hold items addressed. `npm run lint` from `backend/` exits 0 (6 pre-existing `no-explicit-any` warnings on `bridge.ts` and `seed-phrase.ts` boundary code, zero errors). `npx tsc --noEmit` clean.

1. **P2 REL-001 — `claimAccountTokens` trailing count query wrapped in try/catch.** `backend/src/account-creation.ts:60-74` — the trailing `pool.query('SELECT COUNT(*) ...')` plus the two `logger.info` calls that depend on its result are now inside a `try { ... } catch (err) { logger.warn({ err }, 'claimAccountTokens trailing count query failed'); }` block, mirroring the `cleanupExpiredSignups` pattern in `backend/src/signup-cleanup.ts:16-27`. A transient DB blip on that spot after successful `claim_account` ops now logs a contextual warning instead of escaping as an unhandledRejection that would trigger `process.exit(1)` via the handler in `index.ts`.
2. **P3 elevated M1 — dead `tests/**/*.ts` opt-out block deleted from `backend/eslint.config.mjs`.** Per architect's preferred option (a): removed the entire override block (was at lines ~47-54). Tests remain out of scope (`lint` / `lint:fix` scripts still target `eslint src/`); no misleading signal remains for future readers. File is now 46 lines vs. 55, single active config block.

---

**Architect re-review (2026-04-22, round 2) — HELD PENDING FIXES:**

Round-2 `/ce-code-review` on commit `ff21b96` (8 personas: correctness, testing, maintainability, project-standards, ce-agent-native, ce-learnings-researcher, reliability, kieran-typescript). Both round-1 hold items correctly applied. Re-review surfaced one P3 structural nit worth closing before archive.

1. **P3 — `setInterval(claimAccountTokens, ...)` bypasses `no-floating-promises`** (kieran-typescript KT-001 0.65). `backend/src/account-creation.ts:~166` — the startup call at `:~164` uses `void claimAccountTokens();` (explicit discard idiom that surfaces under the lint rule). The recurring call at `:166` passes the async function directly where `setInterval` expects `() => void`. `@typescript-eslint/no-floating-promises` fires on discard-at-call-expression, not on async-assignable-to-void-callback, so the rule is silent here. Today's try/catch coverage means no live unhandled-rejection path exists, but if a future edit inside `claimAccountTokens` adds an await outside try/catch, the `setInterval` callback silently swallows the rejection. The rule cannot warn because there is no floating-promise expression at the setInterval site. Fix: `setInterval(() => { void claimAccountTokens(); }, CLAIM_INTERVAL_MS)` — matches the startup-call idiom, makes future drift lint-visible. One-line change.

**Dismissed from round-2 findings (architect triage):**
- **P3** `logger.warn` vs `logger.error` asymmetry with `signup-cleanup.ts` reference pattern (reliability REL-002 0.72 + maintainability M1 0.65, 2-reviewer agreement): the round-1 hold block explicitly specified `logger.warn`; contradicting the prior hold's stated intent now is worse than the asymmetry. The trailing count query failure is diagnostic (primary `claim_account` op already succeeded); warn is defensible. If operator experience later shows warn isn't enough signal, file a separate severity-consistency-sweep task.
- **P3** Signal block appended to `pending/` not `review/` (project-standards PS-001 0.72): process convention note, end state correct. Addressed separately this review via an `agents/backend/CLAUDE.md` rule clarification — both sequences (append-and-move same commit OR append-then-move split commits) are now explicitly permitted.
- **Pre-existing** while-loop catch at `account-creation.ts:44-58` conflates RC-exhaustion vs DB INSERT failures; INSERT fail after successful broadcast → silent on-chain/DB divergence (correctness CORR-PRE-001 0.85): pre-existing, out of this task's scope. Worth a separate task if observed in prod.

**Path to re-archive:** (1) Backend applies item #1. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-3; archives on clean.

---

**Backend re-review signal (2026-04-22 round-3, worktree branch `worktree-agent-a31de74a`):**

Single round-2 P3 hold item landed. `npm run lint` from `backend/` exits 0 (same 6 pre-existing `no-explicit-any` warnings on `bridge.ts` and `seed-phrase.ts` boundary code as round-2, zero errors). `tsc --noEmit` clean.

1. **P3 — `setInterval(claimAccountTokens, CLAIM_INTERVAL_MS)` wrapped in a voiding arrow.** `backend/src/account-creation.ts:166` — now `setInterval(() => { void claimAccountTokens(); }, CLAIM_INTERVAL_MS)`, matching the startup-call idiom at line 164 (`void claimAccountTokens();`). Without the wrap, `setInterval`'s callback-type unification silently permits a promise-returning fn and `no-floating-promises` cannot see through the callback indirection. With the wrap, the intent is explicit at the lint-visible layer and future edits can't regress the rule coverage.
