# The interpolation limit says every consequence is loud, and one is not

**Owner:** backend
**Created:** 2026-09-22

Routed out of the round-7 architect review of the `accounts.updated_at` writer
canary (`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`),
which archived clean. Text only. Nothing here changes what the reader does; it
changes three sentences that describe it, one of which is false for a shape the
adversarial lens built and reproduced in isolated copies of the range base and
head.

## Why

The interpolation bullet in the docblock's KNOWN LIMITS says that the statement
read and `enclosingQuote` still read an interpolation flat while the blanking
copies it whole, and that "every consequence found is loud, an assignment left
unresolved or a statement reported unreadable". That was true of everything the
implementer's search found. It is not true of this line, planted as a scratch
file under `backend/src/lib/`:

```ts
if (strict) /'/.test(s); const label = `outer ${fmt({ a: 1 }, `it's`)} end`; await q(`UPDATE accounts SET updated_at /* stamped */ = NOW() WHERE id = $1`, [id]);
```

At the range base both writer walks red it. At head the suite is fully green.
Three ingredients have to share one line: the pattern-after-`)` misjudgement
the regex bullet already documents (`if (x) /re/` read as a division, whose
quote then opens a phantom value), a quoted interpolation, and a writer with a
comment in its token gap. Controls: without the interpolation the statement is
reported unreadable in both trees (loud); with `it's` spelled `its` both trees
are loud; the plain writer without the comment is red in both. So the hold's
plain-writer bar is not met and the trigger is a documented misread neither
tree spells. It is a residual, and the sentence should say so rather than say
there is none.

## Scope

1. Qualify the sentence. The adversarial lens's wording is a defensible start:
   "Every consequence found is loud where no phantom value is open on the
   line: an assignment left unresolved or a statement reported unreadable.
   With one open in code (the pattern-after-`)` misjudgement above), the flat
   read can close that phantom at a quote inside the interpolation and reach a
   terminator the blanking reader, which kept the phantom, never reached, so a
   comment in that write's token gap is then silent where the same line
   without the interpolation is reported unreadable. Neither tree spells the
   trigger." Keep the anchor on the regex bullet by its content, not by
   position.
2. Optional, same commit, one sentence each:
   - `lineCommentEnd` hands `tagAt` its `inTemplate` argument where the branch
     callers in `blankLine` hand it `!sql`. The two coincide wherever `tag` is
     non-null, because in a TypeScript file a dollar span opens only inside a
     template and is force-closed at the template's backtick. Say so in the
     `lineCommentEnd` docblock, or thread `!sql` through as `interpolates` and
     keep `inTemplate` for the backtick and escape arms.
   - `typescriptView` builds its own `starts` array and `lineOf` search rather
     than calling `sf.getLineAndCharacterOfPosition`. That is deliberate:
     TypeScript's line map counts a lone `\r`, U+2028 and U+2029 as line
     breaks, while the reader's `lines` array is `split('\n')` and every
     per-line map the view returns is indexed by that array in `blankAll`. A
     one-line comment naming that reason keeps the next reader from
     "simplifying" it into a misaligned map; the round-7 maintainability lens
     proposed exactly that and the validator refuted it by execution.

## Acceptance criteria

1. The KNOWN LIMITS sentence no longer claims every consequence of the flat
   interpolation read is loud, and names the phantom-value condition under
   which one is silent.
2. The planted line above stays green at head (no reader change is asked for;
   this task records the residual, it does not close it). If the implementer
   chooses to close it instead, that is a design change to `statementAt` /
   `enclosingQuote` and needs its own task, not this one.
3. No new sentence contradicts the code beside it. The canary and
   `tests/eslint/` stay green.

## Notes

- Do not fold in the `[TODO Architect]` items the canary task carried at
  archive (`x[k]--` read as a SQL comment, `export default /re/`, the two
  pre-existing false reds, the CHECK constraint, moving the rest of the
  reader's TypeScript layer onto the parser). They stay open triage.
- A sibling task is active on the same file (the ALTER-head work). Land this
  as its own small commit so the two do not interleave in one diff.
