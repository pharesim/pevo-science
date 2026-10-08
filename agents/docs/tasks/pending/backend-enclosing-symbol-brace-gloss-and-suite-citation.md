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

## Folded in at the frontend port's review (2026-10-08)

The frontend port of the after-close arm landed (`78abead8`, archived 2026-10-08). Its
implementer listed backend sentences that its own frontend docblock rewrite had to narrow.
Each was checked against `backend/tests/support/enclosing-symbol.ts` and its suite at HEAD
`5404b32c` (neither changed since the port). Delete or narrow each one; add no exception list
and no new claim. Measure the result against the code, as for items 1 and 2.

3. `blockCommentInterior` docblock: "Openers are recognized at line start only, which is the
   same boundary the rest of this module draws." Delete it. The region pass also reads an
   opener in the code after a close it reads (`*/ /* second` re-enters), and the walk reads
   the code after a line-leading close even when no region is tracked.
4. WHICH BRACE THE WALK SEES: "It tracks a block comment opened at the start of a line, ...".
   Narrow it to a multi-line block comment. `opensUnterminatedBlock` refuses a comment that
   closes on its own line, so `/* note */ }` is not tracked, which the INWARD bullet states.
5. The walk comment in `enclosingSymbol`: "A `}` leading the code after a close ends the
   declaration WHATEVER the line's indentation." Narrow "a close" to a close the walk reads.
   The close of a comment opened mid-line after other code is not read when it does not begin
   its line, and a `}` after it is not taken.
6. The file docblock's rule summary: drop "demonstrably" (an after-close `}` that really closes
   an inner block also rejects the declaration), and narrow "after a comment close" to a
   comment close the walk reads.
7. "a comment opened mid-line", in the INWARD item ("the close of a comment opened mid-line
   when that close does not begin its line") and in the walk comment ("the walk does not see a
   comment opened mid-line"): narrow both to a comment opened mid-line after other code. The
   walk can track an opener at the start of the code after a close it reads.
8. The INWARD item "a `}` indented right of its own declaration": narrow it to a `}` leading
   its line indented right of its own declaration. A `}` after a close the walk reads is taken
   at any indentation.
9. `enclosing-symbol.test.ts`, the region-pass comment "OPENER, line start only: the same
   boundary the brace walk draws.": delete "the same boundary the brace walk draws". The walk
   also reads an opener after a close it reads.

Acceptance for items 3 to 9: each named sentence is deleted or narrowed so it is true against
the code at the HEAD you land on. Run `npx vitest run --retry=0 tests/eslint` and
`tests/support/enclosing-symbol.test.ts` alone and quote the result in the signal block.
