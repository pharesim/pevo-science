# Comment anchors in two route test files, and one in the resend handler

**Owner:** backend
**Created:** 2026-10-07
**Priority:** low

Filed at the archive of the state G unverified-row lifecycle task (its re-review signal's
out-of-scope item 3, and a P3 residual from the re-review). User triage: "as recommended".

## Why

Root `CLAUDE.md` "Comment anchors" bans task slugs, round and hold ordinals, line-number cites
and bare positional anchors in production and test code. The pre-commit gate checks added lines
only, and `backend/tests/eslint/no-stale-comment-anchors.test.ts` scans `backend/src/` only, so
these predate both and nothing flags them:

1. `backend/tests/routes/auth-log-shape.test.ts`: the file header and several block comments
   carry round and hold ordinals ("round-1 hold-fix item 2", "Round-2 hold-fix item 1", "the
   round-1 hold block (file lines 138-143)"), and two comments cite `auth.ts` line numbers for
   the SMTP warn emissions ("Emission is at logger.warn (auth.ts:665)", "(auth.ts:957)").
2. `backend/tests/routes/recover.test.ts`: a comment cites a task file slug
   (`backend-resend-verification-smtp-timing.md`).
3. `backend/src/routes/auth.ts`, `POST /api/auth/resend-verification`: the comment above the
   token UPDATE says the UPDATE "is keyed on the token read above". "Above" carries no stable
   name in that comment.

## Scope

1. In both test files, delete each ordinal, slug and line-number cite. Where a sentence needs a
   pointer, name a stable symbol instead: the log `event` string, the route handler path or the
   `describe` title. Delete a sentence whose only content is coordination history.
2. In the resend comment, name what was read (`account.verify_token`) in place of "the token
   read above".

## Acceptance criteria

1. No ordinal, slug, line-number cite or bare positional anchor is left in the two test files or
   in the resend comment.
2. `tests/eslint` and both route files are green when run alone.
