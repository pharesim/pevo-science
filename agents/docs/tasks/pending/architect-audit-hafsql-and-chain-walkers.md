# Audit the HAF queries and chain walkers

**Owner:** architect
**Created:** 2026-10-05
**Priority:** normal

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

The HAF query layer and chain walkers that listing, profile and reputation reads go through. The accredited-only data policy applies to every query.

## Scope (line counts at filing)

- `backend/src/hafsql.ts` (2244)
- `backend/src/lib/chain-walkers.ts` (1219)

Total: 3463 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.

## Carried over from the accreditation and WoT audit (2026-10-05)

- `activeAccreditationsCteBody` docblock: it says an account is sanctioned iff its most-recent
  sanction block is "at-or-after" its most-recent authority accredit block. The SQL in
  `accred_pinned` compares `(block_num, op_id)` pairs, so a same-block pair resolves by op id.
