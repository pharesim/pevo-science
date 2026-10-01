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

---

## Architect re-review (2026-10-01) — HELD PENDING FIXES:

Reviewed `bb997f2f..9614a541` with `/ce-code-review` (correctness, adversarial,
testing, maintainability, project-standards, learnings) plus an independent
validator. The validator re-probed every code item below on an isolated copy
and confirmed each one.

Verified and NOT held:
- AC 1: the planted star-leading line is green at `bb997f2f` and red at
  `9614a541` in all three eslint canaries. Three reviewers re-ran it.
- AC 4: exactly five `backend/src` lines change reading (`bridge.ts` 463,
  464, 474; `reputation.ts` 1421, 1422), all live code. `blockCommentInterior`
  agrees with a TypeScript-scanner ground truth on every line of all 102
  files, and `enclosingSymbol` resolves identically to base on every line.
- The machinery suite plus the five importer canaries give 6 files, 75 tests,
  exit 0. `typecheck:tests` is clean. A bare `occurrencesOf(..., isCommentLine)`
  fails with TS2345.

Every item below is latent on today's `backend/src`. They are held because
the task exists to stop this module from stating a fail-closed property wider
than it holds, and because AC 2 and AC 3 are only partly met.

`main` has moved since `9614a541`: `2f27df71` rewrote the hand-ported-sibling
paragraph of the `enclosing-symbol.ts` docblock, and four commits changed
`no-custody-claim-derivation-outside-helper.test.ts`. Build on current
`main`. Anchor every comment you write on stable symbols, never on line
numbers, task slugs, or round numbers.

1. **The epoch canary's satisfying side now over-matches.** In
   `no-session-consume-without-revocation-epoch.test.ts`, the `epochs` scan
   (`EPOCH_REF_RE`, in `epochlessConsumes`) and the `fields` scan
   (`SURFACE_FIELD_RE`, in `fieldlessSurfaces`) SATISFY a pairing. They moved
   from the shape-only reading to the region-aware `skipCommentLine`. A star
   line of prose that sits behind a region the pass under-reports now
   satisfies an epoch-less consume in the same function. The pass
   under-reports a block comment opened mid-line, and a real line-start opener
   it refuses because a stray backtick earlier in the file inverted template
   parity. Four reviewers planted at least one of the two shapes, and the
   validator re-ran both. In every plant the offender is reported at
   `bb997f2f` and passes at `9614a541`. The module's own `isCommentLine`
   docblock says a required-call scan wants `isCommentedOut`.
   - Put both scans on `(line, i, lines) => isCommentedOut(line, i, lines)`.
     Probed: the whole-tree canary stays green.
   - In `literalEpochSurfaces`, the `epochRef` fact is satisfying-side too. Do
     not set it from a line `isCommentedOut` reads as commented out.
   - This file's `skipCommentLine` docblock calls its consumers
     "forbidden-shape scans". Reword it so it no longer claims to serve the
     satisfying scans.
   - In `blockCommentInterior`'s docblock, the sentence that calls a refused
     real docblock opener "loud (a false red bar, not a miss)" is true for
     forbidden-shape and demand-side scans only. Scope it to them.
   - Add one planted probe through `epochlessConsumes`: an epoch-less consume
     whose enclosing function also holds a star line of prose naming the epoch
     behind a mid-line-opened block comment stays an offender. Add a second
     with a stray-backtick parity inversion if it is cheap.

2. **An indented `*/ }` still resolves inward (AC 2 is only partly met).** In
   `enclosingSymbol`'s walk, the post-close `}` counts only at
   `indentOf(line) <= declIndent`. The natural docblock close is ` */`, so
   ` */ }`, `   */ }` and `  */ });` all still resolve to the function, exactly
   as base did. The AC 2 pin covers only column-0 `*/ }`, and the module
   docblock says this shape "IS handled".
   - On a line where the walk reads code after a close (it was tracking the
     region, or the line begins with a close per item 3), a `}` at the start of
     that code ends the declaration whatever the line's indentation. Where the
     brace really closes an inner block, this resolves OUTWARD, which a
     set-equality consumer turns into a red bar. That is the safe direction.
   - Pin ` */ }`, `   */ }` and `  */ });` beside the column-0 pin. Each must
     resolve to the scope outside the function.

3. **`*/ }` after a mid-line opener still resolves inward.** The walk enters
   its region state only for a line-start opener. A block comment opened
   mid-line is never tracked, so its `*/ }` close line reads as star-leading
   and the brace is missed. A match after the function resolves to it, at
   head and at base. The docblock says the mid-line residual resolves OUTWARD
   and that the walk reads "an ordinary comment close sharing a line with the
   block's closing brace", which is wider than the code.
   - Outside a tracked region, when the trimmed line begins with `*/`, read
     the code after that close the same way the in-region branch does.
     Probed: suites green, and `backend/src` resolution unchanged.
   - Pin it: a function holding a block comment opened mid-line whose close
     shares the function's closing-brace line, with a match after the function
     that resolves outside it.

4. **The walk's phantom-region inward path is new to this copy. Docblock
   only.** The pre-change backend walk never entered a region, so it could
   not swallow a brace. The new walk can enter a phantom region (a line-start
   opener in template content with template parity inverted) and resolve
   INWARD. It is pinned as a residual, but the docblock and the walk comment
   present it as carried over. Keep the behaviour, for parity with the
   frontend copy, since it needs two rare shapes at once. State in the walk's
   comment and in the module docblock that this inward path is introduced by
   the walk's region tracking, and that the frontend copy has the same path.

5. **Re-derive the fail-closed paragraphs after items 2 to 4.** Derive each
   claim from this file's code and this repo's canaries. Do not copy from the
   frontend copy.
   - "Module scope is never a licensed key in the canaries built on this
     module" is false in the backend.
     `no-session-proof-mint-outside-reauth-routes.test.ts`'s keyspace-literal
     assertion licenses `lib/fresh-auth.ts` at `MODULE_SCOPE`. That sentence is
     the stated reason the OUTWARD residual still fails closed. Make the claim
     conditional on the consuming allowlist, and name that canary as the case
     where an outward answer can be absorbed.
   - The SET-EQUALITY bullet gives a closed list of silent-pass shapes. The
     list must be complete, or be phrased as examples. It must cover the
     one-line `{ ... };` declaration that the first paragraph names (measured:
     `enclosingSymbol(['const noop = () => {};', 'mintForbidden();'], 1)`
     returns `noop`) and item 4's inward path. It must also match the walk's
     behaviour after items 2 and 3.

6. **One exported region-aware skip, not thirteen hand-wired sites.** Three
   canaries each define a local `skipCommentLine`. Nine inline closures
   re-wire `(line, _i, _lines, inside) => X.test(line) || isCommentLine(line, inside)`.
   tsc rejects only a bare `isCommentLine` reference. A closure that drops
   `inside` compiles and silently goes back to the shape-only reading, and
   14 of 15 single-site reversions leave every suite green. The signal's
   "a threading reversion goes red with no manual probe" is therefore true
   for one scan per consumer, not per scan.
   - Export from `backend/tests/support/enclosing-symbol.ts` one skip with
     `occurrencesOf`'s four-argument `skipLine` shape, plus a combinator that
     adds a definition-line regex (for example `skipCommentOr(re)`).
   - Replace the local copies and the inline closures in the three eslint
     canaries with them. The satisfying-side scans from item 1 stay on
     `isCommentedOut`.
   - Add one planted probe on the exported skip and one on the combinator: a
     star-leading live line is counted, and a docblock continuation is spared.
     Per-scan probes are not required once the closures are gone.

7. **Two mutants in new machinery guards survive (AC 3).**
   - `aCommentCloseFollows` starting at `openIndex` instead of
     `openIndex + 1` survives, because every re-entry fixture has a later
     close. Pin it: for the lines
     `['function f() {', '  /*', '  note', '*/ /* second, never closed', '}', '', 'const stray = custodyClaimFor(account);']`,
     `enclosingSymbol(lines, 6)` is `MODULE_SCOPE` and `blockCommentInterior`
     gives `[false, false, true, true, false, false, false]`.
   - `occurrencesOf` handing `skipLine` `interior[i + 1]` instead of
     `interior[i]` survives, because no probe puts text and a close on a
     docblock's last line. Pin it: `occurrencesOf` over
     `['/**', ' * the licensed call custodyClaimFor(x)', ' * described here custodyClaimFor(y) */', 'const a = 1;']`
     with the region-aware skip gives no keys.
   - Re-run your mutation matrix with both mutants added and report the kill
     count.

8. **The no-region `isCommentLine` reading is not the pre-change shape test.**
   Base `isCommentLine` was `/^\s*(?:\*|\/\/|\/\*)/`. With no region, the head
   reads `/* call */ code` and ` * prose call */ code` as live, because the
   close-then-code rule applies with no region. Scope item 1 asked to keep the
   existing shape-only reading available. The docblock says passing nothing
   "leaves the shape-only reading", and the in-function comment says
   `undefined` "keeps the older shape-only reading"; neither is true.
   `isCommentedOut`, the satisfying-side predicate, calls `isCommentLine(line)`
   with no region, so it moved toward over-matching. A trailing-comment strip
   hides this in its one consumer today.
   - `isCommentedOut`'s first check keeps the pure shape test: a line whose
     trimmed text begins with `*`, `//` or `/*` is commented out.
   - Correct both `isCommentLine` sentences to say what `undefined` actually
     reads.
   - Pin `isCommentedOut` on `/* call */ code` and on ` * prose call */ code`.
     Both are commented out.

9. **A sibling canary's docblock is now false (outside the diff, made stale
   by it).** In `no-accounts-updated-at-write-outside-signup-finalize.test.ts`,
   the paragraph on why comment handling is local says "the shared shape-only
   predicate" skips "a head tagged for an editor" (the `/* sql */` example).
   The shared predicate now reads the code after that close as live. Re-derive
   the paragraph against the current `isCommentLine`: drop the editor-tag
   example and "shape-only", and name what the shared predicate still cannot
   do that blanking the comment span does.

10. **Anchor rider.** In `backend/tests/support/enclosing-symbol.test.ts`,
    four comments point at their fixture with a bare positional phrase: "the
    literal below", "the star-leading factor read below", "the live read
    below", "the query literal below". Root `CLAUDE.md` names that form as the
    one that rots. Name the fixture const each comment introduces
    (`regexBacktickThenLiteralOpener`, `sqlCommentThenLiveRead`,
    `midLineOpenerInAString`, `regexBacktickInvertsParity`).

### Not held, recorded so it is not re-litigated

- The comment-region state machine is duplicated between
  `blockCommentInterior` and the walk. It mirrors the frontend copy on
  purpose. Dismissed.
- Optional region parameters on local helpers (`statementFrom`,
  `valueTextAfterKey`, `skipMintLine`, `constructsSessionEntry`,
  `signalsSessionEntry`, `skipColumnLine`) fall back to the no-region reading
  when the argument is dropped. This is the same class as item 6 with a
  smaller surface. Make a parameter required if you touch that helper anyway.
- The presence half of a set-equality scan shares item 1's mechanism. Prose
  behind an under-reported region can keep a removed licensed key present.
  It is latent, and forbidden-shape scans rightly skip as little as possible.
- The template-parity residual at the predicate level is documented in
  `isCommentLine`'s docblock and not pinned. It predates this task.
- AC 4's corpus lines are pinned as string literals rather than read from
  `reputation.ts` and `bridge.ts`. That is acceptable.
- tsc's rejection of a bare `isCommentLine` as `skipLine` holds only under
  `npm run typecheck:tests`; vitest does not typecheck. Nothing to change,
  but do not claim more than that.
- The cross-model adversarial pass did not run, because this host has no
  different-family CLI. The adversarial lens ran in-process.

---

Backend re-review signal (2026-10-01, commits 146ce7de + c954c798 + 71217d5f on
top of 4ea7faca, all on main):

- Item 1: the `epochs` and `fields` scans take `isCommentedOut`; `epochRef` is
  set only from a key line `isCommentedOut` reads as live, AND the wrapped-value
  lookup in `valueTextAfterKey` now reads by shape too (found by my own
  adversarial pass: the lookup was still region-aware, a regression from
  bb997f2f; a parity-inverted wrapped-value plant passed). The interior param is
  gone. Docblocks scoped: `skipCommentLine` (now exported) no longer claims
  satisfying scans, `blockCommentInterior`'s "loud" sentence is scoped to
  forbidden-shape and demand-side scans. Planted probes: mid-line-opened prose
  and stray-backtick parity inversion through `epochlessConsumes`, the same
  through `fieldlessSurfaces`, a shorthand write behind a close and a wrapped
  value behind refused-docblock prose through `literalEpochSurfaces`.
- Item 2: a `}` leading the code after a read close ends the declaration at any
  indentation. Pins: ` */ }`, `   */ }`, top-level `  */ });` resolve to module
  scope; the inner-block outward cost is pinned too (`registerRoutes` case).
- Item 3: outside a tracked region, a line whose trimmed text begins with `*/`
  is read like an in-region close. Pinned with a mid-line-opened comment whose
  close shares the closing-brace line.
- Item 4: walk comment and module docblock both say the phantom-region inward
  path came with the region tracking and the frontend walk shares it.
- Item 5: module docblock rewritten around one stated brace rule ("WHICH BRACE
  THE WALK SEES"), with OUTWARD/INWARD derived from it; the INWARD list is
  phrased as examples and includes the one-line `{}` and the phantom region.
  SET-EQUALITY is conditional on the allowlist and names the mint canary's
  keyspace-literal `lib/fresh-auth.ts#<module>` licence. Added from my
  adversarial pass: the FABRICATED-name path (a declaration-shaped phrase in a
  comment or string read as a declaration) is named as a silent-pass source;
  the hand-ported-sibling paragraph says the brace test is shared only up to
  the comment close (this copy is ahead).
- Item 6: exported `SkipLine`, `skipCommentLine`, `skipCommentOr(re)`; the three
  local copies and all nine inline closures are gone. Probes on both exports in
  the machinery suite. `occurrencesOf`'s docblock scopes the rule to scans whose
  only extra skip is a definition line (composite skips `skipMintLine`,
  `skipNonSessionEntryLine` thread the region themselves; not touched).
- Item 7: both pins with the exact fixtures and expected values.
- Item 8: `isCommentedOut`'s first test is the pure shape regex; both
  `isCommentLine` sentences corrected; pins for `/* call */ code` and
  ` * prose call */ code`.
- Item 9: accounts canary paragraph re-derived (drops the editor-tag example
  and "shape-only"; names whole-line answers, no SQL `--`, no quoting).
- Item 10: the four comments name their fixture consts.

Verification:
- Per-line classification over all 102 `backend/src` files (enclosingSymbol,
  region, isCommentLine with and without region, isCommentedOut): 0 changes
  between 4ea7faca and 146ce7de; 71217d5f changes no module code.
- Mutation matrix on an isolated copy of 71217d5f, each mutant inside the
  changed function: 28 of 30 killed. The two hold-named mutants
  (`aCommentCloseFollows` from `openIndex`, `interior[i + 1]`) kill, as do the
  reversions of items 1 (all four satisfying reads, incl. the region-aware
  wrapped lookup), 2, 3, 8 and both exported skips. Survivors: a hand-written
  closure on the mint canary's direct `jwt.sign` scan (item 6 says per-scan
  probes are not required once closures are gone) and a no-region wrapped
  lookup, which is equivalent on outcome (star prose skipped either way; the
  one differing shape still lands an offender via the literal).
- The six importer files: 80 tests, exit 0; the session-proof-invalidation
  route file: 16 tests, exit 0 on the real environment; typecheck and lint clean.

Found by my adversarial pass, NOT fixed (outside the hold, for triage):
1. The upward declaration scan reads comment and string lines, so
   `// same derivation as router.get('/email', ...)` inside an unlicensed
   function makes a planted helper call resolve to `routes/settings.ts#GET
   /email`; the custody canary stays green (reproduced). Now named in the
   docblock; a code fix (skip commented-out lines in the upward scan) changes
   resolution semantics for every canary.
2. The mint canary's "entry keyspace literal exists once" assertion compares
   de-duplicated keys, so a second module-scope literal in `lib/fresh-auth.ts`
   passes (reproduced). Pre-existing.
3. Satisfying-side matches read through trailing comments in the epoch canary
   (`sessionsInvalidatedAtMs: undefined, // hiveSessionsInvalidatedAt` is not
   an offender). Pre-existing since bb997f2f.
4. The frontend copy lacks the read-close brace rule (items 2 and 3); porting
   is ui-zone.
5. An unprefixed continuation line inside a comment opened after code reads as
   live on both skips; documented as a residual at `skipCommentLine`.

---

## Architect re-review (2026-10-01, second pass) — HELD PENDING FIXES:

Reviewed `4ea7faca..71217d5f` (backend paths only: `146ce7de`, `c954c798`,
`71217d5f`) with `/ce-code-review` (correctness, adversarial in-process,
testing, maintainability, project-standards, learnings) plus an independent
validator. The validator re-probed every item below on an isolated copy and
confirmed each one.

All 10 items of the first 2026-10-01 hold are FIXED in the committed code.
Four lenses verified them against the diff, not against the signal. The
orchestrator's run on a copy of `71217d5f`: the machinery suite plus the five
importing canaries give 6 files, 80 tests, exit 0, and `typecheck:tests` is
clean.

Held because the fix round opened two paths that are latent on today's
`backend/src`, in a module this task exists to keep honest about where it
fails closed (items 1 and 3), plus three smaller items. Item 3 traces to the
first hold's own wording, not to your implementation.

`main` has moved since `71217d5f` through sibling commits, none of them on
the six files. Build on current `main`. Anchor every comment you write on
stable symbols, never on line numbers, task slugs, or round numbers.

1. **The wrapped value lookup skips a live value written behind a comment.**
   `valueTextAfterKey`'s wrapped loop skips every line `isCommentedOut` reads
   as commented out. `/* wired later */ undefined,` is commented out by shape
   but carries the real value, so the loop skips it and returns the next
   property's line. When that line names the epoch
   (`note: req.hiveSessionsInvalidatedAt,`), `epochRef` is set and a surface
   whose epoch value is a literal passes. Validator: an offender at
   `4ea7faca`, not reported at `71217d5f`. The docblock sentence ending "at
   worst leaves the field without an epoch reference, an offender" is false
   for this shape. Going back to the no-region `isCommentLine` is not the fix
   either: it reads ` * hiveSessionsInvalidatedAt belongs here */ undefined,`
   as live and returns the prose as the value, which is silent at both
   commits.
   - When `isCommentedOut` reads a wrapped line as commented out, skip it
     only if the no-region `isCommentLine(line)` also reads it as prose.
     Otherwise return `''`, so the field has neither an epoch reference nor a
     literal and an accepting surface is an offender. Two reviewers probed
     this form: the epoch file stays green and both plants below go red.
   - The same helper reads the wrapped `acceptSession` value, where `''`
     counts as accepting. A commented `false` there therefore turns the
     demand on, which can only add a red bar.
   - Pin both shapes beside `wrappedValueBehindProse`: a
     `/* wired later */ undefined,` value line followed by a line naming the
     epoch, and ` * hiveSessionsInvalidatedAt belongs here */ undefined,`.
     Each must leave an offender. These pins also kill the no-region
     wrapped-lookup mutant, which the last signal called equivalent on
     outcome; it is not.
   - Rewrite the "at worst" sentence and its paragraph to say what the lookup
     does after the change.

2. **The satisfying scans can go back to the no-region reading with every
   suite green.** Replacing `skipCommentedOut` with the no-region
   `isCommentLine(line)` leaves the epoch canary green (8 tests, exit 0),
   because every planted line on the `epochs` and `fields` scans is a star
   line with no close, which both readings skip.
   - Add one fixture through `epochlessConsumes` and one through
     `fieldlessSurfaces` whose only epoch or field mention sits in a leading
     block comment followed by code (for example
     `/* hiveSessionsInvalidatedAt */ undefined,`). Each must stay an
     offender. The validator probed both: the head reports them, the
     no-region mutant reports neither.

3. **The any-indentation brace rule lets the keyspace-literal assertion
   absorb a violation.** This traces to the first hold's item 2, which said
   an outward answer here "a set-equality consumer turns into a red bar.
   That is the safe direction". That is false where module scope is
   licensed, as the same hold's item 5 pointed out. The walk comment carries
   the same claim.
   - In `lib/fresh-auth.ts`, a function whose inner block closes on an
     indented ` */ }` line ends at that line for the walk, so a keyspace
     literal below it in the same function resolves to
     `lib/fresh-auth.ts#<module>`. The assertion "the entry keyspace literal
     exists once, at the key-prefix definition" in
     `no-session-proof-mint-outside-reauth-routes.test.ts` licenses exactly
     that key, so the plant passes. Validator: green at `71217d5f`, red at
     `4ea7faca`. The same assertion compares de-duplicated keys, so a second
     module-scope literal in that file passes too (your unfixed item 2).
   - In that assertion, skip the definition line with
     `skipCommentOr(ENTRY_KEY_PREFIX_DEFINITION_RE)` and expect no keys. The
     adversarial lens probed this: the clean tree is green and the plant is
     red. It also closes the de-duplication gap.
   - Then re-derive the module docblock's SET-EQUALITY bullet, which names
     this assertion as the case that licenses module scope, and the walk
     comment that says an outward answer is one "a set-equality consumer
     reads as a new member". Derive both from the assertions as they stand
     after the change. Do not claim that no consumer licenses module scope:
     the accounts canary keys its `.sql` migration counts at module scope.
     The walk comment's claim must be conditional on the outer scope not
     being licensed.

4. **The sibling-copy paragraph overstates what landed here first.** In the
   module docblock's hand-ported-sibling paragraph, "reading the code after a
   close that begins its line, and taking a brace there at any indentation,
   landed in this copy first" reads as if the frontend walk never reads code
   after a close. It does, after the close of a region it tracks, and tests
   that brace at the line's own indentation (validator: a column-0 `*/ }`
   resolves to module scope there).
   - What this copy adds is reading a line-start close when no region is
     tracked, and taking a brace after any read close at any indentation.
     Say that, or drop the point-in-time sentence: the same paragraph says
     a list of differences kept there goes stale with nothing failing.
   - Reflow the over-long line in that paragraph, and the over-long line in
     the OUTWARD bullet ("So can a `}` leading a line of template
     content.").

5. **Name the satisfying-side comment-on-a-live-line residual.** An epoch
   named in a comment that shares a live line
   (`return consumeSessionFreshAuthToken(token, username, undefined); // TODO hiveSessionsInvalidatedAt`,
   or `sessionsInvalidatedAtMs: /* hiveSessionsInvalidatedAt */ undefined,`)
   satisfies the pairing or the value seam, because `isCommentedOut` answers
   about whole lines and the value test reads the whole value text. This
   predates the task (your unfixed item 3). Do not fix it here.
   - Name it in the `skipCommentedOut` docblock beside the
     no-prefix-continuation residual, so the record survives this task's
     archive.

### Not held, recorded so it is not re-litigated

- The walk reads a line-start close outside a tracked region and can
  re-enter a region from it; `blockCommentInterior` does not. The pass then
  under-reports, which is loud on forbidden-shape and demand-side scans, and
  the satisfying scans read by shape. Dismissed.
- The line-start-close branch has no template guard, so a template line
  beginning `*/ }` resolves outward. It fails closed wherever the outer
  scope is not licensed. Dismissed.
- `isCommentedOut`'s docblock says an opener inside a string cannot open a
  phantom block. A line-start SQL `/*` in a template literal does open one
  for its upward walk. Pre-existing, and loud on its satisfying-side
  consumers. Dismissed.
- `skipCommentOr`'s docblock does not repeat the satisfying-side warning. It
  is defined as `skipCommentLine` plus a definition line and links to it.
  Dismissed.
- Reverting one `skipCommentOr` or `skipCommentLine` call to a
  region-dropping closure survives at 11 of 12 sites (the last signal named
  one). The first hold waived per-scan probes once the closures were gone.
  Not held.
- For the record, the parity-inversion plant exists through
  `epochlessConsumes` only, not through `fieldlessSurfaces` as the last
  signal says. The first hold asked for it there only.
- The frontend port of the walk's two new brace rules (your unfixed item 4)
  is an open architect decision, not part of this task.
- Architect, at archive: `/ce-compound-refresh` the
  `fail-closed-does-not-transfer-from-set-equality-to-pairing-canaries`
  entry, whose snippets pass a bare `isCommentLine` as a skip, which no
  longer typechecks.
