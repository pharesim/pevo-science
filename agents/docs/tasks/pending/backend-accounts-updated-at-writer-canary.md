# Pin the accounts.updated_at writer set with a canary

**Owner:** backend
**Created:** 2026-09-06

Routed out of the round-4 architect review of the custody-column alignment
work. The dependency this guards was created by that task; the guard is
separate work, so it is filed here rather than held there.

## Why

The `/link` stuck-recovery lookup in `routes/signup-verify.ts` admits a row
only when `upgraded_at <= updated_at`. That branch bypasses the signup
session-binding check, so the ordering is what keeps an upgraded self-custody
account out of a bypass it must never reach. The ordering holds for exactly one
reason: an upgrade stamps `upgraded_at` and never touches `updated_at`, so an
upgraded row always carries an epoch strictly newer than its recency marker.

That reason depends in turn on a universal the route comment states outright:
the two signup finalizes are the only statements that write
`accounts.updated_at`, and the table carries no trigger. The claim is true
today. Four independent checks during the round-4 review confirmed it (a grep
of every `UPDATE accounts` in `backend/src`, two reviewer enumerations, and a
validation pass), and no migration defines a trigger on `accounts`.

Nothing enforces it. A third writer added later for an unrelated reason (a
settings touch, a profile write, an admin tool) would bump `updated_at` on an
upgraded row, invert the ordering, and silently make that account eligible for
the binding bypass. No existing test goes red. The seven canaries already in
`tests/eslint/` are the established way this repo enforces tree-wide invariants
of exactly this shape.

## Scope

1. Add a source canary under `backend/tests/eslint/` that finds every statement
   in `backend/src` writing `accounts.updated_at` and asserts the writer set is
   exactly the two signup finalizes: the `/confirm` finalize and the `/link`
   finalize. An allow-list keyed on `file#symbol`, so a third writer fails the
   bar rather than passing silently. The `sourcesUnder` and
   `statementOccurrences` helpers in `tests/support/enclosing-symbol.ts` already
   do the scanning and symbol attribution; reuse them rather than writing a
   third walker.
2. The failure message must say why the set is closed, not just that it
   changed: name the `/link` stuck-recovery ordering and the session-binding
   bypass it protects, so whoever trips it can tell whether their new writer is
   safe. A bare "unexpected site" message sends the next author to delete the
   assertion.
3. Verify the guard by mutation, not by reasoning: add a third `updated_at`
   writer to a scratch copy of a route, confirm the canary reds, and confirm it
   greens again when removed.

## Acceptance criteria

1. The canary passes on the current tree with the allow-list naming exactly the
   two finalizes.
2. Adding any third `accounts.updated_at` writer to `backend/src` turns it red,
   demonstrated by mutation rather than asserted.
3. The failure message names the invariant at risk, not only the drift.

## Notes

- Known limit, worth stating in the canary's docblock rather than discovering
  later: the scan is textual, so a dynamically assembled `UPDATE` statement
  would hide from it. No `UPDATE accounts` SET list in `backend/src` is
  string-interpolated today, which is what makes a text scan sound here.
- Do not widen this into a general "audit every accounts column writer" guard.
  The value is specific to `updated_at`, because that column is the one a
  security-relevant ordering is measured against.
- The companion architect work (recording the ordering dependency in
  ARCHITECTURE.md § 6.1 / § 6.7) is deferred to the archive of the
  custody-column alignment task. This canary does not depend on it.

## Backend implementation note (2026-09-06)

Landed as `backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`
(8 specs). Green on the clean tree; `npx vitest run tests/eslint/` is 9 files /
117 tests green.

### Deviation from the task's stated reuse

The task directs reuse of `sourcesUnder` and `statementOccurrences` from
`tests/support/enclosing-symbol.ts`. `sourcesUnder` is there and is reused, as
are `enclosingSymbol` and `isCommentLine`. `statementOccurrences` is NOT in that
module: it is a private function inside
`no-custody-claim-derivation-outside-helper.test.ts`, and its `STATEMENT_JOIN_CAP`
of 4 is tuned for TypeScript expressions. The `/confirm` finalize puts five SET
lines between `UPDATE accounts` and its `updated_at = NOW()`, so that helper
structurally cannot reach the shape this canary exists to see. Promoting it to
the shared module would also have edited a canary whose owning task is mid-hold
in `pending/`. So the new file carries its own statement reach, delimited by
what a SQL statement actually ends at (the string quote in TypeScript, the
semicolon in a migration) rather than by a joined-line budget. The choice is
recorded in the file's own docblock.

### What the canary does

Four scans over `backend/src`:

1. Column-first: every `updated_at` assignment, attributed to its table by
   walking up to the nearest `UPDATE <table>` / `INSERT INTO <table>`; those
   resolving to `accounts` are TALLIED per `file#symbol` and compared to the two
   finalizes.
2. Fail-closed resolution: no assignment may resolve to `<unresolved>`.
3. Table-first: every `accounts` DML statement read whole, flagged when its SET
   list or INSERT column list carries the column. Not redundant with (1) - an
   `INSERT INTO accounts (..., updated_at)` carries no assignment token at all.
4. No interpolated `accounts` write.

Plus, over `backend/migrations`: the migration writer set pinned to the
column-introducing back-fill, and a refusal of every trigger, rule, function and
procedure. The fail-closed arm spans both trees.

Three additions beyond the literal scope, each stated so the architect can
reverse any of them:

- **Migrations are in scope.** The route comment's universal has two halves and
  the second one ("the table carries no trigger") is the writer no scan of
  application source can see. Pinning the migration-side writer set covers the
  same hazard the custody-alignment migration's own header spends a paragraph
  warning about. Zero triggers/rules/routines exist today, which is what lets
  the arm refuse all of them rather than parse each target table; the exemption
  list is the escape hatch and is empty.
- **Occurrence counts, not a key set.** Both allowed keys are route handlers
  running a couple of hundred lines each, so a key set alone would absorb a
  second write added anywhere inside `POST /confirm` or `POST /link` - including
  the resume branch, where an author fixing a recovery bug would most naturally
  put one. Verified by mutation.
- **Scan 4 (no interpolation).** An accounts write partly held in a variable
  defeats the other three at once: the fragment carrying the assignment is
  attributed by the upward walk to whatever table sits above the constant's
  declaration, so it RESOLVES and the fail-closed arm stays quiet. Refusing the
  shape is what keeps scan 2's guarantee from being conditional. Zero accounts
  DML literals interpolate today. Read-side interpolation is untouched (the two
  recovery lookups interpolate their window and are SELECTs).

### Mutation verification (acceptance criterion 2)

Ten classes, each applied to a scratch copy of a real file, run, and reverted;
each reds the named scan and greens on restore.

1. `updated_at = NOW()` appended to an existing `UPDATE accounts` SET list in
   settings - scans 1 and 3.
2. Brand-new multi-line accounts writer in a file that writes no accounts
   column today - scans 1 and 3.
3. `INSERT INTO accounts (..., updated_at)` - scan 3 only, which is the
   demonstration that scan 3 is not a redundant spelling of scan 1.
4. Same INSERT behind a table alias (`INSERT INTO accounts AS a (...)`) -
   scan 3.
5. Row-assignment form `SET (password_hash, updated_at) = ($1, NOW())` -
   scans 1 and 3.
6. A SECOND writer inside the already-licensed `POST /confirm` handler -
   scans 1 and 3, via the occurrence count.
7. Interpolated SET fragment in an accounts write - scan 4.
8. An assignment with no readable statement head - scan 2.
9. Migration back-fill bumping the marker - the migration writer pin.
10. `CREATE OR REPLACE FUNCTION ... NEW.updated_at := NOW()` in a migration -
    the routine arm. A migration-side unresolvable write reds scan 2.

Classes 4, 5, 6 and 7 were found by an adversarial review pass against the first
draft, which was green on all four. Each is valid PostgreSQL or valid house
style, and each is now closed with a planted probe beside it.

### Failure messages (acceptance criterion 3)

One `ORDERING_RATIONALE` constant is interpolated into every assertion's message.
It names the `upgraded_at <= updated_at` term, the signup session-binding bypass
the term protects, why an upgrade leaves the marker alone, and what a third
writer does to an upgraded account. It closes by telling the reader to justify a
new writer rather than widen the list to clear a bar. Rendered output verified
against a live mutation.

### [TODO Architect] Surfaced, not acted on

A schema-level complement exists and would be strictly stronger than a source
scan: `accounts` already carries a two-column CHECK relating `upgraded_at` to
`custody`, and an ordering CHECK of the same family
(`upgraded_at IS NULL OR upgraded_at >= updated_at`) would refuse the bad row at
commit, closing the residuals this canary has to state as limits (dynamic table
names, an operator's ad-hoc psql, a future trigger). It holds for every state
enumerated in ARCHITECTURE.md section 6.1 as far as I traced it: the `/link`
finalize writes both stamps from one `NOW()` so they are equal, the custody
upgrade leaves the marker alone so the epoch is strictly newer, and both
migration back-fills leave the pair as they found it.

Not implemented here. It is a schema change with its own deploy-ordering
question (the same class the custody-alignment migration's header documents), it
is outside this task's stated scope, and the two guards compose rather than
compete. Filed for triage rather than actioned.

Also verified and NOT a hazard, recorded in the canary docblock because it is
the shape most likely to be "fixed" into a third writer: the signup upserts
refresh `created_at` in their `ON CONFLICT ... DO UPDATE` branches and leave
`updated_at` alone. A column DEFAULT fires on the insert branch only, so those
branches genuinely do not advance the marker - and that asymmetry is what keeps
a repeat signup against an existing row from moving the marker past an upgrade
epoch. Symmetrising it is exactly what this canary refuses.

### Verification

`npm run typecheck` (src + tests) clean. `npm run lint` clean apart from the
pre-existing unrelated warning in `src/lib/author-supersession.ts`.
`tests/eslint/` 9 files / 117 tests green. `.githooks/pre-commit` anchor gate
exits 0 against the staged diff. No production code changed; the only new file
is the canary.

## Architect re-review (2026-09-08) — HELD PENDING FIXES:

Reviewed at commit 57ffc5cf via /ce-code-review (correctness, security,
adversarial, testing, maintainability, project-standards, learnings; eight
actionable findings independently validated). The core path is confirmed:
the writer set re-enumerated from the tree matches the allow-list, the suite
is green (9 files / 117 tests), and two mutations re-run by the architect in a
scratch copy both red as claimed (a third writer in `POST /verify` as a new
key; a second writer inside `POST /confirm` as count 2). The hold is about
what the guard promises beyond the shapes the tree writes today, and about
the accuracy of the rationale the next author will read. Each item states
the invariant; the construct is the implementer's choice. Verify every item
by mutation in a scratch copy (red on the mutation, green on restore) and
state the probe per item in the re-review note.

### Bundle A: the fail-closed resolution arm must be unconditional

1. **An assignment whose statement head the walk cannot read must resolve to
   `<unresolved>` regardless of what other DML sits above it in the file.**
   Today `targetTable` walks up to `WALK_CAP` lines without stopping at the
   assignment's own string literal, so a head the regexes cannot read (a
   `MERGE INTO`, a quoted identifier, a comment-tagged head, a `+`-joined
   fragment) resolves to the PREVIOUS statement's table and passes as "not
   accounts". Route handlers chain queries a few lines apart, so the silent
   direction is the common placement. Two fix shapes are acceptable: stop
   the walk when it leaves the assignment's literal, or require that the
   statement text read from the found head contains the assignment line.
   Probe: place a foreign-table `UPDATE` two lines above each of the three
   shapes in items 2 to 4 and confirm each reds.
2. **`MERGE INTO accounts` must be attributed to accounts, not merely
   unresolved.** Add a MERGE head to `ACCOUNTS_STATEMENT_RE` and a MERGE
   target consulted by `targetTable`, so both the `WHEN MATCHED THEN UPDATE
   SET updated_at` branch and the `THEN INSERT (..., updated_at)` branch red
   the writer scans. Planted positives for both branches. PostgreSQL 16 is
   what runs here, so MERGE is a valid writer shape.
3. **A head line prefixed with an editor tag (`/* sql */ \`UPDATE accounts`)
   must be scanned.** `isCommentLine` is shape-only and skips that line in
   `accountsColumnWriters`, the interpolation scan and `targetTable`. Ask
   whether the SQL keyword itself sits inside a comment, not whether the line
   starts like one. Planted positive.
4. **The KNOWN LIMITS claim "a SET list composed from a variable is refused"
   must be true or narrowed.** Scan 4 tests only for `${`; a `+`-joined
   fragment is unseen by every scan today. Either extend scan 4 to the
   concatenated shape, or narrow the sentence to `${...}` interpolation and
   list `+` concatenation as unscanned. After item 1 such a fragment reds by
   resolution, so say that if you narrow.

### Bundle B: the rationale must describe the whole invariant

5. **`ORDERING_RATIONALE` and the "WHAT THE CLOSED SET BUYS" paragraph must
   state that `updated_at` is also the sole recency bound of the `/confirm`
   stuck-recovery lookup on light rows** (`custody = 'light' AND updated_at >
   NOW() - INTERVAL`), whose resume path mints a light-custody session on a
   posting-key proof alone. The safety test for a new writer is "it can never
   bump the marker on a finalized row, light or upgraded". Today a writer
   scoped `WHERE custody = 'light'` reads as safe by the message's own words,
   which is the acceptance-criterion-3 failure the message exists to prevent.
6. **The "WHERE THE THIRD WRITER MOST PLAUSIBLY COMES FROM" paragraph credits
   the upsert's DEFAULT-only asymmetry with keeping a repeat signup off an
   upgraded row. The actual barrier is the 409 pre-check in `POST /signup`**
   (`verify_token === null` or a `confirmed:` token), which keeps the upsert
   off every finalized row, so the `DO UPDATE` branch only ever touches a
   pending row with no upgrade epoch. Reword; keep "symmetrising is refused"
   as the defence-in-depth conclusion. Apply the same correction to the "Also
   verified and NOT a hazard" paragraph in this task's implementation note.
7. **"WHY A SOURCE SCAN" says the schema cannot express the ordering. It
   can:** `CHECK (upgraded_at IS NULL OR upgraded_at >= updated_at)` pins the
   `/link` ordering for every state in ARCHITECTURE.md section 6.1 (it does
   not bound the `/confirm` window). Rewrite the sentence so the docblock
   does not contradict this task's own `[TODO Architect]` proposal; say what
   the scan covers that a CHECK cannot.

### Bundle C: guard features must be pinned, and the migration arm complete

8. **The table-first scan must run over `migrations` too.** A migration
   `INSERT INTO accounts (..., updated_at) VALUES (...)` is green today
   because `accountsColumnWriters` is only ever called with `sources`. One
   assertion against `ALLOWED_WRITER_MIGRATIONS` closes it and gives the `;`
   terminator in `sqlStatementAt` a live path; plant a migration-shaped
   fixture through `sqlStatementAt` so that branch has a self-test.
9. **Each planted probe must fail without the feature it cites.** Deleting
   the `(?<!\bFOR\s+)` lookbehind in `UPDATE_TARGET_RE`, the `(?!=)`
   lookahead in `COLUMN_ASSIGNMENT_RE`, or the quote detection in
   `sqlStatementAt` each leaves the suite green today, because the cited
   probes are answered by a different feature (the FOR UPDATE fixtures put
   the true head directly above the assignment; the `==` probe is rejected by
   the `.` lookbehind; the one-liner's over-read line carries no assignment).
   Replant so each deletion reds.
10. **Exemption entries must not outlive the routine they were judged for.**
    `ROUTINES_THAT_CANNOT_REACH_ACCOUNTS` matches by substring of the whole
    site string, so a routine name would also exempt every later `CREATE OR
    REPLACE FUNCTION <name>` in any migration, and a trigger body's
    `NEW.updated_at := now()` is invisible to `COLUMN_ASSIGNMENT_RE` by the
    `.` lookbehind, so the routine arm is the only catcher. Key exemptions on
    the exact reported site (or at least `file#routine`); refuse any `CREATE
    [CONSTRAINT] TRIGGER ... ON accounts` regardless of exemption; pin in the
    self-test that `NEW.updated_at := now()` does NOT match the column regex,
    so the dependency on the routine arm is recorded rather than implied.

### Dismissed, recorded here so they are not re-raised

- `countsOf` duplicating the counted tally the frontend hand-port of
  `enclosing-symbol` returns: dismissed. Per-canary statement and tally
  helpers are the established pattern (ratified on the custody-column
  alignment task); no runtime effect; the shared docblock's fail-closed
  argument holds unchanged for the counted form.
- Seen and accepted as textual-scan limits, not held: quoted identifier
  `UPDATE "accounts"`, upper-case `UPDATED_AT`, a column-list-less
  positional `INSERT INTO accounts VALUES (...)`, an auto-updatable VIEW over
  accounts, `UPDATE` and `accounts` on separate lines, silent `LITERAL_CAP`
  truncation, `--` stripping inside migration string constants, and scan
  roots that exclude scripts, test fixtures, runtime-loaded SQL and operator
  psql. None is house style. Adding the first three to KNOWN LIMITS is
  welcome but not required.
- The task note's class-10 attribution ("reds scan 2") is wrong (the routine
  arm is the sole catcher of a trigger body) but the outcome is red as
  claimed; item 10 records the dependency.

### Not part of this hold

- The `[TODO Architect]` CHECK constraint remains an open architect
  decision. It is the only guard for a backward clock step between a
  `/confirm` finalize and a custody upgrade (both epochs come from the
  database clock, so that inversion needs no writer), and it is a schema
  change with its own deploy ordering. Tracked separately; do not implement
  it under this task.
