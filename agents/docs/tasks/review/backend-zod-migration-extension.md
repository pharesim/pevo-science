# BE-ZOD-MIGRATION-EXTENSION — Migrate remaining `req.body as any` / `as string` cast sites to Zod

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-REQUEST-BODY-TYPING-ZOD first-review)
**Priority:** P2

## Context

`BE-REQUEST-BODY-TYPING-ZOD` migrated 4 auth/orcid routes (`/login`, `/signup`, `/recover`, `/callback`) to Zod body schemas. The migration was explicitly incremental — leaving unmigrated sites for future tasks. First-review surfaced two classes of residual sites:

1. **Same-file miss: `POST /api/orcid/start`** at `backend/src/routes/orcid.ts:143` still uses `req.body as { mode?: string }`. Same file the commit touched; same pattern the commit set out to eliminate. (F12.1, kieran KT-1 0.90.)

2. **Sibling auth routes:** `/resend-verification` (line ~434), `/reset-request` (line ~680), `/reset` (line ~770) still use `req.body || {}` + `typeof field !== 'string'` guards. (Kieran RR-1.)

## Goal

Extend the Zod schema approach to:

1. `POST /api/orcid/start` — add `OrcidStartBodySchema` with the narrow `{ mode?: string }` shape, safeParse + VALIDATION_ERROR 400 on failure.
2. `POST /api/auth/resend-verification` — body shape is email + password.
3. `POST /api/auth/reset-request` — body shape is email.
4. `POST /api/auth/reset` — body shape is token + new_password.

Each route's schema lives next to the existing 4 (grouped at the top of `auth.ts`). Business validation (`isEmail`, `isPasswordValid`) continues to run after Zod parse.

## Non-goals

- Replacing existing business validation. Zod is shape-only.
- Global body-parser Zod middleware. Per-route schemas keep scope explicit.
- Changing error codes or status codes.
- Hardening the `details.issues` raw-leak in the 400 response (tracked as F12.2 round-N hold on the original task).

## Acceptance

- Zod schemas added for the 4 listed routes.
- `grep -E 'as string|as \{.*\?\:' backend/src/routes/{auth,orcid}.ts` returns noticeably fewer hits.
- No new `any` or `@ts-expect-error` introduced.
- Full backend vitest clean; `npx tsc --noEmit` clean.

## [TODO Architect]

None initial. See implementation signal below for one contract-update `[TODO Architect]` on the `isPasswordValid` type-predicate change.

---

**Backend implementation signal (2026-04-22 round-1, worktree `.claude/worktrees/agent-a67d9e4c`):**

Full scope landed. `npx tsc --noEmit` clean. `npm run lint` clean (6 pre-existing `no-explicit-any` warnings accepted per backend CLAUDE.md). Directly-affected tests: `auth.test.ts` 16/16, `recover.test.ts` 27/27, `orcid.test.ts` 29/29, `signup-verify.test.ts` 2/2, `auth-concurrency.test.ts` 2/2. Full backend vitest suite deferred to parent.

1. **POST /api/orcid/start (migrated).** `backend/src/routes/orcid.ts:22-32, ~153-161` — new `StartBodySchema = z.object({ mode: z.string().optional() })` with docblock noting that VALID_MODES membership is enforced as business validation post-parse (matching the existing auth.ts schemas). The `req.body as { mode?: string }` cast is gone; safeParse returns 400 VALIDATION_ERROR with the same flat `'Invalid request body'` shape as the round-1 schemas (no `details.issues` leak). The subsequent VALID_MODES check retains its distinct error message ("mode must be one of: ...") so frontend callers can surface the accepted-values list.

2. **POST /api/auth/resend-verification (migrated).** `backend/src/routes/auth.ts:~96-100, ~500-504` — new `ResendVerificationBodySchema = z.object({ email: z.string().min(1), password: z.string().min(1) })`. The `typeof email !== 'string'` + `typeof password !== 'string'` guards are gone; both are now shape-enforced by Zod. Existing tests (e.g. the `/resend-verification` timing specs in recover.test.ts) continue to pass.

3. **POST /api/auth/reset-request (migrated).** `backend/src/routes/auth.ts:~102-104, ~738-742` — new `ResetRequestBodySchema = z.object({ email: z.string().min(1) })`. The `typeof email !== 'string'` guard is gone; `email` is now `string` post-parse.

4. **POST /api/auth/reset (migrated).** `backend/src/routes/auth.ts:~106-109, ~828-832` — new `ResetBodySchema = z.object({ token: z.string().min(1), password: z.string().optional() })`. Note: Kept `password: z.string().optional()` rather than `.min(1)` because `isPasswordValid` below handles the empty/missing case with a more informative error message (PASSWORD_POLICY_MESSAGE) — forcing `.min(1)` at the Zod layer would swallow the policy-message channel for empty-password callers. The existing 400 VALIDATION_ERROR path now fires BEFORE `isPasswordValid` when the body isn't an object at all.

5. **`isPasswordValid` type-predicate (opportunistic fold).** `backend/src/lib/password-policy.ts:9` — signature changed from `pw: unknown): boolean` to `pw: unknown): pw is string`. This lets TS flow-narrow the argument after the truthy check, which in turn lets `argon2.hash(password, ARGON2_OPTIONS)` in the `/reset` handler compile without an `as string` cast. No caller behavior changes: the guard still returns true/false identically. All 2 existing callers (auth.ts `/signup` and `/reset`) were already relying on the boolean return; the type predicate strictly adds compile-time narrowing.

**Acceptance grep:**
- Before this commit: 9+ hits of `as string|as \{.*\?\:` in routes/auth.ts + routes/orcid.ts.
- After: 8 hits, **all of which are now either comments referencing the previous casts, JSON.parse type casts (unrelated to req.body), or the one intentional `(email_or_username || username) as string` narrow at `/login` that keys off the refine invariant (round-1 hold fix for BE-REQUEST-BODY-TYPING-ZOD)**. The req.body-typing cast class is fully eliminated.

**Test outcomes:**
- `auth.test.ts`: 16/16 pass (added `beforeAll(clearRateLimitKeys(['auth-login','auth-signup']))` to the Zod-leak describe block because auth-concurrency.test.ts now burns 8 /login attempts against the 10/hr loginLimiter; without the clear, later tests 429 instead of 400).
- `orcid.test.ts`: 29/29 pass (no regression from the /orcid/start Zod migration).
- `recover.test.ts`: 27/27 pass.
- `signup-verify.test.ts`: 2/2 pass.
- `auth-concurrency.test.ts`: 2/2 pass.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- Full vitest suite: deferred to parent.

**Deviations from acceptance:**
- Task brief named `/api/auth/reset` body fields as `token + new_password`, but the handler field name is `password` (pre-existing). Kept `password` to avoid a breaking API change; the Zod schema matches the handler's actual field name. If the architect intended a rename, that's a separate API-contract change.

**`[TODO Architect]`:**
- The `isPasswordValid` signature change from `boolean` to `pw is string` is a tightening (no runtime behavior change) but is observable via TypeScript type flow. If any doc/API contract references the helper's signature, it should be updated. Not expected to touch api-contracts/*.md since that file describes REST shapes, not internal helper signatures.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `933352c` (correctness persona). All 4 migrated routes (/orcid/start, /resend-verification, /reset-request, /reset) correctly adopt `safeParse` + 400 VALIDATION_ERROR shape matching round-1. `isPasswordValid` type-predicate opportunistic fold is sound. One P2 hold item on testing coverage; two low-confidence residuals dismissed.

1. **P2 — Zod-leak regression test coverage missing on the 4 new routes** (correctness C2 0.85). `backend/tests/routes/auth.test.ts:~215-222` `BE-REQUEST-BODY-TYPING-ZOD` describe block covers /login + /signup + /recover only. None of the 4 routes migrated by this task have a parse-failure + no-issues-leak assertion. A future refactor emitting `res.status(400).json({ ...zodResult.error })` on one of the 4 new routes passes CI silently, reopening the SEC-ZOD-01 issue-leak class round-1 closed. Fix: extend the `cases` array (or add a parallel describe block) to include /resend-verification + /reset-request + /reset + /orcid/start. Note: /orcid/start has an ordering wrinkle — the Zod parse runs AFTER the ORCID config check; test env without `ORCID_CLIENT_ID/SECRET` returns 500 before 400. Either (a) set those env vars in the test, or (b) document the ordering and skip /orcid/start with explicit comment + assert via a code-shape grep instead.

**Dismissed from round-1 findings (architect triage):**
- **P3 C1** `isPasswordValid` type-predicate redundant after `passwordProvided` guard in /recover (0.62): harmless; future callers skipping the guard would hit runtime narrowing that's correct.
- **P3 C3** `ResetBodySchema.password: z.string().optional()` accepts `''` (0.72): intentional two-layer design (policy gate handles empty-string + PASSWORD_POLICY_MESSAGE). Test pin is optional; defer unless operator reports a regression.
- RR1/RR2 testing infrastructure notes: accepted residual.

**Path to re-archive:** (1) Backend applies item #1 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2; archives on clean.

---

**Backend re-review signal (2026-04-22, worktree agent-af344d23):**

P2 "extend Zod-leak regression test coverage to the 4 round-2 migrated routes" fix landed. Only `backend/tests/routes/auth.test.ts` modified.

1. **Extended the parametrized `cases` array** in the `BE-REQUEST-BODY-TYPING-ZOD: 400 VALIDATION_ERROR does not leak Zod schema shape` describe block with 3 new HTTP round-trip cases:
   - `/api/auth/resend-verification` — body `{ email: 123, password: 'x' }` (non-string email fails `ResendVerificationBodySchema.safeParse`).
   - `/api/auth/reset-request` — body `{ email: 123 }` (non-string email fails `ResetRequestBodySchema.safeParse`).
   - `/api/auth/reset` — body `{ token: 123, password: 'NewPass123!' }` (non-string token fails `ResetBodySchema.safeParse`).
   Each new case runs the same assertions as the round-1 cases: 400 status, `status:'error'`, `error.code:'VALIDATION_ERROR'`, `error.message:'Invalid request body'`, `error.details === undefined`, and a deep-stringified body that contains none of `"issues"`, `"received"`, `"expected"`, `"validation"`.

2. **`/orcid/start` handled via option (b) — source-shape grep, not a live HTTP round trip.** The ordering wrinkle (documented inline in the describe-block header comment) is: the `/start` handler returns 500 `INTERNAL_ERROR` ("ORCID integration is not configured") BEFORE `StartBodySchema.safeParse` whenever `config.orcidClientId` or `config.orcidClientSecret` is unset, which is the default test-env state. Plumbing real ORCID creds solely to reach the parse branch adds a large test-harness surface for one assertion. Instead, `/api/orcid/start uses StartBodySchema.safeParse with the flat VALIDATION_ERROR shape` reads `backend/src/routes/orcid.ts` via `readFileSync` and asserts the three structural invariants that the live tests cover for the other routes: `z.object(` schema decl, `StartBodySchema.safeParse(req.body)` call, and the literal `sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body')` forwarding (no `details` arg = no issues leak). Uses `import.meta.dirname` (Node 20, matches the module-Node16 ESM config) to resolve the source path.

3. **Rate-limit pre-clear extended.** `beforeAll(clearRateLimitKeys([...]))` now clears `auth-resend` (3/hr), `auth-reset-request` (5/hr), and `auth-reset` (5/hr) in addition to the prior `auth-login` / `auth-signup`. Each of the new routes has a tighter hourly window than `/login` (10/hr), so they're more vulnerable to cross-test-file ordering flakes; one clear per windowMs at beforeAll is cheap insurance.

**Test outcomes:**
- `auth.test.ts`: **20/20 pass** (up from 16/16, reflecting the 3 new parametrized HTTP cases + 1 new /orcid/start structural case).
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (same 6 pre-existing `no-explicit-any` warnings as round-1; zero new findings).
- No source file modified; no other test file modified. Scope strictly matches the held-pending-fix brief.
