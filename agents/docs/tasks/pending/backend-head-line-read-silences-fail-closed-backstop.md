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

## Backend implementation signal (2026-10-01, commits 317afd8a, 37460891, 49893f27, efe962c6, 72732599, 7bcda9fe)

All six SHAs verified as ancestors of HEAD with `git merge-base --is-ancestor`. The net change
is `git diff c922c4b9 7bcda9fe -- backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`.
The three middle commits are superseded: 72732599 reverts their in-string `;` terminator
and escape cooking (see Scope item 1 below). Review the net diff, not each commit.

**Scope item 1: closed, not named.** `enclosingQuote` now seeds each line with the template
state the blanking reader ended the previous line in (`BlankedCode.template`). A head inside
a template opened above is enclosed by it, reported as `{char: '`', at: -1}`, and its read
ends at that template's backtick. At dollar depth > 0 the carried quote answers null, so a
head in a `DO` body entered from above is still read to its own `;`. Why close rather than
name: the fail-closed guarantee is what the other KNOWN LIMITS rest on, and the plumbing was
sound. One layout stays quiet and is now named: a template holding two `;`-separated
statements. That is the "same quoted text" bound the quoted-identifier bullet already gave for
the same-line layout, and it now covers the opened-above layout too. It is pinned as a silence
(`twoStatements`). The opened-above spelling of it was caught at the parent only because the
read ran to the next `;`.

Five probe rounds against c922c4b9, each finding confirmed by an independent verifier, turned
up further layouts the change touched. Rounds 2 to 4 tried ending quoted reads at a `;` and
cooking TypeScript escapes. Each round found another `;` that value-tracking misplaced (escaped
quotes, `E''` values in every TypeScript string kind, String.raw, hex escapes, a `;` an
interpolation evaluates to). 72732599 reverted all of that: a read inside a string ends at the
string's own closing quote. Kept from those rounds:
- `enclosingQuote` steps over an interpolation (before its span skip) to TypeScript's close.
- A head in a nested template inside an interpolation is enclosed by that template and is
  `interpolated`. `SqlStatement.interpolated` makes the assembled-write arm report an
  `accounts` head there as `interpolation`. That also closes the comment-in-token-gap
  narrowing the interpolation entry used to record.
- A head in an interpolation's own code (`inCode`) gives up at once.
- Inside interpolation code only a backtick opens a literal (comments are copied, not blanked).

**Scope item 2.** The quoted-identifier bullet no longer gives "ends at the quote that encloses
it" as an unbounded reason. It states where a read ends, defers to the dynamic-SQL entry for
reach, and names the CTE-in-same-statement case. The gave-up half is carried by deferring
reach to the dynamic-SQL definition (architect note 2026-09-30, first item).

**Scope item 3, consumer by consumer, with fixtures in the new it-block `a template opened above
its head delimits the read in every arm that reads from a head`:**
- **fail-closed:** 6 plants red: `UPDATE ${table}` and `'UPDATE "accounts"'`, each with a `;`
  after, no `;` inside `LITERAL_CAP`, and no `;` before end of file. Controls (template on the
  head's line) red as before.
- **assembled-write:** the `+` after an opened-above template's backtick is now read. The `+`
  before it stays silent (on an earlier line), as named. A head literal opening after a
  carried template closes on its line now finds its own quote, in both the backtick and `'`
  spellings. The cast-joined `+` (`` `...` as string + `...` ``) is named and pinned silent in
  both layouts.
- **ALTER arm:** reads end at the backtick, so a clause past a bare `;` inside the template is
  read (`alterAbove`). A column passed as an argument after the backtick (`format(`...%I`,
  'updated_at')`) was caught at the parent only by over-reading. It is silent in both layouts
  now, and the "assembled outside the literal" clause names it.
- **every-statement-readable:** unchanged over the tree; pinned by `alterAbove` and the
  closed-above literals.
- **Architect note 2026-09-24 item 1:** the quoted ALTER head (`ALTER TABLE "accounts" DROP
  COLUMN updated_at`) is named in the quoted-identifier bullet as having no backstop in any
  arm, and pinned. The read was not widened.
- **Architect note 2026-09-24 item 2:** the early-`;` ALTER case is closed by the read change,
  so the `unreadableStatements` docblock needed no truncation sibling.
- **Architect note 2026-09-30:**
  - Header scan 2 lost "UNCONDITIONALLY". It now states the bound and defers to KNOWN LIMITS
    by name.
  - The dynamic-SQL entry and the `statementAt` docblock state the refusal as "gives up"
    (`stopped`) and say that a cap or end-of-file read does resolve.
  - The `{@link SqlStatement.stopped}` is added at the reach definition.
  - The no-terminator layout is closed (the read ends at the backtick) and pinned.

**Scope item 4: what the sweep covered.**
- I grepped the file for every statement of where a read ends, what `enclosingQuote` finds,
  and the join halves.
- Five audit rounds, each with a header/KNOWN LIMITS lens, a docblock lens, a fixture-comment
  lens (mutating each named feature to confirm its fixture reds) and two adversarial lenses.
  Every finding was verified by an independent probe against both commits.
- Every reader rule added here is mutation-pinned: the carried seed, the depth guard, the
  interpolation step, the around reset, the depth reset inside an interpolation, the backtick-
  only opener in interpolation code, the in-code give-up, and `interpolated` in the assembled
  arm. Each reds a fixture when removed.
- The fifth round's findings are all fixed in 7bcda9fe. I did not run a sixth round, so that
  commit's own edits are unaudited.

**Acceptance criteria.**
1. Both plants (and the no-terminator and end-of-file members) red the fail-closed arm at
   7bcda9fe, and are 30/30 green with the change removed. Measured in scratch copies built with
   `git archive`.
2. The canary passes (31 tests: 30 plus the new block). Typecheck and lint are clean.
   `bridge-queue.ts`'s lease UPDATE is accepted, and the allowed-writer and
   allowed-alteration tallies are unchanged.
3. Removing the carried seed (pointing the read back at the `;`) reds the new block.
   Re-measured over every scanned file at 7bcda9fe against c922c4b9, every read from every
   head plus every assignment label: four reads move, each now ending at its own backtick
   (bridge-queue.ts lease UPDATE, two auth.ts upsert `DO UPDATE SET`s, one profile.ts upsert).
   Every arm result and every assignment label is byte-identical.

**[TODO Architect]** The test title `a read that cannot reach its own terminator resolves no
table` is still in terminator terms. I left it because
`agents/docs/solutions/conventions/new-fail-closed-outcome-must-not-reuse-an-existing-sentinel-2026-09-15.md`
cites it verbatim. If you rename it, update that citation in the same commit.

## Architect re-review (2026-10-05) — HELD PENDING FIXES:

Reviewed the net diff `c922c4b9..7bcda9fe` on the canary with `/ce-code-review`
(correctness, adversarial, testing, project-standards and learnings lenses, plus an
independent validator that confirmed items 1 to 3 below by plant). Baselines in scratch copies:
7bcda9fe 31 passed, exit 0; c922c4b9 30 passed, exit 0. The rest of the signal held up. The
four moved reads and the byte-identical arm results and labels were re-measured. Each listed
reader rule reds a fixture when removed: nine mutants by one lens, eight by another.
Project-standards found no anchor violations. The user triaged on 2026-10-05: hold items 1
to 4, dismiss the rest (listed at the end).

1. **The fail-closed reach is bounded by the statement's own `;`, not only by its string.**
   A `src` template that opens on the line above its first statement and holds two
   `;`-separated statements, the second with an unreadable head assigning `updated_at`, reds
   the fail-closed arm at c922c4b9 and passes every arm at 7bcda9fe. Measured with three
   members, each unresolved=1 at the parent and 0 at 7bcda9fe:
   - `` pool.query(` `` alone on its line, then `UPDATE sessions ...;`, then
     `UPDATE "accounts" SET updated_at = NOW() ...`;
   - the same with `UPDATE ${table}`;
   - the ordinary `` client.query(`BEGIN; `` layout with `COMMIT;` closing it.

   The same-line spelling is silent at both commits; it is the `twoStatements` pin.
   Item 1 makes the fail-closed arm red in both layouts and flips both `twoStatements` pins.

   This is not the in-string `;` the probe rounds reverted. That change ended the statement's
   TEXT at a `;` inside the string, and misplaced `;`s truncated the text the table-first,
   ALTER and assembled-write arms read. Bound only the reach test `targetTable` applies, and
   leave the text every other arm reads ending at the string. A reach-only bound can only add
   red bars. A `;` taken too early shortens reach, so the assignment lands on
   `UNRESOLVED_TABLE`, which reds. A `;` the value tracking misses leaves reach where it is
   at 7bcda9fe.

   Two variants were measured by reviewers in scratch copies; neither was typechecked or
   linted. Take either, or another with the same property:
   - (a) In `targetTable`, where the head's quote is a backtick (carried or on its line,
     not `inCode`), also take the read as if no quote enclosed it, capped at the backtick
     read's end. Resolve only where both reach. Measured: canary green with the pins
     flipped, and every arm result and assignment label over sources and migrations
     identical to 7bcda9fe.
   - (b) `statementAt` records the first `;` met under a quote delimiter, outside a value
     and at the head's own dollar depth, on the statement. `targetTable` refuses reach past
     it. Measured green with the pins flipped. The cap and end-of-file return paths did not
     carry it yet.

   Acceptance:
   - The three members above and both `twoStatements` layouts red the fail-closed arm.
   - Removing the bound reds a fixture.
   - The clean tree stays green, the `bridge-queue.ts` lease UPDATE is accepted, and the
     tallies are unchanged.
   - The arm-result and label no-op is re-measured over every scanned file.
   - Typecheck and lint are clean.

   Prose: header scan 2, the dynamic-SQL entry's reach definition, the quoted-identifier
   entry's "same quoted text" bound, the `statementAt` docblock and the `twoStatements`
   fixture comment all say where a read ends or what it reaches. Re-audit every such
   sentence in the file against the final code. One adjacent over-read is pre-existing and
   is not closed by this bound, because that head finds no quote: a head in a `DO` body
   followed by apostrophes inside interpolations. The interpolation entry names it; leave
   that entry alone unless your change closes it.

2. **The reach definition's exception list is incomplete.** The dynamic-SQL entry under
   KNOWN LIMITS lists its exceptions as "except where statements share that string or the
   quote found is not the head's own, which the quoted-identifier entry under KNOWN LIMITS
   names". The `statementAt` docblock also lists a quoteless read meeting a quote inside an
   interpolation after its head, and that case is missing from the entry. It is live: a `DO`
   body with apostrophes in its interpolations is silent at both commits, and the control
   without them reds. The quote-not-the-head's-own case points only at the quoted-identifier
   entry, which names the trailing-backslash string. It does not name a migration line that
   begins inside a multi-line value, which only the `SqlStatement` docblock records. Fix:
   defer to the `statementAt` docblock's list by name rather than enumerate, or carry every
   member with its right pointer. Write it against the code as item 1 leaves it.

3. **"literal" where the code means "template literal".** Inside an interpolation's code only
   a backtick opens a literal, so a head inside a `'` or `"` string there is answered as code
   and its read gives up. Measured: `` `${light ? 'UPDATE accounts SET custody = $1' : ...}` ``
   reds the every-statement-readable arm. Four comments say "a literal": the interpolation
   entry ("in no literal there"), the `enclosingQuote` docblock ("only a literal opened there
   can enclose the position"), the `statementAt` comment at the `inCode` give-up, and the
   `inCode` fixture comment. Say "template literal". In the interpolation entry, say why a
   `'` or `"` string there counts as code: the interpolation's comments and regex literals
   are copied rather than blanked. The comment beside the opener test is already right.

4. **The test title, from the `[TODO Architect]` above.** `a read that cannot reach its own
   terminator resolves no table` is false now: a read that runs out of cap or of file reaches
   no terminator and does resolve a table. Retitle it in the "gives up" terms the
   `statementAt` docblock uses, covering what the test asserts (a read that gives up resolves
   no table; running out of room is not giving up). Update the verbatim citation in
   `agents/docs/solutions/conventions/new-fail-closed-outcome-must-not-reuse-an-existing-sentinel-2026-09-15.md`
   in the same commit, with `[skip-zone-audit]` in the subject, since that file is outside the
   backend zone.

Dismissed at triage, not to be reopened on this task:
- Opened-above heads lose catches in the table-first and ALTER arms: `.concat`, a `+`
  behind a comment line, the `as string +` cast, and a column passed as a `format` argument.
  The parent caught them only by reading past the backtick. The same-line spellings are
  silent at both commits, and KNOWN LIMITS names those joins.
- The `inCode` give-up and the `interpolated` refusal stay as they are. Both only add red bars.
- No fixture for the `close === -1` branch of the interpolation step. The
  every-interpolation-closes arm reds that line regardless.
- No fixture for the opened-above `format`-argument ALTER.

None of this block's wording goes into the canary: no item numbers, dates, slugs or line
numbers. Anchor comments on the symbols named above.
