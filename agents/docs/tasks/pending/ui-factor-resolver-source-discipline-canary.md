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
