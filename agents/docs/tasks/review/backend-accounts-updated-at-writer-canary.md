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
`updated_at` alone. What keeps those branches off a finalized row is the
duplicate-email pre-check in `POST /signup`, which answers 409 when the row's
`verify_token` is NULL or carries a `confirmed:` token, so the `DO UPDATE`
branch only ever lands on a pending row with no finalize behind it and no
upgrade epoch. Leaving `updated_at` out of the branch is defence in depth
behind that pre-check: should the upsert ever reach a finalized row, it still
does not move the marker. Symmetrising it is exactly what this canary refuses.

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

## Backend re-review signal (2026-09-08, working tree)

All ten hold items landed. Every item was verified by mutation in a scratch
copy of `backend/` (tar copy, symlinked `node_modules`, a probe-only vitest
config), red on the mutation and green on restore, and the probe is stated per
item below. The suite grew from 8 specs to 20; `tests/eslint/` is 9 files /
130 tests green.

The hold's own instruction to verify by mutation is what turned this into more
than ten fixes. Mutation probing confirmed each item, but four adversarial
sweeps against the file found shapes no probe of the prescribed list reached,
and most of them were silent passes rather than false alarms. The scanning core
was rewritten twice as a result. What that bought is recorded under "Beyond the
hold" below, because it changes what the canary promises.

### Bundle A

1. **Fail-closed resolution is unconditional.** `targetTable` stops at the
   first head it meets and admits it only when the statement that head opens
   REACHES the assignment's own position: a head whose statement closed earlier
   on the line, or on an earlier line, resolves to `<unresolved>` instead of
   lending its table. The walk no longer climbs past a head to whatever query
   sits further up. Probes: a foreign `UPDATE sessions` placed two lines above
   a quoted-identifier head, a variable table name, a `+`-joined head and an
   interpolated fragment each red the resolve arm, adjacent or spaced; a
   readable non-accounts head two lines below the same foreign statement stays
   green; a sibling query that opened and closed to the LEFT of an unreadable
   head on the same line reds rather than lending `sessions`.
2. **MERGE is attributed to accounts.** `MERGE INTO` is a head pattern and a
   statement pattern, both admitting `ONLY` and a parenthesised target, and
   `writesColumn` reads every `WHEN NOT MATCHED THEN INSERT` branch, not the
   first. Probes: the `WHEN MATCHED THEN UPDATE SET` branch reds both writer
   scans with the resolve arm green; the insert branch reds table-first only,
   which is the demonstration that the two scans see different shapes; a MERGE
   whose SECOND conditional branch names the column reds; a MERGE insert branch
   followed by a masking `INSERT INTO accounts (email)` reds; a MERGE in a
   migration reds both migration arms; `MERGE INTO sessions` stays green.
3. **A head is read wherever the keyword sits outside a comment.** The
   line-shape comment test is gone. Comment SPANS are blanked to equal-length
   spaces before any pattern runs, so an editor tag ahead of a literal
   (`/* sql */` before the template) is scanned. Probes: the tagged head reds
   both writer scans on one line and across lines; a commented-out statement,
   a trailing comment and a docblock mention all stay green.
4. **The assembled-write claim is true as written.** `joinedByPlus` recognises
   a `+` before the opening quote, after the terminator, and leading the next
   line, and the failure list tags each site `[interpolation]` or
   `[concatenation]`. The KNOWN LIMITS sentence now says what is NOT seen: a
   join spelled away from the statement's own lines, and a dynamically named
   target. Probes: three join spellings and an interpolation red the assembled
   arm; a spelled-out statement and a joined SELECT stay green.

### Bundle B

5. **Both recovery bounds are stated.** `ORDERING_RATIONALE` and the docblock
   name the `/confirm` bound (`custody = 'light'` plus recency, resuming on a
   posting-key proof into a light-custody session mint) alongside the `/link`
   ordering, and close with the test a new writer actually has to meet: not
   what its WHERE clause says, since one scoped to `custody = 'light'` reopens
   the `/confirm` window just the same, but whether it can ever bump the marker
   on a finalized row, light or upgraded. Verified against the route: the
   `/confirm` resume path mints `custody: 'light'` gated on
   `verifyPostingKeyAuthorized` alone.
6. **The upsert paragraph credits the right barrier.** The `POST /signup`
   duplicate-email pre-check answers 409 for a row whose `verify_token` is NULL
   or carries a `confirmed:` token, so the `DO UPDATE` branch lands only on a
   row that check could see as pending. Leaving `updated_at` out of the branch
   is the defence in depth behind it, and symmetrising the branch stays the
   refused shape. The same correction is applied to the implementation note
   above.
7. **The source scan is no longer claimed to be the only possible guard.** The
   paragraph says the CHECK constraint would pin the `/link` ordering at commit
   for every state section 6.1 enumerates, that it is proposed alongside this
   canary rather than replaced by it, and what it cannot express: the
   `/confirm` bound is a claim about WHICH statement stamped the marker, which
   a constraint cannot see.

### Bundle C

8. **The table-first scan runs over migrations.** A second migration arm
   compares `accountsColumnWriters(migrations)` to the allow-list, and any
   `.sql` resource found under `src` is scanned with them rather than dropped
   by an extension filter. Probes: a migration `INSERT INTO accounts (email,
   updated_at)` reds table-first only, with column-first green, which is the
   motivating case; a back-fill reds both; a second statement on one migration
   line reds; a repair that writes no marker stays green.
9. **Each planted probe fails without the feature it cites.** Every feature was
   deleted in turn and the resulting bar recorded: the FOR-UPDATE lookbehind
   needed a fixture where the row lock sits to the RIGHT of the true head, the
   quote detection needed a decoy literal ahead of the keyword inside the same
   template, and the occurrence count needed a two-write fixture. The full
   deletion set (48 features across the reader and the patterns) is exercised;
   the last four that stayed green were pinned after the final sweep.
10. **Routine exemptions are keyed exactly.** `RoutineSite.key` is
    `file#KIND name`, `unexempted` compares by equality, and a trigger or rule
    bound to `accounts` is refused BEFORE the exemption list is consulted, so
    no entry can license one. A self-test pins that `NEW.updated_at := now()`
    does NOT match the column pattern, recording that the routine arm is the
    sole catcher of a trigger-body write. Probes: the same function name in two
    migrations is exempted separately; a name-only entry exempts nothing; an
    accounts-bound trigger and rule red despite exact exemptions; a trigger on
    another table with both routines judged stays green; a quoted routine name
    reports `<unnamed>`, which an exemption can name but not widen.

### Beyond the hold, because the sweeps found silent passes

The scanning core was rewritten around one reading layer. Every scan now reads
a file whose COMMENT spans are blanked to equal-length spaces, walked from the
top with block-comment, template and dollar-quote state carried across lines.
The reason is that every pattern needs two tokens adjacent, SQL admits a
comment wherever it admits whitespace, and the scans share those patterns, so
one comment between a column and its `=` silenced all of them at once. That
shape, and its relatives (a comment in a row target list, in an INSERT column
list, carrying a semicolon that ended the statement read, or carrying a table
name that supplied a nearer head) were all green before.

The reader errs toward READING, because a blanked line is a line no scan sees:
an unclosed comment opener is text rather than a comment, a value keeps its
markers, a decrement is an operator on either side, and an unescaped backtick
ends a template whatever else is open. Three of those were live defects found
after the rewrite: a glob in a template opened a comment that blanked the rest
of the file, an apostrophe in prose left the template flag inverted, and the
`$${n}` placeholder idiom this repo uses opened a phantom dollar-quoted span
that had comment blanking switched off across 16 files and 5,568 lines.

Also added, each because a sweep found the shape passing: writes are tallied
per occurrence rather than per line, so a second write riding on a licensed
write's line raises the count; an `accounts` statement that cannot be read to a
terminator is refused rather than cleared; `COPY accounts (..., updated_at)`
is a writer; and `ALTER TABLE accounts` naming the column is pinned to the
migration that introduces it, because `ALTER COLUMN ... TYPE ... USING` rewrites
every row with no statement that writes one.

Residuals are stated in KNOWN LIMITS rather than left to be found: a dynamic
target whose COLUMN is also dynamic (no `updated_at =` token remains for the
fail-closed arm), a string value spanning lines, and the shapes that only look
like a comment or a value to the reader.

### Verification

`npm run typecheck` (src + tests) clean. `npm run lint` clean apart from the
pre-existing unrelated warning in `src/lib/author-supersession.ts`.
`tests/eslint/` 9 files / 130 tests green. `.githooks/pre-commit` anchor gate
exits 0 against the staged diff, including the row and table nouns added to it
today. No production code changed; the only changed file is the canary.

Read directly off the tree rather than inferred: of 17,925 blanked lines across
`src` and `migrations`, the 68 whose blanked span contains a SQL word are all
comment prose, no line changes length under blanking, and the tables the
assignments resolve to are exactly `accounts` (the two finalizes plus the
introducing migration's back-fill), `bridge_import_queue` and
`notification_preferences`.

### [TODO Architect] unchanged

The CHECK constraint proposal above is still an open architect decision and is
not implemented here. Item 7's rewrite makes the docblock agree with it rather
than contradict it.

## Architect re-review (2026-09-08, round 2) — HELD PENDING FIXES:

Reviewed at commit ea57bb29 via /ce-code-review (correctness, security,
adversarial, testing, maintainability, project-standards, learnings). Eleven
findings survived an independent validation gate; one was rejected and is
recorded under "Dismissed" below. The round-1 items all landed: the writer set
re-enumerated from the tree matches the allow-list exactly, the three ALTER
statements pinned by count are all in the introducing migration, and every
named artifact from the ten items is present in the code.

The hold is that the reading layer those fixes were built on is not sound. It
is the single point of failure for every scan, and it can be switched off by
ordinary source text that already exists in the tree. Verify every item by
mutation in a scratch copy (red on the mutation, green on restore) and state
the probe per item in the re-review note.

### Bundle A: the reader must not be disarmable by ordinary source text

1. **`DOLLAR_QUOTE_RE` must accept only a PostgreSQL dollar-quote tag.**
   `/^\$[^\s$]*\$/` matches an ordinary placeholder pair: `VALUES ($1,$2)`
   opens a span tagged `$1,$`, and `` `${prefix}$1` `` opens one tagged
   `${prefix}$`. Neither ever closes, and `blankLine`'s dollar branch copies
   verbatim, so comment blanking is off from that point to end of file and the
   column-first walk, the table-first walk and the fail-closed arm all go quiet
   together. Both shapes are live today: `hafsql.ts` at the `namePrefix`
   replacement (717 lines left unblanked) and `lib/ipfs-shared.ts`. A planted
   `UPDATE accounts SET ..., updated_at /* note */ = NOW()` below either point
   leaves the suite green. The `!== '{'` guard closes the `$${n}` spelling
   only. Use the real grammar, empty tag or unquoted identifier; consider also
   requiring the tag to recur later in the file, the way `blockCloses` already
   requires a closer. Probes: a fixture carrying `VALUES ($1,$2)` and one
   carrying the `${...}$N` shape must each open no span, and a commented write
   on a LATER line of the same fixture must still be seen.

2. **`LOOKAHEAD_CAP` must exceed the block comments the scanned trees actually
   contain, or go away.** Seventeen block comments in `src` exceed 60 lines and
   the longest is over a thousand, so `blockCloses` reports "not a comment" for
   each and the prose is read as live code. That is what puts `ipfs-shared.ts`
   into the state item 1 describes. The file is already in memory; scanning to
   the end for the closer costs nothing, and the cap's stated purpose is
   already served by the unbounded "no closer anywhere" answer plus the
   must-close-before-the-backtick clause.

3. **The cap, whatever it becomes, must be pinned by fixtures that do not
   derive from it.** `farClose` builds its filler as `LOOKAHEAD_CAP + 5`, so
   setting the constant to 5, 500 or 2000 all leave the suite green. Use
   literal counts, and add the mirror fixture below the intended bound
   asserting the opener IS a comment there, so a move in either direction reds.

4. **Decide and state what happens inside a `DO $$` body.** Blanking is off
   inside a dollar span, and migrations 007 and 017 already carry one. A write
   with a comment in the `updated_at`/`=` gap planted inside 017's body stays
   green while the same write outside it reds. Either keep blanking inside a
   code-shaped body (the opener follows `DO`, `AS`, or `RETURNS ... AS`) and
   keep today's verbatim copy for value bodies, or refuse anonymous `DO` blocks
   in migrations the way `ROUTINE_CREATION_RE` refuses `CREATE FUNCTION`, with
   007 and 017 exempted by exact key. Either is acceptable; say which and why.

5. **Add a terminal-state assertion over the real trees.** Asserting that
   `blankFile` leaves every file in `sources` and `migrations` at
   `{block:false, template:false, dollar:null}` would have caught items 1 and 2
   at authoring time, and is the cheapest standing guard against the next
   reader defect of this class.

### Bundle B: two pattern gaps

6. **A row-assignment left of a plain one must still be counted.**
   `assignmentIndex` returns on the first plain match before the row-target
   loop ever runs, so `SET (email, updated_at) = ($1, NOW()), custody = $2,
   updated_at = NOW()` reports one occurrence, not two. The docblock's claim
   that a line carrying two contributes two is false as written. Collect both
   and return the earlier. Plant the mixed-form line.

7. **`FOR NO KEY UPDATE` must not become a statement head.** The lookbehind
   sees `KEY ` rather than `FOR `, so the clause matches `UPDATE_TARGET_RE` and
   captures a table named `skip`. A planted accounts write carrying
   `FOR NO KEY UPDATE SKIP LOCKED` leaves the file green where the `FOR UPDATE`
   spelling reds. Widen the exclusion, and promote `NOT_A_TABLE` from one
   string to a set that also rejects `skip`, `nowait` and `of`, so a keyword
   head resolves unresolved rather than naming a fiction.

### Bundle C: the rationale a red bar hands the next author

8. **The upsert paragraph still names the wrong barrier.** Round-1 item 6 asked
   for the `POST /signup` pre-check to be credited, and that correction is
   itself wrong: the pre-check answers 409 only for a NULL or `confirmed:`
   token, so a state G row (ARCHITECTURE.md section 6.1: username set, random
   hex token, custody NULL) falls through to the `DO UPDATE` branch. What makes
   that inert is the branch's own column list together with the `custody`
   filters on both lookups. Correct the docblock, `ORDERING_RATIONALE` if it
   repeats the claim, and the matching sentence in this task's implementation
   note.

9. **`accounts.updated_at` has a third reader, and its docblock states the
   opposite invariant.** `collectCompleted` in `jobs/registration-watch.ts`
   uses the column as an announce cursor, and its docblock says the column is
   "an overlay bumped by later password, ORCID, and custody writes too", which
   no writer in `src` does. That comment tells the next author precisely what
   this canary exists to deny. Correct it to say the two finalizes are the only
   writers and that the `seen:accounts` set suppresses a re-announce on a
   re-finalize, and add this reader to the docblock's account of what a third
   writer would affect.

10. **Replace the bare positional anchor.** "the reading above" in KNOWN LIMITS
    points across paragraphs with a generic noun and no stable name riding
    along, which is the rot form rather than the carve-out form. Name what it
    points at. The pre-commit gate does not catch this shape, so it is not
    evidence the line is fine.

### Bundle D: the coverage claim

11. **"The full deletion set (48 features ...) is exercised" is false.**
    Deleting `enclosingQuote`'s escape-skip, and separately `joinedByPlus`'s
    `closedAt === -1` early return, each leaves the whole suite green. Add a
    probe for each, then either re-verify the claim across the full set or
    replace it with what was actually checked. Do not restate the number.

12. **Minor, fold in if convenient.** The `12` and `2` bounds of the
    local-declaration window in `assignmentIndex` are the only unnamed numeric
    bounds in a file that names every other one.

### Also correct the compound entry

The `/ce-compound` entry committed at the same time as this work records the
`$${n}` guard as closing the phantom-dollar-span class. It closed one spelling
of it. Once bundle A lands, correct that entry so the next reader is not told
the class is shut. It is architect-zone, so commit it separately with
`[skip-zone-audit]`, not bundled into the code commit.

### Dismissed, recorded here so they are not re-raised

- Extracting the reading layer into `tests/support/`: dismissed. The span is
  not domain-agnostic (`targetTable` defaults its position through
  `assignmentIndex`, which is built on the `updated_at`-keyed patterns), and
  per-canary private reading cores are the ratified pattern here. The file's
  own reuse paragraph already records why its reach cannot be the shared one.
- Em dashes in the docblock and in the failure-message constant: out of scope
  per the project rule's own wording, which excludes code comments and
  operator-facing output.
- `escapes = !sql`, the non-recursive migration walk, and `backend/scripts/`
  being outside the scan roots: seen and accepted. None is reachable on
  today's tree; a KNOWN LIMITS line for the walk is welcome, not required.

### Not part of this hold

- The `[TODO Architect]` CHECK constraint remains an open architect decision.
  The review confirmed `upgraded_at IS NULL OR upgraded_at >= updated_at` holds
  for every state section 6.1 enumerates. Tracked separately; do not implement
  it under this task.
- The `POST /signup` upsert overwriting a finalized state G row is a real
  pre-existing defect in `routes/auth.ts`, filed as its own task. Out of scope
  here.

## Backend re-review signal (2026-09-09, commits 6bb92bc9, 68541885, da3075d8)

All twelve round-2 items landed, plus the compound-entry correction (6503571f,
architect-zone, committed separately). Every item was verified by mutation in a
tar-copied scratch tree with symlinked `node_modules` and a probe-only vitest
config, red on the mutation and green on restore. `tests/eslint/` is 9 files /
131 tests green; typecheck and lint clean apart from the pre-existing
`author-supersession.ts` warning; the anchor gate exits 0 on every staged diff.

The hold's instruction to verify by mutation is again what made this more than
twelve fixes. Twelve prescribed-probe agents and six unscripted adversarial
lenses ran in isolated copies with independent refutation. The probes confirmed
the items; the lenses found that two of the round's own fixes had introduced
defects, one of them a silent pass of exactly the class the round existed to
close. Those are fixed and pinned in da3075d8. What the lenses found BEYOND this
hold's scope is listed at the end for triage rather than actioned.

### Bundle A

1. **The dollar-quote opener takes PostgreSQL's grammar and must recur.**
   `DOLLAR_QUOTE_RE` is now empty-tag-or-unquoted-identifier, the tag must
   appear again later in the file (`dollarCloses`), and the `$${n}` guard is
   kept beside both. Probes: `VALUES ($1,$2)` and `` `${prefix}$1` `` each open
   no span and a commented write below each is still seen; a grammatical tag
   that never recurs opens nothing; deleting the recurrence conjunct alone
   turns the write invisible and reds two independent arms.

   **Correction to the item as written.** Its probe (c) does not demonstrate
   what it prescribes: with the loose regex restored and `dollarCloses` intact,
   the planted write stays VISIBLE. The two halves overlap on the shape the item
   names. The grammar is load-bearing against a shape the item does not name, a
   placeholder pair that recurs AFTER the write, where the span opens, closes on
   the later recurrence, and spans the write in value mode. Verified both ways.

2. **`LOOKAHEAD_CAP` is gone**; `blockCloses` searches to end of file. Probe: a
   re-introduced 60-line bound reds the literal-count fixture.

   **Correction to a claim this round made.** The first docblock justified the
   removal with "docblocks in the hundreds of lines, one of them over a
   thousand". Measured with the canary's own reader that is 13 comments past 60
   lines with a longest of 159; the thousand-line figure came from a naive grep
   counting `/*` inside strings and regexes. The docblock now carries the
   measured figures and the real causal chain: a `$1..$4` written in the prose
   of `ipfs-shared.ts`'s 65-line docblock is what opened the phantom span in
   item 1. Also worth recording against the item's own wording: with the cap
   restored, all 13 sites still CATCH a planted write. The cap's error direction
   is over-reading comment prose as source, not invisibility; what it caused was
   item 1, not a missed writer.

3. **Cap fixtures use literal counts**, 400 in both directions, and a bounded
   lookahead re-introduced at 5, 60 or 200 reds them.

   **Defect found and fixed in the fixture itself.** The `neverCloses` fixture
   opened its `/*` inside a template, so `blockCloses` answered on the template
   arm and never reached the no-closer-anywhere refusal the fixture's comment
   cited. That refusal is now pinned directly, outside a template, where running
   off the end of the file is the answer; flipping the trailing `return false`
   to `true` reds it.

4. **A dollar span opening after `AS` or `DO` is a CODE body**, comments
   blanked; anywhere else a VALUE, copied verbatim. Both migrations carrying an
   anonymous block wrap ordinary `accounts` DDL, and a comment-gap write planted
   in either now reds. Audited on the real tree: the 16 newly-blanked lines
   inside those two bodies are all `--` prose, no live SQL erased.

   **Two defects this fix introduced, both found by mutation and both fixed.**
   (a) A dollar-quoted literal NESTED inside a code body was read as more body,
   so a `--` belonging to that literal blanked the rest of its line. A live
   `UPDATE accounts ... updated_at = NOW()` beside one was seen by nothing: 21
   of 21 green with a third writer present. A nested tag is now tracked and
   copied verbatim, which PostgreSQL's differing-tag rule makes well defined.
   (b) The body-or-value judgement read the previous line RAW. Both errors are
   silent: a comment after the keyword hides it, so a real routine body reads as
   a value; and SQL prose ending in `as` or `do` supplies one, so a following
   value is blanked as code and its own `--` erases live statement text. The
   walk now reads the blanked lines the same pass has already finished. Probes
   for both, each red when the feature is deleted.

   **Correction to the item as written.** Its clause (c) second half is false: a
   write whose only `updated_at` token sits inside a dollar-quoted VALUE DOES
   red, and should. Values are copied verbatim by design and `statementAt` reads
   span contents into the statement text, so the token matches. That is the
   documented over-match direction, a red bar on a statement that writes
   nothing.

5. **The terminal-state assertion is in place** over both real trees and names
   the file and the span it was left holding.

   **Correction to the item's stated rationale.** It would NOT have caught both
   items at authoring time. Re-introducing the 60-line cap leaves it green,
   structurally rather than incidentally: that cap's error is over-reading, which
   leaves no span open. And reverting `DOLLAR_QUOTE_RE` alone leaves it green
   too, because `dollarCloses` still refuses the phantom span; it reds against
   the true pre-round reader, both halves removed. It caught the round's own
   item-4 (b) defect on the first run, which is the honest evidence for it.

### Bundle B

6. **`assignmentIndex` returns the earlier of the two spellings.** The mixed
   line reports two writes; end to end, column-first tallies 2 for the symbol.
   Restoring the plain-match-first form turns the second write invisible.

7. **`FOR NO KEY UPDATE` is excluded and the locking-clause tails name no
   table.** The two lookbehinds are pinned on the pattern itself, because the
   rejection set would otherwise answer for them and leave either deletion
   green. The set members are pinned by a lock clause SPLIT across lines, where
   no lookbehind can reach the `FOR` and the word after the keyword is captured;
   deleting `skip`, `nowait` or `of` alone reds.

### Bundle C

8. **The upsert paragraph names the fall-through set and the structural
   barrier.** The pre-check answers 409 for exactly two token shapes, so every
   row carrying a random hex token falls through: state E, the branch's intended
   target, and state G. The item named G alone; the set is both. The barrier
   cited is now the stronger of the two available: the branch WRITES a non-NULL
   `verify_token` and both lookups require it NULL, so a row the branch has
   touched is invisible to both until a licensed finalize clears the token. That
   holds whatever the fall-through set is, where the `custody` filters hold only
   while the section 6.1 enumeration does. Both are stated, in that order.

9. **`collectCompleted`'s docblock is corrected**, and the canary's docblock now
   lists that reader among what a third writer would affect. Two further
   corrections beyond the item, both found by tracing rather than restating: the
   column is ALSO written by its own `DEFAULT now()` at INSERT, which is how a
   state G row (never through signup) acquires the value this cursor reads; and
   the query's predicate matches state G too, not only A/B/C/D as it claimed.
   An independent sweep of `backend/src` for comments asserting the opposite
   invariant found no others: `custody.ts` and `signup-verify.ts` both state it
   correctly.

   **A claim of mine, retracted.** The first rewrite said a repeat signup
   re-opens an announced row and re-stamps the marker. Traced, no path does
   that: the pre-check 409s a NULL token, `/verify` keys on a token a finalized
   row lacks, and both stuck resumes skip the finalize UPDATE. What is
   verifiable is the cursor's resolution, whole milliseconds read back through
   `to_timestamp($1/1000)` against a microsecond column, so the newest row in a
   batch stays strictly greater than the cursor derived from it. Narrowed in
   68541885 before this signal.

10. **The positional anchor is replaced** with `{@link blankLine}` and
    `{@link statementAt}`, and the paragraph re-wrapped. A sweep of every
    `above`/`below`/`previous`/`next` in the file against the carve-out found
    no other rot form. Worth recording: the pre-commit gate does NOT detect the
    shape this item fixed, since the article there sat against "reading" rather
    than one of the enumerated structural nouns. The gate's silence was not
    evidence the line was fine.

### Bundle D

11. **Both named features now red when deleted**, each pinned where it is the
    only thing answering: `enclosingQuote`'s escape skip by an escaped backtick
    ahead of the head, without which the read takes the following apostrophe as
    its delimiter and stops short of the assignment; `joinedByPlus`'s
    unterminated-read guard by a continuation line the whole-line read would
    take for the join.

    **The count claim is not restated.** What was actually checked: an
    exhaustive one-at-a-time deletion sweep across the reader and the patterns.
    It found roughly thirty deletions that leave the suite green. The subset
    belonging to features this round ADDED is now pinned and each verified to
    red: `blockCloses`'s no-closer default, `dollarCloses`, `opensCodeBody`'s
    previous-line walk and its VALUE default, all three clauses of
    `DOLLAR_CODE_BODY_RE`, the nested-tag branch, the `(sql || template)` gate
    in its widening direction, and the row-assignment ordering. The remainder is
    pre-existing dead coverage and is listed for triage below rather than
    swept here.

12. **The window bounds.** `LOCAL_DECLARATION_BEFORE` is named and pinned in
    both directions. The forward bound is REMOVED rather than named: the
    declaration pattern's own `\s*` admits any run of whitespace, so any fixed
    number was either arbitrary or wrong, and `const updated_at   = ...` escaped
    the exclusion at 2. Reading forward to the end of the text is safe because a
    match still requires the keyword within the bound above. Re-introducing a
    forward bound reds. One honest note: the declaration pattern's `:`
    alternative is unreachable from this call site, since the assignment pattern
    rejects `updated_at:` a step earlier, so no fixture here can pin it; that is
    recorded in the comment rather than papered over with a contrived one.

### [TODO Architect] Surfaced by the adversarial pass, NOT acted on

Six lenses ran with no checklist against an isolated copy, each claim replayed
by an independent refuter. Eighteen survived refutation. These are outside this
hold and are listed for triage, not fixed:

- A quoted TypeScript string is copied verbatim as a VALUE, so SQL in the
  repo's one-line `'UPDATE accounts SET ...'` spelling is never comment-blanked
  and the whole comment-gap class round 1 closed is open inside it. Highest
  severity of the set; the root cause is pre-existing, not from this round.
- A data-modifying CTE gives the fail-closed arm a REACHING non-accounts head,
  so an unreadable `accounts` write resolves to the CTE's table rather than
  reding.
- `.mts` / `.cts` modules under `src/` are compiled, emitted and shipped, but
  `sourcesUnder` filters on `.ts` and never walks them. Two lenses converged.
- `ALTER TABLE IF EXISTS accounts` slips the ALTER pin, and the repo's own
  mandatory idempotency house style is the bypass. Two lenses converged.
- Migration 016's licensed back-fill is pinned by COUNT, not by value: editing
  it to stamp `NOW()` keeps the tally at 1.
- An `ALTER TABLE accounts` statement truncated at `LITERAL_CAP` has no
  read-whole guard; that arm iterates the statement pattern only.
- `targetTable`'s documented "the walk does not keep climbing" is pinned by no
  fixture, and roughly thirty other pre-existing feature deletions leave the
  suite green (`ALTER_ACCOUNTS_RE` entirely, the `i` flag at four call sites,
  `statementAt`'s own escape skip, two `enclosingQuote` features).
- Previously dismissed in round 1 and re-raised with a planted proof:
  `backend/scripts/` outside the scan roots (it ships in the image and opens a
  pool against `APP_DATABASE_URL`), the non-recursive migration walk reached by
  a psql `\ir` include, and `COPY accounts` with no column list.

## Architect re-review (2026-09-09, round 3) — HELD PENDING FIXES:

Reviewed at commits 6bb92bc9, 68541885, da3075d8 (and the architect-zone
compound correction 6503571f) via /ce-code-review across eight lenses:
correctness, security, adversarial, testing, maintainability, project-standards,
learnings, and the orchestrator's own read. All four commits are ancestors of
HEAD; no orphan SHAs. Thirteen findings survived merge, ten of them introduced
by this round.

The round-2 hold LANDED, and that was verified rather than taken from the signal
block. The exact round-2 shape was replanted — a block comment past sixty lines
whose prose carries `VALUES ($1,$2)`, followed by a write with a comment in the
`updated_at`/`=` gap — and both writer walks red. Every feature this round added
was mutation-checked to red on its own deletion. The round-2 self-referential
pinning defect (a fixture whose filler derived from the constant it pinned) did
not recur. The measured "thirteen block comments past sixty lines, longest 159"
is exact, re-derived independently through the reader's own state machine.

The hold is that the round introduced two NEW silent passes of the very class it
existed to close, plus a third reader divergence that is live on today's tree.
Both silent passes were demonstrated by mutation with red/green controls in an
isolated copy, not reasoned about:

  - A third writer planted in `routes/settings.ts` — a settings touch, the shape
    the file's own docblock names as the most plausible third writer — whose
    statement carries the characters `const updated_at =` inside an ordinary SQL
    string value leaves the suite 21/21 GREEN. Deleting only that value reds two
    walks.
  - A migration spelling an anonymous block that EXECUTEs a nested dollar-quoted
    literal, with a comment in the `updated_at`/`=` gap inside that literal,
    leaves the suite 21/21 GREEN while bumping the marker on EVERY finalized
    row. Deleting only the comment reds two walks.

Verify every item by mutation in a scratch copy (red on the mutation, green on
restore) and state the probe per item in the re-review note.

### Bundle A: the reader must be sound before anything else is worth checking

1. **The local-declaration exclusion must not scan forward.** Removing the
   forward bound in `assignmentIndex` did not make the exclusion match-scoped,
   it made it unbounded: `TYPESCRIPT_LOCAL_RE.test()` is unanchored, so the
   pattern matches anywhere in the slice, and a `const updated_at =` occurring
   LATER in the same text vetoes a real earlier write. The `LOCAL_DECLARATION_BEFORE`
   docblock asserts the opposite ("a match there still requires the keyword to
   sit within the bound above it"); that claim is false as written, and it is
   the claim that made the removal look safe. This is the exact veto direction
   the inline comment beside the call already forbids. Anchor the test at the
   match rather than bounding it forward — a keyword pattern ending in `$`
   tested against the slice that ENDS at the match position satisfies both the
   arbitrary-whitespace case the removal was chasing and the veto case it
   opened. Verified: that form catches the planted writer on both walks, keeps
   this round's own multi-space fixture green with no rewrite, and leaves
   `tests/eslint/` at 131/131 on a clean tree. Probe: plant a write whose
   statement carries the declaration characters AFTER it; it must red. Four
   lenses raised this independently.

2. **A nested dollar-quoted value inside a code body is an open comment gap.**
   The `dollarNested` branch added this round copies every character of a nested
   literal through verbatim, comments included. That is correct for a value
   PostgreSQL treats as data, but a literal the surrounding body EXECUTEs is
   source, and the comment-gap class is fully open inside it. Decide and state
   which it is: either blank comments inside a nested span whose body executes
   it, or refuse such a span by reporting it as an unresolved site so it reds.
   Either is acceptable; say which and why. Note that the KNOWN LIMITS
   paragraph currently states this residual BACKWARDS (it claims the nested
   value's comments ARE blanked), so the prose and the code disagree about the
   direction of the same gap.

3. **`statementAt` must make the same opener judgement `blankLine` makes.** The
   grammar fix reached both readers because `DOLLAR_QUOTE_RE` is shared, but the
   recurrence requirement (`dollarCloses`) and the `${` exclusion are applied
   only in `blankLine`. `statementAt` commits to a span on a bare match. This is
   not latent: the `$${n}` placeholder idiom occurs 151 times under `src`, and
   `statementAt` opens a phantom span on each one. Give both call sites one
   shared opener helper so the two readers cannot diverge again, rather than
   copying the two guards across. Probe: delete either guard from the shared
   helper and both readers must red.

### Bundle B: three claims the code contradicts

This is the same defect class as round-2 item 9, held then for the same reason:
a docblock that tells the next author the opposite of what the code does is
worse than no docblock, because it is what they will act on.

4. **The KNOWN LIMITS bullet on the two dollar-opener judgements names two
   residuals this same commit removed, and inverts a third.** `opensCodeBody`
   reads `blanked[i]`, never a raw line, so the "previous non-blank line is read
   RAW" clause describes the pre-fix code. The nested-value clause claims a
   comment marker in that value IS blanked; it is copied verbatim, which is
   item 2. Replace the bullet with the residuals that actually survive.

5. **The barrier paragraph's premise is false.** It states that the only
   statements clearing `verify_token` are the two finalizes. The settings
   email-verify route clears it too, with no custody or username scoping and
   without naming the marker. The paragraph builds its "structural, holds for
   whatever the fall-through set turns out to be" claim on that premise, so the
   claim does not survive it. Correct the paragraph, not the code: name the
   third clearer and re-rank the two terms, since what actually keeps a
   fall-through row out of both lookups is the custody filter that only a
   finalize writes.

6. **The state G announce claim in `collectCompleted`'s docblock overclaims.**
   A state G row takes its marker from the INSERT-time default and nothing moves
   it when the token clears, so the row becomes predicate-eligible carrying a
   frozen timestamp. Any other completed registration announced in between
   advances the cursor past it permanently. It is therefore NOT "announced here
   like any other completed registration". Correct the docblock, or cursor the
   completed class on something that moves at verification; the docblock
   correction alone discharges this item. Two lenses raised it independently.

### Bundle C: fold in

7. **The dollar-value branch has no backtick escape.** The `opaque` branch this
   round moved above it clears the span on a backtick with the rationale that a
   value cannot contain one; the value branch never updates the template flag,
   so a span opened inside a template desyncs it. Probe-verified as a silent
   pass in a `src/lib` file. Guarding on the template flag leaves `.sql`
   migrations untouched.

8. **Two sibling comments state the same measurement with different numbers.**
   One says thirteen block comments past sixty lines with a longest of 159; the
   other says seventeen were read as live source. Thirteen is the measured
   figure; seventeen is the stale count from the round-2 hold text, which was
   itself derived from a naive grep. Make them agree or drop the number.

9. **The `DEFAULT now()` KNOWN LIMITS bullet gives a reason the file's own state
   G paragraph contradicts.** Its conclusion (not a hazard, not scanned for) is
   right; "a row being inserted is neither finalized nor upgraded yet" is not the
   reason, because a state G row reaches the finalized-looking predicate without
   a finalize ever running. Replace the reason with the custody one.

10. **Three near-duplicate fixture arrays differ only in one element.** Hoist a
    helper so the varied axis is what a reader sees.

### Dismissed, recorded here so they are not re-raised

- The two positional anchors flagged at the nested-tag branch ("the body's
  terminator was tested above") and beside the split lock-clause assertion ("the
  keyword-tail rejection below"): dismissed. Both name what they point at, which
  is the carve-out's durable form, not the bare positional form the rule
  targets. Naming the constant in the second one is welcome, not required.
- `DO LANGUAGE plpgsql $$` not being read as a code body: dismissed at this
  round. Real, but no site in either tree spells it, and the fixture would pin a
  shape the tree does not write. Revisit if such a body lands.
- Extracting the reading layer into `tests/support/`: still dismissed, on the
  round-2 grounds. Item 3 asks for ONE shared opener helper INSIDE this file,
  which is not that extraction.
- Adding or expanding logging anywhere in this work: out of scope per the
  project's standing posture.

### Not part of this hold

- The `upgraded_at IS NULL OR upgraded_at >= updated_at` CHECK constraint
  remains an open architect decision, unchanged since round 2. The review
  re-confirmed it holds for every state ARCHITECTURE.md section 6.1 enumerates.
  Do not implement it under this task.
- `ALTER TABLE IF EXISTS accounts` slipping the ALTER pin, the scan roots
  excluding `backend/scripts` and every non-`.ts` extension, and
  `collectCompleted` advancing its cursor past rows an indeterminate Redis read
  drops: all three are real and all three are pre-existing rather than
  introduced here. Filed as their own tasks; out of scope for this hold.

## Backend re-review signal (2026-09-14, commit 664be496)

All ten round-3 items landed. Every item was verified by mutation in a
tar-copied scratch tree with symlinked `node_modules`, red on the mutation and
green on restore; sixteen feature-deletion probes ran in parallel isolated
copies and every one of them reds. `tests/eslint/` is 9 files / 131 tests green;
typecheck clean; lint clean apart from the pre-existing `author-supersession.ts`
warning.

Both silent passes the hold demonstrated were REPRODUCED first, as red/green
controls, before anything was changed: the settings writer masked by a value
carrying the declaration characters (21/21 green, and 2 walks red on deleting
only that value), and the migration whose nested literal carries a comment in
the marker's own token gap (21/21 green, 2 walks red on deleting only the
comment). Both now red.

The round's own adversarial pass is again what made this more than ten fixes.
Eight unscripted lenses ran in isolated copies with independent refutation, and
they found that this round's fixes had opened SIX new silent passes, in two
classes, both of exactly the kind the round existed to close. Those are fixed
and pinned. Three of the six had their refuters killed by a session rate limit;
those were re-verified by hand rather than counted either way.

### Bundle A

1. **The local-declaration exclusion no longer scans forward.**
   `TYPESCRIPT_LOCAL_RE` is now an end-anchored keyword, tested against the
   slice that STOPS at the column. Probe: a write whose statement carries
   `const updated_at =` in an ordinary string value AFTER it; red on both walks,
   and pinned at the predicate and end to end. The backward bound is kept and
   pinned separately (a declaration spaced past it reads as a write, which is a
   red bar on a line that writes nothing).

   **Beyond the item.** The whitespace class also had to exclude a NEWLINE.
   `writesColumn` reads a statement with its lines joined, so a plain `\s+`
   let a word ending one line veto a write opening the next; probed as
   `UPDATE accounts SET const` / `updated_at = NOW()`, which the table-first
   walk missed while the column-first walk still red-barred it. The two-walk
   design held, but the veto was real and is closed.

2. **A nested dollar-quoted literal is read as the source it is.** Decided and
   stated: the body EXECUTEs the literal, so its comments are blanked like the
   body's own. Two bounds make that safe and both are pinned - a `--` blanks
   only to the innermost open tag, and a `/*` is a comment only if it closes
   before that tag. Probes: the hold's own migration; the same with the gap
   spelled `--` across a line; an unterminated opener whose `*/` sits further
   down the file.

3. **One shared opener helper.** `dollarOpenerAt` carries the grammar, the
   interpolation exclusion and the recurrence requirement, and `statementAt`
   and `blankLine` both ask through it. Each condition is pinned where it is
   the only one answering; dropping any one reds a bar.

   **Correction to the item as written.** Its premise does not hold. "This is
   not latent: the `$${n}` placeholder idiom occurs 151 times under `src`, and
   `statementAt` opens a phantom span on each one" - instrumenting the readers
   as they are actually called, `statementAt` reaches an unquoted `$` three to
   four times across both trees and NONE of those is a grammar match, so the
   divergence fires zero times today. The idiom is frequent (171 raw
   occurrences by `grep -o`), but `statementAt` only ever reads statements it is
   pointed at: accounts statements, and heads above `updated_at` assignments.
   The fix is kept because the shapes that produce a divergence are ordinary
   code, and the docblock now says latent rather than live.

### Bundle B

4. The KNOWN LIMITS bullet on the dollar-opener judgements is replaced with the
   residuals that survive: the blanked-text reading is stated correctly, a
   string VALUE ending in a keyword is named as what can still supply one, and
   `DO LANGUAGE plpgsql $$` is named as the clause that hides one. The nested
   case has its own bullet and states the direction the code actually takes.

5. The barrier paragraph is corrected rather than the code. The settings
   email-verify route in `routes/settings.ts` is named as the third statement
   that clears `verify_token`, the token gate is re-ranked as a delay rather
   than a barrier, and `custody` plus the marker are named as the terms that
   actually hold - `custody` because no INSERT names the column, so a state G
   row carries NULL against both `= 'light'` and `= 'self'`.

6. `collectCompleted`'s docblock is corrected. State G is no longer claimed to
   be announced like any other completed registration: the row takes its marker
   from the INSERT-time default, nothing moves it when the token clears, and the
   cursor only advances, so any other completed registration announced in
   between carries it past for good. The docblock correction alone, per the
   item; the cursor is unchanged.

### Bundle C

7. The dollar branch honours a backslash escape and closes on an unescaped
   backtick when the template flag is set. Probed via the flag's downstream
   effect (an inverted flag reads an ordinary decrement as a comment and blanks
   the write beside it), because the flag alone is not observable. The escape
   arm needed a second fixture: the first one did not discriminate and its
   deletion probe stayed green.

8. Seventeen corrected to thirteen, re-derived independently through the
   reader's own state machine rather than taken from the hold: 13 block comments
   past sixty lines, longest 159, in `hafsql.ts`. The naive grep that produced
   seventeen was reproduced too, which is what confirms which number is which.

9. The `DEFAULT now()` bullet's reason is replaced with the custody one, and
   the reason it is NOT is stated explicitly, since a state G row reaches the
   finalized-looking predicate with no finalize behind it.

10. The three near-duplicate fixture arrays are hoisted behind a helper whose
    parameter is the varied axis.

### The six silent passes this round opened, and closed

Found by three independent lenses converging, each demonstrated with a
one-character control, each re-verified before being acted on.

- **A code span tracked no string quoting.** A `--` or `/*` that is a CHARACTER
  of a string value inside an EXECUTEd literal was read as a comment, blanking
  the live `updated_at = NOW()` beside it. The shape is an ordinary back-fill:
  `regexp_replace(institution, '\s*--\s*', ' - ', 'g')`, or
  `replace(institution, '/*', '')`. Closed by tracking quotes at every depth,
  which is what the body's own branch already did.
- **The open tags were a single tag, not a stack.** A literal nested inside the
  nested literal reopened the same gap one level down. Closed by making the
  state a stack; the body-versus-value judgement is still made once, at the
  outermost opener.
- **The interpolation exclusion was applied to migrations.** `$${...}$$` is the
  placeholder-builder idiom in a TypeScript template and an ordinary
  dollar-quoted literal in a migration - one whose content begins with a brace,
  which is how an array literal is spelled and the usual reason to reach for
  dollar quoting. Refusing it in a `.sql` file ended the statement read at a `;`
  that was one of the literal's own characters, which hid an
  `ALTER COLUMN updated_at TYPE ... USING` rewrite, a MERGE insert list naming
  the column, and a plain `UPDATE ... SET updated_at = NOW()`. The exclusion is
  now dialect-gated, and the dialect travels WITH the blanked text
  (`BlankedCode`) rather than being passed beside it, so the two readers cannot
  be handed different answers. That is the same defect shape as item 3, one
  layer up: a caller that has to remember a flag is a caller that can pass the
  wrong one.

### [TODO Architect] Surfaced by the adversarial pass, NOT acted on

All pre-existing, none introduced by this round, none in this hold's scope.
Listed for triage rather than filed, per the project's review-findings rule.
Each was demonstrated green-with-the-write in an isolated copy.

FOUR OF THESE RE-DISCOVER ENTRIES THAT ARE STILL OPEN in the earlier
`[TODO Architect]` list in this same file, found again by lenses that had no
sight of it. Triage them together rather than twice: the one-line quoted-string
spelling, `COPY accounts` with no column list, `ALTER TABLE IF EXISTS accounts`,
and the unscanned migration subdirectory. That two independent passes reached
the same four is evidence about severity, not new findings. The other four below
are new.

- The routine/trigger arms run over `migrations` only, never over `sources`, so
  trigger and trigger-function DDL spelled in a TypeScript file is refused by
  nothing. Ranked highest of these: the routine arm is the sole catcher of a
  PL/pgSQL `NEW.updated_at := now()`.
- A trigger bound as `ON public . accounts` (spaces around the dot) evades
  `BOUND_TO_ACCOUNTS_RE`, so the no-exemption refusal never fires.
- `COPY accounts FROM stdin` with NO column list writes every column and is
  read as writing none.
- A rebuild-and-rename table swap: every write names `accounts_rebuilt` and the
  final `RENAME TO accounts` is read by no pattern.
- A one-line SQL statement held in an ordinary single-quoted TypeScript string
  keeps its comments live, because values are not blanked - so a comment in the
  column/`=` gap silences both writer scans there.
- An unescaped backtick inside an ordinary single-quoted TypeScript string
  toggles the reader's `template` flag.
- Two already-filed ones re-confirmed live: `ALTER TABLE IF EXISTS accounts`
  slipping the ALTER pin, and a back-fill in a `migrations/` SUBDIRECTORY going
  unscanned.

## Architect re-review (2026-09-14, round 4) — HELD PENDING FIXES:

Reviewed at commit 664be496 (with the task-file commits 989d5823 and 1e104f4a)
via /ce-code-review across seven lenses: correctness, project-standards,
security, adversarial in-process, testing, maintainability, learnings. All three
commits are ancestors of HEAD; no orphan SHAs. Eight findings went to an
independent validation batch and all eight validated; five more were suppressed
at anchor 50 and two of those are dismissed below.

The round-3 hold LANDED, and that was verified from the tree rather than taken
from the signal block: each of the ten items is present as the artifact it
names, and both silent passes the hold demonstrated were replanted and both red
(the settings writer masked by a value carrying the declaration characters, and
the migration whose nested literal carries a comment in the marker's own token
gap), with the plain third writer as a red control. Fourteen of the round's
feature deletions red on their own.

The hold is that the round left one live silent pass of the class this file
exists to close, opened a second, and left three of its own features unpinned in
the silent direction. Every one of those was demonstrated by mutation with a
red/green control in an isolated copy, not reasoned about. Verify every item the
same way and state the probe per item in the re-review note.

### Bundle A: a statement read must not lend a table it does not own

1. **A head inside an open dollar-quoted span must not lend its table.**
   `statementAt` tracks spans only from its own starting position: it asks
   whether a `$` OPENS a span and never whether it CLOSES the one its head
   already sits in, and unlike `blankLine` it carries no tag stack. So a head
   inside `$q$...$q$` reads that literal's own closing tag as an opener (the
   grammar matches, no brace follows, the tag recurs), swallows the `;` that
   really ends the statement, and runs on to the next line. `targetTable` then
   sees a statement that REACHES the write below it and hands over a plausible
   other table, so the fail-closed arm never fires. Probe: a migration whose
   `DO` block spells two `EXECUTE format($q$...$q$, ...)` calls sharing the tag,
   the second naming its table with `%I` and stamping the marker on every light
   row — 21/21 green; delete only the first EXECUTE and the resolve arm reds.
   The same shape with a quoted identifier instead of `%I`, the same at top
   level between two `DO` blocks, and the same inside a `.ts` template are all
   green. KNOWN LIMITS bullet 1 is part of the fix, not a separate item: its
   claim that such an assignment "reds under the fail-closed arm instead, since
   no readable head reaches it, and that backstop is what the limit rests on" is
   what this probe falsifies.

   **The same invariant in the other dialect, verified separately.** Inside a
   template `statementAt` carries its quoted-value state ACROSS lines while
   `blankLine` resets it per line, so one unescaped quote inside a dollar value
   or inside an interpolated expression leaves the read open past the template's
   closing backtick and the head lends its table the same way. Probes:
   `UPDATE sessions SET note = $$it's$$ WHERE id = $1`, and the hand-escaping
   idiom `SET note = '${note.replace(/'/g, "''")}'`, each placed above an
   `UPDATE "accounts" SET updated_at = NOW()` — 21/21 green, and the
   balanced-quote control reds. Neither shape is in the tree today; both are
   ordinary code.

   The construct is the implementer's choice and the invariant is what is held:
   a read that cannot reach its own terminator must not resolve a table. Giving
   the read the enclosing span as a terminator and resetting value state per
   line the way the blanking reader does is one shape; refusing any head that
   sits inside an open span, or whose read crossed a line it could not balance,
   as {@link UNRESOLVED_TABLE} is the other, and costs a red bar on statements
   EXECUTEd from a literal, which is the tolerable direction. Say which and why.

2. **Every backtick arm in `blankLine` must be dialect-gated.** The close added
   this round is gated on `template`, and the inline comment says that leaves a
   `.sql` migration untouched. It does not: the opaque branch and the main path
   both toggle `template` on ANY backtick with no `sql` gate, so a migration
   sets the flag from a backtick inside an ordinary quoted value. Probe: a
   migration whose first statement writes `'tick `'` and whose second holds
   `$$a ` -- b$$` before `updated_at = NOW()` — 21/21 green with a live writer;
   remove the first backtick and both migration walks red. The pre-existing arm
   has the same root and is in scope here rather than deferred, because this
   round is what made the flag reachable from inside a span: a backtick PAIR
   inside a `RAISE NOTICE` string clears the tag stack, `END $$` is then read as
   an opener rather than a close, `END ` is not a body keyword so a VALUE span
   opens, and a gapped `UPDATE accounts ... updated_at /* ... */ = NOW()`
   between two `DO` blocks passes both walks with the end-state assertion clean
   (21/21 green; backticks removed, 2 walks red). Gate all three arms; pin both
   probes, each asserting the write is seen AND that the reader ends with an
   empty stack.

3. **One closer search, not two.** `blockClosesInSpan` is `blockCloses` with the
   boundary expression swapped, and the copy already drifted: the call site it
   replaced passed `template`, so a `/*` inside a body that sits in a template
   used to stop at the template's backtick and now runs past it, blanking the
   closer and every line up to whatever `*/` it finds. Give the one function a
   boundary set — the tag, and inside a template the backtick — and delete the
   copy. The drift is the reason the duplication is held rather than noted: the
   precondition is doubly malformed source and no such body is in the tree, so
   the bound alone would be a P3, but a second copy of a search this file
   depends on is how the next one goes missing.

### Bundle B: the features this round added must be pinned

4. **Seven of the round's features delete green, and three of those admit an
   ordinary writer under the mutant.** The file's own contract is that each
   planted line answers to exactly one feature, and the signal says sixteen
   deletion probes all red; on the committed tree 14 red and 7 do not. Pin each,
   in the shape that passes under its mutant:
   - the `$` end anchor of `TYPESCRIPT_LOCAL_RE` — `SET note = 'let ',
     updated_at = NOW()` must read as a write (and end to end through both
     walks);
   - the `if (dollar.length === 0)` guard before `dollarCode` is cleared — a
     gapped write in a body AFTER a nested literal closes;
   - the tag stack, in both directions (pushing a nested tag, and popping to the
     enclosing one) — a gapped top-level write between two `DO` blocks, with an
     empty-stack assertion beside it;
   - `opensCodeBody` reading the current line's BLANKED text — `DO /* anonymous
     */ $$` with a gapped write in the body, expecting the migration key from a
     writer walk rather than only from the routine arm;
   - the two `blankLine` call sites of the opener helper — a `.sql` fixture with
     a top-level non-recurring `$tag$` ahead of a gapped write, asserting the
     write is seen and the reader ends with an empty stack.

   Then re-run the deletion set and correct the count the signal states. Do not
   restate a number you have not re-derived.

### Bundle C: three claims the routes or the reader contradict

This is the same class held in rounds 2 and 3, and the reason is unchanged: a
docblock that tells the next author the opposite of what the code does is what
they will act on.

5. **The barrier paragraph's worked example is a transition no route
   produces.** It has a finalized light account acquiring a settings-registered
   email token and having it cleared by the third clearer, then re-entering the
   `/confirm` window for the length of the window. That row — `custody` light,
   `username` set, a random hex token — is not in ARCHITECTURE.md section 6.1,
   and no route makes it: the settings add flow INSERTs only when the username
   has NO row, so every finalized row takes the change flow, which writes
   `pending_email_token` and never names `verify_token`; the clearer in
   `routes/settings.ts` is keyed on `verify_token`, which a finalized light row
   carries as NULL; and nothing puts a hex token back on a finalized row (the
   signup upsert answers 409 on a NULL token, the resend route returns before
   its UPDATE, the verify-link handler selects by a token the row must already
   hold). So that clearer reaches state G alone. Five lenses raised this
   independently. Rewrite the example around the row the statement actually
   reaches, keep the conclusion about the upsert branch and the clearer both
   leaving the marker alone, and apply the same correction to the matching
   sentence in this task's implementation note.

6. **The KNOWN LIMITS example for a value supplying the body keyword cannot
   match the pattern it cites.** `SET note = 'stored exactly as'` ends in a
   quote and the keyword test is end-anchored, so it is false on that line; only
   the form whose quote is left open matches, which is the separate multi-line
   value residual already listed. Fix the example or fold the clause into that
   bullet, and add a self-test for the keyword pattern beside the clause-by-
   clause pins so the next non-reproducing example fails instead of reading
   well.

7. **The opener helper's docblock overclaims which readers reach an opener.**
   It says no read over either tree reaches a dollar opener today. The blanking
   reader reaches two: migrations 007 and 017 each spell `DO $$`, and this
   file's own fixture comment says so. What is true, and what the
   latent-not-live conclusion rests on, is that no STATEMENT read reaches a
   grammatical opener. Scope the sentence to that reader.

### Dismissed, recorded here so they are not re-raised

- Tying the multi-space declaration fixture's `' '.repeat(20)` to
  `LOCAL_DECLARATION_BEFORE`: dismissed, and it is the shape round 2 item 3
  forbade. A fixture whose filler derives from the constant it pins moves with
  that constant and pins nothing; literal counts are the ratified form here.
- "the source rules below" as a bare positional anchor: dismissed. It names what
  it points at within its own paragraph, which is the carve-out's durable form.
- `BlankedCode.sql` being an optional expando the type does not require: seen and
  accepted. No derived array exists, and a required field would be welcome, not
  required.
- The escape and backtick-close arms now being copied three and two times across
  `blankLine`: not held on its own. Item 2 is where the gate goes missing, so
  collapsing the arms while landing that gate is welcome; the duplication is not
  a separate deliverable.
- Adding or expanding logging, and extracting the reading layer into
  `tests/support/`: both still out of scope on the standing grounds.

### Not part of this hold

- The `upgraded_at IS NULL OR upgraded_at >= updated_at` CHECK constraint
  remains an open architect decision, unchanged since round 2.
- `routes/settings.ts` clearing `verify_token` on whatever row carries the
  token, which lets a signup row's own token brick that row into a
  `verify_token` NULL / `username` NULL pair section 6.1 does not enumerate:
  real, pre-existing, and filed as its own task. Out of scope here. The canary's
  prose may name the clearer, as item 5 requires, without waiting on that fix.
- The `[TODO Architect]` residual list this round appended is still open triage.
  Two of its entries have since been filed as their own tasks (the `ALTER TABLE
  IF EXISTS` pin, now in review, and the spaced schema dot in the trigger-bind
  clause); the rest stay listed there. Do not fold any of them into this hold.
- Two count nits for the signal block rather than the code: the statement reader
  reaches an unquoted `$` twice over both trees, not "three to four", and the
  block-comment census does not state its measure (thirteen past sixty with a
  longest of 159 by closer-minus-opener; fifteen and 160 counting inclusively).
  Correct them when the next signal is written; neither is a code change.

## Backend re-review signal (2026-09-15, commits b901abe7, a28b3a69)

All seven round-4 items landed. Every one was verified by MUTATION in a fresh
tar-copied scratch tree with symlinked `node_modules`, red on the mutation and
green on restore, never by reasoning; the probe is stated per item below. Each
of the round's own fixes was then DELETED individually and confirmed to red its
own pin, so nothing here is fixed-but-unpinned.

The canary is 24 tests (was 21); `tests/eslint/` is 9 files green; typecheck
clean; lint clean. The pre-commit anchor gate reports zero hits across the
added lines, with three control lines confirming the check is not vacuous.

### Bundle A

1. **A head inside an open span no longer lends its table.** The hold's probe
   reproduced first, as a red/green control, before anything changed: a
   migration whose `DO` block spells two `EXECUTE format($q$...$q$, ...)` calls
   sharing the tag, the second stamping the marker on every light row via `%I` —
   21/21 green with the live writer, and the resolve arm red on deleting only
   the first EXECUTE. The quoted-identifier variant reproduced identically. So
   did both template shapes: `$$it's$$` above an `UPDATE "accounts"` write, and
   the hand-escaping `replace(/'/g, "''")` idiom above the same. Four
   reproductions, four flipping controls.

   **Shape chosen, and why.** The hold offered two: read correctly, or refuse
   any head sitting inside an open span. Read correctly, because the choice is
   not the one it looks like. Both options need the SAME thing — the span stack
   at the head's exact POSITION, not at its line start, since the offending head
   sits mid-line inside a literal that opened earlier on that line. Once the read
   has that, refusing costs more than it buys: it retires the column-first walk
   inside every `DO` body, which is precisely where round 3's gap-closing work
   lives (the nested-literal quoting, the `--` bounded by the innermost tag, the
   block marker held as data). So `blankLine` now RECORDS every span it opens and
   closes (`SpanEvent`, carried on `BlankedCode` beside `sql` for the same reason
   `sql` is carried there), and `statementAt` REPLAYS them from
   `spanStackAt(code, line, col)`.

   Replaying rather than re-judging is the load-bearing part, and the adversarial
   trace is what showed why: sharing `dollarOpenerAt` between the two readers,
   which is what round 3 landed, does not help here, because the QUESTION is
   wrong. From an empty stack the only question askable at a `$` is "does a span
   OPEN here", and a literal's own CLOSING tag answers yes to it — grammatical,
   uninterpolated, and recurring as the next literal's opener, so the recurrence
   requirement CONFIRMS the phantom instead of refusing it.

   Depth is RELATIVE to the head, which is what keeps the in-body reads: at the
   head's own depth its `;` and quotes terminate normally, deeper is a nested
   value with terminators suspended, and shallower means the span carrying the
   head closed first — the read stops there reporting no terminator, and
   `targetTable` answers `UNRESOLVED_TABLE`. Pinned in both directions: the
   shared-tag fixture resolves to nothing, and `EXECUTE $q$UPDATE accounts ...
   updated_at /* clock */ = NOW();$q$;` is still seen by BOTH walks.

   **The other dialect, fixed separately.** `statementAt`'s quoted-value state
   now resets PER LINE, the way `blankLine` resets it. Both template probes red
   under it. The residual it costs is the one the blanking reader already
   carries, and the KNOWN LIMITS bullet now says so for both readers rather than
   one. The single-line-value pin's comment claimed the read "carries string
   state across lines"; that sentence was this round's own to correct and is.

   KNOWN LIMITS bullet 1 is corrected as part of the item, per the hold. Its
   claim that a dynamically-named target "reds under the fail-closed arm
   instead, since no readable head reaches it" was not a property of the SHAPE,
   it was a property of the READ, and the read did not have it. The bullet now
   says which.

2. **All three backtick arms are dialect-gated.** Both probes reproduced first:
   a migration whose first statement writes `'tick ` mark'` and whose second
   holds `$$a ` -- b$$` before a live write (21/21 green; the first backtick
   removed, both migration walks red), and the `RAISE NOTICE` backtick PAIR that
   clears the tag stack so `END $$` reads as an opener (21/21 green WITH the
   end-state assertion clean; backticks removed, two walks red). `const ticks =
   !sql` now gates the opaque-branch arm, the dollar-branch arm and the main
   path. Both probes red, and both are pinned with the end-state assertion
   beside them, because a clean end state is exactly what let the second one
   through.

3. **One closer search.** `blockClosesInSpan` is deleted; `blockCloses` takes a
   BOUNDARY SET and the nearest boundary wins. The drift the hold named is real
   and is now demonstrated rather than described: a `/*` inside a body that sits
   in a template, bounded by the tag alone, runs past the template's backtick to
   a `*/` two lines down and blanks the accounts write between them. Pinned at
   the predicate in both spellings and end to end.

### Bundle B

4. **All seven features the hold named are pinned, each in the shape that
   passes under its mutant.** Verified by deleting each one and watching its own
   pin red: the `$` end anchor of `TYPESCRIPT_LOCAL_RE` (`SET note = 'let ',
   updated_at = NOW()`, whose twelve characters before the column carry `let `
   without ending in it, so only the anchor separates a write from a veto); the
   `if (dollar.length === 0)` guard, via a gapped write in a body AFTER a nested
   literal closes; the tag stack in BOTH directions, via a gapped top-level
   write between two `DO` blocks with an empty-stack assertion beside it (push
   probed by making a nested tag REPLACE, pop by making a close empty the
   stack); `opensCodeBody` reading the BLANKED text, via `DO /* anonymous */ $$`
   with the migration key expected from the writer walks and the routine arm
   asserted to find nothing; and BOTH `blankLine` call sites of the opener
   helper, each with a `$tag$` spelled once — the main-path site reported by the
   write going unseen, the nested site by the end state.

   **One of the seven is unpinnable by construction, and is reported as that
   rather than padded with a fixture that pins nothing.** The `template &&`
   conjunct on the dollar-branch backtick arm cannot be discriminated: the
   main-path opener is gated on `(sql || template)`, so a `.ts` file can only be
   inside a dollar span while `template` is true, and `ticks` refuses the arm
   outright in a `.sql` file. Deleting the conjunct changes no observable
   behaviour on either tree or on any fixture in the file. Checked rather than
   argued: an assertion that throws when the arm is reached with `template`
   false ran over both trees and all 24 tests without firing. It is kept as the
   arm's semantic guard, because "no path can reach here with the flag false" is
   exactly the implicit invariant that breaks on the next edit, and it is named
   here so the next sweep does not re-raise it as a gap.

   **The deletion set was re-run and the count re-derived, not restated.** 93
   reader features were deleted individually, each in its own fresh copy: 69
   red, 24 green, of which 17 admit an ordinary writer under the mutant and 7
   are cosmetic. That is a far wider set than the sixteen the round-3 signal
   claimed and the twenty-one the hold counted; neither number is reproducible
   because neither stated its enumeration, so this one states its method rather
   than asking to be believed. Of the 17 live ones, 5 are now pinned by this
   round's work and 12 were still green on the fixed tree. Three of those 12 sit
   in code this round changed and are pinned here; one is the unpinnable
   conjunct above; the remaining eight are pre-existing and are listed under
   `[TODO Architect]` for triage rather than folded into this hold.

### Bundle C

5. **The barrier paragraph's worked example is rewritten around the row the
   statement reaches.** Verified against the routes rather than taken from the
   hold. `routes/settings.ts`'s add flow INSERTs only where `existing.length ===
   0`, so a finalized account always takes the change flow, which writes
   `pending_email`, `pending_email_token` and `pending_email_expires_at` and
   never names `verify_token`; the clearer selects `WHERE verify_token = $1`,
   which a finalized light row carries as NULL; `POST /signup` answers 409 on a
   NULL token before its upsert; and the resend route returns at
   `if (!account.verify_token)` before its UPDATE. So the clearer reaches state
   G, and ARCHITECTURE.md section 6.1 confirms a `custody = 'light'` row with a
   hex token is not an enumerated state at all — a hex token means E or G, and
   E carries `username` NULL.

   The paragraph now says `custody` holds ALONE for the rows these two
   statements reach, spells out why the clearer cannot reach a finalized light
   row, and keeps the conclusion the hold asked to keep: neither statement names
   the marker, which is what keeps both out of the writer set.

   **The same correction applies to round 3's signal block**, which said
   "`custody` plus the marker are named as the terms that actually hold". That
   was half wrong in the same way the docblock was. For the rows these two
   statements reach, `custody` holds alone; the marker bounds the rows `custody`
   lets through, which are a different set. Corrected here rather than by
   editing the earlier block, so the round-by-round record stays intact.

6. **The body-keyword example is folded, and pinned.** Confirmed first that it
   cannot match: `DOLLAR_CODE_BODY_RE` is end-anchored, so
   `SET note = 'stored exactly as'` is false on it and only the open-quote form
   `SET note = 'stored exactly as` is true. The clause is folded into the
   multi-line-value residual, which is the shape that actually produces it, and
   the keyword pattern now carries self-tests beside the clause-by-clause pins:
   the closed value false, the open value true, and `DO LANGUAGE plpgsql` false
   for the clause that hides a real body.

7. **The opener docblock is scoped to the statement reader.** Confirmed the
   blanking reader reaches two openers: `DO $$` at 007:33 and 017:84. The
   sentence now says no STATEMENT read reaches a grammatical opener, names the
   two the blanking reader does reach, and points at `SpanEvent` for the
   question sharing the opener judgement does not settle.

### The two counts, re-derived rather than corrected on trust

Both were measured by instrumenting the reader rather than by grepping.

- **The statement reader reaches an unquoted `$` ONCE over both trees, not
  twice and not "three to four".** Measured on the COMMITTED tree with the
  COMMITTED reader, counting every `statementAt` call all four scans actually
  make plus a direct sweep of every `ACCOUNTS_STATEMENT_RE` match: 1 reached the
  `dollarOpenerAt` decision point, 0 were judged an opener. The round-3 figure
  and the hold's figure are both off; this one states what it counted.
- **The block-comment census is 13 past sixty with a longest of 159 by
  closer-minus-opener, and 15 and 160 counting inclusively**, which is what the
  hold said. Re-derived through the reader's own `state.block` transitions
  rather than a per-line grep. The naive scan the round-3 signal called out
  reproduces at 17, which is what confirms which number is which. The docblock's
  figure is correct under the closer-minus-opener measure.

### [TODO Architect] Eight unpinned reader features, surfaced not fixed

Found by the deletion sweep described under item 4, outside this hold's scope
(item 4 names the features the PREVIOUS round added; these are older). Each was
demonstrated live: deleting it keeps the canary green AND an ordinary
`accounts.updated_at` writer planted beside it goes unseen. Listed for triage
per the project's review-findings rule rather than folded in, because pinning
eight more features is a round's work on its own and the architect may prefer a
different cut, or may take the view that the escape arms belong together.

Four are ESCAPE handling, and they cluster:

- `blankLine`'s main-path escape arm, whole. Deleting it keeps the canary green.
- The `escapes &&` dialect gate on that same arm.
- The `escapes &&` gate on the DOLLAR-branch escape arm. Without it a `.sql`
  reader takes `\$` for an escape pair, so a value's own closing `$$` is never
  seen and the span runs on over the write beside it.
- `statementAt`'s escape skip inside its `opaque` branch. Without it a `\'`
  inside an `E'...'` string closes the value early and the following `;`
  terminates the statement before a MERGE's insert column list.

Three are the DOUBLE-quote half of a quote-opens-opaque arm, or its sibling:

- The `|| char === '"'` alternative in the dollar branch. Without it a `$$`
  inside a quoted identifier closes a body early.
- The same alternative on the main path.
- `opaque = null` on the backtick that ends a template, in the opaque branch.

And one is a dialect conjunct:

- The `!sql` conjunct on the `//` arm. Without it a `//` in a migration is read
  as a comment, and a URL in a value blanks the SQL after it.

### [TODO Architect] The earlier residual list, still open

Unchanged from the round-3 signal except where noted. Not acted on.

- The routine/trigger arms run over `migrations` only, never over `sources`, so
  trigger and trigger-function DDL spelled in a TypeScript file is refused by
  nothing. Still the highest-ranked of these.
- `COPY accounts FROM stdin` with NO column list writes every column and is read
  as writing none.
- A rebuild-and-rename table swap: every write names `accounts_rebuilt` and the
  final `RENAME TO accounts` is read by no pattern.
- A one-line SQL statement held in an ordinary single-quoted TypeScript string
  keeps its comments live, because values are not blanked.
- An unescaped backtick inside an ordinary single-quoted TypeScript string
  toggles the reader's `template` flag. RE-CHECKED this round and I could NOT
  reproduce it as a silent pass, which is worth triaging before the entry is
  carried forward again. The flag does toggle, and the new dialect gate closes
  only the `.sql` half of the class (in a `.ts` file a backtick really is a
  delimiter). But every shape tried went red or was dominated by another
  residual: one backtick leaves the file mid-template and the end-state arm
  reds it by name; a PAIR balances the flag but the write beside it is caught by
  both walks anyway; and a pair wrapped around a phantom `$1,$` placeholder span
  greens WITH AND WITHOUT the backticks, because what actually hides that write
  is the single-quoted-string residual listed above it, not the flag. Either the
  round-3 demonstration used a shape I did not find, or the entry belongs folded
  into the single-quoted-string one.
- A back-fill in a `migrations/` SUBDIRECTORY goes unscanned.

Two entries from that list have since been filed as their own tasks and are
dropped from it: the `ALTER TABLE IF EXISTS accounts` pin, and the spaced schema
dot in the trigger-bind clause.

### Verification

Every probe below ran in a fresh tar-copied tree under the scratchpad with
`node_modules` and the repo-root `.env` symlinked, never in the shared checkout;
`git status` there stayed at the sibling's `CONCEPTS.md` throughout.

- The canary is 24 tests, green. `tests/eslint/` is 9 files / 134 tests green.
- `npm run typecheck` clean (both `typecheck:src` and `typecheck:tests`).
- `npm run lint` clean apart from the pre-existing unused-disable warning in
  `src/lib/author-supersession.ts`, unchanged from the previous round.
- The pre-commit anchor gate finds zero violations across the added lines. Run
  standalone with `ALLOW_MARKER` set explicitly, since it is `readonly` in the
  hook and an empty marker exempts every line: three control lines (a task-slug
  citation, a round ordinal, a bare positional anchor) all fire, so the zero is
  not vacuous.
- SIX reproductions before any fix, each with a flipping control: the two
  `EXECUTE format` shapes, the top-level and in-template variants, and the two
  backtick shapes. All six red after the fix; the clean tree stays green.
- FOURTEEN features deleted individually after the fix, each reddening its own
  fixture: the seven the hold named, the two the sweep found, and this round's
  five. Plus the reachability check on the one conjunct no fixture can
  discriminate.
- The regression this round's own change 3 opened was found by the deletion
  sweep, not by reasoning, and is closed rather than reverted: per-line value
  state alone truncates a MERGE at a continuation line's `;` and drops its
  insert column list. The read now STOPS on an unbalanced line reporting no
  terminator, so both directions red instead of one being traded for the other.

### The round's own adversarial pass, which is again what made this more than seven fixes

Six unscripted lenses ran over the REWRITTEN reader in isolated copies, each
finding required to carry a planted fixture and a one-character control. They
raised 20 distinct findings, and the important ones are the ones about this
round: the rewrite had opened FOUR silent passes, every one of them the class
this file exists to close. All four are fixed and pinned, and all four were
re-verified by hand before being acted on rather than taken from the lens.

1. **`targetTable` read the new fail-closed answer as its opposite.** A read
   that GIVES UP and one that RUNS OUT OF ROOM both report `closedAt: -1`, and
   the reach test took either as "the statement reaches". So a write on the very
   line a read stopped on was lent that head's table, which is the exact
   misattribution the stop was added to prevent. `SqlStatement.stopped`
   separates the two; a statement of unknown extent lends to nothing. Probe: the
   shared-tag `EXECUTE format` block with the write pulled up onto the
   closing-tag line, and the same shape with the write to the RIGHT of where the
   span closed. Both green before, both red after, the newline that moves the
   write off that line as the control.

2. **A wrapped string literal inside `ALTER TABLE accounts` hid an
   `ALTER COLUMN updated_at TYPE ... USING`.** The new stop truncated the read
   at the value's own line, and the every-statement-readable arm covered only
   the DML heads, so nothing reported the truncation. That arm now covers the
   ALTER head too, which matters more than it sounds: `accountsColumnAlterations`
   is the ONLY scan that sees a rewrite carrying no assignment and no column
   list, so it has no second walk behind it. Probe: an ADD COLUMN whose DEFAULT
   string wraps, ahead of the retype. Green before; red now on the readable arm,
   and the single-line control reds on the ALTER pin instead, which is the right
   arm for the right shape.

3. **A quoted value inside a NESTED literal outlived the literal.** Dollar
   quoting exists so a value need not escape its quotes, so the apostrophe in
   `$d$ 016's back-fill skipped rows $d$` is correct SQL rather than a slip.
   Consumed as an open value it swallowed the literal's own closing tag, so no
   close was RECORDED. The blanking recovered at the next line, because `opaque`
   resets there; the span record did not, and every following line was
   registered one level too deep for the statement read to replay. Bounded now
   by the same innermost tag the `--` arm two cases below it already stops at.
   Probe: an ordinary operator-note back-fill, green before and red now, in both
   the quoted-identifier and the bare line-broken spelling.

4. **`enclosingQuote` was the last reader that did not know where it was.** It
   accepted a backtick as a delimiter with no dialect test and knew nothing of
   dollar spans, so the apostrophe in `$$don't reuse this$$` and the backtick in
   the same shape each became a statement's terminator, and the read ran past
   its own end to lend its table below. It replays the recorded spans now, like
   the other two readers. That also removes the need for a dialect flag here: a
   backtick is only a delimiter where the blanking reader already treated it as
   one. Two of the lenses reached this independently and it is pre-existing, not
   opened this round, but it is the same invariant Bundle A item 2 gave me one
   reader over, so it is closed rather than listed.

   `BlankedCode.sql` fell out of this. After the rewrite `statementAt` no longer
   judges openers, so the dialect had no second reader to align and the field
   had no reader at all, while its docblock still claimed it was what kept the
   two from drifting. A field nothing reads is a field the next author has to
   decide about, so it is gone and the docblock says what replaced it.

**Four docblocks the rewrite made false**, three of them describing the
pre-stop reader, are corrected: the statement-read value paragraph, the KNOWN
LIMITS value bullet (the two readers now diverge there ON PURPOSE, and only
there), and a `$$it''s$$` example whose DOUBLED apostrophe balances and so
cannot produce the defect it is cited for. That last one is the same
non-reproducing-example class as Bundle C item 6, in prose this round wrote,
which is the argument for the self-test that item asked for. Two pre-existing
ones went with them: the reuse note's "five SET lines" is four with the
assignment on the last of them, and the claim that both `DO`-block migrations
wrap ordinary `accounts` DDL (007 wraps a duplicate-ORCID guard that aggregates
the table and raises).

**Regression run.** All fourteen fixtures this round produced were replayed
against the final tree in one pass: every one red, clean tree green. Nothing
that was closed earlier in the round was re-opened by a later fix.

A caveat on the refutation stage, stated rather than hidden: the refuters copy
the tree under test, and I was fixing findings between the hunt and the
refutation, so several came back "could not reproduce" against a tree where the
defect was already closed. Their verdicts are not load-bearing here. Every
finding acted on was reproduced, fixed and re-verified by hand, each with its
own control, and the regression run above is the evidence.

### [TODO Architect] Three more from the adversarial pass, not acted on

All pre-existing, none opened this round, none in this hold's scope.

- `INSERT INTO "accounts" (..., updated_at)` with a QUOTED identifier is seen by
  no arm at all: the table patterns require a bare identifier, and the shape
  carries no assignment for the fail-closed arm. The KNOWN LIMITS already name
  the quoted identifier, and this is the concrete writer it admits.
- `enclosingQuote` picks its delimiter from the HEAD's own line, so a head on a
  template CONTINUATION line (`\`UPDATE` on one line, `accounts` on the next, or
  a head below a WITH clause) carries no quote character, the read believes it
  is a migration statement, and it hunts for a `;` past the template's closing
  backtick. Needs a different mechanism from the span fix landed here, which is
  why it is listed rather than closed.
- A trigger on `accounts` installed from a TypeScript file is invisible, which
  is the same entry already at the top of the earlier residual list, re-found
  independently. That two passes reached it is evidence about severity.
