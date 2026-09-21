# The ALTER pin does not admit the IF EXISTS spelling

**Owner:** backend
**Created:** 2026-09-09

Routed out of the round-3 architect review of the `accounts.updated_at` writer
canary. Pre-existing rather than introduced by that round, so it is filed here
instead of held there.

## Why

`ALTER_ACCOUNTS_RE` in
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`
admits `ONLY` and a `public.` qualifier but not `IF EXISTS`. A migration
spelling `ALTER TABLE IF EXISTS accounts RENAME COLUMN updated_at TO touched_at;`
is not seen by the column-alteration arm and the suite stays green; without the
clause the same statement reds.

What makes this more than a spelling gap is that the bypass is the repo's own
house style. Migrations here are written idempotent, so `IF EXISTS` is the form
an author reaches for by default, not an evasion. The arm exists to catch a
migration that renames, drops, or retypes the column the `/link` stuck-recovery
ordering is measured against, and it is blind to the spelling most likely to
carry that change.

Verified by mutation during the round-3 review: with the clause, 21/21 green;
without it, 1 failure. The `ALTER COLUMN ... TYPE ... USING NOW()` form passes
too.

## Scope

1. Admit the clause in `ALTER_ACCOUNTS_RE`, between `ALTER TABLE` and the
   optional `ONLY`.
2. Add a fixture asserting the `IF EXISTS` spelling is counted, alongside the
   existing `ONLY` / `public.` / foreign-table fixtures.
3. Check the same omission in the sibling canaries under `tests/eslint/` that
   carry their own ALTER pattern, and fix any that share it. Report what the
   sweep covered from the code rather than asserting completeness.

## Acceptance criteria

1. `ALTER TABLE IF EXISTS accounts DROP COLUMN updated_at;` planted in a
   migration turns the canary red, demonstrated by mutation.
2. The clean tree stays green.
3. The fixture pins the clause specifically: deleting only the `IF EXISTS`
   alternative from the pattern reds it.

## Backend implementation signal (2026-09-14, commit 6e02acf9)

`backend(canary): admit the idempotent ALTER spelling, and pin each head clause`
— one file, `tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`.

### Scope 1, the clause

`ALTER_ACCOUNTS_RE` now reads

```
/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\s*\.\s*)?accounts\b/i
```

with the clause in grammar order, before `ONLY`. One alternative in one
position is the whole clause: `ALTER TABLE ONLY IF EXISTS accounts` is a
syntax error, so the reverse order needs nothing. The docblock gained one
paragraph naming the grammar position and the idempotent house style as the
reason. `ALLOWED_COLUMN_ALTERATIONS` is untouched — no migration in the tree
spells `IF EXISTS` on the table, so the 016 entry of 3 is unchanged.

### Scope 2, the fixtures — and a correction to the task's premise

The task said to add the fixture "alongside the existing `ONLY` / `public.` /
foreign-table fixtures". Those do not exist. `ONLY` and `public.` are pinned
for the statement-head family (`ACCOUNTS_STATEMENT_RE`), but every ALTER
fixture in the file spelled a bare `ALTER TABLE accounts`, so deleting the
`ONLY` or the `public.` alternative from `ALTER_ACCOUNTS_RE` was a silent
21/21 pass. There is no foreign-table ALTER fixture either; the two existing
negatives are an ALTER on `accounts` that does not name the column, and one
naming the column on `sessions`.

Four positives were planted, each answering to exactly one feature:

- `ALTER TABLE IF EXISTS accounts DROP COLUMN updated_at;` — the clause this
  task is about, and the AC3 pin. Deliberately the minimal bare-table
  spelling: it reds when the `IF EXISTS` alternative is deleted and survives
  deletion of the other two, so its red bar names one clause. A combined
  `IF EXISTS ONLY public.accounts` line would have satisfied AC3's wording
  while reding under all three deletions, naming none of them.
- `ALTER TABLE ONLY accounts ...` and `ALTER TABLE public.accounts ...` —
  closing the same unpinned-alternative gap on the two clauses the arm
  already admitted.
- `ALTER TABLE IF EXISTS ONLY accounts ...` — the one spelling that answers
  to the clause ORDER rather than to either clause, so the docblock's
  grammar-order claim is pinned rather than asserted.

### Scope 3, the sweep — what it covered, from the code

Nine files under `tests/eslint/`. Exactly one defines SQL regexes of its own:
this one. No sibling carries an ALTER pattern at all, so there was nothing of
the same spelling to fix.

- `no-accounts-updated-at-write-outside-signup-finalize.test.ts` — the only
  SQL-regex file. Head patterns (`ACCOUNTS_STATEMENT_RE`, `UPDATE_TARGET_RE`,
  `INSERT_TARGET_RE`, `MERGE_TARGET_RE`), column-list patterns
  (`ACCOUNTS_INSERT_COLUMNS_RE`, `MERGE_INSERT_COLUMNS_RE`,
  `COPY_COLUMNS_RE`), `ALTER_ACCOUNTS_RE`, `ROUTINE_CREATION_RE`,
  `BOUND_TO_ACCOUNTS_RE`, plus the lexer and assembly detectors.
- `no-accred-state-read-missing-id-tiebreaker.test.ts`,
  `no-custom-id-block-num-floor.test.ts`, `no-bridge-paper-literal.test.ts` —
  zero regexes each; RuleTester wrappers whose patterns live in
  `backend/eslint.config.mjs`. Followed there rather than counted clean.
- `no-custody-claim-derivation-outside-helper.test.ts`,
  `no-session-consume-without-revocation-epoch.test.ts`,
  `no-session-proof-mint-outside-reauth-routes.test.ts`,
  `no-stale-comment-anchors.test.ts`,
  `no-unresolvable-carve-out-companion-citation.test.ts` — out of class:
  TypeScript identifiers, comment prose, file paths. Named rather than
  omitted so the coverage is auditable.

Outside `tests/eslint/`: `cast-hardening-author-index-weight.test.ts`,
`notification-queries-lateral-guard-canary.test.ts`,
`excludeSelfReviewWhere-callsite-canaries.test.ts`,
`window-cte-deterministic-tiebreaker.test.ts` all scan SQL text but anchor on
clause keywords or literal fragments, not DDL heads. `frontend/tests/unit/eslint/`
holds no regex constants and no SQL. No DDL pattern anywhere but this file.

### Acceptance criteria

1. **Met.** `ALTER TABLE IF EXISTS accounts DROP COLUMN updated_at;` planted
   in `002_nullable_email.sql` reds `only the column-introducing migration
   alters accounts.updated_at itself`, reporting
   `"002_nullable_email.sql#<module>": 1` against an expected empty entry.
   Five further spellings red the same way: rename onto the name, retype
   under all three clauses, the multi-line form, the lower-case clause, and
   irregular whitespace. Controls naming another column or another table stay
   green, so the widening does not over-match.
2. **Met.** Clean tree 21/21, typecheck clean, lint unchanged (one
   pre-existing warning in `src/lib/author-supersession.ts`, untouched here).
   The standing anchor canary is green on the new comments.
3. **Met, and extended.** Deleting the `IF EXISTS` alternative reds exactly
   one test. So does deleting `ONLY`, so does deleting `public.`, and so does
   swapping the two clauses into the invalid-SQL order. Each of the four
   mutants reds one and only one test, so every admitted clause and their
   order is individually attributable.

Beyond the key set: a fourth `ALTER TABLE IF EXISTS accounts DROP COLUMN
updated_at;` planted inside the allowed `016_accounts_updated_at.sql` symbol
raises its tally from 3 to 4 and reds, so the arm refuses a second alteration
inside an allowed symbol rather than only an unexpected key.

All mutation runs used isolated scratchpad copies of `backend/`; the shared
checkout was never mutated.

### [TODO Architect] findings surfaced, not fixed

A survey of the same class turned up further gaps in this file and its rule
host. None were touched — they are outside this task's scope and are for
triage, not silent repair. Ranked in the chat handoff; the load-bearing ones:
`BOUND_TO_ACCOUNTS_RE` spells the schema qualifier `(?:public\.)?` where its
five siblings spell `(?:public\s*\.\s*)?`, which downgrades the unexemptible
trigger-binding refusal to an exemptible one; `ALTER_ACCOUNTS_RE` still misses
the `ONLY (accounts)` paren form its three siblings admit, and a quoted
`"accounts"`; `ALTER MATERIALIZED VIEW accounts RENAME COLUMN` reaches an
ordinary table on this PostgreSQL, so the keyword anchor is not the only way
in; `COPY BINARY accounts (...)` evades both COPY arms; and the ALTER arm has
no read-whole backstop, so a head whose terminator falls past `LITERAL_CAP`
is dropped silently where an `ACCOUNTS_STATEMENT_RE` head would red.

## Architect review (2026-09-14, round 1) — HELD PENDING FIXES:

Reviewed at commit 6e02acf9 via `/ce-code-review` across five lenses — correctness,
project-standards, testing, adversarial, learnings — plus the architect's own
mutation run and an independent validator pass on the two surviving findings.
6e02acf9 is an ancestor of `main`; no orphan SHA. The cross-model adversarial pass
did not run (no different-provider CLI installed on this host), so the in-process
adversarial reviewer held that lens; noted because it means the lens had no
independent-family corroboration this round.

**The signal block's claims were re-verified by execution, not read.** In an
isolated scratchpad copy of `backend/`: clean tree 21/21 and `typecheck:tests`
clean; the AC1 spelling planted in `002_nullable_email.sql` reds the
column-alteration test with the expected `002_nullable_email.sql#<module>: 1`
against an empty entry; deleting the `IF EXISTS` alternative reds the IF EXISTS
fixture, deleting `ONLY` reds the ONLY fixture, deleting `public.` reds the
`public.` fixture, and swapping the two keyword clauses reds the combined fixture,
each mutant failing one test; a fourth alteration planted inside the allowed `016`
symbol raises its tally 3 -> 4 and reds; controls naming another column or another
table stay green. Scope 3 was re-enumerated from the code rather than taken from
the note: nine files under `tests/eslint/`, exactly one defining SQL regexes, no
sibling ALTER pattern, and `backend/eslint.config.mjs` carries none either. Every
other `ALTER` hit under `backend/tests` is executed fixture DDL, not a detection
pattern. All three acceptance criteria hold.

The hold is that the round pinned one of the three pairwise orders among the
pattern's three optional groups, and left a comment that claims more than its line
delivers. Neither costs a red bar today; both are the same class this task exists
to close — an alternative that no fixture answers for, and a docblock a future
author would act on. Verify each item by mutation in a scratch copy (red on the
mutation, green on restore) and state the probe per item when moving back to
`review/`.

### Item 1 (required). The schema-qualifier group's position is pinned by nothing.

`ALTER_ACCOUNTS_RE` carries three optional groups, so there are three pairwise
orders. The combined fixture pins `IF EXISTS` before `ONLY`. Nothing pins
`public.` after either. Demonstrated: with `(?:public\s*\.\s*)?` hoisted to the
front of the pattern, all four new fixtures still match and the suite is 21/21
green, while `ALTER TABLE IF EXISTS public.accounts DROP COLUMN updated_at;`
planted in a migration is not counted at all. The same plant reds under the
committed pattern, so the arm reads the head correctly today and only the pin is
missing. Two further reorderings (`ONLY` before `public.`, `IF EXISTS` before
`public.`) have the same shape.

One line closes all three at once, because it is the only spelling that carries
every group in grammar order:

```
expect(alterations(['ALTER TABLE IF EXISTS ONLY public.accounts DROP COLUMN updated_at;'])).toBe(1);
```

Confirmed by regex matrix and by suite run: it matches the committed pattern and
misses under each of the three reorderings, and the clean tree stays green because
no migration in the tree spells the qualifier. Probe: hoist the qualifier group and
show this line reds while the other four stay green.

### Item 2 (required). The combined fixture's comment claims a property the line does not have.

The comment above the `IF EXISTS ONLY accounts` fixture says that line "answers to
their ORDER rather than to either clause". It needs both clauses to match, so
deleting either one stops it matching too: it reds under three mutations, not one.
What survives is weaker and worth saying plainly — the swap reds that line alone,
and each single deletion reds the clause's own dedicated fixture first, so the set
still names the clause even though the line does not. Reword the comment to say the
line pins the order in addition to needing both clauses, and drop "rather than to
either clause". Do not split the assertion; the attribution comes from the set.

Note the consequence for the signal block's own reasoning: the argument used there
to reject a combined `IF EXISTS ONLY public.accounts` line ("reding under all three
deletions, naming none of them") applies equally to the two-clause line that was
kept. Item 1 adopts that line anyway, on the ground that a group whose position no
fixture answers for is the worse gap.

### Item 3 (optional). The docblock's house-style premise is a prediction stated as an observation.

The new paragraph says `IF EXISTS` "is the spelling an author reaches for by
default". Every `ALTER TABLE` head in `backend/migrations` is bare — seventeen
heads, zero `IF EXISTS` — and idempotency in this tree is spelled at the column
(`ADD COLUMN IF NOT EXISTS`) or inside a `DO` block. The widening is right
regardless, and the rationale survives a smaller claim: the idempotent house style
invites the spelling, so the arm should see it before one lands. Soften the clause
or leave it; if left, say in the task note that the premise is forward-looking.

### Item 4 (optional). The parenthesised `ONLY (accounts)` target on the ALTER head.

Pre-existing, unchanged by this round, and already surfaced in the task's own
`[TODO Architect]` block — carried here because the fix is one character class and
one fixture, and because this round rewrote the line the gap lives on. PostgreSQL's
`relation_expr` admits `ONLY ( name )`, and `ALTER TABLE ONLY (accounts) DROP
COLUMN updated_at;` planted in a migration leaves the suite green. The file already
admits the paren form on its UPDATE, MERGE and COPY heads and pins it for MERGE, so
the ALTER arm is the one head family blind to it. Mirror the sibling spelling
(`(?:ONLY\s+\(?\s*)?`) and pin it with one positive, or decline and add a KNOWN
LIMITS bullet saying a parenthesised ALTER target is not read. Leaving it recorded
nowhere is the one option that should not stand.

### Dismissed this round, recorded so they are not re-raised

- A quoted `"accounts"` on the ALTER head: dismissed. Quoted identifiers are an
  accepted textual-scan limit for this file, already named in its KNOWN LIMITS and
  ratified in the writer canary's round-2 triage. Same posture here.
- `ALTER MATERIALIZED VIEW accounts RENAME COLUMN`: dismissed. A deliberate-evasion
  spelling, not a default reach, and only the RENAME form reaches an ordinary table
  that way. A KNOWN LIMITS bullet is welcome, not required.
- `COPY BINARY accounts (...)`: dismissed on the same ground. It is the pre-7.3
  spelling; no author in this tree writes it by accident.
- The ALTER arm's missing read-whole backstop past `LITERAL_CAP`: no action on this
  task. It is recorded twice already on the writer-canary task in `review/` (accepted
  as a limit in its round-2 triage, re-raised in round 3); triaging it here would
  split one decision across two files.
- The trigger-binding qualifier spacing: out of scope here, already filed as its own
  backend task in `pending/`.

### Residual risks recorded, no action asked

A head split across lines (`ALTER TABLE IF EXISTS` on one line, the table on the
next) stays green because every head pattern in the file is matched per line; this
is an existing KNOWN LIMIT and all seventeen migration ALTERs keep the table on the
ALTER line, but the widening puts a third optional clause on that line. Dynamic SQL
through `EXECUTE format` is unseen, also recorded. A rename-swap around the table is
deliberate-evasion class and outside the stated threat model. PostgreSQL's
acceptance of `ONLY ( name )` was reasoned from the documented grammar, not a live
server. The four head-clause positives share one `it`, so a mutation that reds two
of them reports only the first; that is diagnostics, not coverage. No super-linear
behaviour: the committed pattern scans a 1,000,700-character adversarial line in 1 ms.

## Backend re-review signal (2026-09-16, commit 451054e2)

`backend(canary): the clause order needed a third fixture, and the paren a cheaper
spelling` — one file,
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`,
plus this task file's move. Self-verified: `git merge-base --is-ancestor 451054e2 main`
passes, and `git show --name-status` records the move as a single `R` with both the
source delete and the destination add, so there is no orphan SHA and no half-applied
rename. Only this heading and the SHA line land in a follow-up commit, for the obvious
reason that a block cannot name the commit that carries it. All four hold items landed, items 1 and 2 as prescribed, items 3 and 4
with one named deviation each. The round also found and fixed a defect it had
introduced itself, described under "Self-found" below.

The pattern now reads

```
/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\b\s*\(\s*|ONLY\s+)?(?:public\s*\.\s*)?accounts\b/i
```

### The grammar was read off a live server this round, not reasoned about

The round-1 hold recorded that "PostgreSQL's acceptance of `ONLY ( name )` was
reasoned from the documented grammar, not a live server". It has now been read
off one. Every head spelling below was aimed at a relation that does not exist
on the dev PostgreSQL 16, so `syntax error` versus `does not exist` separates
what the grammar accepts from what it rejects with no DDL ever executing:

| spelling | verdict |
|---|---|
| `ALTER TABLE IF EXISTS ONLY public.accounts ...` | parses |
| `ALTER TABLE ONLY IF EXISTS accounts ...` | **syntax error** |
| `ALTER TABLE ONLY (accounts) ...` | parses |
| `ALTER TABLE ONLY(accounts) ...` | parses |
| `ALTER TABLE ONLY ( public . accounts ) ...` | parses |
| `ALTER TABLE (accounts) ...` | **syntax error** |
| `ALTER TABLE accounts * ...` | parses (already matched; `\b` ends before the `*`) |

So the docblock's clause-order claim is now observed rather than asserted, the
paren gap is real, and the bare-paren form the hold offered as a sibling-mirror
spelling turns out not to be a legal statement at all.

### Item 1 (required) — the qualifier's position is now pinned

Landed exactly as prescribed, one line:

```
expect(alterations(['ALTER TABLE IF EXISTS ONLY public.accounts DROP COLUMN updated_at;'])).toBe(1);
```

Probe: a mutant per reordering, each run in its own scratchpad copy of `backend/`.
The table is which fixture stops being counted under each mutation. `.` = still
counted, `RED` = the mutation kills that line.

| fixture | drop IF EXISTS | drop ONLY | drop `public.` | swap IFEX/ONLY | **hoist `public.` to front** | **swap ONLY/`public.`** | **swap IFEX/`public.`** | drop paren alt | hold's `ONLY\s+` | tidy to short form |
|---|---|---|---|---|---|---|---|---|---|---|
| bare | . | . | . | . | . | . | . | . | . | . |
| `IF EXISTS` | RED | . | . | . | . | . | . | . | . | . |
| `ONLY` | . | RED | . | . | . | . | . | . | . | . |
| `public.` | . | . | RED | . | . | . | . | . | . | . |
| `IFEX+ONLY` | RED | RED | . | RED | . | . | RED | . | . | . |
| **`IFEX+ONLY+public`** (new) | RED | RED | RED | RED | **RED** | **RED** | **RED** | . | . | . |
| **`ONLY (paren)`** (new) | . | RED | . | . | . | . | . | **RED** | . | . |
| **`ONLY(paren)`** (new) | . | RED | . | . | . | . | . | **RED** | **RED** | . |

The three bolded columns are the three reorderings the hold named. Two things this
paragraph said about them are wrong, struck and restated in round 3. They were called
pairwise orders: hoisting the qualifier to the front is a rotation rather than a
pairwise swap, so the three are two swaps and one rotation. And "before this round each
of them killed nothing and the suite stayed green" is wrong for one of the three. The
ten-mutant kill matrix in this same block shows the `IFEX+ONLY` row RED under the
swap-`IF EXISTS`-with-qualifier column, so that order was already killed by a fixture
round 1 added; the matrix is right and the sentence under it contradicted its own cell.
What survives is the rest: the new line is the only fixture that answers for the other
two, and the only one that answers for all three. Each of the ten mutants was also run
through vitest in its own copy: nine red exactly one test, and the tenth is discussed
under "Self-found".

### Item 2 (required) — the combined fixture's comment no longer overclaims

Reworded. The line now says it needs BOTH clauses, that deleting either reds it
alongside that clause's own single-clause line, that what it ADDS is the order,
and that the per-clause attribution comes from the set rather than from that line.
"rather than to either clause" is gone. The assertion was not split.

The matrix confirms the hold's reading: `IFEX+ONLY` dies under four mutations, not
one, while `IF EXISTS` and `ONLY` each still die first at their own dedicated line.

### Item 3 (optional) — the house-style premise, softened and grounded

The premise was checked and the hold is right. Across both trees the canary scans:
seventeen `ALTER TABLE` heads in `backend/migrations`, zero in `backend/src`, and
every one of the seventeen bare. Idempotency in this tree is spelled at the column
(`ADD COLUMN IF NOT EXISTS`), at the constraint (`DROP CONSTRAINT IF EXISTS`), at
`DROP TABLE IF EXISTS`, and inside a `DO` block. So `IF EXISTS` on the table head
is a form this tree has not written yet.

The docblock now says the reason for admitting the clause is forward-looking
rather than observed, and keeps the rationale that survives that: the idempotent
house style invites the clause, so the arm should see it when the first one lands
rather than one migration later.

Deviation, small: the hold scoped this to the docblock. The FIXTURE comment carried
the same overclaim ("the migrations here are idempotent throughout, so it is the
default reach"), so it was audited too, per the convention that a fix for one rot
class checks its own replacement rather than leaving a second copy standing.

### Item 4 (optional) — the paren target admitted and pinned, with a deviation

Taken rather than declined, so no KNOWN LIMITS bullet was needed for it.

Deviation from the prescribed spelling, and the reason. The hold offered
`(?:ONLY\s+\(?\s*)?` as the sibling mirror. Two live-server facts argue against
copying it literally:

1. `ALTER TABLE (accounts)` is a syntax error, so the DML heads' placement of
   `\(?\s*` OUTSIDE the `ONLY` group admits a statement no server runs. Keeping the
   paren inside the group matches the grammar exactly. This is not a criticism of
   the DML heads: over-admission on a head pattern is a widening that loses
   nothing, and the docblock says so, so nothing here forbids a later unification.
2. `ALTER TABLE ONLY(accounts)` — no space — parses. Both `ONLY\s+\(?\s*` and a
   bare sibling-mirror require that space, so both stay blind to it.

The committed group is therefore `(?:ONLY\b\s*\(\s*|ONLY\s+)?`, which admits every
spelling the server accepts and none it rejects. Pinned by two lines: `ONLY (accounts)`
answers for the paren, `ONLY(accounts)` answers for the optional space. The matrix
shows the attribution is clean — dropping the paren alternative kills both, and the
hold's own `ONLY\s+` spelling kills only the no-space line, which is exactly the one
statement the deviation buys.

### Self-found: the paren admission introduced quadratic backtracking, in either spelling

Admitting an optional paren between two unbounded whitespace runs (`ONLY\s*\(?\s*`)
lets the engine split those runs every possible way before failing. Measured against
a line carrying `ALTER TABLE ONLY` and then whitespace that never reaches a table:

| spaces after `ONLY` | pre-round pattern | hold's `ONLY\s+\(?\s*` | short `ONLY\b\s*\(?\s*` | committed alternation |
|---|---|---|---|---|
| 10,000 | 0.0 ms | 33 ms | 32 ms | 0.2 ms |
| 100,000 | 0.1 ms | 2,935 ms | 3,295 ms | 0.1 ms |
| 400,000 | — | — | 53,144 ms | 0.8 ms |

This is not a consequence of the deviation: the hold's own suggested spelling has
it too, and it is why the committed group spells the paren as a REQUIRED alternative
rather than an optional one. The two forms were checked equivalent over 21 head
spellings, valid and invalid, before the swap; they agree on all 21.

It matters because the round-1 residual-risks note recorded "no super-linear
behaviour" as a property of this arm, and the straightforward reading of item 4
would have falsified it silently.

### Acceptance criteria

1. **Met.** `ALTER TABLE IF EXISTS accounts DROP COLUMN updated_at;` planted in
   `002_nullable_email.sql` reds the column-alteration test. Nine further plants
   were run in isolated copies, five red and four green:

   | planted in a migration | result |
   |---|---|
   | `ALTER TABLE IF EXISTS ONLY public.accounts DROP COLUMN updated_at;` | red |
   | `ALTER TABLE ONLY (accounts) DROP COLUMN updated_at;` | red |
   | `ALTER TABLE ONLY(accounts) RENAME COLUMN touched_at TO updated_at;` | red |
   | `ALTER TABLE ONLY ( public . accounts ) ALTER COLUMN updated_at TYPE ... USING NOW();` | red |
   | `ALTER TABLE IF EXISTS ONLY (public.accounts) DROP COLUMN updated_at;` | red |
   | `ALTER TABLE ONLY (sessions) DROP COLUMN updated_at;` | green (other table) |
   | `ALTER TABLE ONLY (accounts) DROP COLUMN pending_email;` | green (other column) |
   | `ALTER TABLE hafsql.accounts DROP COLUMN updated_at;` | green (the read-only view stays out) |
   | `ALTER TABLE (accounts) DROP COLUMN updated_at;` | green (not a legal statement) |

   And inside the allowed symbol rather than against the key set: a further
   `ALTER TABLE ONLY(accounts) DROP COLUMN updated_at;` planted in
   `016_accounts_updated_at.sql` raises its tally from 3 to 4 and reds.
2. **Met.** Clean tree green: the file's own 24 tests, and all 9 files / 134 tests
   under `tests/eslint/` including the standing anchor canary on the new comments.
   `npm run typecheck` clean. `npm run lint` unchanged (the one pre-existing warning
   in `src/lib/author-supersession.ts`, untouched). Both git hooks' self-tests pass
   (pre-commit 37/37, commit-msg 49/49).
3. **Met.** Deleting the `IF EXISTS` alternative reds exactly one test, and the
   matrix shows which line. The same holds for every other admitted alternative and
   for every reordering — ten mutants, nine of which red, each attributable.

### Scope 3 re-enumerated from the code, not carried over

Still nine files under `tests/eslint/`; no sibling task added a tenth. Six of the
nine define regex constants, and five of those six are TypeScript identifiers, JWT
and object-literal shapes, comment prose and file paths — checked by reading their
constants, not by trusting the round-1 note. Exactly one file defines SQL patterns:
this one. No sibling carries an ALTER pattern, and `backend/eslint.config.mjs` carries
none. Every other `ALTER` under `backend/tests` is executed fixture DDL through
`pool.query`, not a detection pattern.

### KNOWN LIMITS gained one bullet, verified live

The ALTER arm anchors on the keyword `TABLE`, and `TABLE` is not the only keyword
that reaches an ordinary table. On the dev PostgreSQL 16, against a temp table
inside a rolled-back transaction: `ALTER MATERIALIZED VIEW`, `ALTER VIEW` and
`ALTER FOREIGN TABLE` all accept `RENAME COLUMN` on an ordinary table, while every
other form of those three is refused for the wrong relkind (`DROP COLUMN` under all
three, `ALTER COLUMN ... TYPE` under `FOREIGN TABLE`). So `RENAME COLUMN` is the
single form that reaches, and it is exactly the form that moves another column onto
the name. The hold dismissed this as deliberate-evasion class and asked only that it
not go unrecorded; it is recorded, not admitted. The dismissal note said "only the
RENAME form reaches an ordinary table that way", which is right, and the bullet adds
that it does so under three different object keywords rather than one.

### Blast radius

The file is self-contained: it exports nothing and nothing imports it. The only
tests its edit can affect are the ones under `tests/eslint/`, which were run whole
and are green. The full backend suite was not run for this change; it carries known
pre-existing failures and load-induced flakiness, so it would have added noise and
no signal here.

### Adversarial pass this round

Four lenses ran against the widened arm in isolated copies of `backend/` — PostgreSQL
grammar, non-ALTER DDL, the reader's own machinery, and comment conventions — each
followed by two independent refuters. Everything below was then re-verified by hand
against the live server and by planting in a probe copy, because a lens's confidence
is not evidence. One lens claim did not survive that check and is recorded as refuted.

**Recorded here as refuted, wrongly. Struck and restated in round 3.** The convention
lens held that the docblock's "the two admit exactly the same statements" is false,
offering `ALTER TABLE onlyaccounts DROP COLUMN updated_at;` as the counter-example,
and the lens was RIGHT. What got measured against it was `ONLY\b\s*\(?\s*`, with the
word boundary. What the docblock printed was `ONLY\s*\(?\s*`, without one. Both
spellings do reject that string when the boundary is there, and the differential over
1,220,700 constructed head strings that found zero divergence was a differential
between the committed group and the boundary-FUL short form. Neither fact reaches the
sentence the lens was disputing, because the spelling that sentence printed carries no
boundary and so reads `onlyaccounts` — a head naming another relation, which the server
accepts as one — as a write to this table. Recording the finding as refuted was the
error, and a later round consulting this entry would have skipped the re-check on the
strength of it. Round 3 fixes the sentence and lands the negative fixture. The rest of
that lens's report — that every other falsifiable claim in the diff reproduces and that
the anchor gate fires on none of the added lines — matched the checks run here and
still does.

**Gate control, because a green gate proves nothing on its own.** The pre-commit
anchor gate passes on this diff, and it was shown to fire on this exact file by
staging a deliberately rotten line (a task slug, a round ordinal and a bare
positional anchor) into a throwaway index and watching the hook reject it. The
working tree was never touched: the violating blob went into the index only.

### [TODO Architect] for triage, nothing applied

Ranked. Each was verified here by hand, not taken from the lens that raised it. None
is in this task's scope and none was touched, per the repo's rule that review findings
are surfaced and triaged rather than silently fixed or silently filed.

1. **A catalog-qualified three-part name evades every arm in the file, with no
   backstop.** `ALTER TABLE pevo_app.public.accounts DROP COLUMN updated_at;` parses
   on the dev server and names the same relation (PostgreSQL resolves the catalog part
   away when it is the current database; a genuinely cross-database name is rejected).
   Every head pattern in the file carries exactly one qualifier group, `(?:public\s*\.\s*)?`,
   so none of them matches. Planted in a migration, the suite stays green. So do
   `UPDATE pevo_app.public.accounts SET updated_at = NOW();` and the INSERT form, while
   the two-part `public.accounts` control reds — so this is not the fail-closed arm
   catching it, it is a silent pass. This is the one finding that worries me: it is not
   a deliberate-evasion spelling, it is what a tool or an author reaching for an
   unambiguous name writes, and the ALTER form carries no assignment token for any
   other arm to resolve. Pre-existing and shared by all five head patterns, so it is a
   file-wide decision rather than an ALTER-arm one.

   The mechanism is worth stating exactly, because it is not simply "the head
   patterns miss it". `QUALIFIED_NAME` is deliberately multi-part, so `UPDATE_TARGET_RE`
   captures `pevo_app.public.accounts` happily; `bareTable` then strips only a leading
   `public.`, so that name normalises to itself rather than to `accounts`. The
   column-first scan therefore resolves the assignment to a plausible OTHER table — not
   to `accounts`, and not to `UNRESOLVED_TABLE`. The fail-closed arm is SATISFIED rather
   than tripped, which is precisely the failure the file's own docblock calls the silent
   direction. Every backstop the KNOWN LIMITS lean on rests on that arm firing.

   Six qualifier sites carry the assumption: the four head and column patterns spell
   `(?:public\s*\.\s*)?`, `BOUND_TO_ACCOUNTS_RE` spells `(?:public\.)?`, and `bareTable`
   spells `^public\.`. No other canary under `tests/eslint/` carries a schema qualifier
   at all, so the blast radius is this file.

   If it is fixed rather than recorded, the fix is bounded: admit an optional leading
   catalog identifier ahead of the qualifier group, keeping `public` required as the
   middle part. That cannot over-match into another database, because PostgreSQL refuses
   a foreign catalog outright rather than resolving it — `ALTER TABLE otherdb.public.x`
   answers `cross-database references are not implemented`, checked on the server. So the
   only names the widening newly admits are names for this same relation.
2. **The trigger, rule and routine arms scan `migrations` only, while the ALTER arm
   next to them scans both trees.** Wired as `routineSites(migrations)` at both call
   sites, against `accountsColumnAlterations([...sources, ...migrations])`. Verified:
   a `CREATE TRIGGER ... ON accounts` with a `NEW.updated_at := now()` body, planted in
   a `src/*.ts` file as a `pool.query` template, leaves the suite green; the identical
   text in a migration reds two tests. The file's own docblock argues the opposite of
   this scoping — it calls the routine arm "the ONLY catcher" of the PL/pgSQL assignment
   shape — so the narrow wiring looks unintended rather than decided.
3. **The table-rebuild-and-rename idiom is invisible to every arm.**
   `CREATE TABLE accounts_rebuilt (LIKE accounts INCLUDING ALL); INSERT INTO
   accounts_rebuilt (...) SELECT ... FROM accounts; DROP TABLE accounts; ALTER TABLE
   accounts_rebuilt RENAME TO accounts;` — planted as a new migration, the suite stays
   green. `LIKE accounts INCLUDING ALL` copies the column's `DEFAULT now()` and its
   `NOT NULL` (confirmed live against a temp table in a rolled-back transaction), so an
   INSERT whose column list omits the marker stamps every copied row at migration time,
   which is the outcome the whole file exists to refuse. The round-1 hold dismissed
   "a rename-swap around the table" as deliberate-evasion class; that dismissal is worth
   revisiting on the narrower ground that this particular shape is a standard rebuild
   idiom rather than an evasion, and that the arm reads `accounts` only as the SUBJECT
   of an ALTER and never as a rename TARGET.
4. **The linear-time shape of the `ONLY` group is held by a docblock paragraph and by
   nothing else.** The tenth mutant in the matrix, tidying the alternation back to the
   short form, kills no fixture — correctly, since the two are behaviourally identical
   and differ only in cost. A timing assertion would pin it but is the preemptive
   hardening this project usually declines, and no line in either tree can reach the
   quadratic case. Recorded as a deliberate gap rather than decided.
5. **One backslash in an earlier literal on the same line truncates the ALTER read,
   silently.** `blankLine` gates backslash-as-escape on the dialect (`const escapes =
   !sql`), because PostgreSQL runs with `standard_conforming_strings = on` and a
   backslash in an ordinary literal is data — confirmed on the server, `'c:\'` is a
   closed three-character value. `enclosingQuote` and `statementAt` do NOT gate it, so
   they read that literal's closing quote as an escape and take everything after it to
   be inside a string. Planted in a migration, `INSERT INTO audit_log (note) VALUES
   ('c:\'); ALTER TABLE accounts ADD COLUMN note text DEFAULT 'n', ALTER COLUMN
   updated_at TYPE timestamptz;` leaves the suite green; the identical line with the
   backslash removed reds. The every-statement-readable arm does not catch it either,
   because the truncated read still reports a terminator. A one-character difference
   between a red bar and a silent pass, and the character is one a Windows path or an
   escape in a note field carries by accident.
6. **Three sibling heads carry the short `\(?\s*` spelling and its quadratic cost.**
   `ACCOUNTS_STATEMENT_RE`, `UPDATE_TARGET_RE` and `MERGE_TARGET_RE` each measure
   ~0.8 s against a fifty-thousand-space input, on the same shape the ALTER docblock
   now rejects; `COPY_COLUMNS_RE` and the committed ALTER head are flat. Not fixed here
   because the widening that made the question live is the ALTER head's, and the cost is
   headroom for them as much as for it. The ALTER docblock now names them, so a reader
   comparing the heads does not read the long form as the anomaly and tidy it away — but
   whether the siblings should simply be brought to the same spelling is a triage call.
7. **`BOUND_TO_ACCOUNTS_RE` still spells the schema qualifier `(?:public\.)?`** where
   its siblings spell `(?:public\s*\.\s*)?`. Unchanged this round, already filed as its
   own pending backend task; carried here only so the list is complete.

Cleared rather than found, so a later round does not re-spend a lens on it: the widening
introduces no offset shift, no swallowed head, no cap change and no ReDoS. `match.index`
is unchanged because everything the widening consumes sits BETWEEN `ALTER TABLE` and the
table name, so the match START does not move and the match length is never read; a longer
match cannot swallow a following head, since whitespace, `IF EXISTS`, `ONLY`, a paren and
a qualifier cannot contain another `ALTER`; and `LITERAL_CAP` counts lines from the head's
line, which does not move. Checked against a 9,576-case generated corpus (the wide pattern
is a strict superset of the narrow one, zero lost match indices) and against the real trees
(zero new heads outside this file's own fixtures).

## Architect re-review (2026-09-16, round 2) — HELD PENDING FIXES:

Reviewed at 451054e2 and 56bfd9db via `/ce-code-review` across six lenses — correctness,
project-standards, testing, performance, adversarial, learnings — plus a validator batch
over every surviving finding and the architect's own probes. Both SHAs are ancestors of
`main`; no orphan SHA, and `git show --name-status` records the task move as a single `R`.

Two things about the run itself, because they bound what it proves. The cross-model
adversarial pass did NOT run: no different-provider route is installed on this host and
the host serving family is `claude`, so the lens ran in-process and has no
independent-family corroboration this round. And the working tree advanced from 56bfd9db
to 81f7df9c mid-review — a sibling commit on this same file — so every finding below is
re-anchored to 56bfd9db. Line numbers read off the current worktree will be wrong.

**What held up, so it is not redone.** All four round-1 items landed. The item-4 deviation
is better than what round 1 prescribed and is NOT held: the prescribed `(?:ONLY\s+\(?\s*)?`
misses `ONLY(accounts)`, which the server accepts, and carries the quadratic shape the
committed alternation avoids. Re-derived here rather than taken from the note: the widening
opens no new silent pass (strict superset, `match.index` unmoved, no head swallowed);
scanning both real trees old-vs-new yields identical match lists across 119 files, so the
allowed-alteration tally is untouched and no new false red is introduced; detection stays
linear while the rejected spellings are quadratic; all four live-server grammar claims
reproduce; the published ten-mutant kill matrix reproduces cell for cell; the three named
sibling constants do carry the quadratic shape attributed to them; and the added comment
prose violates no anchor convention.

The hold is that three claims added THIS round assert more than the fixture set delivers.
That is the same class round-1 item 2 existed to close, which is why it is held rather than
recorded. Verify each item by mutation in a scratch copy and state the probe per item when
moving back to `review/`.

### Item 1 (required). The cited short form drops the word boundary, so its equivalence claim is false.

The docblock explains why the `ONLY` group is spelled as two alternatives rather than as a
shorter optional-paren form, and prints that rejected form as `ONLY\s*\(?\s*` — with no
`\b` — then claims "the two admit exactly the same statements". Without the boundary that
spelling also matches `ALTER TABLE onlyaccounts DROP COLUMN updated_at;`, a head naming a
DIFFERENT table, which the committed pattern rejects. Four head strings diverge. The claim
is false for the spelling actually printed.

What makes this more than a typo is that the round's own adversarial pass recorded this
exact lens finding as refuted, under "Refuted, recorded so it is not re-raised". That
refutation tested `ONLY\b\s*\(?\s*`, WITH the boundary. It refuted a different string from
the one the docblock prints, so the record is wrong and a later round consulting it would
skip the re-check.

Two resolutions, both acceptable; pick one and say which:

- Add the boundary to the citation (`ONLY\b\s*\(?\s*`). The sentence becomes true, the
  prose names the spelling that was actually measured and mutated, and the timing table's
  own header agrees with it.
- Keep the boundary-free citation and change the claim with it — the reason then is grammar
  AND cost, not cost alone — and land the negative fixture
  `expect(alterations(['ALTER TABLE onlyaccounts DROP COLUMN updated_at;'])).toBe(0);`.
  That line converts the one mutant the round recorded as killing nothing into a killed one.

Probe: build both spellings and show which head strings diverge, then show the chosen
resolution makes the committed sentence true.

### Item 2 (required). The reordering prose overclaims, in two different sentences.

Both are about coverage the fixture set genuinely HAS. Only the description is wrong, so no
assertion changes and nothing is split.

- The docblock calls the new all-three-groups fixture "the only spelling a reordering can be
  caught by". Measured over all six permutations of the three optional groups, the
  `IF EXISTS ONLY` fixture already kills three of the five non-identity reorderings on its
  own. The all-three line is the only one that answers for EVERY reordering — say that
  instead, which is both true and the stronger claim.
- The fixture comment says "three optional groups admit three pairwise orders". Three groups
  admit six orderings, five besides grammar order: three pairwise swaps and two rotations.
  The comment's own worked example, hoisting the qualifier to the front, is a rotation, not
  a pairwise swap, so the sentence contradicts its own illustration.

When rewording, do not reach for a bare positional anchor to point at the other fixture.
Name it by what it spells (`the IF EXISTS ONLY fixture`), per the anchor convention.

Probe: the permutation matrix — which fixture stops being counted under each of the six
orderings — pasted into the signal block.

### Item 3 (required). The paren branch's trailing whitespace atom is pinned by nothing.

The committed first alternative carries two whitespace atoms. The leading one, between
`ONLY` and the paren, is pinned by the `ONLY (accounts)` fixture. The trailing one, after
the paren, is pinned by nothing: delete it and every fixture in the file still matches, so
the suite stays green.

The spelling that catches it is `ALTER TABLE ONLY ( accounts ) DROP COLUMN updated_at;` — a
space after the open paren. PostgreSQL accepts it, the committed pattern admits it, and the
docblock ITSELF writes that exact form when it explains that `ONLY ( accounts )` is the whole
of what the server accepts there. So the round names the spelling as canonical in prose and
asserts it nowhere. One line closes it:

```
expect(alterations(['ALTER TABLE ONLY ( accounts ) DROP COLUMN updated_at;'])).toBe(1);
```

Reword the fixture comment to name both gaps around the paren rather than only the one after
`ONLY`.

Probe: delete the trailing `\s*` and show this line reds while the other ALTER fixtures stay
green.

### Item 4 (required). Correct this task file's own record.

Two claims in the round-2 signal block are wrong and will mislead a later round:

- The "Refuted, recorded so it is not re-raised" entry, per item 1. It refuted a spelling the
  docblock does not print. Rewrite it to say what was actually established, or strike it.
- Under item 1's matrix, "Before this round each of them killed nothing and the suite stayed
  green" is wrong for one of the three named orders. The matrix published in the same block
  shows the `IFEX+ONLY` row RED under the swap-`IF EXISTS`-with-qualifier column, so that
  order was already killed by a fixture round 1 added. The matrix is right; the prose above
  it contradicts its own cell.

### Dismissed this round, recorded so they are not re-raised

- No assertion holds the linear-time property down, so a revert to the short spelling passes
  every fixture and silently restores the quadratic curve. Dismissed: preemptive hardening
  whose failure mode is theoretical here, since the scanner reads static repo text and no
  line in either tree can reach the quadratic case. The docblock already says so outright.
- `ALTER TABLE ONLY ( public . accounts )` is pinned by a probe transcript rather than by the
  suite. Dismissed as low value: the qualifier group is shared and already pinned by the
  `public.` and all-three lines.
- No negative fixture asserts the `ALTER MATERIALIZED VIEW` / `ALTER VIEW` /
  `ALTER FOREIGN TABLE` bypass class stays unmatched. Dismissed: the new KNOWN LIMITS bullet
  records it as deliberate-evasion class, which is what round 1 asked for.
- The KNOWN LIMITS universal that every OTHER form of those three keywords is refused for the
  wrong relkind could not be re-derived without creating relations of the wrong relkind. Left
  as recorded; the bullet's conclusion does not depend on it.
- The docblock's list of where idempotency is spelled in this tree omits
  `CREATE INDEX IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS` and `DROP TABLE IF EXISTS`. Its
  load-bearing half — seventeen ALTER heads, every one bare — is correct and re-derived.
  Widen the list if you are in the paragraph anyway; not required.
- `COPY accounts FROM STDIN;` with no column list loads every column including the marker and
  is unseen, where the analogous positional INSERT is recorded in KNOWN LIMITS. Out of this
  task's scope; noted so a later COPY-arm round has it.

### Routed out rather than held

`assembledWrites` reads its heads from `ACCOUNTS_STATEMENT_RE` alone where the two sibling
arms iterate the shared head set, so an interpolated ALTER head against `accounts` is not
reported as an assembled write. `accountsColumnWriters` carries the same single-head walk.
Pre-existing, untouched by this round, and a file-wide decision rather than an ALTER-arm one.
Filed as `backend-assembled-writes-misses-alter-head` in `pending/`.

## Backend re-review signal (2026-09-21, commit 3200f742)

`backend(canary): the boundary is inert where the paren is required, and three orderings
are six` — one file,
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`, plus
this task file. `ALTER_ACCOUNTS_RE` is byte-identical to the one round 2 committed: a
comment-stripped comparison against HEAD shows the whole code delta is two added assertion
lines, with nothing removed or modified, and the file's regex-bearing lines hash the same
on both sides. Everything else in the diff is comment text.

All four hold items landed: item 1 on the hold's second resolution, items 2 and 3 as
prescribed, item 4 with one addition. Two rounds of adversarial verification against the
round's OWN new prose then found thirteen further defects of exactly the class the hold
exists to close, every one of them in text this round wrote. All thirteen are fixed and
listed under "Self-found", because the count is the useful signal and a round that reports
only its prescribed items would be hiding it.

### A methodological correction that bears on the earlier rounds' matrices

Every `alterations(...)` assertion in this file lives in ONE `it` block. A failing `expect`
aborts that block, so a plain run reports only the FIRST assertion to red and says nothing
about the rest; `1 failed | 24 passed` counts test blocks, not assertions inside the
failing one. The masking is real and was demonstrated rather than supposed: deleting the
first alternative's paren atom reds three ALTER fixtures, and a plain run names one.

So every exclusivity claim below was established by rewriting all 379 `expect(` in the file
to `expect.soft(` in a scratch copy and re-running, which reports every red. The
soft-asserted clean copy is 25/25 green, so the rewrite changes no verdict on its own.
Seventeen mutations were run that way, one fresh copy each: six relaxations of the guards
in the `ONLY` group, six changes to its paren branch, and the five non-grammar orderings.
Every red and green in the tables below is read off those runs.
Rounds 1 and 2 derived their per-fixture kill matrices at the regex level rather than from
vitest output, so those matrices are not wrong; but a matrix read off aborting output would
have been, and it is worth recording before a later round builds one that way.

### Item 1 (required) — resolution taken, and why that one

Took the hold's SECOND resolution. The boundary-free `ONLY\s*\(?\s*` citation stays, the
claim changes from "cost rather than grammar" to grammar and cost together, and the
negative fixture lands:

```
expect(alterations(['ALTER TABLE onlyaccounts DROP COLUMN updated_at;'])).toBe(0);
```

The first resolution is a two-character prose fix that leaves the tidy-to-short-form mutant
killing nothing. The second converts it into a killed one, and what it closes is a
correctness gap rather than a cost one: under the printed spelling a head naming a
DIFFERENT relation is counted as a write to this table.

Probe. Mutating the `ONLY` group to the boundary-free short form reds exactly the
`onlyaccounts` line and nothing else across all 379 soft assertions. Mutating to the
boundary-ful short form leaves `tests/eslint/` at 9 files / 135 tests, identical to
control, and three independently constructed differentials find zero divergence from the
committed group — 0 over 438,750 enumerated heads, 0 over 4,000,000 structured random
strings, and 0 over a 992,064-case sweep that includes an exhaustive codepoint sweep of the
slot after `ONLY`. The boundary-free form's divergences are all widenings of one family,
an `only`-leading identifier read as the keyword. Live server, aimed at relations that do
not exist so nothing executes: `relation "onlyaccounts" does not exist` and
`schema "onlypublic" does not exist`, neither a syntax error, so both are real statements
about other relations. The cost half was measured for the spelling actually printed rather
than carried over from the one round 2 measured: 2,975 ms at 100,000 spaces against 0.3 ms
for the committed group, growing 4x per doubling.

### Item 2 (required) — both sentences reworded, on a six-ordering matrix

The docblock no longer says the all-three line is "the only spelling a reordering can be
caught by"; it says it is the only one that answers for EVERY reordering. The fixture
comment's "three optional groups admit three pairwise orders" is now six orderings, five
besides grammar order, three pairwise swaps and two rotations, and the hoist it uses as its
worked example is named as one of the rotations. The other fixture is referred to by what
it spells, not positionally.

Probe, each ordering mutated in its own fresh copy and also evaluated at the regex level
over every ALTER string the file asserts. `.` = still counted, `RED` = that line stops
being counted.

| fixture | swap ONLY/qual | swap IFEX/ONLY | rot. B,C,A | rot. C,A,B (hoist qual) | swap IFEX/qual |
|---|---|---|---|---|---|
| each single-group line | . | . | . | . | . |
| each paren spelling | . | . | . | . | . |
| `IF EXISTS ONLY` | . | RED | RED | . | RED |
| `IF EXISTS ONLY public.` | RED | RED | RED | RED | RED |

So single-group lines answer for none of the five, the two-group line for exactly three —
the three that move `IF EXISTS` and `ONLY` relative to each other — and the three-group
line for all five. The two the two-group line does not reach are the two in which only the
qualifier moves, which is now what the fixture comment claims for the three-group line
instead of the broader "the only one that answers for the qualifier's POSITION" it claimed
before (see Self-found item 5).

### Item 3 (required) — the trailing atom pinned, and the whole branch's attribution stated

`ALTER TABLE ONLY ( accounts ) DROP COLUMN updated_at;` landed, and the comment now names
what each of the three paren lines does and does not answer for.

| change to the `ONLY` branch | lines that red |
|---|---|
| delete the run BEFORE the paren | `ONLY (accounts)` and `ONLY ( accounts )` |
| make that run mandatory | `ONLY(accounts)` alone |
| delete the run AFTER the paren | `ONLY ( accounts )` alone |
| make that run mandatory | `ONLY (accounts)` and `ONLY(accounts)` |
| drop the paren alternative | all three |
| split into fully-spaced and fully-closed-up styles | `ONLY (accounts)` alone |

The trailing atom is answered for by the new line and by nothing else, which is the hold's
item. The pre-existing `ONLY (accounts)` line turns out to carry no unique red bar against
any single-atom change to the branch, so the comment describes what it does hold rather
than crediting it with the leading atom. Live server, against a non-existent relation: the
spaced form parses, as do the closed-up and the fully-spaced ones.

### Item 4 (required) — this task file's own record corrected, plus a third error

Both claims the hold named are struck and restated in place, in the round-2 signal block:
the entry that recorded the convention lens's `onlyaccounts` finding as refuted (it tested
a spelling the docblock does not print, so the lens was right), and the sentence claiming
all three named reorderings killed nothing before round 2 (the kill matrix in that same
block shows one of them already RED).

The addition: the same sentence called those three reorderings "pairwise orders" when one
of them, hoisting the qualifier to the front, is a rotation. That is the same taxonomy slip
item 2 flags in the code, so leaving it standing in the file that prescribes the fix would
have been the convention-enforcing-fix-must-audit-its-own-replacement failure. Corrected
and flagged here rather than silently.

### Self-found: thirteen defects in this round's own prose

Found by two adversarial verification passes over the round's diff, plus my own re-read.
Each was re-verified by execution here rather than taken from the lens that raised it.

Pass 1, four:

1. **"The word boundary after `ONLY` is the whole of what keeps it out" was false.** In the
   committed group the `\b` is INERT: deleting it alone leaves the suite green with zero
   behavioural divergence over corpora to 992,064 heads, because the first alternative
   already requires `\(` and the second already requires `\s+`. A refuter then showed the
   required paren is inert alone too. They are redundant with each other, and the fixture
   reds only when BOTH go, which is what the one-alternative boundary-free tidy does.
2. **"Holding all of it takes three lines", with a unique attribution for the spaced
   form.** Against single-atom changes two lines hold the branch, and the spaced form never
   reds alone. Reworded to the table above.
3. **`ALTER TABLE IF EXISTS public.accounts` was quoted as a line "here"** when it is not a
   fixture at all; it is the migration spelling round 1 used as its demonstration. Worse,
   "every other line here still matches" is false for the negatives, which assert 0 and
   never match under any ordering. Now says a migration spelling the statement, and
   "unaffected".
4. **The reason given for why single-group lines catch no reordering was the wrong fact.**
   It is not that the exercised group is optional; it is that the other two match empty,
   and an empty match has no position. Both copies of the sentence fixed.

My own re-read before pass 1 returned, three:

5. The fixture comment called the three-group line "the only one that answers for the
   qualifier's POSITION". The two-group line catches two of the four qualifier-moving
   orderings. The true claim is narrower and is now what the comment makes. A pass-1
   refuter reached this independently.
6. "the short spelling as written there" pointed across a paragraph break, which the anchor
   convention says rots. Names the spelling now.
7. "the `onlyaccounts` fixture goes green again" implied the fixture had been red. It
   passes under that spelling; it was never red.

Pass 2, five:

8. **"Twice over" was an undercount: there are three guards, and the third is a single
   point of failure.** Relaxing the second alternative's required space to `ONLY\s*` — with
   the boundary and the paren both untouched — admits `onlyaccounts`, and the negative
   fixture is the ONLY assertion in the file that reds on it. This one matters beyond the
   arithmetic: the docblock's own reasoning that the gap before a paren is optional is a
   standing invitation to spell the second alternative the same way, and that guard has no
   redundancy behind it. Both the docblock and the fixture comment now say three guards and
   name which one is single-point.
9. **"Dropping either one alone changes nothing any statement can see" was false under the
   literal reading.** Deleting the paren ATOM, rather than making it optional, gives 6,000
   divergences and reds three fixtures. Now says relaxing rather than dropping, and names
   the two relaxations.
10. **"All three spellings are legal and all three are asserted" miscounts its own
    premise.** Two independently optional runs give four combinations. The fourth,
    `ONLY( accounts )`, parses on the server and is matched by the committed pattern, and
    is asserted nowhere. This is the round-2 item-2 class recurring in the same comment.
    The comment now says four are legal, three asserted, and why the fourth adds no red bar.
11. **The `UPDATE onlyaccounts` illustration did not hold distributively** across the three
    named siblings: `MERGE_TARGET_RE` cannot match an UPDATE at all, and
    `ACCOUNTS_STATEMENT_RE` has no target capture. The substantive point holds for all
    three and the `ONLY\s+` spelling claim is exact for all three; only the illustration
    over-reached. Restated per their jobs.
12. Ragged reflow, three instances: one the round's first edit left behind, and two the
    corrections for the items above introduced in their turn.
13. "`ONLY (accounts)` reds only alongside one of those two" carried no scope qualifier and
    is falsified by a change the very next clause describes. Now "never reds alone against
    such a change".

### Acceptance criteria

1. **Met.** `ALTER TABLE IF EXISTS accounts DROP COLUMN updated_at;` appended to
   `002_nullable_email.sql` reds `only the column-introducing migration alters
   accounts.updated_at itself`, reporting
   `{"002_nullable_email.sql#<module>": 1, "016_accounts_updated_at.sql#<module>": 3}`
   against the expected `{"016_accounts_updated_at.sql#<module>": 3}`, and no other arm
   sees it. Nine further plants ran in fresh copies, four red and five green:

   | planted in a migration | result |
   |---|---|
   | `ALTER TABLE IF EXISTS ONLY public.accounts DROP COLUMN updated_at;` | red |
   | `ALTER TABLE ONLY ( accounts ) DROP COLUMN updated_at;` | red |
   | `ALTER TABLE ONLY ( public . accounts ) ALTER COLUMN updated_at TYPE timestamptz USING NOW();` | red |
   | `ALTER TABLE ONLY(accounts) RENAME COLUMN touched_at TO updated_at;` | red |
   | `ALTER TABLE ONLY ( sessions ) DROP COLUMN updated_at;` | green (other table) |
   | `ALTER TABLE ONLY ( accounts ) DROP COLUMN pending_email;` | green (other column) |
   | `ALTER TABLE onlyaccounts DROP COLUMN updated_at;` | green (other relation) |
   | `ALTER TABLE ( accounts ) DROP COLUMN updated_at;` | green (not a legal statement) |
   | `ALTER TABLE hafsql.accounts DROP COLUMN updated_at;` | green (the read-only view stays out) |

   Every must-red plant was grammar-checked on the live server first, aimed at a relation
   confirmed absent from `pg_class`, so none is a statement PostgreSQL would reject anyway.
   Plant location changes no verdict: the same statements as a new `018_probe_plant.sql`
   give identical outcomes with only the reported key differing. And inside the allowed
   symbol rather than against the key set: the same statement in
   `016_accounts_updated_at.sql` raises its tally from 3 to 4 and reds, so the count is what
   refuses a further alteration in an allowed symbol.
2. **Met.** Clean tree green: the file's 25 tests, and 9 files / 135 tests under
   `tests/eslint/` including the standing anchor canary. `npm run typecheck` clean on both
   projects. `npm run lint` unchanged — it is `eslint src/` and does not reach this file, so
   the file was linted explicitly and is clean; the one pre-existing warning in
   `src/lib/author-supersession.ts` is untouched.
3. **Met.** Deleting only `(?:IF\s+EXISTS\s+)?` reds the three `IF EXISTS`-carrying
   fixtures and nothing else, confirmed by peeling assertions one at a time. The group is
   load-bearing against real migration text and not only fixtures: with those three lines
   neutralised AND a live `ALTER TABLE IF EXISTS accounts DROP COLUMN updated_at;` sitting
   in the migration tree, the suite goes green.

### Gates

The final diff is 89 lines added and 22 removed. A comment-stripped comparison shows the
whole code delta is the two assertion lines named under items 1 and 3; every regex-bearing
line hashes the same as HEAD, and no non-comment line was removed or modified.

The real `.githooks/pre-commit` passes on that diff, run against a throwaway
`GIT_INDEX_FILE` so the shared index was never touched. A green gate proves nothing on its
own, so the same hook was then run against a blob of this file carrying two deliberately
rotten comment lines (a task slug, a round and hold ordinal, a bare positional anchor, a
file:line cite and an acceptance-number redirect), staged into a second throwaway index
only: it rejected both lines and exited 1. An earlier pass had also sourced
`anchor_violation()` standalone with `ALLOW_MARKER` set explicitly to `anchor-allow`, fired
it on 12 rotten controls, one per arm, and seen it correctly decline 5 durable or
marker-exempt ones.

Reading every added comment line against the root conventions found no task slug, round
or hold ordinal, `Option X.N` label, file:line or SHA cite, or bare positional anchor;
every back-reference the round introduced resolves to a set named in the same container.
The only non-ASCII added is em dashes in code comments, which the no-em-dash rule exempts.

### Blast radius

The file exports nothing and nothing imports it; the only tests its edit can affect are
those under `tests/eslint/`, which were run whole and are green. The full backend suite was
not run: it carries known pre-existing failures and load-induced flakiness, so it would
have added noise and no signal for a change whose entire code delta is two assertions.

All mutation runs used isolated scratchpad copies of `backend/`. The shared checkout was
read only throughout and its md5 for this file was verified unchanged before and after
every probe.

### [TODO Architect] for triage, nothing applied

1. **The fourth paren spelling is legal, matched, and asserted nowhere.**
   `ALTER TABLE ONLY( accounts )` parses and the committed head matches it. It is left out
   because every change to the branch that reds it reds one of the three asserted spellings
   as well, and the comment says so; a fourth line would make the enumeration exhaustive at
   the cost of a fixture carrying no unique red bar. Prose decision, not a coverage gap.
2. **`ONLY (accounts)` carries no unique red bar against any single-atom change** to the
   branch, and reds alone only under a change splitting the branch into two styles. A prune
   candidate. Not pruned here: round 2 landed it and the architect reviewed it, so removing
   it is the architect's call rather than a tidy-up.
3. **The second alternative's required space is a single point of failure pinned by exactly
   one assertion.** Now documented in both the docblock and the fixture comment. A second
   line for it would be the preemptive hardening this project usually declines, so it is
   recorded rather than hardened.
4. **The abort-masking point above** applies to any future exclusivity claim about this
   file. No action asked; recorded so a later round reaches for the soft-assert method
   rather than reading exclusivity off an aborting run.
5. **Round 2's seven [TODO Architect] findings are carried forward untouched** — the
   catalog-qualified three-part name, the trigger/rule/routine arms scanning `migrations`
   only, the table-rebuild-and-rename idiom, the linear-time shape held by prose alone, the
   backslash truncation in `enclosingQuote` and `statementAt`, the three sibling heads'
   quadratic spelling, and `BOUND_TO_ACCOUNTS_RE`'s qualifier spacing. None was revisited
   this round; none is in this task's scope.
