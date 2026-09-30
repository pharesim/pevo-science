# A head in a template opened above reads past its own backtick and lends its table to a sibling write

**Owner:** backend
**Created:** 2026-09-22

Routed out of the round-2 architect review of `backend-assembled-writes-misses-alter-head`.
The backend's own round-2 sweep found it and recorded it as a `[TODO Architect]` gap
rather than fixing it, since it is pre-existing and not about the `+` join that round was
bounding. The user triaged it on 2026-09-22: file it as its own task. That entry is
superseded by this file, so it is not triaged again there.

Merged on 2026-09-30, by user triage, with `backend-opened-above-head-lends-its-table`,
which the backend filed the same day for the same read with the same two plants. That file
is deleted; what it asked for beyond this one is folded into Why, Scope items 1, 3 and 4,
acceptance criterion 3 and the Notes here, so nothing of it is left to triage.

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

Where the second write's own head is unreadable, that is a silent pass rather than a
mislabel. An unreadable head is exactly what the fail-closed arm exists to catch: with no
head reaching it, the assignment resolves to `UNRESOLVED_TABLE` and reds by line. Reached
by the opened-above head instead, it resolves to that head's table and nothing fires. The
two shapes with unreadable heads are the ones the KNOWN LIMITS entries already name, a
dynamically named target and a quoted identifier, and both are the shapes the file says
the fail-closed arm backstops.

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
   this backstop; say which way this one goes and why. The blanking reader already tracks
   template state per line and `BlankedCode` already carries replayed span events, so
   there is a plausible path to telling `enclosingQuote` that a template is open at the
   line's start; whether that path is sound at every arm is the question, not a
   prescription. Weigh it against the file's own standard: the fail-closed arm's guarantee
   is what the rest of the KNOWN LIMITS rest on, so a limit here is worth more than a
   limit in the assembled arm.
2. Whichever way, the quoted-identifier bullet must stop giving "a statement read ends at
   the quote that encloses it" as the reason its silence is bounded to the same quoted
   text, since that is false for the layout above. Bound the sentence or defer to the
   dynamic-SQL entry by name.
3. If the silence is closed, check the other consumers of `statementAt` for a `src` head
   with no enclosing quote (the assembled-write scan, the every-statement-readable arm,
   the ALTER arm) and say what changes for each, by fixture. If it is named, state the
   bound where a reader will hit it, say in the entry which arms the same read silences
   and which it does not, and audit the file for every statement of where a statement
   read ends rather than trusting the ones named in this file. At least the
   quoted-identifier bullet under KNOWN LIMITS and the `enclosingQuote` docblock, whose
   cost sentence currently names the join test only, both state it; the architect notes
   on this file add more.
4. Either way, say what the sweep covered from the code rather than asserting completeness.

## Acceptance criteria

1. `UPDATE ${table} SET updated_at = NOW()` placed after an opened-above `UPDATE sessions`
   head in a `src` file, and the same with `'UPDATE "accounts" SET updated_at = NOW()'`,
   either red the fail-closed arm or are recorded as a named limit with the reasoning
   that makes it acceptable. Demonstrated by plant in a scratch copy either way, with the
   29/29 green result at the parent commit as the control.
2. The clean tree stays green, the `bridge-queue.ts` lease UPDATE is still accepted, and
   the allowed-writer and allowed-alteration tallies are unchanged.
3. If the read is changed, a fixture reds when it is pointed back at the `;`, so the
   change is pinned rather than asserted, and the byte-identical no-op over the scanned
   files is re-measured, not assumed: the round that introduced `typescriptView` reported
   it over all scanned files and that is the bar.

## Notes

Measured at the time of filing, in scratch copies built with `git archive`, never in the
shared checkout. Each plant is 29/29 green while its control, the same text with the
template's backtick on the head's own line, reds `every updated_at assignment resolves to
the table it writes`. The canary has 30 tests since the scan-roots work, so counts measured
today are against 30.

The `bridge-queue.ts` head is not an `accounts` head. It shows the layout is house style
rather than contrived.

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

## Architect note (2026-09-30): five more sentences and one layout, added to this task's scope

Routed here from the round-6 review of `backend-assembled-writes-misses-alter-head`, by user
triage. All measured in scratch copies built with `git archive f9a839a8`, never in the
shared checkout; the unmodified copy is 30 passed, exit 0.

### The quoted-identifier bullet's sibling-read sentence omits the gave-up half

Found by the backend's round-6 check and reproduced by the architect.

The quoted-identifier bullet ends "so a sibling statement read from that head reaches the
assignment and lends it its own table, silently". That uses the defined verb outside the
defining entry with no deferral, and it is false where the sibling's read gave up. A
template holding `UPDATE widgets SET note = 'open` / `tail' WHERE id = 2;` /
`UPDATE "accounts" SET updated_at = now() WHERE id = 1` reds the fail-closed arm
(1 failed | 29 passed, exit 1) where the sentence predicts silence; with the value closed
on line 1 it is 30 passed, exit 0. Loud direction, pre-existing.

Scope item 2 already rewrites this sentence. Whichever way Scope item 1 goes, the rewrite
must not restate reach: either carry both halves (the read did not give up, and ended past
where the `updated_at` token begins) or, preferred, defer to the dynamic-SQL entry under
KNOWN LIMITS by name, as header scan 4 and the `assembledWrites` docblock do since
`f9a839a8`. This supersedes the `[TODO Architect]` in that task's round-6 signal, so it is
not triaged again there.

### Header scan 2, two terminator sentences, a no-terminator layout, and one link

1. Header scan 2 states the guarantee this task is about as a universal.
   "RESOLUTION IS FAIL-CLOSED, UNCONDITIONALLY" says the label "does not depend on what
   else sits in the file", that an unreadable head "is not attributed to whichever query
   happens to precede it", and that an unattributable write "is a red bar naming its
   line". Measured by the adversarial lens and again by the architect: inside one
   `Promise.all`, a `pool.query` whose template opens on the line above its
   `UPDATE sessions` head, followed by
   `` pool.query(`UPDATE ${table} SET updated_at = NOW() WHERE id = $1`, [id]) ``, is
   30 passed, exit 0; the control with the sessions template opening on its head's line
   reds `every updated_at assignment resolves to the table it writes`, 1 failed | 29 passed,
   exit 1. Whichever way Scope item 1 goes, scan 2 is in the Scope item 3 audit. If the
   silence is closed, the sentence becomes true again and wants the fixture that pins it.
   If it is named, scan 2 must bound itself the way scan 4 does since `f9a839a8` (the label
   follows the nearest head and what its read found) and defer to the dynamic-SQL entry
   under KNOWN LIMITS by name.
2. Two more sentences state the refusal in terminator terms where `targetTable` tests
   `stopped`: the dynamic-SQL entry's "refuses to resolve a table it cannot reach its own
   terminator from", and the `statementAt` docblock's capitalised invariant that a read
   which cannot reach its own terminator must not resolve a table. A read that runs out of
   cap or of file reaches no terminator and does resolve its table. Same audit.
3. The layout is wider than "reads to the next `;`". The opened-above read also lends its
   table when it reaches no `;` at all: an `UPDATE sessions` template opened above its
   head, then `UPDATE ${table} SET updated_at = NOW()` nine lines below with no `;` inside
   `LITERAL_CAP`, is 30 passed, exit 0 (the read ends at the cap with `stopped` false), and
   the same holds at end of file. The twin with a line ending inside a value after the
   write reds the fail-closed arm. So acceptance criterion 1's plants want a no-terminator
   member, and a fix that names the limit has to cover a read that runs out of room, not
   only one that runs to a `;`.
4. While the entry is open: its definition of reach ("did not give up and ended past where
   the `updated_at` token begins") is what header scan 4 and the `assembledWrites` docblock
   defer to by name since `f9a839a8`, and "give up" is enumerated only in the
   `SqlStatement.stopped` docblock, which the entry never links. Add the `{@link}` at the
   definition. A link is not a second statement of reach, so the one-definition shape
   stays. Nothing is false today; the correctness and adversarial lenses each found it.
