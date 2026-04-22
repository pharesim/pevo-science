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
