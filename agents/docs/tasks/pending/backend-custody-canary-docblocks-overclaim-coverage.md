# The custody-claim canary's docblocks claim coverage its scans do not have

**Owner:** backend
**Created:** 2026-10-05
**Priority:** low

Routed out of the architect re-review that archived
`backend-custody-canary-unpinned-surfaces` (2026-10-05). One item is that
review's confirmed finding; the other three come from the "for architect
triage" list the implementer of that task left. All four are
pre-existing prose in one file. Filed separately rather than held, so a task
whose hold items had all landed was not held for another round.

## Why

`backend/tests/eslint/no-custody-claim-derivation-outside-helper.test.ts` is a
merge-blocking canary, and its docblocks are what a maintainer reads before
moving a cap or loosening a pattern. Four passages state coverage the code
does not have. Line numbers below are at HEAD `c8f43eb9` and are only for
finding the text: never cite them in the file.

1. **Comment lines and the join budget.** `statementFrom` steps over a line
   only when `isCommentLine` reads it as comment. Any other non-blank line it
   reaches is joined and counts against `STATEMENT_JOIN_CAP`. `isCommentLine` reads a
   line whose trimmed text starts with none of `/*`, `//` or `*` as live code,
   inside a block comment or not. Three passages still say every comment line
   is free:
   - the `STATEMENT_JOIN_CAP` docblock, "steps over comment lines for free"
     (line 266);
   - the same docblock, ", so stepping over prose costs nothing there"
     (line 272);
   - the probe comment in the test titled "a derivation wrapped,
     optional-chained, bracketed, or destructured is still refused", "a note
     beside the branch it explains cannot spend the budget the expression
     needs" (line 868).

   Measured at `ab6fe37b` by the review's correctness lens and confirmed by
   its validator: a wrapped ternary with `/*`, four unstarred note lines and
   `*/` between its halves reports 0 sites. The same layout with star-leading
   notes reports the derivation. `statementFrom`'s own docblock already states
   the narrowed form ("Lines inside the run that `isCommentLine` reads as
   comment").
2. **Typed destructure.** The `COLUMN_DESTRUCTURE_RE` docblock says "The
   refusal is absolute for a declaration destructure naming the column"
   (line 216). Scan 2 in the module docblock says the column read is refused
   "in every spelling that reaches the same property (plain, optional-chained,
   non-null-asserted, cast, bracketed, destructured)" (line 32). Measured by
   the architect, the three scan-2 patterns as written at HEAD against one
   line each: `const { custody }: AccountRow = row;` matches none of
   `EPOCH_TERNARY_RE`, `COLUMN_COPY_RE` or `COLUMN_DESTRUCTURE_RE`, and the
   control `const { custody } = row;` matches `COLUMN_DESTRUCTURE_RE`.
   `COLUMN_DESTRUCTURE_RE` needs `=` after the closing brace with only
   whitespace between.
3. **Parenthesised and cast branches.** Scan 2 in the module docblock refuses
   "a ternary on `upgraded_at` yielding a custody literal" (line 30), and the
   `EPOCH_TERNARY_RE` docblock describes "A conditional on the epoch column
   that yields a custody literal" (line 152). Measured by the architect the
   same way: `const c = row.upgraded_at ? ('self') : ('light');` and the same
   with `('self' as const)` and `('light' as const)` match no scan-2 pattern;
   the control `const c = row.upgraded_at ? 'self' : 'light';` matches
   `EPOCH_TERNARY_RE`. The pattern needs a `?`, optional whitespace, then a
   quoted `self` or `light`.
4. **Walk-cap cost.** The `STATEMENT_SCAN_CAP` paragraph of `statementFrom`'s
   docblock says "A derivation split by twelve or more consecutive comment
   lines still escapes" (line 421), and its pinning sentence refers to "the
   twelve stated here" (line 426). The walk bound in `statementFrom`'s loop is
   `j <= lineIndex + STATEMENT_SCAN_CAP`, and `j` advances on every line
   walked, code or comment. The implementer of the archived task measured 6
   comment lines, 1 code line and 5 comment lines between a derivation's
   halves escaping. The architect confirmed this by reading the loop, not by
   running it.

## Scope

Prose only. No pattern, cap, probe or assertion changes.

1. Narrow or delete the three clauses in item 1 so they claim only the lines
   `isCommentLine` reads as comment.
2. Narrow or delete "absolute" and "every spelling" in item 2.
3. Narrow the two descriptions in item 3 to the spelling `EPOCH_TERNARY_RE`
   matches. Intent only: write the sentence against the pattern.
4. Make item 4's escape condition name what the walk counts, or delete the
   condition. Keep the pinning sentence's "twelve" consistent with whatever
   remains.

## Acceptance criteria

1. Every sentence you change is measured against the code before it lands:
   a plant and a control in a `git archive` copy, recording which went red.
   A sentence you cannot measure is deleted, not reworded.
2. Each fix deletes or narrows the claim. Do not add exception lists,
   mechanism explanations or new "because" clauses (root `CLAUDE.md`,
   "Comment anchors").
3. No line numbers, task slugs, round numbers or SHAs in the file.
4. `tests/eslint/` stays green.

## Notes

- Dismissed at the same review, do not reopen here: an `EPOCH_TERNARY_RE`
  pattern change for parenthesised, cast, `&&`/`||`, named-constant or
  lookup-table branches (no instance exists in `backend/src`); the scan-2
  "does not see" list over-matching some intermediate-binding and
  control-flow variants (safe direction, both listed examples unseen as
  written); the count in "the four row-reading mints".
- Another backend commit, `c18d37cf`, edited this file after the archived
  task's last commit, in the helper-caller list. Make the edits on current
  HEAD.
