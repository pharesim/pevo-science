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

## Backend implementation note (2026-06-14, working tree)

- **Schema fix (item 1).** `SignupBodySchema.password` in `backend/src/routes/auth.ts`
  is now `z.string().optional().nullable()` (added `.nullable()` only; no `.min(1)`).
  An explicit `password: null` now clears `safeParse`. `npm run typecheck` passes,
  confirming the widened `string | null | undefined` type is already handled
  downstream (no handler change needed, per item 2 — the `hasPassword` /
  `if (password)` guards treat null as falsy).
- **Coverage (item 3).** New real-path describe block in
  `backend/tests/routes/auth.test.ts` ("SignupBodySchema accepts password: null")
  under the existing `dbReachable` guard, seeding the ORCID-verification nonce
  directly:
  - `password: null` + valid `orcid_token` → not 400, 200, and the landed row has
    `accounts.password_hash IS NULL`.
  - `password` omitted (undefined) → still 200 (regression guard).
  - non-null string `password` (ORCID+email) → still 200 and `password_hash` is
    NOT NULL (regression guard).
  Full `auth.test.ts` green (26). `npm run lint` clean (the lone warning is the
  pre-existing unused-eslint-disable in `src/lib/author-supersession.ts`).
- **Downstream unblock.** Per the "After the fix lands" step and rule #6 (the
  blocking agent moves the file back), `ui-orcid-signup-recover-real-roundtrip.md`
  is `git mv`d blocked → pending in a companion `[skip-zone-audit]` commit (the
  ui-zone task file is outside backend's zone). Verified the older 06-09 seam /
  06-11 compose-stub blockers are already resolved (the 06-14 UI note confirms the
  works-stub + `ORCID_API_BASE_URL` are wired); the schema fix is the sole
  remaining blocker.

## Architect re-review (2026-06-14) — HELD PENDING FIXES:

`/ce-code-review` (correctness, security, testing, project-standards, api-contract;
ce-agent-native skipped per PEvO) clean on the substance for commit `460cd989`: the
`.nullable()` widening is purely additive (null / undefined / empty-string all route to
the no-password path; no `.min(1)`, so empty-string acceptance is preserved), and a
`password_hash IS NULL` account CANNOT be password-authenticated — the login and
resend-verification handlers guard the null/empty hash BEFORE the argon compare, and
ARCHITECTURE.md § 6.1 State C (passwordless ORCID-only) enumerates the state. api-contract
clean (`auth.md` already documents `password: null`). Two items hold archive, both in
backend-owned files:

1. **(P2) Cross-file test-cleanup collision.** The new block's `afterAll` runs
   `DELETE FROM accounts WHERE orcid LIKE '0000-0003-${suffix}-%' OR email LIKE ...`. The
   `0000-0003-${last4-of-timestamp}-NNNN` ORCID band is shared by several sibling files
   (`verifyHiveSignature-reissuedat-orcid-roundtrip`, the `settings-*-fresh-auth` and
   `settings-set-password` suites), and `vitest.config.ts` runs `maxWorkers: 2`. When a
   concurrently-scheduled sibling's timestamp last-4 coincides with this block's `suffix`,
   the wildcard `orcid LIKE` half deletes that sibling's row mid-test (the named sibling
   cleans only by username, so it does not defend itself). Low probability, but a real
   cross-file flake. Fix: make the cleanup unable to match a foreign row — scope the orcid
   arm to the exact three orcids this block seeds (or AND it with the `null_pw_` email
   prefix) rather than a `-%` wildcard over the shared band.

2. **(P3) `SEC-004` tracking-id in the new source comment.** The new comment labels itself
   `SEC-004`, which resolves to no durable `solutions/` or `api-contracts/` record (only
   coordination prefixes in narratives and test titles). Per root `CLAUDE.md` "Comment
   anchors", tracking-id citations in production code rot. The comment is otherwise fully
   self-contained — drop the `SEC-004` token and keep the behavioral wording (optionally
   anchor on "ARCHITECTURE.md § 6.1 State C, passwordless ORCID-only", which is durable).
   Same rot class held on the sibling `backend-orcid-unique-index-boot-assertion` this batch.

Not blocking (no action): the pre-existing `/api/auth/reset` mailbox-gated password-add
path; the documented 403-NO_PASSWORD_SET vs 401 disclosure (by design); the commit-message
"mirrors recover.ts" imprecision (recover uses `.min(1)`, signup deliberately does not).

The downstream `ui-orcid-signup-recover-real-roundtrip` unblock already landed and is not
regated by these holds — the schema fix itself is correct and deployed; these are
test-isolation + comment-hygiene fixes only. When they land, `git mv` this file back to
`tasks/review/` (the move is the re-review signal).
