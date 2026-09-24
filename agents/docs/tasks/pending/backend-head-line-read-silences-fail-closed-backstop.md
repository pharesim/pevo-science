# A head in a template opened above reads past its own backtick and lends its table to a sibling write

**Owner:** backend
**Created:** 2026-09-22

Routed out of the round-2 architect review of `backend-assembled-writes-misses-alter-head`.
The backend's own round-2 sweep found it and recorded it as a `[TODO Architect]` gap
rather than fixing it, since it is pre-existing and not about the `+` join that round was
bounding. The user triaged it on 2026-09-22: file it as its own task. That entry is
superseded by this file, so it is not triaged again there.

## Why

In `backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`
the fail-closed arm resolves every `updated_at =` to the nearest readable head above it
and reds when none is found. The dynamic-SQL and quoted-identifier entries under KNOWN
LIMITS say what that backstop cannot see, and the quoted-identifier bullet bounds its own
silence with: the SET-list form "reds by resolution instead, but only where no readable
head opens earlier in the same quoted text: a statement read ends at the quote that
encloses it, a backtick or an ordinary `'`, rather than at a `;`".

That reason does not hold for a head inside a template opened on an earlier line.
`enclosingQuote` reads the head's own line from its start with no quote open, so it finds
no quote for such a head, and `statementAt` then reads as if no string enclosed it: past
the template's closing backtick, to the next `;`. A sibling write with an unreadable head
sitting between that backtick and that `;` is attributed to the first head's table, and
the backstop stays quiet. The round-2 signal measured two plants, each 29/29 green while
its control reds: `UPDATE ${table} SET updated_at = NOW()` and
`'UPDATE "accounts" SET updated_at = NOW()'`, each placed after an opened-above
`UPDATE sessions` head. Neither sits "in the same quoted text" as that head, so the
bullet's bound is narrower than the silence, and its stated mechanism is the one the
dynamic-SQL entry now says does not apply to this layout.

One live `src` head already has this shape: the lease UPDATE in `bridge-queue.ts`
(`UPDATE bridge_import_queue q` inside the `WITH due AS (...)` template) opens on a line
above its head, so its read runs past the closing backtick after `RETURNING q.*` to the
`;` that ends the call.
Harmless today, because only the parameter array sits between the two, and one edit away
from not being.

## Scope

1. Decide, from the code, whether to close the silence or to name it. Closing it means the
   quote-less read of a `src` head ends where the template ends rather than at a `;`;
   naming it means the quoted-identifier bullet states the opened-above layout as a
   second case, with the mechanism the dynamic-SQL entry already gives (`enclosingQuote`
   reads one line; a head it finds no quote for is read to a `;`). The user's round-1
   decision on the `+` join ("name it, do not close it") was about that join, not about
   this backstop; say which way this one goes and why.
2. Whichever way, the quoted-identifier bullet must stop giving "a statement read ends at
   the quote that encloses it" as the reason its silence is bounded to the same quoted
   text, since that is false for the layout above. Bound the sentence or defer to the
   dynamic-SQL entry by name.
3. If the silence is closed, check the other consumers of `statementAt` for a `src` head
   with no enclosing quote (the assembled-write scan, the every-statement-readable arm,
   the ALTER arm) and say what changes for each, by fixture. If it is named, say in the
   entry which arms the same read silences and which it does not.

## Acceptance criteria

1. `UPDATE ${table} SET updated_at = NOW()` placed after an opened-above `UPDATE sessions`
   head in a `src` file, and the same with `'UPDATE "accounts" SET updated_at = NOW()'`,
   either red the fail-closed arm or are recorded as a named limit with the reasoning
   that makes it acceptable. Demonstrated by plant in a scratch copy either way, with the
   29/29 green result at the parent commit as the control.
2. The clean tree stays green, the `bridge-queue.ts` lease UPDATE is still accepted, and
   the allowed-writer and allowed-alteration tallies are unchanged.
3. If the read is changed, a fixture reds when it is pointed back at the `;`, so the
   change is pinned rather than asserted.

## Out of scope

The `+` join's own silence under the same layout is recorded in the dynamic-SQL KNOWN
LIMITS entry by the user's decision and is not reopened here. The routine arms' tree is
`backend-routine-arms-read-migrations-only`.

## Architect note (2026-09-24): two more cases of the same read, added to this task's scope

Routed here from the round-3 review of `backend-assembled-writes-misses-alter-head`, by
user triage. Both were measured by the backend's round-3 whole-file audit with a control,
and both belong to the mechanism this task already covers.

1. The quoted-identifier bullet's taxonomy has a third case. `ALTER TABLE "accounts" DROP
   COLUMN updated_at` carries no assignment token, so the fail-closed backstop has nothing
   to start from, and the quoted head matches no `READ_FROM_HEADS` pattern, so the ALTER
   arm does not see it either: 29/29 green against an unquoted control that reds the ALTER
   arm. The bullet reasons about quoted identifiers for the writer scans only. Whichever
   way Scope item 1 goes, the bullet must name the ALTER clause as the case with no
   assignment-token backstop at all, or the read must be widened to cover it; say which.
2. The `unreadableStatements` docblock gives truncation as the only way a read hides an
   ALTER from the one arm that sees it. A bare `;` inside a template whose head
   `enclosingQuote` finds no quote for (the opened-above layout this task is about) ends
   the read early with `closedAt` set, so that arm stays silent, and an ALTER clause past
   the `;` in the same template is a silent pass: measured, with the same-line control
   reding the ALTER arm. This is the ALTER-arm half of the read this task covers for the
   fail-closed arm. If Scope item 1 closes the silence (the quote-less read ends where the
   template ends), check this arm by fixture as Scope item 3 already asks; if it names the
   silence, the `unreadableStatements` docblock must name the early `;` beside truncation.
