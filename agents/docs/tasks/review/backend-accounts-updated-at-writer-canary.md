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
