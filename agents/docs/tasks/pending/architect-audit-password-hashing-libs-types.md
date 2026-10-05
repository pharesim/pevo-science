# Audit password hashing, small backend libs and types

**Owner:** architect
**Created:** 2026-10-05
**Priority:** low

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

Argon2 hashing with its semaphore and error handling, the small shared helpers, and the backend types.

## Scope (line counts at filing)

- `backend/src/lib/argon2-error-handler.ts` (292)
- `backend/src/lib/argon2-options.ts` (13)
- `backend/src/lib/argon2-semaphore.ts` (568)
- `backend/src/lib/authMessage.ts` (31)
- `backend/src/lib/smtp.ts` (58)
- `backend/src/lib/password-policy.ts` (20)
- `backend/src/lib/flush-and-exit.ts` (32)
- `backend/src/lib/hive-account-name.ts` (35)
- `backend/src/lib/hive-permlink.ts` (22)
- `backend/src/lib/line-terminators.ts` (32)
- `backend/src/lib/request-abort-signal.ts` (39)
- `backend/src/util/assertNever.ts` (22)
- `backend/src/types/api.ts` (102)
- `backend/src/types/disciplines.ts` (176)
- `backend/src/types/domain.ts` (121)
- `backend/src/types/hive.ts` (299)
- `backend/src/types/index.ts` (6)
- `backend/src/types/search-filters.ts` (227)

Total: 2095 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.
