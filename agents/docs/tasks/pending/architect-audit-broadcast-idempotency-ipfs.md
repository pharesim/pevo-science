# Audit broadcast handling, idempotency and IPFS

**Owner:** architect
**Created:** 2026-10-05
**Priority:** low

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

The Hive client and block watcher, broadcast error handling, idempotency, Redis scripts, the pending-decrement queue, and IPFS upload validation, tokens and cleanup.

## Scope (line counts at filing)

- `backend/src/hive.ts` (238)
- `backend/src/block-watcher.ts` (74)
- `backend/src/lib/broadcast-error.ts` (775)
- `backend/src/lib/idempotency.ts` (636)
- `backend/src/lib/redis-scripts.ts` (314)
- `backend/src/lib/pending-decrement-queue.ts` (185)
- `backend/src/ipfs-cleanup.ts` (116)
- `backend/src/lib/ipfs-shared.ts` (302)
- `backend/src/lib/ipfs-upload-token.ts` (197)
- `backend/src/lib/ipfs-validation.ts` (138)

Total: 2975 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.

## Carried over from the accreditation and WoT audit (2026-10-05)

- `backend/src/lib/idempotency.ts`: the custom_json arm of `findCustodyBroadcastByIdempotencyKey`
  has the `ORDER BY block_num DESC LIMIT 1` shape that took 19.75 s in `findExistingAccreditation`
  for a no-match input. It was not plan-checked.
  `backend-latest-op-haf-lookups-walk-the-blocks-index` fences the two accreditation lookups in
  this file, not this one.
- `backend/src/hive.ts`: the `broadcastAdminCustomJson` docblock lists "WoT accreditation
  grants/revocations". No WoT path broadcasts a revoke.
