# Audit the admin, profile, search and smaller routes

**Owner:** architect
**Created:** 2026-10-05
**Priority:** low

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

The admin, profile, search, stats, blog, contact, disciplines and accounts routes, and the custody audit log with its retention sweep.

## Scope (line counts at filing)

- `backend/src/routes/admin.ts` (556)
- `backend/src/routes/profile.ts` (844)
- `backend/src/routes/search.ts` (466)
- `backend/src/routes/stats.ts` (180)
- `backend/src/routes/blog.ts` (85)
- `backend/src/routes/contact.ts` (57)
- `backend/src/routes/disciplines.ts` (74)
- `backend/src/routes/accounts.ts` (49)
- `backend/src/custody-audit.ts` (93)
- `backend/src/jobs/custody-audit-retention-sweep.ts` (270)

Total: 2674 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.
