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

The three bolded columns are the three pairwise orders the hold named. Before this
round each of them killed nothing and the suite stayed green; the new line is the
only fixture that answers for any of them, and it answers for all three. Each of
the ten mutants was also run through vitest in its own copy: nine red exactly one
test, and the tenth is discussed under "Self-found".

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

**Refuted, recorded so it is not re-raised.** The convention lens held that the
docblock's "the two admit exactly the same statements" is false, offering
`ALTER TABLE onlyaccounts DROP COLUMN updated_at;` as the counter-example. Both
spellings reject that string identically — the `\b` after `ONLY` blocks it in each —
and an exhaustive differential over 1,220,700 constructed head strings finds zero
divergence between them. The claim stands as written. The same lens reported that
every other falsifiable claim in the diff reproduces and that the anchor gate fires
on none of the added lines, which matches the checks run here.

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
5. **`BOUND_TO_ACCOUNTS_RE` still spells the schema qualifier `(?:public\.)?`** where
   its siblings spell `(?:public\s*\.\s*)?`. Unchanged this round, already filed as its
   own pending backend task; carried here only so the list is complete.
