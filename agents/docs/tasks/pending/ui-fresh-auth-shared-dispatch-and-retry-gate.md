# Centralize the fresh-auth outcome dispatch and the orchestrators' retry gate

**Owner:** ui
**Created:** 2026-08-31

Routed out of the architect reviews of the reauth-window round-4 and
hasPassword-divergence round-3 holds. Not held on either task: neither finding
is a defect today (every current outcome is handled at every site); both are
structural traps whose next widening pays the cost.

## Why

Two duplication shapes grew across the last rounds, and each has already
produced the failure it predicts:

1. **The window-outcome dispatch is triplicated.** `ensureSessionWindow`'s
   outcome vocabulary (`ready` / `failed` / `busy` / `reauthRequired`) is
   consumed by three independently maintained if-chains — `freshAuthWindowReady`
   and `acquisitionAborted` in `lib/fresh-auth.js`, and `windowProof` in
   `lib/ipfs-upload.js` — beside three near-identical toast helpers. The
   reauth-window rounds had to hand-edit all three chains, and the round-2 hold
   there was literally "an outcome added to the vocabulary was missed at two of
   three consumers." The convention entry
   `outcome-vocabulary-widening-requires-a-consumer-audit-2026-08-31` documents
   the class and recommends exactly this consolidation.

2. **The orchestrators' retry gate is a byte-identical clone.** The remintable
   401 retry-gate ladders in `lib/authorship-consent.js` and
   `lib/settings-fresh-auth.js` are identical modulo bindings (factor
   resolution, `usesPassword` gate, mint, the
   ORCID_FALLBACK/PROMPT_BUSY/CANCELLED/MINT_FAILED ladder, run +
   cache-clear, the retry catch), and the hasPassword rounds grew the clone by
   adding the fallback arm to both in lockstep — after which the new branch was
   tested in only one of the two files. Precedent: the byte-identical
   `promptBusy()` was already extracted from this exact file pair.

## Scope

1. One outcome-to-action mapping for the window-outcome vocabulary, shared by
   the three consuming sites (a lookup table in `lib/fresh-auth.js`, or a
   vocabulary-driven exhaustiveness test that fails when a site misses an
   outcome — implementer's choice; the point is a single place the next
   outcome must be added). Collapse the three toast helpers into one
   parameterized helper while there.
2. Extract the shared retry-gate helper into `lib/fresh-auth.js`, parameterized
   by the closures that actually differ (the factor resolver hook, the bound
   mint, the ORCID begin function, the run/clear pair). Both orchestrators
   consume it; their suites keep their own behavioral coverage but the ladder
   itself has one home.
3. No behavior change anywhere. The full unit suite must pass unmodified except
   where a test names a helper that moved.

## Acceptance criteria

1. A window outcome forgotten at a consuming site is caught by structure or by
   a failing test, not by an architect review.
2. The retry-gate ladder exists once; both orchestrators import it.
3. Suite green with no behavioral test rewrites (mechanical import/name updates
   only), build clean.

## Notes

Sequence after the two held rounds land: the reauth-window round-4 hold touches
`acquisitionAborted` and the pages, and the hasPassword round-3 hold touches the
authorship retry gate and the memo write, so extracting first would force both
holds to rebase onto moved code.
