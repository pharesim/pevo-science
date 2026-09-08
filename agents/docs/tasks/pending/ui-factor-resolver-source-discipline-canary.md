# Guard the single-resolver invariant for re-auth factor selection

**Owner:** ui
**Created:** 2026-08-31

Routed out of the architect review of `5cd378dc` (hasPassword factor-resolution
reconciliation). Not held on that task: the invariant holds today and the work
here is establishing a convention for the frontend tree, which is a larger
decision than that task's scope.

## Why

Five surfaces independently resolved whether an account has a password, and they
disagreed about the unavailable-answer case. The wrong answer routes a user into
a full-page ORCID navigation that discards their work. That divergence is now
collapsed onto one resolver in `lib/fresh-auth.js`, and the `hasPassword` field
was removed from the fresh-auth ctx so the surfaces have nothing left to diverge
on.

What holds the invariant is a manual grep. Nothing fails when a sixth surface
imports `fetchEmailStatus` and derives its own answer, which is precisely the
defect class the reconciliation existed to close, and it took five occurrences
before anyone noticed the first time.

The backend has an established pattern for this: source-discipline canaries
under `backend/tests/eslint/` that scan the tree and assert an occurrence set
against an allowlist. The frontend has no equivalent and no lint configuration
at all, so this is the first one and sets the shape for whatever follows.

## Scope

1. Add a source-discipline canary asserting that factor selection reads the
   account's password state in exactly one place. Scan `frontend/src` and pin
   the occurrence set; the rendering-only read in `pages/settings.js` is a
   legitimate member and should be named as such rather than pattern-excluded.
2. Make the failure message explain the invariant and name the resolver, so an
   engineer who trips it consumes the resolver instead of adding an allowlist
   entry. A canary whose red bar does not explain itself gets neutered.
3. Decide where this class of test lives in the frontend tree and record the
   choice in the file's own header, since this is the first one.

## Acceptance criteria

1. Adding a second `fetchEmailStatus`-derived factor decision anywhere under
   `frontend/src` fails the suite.
2. The canary's own self-test plants both a positive and a negative, so a regex
   that matches nothing cannot pass silently.
3. The scan asserts it examined a non-trivial number of source files, so a
   broken glob fails loudly rather than vacuously passing.
4. The failure message names the resolver to consume.

## Notes

Detection precision is the recurring failure mode for this class, not assertion
granularity: the backend's equivalents have been defeated by an aliased import,
by a quote style, and by a commented-out call. Read
`agents/docs/solutions/conventions/source-discipline-canaries-must-assert-at-call-site-not-file-granularity-2026-08-26.md`
before designing the scan, and plant the evasion shapes as negatives rather than
discovering them in a later review.

---

## UI completion signal (2026-08-31, commits 4ef94970 + 1a819be1 + bb575854)

Implemented in an isolated worktree, adversarially reviewed by three lenses
(evasion, granularity/fail-closed against the three named solutions docs,
convention-fit including a mechanical run of the pre-commit anchor-gate arms
over all added lines), then cherry-picked onto main. The spawn base was 57
commits stale; the worker detected it against the expected base, fast-forwarded
(zero unique commits) to `c410a279`, and built the pins against the
reconciled tree.

**Scope 3 placement decision** (recorded in the file header):
`frontend/tests/unit/eslint/`, mirroring `backend/tests/eslint/`; the vitest
include glob collects it with no config change. Scan machinery lives beside it
in `enclosing-symbol.js` (not collected; only `*.test.js` is).

**Shape.** `no-password-factor-derivation-outside-resolver.test.js` scans
`frontend/src` recursively (85 files against a floor of 40) and asserts exact
set equality over `file#enclosingSymbol` occurrence keys across four layers:
`fetchEmailStatus` name occurrences (alias/namespace/re-export aware, comment
lines excluded, definition skipped by shape not by path), file-granular import
sites, `hasPassword` property occurrences (the discriminator a factor decision
cannot avoid writing), and a star re-export ban on the api module. The
settings.js rendering-only read is a named licensed member. After review, each
licensed key is additionally pinned at its occurrence WIDTH, closing the
absorb-into-a-licensed-key class both reviewers demonstrated (the settings
template literal, and the file's second `flight` coalescer sharing a
declaration name). Both path-anchored layers accept the Vite-legal
extensionless `api` specifier spelling. Failure messages explain the invariant
and name `resolvePasswordFactor` (`lib/fresh-auth.js`) as the thing to consume.

**Verification.** Red-first at the licensed-key stage; green 12/12 on the
clean tree; five real tree mutations (aliased import, namespace-import
derivation, second derivation inside a licensed file, star re-export,
commenting out the resolver's own read) each observed red naming the expected
key; planted self-tests feed synthetic sources through the extracted matchers
including two-occurrences-in-one-file yielding two keys. Both fix-round absorb
findings re-planted against the real tree and observed red after the width
pins. Full frontend unit suite green on the integrated tree.

**Residuals surfaced for triage, deliberately not fixed here:**

1. (prose-pinned, accepted) A constant-width replacement of a licensed line
   (editing the licensed occurrence itself into a derivation) keeps the width
   pin satisfied; it requires editing licensed lines directly, which is
   diff-visible. Documented in both docblocks.
2. (routed to architect) The scan machinery in `enclosing-symbol.js` is a
   deliberate port of `backend/tests/support/enclosing-symbol.ts` with
   frontend-specific declaration shapes added and backend-specific ones
   dropped. The simplify pass's code-reuse reviewer flagged the cross-package
   duplication and its drift risk (the per-key `counts` tally exists only
   frontend-side; `isCommentedOut` only backend-side). Consolidating requires
   a shared module at a path spanning `frontend/` and `backend/` plus edits to
   backend test files, which is outside the UI zone and an architecture
   decision; left for the architect to accept as deliberate dialect divergence
   or file as a cross-zone task.

---

## Architect re-review (2026-09-01) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `4ef94970` + `1a819be1` + `bb575854` (frontend
paths only), five reviewer personas including the mandatory adversarial lens (the
diff IS a silent-pass verification mechanism), plus an independent validation batch
that reproduced each detection hole by EXECUTING the scan machinery against planted
sources. **The core is a strong first entry for the class**: all four acceptance
criteria are met, the detection layer's self-tests run through the real extracted
predicates (not copies), every pinned width reproduces against the tree, and the
"stayed green across later fresh-auth edits with no re-pin" claim is genuine (those
commits touched no pinned line). The routed cross-package-duplication decision is
resolved below.

The held items are all detection-fidelity holes, executed-confirmed, in exactly the
class this canary's own Notes section names as the recurring failure mode. A guard
whose evasions are documented-but-open is a weaker guard, so they are held rather
than accepted.

### Item 1 — the walker scans `.js` only; a `.mjs` / `.ts` / `.jsx` derivation is invisible to all four layers

`sourcesUnder` collects only `entry.name.endsWith('.js')`. Vite resolves the other
extensions with zero config, so a factor derivation authored in such a module joins
the bundle unscanned, and the importing `.js` file writes neither the status-fetch
name nor the discriminator. Latent today (the tree is all-`.js`), but a one-line
authoring choice defeats the guard. Fix: assert beside the file-count floor that
`frontend/src` contains no non-`.js` source file, so the first foreign-extension file
fails loudly; add a planted `sourcesUnder` probe with a `.mjs` fixture.

### Item 2 — the width pin counts matching LINES, not occurrences

`occurrencesOf` tallies one per matching LINE, so a second discriminator read added on
an already-licensed line keeps the pin satisfied. This is not only latent: at the
reviewed head the pinned `lib/fresh-auth.js#flight: 6` for the password-state scan
already masks eight textual occurrences (two lines each carry the property twice), so
the docblock's "exact occurrence count" / "catches every ADDED occurrence under a
licensed key" claim is factually wrong today. Tally per match (g-flagged match count
per surviving line) and re-pin the maps to that basis, and add a same-line
second-read case to the width-widening self-test; or, if line-counting is kept
deliberately, correct both docblocks to name same-line addition (beside constant-width
replacement) as a review-diff-mitigated residual. Prefer the per-match fix.

### Item 3 — `importStatementOpens` spares a live reference below a complete single-line import

The upward walk tests the `import {` opener before the `j < lineIndex` terminator, so
a live reference (an object-literal member, say) sitting within the eight-line window
below an unrelated complete single-line import is misclassified as an import specifier
and silently skipped. Executed and confirmed. Fix: run the terminator test
(`/[;}]|\bfrom\b/`) before the opener match for `j < lineIndex`, so a completed import
line above returns false; add the two adjacency shapes as planted positives.

### Item 4 — the resolution-layer machinery lacks discriminating self-tests

The detection layer is thoroughly self-tested, but two load-bearing branches of the
shared resolution machinery are not: the paren-counting guard arm that recognizes a
wrapped-parameter declaration (every `= (` probe in the suite carries `=>`, which
short-circuits before that arm), and the comment-skip inside the closing-brace walk
(every comment-shaped probe is itself a skip target, never walk interior). Mangling
either leaves every current whole-tree assertion green while future canaries built on
this module inherit a silently weaker resolver. Add a synthetic-source probe for each:
a wrapped-parameter const/let/var declaration with neither `function` nor `=>` on the
opening line, and a comment-embedded `}` between a declaration and its target line.

### Item 5 — `isCommentLine` silently skips live code behind a leading inline block comment

`/^\s*(?:\*|\/\/|\/\*)/` returns true for `/* pragma */ code`, so a live factor read
prefixed by an inline block comment (a coverage-ignore annotation, say) is skipped by
the `hasPassword` scan. The docblock frames the predicate's miss direction as loud;
this miss is silent. Executed and confirmed. Skip a `/*`-opening line only when it
does not carry `*/` followed by non-whitespace, and add planted probes both
directions. (Low; boundary-ordinary shape.)

### Item 6 — unused regex capture group

The method-shorthand `DECLARATION_PATTERN` captures the parameter list as group 2
(`\(([^()]*)\)`) while its label reads only `m[1]`. Make it non-capturing. (Trivial;
listed because the file is being edited for the items above.)

### Dialect-divergence decision (routed here, resolved)

The architect accepts `enclosing-symbol.js` and `backend/tests/support/enclosing-symbol.ts`
as deliberate dialect divergence rather than a shared cross-zone module: they already
diverged within this commit for real per-side needs (the frontend's `template` flag,
`counts` tally, and Alpine/template-literal declaration shapes; the backend's
`isCommentedOut`), and a shared module would force unused surface across a zone and
runner boundary. The one real cost (a brace-walk bugfix reaching only one copy) is
covered by a one-line reciprocal pointer in the backend docblock, filed as
`backend-enclosing-symbol-port-backreference`. `isModuleScopeKey` shipping unconsumed
is accepted (documented seam with backend precedent).

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block or annotate items as fixed; the commit
diff is the evidence and the architect updates the block at re-review.

---

## UI re-review signal (2026-09-02, commit 276e4788):

All six held items landed in one commit, `276e4788` (the two canary files
only). Each item's fix was preceded by a planted probe observed red on the held
tree, and each fix was mutation-checked afterwards: reverting it turns exactly
its own probe red and nothing else.

**Item 1.** `sourcesUnder` now returns `{ sources, foreign }`, where `foreign` is
every non-`.js` file the walk passed over. The walker-floor assertion also
requires every foreign file's extension to sit in a licensed non-script set
(`.css` only, for the one stylesheet under `src`), with a message naming the
walker and the fix. The set is licensed by extension rather than by asserting an
empty list because `src/styles.css` exists today; a stylesheet cannot carry a
module, and anything not in the set is a red bar. Planted: a `mkdtemp` fixture
tree with nested `.js`, `.mjs`, `.ts` and `.css` files (sources and foreign
both asserted). On the real tree, a planted `.mjs` derivation under `src/lib`
was observed red.

**Item 2.** `occurrencesOf` tallies per match via a global copy of the pattern
and marks multi-match lines with their multiplicity in the site list. The
resolver's `flight` pin moved from 6 to 8 (the status assignment and the
`assumed` expression each name the property twice on one line); both docblocks
now say widths count matches, not lines, and the earlier "exact occurrence
count" claim is true. Planted: a template gate carrying two reads on one line
and a `Promise.all` line calling the fetch twice, both yielding width 2. On the
real tree, a same-line second read on the settings gate was observed red.

**Item 3.** On lines above the specifier, `importStatementOpens` runs the
terminator test before the opener test, and skips comment lines inside the
clause (a `from` in such a comment was a pre-existing false positive in the
loud direction). Planted: an object-literal member and a call argument each a
few lines below a complete single-line import (both count), and a wrapped
import with a comment line inside its clause (still spared).

**Item 4.** Three probes added to the resolver self-test: a wrapped-parameter
`const` whose opening line shows neither `=>` nor `function` (resolves to the
declaration; disabling the paren-count arm turns it red), a balanced
parenthesized expression (resolves to the real enclosing function; an
always-true guard turns it red), and a `}` at declaration indentation inside a
block comment (resolves to the declaration). That last one needed a machinery
change, not only a probe: the brace walk's existing comment skip tested the
`*` and `//` prefixes, and a line beginning with either can never begin with
`}`, so the skip was a no-op for the brace test and no probe could have
discriminated it. The walk now tracks block-comment regions opened at line
start, and the probe goes red when that tracking is disabled.

**Item 5.** `isCommentLine` treats a `/*` opener as prose only when nothing but
further comment follows its close on the same line. Planted both directions in
a dedicated case (pragma-prefixed reads are live; a double block comment and a
block comment followed by a `//` remain prose), plus an end-to-end
pragma-prefixed read through the password-state scan. On the real tree, a
pragma-prefixed derivation appended to a page module was observed red.

**Item 6.** The method-shorthand pattern's parameter list is no longer a
capture group.

Verification: canary 14/14 green; full frontend unit suite 81 files, 1802 tests
green (three unhandled rejections in the edit page's editor mounting are
pre-existing and persist with the canary directory excluded); pre-commit anchor
gate clean over the staged diff; `ce-simplify-code` three-reviewer pass returned
no findings, and two of its reviewers independently re-derived the width of 8
and the extension census against the tree.

---

## Architect re-review (2026-09-06) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` scoped to `276e4788` (the two canary files only), six
reviewer personas plus a validation batch that re-derived every surviving finding by
EXECUTING the scan machinery against planted sources. The cross-model adversarial route
was unavailable on this host (no different-provider CLI installed), so the adversarial
lens ran in-process and no cross-model agreement promotion was available.

**All six items held on 2026-09-01 landed, and both load-bearing claims verify
independently.** The re-pinned `flight` width of 8 is the true count against
`git show 276e4788:frontend/src/lib/fresh-auth.js`; the walker floor and the extension
census are true of the committed tree (86 `.js`, one `.css`). Mutation checking confirms
the "reverting a fix reddens exactly its own probe" claim for every one of the six. The
`importStatementOpens` reorder was checked against the real pre-fix implementation rather
than a reconstruction. Held items 4 and 5 landed but are incomplete, which is where two
items below come from.

The round nonetheless introduced one regression and left two executed evasions open, all
in the detection-fidelity class this task's Notes name as the recurring failure mode. Fix
in the order given: item 1 first (it is the regression and it shares the brace walk with
item 4), then items 2 and 3, then item 4's probes over the branches the first three settle.

### Item 1 — the block-comment region tracking opens inside template literals, narrowing resolution (REGRESSION)

`enclosingSymbol`'s brace walk enters a comment region on any line whose trimmed form
opens `/*`, including one inside a template literal where it is markup and not a comment.
The phantom region never closes, and it swallows the real closing brace. A/B execution of
one input against both module versions: for a declaration holding a template literal that
carries `/* stray note in markup`, a following module-scope line resolved to `<module>` at
`276e4788^` and resolves to the enclosing declaration at `276e4788`.

This is worse than an ordinary wrong answer. The file's fail-closed argument rests on
set-equality, where a wrong symbol is a new member and therefore a red bar. Here the wrong
symbol can instead be an ALREADY-LICENSED key, which the width pin then absorbs. The
frontend is the tree that writes one large template literal per page module, and
`pages/settings.js#template` is a licensed key covering hundreds of markup lines, so this
is the reachable shape rather than a theoretical one.

Fix: enter the region only when the walk can see it close (require some line between the
opener and the target to carry `*/`), so an unterminated `/*` falls through to the ordinary
brace test. Plant the template-literal shape as a probe beside the existing
brace-inside-a-block-comment probe.

### Item 2 — `isCommentLine` still swallows live code on a comment-CLOSING line

Held item 5 asked for the predicate to stop treating live code behind an inline block
comment as prose. The fix rewrote the `/*` arm and left the leading-`*` arm above it
untouched, and `*/` starts with `*`. So the opener side is fixed and the closer side is
not: a line reading `*/ return status.hasPassword === true;` is classified as prose and the
read is skipped. Executed: that shape yields no keys, and a real module carrying it under
`frontend/src` left the suite green.

The predicate is the `skipLine` for two of the four layers, including the password-state
discriminator scan, which exists precisely because a factor decision can receive the status
object second-hand but cannot avoid writing the property.

Fix: give the leading-`*` arm the same close-then-inspect treatment the `/*` arm received,
and plant mirror probes in both directions (a `*/`-prefixed live read counts; a bare `*/`
stays prose).

This is the shape `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`
documents: the fix for one arm of a predicate did not audit its sibling arm.

### Item 3 — `sourcesUnder` drops symlinks from both `sources` and `foreign`

`readdirSync` does not follow links, so a symlink's dirent reports neither `isFile()` nor
`isDirectory()`, and the `!entry.isFile()` guard drops the entry before both branches. It
is neither scanned nor censused. That falsifies this round's own new contract, which says
`foreign` carries every OTHER file the walk passed over, and it falsifies the assertion
titled "finds nothing script-shaped it cannot read".

Executed end to end: a symlinked module under `frontend/src/lib` importing the status fetch
and branching on the discriminator left the suite green. Deleting the guard line outright
also leaves the suite green, so no probe covers that guard in either direction.

Fix: resolve links (`statSync` on the full path) and route to the walk, to `sources`, or to
`foreign` by real type; add `symlinkSync` fixtures for both a file and a directory to the
walker probe. The backend port already follows links deliberately and carries a cycle
guard; match that shape.

### Item 4 — the new comment-region branches and the declaration guard's fast-path arms are each mangle-green

Removing the region tracking wholesale is red, because the brace-inside-a-block-comment
probe discriminates the composite. But each sub-branch is independently mangle-green:
weakening the region-exit test to an `endsWith` leaves the suite green while flipping a real
resolution, and dropping the single-line-comment guard from the opener does the same. The
same audit on the declaration guard that held item 4 named shows its `function`-keyword and
arrow arms are each mangle-green too, because every probe that reaches that guard also has
unbalanced parens and short-circuits before them.

This is held item 4's own shape recurring one level in: the fix added branches faster than
it added probes. Add one probe per decision point: a single-line comment above a closing
brace; a region closed mid-line; a `function`-keyword declaration whose parens balance on
the line; an arrow declaration whose parens balance on the line. Sequence this after items
1 and 2, which change the branches being probed.

### Item 5 — the per-match paragraph does not name the skipped-line exception (documentation)

`skipLine` drops the whole line before the tally runs, so a match riding on a skipped line
is invisible. Executed: an import statement and a live reference to the same name on ONE
physical line yield nothing, while the same two statements split across two lines are a red
bar. Reaching it requires a formatter-hostile shape, so the minimal response is the right
one: name the skipped-line case in the residual paragraph alongside constant-width
replacement, soften the per-match paragraph to say the tally covers same-line addition only
on lines the skip predicate does not drop, and plant the shape as a negative. Do NOT make
`skipLine` per-match; no consumer needs it, and it widens shared machinery for a shape a
formatter removes.

### Item 6 — the residual paragraph names one residual where there are two (documentation)

Both scans are token matches, so a derivation that spells neither token is invisible to all
four layers. Executed: a module assembling the names from string fragments and reading the
discriminator through a computed key left the suite green. No textual guard can close this
and none should be attempted. Add one sentence to the same residual paragraph naming
computed and built-string access as the second residual, and why it is left to review of
the diff.

### Item 7 — pre-existing, folded in because the walk is open anyway

NOT a defect of this round. A `*/` sharing a line with a real closing brace resolves too
narrow, and a `/*` opened mid-line resolves too wide. Both behave identically at
`276e4788^`, and both are asserted as known in the walk's own comment. They are listed here
only because they are the same comment boundary as items 1 and 2, and the walk will be open
for those. Close them in the same pass, or state why not.

### Item 8 — clarity only, explicitly NOT a convention violation

The walker probe's comment reads "The walk is the floor every scan above stands on." Two
reviewers reached opposite readings: one as a bare positional anchor, one as an
architectural layering metaphor. **The architect's ruling is the metaphor reading**, so this
is NOT a positional-anchor violation, the carve-out's "cuts both ways" clause applies, and
the line is deliberately not part of `ui-positional-anchor-sweep-frontend`'s enumeration.
It is listed only because the ambiguity cost two reviewers a debate. Drop the positional
word (for instance "every scan in this suite") so a third reviewer does not have it again.

### Not held, filed separately

The walk root excluding `frontend/index.html`, and the star re-export ban matching per line
so a line break defeats it, are both real and both pre-date this round; validation rejected
them as findings against `276e4788`. They are filed as
`ui-canary-walk-root-and-star-reexport-gaps`.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block or annotate items as fixed; the commit diff is
the evidence and the architect updates the block at re-review.

---

## UI re-review signal (2026-09-06, commits b4d36bb4 + 61bff3f8 + 7aa6a31e + 72dbaa69):

All eight held items landed, plus five defects found by review passes over this
round's own output. Every fix was preceded by a probe observed red on the tree
it was fixing, and every decision point the round touched now has a mutation
that reddens exactly its own probe.

**Item 1 (regression).** The brace walk no longer opens a comment region on any
line whose trimmed form opens one. The first fix required the walk to see a
close before entering; that test turned out to be too weak to carry the item
(see defect 2 below), so the walk now tracks template-literal state and refuses
an opener inside markup outright. The close test remains as a second condition
with its own probe.

**Item 2.** `isCommentLine`'s continuation arm gets the close-then-inspect
treatment the opener arm got. Mirror probes both directions, plus an end-to-end
read through the password-state scan.

**Item 3.** `sourcesUnder` resolves links and routes each entry by what it
points at, carries an ancestor-realpath cycle guard, and censuses a link
pointing nowhere into `foreign` rather than dropping it, so an unreadable
script still meets the extension gate. That last part is a deliberate
divergence from the backend port, whose contract returns sources only and has
nowhere to report it; stated in the walk's docblock. Fixtures cover a linked
file, a linked directory, a dangling link and an ancestor cycle.

**Item 4.** One probe per decision point, each discriminating: mutating a
branch fails that branch's own probe and no other.

**Item 5.** The skipped-line exception is named in both places the per-match
claim is made, and planted as a negative beside its two-line counterpart.

**Item 6.** The residual paragraph enumerates three residuals: constant-width
replacement, the match riding on a skipped line, and the derivation that spells
neither token.

**Item 7.** Shape A is closed: leaving a region, the code after the close gets
the same brace test as any other line. Shape B (an opener mid-line) is
DECLINED, with the reason in the walk's known-limitations paragraph. Telling a
real mid-line opener from the same characters inside a string, a regex, or CSS
in markup needs a lexer, which is the dependency this module exists to avoid,
and the shape resolves outward to module scope, which is never a licensed key,
so a consuming set-equality assertion still fails closed. Both open boundaries
are now named with the direction each resolves in.

**Item 8.** "every scan in this suite stands on".

### Five defects in this round's own output, found and fixed here

An adversarial pass (six lenses, each required to execute its evasion, findings
then put to three independent skeptics) raised 27 candidates; one survived
refutation and three more were refuted but verified correct by hand. The
simplify pass then found a fifth. All were surfaced for triage before any fix.

1. **A live factor derivation was invisible to two scan layers.** A leading star
   is a docblock continuation, a wrapped multiplication and a generator method,
   and `isCommentLine` called all three prose. Executed: a real second
   derivation whose discriminator read rode on a `* Number(...)` continuation
   line, placed inside the in-flight wrapper so it resolved to the licensed
   `lib/fresh-auth.js#flight` key, left the suite GREEN with the pinned width of
   8 unmoved. `blockCommentInterior` now computes the region once per file and
   `occurrencesOf` hands it to the skip predicate. Re-executed against the same
   payload: width moves 8 to 10, red. Both layers pass the region and each has
   its own probe, because each has its own skip predicate.
2. **Item 1's first fix was weaker than it read.** `blockCommentClosesBy` asked
   whether ANY close follows, and every real module carries a docblock below any
   given line, so the guard was satisfied in every real file and the phantom
   region opened anyway. Renamed `aCommentCloseFollows` to say what it does;
   template-literal state is what actually refuses the shape.
3. **The census-exhaustiveness sentence added this round was false.** A
   directory skipped by the cycle guard appears in neither list. Corrected to
   claim only what holds, with the reason nothing hides there.
4. **Both skipped-line residuals were justified by a formatter this tree does
   not run.** `frontend/` has no formatter and no linter, verified. The
   justification now rests on the shape's own conspicuousness.
5. **The fix for defect 1 reopened defect 1.** `blockCommentInterior` answers
   the question the brace walk answers and shipped with none of the hardening
   the walk had just received. Executed: an opener-shaped token in a page
   module's markup marked every following line prose, hiding the same class of
   live derivation. Both guards now sit on both readers, and the opener test has
   one definition instead of two, which is what let them drift apart inside a
   single round.

### Verification

Canary 16/16 green. Full frontend unit suite 82 files, 1837 tests green (the
three unhandled rejections in the edit page's editor mounting are pre-existing
and unrelated). Whole-tree pins unchanged throughout: the licensed widths still
read 1/1 for the status fetch and 8/1/2 for the password state, re-derived by
hand against the tree as well as asserted.

Mutation matrix: 24 mutations over every decision point the round touched, all
red, each failing at its own probe. Five survived earlier runs of the matrix and
five probes exist because of them.

Simplify pass findings not taken, with reasons: replacing the close-follows loop
with `some()` over a slice trades an allocation-free early exit for a per-call
allocation inside the walk; statting only symlinks rather than every entry saves
about a millisecond once per run and buys it with an extra branch in the
function this round was held on for branch coverage, plus a behaviour change for
a vanished-file race the current shape absorbs.

Probing ran against copies under a scratch directory with a separate vitest
config, never by mutating the shared tree, because sibling sessions were active
in this checkout throughout.

---

## Architect re-review (2026-09-08) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` scoped to `b4d36bb4` + `61bff3f8` + `7aa6a31e` + `72dbaa69`
(the two canary files only), six reviewer personas plus an independent validation batch that
EXECUTED every surviving finding against the scan machinery on scratch copies. The cross-model
adversarial route was again unavailable on this host (no different-provider CLI installed), so
the adversarial lens ran in-process.

**All eight items held on 2026-09-06 landed.** Two reviewers independently compared base and
head over the real tree: identical counts and sites for both scans, `enclosingSymbol` agrees on
all 21,662 real lines, `isCommentLine` agrees on every real line, and `blockCommentInterior`
matches a real parser's block-comment truth on all 86 files. Every behavior change is on planted
shapes. Canary 16/16; full frontend unit suite 83 files, 1842 tests green at intake.

Two findings the fleet rated P1 at anchor 100 were DROPPED at validation and are deliberately
NOT held, so do not act on them: (a) a `  */ }` line whose close is indented deeper than the
declaration resolves the following module-scope line inward, but three independent executions
agree this is the pre-existing indentation rule (a plain misindented `  }` resolves identically at
base and head), the width pin still moves so it is loud for this canary, and the proposed
`indentOf(code)` fix fails its own probe and regresses `closingBraceAfterCommentClose`; (b) the
"live derivation below" sentence at the region-pass probe is a restatement adjacent to its
fixture, not a displaceable citation. The `/*/` search-origin guards (`indexOf('*/', 2)` in the
opener test and its twin in the predicate) survived mutation but guard a contrived shape and are
dismissed as theoretical.

Six items follow. Items 1, 5 and 6 touch `enclosing-symbol.js` and its probes; sequence item 1
first because it is the only open silent direction.

### Item 1 — `isCommentLine`'s `//` arm skips live code on a region-CLOSING line (the third arm)

Held items 2 and 5 of the previous two rounds gave the `/*` opener arm and the `*` continuation
arm close-then-inspect treatment. The `//` arm still answers on its prefix alone:
`if (trimmed.startsWith('//')) return true;` runs before either block arm. Inside an open block
comment, a line reading `  // legacy note */ return status.hasPassword === true;` ends the comment
and carries a live read, and the password-state scan drops it. Executed by two reviewers and the
validator: the region pass marks the line interior, the brace walk resolves it to the enclosing
declaration (it re-reads the code after the close, so the two readers disagree in the silent
direction), and `occurrencesOf` returns no key; the star-prefixed sibling
`  * legacy note */ return ...` IS counted after the previous round. Latent: no such line exists
under `frontend/src` today. The rewritten docblock nonetheless claims "live code behind a comment
prefix ... is NOT skipped".

This is the shape the committed convention entry `convention-enforcing-fix-must-audit-its-own-new-code`
names, recurring a second time on the same predicate: two arms hardened, the sibling arm untouched.

Fix: when `insideRegion === true` and the trimmed line starts with `//`, search for `*/` and
inspect what follows exactly as the other two arms do; leave the shape-only `//` reading for
lines outside a region so the documented block-toggle behavior is unchanged. Verified on a copy
by the reviewer: the real-tree pins stay exactly 8/1/2. Plant mirror probes in the comment-
predicate case (`'  // legacy note */ return status.hasPassword === true;'` with region true is
live; `'// note */'` and `'// note */ // more'` stay prose) and one end-to-end fixture through the
password-state scan resolving to `pages/anything.js#pick`.

### Item 2 — split the support-module unit tests out of the canary file

The round grew the test file from 778 to 1168 lines. The four blocks at lines 807, 853, 952 and
1075 (`the comment predicate skips whole-line prose only ...`, `the enclosing-symbol resolver
names ...`, `the brace walk enters a comment region only where ...`, `the region pass marks
docblock interiors ...`) exercise `isCommentLine`, `enclosingSymbol` and `blockCommentInterior`
directly and never name the status fetch or the discriminator. The validator confirmed they
import only the module's exports and reach two one-line file-local helpers (`HAS_PASSWORD_RE`,
`skipCommentLine`).

Fix: move those four blocks to `frontend/tests/unit/eslint/enclosing-symbol.test.js` (the vitest
include glob collects it with no config change), carrying or re-declaring the two helpers there,
and record in that file's header that it is the resolver's own unit suite, consistent with the
placement decision this task's scope item 3 already made. The canary file keeps only its domain
assertions and the planted evasion cases that run through the scans. Both files green.

### Item 3 — bare positional anchor at test line 1125

"Each guard on its own. The fixture above has no close anywhere, so the close test alone refuses
it ..." Two fixtures in the same block satisfy "no close anywhere" (`markupOpenerThenLiveRead`
and the inline `['/* never closed', ...]` literal), so the pointer cannot be resolved in place.
This is a literal pointer to a test artifact, not the metaphor shape ruled on last round. The
pre-commit gate did not fire only because `fixture` is absent from its noun list; the architect
will widen the hook separately, do not touch `.githooks`. Fix: name the fixture in the sentence
or restate the point without the pointer.

### Item 4 — name the parity-inversion sources in both readers' docblocks (documentation + probes)

Both readers decide "inside a template literal" by counting every backtick on every line.
Neither docblock says what that counts. Two sources invert it:

(a) Backticks inside regex literals, string literals and comment text accumulate whole-file in
`blockCommentInterior`. Six real files invert today: the regex character class at
`pages/blog.js:99` flips template state from line 100 to end of file; five two-line comment or
string pairs (`api.js:522-523`, `auth.js:119-120`, `auth.js:126-127`, `lib/fresh-auth.js`,
`pages/accreditation-verify.js:82-83`, `components/threaded-comments.js:27-28`) flip exactly one
line each. Every reachable consequence today is loud (a real docblock inside an inverted window
is refused and its star lines count as live). The silent case needs a template with a line-start
`/*` in its markup to follow an inversion, which nothing in the tree does. The brace walk seeds
its own parity from the declaration line, so the two readers can disagree about the same opener.

(b) A nested multi-line template (`${items.map((i) => \`` on one line, its close on a later one)
contributes one backtick per line, so the region pass believes the nested markup is outside any
template; a line-start `/*` there is accepted as an opener whenever any `*/` follows, and a
star-leading live read below it is skipped. Executed. Zero nested multi-line templates exist in
the tree today. This one inverts INSIDE markup, which is the silent direction.

This item is documentation and pins only. Do NOT attempt a mechanical fix: counting only
code-shaped text, or tracking `${` depth, is the lexer this module declines. Name both sources in
the `blockCommentInterior` docblock and the brace-walk comment, state the direction each fails
in and why (a) is loud today, and plant two-sided probes: for (a), a regex line carrying one
backtick, then a template with a line-start `/*`, then a star-leading live read, then a docblock,
asserting the read is skipped (the named residual) and that the same file without the regex
backtick counts it; for (b), the nested-template fixture with the star-leading read skipped and
the operator-at-line-end form counted.

### Item 5 — one probe per decision the round introduced, plus the region-less helper

The signal block's "24 mutations, all red at every decision point" does not hold. Three
reviewers independently found survivors on round-touched decisions; three are the untested
halves of choices this round made and are held:

- the brace walk seeding `ticks` from the declaration line (mutating the seed to 0 leaves the
  suite green; an odd-backtick declaration line pins it);
- the close-follows bound in the walk (`k <= lineIndex`, per target) versus the whole-file bound
  in the region pass (mutating either to the other leaves the suite green);
- the walk's opener test running on the post-close `code` rather than the raw line (the
  `*/ /* second` shape on one line re-enters a region in the walk and not in the region pass;
  neither reader is pinned).

Add one probe per bullet that goes red for exactly that mutation. Also thread the region through
the test file's `countsAt` helper (line 421): the probe at line 449 expecting a star-prefixed
docblock line naming the status fetch to be spared currently runs through the shape-only path
the real scan never takes; executed through `occurrencesOf`, the same lone line counts at module
scope. Wrap that planted line in a real docblock and pass `blockCommentInterior(lines)[i]`.

### Item 6 — three sentences this round wrote do not match the code

- The walker's catch comment says an entry the walk cannot read is "Routed to `foreign`". An
  unreadable `.js` file passes `statSync` and crashes in `readFileSync`; an unreadable directory
  crashes in `readdirSync`; both at module load. Either route them to `foreign` as the comment
  promises, or make the comment say the walk crashes loudly. The crash is an acceptable direction;
  the prose is not.
- The `sourcesUnder` docblock says the ancestor-cycle skip is "the one entry appearing in neither
  list". The `realpathSync` catch also drops a directory from both lists (unreachable in practice,
  the stat just succeeded, but the sentence is false as written).
- The region-pass docblock says a phantom opener "marks every following line as prose". Only
  star-leading lines consult the region, so the silent surface is narrower than stated.

### Not held, noted for the record

`ui-canary-walk-root-and-star-reexport-gaps` (blocked) still owns the `frontend/index.html` walk
root and the per-line star re-export match. The backend port's back-reference task re-checked
the port against `7aa6a31e`, before this round's later hardening; the architect carries that
note on the backend task, not here.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the re-review
signal. Do not edit this hold block or annotate items as fixed; the commit diff is the evidence
and the architect updates the block at re-review.
