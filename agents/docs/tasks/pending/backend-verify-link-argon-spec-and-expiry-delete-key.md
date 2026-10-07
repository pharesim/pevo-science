# Signup verify link: an argon2 error-class spec, the expiry delete's key, one comment

**Owner:** backend
**Created:** 2026-10-07
**Priority:** low

Filed at the architect review of `backend-signup-verify-requires-the-signup-password` (archived
2026-10-07): the review's one finding in the diff, that task's follow-up 2, and a comment nit.
User triage: "as recommended".

## Why

1. `POST /api/auth/verify` now calls argon2 through `runWithArgon2Slot` and hands argon errors
   to `handleArgonError` in its catch, but no test injects an argon error on this route. A later
   edit that drops the hand-off stays green, and a saturated or draining semaphore would then get
   the logged 500 instead of the 503. The convention
   `agents/docs/solutions/conventions/route-level-error-class-coverage-after-helper-extraction-2026-04-29.md`
   asks for per-route coverage at every new call site of the helper. `/resume-signup` has it in
   `backend/tests/routes/signup-verify-resume-argon-error-translation.test.ts`.
2. The `/verify` expiry branch deletes `WHERE id = $1`. A signup retry that refreshes the expired
   row E between `/verify`'s SELECT and that DELETE loses its fresh row, and the user has to sign
   up again. The implementer reproduced this in a scratchpad probe. The confirm UPDATE in the same
   handler is already keyed on the presented token.
3. The comment above the unresolved-`orcid_token` refusal in `POST /api/auth/signup` says the
   standard email path is "reached only when no `orcid_token` was sent". An empty-string
   `orcid_token` is sent and takes that path.

## Scope

1. Add a spec for `POST /api/auth/verify` that mirrors the `/resume-signup` one: the three argon
   error classes, the same assertions, the cases run unconditionally, and the pool returning a
   row E that carries a `password_hash`. It mocks the pool, so its header gives the carve-out
   (a), (b) and (c) from root CLAUDE.md "Running Tests".
2. Key the expiry branch's DELETE on the presented token as well as the id. The answer stays
   "Verification token has expired". A spec for the interleave is optional.
3. Narrow the comment to "reached only when `hasOrcidToken` is false".

## Acceptance criteria

1. The new spec is green, and it goes red when the `handleArgonError` hand-off is removed from
   the `/verify` catch (plant-test it and report the result in the signal block).
2. The expiry DELETE carries the token key.
3. `tests/eslint` and the signup route suites are green.
