# Audit the server setup, caching, logging and rate limiting

**Owner:** architect
**Created:** 2026-10-05
**Priority:** low

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

App setup and startup checks, caching, database pools, logging and PII redaction, rate limiting, error handling and shared helpers.

## Scope (line counts at filing)

- `backend/src/app.ts` (541)
- `backend/src/startup-checks.ts` (499)
- `backend/src/cache.ts` (553)
- `backend/src/db.ts` (163)
- `backend/src/app-db.ts` (186)
- `backend/src/logger.ts` (485)
- `backend/src/lib/log-pii.ts` (154)
- `backend/src/middleware/rateLimit.ts` (308)
- `backend/src/middleware/errorHandler.ts` (31)
- `backend/src/response.ts` (43)
- `backend/src/helpers.ts` (390)

Total: 3353 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.
