# SignupBodySchema rejects `password: null`, 400s passwordless ORCID signup (backend)

**Owner:** backend
**Created:** 2026-06-14 (architect, surfaced by the `[BLOCKED by Backend]` note on `ui-orcid-signup-recover-real-roundtrip`)

`POST /api/auth/signup` carrying `password: null` (the SEC-004 passwordless-ORCID
signup contract the frontend sends) is rejected at schema validation with
`400 VALIDATION_ERROR "Invalid request body"`, before the handler runs.

Root cause: `SignupBodySchema` in `backend/src/routes/auth.ts` declares
`password: z.string().optional()`. Zod `.optional()` accepts `string | undefined`,
not `null`, so an explicit `null` fails `safeParse`. The signup *handler* already
treats null as no-password (`hasPassword = !!(password && password.length > 0)`),
and the sibling recover schema already does the right thing
(`new_password: z.string().min(1).optional().nullable()` in
`backend/src/routes/recover.ts`). Only the schema gate is wrong.

This was reproduced against the running backend by the UI agent while driving the
ORCID signup E2E spec:
- `{...,"password":null,"orcid_token":"fake"}` -> 400 VALIDATION_ERROR
- same body with `password` omitted -> 200 (clears the schema)

## Acceptance criteria

1. In `backend/src/routes/auth.ts`, make `SignupBodySchema.password` accept null:
   `password: z.string().optional().nullable()`. Do NOT add `.min(1)` — the current
   schema has no min and the handler already treats empty string as no-password
   (`hasPassword`), so adding a min would newly 400 a previously-accepted empty
   string. The goal is strictly "additionally accept null", no other behavior change.
2. No handler change is needed — the null path is already handled downstream.
3. Test coverage (real-path per project test policy; mocked-pool only under the
   `CLAUDE.md` carve-out with a real-path companion):
   - `/signup` with `password: null` + a valid `orcid_token` clears schema
     validation (does NOT 400 VALIDATION_ERROR) and lands a row with
     `accounts.password_hash IS NULL`.
   - `password` omitted (undefined) still works (regression guard).
   - a non-null string `password` still works (regression guard).

## After the fix lands

`git mv agents/docs/tasks/blocked/ui-orcid-signup-recover-real-roundtrip.md
agents/docs/tasks/pending/` so the UI agent picks up the signup-spec re-enable at
startup. That task's `[BLOCKED by Backend] (2026-06-14, UI)` note is waiting on
exactly this schema change; the recover half is already done and passing, only the
signup half is gated on this.

## Context / out of scope

- HTTP response strings are user-facing text (no emdashes), but this change adds no
  new message — `400 VALIDATION_ERROR` simply stops firing for the null case.
- Other signup-path correctness work is tracked separately
  (`backend-signup-orcid-duplicate-409`, `backend-signup-confirm-orcid-binding-guard`,
  `backend-orcid-unique-index-boot-assertion`). This task is the one-line schema fix
  plus its tests only.

## References

- `backend/src/routes/auth.ts` — `SignupBodySchema` (the `password` field).
- `backend/src/routes/recover.ts` — `new_password` shows the correct nullable pattern.
- `agents/docs/tasks/blocked/ui-orcid-signup-recover-real-roundtrip.md` — the
  downstream E2E task this unblocks.
