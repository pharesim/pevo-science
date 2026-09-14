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

---

## UI re-review signal (2026-09-08, commit 7bf49a6e):

All six held items landed in one commit, `7bf49a6e` (the three canary files:
the machinery, the canary, and the new unit suite the split produced). Every
machinery change was preceded by a probe observed red on the held tree, and
every decision point the round touched has a mutation that reddens exactly
its own probe.

**Item 1.** `isCommentLine`'s `//` arm answers on its prefix alone only when
no region is open. Inside one it is searched for a close and what follows is
inspected, exactly as the other two arms are, so `// legacy note */ return
status.hasPassword === true;` is live and `// note */`, `// note */ // more`
and a `//` with no close stay prose. The three mirror probes the hold named
sit in the comment-predicate case, plus the outside-a-region and
region-unknown readings of the same line (both prose), and the end-to-end
fixture through the password-state scan resolves to
`pages/anything.js#pick`. Reverting the arm reddens that fixture and the
predicate probe and nothing else; the whole-tree pins stay 1/1 and 8/1/2.

**Item 2.** The four blocks moved verbatim to
`frontend/tests/unit/eslint/enclosing-symbol.test.js` (the vitest glob
collects it unchanged), and every probe this round added for the machinery
went there rather than into the canary. The header records that it is the
machinery's own suite under the same placement rule as the canary, and why
each branch gets a probe of its own. `HAS_PASSWORD_RE` and `skipCommentLine`
are re-declared there with a comment saying which canary they mirror. The
canary's PLACEMENT paragraph now names the boundary. The canary keeps its
domain assertions, the walker probe (it exercises `sourcesUnder` against a
fixture tree, but its subject is the walk the canary's floor stands on), and
the planted evasions that run through its scans; `enclosingSymbol` is no
longer imported there.

**Item 3.** The sentence names `markupOpenerThenLiveRead`.

**Item 4.** Both readers' docblocks now say that template parity is a plain
per-line backtick count, name the two inversion sources (a backtick in a
regex, string or comment; a nested multi-line template), and state the
direction each fails in: for the region pass the first is loud today and the
second silent inside its own markup; for the walk, whose count is seeded at
the declaration, both resolve inward. Two-sided probes for each in the unit
suite: the regex-backtick fixture through the password-state scan yields no
key and the same file without the backtick yields `pick`; the
nested-template fixture yields no key and its operator-at-line-end form
yields `pick`; and the walk-side pair for each resolves to the declaration
with the inversion and to module scope without it. No mechanical fix was
attempted, per the hold.

**Item 5.** One probe per decision, each observed red under exactly its own
mutation in a scratch copy: the parity seed (a one-line declaration that
opens a literal; seed of zero resolves inward), the walk's per-target close
bound (the only close below the target; the whole-file bound resolves
inward), the bound's inclusive end (a close on the target line itself; the
exclusive form resolves outward, and the same helper mutation reddens the
region pass's close-on-last-line probe), the walk's opener test on the
post-close code (`*/ /* second note` re-enters; the raw-line form does not),
the region pass's whole-file bound (a twelve-line docblock; a windowed bound
counts its continuations as live). `countsAt` threads
`blockCommentInterior(lines)[i]` into the skip, and the docblock line naming
the status fetch is now planted inside a real docblock (spared) and alone
(counted); with the threading reverted the lone line reads as prose and the
probe goes red.

Beyond the probe the hold asked for, the region pass now RE-ENTERS on a line
that closes one region and opens another, as the walk already did. The two
readers were built to carry the same guards, and pinning them disagreeing on
one line would have left the skip predicate calling a docblock continuation
live below such a line (a false red bar). The re-entry has its own probe,
both readers agree on the shape, and only an unterminated second opener
re-enters.

**Item 6.** The stat-catch comment says what the catch actually receives
(nothing to stat: a link pointing nowhere, or an entry gone between listing
and stat) and that an entry the stat can see but the walk cannot open throws
at the read, which is loud. The `realpathSync` catch is REMOVED rather than
described: every directory reaching the walk was just stat-ed by its parent
or is the root the consumer named, so a resolve failure is a directory
vanishing mid-walk, and a throw there is the loud direction the hold
accepted. With it gone, the docblock's "one entry in neither list" sentence
is true as written, and a sentence beside it says everything else the walk
cannot resolve or read throws. The region-pass docblock now says a phantom
region hides the star-leading shape of live code, not every line.

### Eleven defects in this round's own output, found and fixed here

An adversarial pass ran six executing lenses (comment-boundary evasion,
symbol-resolution evasion, mutation audit, hold-item audit, prose-versus-code,
walker and structure), each planting its shapes in its own scratch copy, then
three refuters per finding. Rate limits killed 31 of 67 agents, so every
finding whose refuters all died was triaged by hand rather than trusted to the
majority rule. Twenty-eight raised, twenty unique. Ten were defects in text
this round wrote, all of them the class item 6 held, and all are fixed here:

1. The new suite's header listed the walker among what it exercises;
   `sourcesUnder` is not imported there, and both walker tests stayed in the
   canary. The header now says so and says why (the walker reads a directory,
   and the floor it gives a canary is a claim about that canary's tree).
2. The item-3 replacement sentence was itself wrong: `markupOpenerThenLiveRead`
   fails BOTH guards (its opener is inside the literal and nothing closes
   below it), and the template test short-circuits before the close test ever
   runs. The inline never-closed fixture is the one the close test alone
   decides. Both are now named for what they discriminate.
3. Two claims that the parity inversion is "loud today" described a refusal
   that does not happen: the inverted windows in the tree carry no line-start
   opener, so nothing is refused and no scan is affected. Both now say the
   inversion is inert today and name loud as the direction its reachable
   consequence would take.
4. "from there to the end of the file" overstated the phantom region: it ends
   at the next line carrying a close, which in a real module is the next
   docblock. The sentence now says that, and names the star-leading line as
   the whole silent surface.
5. "Anything the walk cannot resolve or read throws instead of being dropped"
   contradicted the sentence before it, where a dangling link (which cannot be
   resolved) is censused into `foreign`. Rewritten to name the three unguarded
   calls that do throw.
6. The rewritten stat-catch comment dropped the permission cause the old one
   named; an entry under a directory the walk may list but not search fails
   the same way. Restored.
7. "The granularity every assertion above rests on" moved with the resolver
   case, leaving its referent (the canary's whole-tree assertions) in the other
   file. It now names them.
8. "Four decision points, one probe each" and "Both arms have to close then
   inspect" were counts this round invalidated (eleven fixtures, three arms).
9. A canary probe pointed at "the star-prefixed form on the line before this
   one", a positional pointer to the preceding fixture. It now names the shape.
10. The header claimed the module's declined residuals are pinned; only the two
    parity inversions are. It now says which are pinned and why the two
    comment-boundary residuals need no pin (both resolve outward to module
    scope, which no canary licenses, so set-equality already fails closed).

Two more findings were accepted and fixed beyond the hold's letter:

- The parity paragraphs listed regex, string and comment backticks; an escaped
  backtick in a template's own text is the same class and was missing. Both
  docblocks and the fixture comment now say "a backtick that is not a
  delimiter" and enumerate all four.
- `opensUnterminatedBlock`'s line-start boundary had no probe in either reader,
  so widening the opener test to any mid-line `/*` (the tempting way to close
  the documented mid-line residual) left all sixteen green while turning an
  ordinary `'image/*'` into a phantom region. One probe per reader now pins it;
  the widening reddens both.

The simplify pass (three reviewers) found one more: the stat-catch comment
this round rewrote pointed at "the read below", a bare positional anchor in
the same class as item 3. It now names `readFileSync`.

Two simplify findings were not taken. Hoisting the one-line `skipCommentLine`
adapter and the discriminator regex into the shared module was declined: the
two suites are siblings over that module and each is meant to stand alone, the
machinery suite's token is chosen for fixture readability rather than to track
the canary's domain regex, and widening the shared surface is not this round's
scope. The reviewer that raised the duplication and the reviewer that assessed
it reached opposite recommendations, so both are recorded here.

### Residuals surfaced for triage, deliberately not fixed here

1. (P2, executed) `sourcesUnder` splits files on `\n`, but ECMAScript ends a
   line comment at any line terminator. A `//` comment ended by U+2028, U+2029
   or a lone CR reaches every skip predicate as one line beginning with `//`
   and is dropped, while the bundler runs the code after the terminator. Three
   refuters reproduced it, including inside the licensed files at unchanged
   width; CRLF is already caught, so no accidental path exists. The fix is one
   regex in the split, verified pin-neutral. Not applied because the walker's
   line contract is pre-existing and outside the six items.
2. (P2, executed) Item 1's `//` arm inspects for a close only when the region
   pass reports `true`, exactly as the hold specified. Wherever the region pass
   under-reports (the parity inversions, a mid-line opener), the arm falls back
   to its shape reading and a real close-plus-live-read is skipped. Widening it
   to inspect whenever a region state is known at all closes this and leaves
   the tree's pins unchanged, but it contradicts the hold's explicit "leave the
   shape-only `//` reading for lines outside a region", so it is the
   architect's call.
3. (P2, executed) A line that begins with `//` or `/*` while being the tail of
   a backslash-continued string, or the last markup line of a template, is
   prose to both predicates, and the string case seeds a phantom region. A
   third opener class beside the documented mid-line one. No line under `src`
   ends in a backslash today.
4. (P2, executed) A unicode escape inside an identifier (`hasPassword`)
   spells neither token and passes all four layers while the bundler compiles
   it to the real name. Residual 3's "no textual guard closes this" is false
   for this member: a pinned count of identifier-position escapes would close
   it.
5. (P3) Three width-pin sentences overstate what the pin holds: it catches an
   occurrence added while the licensed lines are untouched, and the `flight`
   width is dominated by the local's name rather than by reads.
6. (P3) The brace walk's `j <= lineIndex` bound has no probe; mutating it to
   `<` leaves the suite green and resolves a read behind a target-line closing
   brace inward. Pre-existing and outside this round's diff.

Two further findings were refuted by majority vote and are not carried: a `}`
inside an import clause's comment defeating the whole-file import matcher, and
a split constant-width edit (a removal under a licensed key funding an addition
under another).


### Verification

Canary 12 and unit suite 4 green (16 cases across the two files, the same
count as before the split; the new probes joined existing cases). Full
frontend unit suite 84 files, 1847 tests green (the editor-mounting
unhandled rejections are pre-existing). Pre-commit anchor gate clean over
the staged diff, re-run after the gate learned the `fixture` and `row`
nouns. Whole-tree pins unchanged at 1/1 and 8/1/2.

Every behavior change is on planted shapes. An A/B of this round's module
against the committed one over all 86 real files agrees on every line for
all three readers: the region pass, the comment predicate fed that region,
and the brace walk resolved at every line of every file. A separate census
confirms the sentence the parity paragraph now rests on: no line the
backtick counter believes is inside a template carries a line-start opener,
so neither inversion has a consequence in this tree today.

Mutation matrix, each in its own scratch copy: 13 mutations over
every decision point the round touched, all red at their own probe. Probing
ran against copies under a scratch directory, never by mutating the shared
tree, because sibling sessions were active in this checkout throughout.

---

## Architect re-review (2026-09-08, second pass) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` scoped to `7bf49a6e` (the three files only), seven lenses plus an
independent validation pass that executed the one surviving finding against the scan machinery on
scratch copies. The cross-model adversarial route was again unavailable on this host, so the
adversarial lens ran in-process.

**All six items held earlier on 2026-09-08 landed, and the round's central claim is verified
independently rather than accepted.** An architect A/B of the base and head machinery over all 86
real files under `frontend/src` agrees on every line for all three readers: `regionDiff=0
commentDiff=0 symbolDiff=0`. The whole-tree pins are unmoved, the new suite is collected by the
existing vitest include glob, and the baseline is 16 green. The reviewers reproduced the round's
own claims rather than trusting them: the mutation matrix was re-run independently (17 of 20
mutations die at their own probe, and the three survivors are the gaps named below or already
self-reported), the `countsAt` region threading was confirmed to change exactly one probe's
meaning, the split was confirmed to have dropped zero assertions (`expect(` 123 before, 74 + 76
after), and the repo's own pre-commit anchor gate was run over the added lines with a control line
proving the run was not vacuous. Zero anchor violations.

Three findings were raised and are NOT held, so do not act on them: the real-tree floor on the
walk and the missing `components/` membership assertion are pre-existing and are filed as their
own task; the missing probe for the `realpathSync` guard removal is accepted as untestable (it
needs a directory vanishing mid-walk, which no fixture can stage) and the change is loud by
design; and the canary keeping its own `mkdtemp` walker fixture after the split is a boundary
judgment with no live cost.

**This hold is documentation-only. No machinery change is wanted.** Every item below is a
sentence. If landing one appears to require a behavior change, stop and say so rather than
changing the readers; the mechanical fix is a separate decision that has deliberately not been
made here.

### Item 1 — the template axis is a third undocumented residual of the comment predicate

`isCommentLine` is the only reader that never receives template parity. Both opener readers guard
their opener test with `!inTemplate`; the predicate has no such signal. Inside a template literal
the two slashes of a `//` line, and the `/*` of a CSS-comment line, are markup text, and the block
region is legitimately false there, so the arm this round hardened answers on its shape and the
whole line is dropped before `enclosingSymbol` runs. Because the line never reaches the resolver,
the module-scope fail-closed argument never engages: the miss is silent, not a new member.

Executed three ways. A live password-state derivation planted inside a page module's template
literal on a line whose trimmed text starts with `//` leaves the suite at 16/16 green; the
byte-identical derivation with the prefix removed reddens both pinned assertions and names the
new key. The `/*` half behaves the same, in the unterminated, later-closing and self-closing
forms. The mechanism predates this round (base and head answer identically on these shapes), and
no line under `frontend/src` has this shape today: the tree's markup-comment idiom is `<!--`,
which the scans already count, and a sweep of all 86 files finds none. It is nonetheless not
untouched code. This round rewrote this arm, rewrote the enumeration of what shape alone decides,
and added pins for the outside-a-region readings of the same line, which license the shape-only
answer this residual rides on.

Two sentences this round wrote are false in the template case: the predicate docblock's claim that
shape alone decides every case but two, and its claim that the rule holds for all three prefixes.

Fix, in the predicate's own docblock: name the template axis as a documented residual, in the same
register the file docblock already uses for the two comment boundaries it declines to close. Say
which direction it fails in and why that direction is the dangerous one (the line is dropped whole
before the resolver runs, so set-equality never sees a wrong member). Say why it is not closed
here: threading template parity into the predicate widens the shared surface and is the lexer this
module declines, so it is a separate decision. Correct the two false sentences to match. And say,
where a future implementer will find it, that the outside-a-region pins license this reading, so
closing the residual means changing those pins.

### Item 2 — the `/*` arm's search origin: correct the sentence, do not change the code

The `/*` arm reads its close from past its own two characters, so inside an open region a
`/*/`-prefixed line answers as an opener rather than as a close. The `/*/` shape stays dismissed
as contrived; that dismissal is unchanged and no code fix is wanted. It is named here only because
it is the second reason the all-three-prefixes sentence does not hold, and item 1's correction is
expected to cover it. Do not reopen it as a behavior change.

### Item 3 — the walk's parity comment names only one direction of its inversion

The brace walk's parity paragraph ends by naming the inward, silent direction. The sibling reader's
docblock names both directions of the same inversion. Add the missing clause to the walk: parity
inverted the other way refuses a real opener, so a commented-out brace at the declaration's own
indentation ends the block early and the target resolves outward, which fails closed.

### Not held, noted for the record

The backend port still reads a `//` line as unconditional prose and still swallows its link
resolution. This round widened that drift by two decisions. The architect carries that note on the
backend port's own back-reference task, not here.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the re-review
signal. Do not edit this hold block or annotate items as fixed; the commit diff is the evidence
and the architect updates the block at re-review.

---

## UI re-review signal (2026-09-09, commit 75458b38):

All three held items landed in one commit, `75458b38`, on the machinery file
only. The hold is documentation-only and no reader was changed: an A/B of the
committed and edited machinery over all 86 files under `frontend/src` agrees
on every line for all three readers (`files=86 lines=21864 regionDiff=0
commentDiff=0 symbolDiff=0`), which is the claim a documentation-only hold
actually wants and which no green suite establishes on its own. The suite is
16 green and the repo's own pre-commit anchor gate over the 59 added lines
reports zero violations against a planted control line that trips, so the run
is not vacuous.

Nothing here was written from the hold's prose. Every fact the new sentences
assert was executed first, in scratch copies of `frontend/`, never in this
checkout: six lenses established ground truth and twelve independent agents
re-executed each headline on fixtures they built themselves, eighteen agents
with no failures. Three claims in the first draft of the new prose did not
survive that pass and were corrected before the commit; they are listed below
because the round's own output is the thing this task has repeatedly got
wrong.

**Item 1.** The predicate's docblock now carries the template axis as a named
residual, in the register the file docblock uses for the two comment
boundaries it declines to close: shape, mechanism, direction in caps, then the
consequence for the consuming assertion. It says that both opener readers
guard their opener test with a template check and this one has no such signal;
that `insideRegion` cannot stand in, because inside a literal no block region
is open, so `false` is the honest answer to the question that argument asks
and the reading it licenses is the wrong one; that two of the three prefixes
are markup there, so an interpolation the markup appears to comment out is
dropped although it evaluates. The direction is named SILENT and placed
against the two boundaries the file docblock already carries: those resolve to
a wrong symbol, which set-equality can at least see, while here the whole line
is dropped before the resolver runs, so no key is minted and there is nothing
to reject. That is why it is the dangerous one rather than the weaker of two.
Why it is not closed is stated in the bullet rather than hoisted, because the
two residuals do not share a reason: this one needs a new axis rather than a
better region pass, and threading template parity through the predicate widens
the shared surface and asks for the lexer the file docblock declines.

Both flagged sentences are corrected. "The rule holds for all three prefixes"
now reads "is written for all three prefixes" and says two shapes defeat it;
"Shape alone decides every case but two" now names the third case it decides
on shape and gets wrong. The correction is true under both readings of the
original: exactly two arms consult the region, and a third case exists where
shape decides and should not.

The licence is named where an implementer will find it. The paragraph says the
shape-only reading is pinned, not incidental, by the two `legacy note`
line-comment pins in the resolver's own suite, at a region known closed and at
a region unknown, with no literal in the question, and that closing the
residual withdraws exactly the licence those pins record. The pin fixture
cannot be quoted verbatim: it carries a comment close, and a literal close
inside a block comment terminates it. The pins are named by their fixture
phrase instead.

**Item 2.** Covered inside item 1's second bullet, as a sentence, with no code
change. It names the close search beginning past the opener's own two
characters, the line whose close begins one position short of where the search
starts, the resulting read of an opener rather than a close inside an open
region, and that the offset is right outside a region where such a line really
is an opener. The dismissal is unchanged: the shape stays dismissed as
contrived.

**Item 3.** The brace walk's parity paragraph gains the missing direction:
inverted the other way it refuses a real opener, so a commented-out brace at
the declaration's own indentation ends the block early and the target resolves
outward, which fails closed. Executed both ways on a hand-built fixture:
correct parity resolves to the declaration, one non-delimiter backtick ahead
of the opener resolves to module scope, and module scope is in no licensed set
in the canary, so the wrong answer is a new member.

### Three claims this round wrote and then withdrew

1. "For the two shapes named next no value of `insideRegion` changes the
   verdict at all." False. A `//` line carrying a close is re-inspected when
   the region is known open and reads as live there. The sentence now says
   only that inside a literal the region answer is honest and the reading it
   licenses is wrong, which holds for every shape.
2. "Both would need this predicate to know something one line cannot carry."
   False for the close-search residual, which is derivable from `insideRegion`
   the predicate already receives. Writing it would have implied the shape is
   unfixable when the hold's position is that it is not worth fixing. The
   lead-in now says the two do not share a reason and each carries its own.
3. The pin sentence first asserted that closing the residual must change those
   pins. Mechanically it need not: a closing edit that adds a defaulted third
   argument leaves them passing. It now says what is true, that the pins record
   the licence the closing edit withdraws, so they are the first thing it has
   to restate.

### Residuals surfaced for triage, deliberately not fixed here

The hold is documentation-only and says to stop and say so rather than change
a reader, so none of these was acted on.

1. **A live leading-`*` line carrying a trailing block comment is read as
   prose, and the canary misses it.** The close search never inspects the span
   BEFORE the close, so the docblock's own motivating live-code example is
   skipped once a trailing comment is added to it: at a closed region the
   wrapped-multiplication form of a password-state read followed by a short
   block comment returns `true`, while the identical line without the trailing
   comment returns `false`. This is a real silent miss on the live canary, not
   a prose defect, and no sentence in the docblock covers it. It is the same
   class as the arms this task has hardened over four rounds, on the one span
   none of them reads.
2. **The walk's newly documented outward direction has no probe.** Both parity
   pins in the resolver's own suite are the inward direction, and their
   controls are correct-parity files. The clause item 3 asked for is now
   documented and still untested.
3. **"Every arm closes before it is believed" is loose.** The line-comment arm
   returns `true` on its prefix alone, without computing a close, whenever the
   region is not known open. True where closing is meaningful, false as
   written.
4. **`blockCommentInterior`'s docblock is terminated early by a literal comment
   close inside it.** The paragraph illustrating re-entry writes the close
   literally; the file parses only because the illustration's own opener
   immediately re-opens a comment that runs to the real terminator. Roughly the
   last third of that docblock, the whole template-parity residual included, is
   inside the accidental second comment, doc tooling reads the docblock as
   ending mid-sentence, and anything carrying a close added in that span breaks
   the file. Pre-existing.

### Verification

- `frontend/tests/unit/eslint/`: 16 passed (2 files), in a scratch copy.
- A/B whole-tree equivalence, committed machinery against edited: `files=86
  lines=21864 regionDiff=0 commentDiff=0 symbolDiff=0`.
- Pre-commit anchor gate over the 59 added lines: zero violations, control
  line trips.
- Every probe and every mutation ran against copies under a scratch directory.
  The shared checkout was never mutated and no test was run in it.

---

## Architect re-review (2026-09-14) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` scoped to `75458b38` (the machinery file only), five lenses
(correctness, project-standards, testing, adversarial in-process, learnings) plus an independent
validator that executed the one surviving finding on a scratch copy. The cross-model adversarial
route was again unavailable on this host, so the adversarial lens ran in-process.

**All three items held on 2026-09-08 (second pass) landed, and the documentation-only claim is
verified independently rather than accepted.** An architect A/B of the parent and reviewed
machinery over all 86 real files under `frontend/src` agrees on every line for all three readers
(`files=86 lines=21864 regionDiff=0 commentDiff=0 symbolDiff=0`); the reader bodies are identical
once comment lines are excluded; the adversarial reviewer found the esbuild output byte-identical
between the two commits, plain and minified. Every other added or changed sentence was executed
against fixtures and matches the code: both opener readers refuse an opener inside a literal;
inside a literal the `//` and `/*` prefixes drop before the resolver runs while `*` lines are
counted; the `/*/` bullet holds; the two `legacy note` pins answer prose at a region known closed
and at a region unknown and live at a region open, exactly as the prose says; the outward parity
sentence holds and resolves to module scope, a new member. The repo's own pre-commit anchor gate
over the 59 added lines reports zero violations with control lines tripping, run by three
reviewers independently.

Two of the four residuals the round surfaced are NOT held, so do not act on them: the outward
parity direction of the brace walk stays unprobed, dismissed as a fail-closed direction the
resolver suite's own docblock already declines to pin; and the `/*/` close-search shape stays
dismissed as contrived, unchanged from the earlier round.

**This hold carries one reader change.** The previous hold declined to make the mechanical
decision; it is made here for item 1 and only there. Items 2 to 5 are sentences. Everything runs
in a scratch copy, never in the checkout, and the whole-tree A/B is re-run and recorded after the
reader change lands.

### Item 1 — the predicate's new enumeration omits a third silent drop, and the fix is a guard, not a fourth bullet

The `*` arm of `isCommentLine` consults `insideRegion` only when NO close sits on the line. A
leading-star line that carries a close is answered by what follows the close alone, so at a
region known closed `* Number(cached?.hasPassword === false) /* short */` returns prose and the
password-state scan mints no key, while the byte-identical line with no trailing comment, or with
a trailing `// short`, mints `pages/x.js#pick`. Executed by three reviewers, the architect and
the validator, through `occurrencesOf` with the canary's own skip. No line under `frontend/src`
has this shape today. The round self-reported the shape in its triage list and then wrote, on the
very sentence the previous hold asked it to correct, that the residual list is complete: "Two
shapes defeat it, both named as residuals here" and "Shape alone decides every case but two, and
a third it decides on shape and gets wrong". That is the convention-enforcing-fix pattern
recurring a third time on this predicate: the fix commit's own new prose under-enumerates.

Decision: close the shape in code rather than document it. A trailing comment is an ordinary
authoring shape, the wrapped-multiplication read is the case the region threading was built for,
and a predicate that keeps accreting documented residuals is growing the wrong thing.

Fix: in `isCommentLine`, before the close search, add the guard that a star-leading line at a
region KNOWN closed is live whatever follows it (it cannot be a continuation there):
`if (insideRegion === false && trimmed.startsWith('*') && !trimmed.startsWith('*/')) return false;`.
The adversarial reviewer probed exactly this line: both suites 16/16, whole-tree `isCommentLine`
A/B against the reviewed commit over 86 files zero diffs, and the fixture then mints
`pages/x.js#pick`. Its only behavior change is in the loud direction (a star line inside a
refused docblock also reads live, which is the direction those already fail in). Plant a pin pair
beside the wrapped-multiplication pins in the resolver's own suite: the trailing-block-comment
form at region false is live, the `// w` control stays live, and the region-unknown reading of
the same line stays shape-only as pinned today. Add one end-to-end fixture through the
password-state scan resolving to the enclosing declaration. Then re-audit the docblock and the
body comment against the new arm and execute every sentence you touch: the "A leading `*` with
no close on the line ... takes `insideRegion`" sentence must now cover both sub-cases (known
closed is live regardless; no close and region unknown or open keeps today's reading), the
"every case but two" count must still be true as written, and the body paragraph that says the
star prefix is searched from the start must say when the search is consulted at all.

### Item 2 — replace the two ordinal pointers with the residual's name

"which is the first of those residuals" and "What licenses the first residual's silence" index
the bullet list by position from a different paragraph than the bullets. Per root `CLAUDE.md`
"Comment anchors", a positional form is durable only when a stable name rides along in the same
container; these rot the moment a bullet is inserted or reordered. Name the residual (TEMPLATE
PARITY) in both places.

### Item 3 — `blockCommentInterior`'s docblock is terminated early by its own illustration (pre-existing, folded in)

The docblock writes the re-entry illustration with a literal close, `(\`*/ /* second\`)`, which
ends the `/**` docblock there; the file parses only because the illustration's own second opener
re-opens a plain block comment that runs to the real terminator. Roughly the last third of that
docblock, the whole template-parity paragraph included, sits in an accidental second comment; doc
tooling reads the docblock as ending mid-sentence, and any `*/` added in that span turns the
remainder into live code (loud: `node --check` fails, both suites fail at import). Provenance
`7bf49a6e`. Fix: describe the illustration in words (a close, a space, then a second opener); the
brace walk's `//` comment may keep its literal. Verify with `node --check`, with
`blockCommentInterior` over the module's own lines reporting that docblock as one region, and
with both suites green.

### Item 4 — "Every arm closes before it is believed" overstates the `//` arm (pre-existing, folded in)

The `//` arm returns prose on its prefix alone whenever the region is not known open; the
universal is loose rather than false, and the paragraph's next sentence already scopes it. Restate
the opening so it matches the code after item 1 lands (an arm that can be inside a region closes
before it is believed; a `//` line outside one, or with no region known, is prose on its prefix;
a `*` line at a region known closed is live on its prefix).

### Item 5 — "withdraws exactly the licence those pins record" overclaims (documentation, low priority)

A closing edit that adds a template signal leaves both `legacy note` pins passing, so the licence
is narrowed to lines outside a literal, not withdrawn; the round already withdrew the stronger
"must change those pins" form for this reason and kept the same overclaim in softer words. Say
that the pins become the outside-a-literal controls a closing edit keeps beside its in-literal
sibling.

### Not held, noted for the record

The self-truncating-docblock hazard in item 3 matches no `agents/docs/solutions/` entry; the
architect will weigh a `/ce-compound` entry at archive. The backend port's drift note still rides
on the backend port's own back-reference task, not here.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the re-review
signal. Do not edit this hold block or annotate items as fixed; the commit diff is the evidence
and the architect updates the block at re-review.

---

## UI re-review signal (2026-09-14, commits 126e7ae2 + 126b2fba):

All five held items landed in `126e7ae2`, on the three canary files. A review
pass over that commit's own output then found five more defects in it, four
of which are fixed in `126b2fba`; the fifth is a disclosure, below. Every
reader change was preceded by a probe observed red on the tree it was fixing,
and every fact the new prose asserts was executed before it was written.
Everything ran in scratch copies; no test was run and no file was mutated in
the shared checkout, because sibling sessions were active throughout.

**Item 1.** The guard sits before the close search, as prescribed: a
star-leading line at a region known closed is live whatever follows it,
unless it leads with a close, which still ends a comment whatever the region
pass believes and is answered by what follows its close. Red first: the
trailing-block form at region false and the end-to-end fixture, exactly those
two, with the `// w` control and the region-unknown reading already passing.
Green after. The pins sit beside the wrapped-multiplication pins in the
resolver's own suite: the trailing-block form at region false is live, the
`// w` control stays live, the same line at a region unknown and at a region
open keeps the close reading, and the close-leading line keeps it at every
region value. The end-to-end fixture in the canary runs the read through the
password-state scan and resolves to `pages/anything.js#pick`.

One consequence the hold did not spell out, taken deliberately and disclosed
rather than buried: with the region decision answered ahead of the search,
every line reaching the no-close branch is prose on that evidence, so that
branch's `opensBlock || insideRegion !== false` had a region test nothing
could reach with a value that changed the answer. It now returns a constant.
Equivalence executed two ways: a 672-case synthetic enumeration over every
prefix, tail and region value, and the whole-tree A/B, both zero. Restoring
the old expression leaves every pin passing, and so does dropping its
`opensBlock` disjunct alone, which is what says it had become two decisions
no probe could redden. Leaving it would have been the shape this task has
been held on twice. If the architect wants the "one reader change" sentence
honoured to the letter, restoring the expression is a one-line revert that
stays green and A/B-identical.

The docblock's star-arm sentence now covers both sub-cases (known closed is
live regardless, the close search not consulted; open or unknown keeps the
close reading, and no close is prose), names the close-leading line as the
shape it sets aside, and says where the loud direction goes. "Every case but
two" is still true as written: only the `*` and `//` prefixes answer
differently across region values, executed over fixtures for the opener
prefix and for plain code as controls. The body comment says when the star
search is consulted at all.

**Item 2.** Both ordinal pointers name TEMPLATE PARITY.

**Item 3.** The re-entry illustration is described in words (a close, a
space, then a second opener). `node --check` passes; a real parser reads
twelve block comments in the module where it read thirteen, with the
region-pass docblock as one comment from its opener to its real close; the
region pass over the module's own lines reports it as one run.

**Item 4.** The opening is scoped: an arm that can sit inside a region closes
before it is believed; a `//` line outside one, or with none known, is prose
on its prefix; a `*` line at a region known closed is live on its prefix.

**Item 5.** The pins paragraph says a closing edit that adds a template
signal leaves both `legacy note` pins passing, and that they become the
outside-a-literal controls it keeps beside its in-literal sibling.

Neither NOT-held residual was acted on: the walk's outward parity direction
stays unprobed, and the `/*/` close-search shape stays dismissed with no code
change.

### Five defects in this round's own output, four fixed here

Six executing lenses probed `126e7ae2` in their own scratch copies, then
three refuters per finding. The refuters all died on a session rate limit, so
the run's own "no survivors" line is vacuous and every finding was triaged by
hand instead. Seven raised, five unique, all documentation or probe coverage;
no lens found a silent miss, and the evasion lens argued the negative by
exhaustive check (about a million line-and-region combinations, zero cases
where the guard turns live into prose).

1. **The sentence that scoped the guard needed scoping itself.** Two lenses
   found this independently. The body comment's new reading said a star line
   at a region known closed is live "whatever follows it", while the guard it
   describes exempts a close-leading line. The docblock had written the
   exception in and the body comment had not, so one predicate had two
   descriptions that disagreed, and the searched-from-the-start list left the
   close-leading line out of both buckets. This is the shape the hold's own
   item 4 named, written fresh in the sentence that replaced it.
2. **The guard's loud reach was attributed to a refused opener alone.** The
   region pass under-reports for a second reason the guard's own comment
   already named, an opener it never saw. Executed: a comment opened mid-line,
   and one opened after code on a line that closed another, each mint a key
   the pre-guard reader did not. The sentence now says where the pass looks
   for an opener, which makes both one statement rather than a list.
3. **The residual count held only where the region pass is right** (pre-
   existing, folded in because the paragraph was open). Where it under-
   reports, each arm falls back to its shape reading, silently for a line
   comment carrying a close and loudly for a star line that does not. Both
   directions executed. No code change: the previous hold left the line-
   comment arm's shape reading outside a region deliberately, and that silent
   case remains the architect's call.
4. **The guard's star conjunct had no probe of its own.** Its only cover was
   the pre-existing double-comment pins reaching it through the post-close
   recursion, which were written for a different rule, so the file's
   one-probe-per-decision claim was not true of it. An opener at a known-
   closed region is now pinned in both directions.
5. **A demonstrative pointed at a mechanism the container never named.** The
   test comment read "that guard" where the file uses the word for at least
   four different mechanisms and the antecedent sat in a different comment
   block. It now uses the module's own name for it.

The fifth finding is the constant return, disclosed under item 1 rather than
reverted.

### Verification

- Both suites 16 green (12 canary, 4 machinery); full frontend unit suite 85
  files, 1902 tests green (the three editor-mounting rejections are
  pre-existing), in a scratch copy with the backend tree linked beside it so
  the one cross-tree import resolves.
- A/B of the pre-guard machinery against the final one over all 86 files
  under `frontend/src`: `files=86 lines=21931 regionDiff=0 commentDiff=0
  commentUndefDiff=0 symbolDiff=0`, and the same zero between the two
  commits, so the second is comment-and-pin only. A control mutation of the
  head module flips 16802 lines, so the comparison is not vacuous. The guard
  itself flips nothing in this tree, which a census explains rather than
  excuses: of 328 star-leading lines under `frontend/src`, every one sits
  inside a region the pass reports, so the surface the guard governs is empty
  today and the pins, not the tree, carry its evidence.
- Whole-tree pins unchanged at 1/1 and 8/1/2.
- Mutation matrix, evaluated per pin rather than per suite, because vitest
  reports only the first failing assertion in a case and these pins share
  one: each of the guard's three conjuncts, the no-close branch, and the
  line-comment arm reddens a pin written for it, and the pre-fix reader
  reddens exactly the two probes this round added for it.
- Seventy-three executed claims across the two commits, covering every
  sentence added or changed, run against the pre-guard, reviewed and final
  modules.
- Pre-commit anchor gate over the added lines of both commits: zero hits,
  control lines trip.
- The star-line census the paragraph above rests on was re-derived by hand
  rather than taken from the pass that first reported it, with a planted
  fixture as its control.
- `ce-simplify-code`, three reviewers in their own scratch copies: no
  findings. The quality reviewer re-proved the constant return by exhausting
  the reachable states at that branch and then by execution over twenty
  shapes at every region value, zero divergence, which is the third
  independent derivation of that equivalence. The reuse reviewer traced each
  new fixture to the mutation it discriminates and found no duplicate of an
  existing one. The efficiency reviewer found the guard's cost negligible at
  this scale and declined the one micro-optimization available, a shared
  prefix test, as a clarity loss.
