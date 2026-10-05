# Port the after-close brace rule into the frontend enclosingSymbol walk, and correct its docblock

**Owner:** ui
**Created:** 2026-10-05

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
