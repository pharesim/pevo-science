# Audit ORCID binding, claims and account creation

**Owner:** architect
**Created:** 2026-10-05
**Priority:** normal

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

Identity and accounts: ORCID binding, claims, `/me`, signup session binding, light account creation, seed-phrase derivation, the signup activation lock and the recovery purge. The account-state defense review in root `CLAUDE.md` applies.

## Scope (line counts at filing)

- `backend/src/lib/orcid-binding.ts` (751)
- `backend/src/routes/claims.ts` (374)
- `backend/src/routes/me.ts` (264)
- `backend/src/signup-session-binding.ts` (159)
- `backend/src/account-creation.ts` (322)
- `backend/src/seed-phrase.ts` (99)
- `backend/src/custody-crypto.ts` (57)
- `backend/src/lib/signup-activation-lock.ts` (308)
- `backend/src/recovery-purge.ts` (97)

Total: 2431 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.
