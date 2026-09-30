## The assembled-write scan reads one head where the shared set names two (archived 2026-09-30)

Architect archive note (2026-09-30, round 6): archived clean after six rounds. Re-reviewed
`f9a839a8` alone (an ancestor of `main`, 11 added and 9 removed comment lines) with
/ce-code-review: correctness, project-standards on root `CLAUDE.md`, adversarial in-process
(the reviewed tree was not the checkout, and this host has no different-model peer) and
learnings. No actionable finding. Both round-5 items are FIXED.

- Item 1: header item 4 and the `assembledWrites` docblock state the bucketing consequent
  with the defined verb and defer what reaching asks of a read, by name, to the
  dynamic-SQL entry under KNOWN LIMITS. "runs on to the assignment" occurs nowhere in the
  file. The hold's plant reds `every updated_at assignment resolves to the table it writes`
  (1 failed | 29 passed, exit 1) and its closed-value control is 30/30, re-measured by the
  architect. Item 2: `UNRESOLVED_TABLE` carries the two-disjunct form, one disjunct per
  `targetTable` return site; the no-head, closed-nearest-head and near/far plants each red
  the fail-closed arm and the near/far control is 30/30.
- Three parties planted independently (correctness 12, adversarial 21, the architect 9) and
  found no layout where a rewritten sentence plus the deferred definition predicts one
  outcome and the canary does another. The entry holds one definition of reach and it maps
  term for term onto `targetTable`'s `reaches` expression.
- Architect intake from a `git archive f9a839a8` copy: canary 30/30, all nine `tests/eslint`
  files 140/140 with exit 0 and no `Errors` line, `npm run typecheck` and `npx eslint` on
  the file exit 0. Prose only, verified mechanically: the non-JSDoc parser-leaf streams at
  base and head are identical (23141 leaves, zero parse diagnostics, a mutation control
  that differs). The anchor gate is zero-hit over the 11 added lines with a firing control.
  Project standards is clean.
- Routed, by user triage, to `backend-head-line-read-silences-fail-closed-backstop`
  (commit `f3e8048a`, which also merges `backend-opened-above-head-lends-its-table` into
  it): the one P3 advisory of this round (the reach definition says "did not give up" and
  never links `SqlStatement.stopped`; correctness and adversarial, independently); the
  pre-existing header scan 2 sentence that promises the fail-closed red bar as a universal
  (silent under an opened-above preceding head: plant 30/30, control reds, reproduced by
  the architect); the two sentences that state the refusal in terminator terms; the
  no-terminator member of the opened-above layout; and the round-6 `[TODO Architect]` on
  the quoted-identifier bullet (reproduced: red where the sentence predicts silence,
  control 30/30).
- Dismissed by the user in triage, recorded so they are not re-raised: the
  `SqlStatement.stopped` docblock's "runs on past everything below it, so it does reach a
  write there" (a write past `LITERAL_CAP` is not reached; loud direction, statements over
  40 lines only, the same class as the round-5 `targetTable` dismissal); the unpinned
  `reach.closedAt === -1 ||` disjunct (deleting it leaves the suite 30/30; a regression
  there errs loud, and the no-new-fixture decision stands). Not held, nothing false: the
  `assembledWrites` lead-in "whether its read spans the ASSIGNMENT", the two bare pronouns
  in "where it does reach it", the numeral in "the three buckets", and the deferral name
  resolving by convention.
- Learnings: no new entry. The recurrence goes into
  `conventions/a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each.md` and the
  stale `targetTable` summary in the comment-normalization entry is corrected, both via
  /ce-compound-refresh in the same pass, as the round-3 to round-5 notes planned.
- Sibling commit `078550bc` landed on the file during the review; its hunks touch none of
  the reviewed sentences. Line numbers in the rounds below are as of each round's commit.


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
