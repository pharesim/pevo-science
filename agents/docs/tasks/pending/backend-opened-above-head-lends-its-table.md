# A head in a template opened on an earlier line reads past it and lends its table

**Owner:** backend
**Created:** 2026-09-22

Found by the sweep during the round-2 work on the assembled-write ALTER head, in the same
canary (`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`).
Pre-existing, not about the `+` join, and in the silent direction for the arm the file leans
on hardest, so it is filed rather than folded into that round.

## Why

`enclosingQuote` reads the head's own line from its start. A head sitting in a template
opened on an earlier line therefore has no enclosing quote as far as that function is
concerned, so `statementAt` runs with `quote` null and reads to the first `;` instead of to
the template's closing backtick. The read then covers whatever TypeScript follows the
template on those lines, and `targetTable` hands a write in that text the head's table.

Where the second write's own head is unreadable, that is a silent pass rather than a
mislabel. An unreadable head is exactly what the fail-closed arm exists to catch: with no
head reaching it, the assignment resolves to `UNRESOLVED_TABLE` and reds by line. Reached by
the opened-above head instead, it resolves to that head's table and nothing fires. The two
shapes with unreadable heads are the ones the KNOWN LIMITS entries already name, a
dynamically named target and a quoted identifier, and both are the shapes the file says the
fail-closed arm backstops.

The quoted-identifier bullet under KNOWN LIMITS states the condition too narrowly. It says
the SET-list form "reds by resolution instead, but only where no readable head opens earlier
in the same quoted text", and gives the reason that a statement read ends at the quote that
encloses it rather than at a `;`. For a head whose template opened on an earlier line the
read ends at the `;`, so a sibling statement in the code after the template is reached
without opening in the same quoted text at all.

## Scope

1. Decide whether to close this in the reader or to record it as a named limit. The blanking
   reader already tracks template state per line and `BlankedCode` already carries replayed
   span events, so there is a plausible path to telling `enclosingQuote` that a template is
   open at the line's start; whether that path is sound at every arm is the question, not a
   prescription. Weigh it against the file's own standard: the fail-closed arm's guarantee is
   what the rest of the KNOWN LIMITS rest on, so a limit here is worth more than a limit in
   the assembled arm.
2. If it is closed, pin it: a fixture that reds when the change is reverted.
3. If it is recorded, state the bound where a reader will hit it, and audit the file for every
   statement of where a statement read ends rather than trusting the two named here. At least
   the quoted-identifier bullet under KNOWN LIMITS and the `enclosingQuote` docblock, whose
   cost sentence currently names the join test only, both state it.
4. Either way, say what the sweep covered from the code rather than asserting completeness.

## Acceptance criteria

1. A sibling write with an unreadable head, planted in a `src` file after a head whose
   template opened on an earlier line, is either reported by some arm or its silence is
   recorded as a named limit with the reasoning that makes it acceptable. Demonstrated by
   planting, either way.
2. The clean tree stays green and the runtime tallies are unchanged.
3. If the reader changes, the byte-identical no-op over the scanned files is re-measured, not
   assumed: the round that introduced `typescriptView` reported it over all scanned files and
   that is the bar.

## Notes

Measured at the time of filing, in scratch copies built with `git archive`, never in the
shared checkout. Each plant is 29/29 green while its control, the same text with the
template's backtick on the head's own line, reds `every updated_at assignment resolves to the
table it writes`:

- a `UPDATE ${table} SET updated_at = NOW()` sitting after an opened-above
  `UPDATE sessions` head, both inside one call;
- the same layout with `'UPDATE "accounts" SET updated_at = NOW()'` as the second statement.

One live `src` head already reads past its own backtick this way, the import-queue UPDATE in
`bridge-queue.ts`. It is harmless today because nothing sits between that backtick and the
`;` two lines below it, and it is not an `accounts` head, but it shows the layout is house
style rather than contrived.
