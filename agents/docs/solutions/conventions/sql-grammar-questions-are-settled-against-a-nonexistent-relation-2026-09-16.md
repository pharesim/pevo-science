---
title: "A SQL grammar question is settled by aiming the statement at a relation that does not exist, not by reading the grammar"
date: 2026-09-16
category: conventions
module: backend/tests/eslint + backend/migrations
problem_type: convention
component: testing_framework
severity: medium
related_components:
  - database
  - development_workflow
  - agent_coordination
resolution_type: workflow_improvement
applies_when:
  - "Writing or widening a regex, canary or parser that must recognise a set of SQL spellings, where `is this legal?` decides what the pattern admits"
  - "Reviewing a claim that a SQL spelling is or is not accepted, especially one already stated as settled in a docblock or a hold block"
  - "A verification question is answerable by a live server the project already runs, but the obvious way to ask it would mutate real data"
  - "Briefing a subagent to investigate anything touching a live database, where the brief must say what is off limits and offer a sanctioned alternative"
  - "A docblock is about to assert a grammar fact that later readers will extend the pattern by trusting"
symptoms:
  - "A hold block or docblock records that a grammar fact was reasoned from documentation rather than observed"
  - "A proposed pattern mirrors a sibling and would admit a spelling no server accepts"
  - "A pattern requires whitespace in a position where the grammar makes it optional, so a legal spelling evades"
  - "A relation-kind claim is stated for a whole family of statements when only one form of it actually reaches the relation"
tags:
  - postgres
  - sql-grammar
  - canary-tests
  - source-discipline
  - verification
  - empirical-verification
  - read-only-probing
  - subagent-briefing
---

# A SQL grammar question is settled by aiming the statement at a relation that does not exist, not by reading the grammar

## Context

`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` refuses
any statement that rewrites `accounts.updated_at` outside the two signup finalizes. One of
its arms detects `ALTER TABLE accounts` heads with a regex, because a `DROP COLUMN`, a
`RENAME COLUMN` onto the name, or an `ALTER COLUMN ... TYPE ... USING <expr>` lands every
row at a new value while being neither an UPDATE, an INSERT nor a MERGE.

Deciding which head spellings that regex must admit is a question about PostgreSQL's
grammar, not about this codebase. An earlier review round answered it by reasoning from the
documented grammar, and was honest enough to record the fact in its own hold block:
acceptance of the parenthesised `ONLY ( name )` target "was reasoned from the documented
grammar, not a live server."

The repo runs a real PostgreSQL 16 in `pevo-postgres-1`, holding real development data. So
the grammar was answerable by observation all along. What stopped it being answered that
way is that the obvious way to ask — run the statement — is destructive: the statements in
question are `DROP COLUMN` and `ALTER COLUMN ... TYPE`, aimed at the live `accounts` table.

## Guidance

**Ask the server, not the documentation, and ask it in a way that cannot execute. Aim the
candidate statement at a relation that does not exist, and read which error class comes
back.**

```bash
docker exec pevo-postgres-1 psql -U pevo -d pevo_app -X -q \
  -c "ALTER TABLE pevo_nonexistent_zzz DROP COLUMN updated_at"
```

- `ERROR: syntax error at or near ...` -> the grammar **rejects** that spelling.
- `ERROR: relation "..." does not exist` -> the grammar **accepts** it. The parser was
  satisfied and the statement died later, at name resolution.

The whole technique rests on the fact that parsing precedes name resolution. A statement
that reaches "does not exist" has already been parsed successfully, which is exactly the
question being asked, and it has touched nothing, because there was nothing to touch.

Four rules make it trustworthy.

**1. Keep a third bucket, and read the error text rather than pattern-matching for two
outcomes.** Not every rejection is a syntax error and not every non-syntax error means
acceptance. `ALTER TABLE otherdb.public.x ...` answers `cross-database references are not
implemented`, which is a semantic refusal of a statement the parser accepted. A permission
error, a type error, or an unexpected message all belong in an `OTHER` bucket that gets
read by eye, not silently scored as acceptance. A two-way `case` over the output will
quietly misclassify the interesting cases, which are the ones worth running the probe for.

**2. Use a relation name nothing could collide with.** A probe aimed at a name that turns
out to exist stops being a probe and becomes the destructive statement it was standing in
for. A long, obviously-synthetic suffix is the whole guard.

**3. When the question genuinely needs a real relation, use a temp table inside a
transaction you roll back.** Relation-kind questions cannot be answered against a
non-existent relation, because the relkind check happens after name resolution. `CREATE TEMP
TABLE` is session-local and reaches no real object, and wrapping it in `BEGIN; ... ROLLBACK;`
bounds it further. That is how `ALTER MATERIALIZED VIEW <ordinary table> RENAME COLUMN`
was shown to succeed while its `DROP COLUMN` form is refused for the wrong relkind.

**4. State in the brief which database is off limits, by name.** A subagent told only "do
not write files" will still happily run DDL against a live dev database, because it did not
read that as writing. Name the database, say no DDL or DML against any real relation even
inside a transaction meant to be rolled back, and hand over the non-existent-relation
recipe so the agent has a sanctioned way to get its answer.

## Why This Matters

The technique is cheap enough that there is no reason to reason instead, and in this round
reasoning was wrong twice in the same paragraph.

The review round had proposed mirroring a sibling pattern that admits a parenthesised target
*outside* its `ONLY` group. Observation showed that a bare `ALTER TABLE (accounts)` is a
syntax error: PostgreSQL's `relation_expr` admits `ONLY ( name )` and never a bare
`( name )`. Copying the sibling would have admitted a statement no server will run. And both
the proposed spelling and the obvious alternative required whitespace after `ONLY`;
observation showed `ALTER TABLE ONLY(accounts)` parses, so both would have stayed blind to a
legal spelling of exactly the statement the arm exists to catch. Neither error is the kind
that careful reading catches, because both are cases where the documented grammar is being
read correctly and applied to the wrong construct.

There is a second, sharper reason in a file like this one. A source-discipline canary exists
to stop unverifiable prose from standing in for verification. When such a file's own docblock
asserts a grammar fact, the assertion is load-bearing: later readers extend the pattern by
trusting it. A docblock that says a spelling is a syntax error, and is wrong, launders the
defect it was written to prevent. Grounding those assertions in an observation that can be
re-run in one command is the difference between a comment a reader trusts and a comment a
reader can check.

## When to Apply

- Writing or widening any regex, canary, or parser that must recognise a set of SQL
  spellings, where the question "is this legal?" decides what the pattern admits.
- Reviewing a claim that a SQL spelling is or is not accepted, especially one stated in a
  docblock or a hold block as settled.
- Any time a verification question is answerable by a live server the project already runs,
  but the obvious way to ask it would mutate real data.
- Briefing a subagent to investigate anything touching a live database, where the brief needs
  to say what is off limits and hand over a sanctioned alternative.

## Examples

**Grammar questions answered in one pass**, each statement aimed at a relation that does not
exist, so nothing ran:

| spelling | verdict |
|---|---|
| `ALTER TABLE IF EXISTS ONLY public.accounts ...` | parses |
| `ALTER TABLE ONLY IF EXISTS accounts ...` | syntax error |
| `ALTER TABLE ONLY (accounts) ...` | parses |
| `ALTER TABLE ONLY(accounts) ...` | parses |
| `ALTER TABLE ONLY ( public . accounts ) ...` | parses |
| `ALTER TABLE (accounts) ...` | syntax error |
| `ALTER TABLE accounts * ...` | parses |
| `ALTER TABLE pevo_app.public.accounts ...` | parses, same relation |
| `ALTER TABLE otherdb.public.accounts ...` | cross-database references are not implemented |

The loop, with the three-bucket discrimination that rule 1 asks for:

```bash
probe() {
  out=$(docker exec pevo-postgres-1 psql -U pevo -d pevo_app -X -q -c "$1" 2>&1 | tr '\n' ' ')
  case "$out" in
    *"syntax error"*)  v="SYNTAX-REJECT" ;;
    *"does not exist"*) v="PARSES-OK" ;;
    *)                  v="OTHER: $out" ;;   # read this one by eye
  esac
  printf '%-16s %s\n' "$v" "$1"
}
```

**A relkind question, which needs a real relation**, so a temp table inside a rolled-back
transaction stands in for one:

```sql
BEGIN; CREATE TEMP TABLE zp(c int);
ALTER MATERIALIZED VIEW zp RENAME COLUMN c TO d;   -- succeeds: no relkind check on RENAME
ALTER MATERIALIZED VIEW zp DROP COLUMN c;          -- ERROR: "zp" is not a materialized view
ROLLBACK;
```

That pair is what turned "a materialized-view spelling might reach an ordinary table" into
the precise statement that landed in the file's KNOWN LIMITS: `RENAME COLUMN` is the single
form of `ALTER MATERIALIZED VIEW`, `ALTER VIEW` and `ALTER FOREIGN TABLE` that reaches an
ordinary table, and it is exactly the form that moves another column onto the guarded name.

## Related

- `postgres-e-string-backslash-v-not-recognized-2026-05-20.md` is the closest precedent and
  the reason this entry says "second instance" rather than "a new idea". There, an E-string
  escape charset was specified from the documented escape table by both the architect and the
  implementer, shipped, and was wrong: `\v` is not a recognized PostgreSQL escape and passed a
  literal `v`. Same root principle, different mechanism — that entry round-trips a value
  through `encode(...)` to observe byte behaviour, this one reads an error class to observe
  parse behaviour. Two recorded cases now of a PostgreSQL claim reasoned from documentation
  and later overturned by asking the server, which is enough to call it a shape rather than
  an accident.
- `verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` and
  `verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md` are the
  repo-wide parent rule this is an instance of: do not let a load-bearing margin rest on a
  claim from documentation or authority when the claim is cheaply checkable. This entry adds
  the case where checking it looks destructive, and the technique that makes it not.
- `correlated-subquery-to-cte-collapse-is-index-dependent-2026-06-14.md` is the same posture
  in the query-planner domain: what the engine actually does is not derivable from the SQL.
- `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel-2026-09-15.md` and
  `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md`
  are the two preceding review rounds on this same canary, on sentinel semantics and on
  comment normalization. This round is the grammar-acceptance axis of the same file: which
  spellings the detection patterns must admit at all.
- `backtracking-fix-must-bound-every-quantifier-whose-class-overlaps-2026-09-14.md` is the
  cost rung for patterns in these canaries. Widening a head pattern to admit a newly-observed
  spelling is exactly the moment to re-check that rung, because the admission that makes the
  grammar right can make the match quadratic: admitting an optional paren between two
  unbounded whitespace runs did precisely that here, and was respelled as two alternatives
  with the paren required in one.
