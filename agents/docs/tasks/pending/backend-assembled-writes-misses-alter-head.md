# The assembled-write scan reads one head where the shared set names two

**Owner:** backend
**Created:** 2026-09-16

Routed out of the round-2 architect review of the ALTER `IF EXISTS` pin. Pre-existing
and untouched by that round, and a file-wide decision rather than an ALTER-arm one, so
it is filed here rather than held there.

## Why

`READ_FROM_HEADS` exists to be the single enumeration of every head a statement is read
FROM, and it names two patterns: `ACCOUNTS_STATEMENT_RE` and `ALTER_ACCOUNTS_RE`. Two
scan sites iterate it. Two others do not: `accountsColumnWriters` and `assembledWrites`
each walk `ACCOUNTS_STATEMENT_RE` alone.

For `assembledWrites` that is a silent pass in the direction the file cares about. An
ALTER against `accounts` whose column name is interpolated is not reported as an
assembled write, because the scan never sees the head. The file's own docblock argues
the opposite of this scoping, and the dynamic-SQL entry in KNOWN LIMITS leans on an
assignment backstop that the ALTER head does not have: an ALTER carries no assignment
token for another arm to resolve, so one dynamic identifier is enough to go quiet.

## Scope

1. Decide whether the two single-head sites should read from `READ_FROM_HEADS`. They are
   not obviously the same case: `assembledWrites` looks unintended, while
   `accountsColumnWriters` may be deliberately column-write-shaped. Say which is which
   from the code and its docblocks, not from this task file.
2. For whichever sites should widen, point them at the shared set, matching the two arms
   that already iterate it.
3. For whichever should not, record the narrowing where a reader will hit it — including
   a sentence in the dynamic-SQL KNOWN LIMITS entry saying its assignment-backstop
   reasoning does not extend to the ALTER head.
4. Check whether any OTHER consumer of a head pattern in this file spells its own walk
   instead of reading the shared enumeration, and report what the sweep covered from the
   code rather than asserting completeness.

## Acceptance criteria

1. An interpolated `ALTER TABLE accounts DROP COLUMN ${column}` planted in a `src` file
   is either reported as an assembled write, or its absence is recorded as a named limit
   with the reasoning that makes it acceptable. Demonstrated by planting, either way.
2. The clean tree stays green, and the allowed-alteration tally is unchanged.
3. If a site is widened, a fixture reds when it is pointed back at the single head, so
   the widening is pinned rather than asserted.

## Notes

Verified live at review time: an interpolated ALTER head planted in a `src` file leaves
the suite green, while the same text in a migration reds. The two `READ_FROM_HEADS`
iterations and the two single-head walks are all in this one file, so the blast radius
is the canary itself.

## Backend implementation signal (2026-09-21, commits 43545ee4, 24c5e332, 72f1196d)

All three are on `main` (`git merge-base --is-ancestor` checked) and touch only
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`.

- `43545ee4`: `assembledWrites` iterates `READ_FROM_HEADS`. A fixture pins the ALTER head
  (interpolation and concatenation, with controls on the ALTER arm and the fail-closed arm).
  The docblocks record the narrowing.
- `24c5e332`: prose corrections after adversarial verification of `43545ee4` (see below).
- `72f1196d`: pins for the case fold and the whole-statement read on the ALTER head.

### Scope decisions

1. Which is which. `assembledWrites` widened. Its own rationale (the reading arm meets a
   placeholder) applies to the ALTER arm, and an ALTER column clause has no second catcher,
   so the single-head walk was a silent pass. `accountsColumnWriters` stays on the write
   head on purpose. Every text `writesColumn` accepts spells `\bupdated_at\b`, and
   `accountsColumnAlterations` reads the ALTER statement from the same position with that
   test, so widening would only double-count. Exception, recorded in its docblock: inside
   the licensed migration, count licensing absorbs an in-place edit, and widening would not
   close that either (a retype to `USING now()` carries no comparison).
2. The widened site iterates `READ_FROM_HEADS` with the same nested loop as
   `unreadableStatements`.
3. The narrowing is recorded in four places:
   - the `accountsColumnWriters` docblock;
   - the `READ_FROM_HEADS` docblock, which names both single-head walks and the routine head;
   - `accountsColumnAlterations`, which now gives its own reason;
   - the dynamic-SQL KNOWN LIMITS entry. It says the assignment backstop does not reach a
     column list held in a variable or, as a rule, the ALTER head. It names the two joins
     the assembled scan recognises (`${...}` and a `+` beside the quote), and says a
     same-line `.join`, `.concat` or `+=` goes unreported.
4. Sweep, read from the code at `72f1196d`. There are six production walks that run
   `line.matchAll(new RegExp(X.source, 'gi'))` over a head:
   - `statementHead`: `HEAD_PATTERNS` (UPDATE/INSERT/MERGE target, any table, captures the
     name). It is a separate enumeration by purpose, reached through `targetTable` from
     `columnAssignments`.
   - `accountsColumnWriters`: `ACCOUNTS_STATEMENT_RE` alone, on purpose (docblock).
   - `assembledWrites`: `READ_FROM_HEADS` (widened here).
   - `accountsColumnAlterations`: `ALTER_ACCOUNTS_RE` alone, on purpose (docblock).
   - `unreadableStatements`: `READ_FROM_HEADS`.
   - `routineSites`: `ROUTINE_CREATION_RE`. Not an accounts head, so it stays out of
     `READ_FROM_HEADS` (docblock).

   The text patterns are tested against a statement already read and walk no lines:
   `COLUMN_ASSIGNMENT_RE`, `ROW_TARGET_LIST_RE`, the three column-list patterns (the INSERT
   and COPY ones re-spell the accounts qualifier, consistently), `BOUND_TO_ACCOUNTS_RE`
   (narrower qualifier, TODO item 4), `SQL_INTERPOLATION_RE` and `JOINED_*`. The end-state
   arm re-runs `blankAll` but walks no head. Each fixture helper (`unreadableIn`,
   `unresolvedIn`, `scansOf`, `how`, `alterations`, `caught`) calls an arm function. Test
   bodies call `statementAt`, `statementHead` and `targetTable` at hand-picked positions and
   `.test()` the head constants, but none loops over heads, so no copied walk exists. "Two
   scan sites iterate it" was one function before this change (`unreadableStatements`,
   called by the arm and by `unreadableIn`). Now it is two.

### Acceptance evidence

All from scratch copies built with `git archive`, never the shared checkout.

- AC1: `src/zz-probe-alter.ts` holding
  ``await pool.query(`ALTER TABLE accounts DROP COLUMN ${column}`)``:
  - at `eff8d6b9`, 25/25 green (the silent pass);
  - at `43545ee4` and `24c5e332`, 1 failed:
    `[interpolation] zz-probe-alter.ts:2 (probeAlter)` on the assembled arm;
  - the `'...' + column` spelling reds as `[concatenation]`.
- AC2: the clean tree is 25/25 at every commit. `ALLOWED_COLUMN_ALTERATIONS` is
  byte-identical (`016: 3`). Runtime tallies are unchanged: src writers `/confirm:1`,
  `/link:1`; migration writers `016:1`; alterations `016:3`; assembled `[]`. All 9
  `tests/eslint` files pass (135 tests).
- AC3: these mutants of `assembledWrites` each red the fixture:
  - `[ACCOUNTS_STATEMENT_RE]` in place of `READ_FROM_HEADS` (checked at `72f1196d`);
  - `READ_FROM_HEADS.slice(0, 1)`, and `READ_FROM_HEADS` without the ALTER head (checked at
    `43545ee4`);
  - `'gi'` to `'g'` (the lowercase pin), plus `SQL_INTERPOLATION_RE.test(line)` and the
    first-line-only read (the wrapped pin), checked at `72f1196d`.
- Correction to this task's Notes: the interpolated ALTER in a migration does not red as an
  assembled write, before or after this change. It reds only without a `;`, and then through
  the every-statement-readable arm (a missing terminator), identically at base. The assembled
  arm reads `sources` only.

Verification: workflow `wf_b138cadd-7ec` ran four lenses (plant, mutation, claims, sweep),
with two verifiers per finding. Its confirmed claim corrections are in `24c5e332`. Backend did
not run code review (agents/backend/CLAUDE.md assigns `/ce-code-review` to the architect).
Dismissed by the user in triage:
- per-walk `'gi'` spelling (the constants' own `/i` is unused);
- the one-report-per-line `return`;
- the header's proposed CHECK tripping the ALTER pin.

### [TODO Architect] Pre-existing gaps the sweep found, recorded here at the user's direction

1. (medium) The routine arms read `migrations` only (both call `routineSites(migrations)`). A
   `CREATE FUNCTION ... NEW.updated_at := now()` plus `CREATE TRIGGER ... ON accounts` run
   from `src` through `pool.query` leaves the suite 25/25 green. The header says nothing in
   the application writes the column. Handing both calls `[...sources, ...migrations]` is
   green today.
2. (low) `NOT_A_TABLE` misses DDL uses of `UPDATE`. `ON UPDATE CASCADE`, `RESTRICT`,
   `NO ACTION`, `BEFORE UPDATE ON`, `GRANT UPDATE ON` and `UPDATE OR` resolve to tables named
   `cascade`, `restrict`, `no`, `on` and `or`. An `updated_at =` later in the same DDL then
   resolves to that table, and the fail-closed arm goes quiet. The set's own docblock calls
   this the silent direction. Adding the words is green today.
3. (low) The allowlists license by count, so an in-place edit of a licensed 016 statement is
   absorbed. A retype edited to `USING now()`, or the back-fill losing its
   `WHERE updated_at IS NULL`, stays green, and `deploy.sh` re-applies every migration on
   every run. Suggest a KNOWN LIMITS entry at least, or pinning by normalised text.
4. (low) Routine binding reads a statement that nothing holds to a terminator.
   `BOUND_TO_ACCOUNTS_RE` misses `ON accounts` when 41 blanked comment lines before `ON` hit
   `LITERAL_CAP`, or when an `EXECUTE` string joined across lines stops the read. It also
   spells `(?:public\.)?` where the heads accept `public . accounts`. Separately, an
   `<unnamed>` routine key can be exempted, although its docblock says "no exemption can
   match". Nothing changes in outcome while `ROUTINES_THAT_CANNOT_REACH_ACCOUNTS` is empty.
   What weakens is the guarantee that a bound trigger "cannot be listed here at all".

## Architect re-review (2026-09-21, round 1) — HELD PENDING FIXES:

Reviewed `eff8d6b9..72f1196d` via `/ce-code-review` across five lenses (correctness,
project-standards, testing, adversarial, learnings) plus one validator batch that
re-measured every surviving finding in its own `git archive 72f1196d` copy. All three
commits are ancestors of `main`. Every line number below is a line number in the file AT
`72f1196d`. The cross-model adversarial pass did NOT run (no different-provider route is
installed on this host), so the adversarial lens ran in-process and has no
independent-family corroboration. No reviewer touched a database or the shared checkout.

**What held up, so it is not redone.** AC1, AC2 and AC3 all hold, each re-derived by
execution rather than taken from the signal block: three independent plants of the
interpolated ALTER red the assembled arm by name; the clean tree is 25/25 and
`ALLOWED_COLUMN_ALTERATIONS` is untouched; pointing `assembledWrites` back at
`[ACCOUNTS_STATEMENT_RE]` reds the fixture, each of the four new ALTER assertions reds
independently under that mutant, and `'gi'` to `'g'` and the head-line-only interpolation
test red their own pins. The two silent-arm controls prove what their comment says. The
sweep in Scope decision 4 was re-enumerated from the code by the architect: exactly six
production line-walks over a head, the six the signal block names, and no test body loops
over heads. Probed true: `.join`, `.concat` and `+=` are silent on the statement's own
line; an equality inside a USING expression or a CHECK reds the fail-closed arm;
`ALTER TABLE ${table}` reds nowhere; `src` spells no ALTER; every text `writesColumn`
accepts also satisfies the ALTER arm's test, so the single-head argument in the
`accountsColumnWriters` docblock holds. Project standards is clean. The
shared-constant-unification learning is honored by a real membership fixture.

The hold is prose only. Both items are claims this range added that the code falsifies.

### Item 1 (required). The `+` recognition is stated without the bound that makes it true.

Measured three times (correctness, adversarial, validator), same result each time. With
the template's opening backtick on the line ABOVE the head,

    const sql = `
      ALTER TABLE accounts DROP COLUMN ` + column;

planted in a `src` file leaves the whole canary 25/25 green. The same text with the
backtick on the head's own line reds `[concatenation]`. The silence holds for the wrapped
form, for a `+` leading the next line, for the argument position, and for an opened-above
`INSERT INTO accounts (` + cols + `)` and an opened-above UPDATE join. Interpolation in the
same layout IS reported; only the `+` join goes quiet. Cause: `enclosingQuote` reads the
head's own line only, so `statementAt` runs with no quote, reads to the `;`, and
`joinedByPlus` looks for the `+` after the semicolon (and skips the before-the-quote test,
since `quoteAt` is -1). The mechanism predates this range and the write head is silent the
same way at `eff8d6b9`. It is held here because this range put a head with no second
catcher behind that join test and wrote the prose that the shape falsifies:

- header item 4: "a `+` beside its opening or closing quote";
- the dynamic-SQL KNOWN LIMITS entry: "That scan recognises two ... and a `+` beside its
  quote. An array `.join`, a `.concat` or a `+=` is silent even on the statement's own
  line", an enumeration of silent joins this shape is missing from;
- the `assembledWrites` docblock: an interpolated or joined ALTER "is reported here or
  nowhere", which for this shape is nowhere, unnamed;
- the `SQL_INTERPOLATION_RE` docblock's description of where the join is recognised.

`src` opens a template on the line above its first SQL line 21 times at `72f1196d`. No
`accounts` head does today, which is why the clean tree is green either way.

**User decision (2026-09-21): name it, do not close it.** No new branch in
`joinedByPlus` or `assembledWrites`, and no new fixture is required. State the bound once,
in the dynamic-SQL KNOWN LIMITS entry: the `+` is read only where the literal's opening
quote shares a line with the head, and a template opened on a line above its head is a
silent join (its interpolation is still read). Then make every other statement of the `+`
recognition in the file either carry that bound or defer to the entry by name. Audit the
whole file for statements of this claim rather than trusting the four sites listed above;
the list is what the lenses found, not a completeness claim. Re-measure the opened-above
plant and the same-line control in a scratch copy and quote both results in the signal
block.

### Item 2 (required). The `assembledWrites` docblock states as a universal what its two siblings state as a rule.

"Only one assembled shape has a second catcher" and "neither does the clause of a drop, a
rename or a retype" (lines 1975-1978). Validator re-measured: a retype clause held in a
constant, with an equality in its USING expression, interpolated into an `ALTER TABLE
accounts`, reds the fail-closed arm AND this arm. Header item 4 and the KNOWN LIMITS entry
both say "as a rule" and carry the USING/CHECK carve-out; this third statement of the same
claim dropped both. The error is in the safe direction (an extra catcher, not a missing
one), so it is wording only. Carry the hedge across so the three statements agree.

### Dismissed by the user in triage (2026-09-21), recorded so it is not re-raised

- No negative fixture pins "a spelled-out `ALTER TABLE accounts ...` is not assembled"
  (line 4025). Validated: a mutant reporting every ALTER head as assembled, with the
  correct label, survives the unmodified fixture set. Dismissed as pre-emptive hardening:
  the shipped code is correct on the input, the failure direction is a loud false red, and
  `src` spells no ALTER.

### The four `[TODO Architect]` gaps, triaged by the user (2026-09-21). No action on this task.

1. Routine arms read `migrations` only: FILED as `backend-routine-arms-read-migrations-only`.
   It was already open on `backend-accounts-updated-at-writer-canary`'s residual list and
   carried forward undecided by the IF EXISTS review; the new task supersedes those entries.
2. `NOT_A_TABLE` misses the DDL uses of `UPDATE`: DISMISSED on the user's canary bar.
   Neither tree spells `ON UPDATE CASCADE`, `GRANT UPDATE ON`, `BEFORE UPDATE ON` or the
   rest (checked by grep at `72f1196d`), and it is the class of the `'only'` addition
   dismissed on the IF EXISTS task.
3. Allowlists license by count: DISMISSED as recorded. It is on the writer-canary residual
   list, and this range's `accountsColumnWriters` docblock now states the limit in the code.
4. Routine-bind read and the `<unnamed>` exemption: the qualifier spacing is
   `backend-trigger-bind-qualifier-admits-no-spacing` already; the "no exemption can match"
   docblock sentence is APPENDED to that task as an architect note; the `LITERAL_CAP` and
   joined-`EXECUTE` part is DISMISSED, since nothing changes in outcome while the exemption
   list is empty.

## Backend round-2 signal (2026-09-22, commits 7bc103d8, 23f96433, 73c69f6e, 29099b09, 5d44f839)

All five are ancestors of `main` (`git merge-base --is-ancestor` checked) and touch only
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`. Prose
only: `git diff` over the range shows no non-comment line. The file moved under the hold
(`79cb6536` and `b93a3b04` landed after the reviewed range), so the hold's line numbers no
longer resolve; every measurement below was re-taken against these commits.

Four adversarial verification passes ran over the range, each with two refuters per finding.
The first three each falsified sentences this work had itself written, which is why there
are five commits: `7bc103d8` is the hold's two items, and the rest are corrections to it.
The hold's own prescribed wording is among what was corrected, per the convention that
hold-block prescriptions are in scope.

### Item 1. What the bound is, stated once in the dynamic-SQL KNOWN LIMITS entry

The prescription ("the `+` is read only where the literal's opening quote shares a line with
the head") is a necessary condition, and stating it as a sufficient one is false three times
over. The arm's two halves answer to different things, and the entry now says so:

- The `+` BEFORE the quote is read only where `enclosingQuote` finds a quote on the head's
  line, and only on that line. Any quote it found will do, including a template's closing
  backtick carried over from an earlier line, and the half is tested first, so it fires
  whatever the read went on to reach. A `+` ending an earlier line is silent, though only
  text ahead of the head can hide there.
- The `+` AFTER the quote is looked for past where the READ stopped, wherever that landed,
  and is false where the read reached no terminator. A join sitting behind the stop is not
  seen.
- `enclosingQuote` reads the head's line from its start with no quote open. It finds none
  for a template opened on a line above its head, and misreads the quote where a template
  from above closes on the head's line (that closing backtick reads as an opener). Both are
  named as examples, not as a closed list, and in both the join is silent whichever side of
  the literal the `+` sits on, while an interpolation in either is still read.
- A `'` or `"` inside the literal that is not its delimiter opens a value the read carries
  to its match, so a literal holding an odd one runs past its own close and leaves the join
  beside that close behind the read. That is how a concatenated quoted identifier is
  spelled. It is silent in every arm only when read on one line with nothing joined past its
  last literal: wrapped over lines the every-statement-readable arm reds it, and a `+` past
  its last literal is read as a join.

Sites carrying the bound or deferring to the entry by name: header item 4, the
`SQL_INTERPOLATION_RE` docblock, the `joinedByPlus` docblock, the `assembledWrites` docblock
and the join fixture's comment. Two mechanism docblocks the entry cites were bounded as
well, beyond the sites the hold named: `enclosingQuote`, whose contract said "null when the
position sits in no string" while it reads one line, and `statementAt`, whose quote-less
read covers a keyword `enclosingQuote` finds no quote for, while a quote it finds that is
not the keyword's delimits the read instead.

### Item 2. The hedge, carried and corrected

The `assembledWrites` docblock no longer states a universal ("Only one assembled shape has a
second catcher" is now "One assembled shape has a second catcher"), its rule covers an
`ALTER TABLE accounts` clause as its two siblings' does, so the CHECK half of the carve-out
fits, and it carries the carve-out. Header item 4 had "as a rule" but never the carve-out,
so it has it now too. The three copies are byte-identical.

Three corrections to what the copies claimed, each measured:

- The carve-out said any equality inside a USING expression or a CHECK is read as an
  assignment. Only an `updated_at =` is: with the column on the right, or behind a cast, the
  fail-closed arm stays green. All three copies now say `updated_at =`.
- "Are nowhere" covered every unrecognised join, and a SET-list or USING fragment joined
  that way reds the fail-closed arm. It is scoped to the two shapes its sentence names and
  carries the loud exception: a shape whose read reached no terminator reds the
  every-statement-readable arm.
- The entry's consequence ("reds nowhere") now names all three catchers that can still fire:
  an `updated_at =` reds the fail-closed arm, a bare `updated_at` left in the head's own
  literal reds the ALTER arm, which asks for the name and not for an assignment, and a read
  that reaches no terminator reds the every-statement-readable arm.

### Acceptance evidence

All from scratch copies (`git archive <sha> backend`, `node_modules` and `.env` symlinked,
`tests/setup.ts` stubbed). The shared checkout was never mutated; plants went to
`backend/src/zz-probe*.ts` inside the copy and were deleted after each run.

- AC1, the hold's shape re-measured at this round's HEAD: the opened-above `+` plant leaves
  the canary 29/29 green, while the same text with the backtick on the head's line reds
  `[concatenation] zz-probe-alter.ts:2`; the same layout with `${column}` reds
  `[interpolation]`. A `+` leading the next line, and a `+` before the literal, are silent.
- The second silent layout (a template from above closing on the head's own line before the
  head's literal opens): 29/29 green, control reds `[concatenation]`, the interpolated
  spelling reds `[interpolation] zz-probe-s1i.ts:3`.
- The read-stop half: `await q('UPDATE accounts SET "' + column + '" = now() WHERE id = $1', [id]);`
  is 29/29 green, the same call without the stray `"` reds `[concatenation]`; wrapped over
  lines it reds `every accounts statement can be read whole`; with one more join past its
  last literal it reds `[concatenation]`. The column-list and ALTER spellings behave the same.
- The before half is not gated on the stop: `pre + ` + an unterminated template head reds
  `[concatenation]`, so the half fires with `closedAt` at -1.
- The three catchers: `ALTER TABLE ${table} ADD CONSTRAINT stamped CHECK (updated_at = created_at)`
  reds `every updated_at assignment resolves to the table it writes`;
  `'ALTER TABLE accounts RENAME COLUMN updated_at TO '.concat(next)` reds
  `only the column-introducing migration alters accounts.updated_at itself`; the same join
  with the name held in the variable is 29/29 green, as is
  `ALTER TABLE ${table} DROP COLUMN updated_at`.
- AC2: the clean tree is 29/29 on the canary and 139/139 across all 9 `tests/eslint` files at
  each commit, `ALLOWED_COLUMN_ALTERATIONS` is untouched, and `npm run typecheck` and
  `npx eslint` on the file both exit 0.
- AC3 (the round-1 pin) is unchanged: this round adds no fixture and no assertion, so the
  widening pinned at `43545ee4`/`72f1196d` still reds under its mutants.
- The soundness clause was measured, not asserted: 23 `accounts` heads in `src`, every one
  with `enclosingQuote` finding its own literal's opening quote on the head's line and every
  read closing at that literal's own closing quote, checked against a TypeScript AST view of
  each file. No head follows a line ending in `+`, and `src` spells no ALTER.
- The repo's `pre-commit` anchor gate over the added lines is zero-hit at each commit, with
  `ALLOW_MARKER` set explicitly and the control line firing.

Verification: workflows `wf_dfaa3781-d82`, `wf_3cd820ed-55c`, `wf_8175ec8b-69c` and
`wf_7af2218f-35d`. Backend did not run code review (`agents/backend/CLAUDE.md` assigns
`/ce-code-review` to the architect).

### Considered and left, with the reason

- `SqlStatement.quoteAt`'s "(-1 in a migration, where there is none)", the A NOTE ON REUSE
  sentence about where a read ends, the bare-`;` fixture comment, and header item 4's stated
  reason for the SET-list fragment's second catcher ("no readable head's statement reaches a
  constant declared on its own", which a call carrying no `;` of its own can defeat) each
  state the read's end or its arm without the head-line bound. All predate this range and
  state neither the `+` recognition nor the second-catcher claim.

### [TODO Architect] Pre-existing gap found by the sweep, not acted on

The head-line read also silences the fail-closed backstop, which no text names. A head in a
template opened on an earlier line is read past its closing backtick to a `;`, so a sibling
write with an unreadable head before that `;` is attributed to the first head's table. Two
plants, each 29/29 green while its control reds: `UPDATE ${table} SET updated_at = NOW()` and
`'UPDATE "accounts" SET updated_at = NOW()'` sitting after an opened-above `UPDATE sessions`
head. Pre-existing and not about `+`, so it is recorded rather than fixed; the sentence it
falsifies is the quoted-identifier bullet's "only where no readable head opens earlier in the
same quoted text". One live `src` head already reads past its backtick (`bridge-queue.ts`,
the import-queue UPDATE), harmless today because nothing sits between that backtick and its `;`.

## Architect re-review (2026-09-22, round 2) — HELD PENDING FIXES:

Reviewed `b93a3b04..5d44f839` (the five round-2 commits, all ancestors of `main`; the file
at `5d44f839` is byte-identical to `main`) via `/ce-code-review` across four lenses
(correctness, project-standards, adversarial, learnings) plus one validator batch that
re-measured both actionable findings in its own `git archive 5d44f839` copy. The
cross-model pass did NOT run (only a same-family route is installed on this host), so the
adversarial lens ran in-process. No reviewer touched a database or the shared checkout.
Every line number below is a line number in the file AT `5d44f839`.

**What held up, so it is not redone.** Both round-1 items landed and were re-derived by
execution rather than taken from the signal. Item 1: the bound is stated once in the
dynamic-SQL KNOWN LIMITS entry, and both the correctness and the adversarial lens
re-enumerated the whole file and found every other statement of the `+` recognition
carrying it or deferring to the entry by name (header item 4, `SQL_INTERPOLATION_RE`,
`enclosingQuote`, `statementAt`, `joinedByPlus`, `assembledWrites`, the join fixture
comment); the untouched join sentences state neither the recognition nor the
second-catcher claim. The opened-above `+` plant is 29/29 green, the same-line control
reds `[concatenation]`, the opened-above `${column}` reds `[interpolation]`. Item 2: the
three carve-out copies are identical after whitespace normalisation and each is a
self-sufficient restatement; `assembledWrites` no longer states a universal. AC2, re-run by
the architect: canary 29/29, all nine `tests/eslint` files 139/139, `npm run typecheck`
exit 0, `npx eslint` on the file exit 0, no `Errors` line. The soundness clause holds:
exactly 23 `accounts` heads in `src`, each opening and closing on its own literal's
quotes (one lens via the TypeScript AST, one via a dump mutant); `src` spells no ALTER.
The pre-commit anchor gate is zero-hit over the added lines with a firing control, in
four independent runs; the TypeScript scanner counts the same block comments at base and
head (54, of which 45 JSDoc), so no docblock truncated itself. Project standards is clean.

The hold is prose only, three items. Each is a sentence this range added, or made newly
relevant, that the code falsifies or that a sibling sentence now contradicts. The user's
round-1 decision stands: no code change and no new fixture.

### Item 1 (required). The entry's "unless" clause promises head-anchored catchers for a headless ALTER.

Lines 259-267. The sentence's subject is "an ALTER whose table is named dynamically
(`ALTER TABLE ${table}`, an `EXECUTE format(...)`), or whose column clause is assembled in
any way the assembled-write scan does not recognise", and its "unless" clause says such a
statement reds "under the ALTER arm" when a bare `updated_at` is left in the head's own
literal, and under the every-statement-readable arm where its read reaches no terminator.
Both of those arms walk only from heads that match `ALTER_ACCOUNTS_RE` /
`READ_FROM_HEADS`, which require the literal `accounts`; a dynamically named head is no
head to either. Measured four times (correctness, adversarial, the validator, the
architect): `await pool.query(`ALTER TABLE ${table} DROP COLUMN updated_at`)` planted in a
`src` file leaves the canary 29/29 green, exit 0; the same text with `accounts` in place
of `${table}` reds `only the column-introducing migration alters accounts.updated_at
itself`. Only the fail-closed `updated_at =` catcher is head-independent. The error is in
the unsafe direction: the entry's own `EXECUTE format('ALTER TABLE %I DROP COLUMN
updated_at', 'accounts')` example is silent although it spells the column, and a reader
of the entry is told otherwise.

Fix: the entry must say which catchers a dynamically named head can still reach (the
fail-closed arm, which reads the assignment token and not the head) and which it cannot
(the ALTER arm and the every-statement-readable arm, which walk from a head that spells
`accounts`), so the two head-anchored catchers are scoped to the assembled-column-clause
case and the dynamically named case is named as silent, its `EXECUTE format` example
included. The standalone "Nor where its read reaches no terminator" sentence takes the
same scope. Re-measure both plants above and quote the results in the signal block.

### Item 2 (required). The second silent layout is stated for any head literal; only a backtick literal is silent there.

Lines 277-280: "a head whose own literal opens on its line after a template from above
closes there, since that closing backtick is read as an opener and the literal's opening
one as its close". The clause presupposes a backtick literal. With a `'` or `"` head
literal in the same position, `enclosingQuote` finds the carried closing backtick and
returns it, the read is delimited by that backtick, ends the line inside a value, and the
every-statement-readable arm reds by line. Measured (adversarial, the validator, the
architect): a template closing on the head's line followed by
`const sql = 'UPDATE accounts SET custody = $1, ' + recency + ' WHERE id = $2';` reds
`every accounts statement can be read whole`; the same layout with a backtick head
literal is 29/29 green; the same-line backtick control reds `[concatenation]`. The error
is in the loud direction, and it sits in the sentence that names the layout.

Fix: restrict the named layout to a backtick head literal, and either say what a `'` or
`"` literal in that position does or leave it to the odd-quote paragraph below it by
name. Re-measure the two variants and quote them.

### Item 3 (required). Three sibling sentences the new text now contradicts.

Each predates this range and was listed by the backend under "Considered and left" as
stating neither the `+` recognition nor the second-catcher claim. That reading held at
round 1; the sentences this range added now name the case each one denies, so each is
newly relevant. Bound each to the head-line read, or defer to the dynamic-SQL entry by
name; nothing else in them changes.

- Lines 2151-2152, the `SqlStatement.quoteAt` field: "(-1 in a migration, where there is
  none)". The rewritten `joinedByPlus` docblock (lines 2420-2429) now says the before-half
  is skipped where `enclosingQuote` found no quote on the head's line, "`quoteAt` is -1",
  which is the `src` opened-above case. Measured: an opened-above `src` head has
  `quoteAt` -1; the closed-above single-quoted layout has `quoteAt` at the carried
  backtick.
- Line 913, the `SQL_INTERPOLATION_RE` docblock: "before the literal's opening quote". The
  code tests the text before whatever quote `enclosingQuote` found (`slice(0,
  statement.quoteAt)`), and the entry this docblock defers to says that quote may be a
  template's closing backtick carried from above. Measured (correctness): on the head's
  own line, `x +` ahead of the carried closing backtick, then a `'`-quoted head joined
  with `+`, reports `[concatenation]` from the `+` before that backtick, not from
  anything before the literal's `'`.
- Line 4758, the join fixture's comment: "A bare `;` inside a template ends nothing: only
  the enclosing quote does." The rewritten `statementAt` docblock and the entry now say a
  template opened above its head IS read to its `;`. True of the fixture's own layout
  (its quote is found on the head's line); bound it to that layout.

### Not held, recorded so it is not re-raised

- "An interpolation in either layout is still read" (line 281) has one narrow exception: in
  the opened-above layout the read stops at a SQL `;` inside the template, so a `${...}`
  after that `;` in the same template is silent while the same-line layout reads it.
  The interpolation sits past the statement's own terminator, so "in the statement" is a
  defensible reading. Not held.
- No fixture pins the two named silent layouts, the headless-ALTER silence, or the
  quoted-identifier idiom. Waived by the round-1 decision; recorded for coverage
  visibility only.

### The round-2 `[TODO Architect]` gap, triaged by the user (2026-09-22). No action on this task.

The head-line read silencing the fail-closed backstop, and the quoted-identifier bullet's
falsified "only where no readable head opens earlier in the same quoted text": FILED as
`backend-head-line-read-silences-fail-closed-backstop`. That file supersedes the entry
above, so it is not triaged again here.

## Backend round-3 signal (2026-09-23, commits baa8b6d8, aec8f24d, 00c12124, d0c5f95e, 140df650, e49f25f2)

All six are ancestors of `main` (`git merge-base --is-ancestor` checked) and touch only
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`. Prose
only: `git diff 5d44f839 HEAD` over the file shows no non-comment line. The file was
byte-identical to `5d44f839` when this round started, so the hold's line numbers resolved.

`baa8b6d8` is the hold's three items. The other five are corrections to it. Five adversarial
falsification passes ran over the range, each lens required to demonstrate a wrong sentence
with a plant AND a control, and every candidate re-measured independently by two confirmers
in their own `git archive` copies. The rate was 13, 6, 3, 3, 2, narrowing each round, and by
the last two rounds every finding was one defect class: a consequent written without a
condition the same paragraph already carries.

### Item 1. The two subjects split, and what a dynamically named head can reach

The entry's "unless" clause offered the ALTER arm and the every-statement-readable arm as
catchers for a statement whose table is named dynamically. Both walk from a head and every
head in `READ_FROM_HEADS` wants the literal `accounts`, so neither can fire there. The entry
now separates the assembled-column-clause case, which keeps all three catchers, from the
dynamically named case, and names the entry's own `EXECUTE format` example as silent
although it spells the column.

Four corrections followed, each measured:

- Replacing the whole name is not the only way past the head-anchored arms. The patterns
  admit one literal `public\s*\.\s*` and nothing else, so `ALTER TABLE ${schema}.accounts`,
  the search-path-safe DDL spelling, matches neither although it spells the name in full.
- A name the dynamic part only SUFFIXES is still a head: the patterns end at `accounts\b`
  and a `$` or a `%` is a word boundary.
- The fail-closed arm is not the only catcher answering to the assignment token;
  `columnAssignments` feeds the writer arms too, and what it reaches is a property of the
  read. The paragraph now states three buckets: the fail-closed arm where no readable head
  reaches the assignment, the writer arms where an `accounts` head does, and nothing at all
  where the reaching head names another table.
- The USING/CHECK carve-out the file keeps in three other places was dropped from the
  "carries no assignment" sentence and is restored, with the retype's outcome routed through
  the same three buckets rather than asserted as fail-closed.

### Item 2. The second silent layout wants a backtick head literal

The layout is stated for a BACKTICK head literal, which is the only one whose own opening
quote closes the carried backtick. A `'` or `"` head literal in the same position is read to
that carried backtick, its own closing quote opens a value, and the line ends inside it, so
the read stops and the every-statement-readable arm reds by line whether or not anything is
joined, with a `+` ending the carried template's text read as a join on top of it.

Corrections: the read meets that backtick more often than "never". Two things on the head's
line close it early and restore the silence, a backtick INSIDE the head literal and one more
unpaired quote of the literal's own kind, and the text is then truncated where the read
closed. What that truncation hides was also over-stated. It hides the write from the arms
walked from THAT head; a second `accounts` head past the truncation starts its own read, and
the walk from the assignment token still reaches an `updated_at =` out there. What is left
quiet is a write carrying no assignment and opening no head of its own, and the enumeration
of those was missing COPY.

### Item 3. The three sibling sentences

- `SqlStatement.quoteAt`: -1 is what `enclosingQuote` found none for, not a migration marker,
  and a found quote need not be the head literal's. Corrected three times after that: the
  enumeration was missing its third member, the closed-above BACKTICK head literal whose two
  backticks cancel; "every migration head in the tree" over-generalised, since that function
  runs per line and a head after an unclosed `'` at depth zero gets that quote; and the
  depth-zero qualifier needed adding, since the function seeds its depth at LINE ENTRY and
  skips every column inside a span, with the `$$`-opener carve-out holding only for a `src`
  head, which is the only one with a literal ahead of the opener.
- `SQL_INTERPOLATION_RE`: the before-half is measured from whichever quote that function
  found, not from the literal's opening quote. Corrected once more: the anchor list is open,
  since a value's quote takes the same slot where the head's line begins inside a value, and
  a `+` in the SQL text ahead of it is then read as a join that joins nothing.
- The join fixture's comment: what suspends the `;` is `enclosingQuote` finding a quote, not
  the template's own quote opening on the head's line. Corrected twice: the read reaching a
  `;` needs the span carrying the head to stay open as well, which with the mid-value case is
  the pair `SqlStatement.stopped` enumerates while the cap is the other answer; and a cap-hit
  read lends its table only as far as the last line it read, so a write past the cap answers
  to whatever head does reach it.

### Acceptance evidence

All from scratch copies (`git archive <sha> backend`, `node_modules` and `.env` symlinked,
`tests/setup.ts` stubbed). The shared checkout was never mutated by a probe; plants went to
`backend/src/zz-probe*.ts` or `backend/migrations/zz9_probe.sql` inside the copy and were
deleted after each run.

- Item 1, both plants re-measured at the round's HEAD:
  ``await pool.query(`ALTER TABLE ${table} DROP COLUMN updated_at`)`` in a `src` file leaves
  the canary 29/29 green, exit 0; the same text with `accounts` reds
  `only the column-introducing migration alters accounts.updated_at itself`. The entry's own
  `EXECUTE format('ALTER TABLE %I DROP COLUMN updated_at', 'accounts')` in a migration is
  29/29 green, while `format('ALTER TABLE accounts DROP COLUMN %I', 'updated_at')` reds the
  ALTER arm and the every-statement-readable arm. A dynamic-head retype and a dynamic-head
  rename carrying no assignment are each 29/29 green; one carrying
  `CHECK (updated_at = created_at)` reds the fail-closed arm.
- Item 1's corrections: `ALTER TABLE ${schema}.accounts DROP COLUMN updated_at` is 29/29
  green against a `public.accounts` control that reds the ALTER arm.
  `ALTER TABLE accounts${suffix} DROP COLUMN updated_at` reds the ALTER arm AND the assembled
  arm, against a static `accounts_2026` control that is 29/29 green.
  `ALTER TABLE ${table} ALTER COLUMN c TYPE text USING (updated_at = 1)` reds the fail-closed
  arm standalone, and is 29/29 green under a reaching `UPDATE sessions` head.
  A planted `COPY accounts (email, updated_at) FROM STDIN;` reds
  `only the column-introducing migration writes accounts.updated_at, table-first`.
- Item 2, the two variants the hold asked for, plus the clause they license: a closed-above
  layout with a `'` head literal reds `every accounts statement can be read whole`; the same
  layout with a backtick head literal is 29/29 green; the same-line backtick control reds
  `[concatenation]`. The `"` spelling behaves as the `'` one, and the `'` spelling with no
  join at all still reds the readable arm, which is what "whether or not anything is joined"
  rests on. The two quieting shapes are 29/29 green: a backtick inside the head literal, and
  one more unpaired apostrophe later on the line, the latter against a control differing only
  in `it's` versus `it is`. A second `accounts` head past the truncation reds both writer
  arms, against an `UPDATE sessions` twin that leaves them green.
- Item 3: a `+` ending the text before the CARRIED backtick reds `[concatenation]`, while one
  glued to the head literal's own `'` does not. An opened-above head whose template holds
  `UPDATE accounts SET custody = $1; SET updated_at = NOW()` has its read stopped at the bare
  `;` and reds `every updated_at assignment resolves to the table it writes`; the same text
  with the head on its own line reads the whole template and reds both writer arms.
  Direct `statementAt` probes: opened-above `quoteAt` -1 with the read running past the
  template's closing backtick to the `;`; closed-above single-quoted `quoteAt` 12, the
  carried backtick's column, against the literal's own `'` at 27, `stopped` true;
  closed-above BACKTICK head literal `enclosingQuote` null and `quoteAt` -1, the third case;
  same-line backtick its own quote; migration -1. A head inside a `DO $$` body with a `'`
  open ahead of it on its line measures `quoteAt` -1, while the same head at depth zero
  measures that quote's column; a MIGRATION head sharing its line with the `$$` opener stays
  quote-free at -1 while the `src` twin returns its own template's backtick. A cap-hit read
  has `lastLine` 40 at `LITERAL_CAP` 40 with `stopped` false, and `targetTable` for an
  assignment past the cap returns `accounts` where that write spells its own head and
  `<unresolved>` where it does not.
- AC2: the clean tree is 29/29 on the canary and 139/139 across all 9 `tests/eslint` files at
  each of the six commits, `ALLOWED_COLUMN_ALTERATIONS` is byte-identical to `5d44f839`
  (`016: 3`), and `npm run typecheck` and `npx eslint` on the file both exit 0 with no
  `Errors` line.
- AC3 (the round-1 pin) is unchanged: this round adds no fixture and no assertion, so the
  widening pinned at `43545ee4`/`72f1196d` still reds under its mutants.
- The repo's `pre-commit` anchor gate over the whole range's added lines is zero-hit, with
  `ALLOW_MARKER` set explicitly and the control line firing. The block-comment count is 290
  at `5d44f839` and 290 at HEAD, so no docblock truncated itself.

Verification: workflows `wf_7d9c53ef-303` (a whole-file audit of the three claim classes,
four lenses plus two refuters per candidate), then `wf_52ea351f-9bf`, `wf_091f0f4d-8d7`,
`wf_ba6e23ea-d4c`, `wf_d2e55de0-405` and `wf_530ee09d-550`, the five falsification passes.
Backend did not run code review (`agents/backend/CLAUDE.md` assigns `/ce-code-review` to the
architect).

### Considered and left, with the reason

The opening audit flagged three sites in the round-2 range that state the `+` recognition:
the file header's item 4, the `joinedByPlus` docblock and the `enclosingQuote` docblock. They
are NOT changed. The round-2 re-review re-enumerated the whole file and recorded each as
carrying the bound or deferring to the dynamic-SQL entry by name, and two independent
refuters each agreed the wording survives on its own scope: `joinedByPlus` corrects itself in
its next sentence ("Each half answers to what the read found rather than to the literal"), and
header item 4's following clause is the accurate hedge. Changing them would overturn a
completed architect verification on a lens's opinion rather than on a measurement. Flagged
here so the architect can rule otherwise; the architect's own item 3 held line 913 and not
these, which reads as a deliberate distinction.

### [TODO Architect] Pre-existing gaps the whole-file audit found, recorded rather than acted on

Each is outside the round-3 hold, predates the reviewed range, and was measured with a
control. None is triaged here.

1. (medium) `BOUND_TO_ACCOUNTS_RE` spells the bare literal, so a trigger bound to
   `ON "accounts"` leaves `boundToAccounts` false and falls through to the exemptible arm.
   That falsifies the header's "A trigger or rule bound to `accounts` is refused outright,
   with no exemption" and the exemption list's "cannot be listed here at all". Measured: with
   its key added to `ROUTINES_THAT_CANNOT_REACH_ACCOUNTS` the whole file goes 29/29 green.
   Adjacent to `backend-trigger-bind-qualifier-admits-no-spacing`, which already carries the
   qualifier-spacing half.
2. (low) A dynamically named INSERT naming the column in its list is silent in every arm, so
   the entry's "make both identifiers dynamic ... and nothing fires at all" names the wrong
   sufficient condition, and "caught in either spelling" a few lines above is unqualified.
   Measured: `format('INSERT INTO %I (username, updated_at) VALUES (%L, now())', 'accounts',
   'x')` in a migration is 29/29 green, the literal-table control reds two arms.
3. (low) The quoted-identifier bullet's two-case taxonomy misses a third: an
   `ALTER TABLE "accounts" DROP COLUMN updated_at` carries no assignment token either and is
   29/29 green, against an unquoted control that reds the ALTER arm.
4. (low) `unreadableStatements`'s docblock gives truncation as the only way a read hides an
   ALTER from the one arm that sees it. A bare `;` inside a template whose head has no quote
   found terminates the read early, so `closedAt` is set, that arm stays silent, and the ALTER
   past the `;` is a silent pass. Measured, with the same-line control reding the ALTER arm.
   Related to `backend-head-line-read-silences-fail-closed-backstop`, which covers the
   fail-closed half of the same mechanism.

## Architect re-review (2026-09-24, round 3) — HELD PENDING FIXES:

Reviewed `5d44f839..e49f25f2` (the six round-3 commits, all ancestors of `main`) via
`/ce-code-review` across four lenses (correctness, project-standards, adversarial, learnings)
plus one validator batch that re-measured all three surviving findings in its own
`git archive e49f25f2` copy. The cross-model pass did NOT run (only a same-family route is
installed on this host), so the adversarial lens ran in-process. No reviewer touched a
database or the shared checkout. Every line number below is a line number in the file AT
`e49f25f2`. A sibling commit (`cffe3a4a`, the catalog-pointer task) landed nine header lines
while this review ran, so at `f65e38b7` the same text sits nine lines lower.

**What held up, so it is not redone.** All three round-2 items landed and were re-derived by
execution rather than taken from the signal. Item 1: lines 259-271 scope the ALTER arm and
the every-statement-readable arm (the "Nor where its read reaches no terminator" sentence
included) to the accounts-head assembled-clause case, name `ALTER TABLE ${table}`, the
`EXECUTE format` example and the schema-dynamic spelling as no head to either, and 283-290
give the assignment-token walk its three buckets. Item 2: 312-318 restrict the second silent
layout to a BACKTICK head literal and say what a `'` or `"` literal does there. Item 3:
`SqlStatement.quoteAt` (2218-2221), `SQL_INTERPOLATION_RE` (974-977) and the join fixture's
comment (4845-4847) are each bound to what `enclosingQuote` found. Eight architect plants,
all matching the signal: `ALTER TABLE ${table}` and `${schema}.accounts` are silent (29/29,
exit 0) against `accounts` and `public.accounts` controls that red the ALTER arm;
`accounts${suffix}` reds the ALTER arm AND the assembled arm; the closed-above layout with a
`'` head literal reds the readable arm, the backtick twin is silent, and the same-line
backtick control reds `[concatenation]`. AC2, re-run by the architect from a
`git archive e49f25f2` copy: canary 29/29, all nine `tests/eslint` files 139/139,
`npm run typecheck` and `npx eslint` on the file exit 0, no `Errors` line;
`ALLOWED_COLUMN_ALTERATIONS` is byte-identical (`016: 3`). The pre-commit anchor gate is
zero-hit over the 121 added lines with a firing control. The TypeScript scanner counts 54
block comments (45 JSDoc) at both ends and zero parse diagnostics; the signal's 290/290 is a
different count, and the invariant it stands for holds either way. Project standards is
clean: every `{@link}` target exists, and `the carve-out above` / `the ALTER paragraph
above` satisfy the convention's "restate it" clause. The adversarial lens re-enumerated the
corpus at `e49f25f2`: 23 `accounts` heads in `src`, each with `enclosingQuote` finding its
own literal's quote and the read closing there; no `ALTER` under `backend/src`; 15 migration
heads, all `quoteAt` -1; the pattern boundaries hold for `${schema}.accounts`,
`%I.accounts`, `${prefix}accounts` and `accounts_2026` (no head) against `public.accounts`,
`accounts${suffix}` and `accounts%I` (the ALTER head). Every catcher the new prose promises
and the lenses probed does fire, except the one in item 1.

The hold is prose only, three items, and all three are one defect class: a consequent
written without a condition the mechanism requires, which is the class the round-3 signal
itself named. The user's round-1 decision stands: no code change, no new fixture. Land the
three as one commit, item 1 first, and quote each item's plant and control in the signal.

### Item 1 (required). The accounts-head assembled-clause sentence promises the fail-closed arm unconditionally.

Lines 259-262: an ALTER whose head spells `accounts` but whose column clause is assembled in
a way the assembled scan does not recognise "reds nowhere unless the statement still spells
the column: an `updated_at =` reds under the fail-closed arm". Measured three times
(correctness, adversarial, the validator), two plant shapes: an `UPDATE sessions` template
opened on an earlier line with no `;` after its closing backtick, then
`const clause = 'ADD CONSTRAINT stamped CHECK (updated_at = created_at)';` joined to
`'ALTER TABLE accounts '` by `.concat` (the correctness plant joins a USING retype by an
opened-above `+` instead), planted in `src`, leaves the canary 29/29 green, exit 0, with
`columnAssignments` bucketing the clause under `sessions`. The same file with a `;` after the
sessions backtick, or with the sessions block removed, reds
`every updated_at assignment resolves to the table it writes`, exit 1. Cause: the walk from
the assignment token stops at the NEAREST reaching head, and an ALTER head is no
`HEAD_PATTERNS` head, so the ALTER's own `accounts` spelling never enters `targetTable`'s
answer; where the reaching head names another table, nothing reds at all. The error is in
the unsafe direction. The consequent's words existed at base, but this range rewrote the
sentence's subject and, at 283-290 of the same entry, added the correctly conditioned
three-bucket form for the dynamic-head case, so the sentence now contradicts its own
paragraph. The mechanism is pre-existing and belongs to
`backend-head-line-read-silences-fail-closed-backstop`; the unconditioned promise is this
range's.

Fix: state the accounts-head case's `updated_at =` outcome as the same three buckets the
dynamic-head paragraph already gives (the fail-closed arm where no readable head reaches the
fragment, the writer arms where an `accounts` head does, nothing where a head naming another
table does), or defer to that `columnAssignments` paragraph by name. The bare-`updated_at`
ALTER-arm clause beside it is correct and stays. Optional companion, pre-existing from round
2 and NOT required: the `assembledWrites` docblock (2534-2536) carries the same flat
fail-closed consequent for a SET-list fragment; fix it in the same pass or leave it, and say
which. Re-measure the `.concat` plant and its `;` control and quote both.

### Item 2 (required). The DO-body `$$` sentence omits the same-line-backtick condition.

Lines 2224-2227, the `SqlStatement.quoteAt` docblock: "A `src` head sharing its line with
the `$$` that opens the body is not [quote-free]: the columns ahead of that opener are at
depth zero, so the template literal holding the body is read there and its backtick is
returned instead." True only where the template's own opening backtick is on the head's
line. `enclosingQuote` reads the head's line from column 0 with nothing open, so with the
template opened on the line above (`await q(\`` then `DO $$ BEGIN UPDATE accounts ...` on
the next line, the `$$` opening ON that line) it returns null, `quoteAt` is -1, and the read
reaches its `;`. Measured three times: the opened-above plant is 29/29, exit 0; the same
statement with the template opened on the head's line reds
`every accounts statement can be read whole`, `quoteAt` 10, `stopped` true. The same list's
next item ("a `src` head inside a template opened on an earlier line ... quote-free") gives
the opposite answer for a head that is both. The error is in the loud direction; the
sentence was added by `e49f25f2`.

Fix: condition the sentence on the template literal's opening backtick sharing the head's
line ahead of the opener, and say that the opened-above layout stays quote-free for the same
reason the migration twin does (no literal ahead of the opener on that line). Re-measure the
two layouts and quote `enclosingQuote` / `quoteAt` for each.

### Item 3 (required). "Either way the statement's text is truncated" holds for the first quieting shape only.

Lines 328-330 and 337-340. After naming the two shapes that make a closed-above `'` or `"`
head's read close early rather than stop (a backtick inside the head literal; one more
unpaired quote of the literal's own kind later on the line), the paragraph says "Either way
the statement's text is truncated where the read closed, so a write past that point is
hidden from the arms walked from THAT head", and counts an INSERT column list among what is
left quiet. For the second shape the read passes the head literal's closing quote as a value
opener, closes the value at the later apostrophe and ends at that template's backtick, so
its text holds the WHOLE head literal and what follows: nothing is truncated and nothing in
the statement is hidden. Measured (adversarial, the validator):
`x\`; await q('INSERT INTO accounts (email, updated_at) VALUES ($1, now())'); const m = \`it's\`;`
after a template opened above reds `the accounts writers found table-first are the same two`,
exit 1, with `statementAt`'s text ending at column 95 against the literal's close at 76; the
`verify_token` control is 29/29. The first shape does truncate: an INSERT list past an inner
backtick is silent in every arm. Loud direction, wording only; the paragraph is new text.

Fix: scope the truncation sentence and the "What is left quiet" set to the first shape, and
say what the second does instead (the read over-runs the literal to the carried backtick and
lends the head's read whatever sits between). Re-measure both shapes with the INSERT list
and quote each.

### Dismissed by the user in triage (2026-09-24), recorded so it is not re-raised

All anchor-50 or red-bar-either-way, and none changes an outcome:

- 322: "a `+` ending the carried template's text is read as a join" holds only where that
  `+` is on the head's line; the bound is stated at 354-357, not in this sentence.
- 324: "go quiet again": the after-half `+` past an early close is still read as
  `[concatenation]`, so only the readable arm goes quiet.
- 330-333: a second `accounts` head past the truncation carries the write to the
  column-first arm only where its own read reaches the assignment; where it is stopped, the
  fail-closed arm reds instead.
- 4854: the past-the-cap enumeration omits a nearer reaching head naming another table,
  which buckets the write silently; a contrived layout.
- 288: a reaching COPY head is an `ACCOUNTS_STATEMENT_RE` head but no `HEAD_PATTERNS` head,
  so it reds table-first while the column-first walk climbs past it.
- 2233-2235: the quoteAt list item "a `src` head inside a template opened on an earlier
  line" is -1 only while no `'` or `"` is left open ahead of the head on that line; the
  paragraph's opening sentence carries that condition.
- 292 and 337: `the carve-out above` and `the ALTER paragraph above` carry no ALL-CAPS
  identifier but restate what they point at, which the convention accepts.

### Learnings

No new entry. This round is the third recurrence, on the same file, of
`agents/docs/solutions/conventions/a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each.md`
(its guidance to write a bound as a necessary condition is items 1 and 2 exactly). The
architect folds the recurrence into that entry via `/ce-compound-refresh` at archive.

### The four `[TODO Architect]` gaps in the round-3 signal, triaged by the user (2026-09-24). No action on this task.

1. `BOUND_TO_ACCOUNTS_RE` and a quoted bind target `ON "accounts"`: APPENDED to
   `backend-trigger-bind-qualifier-admits-no-spacing` as an architect note. Same pattern,
   same exemption path; that task's own "Deferred" section had left the quoted target as an
   architect call, and this is that call.
2. A dynamically named INSERT naming the column: DISMISSED on the user's canary bar. Neither
   tree spells a dynamically named INSERT, so the pre-existing "caught in either spelling" is
   wrong only for a shape the corpus does not write; the class of the `NOT_A_TABLE` DDL
   words dismissed in round 1.
3. The quoted-identifier `ALTER TABLE "accounts"` as a third case of that bullet: APPENDED
   to `backend-head-line-read-silences-fail-closed-backstop` as an architect note, since
   that task already owns the bullet's falsified sentence.
4. The `unreadableStatements` docblock's truncation-only account of a hidden ALTER: APPENDED
   to `backend-head-line-read-silences-fail-closed-backstop` as an architect note; it is the
   ALTER-arm half of the mechanism that task covers for the fail-closed arm.

## Backend round-4 signal (2026-09-28, commits bd8e7d06, 3e02dc27, b49ceb14)

All three are ancestors of `main` (`git merge-base --is-ancestor` checked) and touch only
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`. Prose
only: `git diff f65e38b7 b49ceb14` over the file shows zero non-comment changed lines.

`bd8e7d06` is the hold's three items in one commit, item 1 first, as prescribed. The other
two are corrections after adversarial verification, the same shape as rounds 2 and 3: the
first pass confirmed six falsifications of `bd8e7d06`'s own sentences (each with a plant AND
a control, each re-measured by two independent confirmers), fixed in `3e02dc27`; the second
pass confirmed one further defect in two variants at the four rewritten sites, fixed in
`b49ceb14`.

### The hold's items, and the two companions

- Item 1 landed with the three-bucket form and the `{@link HEAD_PATTERNS}` /
  `{@link columnAssignments}` anchors. The OPTIONAL COMPANION in the `assembledWrites`
  docblock was FIXED in the same pass, and header item 4's because-clause with it: all three
  statements of the fail-closed second-catcher claim carried the same universal the entry now
  bounds, and the round-1 rule is that sibling statements of one claim carry one hedge.
- Item 2 landed conditioned on the body template OPENING on the head's line; corrections
  below added the read-as-an-opener condition.
- Item 3 landed with the truncation sentence and the left-quiet set scoped to the first
  quieting shape and the over-run stated for the second.
- The hold's "The bare-`updated_at` ALTER-arm clause beside it is correct and stays" was
  itself falsified by measurement (below); the clause now carries the read's-text bound.
  Hold prescriptions are in scope per the standing convention.

### Acceptance evidence, all from scratch copies (`git archive <sha> backend`, node_modules
and .env symlinked, `tests/setup.ts` stubbed; the shared checkout never mutated)

- Item 1's prescribed plant and control: the `.concat` ALTER clause behind an
  `UPDATE sessions` template with no `;` after its closing backtick is 29/29 green, exit 0
  (the sessions read runs on and buckets the CHECK's `updated_at =` under sessions); the same
  file with the `;` reds `every updated_at assignment resolves to the table it writes`,
  exit 1. Bucket 2 measured too: the opened-above head as `UPDATE accounts` reds BOTH writer
  arms (`the accounts writers found column-first are exactly the two signup finalizes`,
  `the accounts writers found table-first are the same two`) with the fail-closed arm green.
  The SET-list-fragment twin (header item 4 / assembledWrites): no-`;` plant green, `;`
  control reds the fail-closed arm.
- Item 2's two layouts: opened-above 29/29 green with `enclosingQuote` null / `quoteAt` -1 /
  `stopped` false / `closedAt` 58; same-line reds `every accounts statement can be read
  whole` with `enclosingQuote` `{char: backtick, at: 10}` (the backtick in `await q(` at
  col 10), `quoteAt` 10, `stopped` true, `closedAt` -1.
- Item 3's two shapes with the INSERT list: the inner-backtick shape is 29/29 green (the
  list is truncated away); its control without the inner backtick reds the readable arm
  (plus table-first, since the untruncated list is visible, consistent); the odd-quote shape
  reds `the accounts writers found table-first are the same two` alone, with the direct
  probe showing `closedAt` 91 past the literal's close at 72 and the text holding the whole
  INSERT; its `verify_token` control is 29/29 green.
- AC2 at `bd8e7d06` and `3e02dc27`, each measured in its own copy: canary 29/29, all nine
  `tests/eslint` files 139/139, `npm run typecheck` and `npx eslint` on the file exit 0,
  `ALLOWED_COLUMN_ALTERATIONS` byte-identical to `5d44f839` (016 at 3), zero TypeScript
  parse diagnostics and 54 block comments at every end. At `b49ceb14`: 139/139 exit 0 in a
  fresh copy, eslint and typecheck exit 0.
- AC3 is unchanged: no fixture or assertion was touched in any of the three commits, so the
  round-1 pins still red under their mutants.
- The pre-commit anchor gate: standalone zero-hit proofs over the added lines of `bd8e7d06`
  (42 lines) and `3e02dc27` (54 lines), each in a throwaway repo with a copied hooks dir and
  a firing one-line control (`the rule below` + task-slug redirect rejected, verbatim FAILED
  output captured); `b49ceb14` passed the live hook at commit with the gate on.

### The six confirmed falsifications of `bd8e7d06`, fixed in `3e02dc27`

Each was demonstrated with a plant and a minimal control by its finder and independently
re-measured by two confirmers (2/2 confirmed each):

1. The quoteAt DO-body sentence lacked the read-AS-an-opener condition: a template from
   above CLOSING on the head's line first cancels the body literal's backtick (the pair
   cancel, `enclosingQuote` null, plant green) where the sentence predicted the backtick
   returned and a loud read stop. Fixed by naming the cancellation, the same one the
   heads-that-answer list records for a head's own literal; "opens a quote" in the
   opened-above sentence became "LEAVES a quote open".
2. The shape-2 sentence's "nothing in the statement is hidden from the arms walked from
   that head" was false for the assembled arm: `joinedByPlus` reads positions (ahead of the
   quote, past the close), so a `+` inside the over-run — beside the head literal's own
   closing quote — joins silently (`ALTER TABLE accounts ' + clause` behind a carried
   backtick with a later apostrophe: green; the same line without the carried prefix reds
   `[concatenation]`). Scoped to the arms that read the text, with the `+` exception stated.
3. The bare-`updated_at` ALTER-arm promise was silenced by the first quieting shape: a
   backtick inside the head's own literal ahead of the name closes the read early
   (`closedAt` at the inner backtick, text truncated before the name), and the rename reds
   nowhere; the control without the carried prefix reds the ALTER arm. The clause now asks
   the read's TEXT and names the shape that cuts the name away.
4-6. The fail-closed bucket conditions at header item 4, the KNOWN LIMITS three-bucket
   clause and the `assembledWrites` docblock quantified over readable heads that reach the
   fragment; `targetTable` consults only the NEAREST head-bearing line and never climbs past
   it. An interposed one-line `UPDATE widgets` (or a stopped `INSERT INTO papers` with an
   odd quote) between a reaching sessions head and the fragment turns the predicted silence
   into a fail-closed red; removing the interposed line restores the predicted bucketing.
   All four sites (the three plus the `columnAssignments` paragraph they defer to) now state
   the walk in the nearest-head form, matching `targetTable`'s own docblock.

### The second pass, fixed in `b49ceb14`, and the truncation disclosure

The second falsification pass (two of three lenses returned, both measurement agents
returned) confirmed all six fixes landed and filed one further defect, two variants, four
sites: the walk starts AT the assignment's own line — a head there LEFT of the assignment
counts, so "finds no head above" was the wrong condition (plant: `UPDATE widgets` head on
the declaration's own line, no head above, fragment bucketed silently while the stated
condition held; control with the fragment alone reds fail-closed) — and on that line a head
to the RIGHT of the assignment is invisible to the walk (plant: the accounts head right of
the assignment in a two-declarator line is climbed past to a farther widgets head, green;
the swapped-declarator control reds fail-closed). All four sites now carry the
left-of-assignment rider from `targetTable`'s docblock.

DISCLOSURE: the second pass was stopped early at the user's rate-limit warning. Its four
findings carry their finders' measured plants and controls (verbatim red names and exit
codes) and two lenses converged on the same defect, but the two-confirmer replication that
every round-1 finding got did NOT run for them, and the third lens (sibling-consistency
across the four rewritten sites and the neighbouring docblocks) did not return. The backend
judged the fix safe because it copies `targetTable`'s own reviewed docblock wording; the
architect's re-review is the replication.

### Considered and left, with the reason

- Multi-backtick interference between a carried close and the body opener (an odd stray
  backtick leaves a quote open): governed by the quoteAt paragraph's opening sentence and
  the LEAVES-a-quote-open hedge, the condition-carried-in-paragraph class the round-3
  triage dismissed at its own items.
- A NOT_A_TABLE match interposed between fragment and reaching head (probed: `DO UPDATE
  SET` line is no head, walk unaffected, green) and the nested-template ordering for the
  cancellation sentence (probed: the OPENS-first ordering returns the body backtick, and
  "closes on that line first" excludes it): both measured consistent, nothing filed.
- Header item 4's `+`-recognition wording, `joinedByPlus` and `enclosingQuote` docblocks:
  untouched, per the round-3 ruling that they survive on their own scope.

Verification: workflows `wf_701e4c10-3a4` (pass 1: five measurement agents including AC2
and the anchor gate, four falsification lenses, two confirmers per deduped candidate, 21
agents, zero errors) and `wf_b8f5c0fa-d9d` (pass 2, stopped early as disclosed). Backend
did not run code review (`agents/backend/CLAUDE.md` assigns `/ce-code-review` to the
architect).

## Architect re-review (2026-09-29, round 4) — HELD PENDING FIXES:

Reviewed `f65e38b7..b49ceb14` (the three round-4 commits, all ancestors of `main`) via
`/ce-code-review` across four lenses (correctness, project-standards, adversarial, learnings)
plus one validator batch that re-measured all three surviving findings in its own
`git archive b49ceb14` copy. The cross-model pass did NOT run (only a same-family route is
installed on this host), so the adversarial lens ran in-process. No reviewer touched a
database or the shared checkout. Every line number below is a line number in the file AT
`b49ceb14`. A sibling commit (`67361efe`, the scan-roots task) landed on the file while this
review ran, adding a header-region section, so the same text sits lower at HEAD; every
measurement was taken in `git archive b49ceb14` copies and is unaffected.

**What held up, so it is not redone.** All three round-3 items landed and were re-derived by
execution rather than taken from the signal. The DISCLOSED replication gap is closed: the
stopped pass's four-site left-of-assignment rider was confirmed by three independent
measurement families (correctness, adversarial, the validator), both variants — a head on the
assignment's own line LEFT of it is consulted (silent bucketing where its read spans the
assignment and names another table; the fragment-alone control reds fail-closed), and a head
RIGHT of the assignment on that line is invisible (the walk climbs past it to a farther
reaching head; the swapped-declarator control reds fail-closed) — including the
never-climbs-past clause with a farther reaching head. Also probed true: the shape-1 ALTER
quieting against a src control, the shape-2 over-run with the `+` inside the over-run joining
silently, the three quoteAt case signatures, and ALTER-is-no-`HEAD_PATTERNS`-head. The
sibling-consistency sweep the stopped pass never ran found nothing beyond item 1 below. AC2
re-run by the architect from a `git archive b49ceb14` copy: canary 29/29, all nine
`tests/eslint` files 139/139, `npm run typecheck` and `npx eslint` on the file exit 0;
`ALLOWED_COLUMN_ALTERATIONS` byte-identical (`016: 3`); 54 block comments (45 JSDoc) and zero
parse diagnostics at both range ends; the pre-commit anchor gate is zero-hit over the 75
added lines with a firing control. Project standards is clean: every added positional cite
carries a stable name.

The hold is prose only, two items, both the standing defect class (a consequent written
without a condition the mechanism requires), each validated with a plant and a control by two
lenses and the validator. The user's round-1 decision stands: no code change, no new fixture.
Land both in one commit and quote each item's plant and control in the signal.

### Item 1 (required). Bucketing is promised on declaration/fragment reach; the walk buckets only a read that spans the assignment.

Three sites this range rewrote state the nearest head's read reaching the DECLARATION or the
FRAGMENT as what buckets the assignment under that head's table: header item 4 ("where that
nearest head's read runs on to the declaration", lines 188-190), the three-bucket clause
("does not reach the fragment", 289-290), and the `assembledWrites` docblock ("a read that
does not reach the fragment" / "where it runs on to the fragment", 2593-2596). `targetTable`
answers to the ASSIGNMENT token's own line and column, so a read that runs into the fragment
but closes before the assignment does not bucket it. Measured (adversarial, the validator):
an `UPDATE widgets` template opened on an earlier line with no `;` after its closing
backtick, then a fragment spelling `SET b = 2;` with `updated_at = now()` on the next line,
reds `every updated_at assignment resolves to the table it writes`, exit 1, where the prose
predicts silent widgets bucketing; the control with that `;` changed to `,` (the read then
spans the assignment) is 29/29, exit 0. The error is in the loud direction. The ALTER
paragraph's own form ("the nearest one's read does not reach its assignment", 321-322) is
correct and stays.

Fix: state the reach/run-on condition against the assignment token at the three sites, as the
ALTER paragraph already does; a fragment/declaration wording may remain only where its own
sentence separately says the read must span the assignment. Re-measure the plant and control
above and quote both in the signal.

### Item 2 (required). The fail-closed disjunct says "above"; the walk's domain is at-or-above.

Lines 289-290: "the fail-closed arm reds where that one head's read does not reach the
fragment or no head sits above at all". The walk's domain, stated by this same range at all
four rider sites, includes a head on the assignment's own line to its LEFT. Measured
(correctness, the validator): a head left of the assignment on its own line, nothing above,
read spanning the assignment, is 29/29, exit 0 (bucketed silently), while the disjunct
predicts a fail-closed red; the fragment-alone control reds
`every updated_at assignment resolves to the table it writes`. The error is in the unsafe
direction: a reader is promised a catcher the own-line-left layout does not get. The sibling
clause at 321 ("where the walk finds no head at all") is the correct form.

Fix: bring the disjunct inside the walk's stated domain (no head found at all, the
own-line-left slot included), matching the sibling clause at 321. Re-measure the plant and
control and quote both.

### Dismissed by the user in triage (2026-09-29), recorded so it is not re-raised

- 2275-2279, the quoteAt cancellation sentence's unconditional "the head is quote-free after
  all": an unpaired `'` or `"` after the cancellation and ahead of the `$$` re-arms
  `enclosingQuote` and the readable arm reds (measured, plant and control, twice). Dismissed
  as the condition-carried-in-paragraph class: the paragraph's governing sentence ("takes a
  head with no quote open ahead of it on its own line") carries the condition, the round-3
  triage dismissed this class at its own items, and the round-4 "Considered and left" covers
  the backtick variant of the same interference.

### Learnings

No new entry. Items 1 and 2 are the fourth recurrence, on this file, of
`agents/docs/solutions/conventions/a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each.md`,
whose body does not yet carry the assignment-walk material. The architect folds the
recurrence into that entry via `/ce-compound-refresh` at archive, per the round-3 note.

## Backend round-5 signal (2026-09-29, commit 57afcc63)

The commit is an ancestor of `main` (`git merge-base --is-ancestor` checked) and touches
only `backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`.
Prose only: `git diff 67361efe 57afcc63` over the file (this round's whole diff; the file
started byte-identical to the round-4 result plus `67361efe`, the scan-roots sibling)
shows zero non-comment changed lines, verified mechanically. Both hold items AND all
corrections landed in this ONE commit, as prescribed: the adversarial verification ran
BEFORE committing rather than after, which is why this round lacks the
hold-items-then-corrections commit chain of rounds 2 to 4.

One verification workflow ran over the working tree (`wf_bb8556a5-403`, 18 agents, zero
errors): five measurement agents, three falsification lenses each required to demonstrate
with a plant AND a control, and two independent confirmers per deduped candidate, all in
their own scratch copies. Five falsifications were confirmed, every one 2/2; four were
fixed in the commit and one is recorded below for the architect. The correctness lens
returned no findings; the five came from the adversarial and sibling-consistency lenses.

### Item 1. Reach stated against the assignment token

Header item 4, the three-bucket clause and the `assembledWrites` docblock now state the
condition against the assignment, and the three-bucket clause pins what the walk asks:
POSITION, not text — the nearest head's read reaches the assignment where it did not give
up and ended past where the `updated_at` token begins (a later line, or the token's own
line either right of it or at no terminator at all). The hold's plant and control,
re-measured at 57afcc63 in a scratch copy:

- PLANT (an `UPDATE widgets` template opened on an earlier line, no `;` after its closing
  backtick, then a fragment spelling `SET b = 2;` with `updated_at = now()` on the next
  line): reds `every updated_at assignment resolves to the table it writes`,
  1 failed | 28 passed, exit 1.
- CONTROL (that `;` changed to `,`, the read then spans the assignment): 29 passed,
  exit 0.
- Bucket 2 measured positively: the control shape with `UPDATE accounts` reds BOTH writer
  arms (`the accounts writers found column-first are exactly the two signup finalizes`,
  `the accounts writers found table-first are the same two`), 2 failed | 27 passed,
  exit 1.

### Item 2. The disjunct covers the walk's domain

The fail-closed disjunct now reads `where the walk finds no head at all`, matching the
ALTER paragraph's sibling clause; the own-line-left slot sits inside the domain the same
sentence already states. Re-measured at 57afcc63:

- PLANT (a widgets head LEFT of the assignment on its own line, nothing above, read
  spanning the assignment — one line,
  `` const s = `UPDATE widgets SET a = 1, updated_at = now() WHERE id = 1;`; ``):
  29 passed, exit 0, where the old `no head sits above at all` wording promised a
  fail-closed red.
- CONTROL (the fragment alone, no head anywhere): reds
  `every updated_at assignment resolves to the table it writes`, 1 failed | 28 passed,
  exit 1.

### Corrections the verification pass forced, fixed in the same commit

1. The hold-prescribed rewrite itself overclaimed `the writer arms red` (plural) for
   bucket 2, and the round-4-reviewed ALTER-paragraph sibling carried the same plural.
   The walk buckets on position while the table-first arm answers to its own read of the
   TEXT, so a terminator landing between the `updated_at` token and its `=` satisfies the
   walk and not that arm. Both sites now split the consequent — the column-first arm reds
   on the bucket; the table-first arm only while the text still spells the write — with
   the ALTER paragraph deferring to the three-bucket sentence by name. Hold prescriptions
   are in scope per the standing convention. Measured at 57afcc63:
   - PLANT `export enum ProbeSql { "UPDATE accounts SET updated_at" = 1, }` (the enum
     member's closing `"` is the read's terminator, landing between the token and its
     `=`, inside the optional-quote slot of `COLUMN_ASSIGNMENT_RE`): reds the
     column-first arm ALONE, 1 failed | 28 passed, exit 1 — table-first and fail-closed
     both green.
   - CONTROL (the `=` moved inside the quotes): reds BOTH writer arms,
     2 failed | 27 passed, exit 1.
   The same boundary re-worded bucket 1: `closes before its assignment` became `ends
   before its updated_at token`, since the plant's read closes before the `=` yet
   resolves.
2. Three pre-existing comment sites stated the walk as a universal over heads above:
   the `targetTable` docblock (`provided the statement that head opens reaches the
   assignment's line`, an if-form its own inline comment contradicts), the
   `UNRESOLVED_TABLE` one-liner (`when no statement head above it reaches it`), and the
   `unresolvedIn` helper docblock (`that no readable head reaches`). The walk stops at
   the NEAREST head found and never climbs past, so a write whose nearest head does not
   reach it is labeled even while a farther readable head's read spans it. All three now
   state the nearest-head bound. Measured at 57afcc63:
   - PLANT (a near non-reaching head under a far reaching one: an `UPDATE far_table`
     backtick template holding `; UPDATE near_table SET b = 2 ;` on its middle line and
     `, updated_at = NOW()` on its last): reds
     `every updated_at assignment resolves to the table it writes`,
     1 failed | 28 passed, exit 1, although the far head's read spans the assignment.
   - CONTROL (the near head defused to `SELECT near_noise`): 29 passed, exit 0 — the far
     head, once nearest, resolves the same assignment silently, proving its read
     readable and reaching in both probes.

### [TODO Architect] Found, not acted on: the fail-closed arm's assertion message

The message inside the fail-closed arm's `it(...)` states the same falsified universal
(`an updated_at assignment that no readable statement head reaches`, with `a head further
up the file whose statement closed earlier does not count` as its only farther-head
caveat), and its remediation (`Give the statement a readable head`) misdirects in the
near-non-reaching case, where the statement HAS one. The near/far plant above reds this
very bar while a readable head reaches the reported assignment, and that head's statement
closed PAST it, not earlier. Confirmed 2/2 by independent re-measurement. It is a string
literal — a non-comment line — and the standing round-1 decision is no code change, which
every round's evidence has certified as zero non-comment changed lines, so it is recorded
here for the architect to rule rather than edited.

### Considered and left, with the reason

- Header scan-1's `The head counts only if the statement it opens reaches the
  assignment's line` keeps its deliberate `only if` necessity spelling: reaching the
  token implies reaching the line, so the necessary condition survives.
- The dynamically-named-target bullet's `"No readable head reaches it" is not a property
  of the shape...` and the `SpanEvent` docblock's `lends its table to a write below it
  that no readable head reaches` describe the span-replay mechanism
  `backend-head-line-read-silences-fail-closed-backstop` owns; the sweep read both and
  filed nothing.
- The quieting-shapes paragraph's `reds the fail-closed arm where no nearer head reaches
  it` already anchors on the assignment.

### Acceptance evidence

All vitest runs from scratch copies (`git archive HEAD backend`, the edited canary
overlaid, `node_modules` and `.env` symlinked, `tests/setup.ts` stubbed). The shared
checkout was never mutated by a probe; plants went to `backend/src/zz-probe-*.ts` inside
the copies and were deleted after each run.

- AC2 at the final tree: the canary is 29/29 and all nine `tests/eslint` files are
  139/139 with exit 0 and no `Errors` line; `npm run typecheck` and `npx eslint` on the
  file both exit 0; `ALLOWED_COLUMN_ALTERATIONS` is untouched (zero hits in the diff);
  the TypeScript scanner counts 54 block comments and 894 line comments with zero parse
  diagnostics at both range ends.
- AC3 is unchanged: no fixture or assertion was touched, so the round-1 pins still red
  under their mutants.
- The pre-commit anchor gate: a standalone proof ran the hook in a throwaway repo over
  the hold-items diff with `PEVO_ANCHOR_GATE=on` exported and a one-line firing control
  (`// see the rule below`, rejection captured verbatim); the full final diff then passed
  the live hook at commit with the gate on.

This round's corrections are the fifth recurrence on this file of
`agents/docs/solutions/conventions/a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each.md`
(the plural consequent and the universal-over-heads items are the same class); no new
entry, and per the round-3 and round-4 notes the architect folds the recurrence at
archive. Backend did not run code review (`agents/backend/CLAUDE.md` assigns
`/ce-code-review` to the architect).

## Architect re-review (2026-09-29, round 5) — HELD PENDING FIXES:

Reviewed `57afcc63` alone (`57afcc63^..57afcc63`, an ancestor of `main`) via
`/ce-code-review` across four lenses (correctness, project-standards on root `CLAUDE.md`,
adversarial, learnings) plus one validator batch that re-measured both actionable findings in
its own `git archive 57afcc63` copy. The cross-model pass did NOT run (the reviewed commit is
no longer the working-tree file, and only a same-family route is installed on this host), so
the adversarial lens ran in-process. No reviewer touched a database or the shared checkout.
Every line number below is a line number in the file AT `57afcc63`. Two sibling commits
(`35b3a3bb`, `50a582dc`, the scan-roots task) landed on the file while this review ran; their
hunks touch none of the sentences below, but text past line 256 sits lower at HEAD (header
item 4 is unmoved at 189; the `assembledWrites` sentence is at 2691 and `UNRESOLVED_TABLE` at
1128 as of `50a582dc`).

**What held up, so it is not redone.** Both round-4 items landed and were re-derived by
execution rather than taken from the signal, each by three lenses independently. Item 1: the
hold's plant (an `UPDATE widgets` template opened above, no `;` after its backtick, fragment
`SET b = 2;` with `updated_at = now()` on the next line) reds
`every updated_at assignment resolves to the table it writes`, exit 1; the `;`-to-`,` control
is 29/29, exit 0. Item 2: the own-line-left widgets head is 29/29 and the fragment-alone
control reds the fail-closed arm. The self-found corrections hold too: the enum-member plant
reds the column-first arm ALONE (1 failed | 28 passed) and the `=`-inside-the-quotes control
reds both writer arms (2 failed | 27 passed); the near/far plant reds the fail-closed arm and
the `SELECT near_noise` control is 29/29. The new POSITION rule's other disjuncts were probed
true (a migration last line with no terminator resolves; a read that passes the assignment and
then ends a later line inside a value does not). AC2, re-run by the architect from a
`git archive 57afcc63` copy: canary 29/29, all nine `tests/eslint` files 139/139 with exit 0
and no `Errors` line, `npm run typecheck` and `npx eslint` on the file exit 0,
`ALLOWED_COLUMN_ALTERATIONS` absent from the diff. Prose only, verified mechanically: the
non-comment parser-leaf streams at base and head are identical (22745 leaves), with 54 block
comments (45 JSDoc), 894 line comments and zero parse diagnostics at both ends. The pre-commit
anchor gate is zero-hit over the 41 added lines with `ALLOW_MARKER` set and a firing control.
Project standards is clean.

The hold is prose only, two items, one commit. The user's round-1 decision stands: no code
change, no new fixture. Quote item 1's plant and control in the signal.

### Item 1 (required). "Runs on to the assignment" buckets a read that gave up past it.

Header item 4 (lines 186-190: "where that nearest head's read runs on to the assignment, the
assignment is bucketed under that head's table instead") and the `assembledWrites` docblock
(2645-2649: "where it runs on to the assignment, the assignment is bucketed under its table
instead") state the bucketing consequent without the gave-up condition. `targetTable`
(2298-2302) refuses any read with `stopped` set, whatever line it stopped on, and this same
commit says so at 309 ("where it did not give up and ended past where the `updated_at` token
begins") and 2279. Measured twice (adversarial, the validator), same result: an
`UPDATE widgets` template opened on a line above its head, whose read runs into a SET-list
fragment, passes `updated_at = now(),` and gives up on the next line (a value left open), reds
`every updated_at assignment resolves to the table it writes`, 1 failed | 28 passed, exit 1;
the control with that value closed on its own line is 29/29, exit 0. A direct `statementAt`
probe shows the read at `lastLine` past the assignment with `stopped` true in the plant, false
in the control. The error is in the loud direction, and the two sentences are this range's
rewrite of the round-4 item-1 sites.

Fix: at both sites, either defer the reach condition to the three-bucket clause's definition
by name (preferred: one definition, restated nowhere, is what ends this recurrence), or carry
both halves of it (did not give up; ended past where the token begins). Check every other
sentence in the file that states the bucketing consequent for the same omission and list what
the check covered, from the code; at `57afcc63` the architect's grep finds "runs on to the
assignment" at these two sites only, and line 313's "runs on into the fragment but ends before
its `updated_at` token" is correct. Re-measure the plant and control above and quote both.

### Item 2 (required). The `UNRESOLVED_TABLE` one-liner leaves the no-head case to a parenthetical.

Lines 1085-1087: "The label a write gets when the NEAREST head the upward walk finds — if it
finds one at all — has a read that does not reach it." The condition depends on a head being
found; the no-head case, which `targetTable` returns at 2304, is never stated. The
`unresolvedIn` docblock this range also rewrote (4816-4818) and the round-4 item-2 disjunct
both name it as its own disjunct. Found independently by correctness, adversarial and
learnings. Nothing false, wording only. Fix: state it as the two-disjunct form its siblings
use (the walk finds no head, or the nearest head it finds has a read that does not reach it).

### Dismissed by the user in triage (2026-09-29), recorded so it is not re-raised

- 413-416, the quieting-shapes clause's "where one naming another table does, it is bucketed
  there": the walk asks only the NEAREST head, so an even nearer non-reaching head reds the
  fail-closed arm instead (plant and control reproduced three times). Dismissed: the sentence
  predates this range (`d0c5f95e`), it defers by name to the ALTER paragraph that carries the
  nearest-head bound, and the round-3 triage dismissed contrived nearer-head layouts in the
  same passage. Leave its wording as is; item 1's check is for the gave-up condition only.
- 2280, the `targetTable` docblock's "A head whose statement ended before that belongs to
  some other query": "ended before" now also covers a read that hit `LITERAL_CAP` short of
  its own assignment, which is that assignment's own statement (measured: a 47-line template
  reds, the 30-filler-line control is green). Dismissed: the outcome it states is correct,
  only the stated reason is off, and only for a statement longer than the cap.
- 354, the ALTER paragraph's "the table-first arm reds only while that head's read still
  spells the write": that arm reads from every `accounts` head, so a farther accounts
  template reds both writer arms. Contrived, and red either way.
- 305 and 355, "the three buckets the columnAssignments paragraph below gives" and "per the
  three-bucket sentence above" point at each other. Both enumerate all three buckets;
  navigation only, and the convention's restate-it clause is met.
- 2646, `assembledWrites`' "spans the ASSIGNMENT" differs from the token-begin rule only when
  a `"` terminator sits between the token and its `=`, which only an enum or class-field
  member name produces.

### The round-5 `[TODO Architect]`, triaged by the user (2026-09-29). No action on this task.

The fail-closed arm's assertion message (2987-2991) states the falsified universal ("no
readable statement head reaches", "Give the statement a readable head"). The claim is true,
confirmed by four agents with the near/far plant and control. DISMISSED: the red bar still
names the site and its line, the misdirection needs a near/far layout no tree writes, and
lifting the no-code-change decision for one string is not worth another surface.

### Learnings

No new entry. This round's item 1 is the sixth recurrence, on this file, of
`agents/docs/solutions/conventions/a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each.md`:
the sweep patched the sites a verification pass named instead of re-deriving every
restatement. The architect folds the recurrence into that entry via `/ce-compound-refresh` at
archive, per the round-3 and round-4 notes, together with the stale `targetTable` summary in
the normalization entry's Examples that the learnings lens flagged.
