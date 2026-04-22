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
