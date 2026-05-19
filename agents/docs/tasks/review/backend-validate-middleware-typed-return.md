# BACKEND-VALIDATE-MIDDLEWARE-TYPED-RETURN — teach `validate(zodSchema)` to return a typed handler so `req.body` carries the inferred type

**Owner:** Backend Agent
**Created:** 2026-05-18 (architect, surfaced by cluster-B `/ce-code-review` on `backend-verify-cap-redis-flap-recovery` round-1 — kieran-typescript KT-1)
**Priority:** P3

## Problem

Express types `req.body` as `any`. The repo-wide `validate(zodSchema)` middleware (presumably at `backend/src/validation.ts`) runs before the handler and assigns `req.body = result.data` from the zod `safeParse`. At runtime the body shape is guaranteed; at compile time, every handler that reads `req.body.X` must either cast (`req.body.X as string`), destructure with a cast (`const { X } = req.body as z.infer<typeof schema>`), or live with `any`. The current pattern in `backend/src/routes/admin.ts` post-validate uses two `as string` casts on `req.body.token` (one in the 403 audit log, one in the happy path), which is mechanically safe but creates a permanent drift surface: if `validate` is ever refactored to NOT reassign `req.body`, the casts hide the loss of guarantee.

The right shape is for `validate(schema)` to return a typed middleware so route handlers inherit the inferred body type from the schema directly, eliminating per-handler casts.

## Goal

Make `validate(zodSchema)` produce a typed `RequestHandler` such that route handlers downstream of it read `req.body` with the inferred zod type, no cast needed.

## Acceptance

1. `backend/src/validation.ts` (or wherever `validate` lives) — `validate<T extends z.ZodTypeAny>(schema: T)` returns a middleware typed as `RequestHandler<{}, any, z.infer<T>>` (or equivalent — Express's generic positional parameters require care; the key win is `req.body: z.infer<T>` at the handler).
2. At least three existing post-validate `as` casts in the codebase are removed and replaced with direct field reads. Recommended sweep targets:
   - `backend/src/routes/admin.ts` — two `req.body.token as string` casts.
   - Any other site discovered via repo-wide grep for `req\.body\.\w+ as` patterns immediately after a `validate(...)` middleware.
3. The validate middleware infrastructure change itself must not break any existing route's body-handling. Run the full backend test suite to verify.
4. Add a JSDoc on the `validate` export documenting the typed-return contract so future route authors can rely on it without casts.

## Out of scope

- Migrating zod schemas themselves. The shape `accreditationVerifySchema`, `loginSchema`, etc. are stable.
- Validating query params or path params. Express's type generics are messier for `req.query` / `req.params`; this task scopes to `req.body` only.
- Switching from zod to a different validator. Schema-tool choice is settled.

## References

- `backend/src/validation.ts` (the `validate` middleware)
- `backend/src/routes/admin.ts` (the two casts that motivated this task)
- `backend/src/routes/**` (sweep target for remaining `as` casts)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
