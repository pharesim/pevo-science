# Audit the accreditation and Web of Trust code

**Owner:** architect
**Created:** 2026-10-05
**Priority:** normal

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

The trust layer (root `CLAUDE.md` principle 3): the accreditation routes and service, email validation, and the Web of Trust.

## Scope (line counts at filing)

- `backend/src/routes/accreditation.ts` (1331)
- `backend/src/accreditation.ts` (470)
- `backend/src/routes/accreditations.ts` (188)
- `backend/src/email-validator.ts` (123)
- `backend/src/wot.ts` (343)
- `backend/src/routes/wot.ts` (267)

Total: 2722 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.
