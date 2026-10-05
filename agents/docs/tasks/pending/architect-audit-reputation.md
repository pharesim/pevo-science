# Audit the reputation computation

**Owner:** architect
**Created:** 2026-10-05
**Priority:** normal

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

Reputation must be reproducible from public chain data ("Reputation Algorithm Constraint" in `agents/architect/CLAUDE.md`; `agents/docs/reputation-algorithm.md` is the spec).

## Scope (line counts at filing)

- `backend/src/reputation.ts` (1571)
- `backend/src/reputation-batch.ts` (639)
- `backend/src/lib/chain-cumulative.ts` (825)

Total: 3035 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.
