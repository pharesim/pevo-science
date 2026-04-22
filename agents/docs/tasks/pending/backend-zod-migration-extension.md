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

None.
