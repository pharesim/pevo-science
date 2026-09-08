# Make the backend comment predicates region-aware

**Owner:** backend
**Created:** 2026-09-08

Routed out of the architect review of `backend-enclosing-symbol-port-backreference`. That
task was docblock-only; these are pre-existing defects in the module it documents. Both share
one root cause: `backend/tests/support/enclosing-symbol.ts` decides what is a comment from
line SHAPE alone, where the frontend hand-port decides it from an open-region pass. Do not
fold these back into the docblock task.

## Why

### 1. `isCommentLine` reads live star-leading code as prose (the live one)

`isCommentLine` is a bare shape test: it answers true for any line whose trimmed text starts
with `*`, `//`, or `/*`. `backend/src` contains live code in exactly that shape, inside
template literals:

- `backend/src/reputation.ts` has a SQL fragment line beginning `* CASE WHEN cpq.is_self ...`
  (a multiplication operator opening a wrapped expression).
- `backend/src/bridge.ts` has a markdown line beginning `**Authors:** ${authorList}`.

Three source-discipline canaries pass `isCommentLine` as their `skipLine` filter over
`backend/src`: `no-session-proof-mint-outside-reauth-routes`,
`no-custody-claim-derivation-outside-helper`, and
`no-session-consume-without-revocation-epoch`. A forbidden call placed on a star-leading line
is therefore dropped before it is counted, and the canary stays green for exactly the
violation it was written to catch. This is a silent-pass hole in a guard, not a cosmetic
issue.

The frontend copy already fixed this class by giving its `isCommentLine` an `insideRegion`
argument computed once per file by `blockCommentInterior`, so a leading `*` is prose only when
a block-comment region is genuinely open. That fix never travelled back across the port.

### 2. The SET-EQUALITY fail-closed argument has a reachable counterexample

The module docblock tells a canary author that a set-equality assertion can never pass an
unreported violation, on the reasoning that landing on an already-allowed key would mean the
occurrence is textually inside that allowed function's block. The brace walk in
`enclosingSymbol` produces a counterexample: it skips any line whose trimmed text starts with
`*`, so a `*/` sharing its line with a real block-closing brace is never seen as a close. A
match placed after such a function resolves to that function's name from OUTSIDE its block. If
that function is an allowed key, the violation is absorbed silently, which is the precise
failure the `file#symbol` scheme exists to remove.

This is a recurrence of the class recorded in
`agents/docs/solutions/conventions/fail-closed-does-not-transfer-from-set-equality-to-pairing-canaries-2026-08-31.md`,
where the same docblock stated its fail-closed argument wider than it held.

Adversarial swept all `.ts` files under `backend/src` and found no block-comment interior line
whose trimmed text begins with `}`, so item 2 is latent in the current corpus. Item 1 is
reachable today. Fixing the walk fixes both.

## Scope

1. Give `isCommentLine` region awareness. The frontend's `blockCommentInterior` plus the
   `insideRegion` argument on its own `isCommentLine` is the shape to port; port it, do not
   re-derive it from scratch, and keep the existing shape-only reading available for callers
   with no file in hand.
2. Thread the region through the three canaries that use `isCommentLine` as their `skipLine`
   filter, and through `occurrencesOf` so it is computed once per file rather than per match.
3. Teach the `enclosingSymbol` brace walk to re-read the code after a mid-line `*/` instead of
   skipping the whole line, so a comment close sharing its line with a block-closing brace is
   seen as a close.
4. Re-scope or correct the SET-EQUALITY paragraph in the module docblock if item 3 does not
   fully close the counterexample. If it does close it, the paragraph stands as written.

## Acceptance criteria

1. A planted forbidden call on a star-leading live line under `backend/src` is REPORTED by
   each of the three consuming canaries, not skipped. Prove it with a mutation probe, not by
   observing that the suite is green: a green suite on the clean tree proves nothing here.
2. `enclosingSymbol` resolves a match placed after a function whose closing brace shares its
   line with a `*/` to the enclosing scope, not to that function.
3. Per-branch probes for each new arm of the comment predicate, mutating INSIDE the changed
   function rather than only at its boundary.
4. The two cited live lines in `backend/src/reputation.ts` and `backend/src/bridge.ts` are
   still correctly treated as live code by the fixed predicate, and a real docblock
   continuation line is still treated as prose.

## Notes

Backend zone only. The frontend copy already has the fix and must not be edited from this
task. Anchor any new comment prose on exported symbol names, not on line numbers, SHAs, or
task slugs.
