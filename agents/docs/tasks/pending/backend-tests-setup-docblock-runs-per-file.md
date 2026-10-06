# The tests/setup.ts docblock says it runs once around the whole suite

**Owner:** backend
**Created:** 2026-10-06
**Priority:** low

Filed from the review of `backend-accreditation-mail-names-the-account` (the implementer's
out-of-scope follow-up; triage: user, "as recommended").

## Why

The docblock of `backend/tests/setup.ts` opens with "Global test setup — runs before/after all
test files." The file is a `setupFiles` entry in `backend/vitest.config.ts`, so vitest runs it in
every test file: its `beforeAll` deletes every `${appTag}:*` Redis key at the start of each file,
and its `afterAll` runs at the end of each file. A reader who trusts the docblock does not expect
one file's start to wipe keys a concurrently running file still holds.

## Scope

1. Narrow the docblock's opening claim to what the file does: it runs in every test file, before
   and after that file's tests. Do not add an explanation of the consequences; the learnings entry
   `per-file-setup-redis-flush-wipes-concurrent-test-files.md` carries it.

## Acceptance criteria

1. The docblock no longer says the file runs once around all test files.
2. `npx vitest run --retry=0 tests/eslint` run alone stays green. Comments follow root
   `CLAUDE.md` "Comment anchors".
