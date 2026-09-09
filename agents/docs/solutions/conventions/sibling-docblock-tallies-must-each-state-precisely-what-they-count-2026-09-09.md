---
title: Two nearby docblocks tallying the same-looking fact must each state precisely what they count, not gain a third sentence explaining why they disagree
date: 2026-09-09
category: conventions
module: frontend/src/lib/fresh-auth.js + its consumers
problem_type: convention
component: frontend_stimulus
severity: medium
root_cause: incomplete_enumeration
applies_when:
  - "A comment sweep corrects a count, tally, or enumeration at one docblock and a sibling docblock elsewhere in the same file states a different-looking count about a related fact"
  - "The instinct is to add a clause saying `the other count over there measures something else` instead of editing that other sentence"
  - "A docblock names N sites, readers, or consumers of a shared value and a nearby docblock names a different N for what reads like the same population"
  - "Reviewing such a sweep: deciding whether an added reconciling sentence narrows to a true distinction or merely asserts a reading the pointed-at sentence does not carry"
  - "Running a proactive sibling-miscount grep before committing a count correction"
tags:
  - fresh-auth
  - comment-rot
  - docblock
  - tally-accuracy
  - comment-anchor
  - convention-sweep
  - single-source-of-truth
---

# Two nearby docblocks tallying the same-looking fact must each state precisely what they count, not gain a third sentence explaining why they disagree

## Context

`frontend/src/lib/fresh-auth.js` carries two hand-maintained tallies of "how many sites consume an acquisition result", in two docblocks about 130 lines apart.

`evictUnnamedAcquisition`'s docblock enumerated the readers of the raw result returned by the module-private `acquireSessionProof`. It said THREE, and it was wrong: there are two, the fail-closed guard inside `ensureSessionWindow` and the broadcast unwinder `acquisitionAborted`. `freshAuthWindowReady` and `windowProof` (`frontend/src/lib/ipfs-upload.js`) both call `ensureSessionWindow` and only ever see the outcome object it derives; neither touches the raw value.

`WINDOW_OUTCOME_BY_SENTINEL`'s docblock says `acquireSessionProof` "resolves to a proof string or to one of the sentinels below, and three independently owned sites consume the result", then names `freshAuthWindowReady`, `acquisitionAborted` and `windowProof`. Read literally, "consume the result" binds all three to the raw result. Only `acquisitionAborted` is a genuine member of both tallies.

The fix corrected the count at `evictUnnamedAcquisition`, corrected a matching miscount in `ensureSessionWindow`'s own docblock, and then added a clause at the corrected site asserting that the sibling tally "is a different and equally correct count: it tallies who acts on an outcome ... not who reads the raw result." That clause reconciles from a distance. It asserts a reading of the sibling sentence rather than amending it, and the sibling sentence does not carry that reading: nothing in its wording signals that two of its three names are being counted for a downstream thing and the third for the raw value.

The implementer saw the tension and chose the clause deliberately, so the next reader would not have to re-derive the distinction. Two independent review lenses raised the residual anyway, and a validator confirmed it both textually and by call graph. The clause did not stop the collision it was written to stop. It moved the disagreement from "two numbers that do not match" to "two numbers plus a third sentence asserting they measure different things, where that assertion does not survive a cold read of its target."

## Guidance

When a sweep corrects a count, tally, or enumeration at one site, and a sibling site states a related-sounding count about what looks like the same fact, make **both** sentences say precisely what they count. Do not add a third sentence explaining why the two differ.

Prefer naming the members inline over restating a number. "A, B and C do X" cannot drift the way "three sites do X" can, and it makes the sentence self-sufficient: a reader landing on either docblock in isolation gets the right answer without having to find and trust a reconciling clause somewhere else. Where two nearby comments really do count two different valid subsets, say which subset each one counts, in that sentence, in its own words.

**The sibling-miscount grep must match semantically, not by phrase.** This file already had a standing pre-commit habit of sweeping for sibling count claims before landing a count correction, and it ran on this very change. It searched literal phrasings ("three readings", "three sites"). The sibling that survived it says "three independently owned sites consume the result" about the same population in different words, and it was never the subject of any fix. (session history) A phrase-matched sweep confirms only that nobody else wrote your sentence; it says nothing about who else counted your set.

## Why This Matters

Reconcile-by-explanation is tempting because it looks like the conscientious move. You noticed the tension, so you name it rather than leaving the next reader to rediscover it and wonder which sentence is stale.

But naming a tension is not resolving it. If the clause's claim about the target sentence does not survive a literal re-read of that sentence, the clause has not removed the ambiguity. It has added a claim *about* the ambiguity that itself has to be verified against the tree, the same standing liability as a line-number or SHA citation. And it adds a third thing to keep in sync with the two it is bridging, so the next edit to either count can now falsify a sentence in a third place.

It also reads differently depending on who is reading. To the author, who holds the intended distinction in mind, an explaining clause reads as resolved. To anyone checking the target sentence cold, it reads as unresolved. Future readers and reviewers are entirely the second population, which is why review lenses keep re-finding this shape: a lens checking a numeric claim does not stop at "is there a sentence acknowledging the discrepancy", it checks whether the discrepancy is gone.

## When to Apply

- During a comment or docblock sweep that fixes a wrong count, and a second site nearby states a related count.
- When about to write a clause of the form "the count over there is a different and equally correct count, because ...".
- When reviewing such a sweep: treat a reconciling clause as a finding until you have re-read the target sentence in isolation and asked whether it would read that way to someone who has not seen the clause. Trace the call graph the two comments claim to describe.
- When running a pre-commit sibling-miscount grep: search the concept, not the phrasing. Grep the participating symbol names and the noun of the counted set, not the numeral and its neighbouring words.
- Applies to any pair of nearby comments making countable claims about the same or overlapping surface: "N call sites", "M consumers", "K branches handle this".

## Examples

The abstract shape, independent of module:

- Comment A: "Three callers read raw result R: X, Y, Z. Only X cleans up." Wrong, because Y reads a derived value rather than R.
- Comment B, elsewhere in the file: "R resolves to V or one of these sentinels, and three sites consume the result: X, Y, Z."
- What was done: correct A to "two callers read raw result R: X and Z", then add to A a clause saying B's three-site count "tallies who acts on the derived outcome, not who reads the raw result".
- Why it does not hold: B never signalled that "consume the result" meant the derived outcome for two of its three names. Read cold, B still says all three touch the thing A now carefully distinguishes. The reader has to take A's word about B.
- The durable repair: edit B to say what it means. "R resolves to V or one of these sentinels; three sites act on the resulting outcome once it is known: X and Y through the wrapper's outcome object, and Z, which reads R directly." Now each site is correct read alone, and there is nothing left to reconcile.

In this module: `evictUnnamedAcquisition` and `ensureSessionWindow` now correctly name the two raw-result readers. `WINDOW_OUTCOME_BY_SENTINEL`'s sentence is still unedited and still reads as though `freshAuthWindowReady`, `acquisitionAborted` and `windowProof` all consume `acquireSessionProof`'s result in the same sense. Editing that sentence directly, and shrinking or dropping the reconciling clause once it is precise, is the move this entry recommends.

## Related

- `comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md` — the parent rule that every added clause must be verified against the code it describes, with the default of dropping a clause whose accuracy cannot be guaranteed. This entry is the sub-case where the added clause's *purpose* is to bridge two counts, and where the alternative to dropping it is precision at both sites.
- `prose-must-not-restate-derivable-data-from-nearby-structure-2026-06-14.md` — same mechanical fix (name the members instead of restating a number), but its trigger is a nearby in-file data structure the prose should point at instead. That trigger does not fire here: both counts are prose, with no table or enum for either to defer to, so its prescription of naming the structure has nothing to name. The two are boundaried rather than overlapping: that entry owns the case where the file holds an authoritative structure, this one the case where it does not.
- `convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` — the same blind spot as the phrase-matched grep above, in the SQL-audit domain: a sweep scoped to the offender's syntactic form misses instances expressing the same semantics in another construct.
- `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — a fix that removes one rot class must audit its own replacement text. Here the replacement introduced a different rot class.
- `outcome-vocabulary-widening-requires-a-consumer-audit-2026-08-31.md` — the consumer-audit discipline for this same vocabulary, and the reason these two tallies exist at all.
