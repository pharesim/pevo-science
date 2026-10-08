# Name the module's own suite in the frontend enclosing-symbol planted-probe sentence

**Owner:** ui
**Created:** 2026-10-08
**Priority:** low

Routed out of the architect review of `ui-enclosing-symbol-after-close-brace-port` (clean,
archived 2026-10-08). Its implementer flagged this as the frontend twin of item 2 of
`backend-enclosing-symbol-brace-gloss-and-suite-citation`. Docblock only, no code change.

## Why

The file docblock of `frontend/tests/unit/eslint/enclosing-symbol.js` says textual resolution
"is why {@link enclosingSymbol} is exercised by planted positives and negatives in the canary
that consumes it." The module's own suite, `enclosing-symbol.test.js` beside it, also calls
`enclosingSymbol` on planted sources (31 call sites at HEAD `5404b32c`), and the walk comment
inside `enclosingSymbol` already cites "the resolver's own suite". The sentence is incomplete,
not false. The backend task named above carries the same correction for the backend copy.

## Scope

1. Add the module's own suite to the planted-probe sentence, naming it by file name
   (`enclosing-symbol.test.js`, beside this file), and keep the consuming canary.

## Acceptance criteria

1. The planted-probe sentence names both the module's own suite and the canary that consumes
   it, and is true against the tree at the HEAD you land on.
2. Docblock only. Run `npx vitest run tests/unit/eslint/` and quote the result. The
   `.githooks/pre-commit` anchor gate passes on the commit.

## Notes

- Do not edit `backend/`. Do not cite a task slug or SHA in the docblock, and add no claim
  about which copy is ahead.
