# Upload-token single-use rests on the rationale the consent-op work disproved

**Owner:** backend
**Created:** 2026-09-01
**Priority:** normal

## Why

`backend/src/lib/ipfs-upload-token.ts` implements the same dual-tier single-use primitive
as the fresh-auth consent-op burn: Redis canonical, an in-process map as a flap backup,
an atomic `getdel`, and an existence-guarded compensating `del` on the fallback leg. What
it does NOT have is a record of the spend.

The consent-op work established, and verified against installed ioredis, that the
compensating delete cannot be the thing that establishes single-use. A queued delete is
rejected wholesale once the reconnect count reaches a multiple of
`maxRetriesPerRequest + 1`, which on this client's curve is a little over a second into an
outage. An ordinary Redis restart outlasts that. Past that point the canonical copy stands
for the rest of its TTL and a spent token reads straight back out.

The upload-token store still states the retired reasoning as settled fact. Its top-of-file
docblock says single-use "is enforced by GETDEL on the Redis tier and delete-on-read on the
memory tier", with no caveat. After the consent-op corrections this is the one place left
in `backend/src/` asserting that rationale as fact (verified by grep across `backend/src/`
during the round-5 review; the only other `getdel` use, in the admin broadcast-counter
reset, has no dual-tier fallback and makes no single-use claim).

Note the function-level comment at the compensating delete is already more honest ("a
failed del only leaves ... the replay window until the token's TTL expires"), so the
overclaim is localized to the top-of-file docblock. The file contradicts itself.

## What contains the impact today

This is a correctness-of-claim divergence, not a live hole. A replayed upload token is
bounded by the `file_sha256` re-verification at the pin route and by the independent pin
cap, so a second use cannot pin arbitrary content. Treat this as real but not urgent.

The trap is a future change that widens what an upload token authorizes while reasoning
from the current docblock.

## Scope

Two defensible directions. Pick one and record why in the task file.

1. **Mirror the record.** Give the upload-token burn the same spent-record shape the
   consent-op path now has: write the record before attempting the removal, retire it only
   on a confirmed reply. The corrected convention entry
   (`agents/docs/solutions/conventions/atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md`)
   is a safe template for this as of its 2026-09-01 correction, including the reason the
   record must carry no deadline and the accepted cost of that choice.
2. **Downgrade the claim.** Leave the mechanism alone and rewrite the docblock to describe
   the containment that actually applies (`file_sha256` re-verification plus the pin cap),
   explicitly stating that the compensating delete is best-effort cleanup and not the
   guarantee.

Direction 2 is legitimate here in a way it was not for consent ops, because the blast
radius genuinely is contained by an independent mechanism. Do not assume direction 1 is
required; argue it from what an upload token authorizes.

Whichever is chosen, the file must not end up claiming more than it enforces.

## Acceptance criteria

1. `backend/src/lib/ipfs-upload-token.ts` no longer states, as unqualified fact, that
   single-use is enforced by the `GETDEL` plus memory-tier delete alone.
2. The top-of-file docblock and the function-level comment at the compensating delete
   agree with each other.
3. If direction 1 was taken, a test drives the real rejection path (a burn whose Redis leg
   could not confirm the removal, then a replay after recovery within the TTL) rather than
   a stubbed readiness predicate. If direction 2 was taken, the stated containment is
   verified to exist at the pin route rather than assumed.
4. The chosen direction and its rationale are recorded in this file.
