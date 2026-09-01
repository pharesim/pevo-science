# Add a reciprocal port pointer to backend/tests/support/enclosing-symbol.ts

**Owner:** backend
**Created:** 2026-09-01

Routed out of the architect review of the first frontend source-discipline canary
(`ui-factor-resolver-source-discipline-canary`). The architect has ratified that the
two `enclosing-symbol` implementations stay as deliberate dialect divergence rather
than a shared cross-zone module; this task adds the one cheap mitigation that
decision needs.

## Why

`frontend/tests/unit/eslint/enclosing-symbol.js` is a hand-port of
`backend/tests/support/enclosing-symbol.ts`. Roughly 65-70 of its non-docblock lines
are a near-literal, dialect-adjusted copy, including the closing-brace / indentation
walk (the highest bug-risk region). The two files legitimately diverge (the frontend
adds Alpine method-shorthand and template-literal declaration shapes and a per-key
occurrence tally; the backend has `isCommentedOut` the frontend dropped), so a shared
module is not warranted.

The one real cost of the divergence is that a future bugfix to the shared brace-walk
logic has no forcing function to reach the sibling copy. The frontend docblock already
acknowledges the port one-directionally; the backend file has no pointer back.

## Scope

1. Add a one-line pointer in `backend/tests/support/enclosing-symbol.ts`'s docblock
   naming `frontend/tests/unit/eslint/enclosing-symbol.js` as a hand-ported sibling,
   so a future change to the shared closing-brace / indent walk prompts checking the
   frontend copy. Anchor it on the file path and the shared-algorithm description, not
   on this task's slug.

## Acceptance criteria

1. `backend/tests/support/enclosing-symbol.ts` carries a docblock note pointing at the
   frontend sibling and naming the shared walk as the thing to keep in sync.

## Notes

Docblock-only, no code change. This is the backend-zone half of a decision recorded in
full on the canary task; the frontend canary itself needs no change for this item.
