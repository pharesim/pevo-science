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

---

Backend implementation signal (2026-09-29, commits a8000291 + c11902ce + 9614a541, all
self-verified as ancestors of main):

- `a8000291` — the port: `blockCommentInterior` carried over from the frontend copy
  (line-start openers only, template-parity and visible-close guards), `isCommentLine`
  takes `insideRegion` with the shape-only reading preserved when no region is passed,
  `occurrencesOf` computes the region once per file and hands it to `skipLine` as a
  fourth argument (scope items 1-2), and the `enclosingSymbol` brace walk tracks the same
  region state instead of skipping star-leading lines, so a comment close sharing its
  line with a block-closing brace is seen as a close (scope item 3). Scope item 4
  resolved as "re-scope": the walk closes the counterexample this task names, but the
  port carries the sibling's two comment-boundary residuals (the multi-boundary line
  resolves inward) plus the parity inversions, so the SET-EQUALITY paragraph is
  re-stated against those named residuals rather than left as written. New machinery
  suite at `backend/tests/support/enclosing-symbol.test.ts`, one probe per decision
  point, with the live corpus shapes pinned verbatim.
- Scope extension found at intake: a FOURTH consumer, the revocation-column scan in
  `backend/tests/routes/session-proof-invalidation.test.ts`, passes the same predicate
  over `backend/src` (demand side of a pairing, so a skipped star-leading write was the
  same silent pass). Threaded and probed like the three named canaries; its docblock
  claim that the shape-only predicate is "the right one" is reworded accordingly. The
  changed `isCommentLine` signature makes TypeScript reject passing it directly as a
  `skipLine`, so no future caller can silently fall back to the shape-only reading.
- AC 1, proven by mutation probe, not suite green: a planted star-leading live line in
  the reputation SQL literal carrying `jwt.sign(` + `custodyClaimFor(` +
  `consumeSessionFreshAuthToken(` + `sessions_invalidated_at` left all four consumers
  GREEN on the pre-change tree and turns all four RED post-change. Each consumer now
  also carries a standing planted probe (star-leading live occurrence counted, docblock
  continuation spared), so a threading reversion goes red with no manual probe.
- AC 2: the machinery suite resolves a match placed after `*/ }` to module scope, not to
  the function whose brace that line closes.
- AC 3: a 19-mutation matrix (predicate arms, region-pass guards, walk guards, seed,
  bound, re-entry, `occurrencesOf` threading, per-canary threading), each mutation
  applied inside the changed function in an isolated scratchpad copy: 17 killed on the
  first pass; the two survivors exposed a missing close-search-offset pin and an
  invalidation probe fixture whose second plain-shaped write self-absorbed the
  assertion, both fixed in `c11902ce`, after which all 19 kill.
- AC 4: a classification diff over every line of `backend/src` shows exactly five lines
  change reading under the region-aware predicate — the two cited lines plus one more
  reputation SQL factor line and two more bridge markdown lines — all live code; every
  docblock continuation keeps its prose reading. Machinery suite, all six importer test
  files, and the full session-proof-invalidation route file pass on the real
  environment; typecheck and lint clean.
- `9614a541` — anchor-convention fix from the simplify pass: the skip docblocks name
  their targets instead of pointing "below". Frontend copy untouched.
