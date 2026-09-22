## UI-FACTOR-RESOLVER-SOURCE-DISCIPLINE-CANARY — Guard the single-resolver invariant for re-auth factor selection (archived 2026-09-22) — 7 hold rounds (6+8+6+3+5+3 items, all FIXED), round 7 review clean; 2 findings dismissed at triage ✓


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

