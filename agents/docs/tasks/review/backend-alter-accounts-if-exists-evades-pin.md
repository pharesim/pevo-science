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
