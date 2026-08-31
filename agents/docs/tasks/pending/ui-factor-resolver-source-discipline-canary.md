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
