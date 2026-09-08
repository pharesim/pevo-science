# The outcome tally's source sentence still binds three sites to the raw result

**Owner:** ui
**Created:** 2026-09-09

Routed out of the re-review of the broadcast-path window eviction task, which
corrected the reading site but not the sentence that seeded the miscount. Raised
independently by two review lenses and confirmed at validation.

## Why

`evictUnnamedAcquisition`'s docblock now correctly says TWO sites read the raw
acquisition result: the fail-closed guard in `ensureSessionWindow` and the
broadcast unwinder `acquisitionAborted`. To reconcile that against the THREE-site
tally in `WINDOW_OUTCOME_BY_SENTINEL`'s docblock, it added a clause asserting that
the other tally "tallies who acts on an outcome ... not who reads the raw result".

That sentence does not say what the clause says it says. It reads that
`acquireSessionProof` "resolves to a proof string or to one of the sentinels
below, and three independently owned sites consume the result", then names
`freshAuthWindowReady`, `acquisitionAborted` and `windowProof`. The definite
article binds all three to `acquireSessionProof`'s result, and two of the three
provably never see it: `freshAuthWindowReady` and `windowProof`
(`lib/ipfs-upload.js`) both consume `ensureSessionWindow`'s derived outcome
object. Only `acquisitionAborted` is a member of both tallies.

So the module reconciles a real imprecision from a distance, by asserting a
reading of a sentence rather than amending it. The next reader who checks the
claim against the sentence finds they disagree, which is the same rot the
corrected count was fixing. The correct phrasing already exists in the module's
own dispatch suite header.

## Scope

1. Amend `WINDOW_OUTCOME_BY_SENTINEL`'s docblock so its tally binds to the outcome
   vocabulary rather than to `acquireSessionProof`'s result, and so it says which
   of the three named sites read the raw result and which read the derived
   outcome. Naming the members inline is preferred over restating a count.
2. With the source sentence precise, shrink or drop the reconciling clause in
   `evictUnnamedAcquisition`'s docblock. Two hand-maintained tallies in one file
   that need a third sentence to stay consistent is the shape to remove, not to
   document better.
3. Out of scope: the two counts themselves are both correct as numbers, and
   `acquireSessionProof`'s eviction behaviour is settled. This is a prose accuracy
   task, not a behaviour change. No production logic may change.

## Acceptance criteria

1. No sentence in `lib/fresh-auth.js` binds `freshAuthWindowReady` or `windowProof`
   to `acquireSessionProof`'s raw result.
2. Any surviving cross-reference between the two docblocks is checkable against
   the text it points at, not an assertion about what that text means.
3. Suite green, build clean. No production logic changed: the diff is comments
   only, confirmed by reading it.

## Notes

The sibling work this was going to be sequenced behind has already landed
(f9b6ad8d, the broadcast path's unnamed refusal). It rewrote the closing paragraph
of the `ensureSessionWindow` guard docblock and added the `?? 'failed'`
fall-through in `acquisitionAborted`, but touched neither sentence this task is
about: both were confirmed present and unchanged at that commit. So there is no
sequencing constraint left. Re-read both docblocks from the committed tree anyway
before starting, since that file is edited often.

Nothing mechanically pins either tally. A third raw-result reader added later
inherits the producer eviction automatically, so the exposure is documentation
drift rather than a lockout regression, which is why this is prose-only and
carries no canary.
