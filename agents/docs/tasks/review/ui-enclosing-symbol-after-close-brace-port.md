# Port the after-close brace rule into the frontend enclosingSymbol walk, and correct its docblock

**Owner:** ui
**Created:** 2026-10-05
**Priority:** low

Routed out of the architect re-review of `backend-enclosing-symbol-port-backreference`
(archived 2026-10-05). The two enclosing-symbol copies stay separate by ratified decision
(dialect divergence, no shared module). This task brings the shared brace walk back in
line where the backend copy moved, and fixes three frontend docblock statements.
User decision 2026-10-05: port the rule rather than decline it.

## Why

1. **The brace walks split at a comment close.** Since `146ce7de` (2026-10-01) the
   backend `enclosingSymbol` in `backend/tests/support/enclosing-symbol.ts` reads a
   comment close that begins its trimmed line even when no tracked region is open, and
   takes a `}` leading the code after any close it reads, at any indentation
   (`afterClose || indentOf(line) <= declIndent`). The frontend walk in
   `frontend/tests/unit/eslint/enclosing-symbol.js` only takes a `}` at or left of the
   declaration's indentation. Measured on both files at HEAD `9e731556`:

   | Shape (target line after the block) | Correct | Backend | Frontend |
   |---|---|---|---|
   | `ok(); /* note` then `  */ }` ending the function | module | module | inner (INWARD) |
   | `/* note` then `   */ }`, indented right of the declaration | module | module | inner (INWARD) |
   | `   */ }` closing an inner `if`, target still inside `f` | `f` | module (OUTWARD) | `f` |
   | control: `*/ }` at the declaration's indentation | module | module | module |

   INWARD is the direction a set-equality canary absorbs silently when the inner
   declaration is a licensed key. OUTWARD fails closed unless the allowlist holds the
   enclosing scope. The backend took the third row's OUTWARD cost on purpose, and its
   docblock's OUTWARD bullet names it ("a `}` after a read close ends the declaration even
   where it really closes an inner block"). No line in `frontend/src` or `backend/src`
   has a line-leading comment close followed by code today, so the exposure is latent.

2. **Three frontend docblock statements are false or one-directional.**
   - "The ordinary single-boundary form of that second shape, a close sharing its line
     with the real closing brace, IS handled: the walk reads the code after the close."
     Today this holds only when the close's line sits at or left of the declaration's
     indentation and the comment opened at a line start (rows 1 and 2 above are not
     handled).
   - The SET-EQUALITY bullet says set-equality assertions "fail closed: a wrong symbol is
     a new member and therefore a red bar, never a silent pass." That contradicts the
     same docblock's INWARD bullet, which says the multi-boundary miss "resolves INWARD,
     which is the direction a licensed key can absorb." An INWARD answer that names a
     licensed declaration is absorbed. The backend copy's SET-EQUALITY bullet was
     rewritten to say so.
   - The frontend file names its sibling only as "the backend's declaration shapes" and
     "the backend port", with no path. The backend file docblock carries a path pointer
     to this file and a two-way obligation; this file has no pointer back, so a change made
     only here never prompts a reader to check the backend copy. (Held out of scope for the
     backend task at its 2026-09-08 review as ui-zone; picked up here because this task
     edits the same docblock.)

## Scope

1. Port the backend's line-leading close read and after-close brace arm into the frontend
   `enclosingSymbol`, keeping the frontend's own dialect machinery (the template-literal
   declaration branch and the rest). Pin rows 1 to 3 as planted probes in the suite that
   pins the walk, row 3 as the accepted OUTWARD residual.
2. Update the frontend file docblock: the statement(s) of which brace the walk sees,
   including the OUTWARD cost the port takes on; the "IS handled" sentence; the
   SET-EQUALITY bullet; and a reciprocal pointer naming
   `backend/tests/support/enclosing-symbol.ts` by path with the obligation that a change
   to the walk, the region pass, or the comment predicate in either file is a prompt to
   read the other.

## Acceptance criteria

1. The four shapes in the table resolve the same in both copies.
2. Every frontend docblock sentence about which brace the walk sees is true against the
   code at the HEAD you land on.
3. The SET-EQUALITY bullet no longer claims a wrong symbol can never be a silent pass.
4. The frontend file docblock names `backend/tests/support/enclosing-symbol.ts` by path
   and states the two-way obligation.
5. The frontend unit suite passes, including every canary built on this module, with no
   change to an allowlist (the port must not newly absorb an existing occurrence).
   No anchor-rot form in added lines; the `.githooks/pre-commit` gate passes.

## Notes

- Do not add a "which copy is ahead" claim to the frontend docblock. The backend paragraph
  sends the reader to the sibling for that on purpose, because the direction has flipped
  twice already.
- A backend task (`backend-enclosing-symbol-brace-gloss-and-suite-citation`) corrects the
  backend docblock's description of the shared brace test. The two can land in either
  order. Do not cite either task, or any slug or SHA, in the docblock.
- Do not edit `backend/`.

UI implementation signal (2026-10-05, commits `78abead8`, `a2085733`):

- `78abead8`: the port (line-leading close read, `afterClose`, brace condition
  `afterClose || indentOf(line) <= declIndent`, textually the backend walk apart from the
  template-literal branch), the docblock rewrite, and the suite probes. `a2085733`: the canary
  header narrowing below (user-approved fold-in). Both verified on main
  (`git merge-base --is-ancestor`), file lists match.
- AC1: the four table rows give module/module/module/module on both copies (HEAD frontend gave
  f/f/f/module). A differential over about 12M generated files (37M + 25M targets) found 0 walk
  divergences between the copies outside dialect-only declaration shapes; a mixed-dialect corpus
  attributes every divergence to a declaration only one dialect recognizes.
- AC2: one rule statement (WHICH BRACE THE WALK SEES) with OUTWARD/INWARD bullets replaces the
  two-boundary paragraph and the "IS handled" sentence; the OUTWARD bullet carries the port's
  inner-block cost. Three adversarial verification rounds planted every shape the bullets name.
  Sentences the port or the new bullet made false were narrowed or deleted beyond the three the
  task names: the walk comment (tracking, re-entry, after-close brace, "fails closed" now per
  allowed key, "silent" dropped from the inward label); the region-pass docblock's "Openers are
  recognized at line start only, which is the same boundary the rest of this module draws"
  (deleted: the walk now also reads after an untracked line-leading close); the rule summary
  ("demonstrably" dropped, "a close the walk reads"); "two shapes the backend copy does not"; the
  isCommentLine cross-reference; sourcesUnder "a deliberate divergence"; in the suite, the
  header's false "both resolve outward to module scope" rationale and "and no other", plus three
  probe comments (width-pin "absorbs", "The residual resolves outward", "every declaration the
  walk tests") and the region-pass OPENER comment's "same boundary the brace walk draws".
- AC3: the SET-EQUALITY bullet now says set-equality fails closed when the wrong key is not
  allowed, that keys alone absorb an allowed wrong key, and that a per-key count pin turns an
  absorbed addition into a moved count.
- AC4: a "Hand-ported sibling." paragraph names `backend/tests/support/enclosing-symbol.ts` and
  the two-way obligation; no which-copy-is-ahead claim, no slug or SHA.
- AC5: eslint dir 2 files / 18 tests green; full frontend unit suite 91 files / 2135 tests green
  (two-level scratch copy; later edits were comment-only); no allowlist change; A/B of the HEAD
  and ported walk over all 88 `frontend/src` files gives symbolDiff=0; zero line-leading closes
  followed by code in `frontend/src` or `backend/src`; the anchor gate on added lines is clean
  (control line fires); babel parse shows the block-comment count unchanged (no escaped close
  ended a docblock early).
- User decisions (2026-10-05): (1) four surviving mutants of the new arm (close read widened to
  `includes`, `afterClose` hoisted out of the per-line loop, the opener test skipped after an
  untracked close, `lastIndexOf` in the slice) are DISMISSED as preemptive hardening; the backend
  suite has the same gaps. (2) The canary header's "an unresolvable or wrongly resolved symbol
  fails closed as an unexpected member" overclaim was folded in (`a2085733`, "or wrongly
  resolved" deleted).
- Code review: not run here; agents/ui/CLAUDE.md assigns it to the architect at intake.
- Out of scope, for follow-up filing (backend twins of sentences narrowed here, all in
  `backend/tests/support/`): `blockCommentInterior`'s "Openers are recognized at line start only,
  which is the same boundary the rest of this module draws" (false there since the backend walk
  reads after an untracked line-leading close); the WHICH BRACE tracking sentence lacks
  "multi-line" (a self-contained `/* note */ }` reads as tracked); the walk comment's "A `}`
  leading the code after a close ends the declaration WHATEVER the line's indentation" lacks
  "the walk reads"; the rule summary's "demonstrably" and its unqualified "after a comment
  close"; the INWARD item "the close of a comment opened mid-line" and the walk comment's "does
  not see a comment opened mid-line" lack "after other code"; the INWARD item "a `}` indented
  right of its own declaration" (a `}` after a read close is taken at any indentation); the suite
  comment "OPENER, line start only: the same boundary the brace walk draws". The frontend twin of
  the backend sibling task's item 2 also stands: the file docblock's "in the canary that consumes
  it" omits the module's own suite (incomplete, not false).
