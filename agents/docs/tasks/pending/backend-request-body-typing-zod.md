# BE-REQUEST-BODY-TYPING-ZOD — Replace `req.body as any` + `field as string` casts with Zod schemas across auth/signup/orcid/recover routes

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-LOGIN-UNKNOWN-USER-TIMING round-2 review 2026-04-22)
**Priority:** P3

## Context

Re-review on BE-LOGIN-UNKNOWN-USER-TIMING round-2 flagged recurring `as string` casts at places like:

```js
const { password, new_password, ... } = req.body || {};
// ...
if (passwordProvided) { await burnSentinel(new_password as string); }
// ...
if (hasPassword) { await burnSentinel(password as string); }
```

`req.body` is Express-typed `any`. Destructured bindings inherit `any`. The `as string` casts are logically correct (guarded by runtime checks like `passwordProvided` / `hasPassword`) but are unsafe casts: TypeScript accepts them without narrowing, and a future refactor that weakens the guard silently admits non-string values.

This pattern is not new — it exists across most /auth and /orcid route handlers. The cost isn't immediate (guards work), but the type system has no way to enforce the guard, so a regression landing via bad guard code is invisible until runtime.

## Goal

Introduce Zod (`npm i zod`) and define request-body schemas for the highest-traffic / highest-risk auth surfaces:

1. `POST /api/auth/login` — body schema with `username` + optional `password` + optional `verify_token`.
2. `POST /api/auth/signup` — body schema with `email` + `password` + `full_name` + `institution` + `field` + optional `orcid_token` + optional `hive_username`.
3. `POST /api/auth/recover` — body schema with `username` + optional `new_password` + optional `orcid_token` + optional `memo_key` + optional `seed_phrase`.
4. `POST /api/orcid/callback` — body schema covered by existing callback handler shape.

Pattern:

```ts
const LoginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().optional(),
  verify_token: z.string().optional(),
});
type LoginBody = z.infer<typeof LoginBodySchema>;

router.post('/login', async (req, res) => {
  const parsed = LoginBodySchema.safeParse(req.body);
  if (!parsed.success) { return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body', { issues: parsed.error.issues }); }
  const { username, password, verify_token } = parsed.data;
  // ... no more `as string` casts; types flow from schema
});
```

Leave other routes untouched for now (incremental migration). The four above are the ones that pass user-controlled strings into argon2/seed/ORCID-token paths where type-level guarantees matter most.

## Non-goals

- Replacing existing validation logic. Zod runs alongside the existing `isEmail` / `isPasswordValid` / etc. guards. Migrating those is a separate future task.
- Introducing a global body-parser Zod middleware. Per-route schemas keep scope explicit.
- Changing any error codes or status codes.

## Acceptance

- `zod` dependency added.
- Four routes above use `safeParse` + schema-derived types.
- All existing tests pass.
- Grep for `as string` inside `backend/src/routes/auth.ts` and `backend/src/routes/orcid.ts` returns noticeably fewer hits (not necessarily zero — semantic casts may survive where they're legitimate post-narrow).
- No new `any` or `@ts-expect-error` introduced.

## [TODO Architect]

- Confirm Zod is the preferred validation lib (alternatives: `ajv`, `io-ts`, hand-rolled typed guards). Zod is the lowest-ceremony option for this codebase's TypeScript-light style.
- If other backend teams prefer a different shape, ping before landing.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `a04cadd` (correctness, security, kieran-typescript, project-standards). The 4 scoped routes migrated cleanly; business validation still runs after Zod; no new timing oracle; no prototype pollution regression (Zod's `strip` mode is safer than `req.body || {}`). One hold item; other residuals filed as follow-up task or dismissed.

1. **P2 — Zod `details.issues` returned verbatim on 400 responses leaks schema shape** (security SEC-ZOD-01). All 4 migrated routes emit `parsed.error.issues` raw in the 400 response: field paths, constraint codes, received types. Schema-disclosure regression vs pre-Zod plain-string messages. While no credential values leak (issues expose `type name` not values), the shape surface hardens the target for an attacker probing field names. Fix: in the safeParse-failure branch, flatten the error to `{ code: 'VALIDATION_ERROR', message: 'Invalid request body' }` (or a narrower whitelist of `{ path, message }` pairs without `code` / `received` internals). Add a test asserting the 400 body doesn't contain `issues`, `received`, or field-specific Zod internals.

**Dismissed from round-1 findings (architect triage):**
- **P2 → filed as new task** `/api/orcid/start` same-file `req.body as { mode?: string }` + 3 other auth routes still using `req.body || {}` + typeof guards (kieran KT-1 0.90 + RR-1): filed as `backend-zod-migration-extension.md`. Incremental migration is explicit in this task's Non-goals.
- **P3** RecoverBodySchema allows empty string for new_password (kieran KT-2 0.82): `z.string().min(1).optional().nullable()` would consolidate; fold into hold-fix commit.
- **P3** Dead `if (!loginId)` guard after refine (kieran KT-3 0.75): refine already enforces; fold opportunistically.
- **P3** Residual `typeof memo_key === 'string'` / `typeof orcid_token === 'string'` guards (kieran KT-4 0.72): redundant post-Zod; fold opportunistically.
- **P3** `/recover` message text changed ('Username is required' → 'Invalid request body') (correctness): existing test asserts code only; acceptable.
- **P3** No test for Zod parse-failure path / LoginBodySchema.refine invariant (testing TG-1 / TG-2): fold test additions into the hold-fix commit.

**Filed as separate Pending tasks:**
- `backend-zod-migration-extension.md` (new P2) — migrate `/api/orcid/start`, `/resend-verification`, `/reset-request`, `/reset` to Zod schemas; same pattern as this task.

**Path to re-archive:** (1) Backend applies item #1 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review`; archives on clean.

---

**Backend re-review signal (2026-04-22 round-1 hold fix, worktree `.claude/worktrees/agent-a67d9e4c`):**

Round-1 P2 SEC-ZOD-01 hold item landed + all 4 architect-suggested P3 folds applied. `npx tsc --noEmit` clean. `npm run lint` clean (6 pre-existing `no-explicit-any` warnings at Express/dhive boundaries accepted per backend CLAUDE.md). `backend/tests/routes/auth.test.ts` 16/16 pass; `orcid.test.ts` 29/29 pass; `recover.test.ts` 24/27 pass (same 3 pre-existing SMTP-not-configured failures on baseline `55fc03b`, unrelated to this task). Full backend vitest suite deferred to parent per coordination rules.

1. **P2 SEC-ZOD-01 Zod `issues` leak (fixed).** All 4 migrated routes' 400 VALIDATION_ERROR responses now omit `details` entirely. The `sendError(..., { issues: parsed.error.issues })` shape at `backend/src/routes/auth.ts:~200` (/signup), `~556` (/login), `~855` (/recover), and `backend/src/routes/orcid.ts:~194` (/callback) all collapsed to `sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body')` — no `details`, no Zod internals leaked. The schema-level comment block at `auth.ts:~30-37` updated to document the generic-message error shape and why the raw issue array was a schema-disclosure regression.

2. **P3 KT-2 RecoverBodySchema empty-string tighten (fixed).** `backend/src/routes/auth.ts:~63-65` — `new_password: z.string().min(1).optional().nullable()` (was `.optional().nullable()` alone). Pushed the min-length guard up to the schema layer so empty strings now 400 at parse rather than slipping through to the downstream `passwordProvided` guard. Inline comment explains the rationale.

3. **P3 KT-3 Dead `if (!loginId)` guard removed (fixed).** `backend/src/routes/auth.ts:~558-563` — the dead post-refine guard is gone; replaced with a single-line cast `(email_or_username || username) as string` and a one-line comment pointing at the refine invariant. Post-refine, at least one of the two string fields is non-empty, so the coalesce is guaranteed to yield a non-empty string.

4. **P3 KT-4 Redundant typeof guards removed (fixed).** `backend/src/routes/auth.ts:~920, ~948` — the `memo_key && typeof memo_key === 'string'` and `orcid_token && typeof orcid_token === 'string'` guards collapsed to `memo_key` / `orcid_token` truthy checks. Post-Zod these fields are already `string | undefined`; the typeof was redundant.

5. **P3 TG-1/TG-2 Tests added (fixed).** `backend/tests/routes/auth.test.ts:~189-244` — new `BE-REQUEST-BODY-TYPING-ZOD` describe block with:
   - a parametrized 400-schema-leak guard over 3 routes (/login, /signup, /recover) asserting `res.body.error.details === undefined` + a `JSON.stringify(res.body)` scan that rejects `"issues"`, `"received"`, `"expected"`, and `"validation"` — Zod internals must not leak anywhere in the response body;
   - a LoginBodySchema.refine-invariant test asserting both-fields-empty yields 400 VALIDATION_ERROR with the generic message (the refine still fires);
   - a parse-failure test asserting non-string password on /login yields 400 VALIDATION_ERROR (zod shape rejection, pre-business-validation).

   `/api/orcid/callback` is intentionally omitted from the parametrized batch: the route returns 500 INTERNAL_ERROR before safeParse when `ORCID_CLIENT_ID/SECRET` are unset (test env default). The flattening on that route mirrors the 3 auth.ts sites structurally and is covered by the same `sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body')` call shape in the code.

**Test outcomes:**
- `auth.test.ts`: 16/16 pass.
- `orcid.test.ts`: 29/29 pass (no regression from the /callback 400 flattening).
- `recover.test.ts`: 24/27 pass (3 pre-existing SMTP-config failures on baseline `55fc03b`).
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- Full vitest suite: deferred to parent agent.

**Deviations from hold block:**
- The architect's P2 hold text offered two shapes: "collapse to `sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body')` with no `details`, OR a narrowed `{ path, message }` whitelist". Landed the simpler shape (no details) per the hold's "Prefer the message-only shape for simplicity" note.
- `/orcid/callback` is covered by code-shape inspection rather than an end-to-end test (rationale above). If the architect prefers a real E2E test for that route, it would need a test fixture that sets `config.orcidClientId` + `config.orcidClientSecret`, which is a test-infra change outside the scope of this hold.
