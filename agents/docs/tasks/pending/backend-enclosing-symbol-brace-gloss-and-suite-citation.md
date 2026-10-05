# Correct two enclosing-symbol docblock sentences the walk has outgrown

**Owner:** backend
**Created:** 2026-10-05
**Priority:** low

Routed out of the architect re-review of `backend-enclosing-symbol-port-backreference`
(clean at `2f27df71`, archived 2026-10-05). Both items are HEAD-state drift: each
sentence was accurate when written and was made false or incomplete by later commits to
the same file. Docblock only, no code change.

## Why

1. **The sibling paragraph glosses the closing-brace test with a rule this copy no
   longer has.** The "Hand-ported sibling." paragraph at the tail of the file docblock in
   `backend/tests/support/enclosing-symbol.ts` says the two copies share
   "{@link enclosingSymbol}'s upward declaration scan and its closing-brace test (a
   declaration whose block closed at or left of its own indentation is rejected)". That
   matched both copies when it was written. Since `146ce7de` this copy's walk also reads
   a comment close that begins its trimmed line, and takes a `}` leading the code after
   any close it reads, at any indentation (`afterClose || indentOf(line) <= declIndent`
   inside `enclosingSymbol`). The same docblock states the full rule twice already: the
   rule sentence near the top ("a `}` at or left of the declaration's own indentation, or
   one leading the code after a comment close") and the WHICH BRACE THE WALK SEES section.
   The parenthetical is the one statement of the three that disagrees. `71217d5f` added
   a sentence recording that the brace test is shared only up to the comment close;
   `d0c7f771` removed it and changed "share one algorithm:" to "share one algorithm in
   outline:", which hedges the sharing but leaves the parenthetical describing a rule this
   copy does not implement. Measured on both files at HEAD `9e731556`:

   | Shape (target line after the block) | Correct | This copy | Frontend copy |
   |---|---|---|---|
   | `ok(); /* note` then `  */ }` ending the function | module | module | inner |
   | `/* note` then `   */ }`, indented right of the declaration | module | module | inner |
   | `   */ }` closing an inner `if`, target still inside `f` | `f` | module | `f` |
   | control: `*/ }` at the declaration's indentation | module | module | module |

2. **The planted-probe sentence omits the module's own suite.** The file docblock says
   textual resolution "is why {@link enclosingSymbol} is exercised by planted positives
   and negatives in the canaries that consume it." That wording replaced a false "in its
   own test file" at a time when no such file existed. `backend/tests/support/enclosing-symbol.test.ts`
   has existed since `a8000291` and calls `enclosingSymbol` on planted sources (21 call
   sites at `9e731556`), and the same docblock already cites "the machinery's own suite
   beside this file" further down. The sentence is incomplete, not false.

## Scope

1. Replace the closing-brace parenthetical in the "Hand-ported sibling." paragraph so it
   no longer states a rule this copy does not implement. Either name the shared pieces
   without a behavioral gloss (the upward declaration scan and the brace walk), or point
   at this copy's own rule by its section name, WHICH BRACE THE WALK SEES. Do not restate
   the full rule a fourth time.
2. Add the module's own suite to the planted-probe sentence, naming it by file name
   (`enclosing-symbol.test.ts`, beside this file), and keep the consuming canaries.

## Acceptance criteria

1. Every statement in the "Hand-ported sibling." paragraph about what the two copies share
   is true against both `backend/tests/support/enclosing-symbol.ts` and
   `frontend/tests/unit/eslint/enclosing-symbol.js` at the HEAD you land on.
2. The planted-probe sentence names both the module's own suite and the canaries that
   consume it.
3. Docblock only. The `.githooks/pre-commit` anchor gate passes on the commit.

## Notes

- A ui task (`ui-enclosing-symbol-after-close-brace-port`) is open to port the after-close
  arm into the frontend walk. The two can land in either order, so do not write a sentence
  whose truth depends on which landed first, and do not add a claim about which copy is
  ahead: the paragraph sends the reader to the sibling for that on purpose, because the
  direction has already flipped twice. Do not cite that task, or any slug or SHA, in the
  docblock.
- Do not touch the frontend copy.
- Measure each sentence you write against both files before landing it, per
  `agents/docs/solutions/conventions/comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md`.
