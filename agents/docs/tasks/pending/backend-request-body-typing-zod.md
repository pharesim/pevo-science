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
