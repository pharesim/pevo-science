# Two WoT test comments cite a test file that no longer exists

**Owner:** backend
**Created:** 2026-10-05
**Priority:** low

## Why

`backend/tests/routes/wot-retract-cascaderevocation.test.ts` was deleted in
`11039c47` (revoke reclassified as a sticky sanction, cascade machinery
removed). Two comments at HEAD still cite it:

- `backend/tests/wot-vouch-status-select-real-postgres.test.ts`, the header's
  clause (c): "the assembled `getVouchStatus` response envelope and the
  single-read call accounting are covered by the mocked-pool specs in
  `tests/routes/wot-retract-cascaderevocation.test.ts`".
- `backend/tests/routes/wot-vouch-broadcast-outcomes.test.ts`, the comment
  above the `vi.mock` of `../../src/redis.js`: "Mirrors the sibling
  `tests/routes/wot-retract-cascaderevocation.test.ts`."

The carve-out companion-citation canary does not catch the first one. That
clause (c) is free prose, and the file is listed in `DEFERRED_FREE_PROSE`, so
the canary does not resolve the path. The second is not a carve-out block at
all.

What the deleted file held, read at `11039c47^`: a
`getVouchStatus — single-read snapshot (vouches + self_method)` describe block
run against a mocked pool, and a `getRedis: () => null` mock of the Redis
module. At HEAD, `getRedis: () => null` appears in
`routes/wot-retract-route.test.ts`, `wot-broadcast-timeout.test.ts` and
`wot-threshold-signer-gate.test.ts`. Whether any spec at HEAD still pins the
`getVouchStatus` envelope and its single-read call accounting was NOT
measured. `routes/wot-retract-route.test.ts` runs `getVouchStatus` against a
mocked pool, and `routes/wot-retract-poll.test.ts` mocks `getVouchStatus`
itself. Neither was read for that.

## Scope

1. For the clause (c) in `wot-vouch-status-select-real-postgres.test.ts`, find
   the spec that covers the `getVouchStatus` envelope and its single-read call
   accounting today, and cite it. If no spec covers them, say so in the clause
   (c) rather than citing a file. Then put that gap in the signal block for
   architect triage. Do not add coverage in this task.
2. For the comment in `wot-vouch-broadcast-outcomes.test.ts`, point it at a
   sibling that exists and uses the same null-Redis mock, or drop the
   "Mirrors" sentence if the comment reads complete without it.

## Acceptance criteria

1. Neither file names `wot-retract-cascaderevocation`. A grep of `backend/`
   for it returns nothing.
2. Every file the two comments now cite exists, and the claim made about it
   holds against its current content.
3. The clause (c) block keeps its citation class. Converting it to the
   structured form is out of scope. The carve-out canary is green with
   `LANDING_FREE_PROSE`, `LANDING_FILELESS`, both deferred maps and
   `LANDING_DIGEST` untouched.
4. Comments anchor on stable symbols and file paths only, with no task slugs,
   round numbers, line numbers or SHAs.

## Notes

`backend-wot-read-side-drops-self-vouch` also names
`wot-vouch-status-select-real-postgres.test.ts` as a possible home for a new
spec. If both tasks touch that file, land them one at a time.

## Architect note (2026-10-08): one more stale WoT comment, folded in

Light accounts now vouch and retract through `POST /api/custody/broadcast`, signed server-side.
The route comment above the `POST /vouch` handler in `backend/src/routes/wot.ts` still says the
voucher broadcasts the vouch custom_json "via Hive Keychain".

3. Delete "via Hive Keychain" from that comment. Change nothing else in it.

Acceptance: a grep of `backend/src/routes/wot.ts` for "via Hive Keychain" returns nothing.
