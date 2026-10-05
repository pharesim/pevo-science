# The trigger, rule and routine arms read one tree where the ALTER arm beside them reads two

**Owner:** backend
**Created:** 2026-09-21
**Priority:** low

Routed out of the round-1 architect review of `backend-assembled-writes-misses-alter-head`,
whose sweep re-found it. It is the third independent rediscovery: it sits open on
`backend-accounts-updated-at-writer-canary`'s `[TODO Architect]` residual list, where two
passes ranked it highest, and the `ALTER TABLE IF EXISTS` review carried it forward
undecided. The user decided it on 2026-09-21: file it as its own small task. This file
supersedes those open entries, so it is not triaged again there.

## Why

In `backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`
both routine arms call `routineSites(migrations)`: the arm that refuses any trigger or
rule bound to `accounts`, and the arm that refuses any trigger, rule or stored routine
without an exact `file#KIND name` exemption. The ALTER arm next to them reads
`accountsColumnAlterations([...sources, ...migrations])`.

The file's own prose says the routine arm is the ONLY catcher of a PL/pgSQL
`NEW.updated_at := now()`, because the column pattern does not read that assignment. So
a `CREATE FUNCTION ... NEW.updated_at := now()` plus a `CREATE TRIGGER ... ON accounts`,
run from a `src` file through `pool.query`, is refused by nothing: reported 25/25 green
by plant in three separate reviews. The narrow wiring reads as unintended rather than
decided, since nothing in the file argues for it and the header's claim that nothing in
the application writes the column leans on the opposite.

This is a widening of an existing arm's input, not a new detection branch.

## Scope

1. Hand both routine arm call sites `[...sources, ...migrations]`, matching the ALTER
   arm. The backend sweep reported this green on the clean tree; re-measure it rather
   than taking that from this file.
2. The two arms' test titles and failure messages say "migration". Reword whatever the
   widening makes false, and nothing else.
3. Check from the code how a routine created inside a TypeScript template is read: the
   bind test runs over `statementAt`'s text, and in a `.ts` file that read ends at the
   enclosing quote rather than at a `;`. Say what that does to a `CREATE TRIGGER` whose
   `ON accounts` clause sits on a later line of the same template, by fixture.
4. If any docblock states the routine arms' tree (the header, the KNOWN LIMITS entries,
   the `READ_FROM_HEADS` docblock's sentence about the exemption arm reading the
   migrations), make it agree with the widened wiring.

## Acceptance criteria

1. A trigger function writing `NEW.updated_at := now()` and a trigger binding it
   `ON accounts`, planted in a `src` file as `pool.query` templates, red the suite.
   Demonstrated by plant in a scratch copy, with the 25/25 green result at the parent
   commit as the control.
2. The clean tree stays green, and `ROUTINES_THAT_CANNOT_REACH_ACCOUNTS` is unchanged.
3. A fixture reds when either call site is pointed back at `migrations` alone, so the
   widening is pinned rather than asserted. If the call sites cannot be reached from a
   fixture (the file already says so of another arm's file set), say that plainly in the
   signal block instead of adding a fixture that pins something else.

## Out of scope

`BOUND_TO_ACCOUNTS_RE`'s qualifier spacing is `backend-trigger-bind-qualifier-admits-no-spacing`.
The bind read reaching `LITERAL_CAP`, and an `EXECUTE` string joined across lines, were
dismissed in the same triage: nothing changes in outcome while the exemption list is
empty.
