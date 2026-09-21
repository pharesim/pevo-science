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

### Not triaged this round

The four `[TODO Architect]` pre-existing gaps above are the architect's to route and need
no backend action. Two appear to overlap tasks already in `pending/` (the routine arms'
tree in `backend-alter-accounts-if-exists-evades-pin`, the `public.` qualifier in
`backend-trigger-bind-qualifier-admits-no-spacing`); the architect is checking before
filing or dismissing.
