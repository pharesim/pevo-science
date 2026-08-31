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
