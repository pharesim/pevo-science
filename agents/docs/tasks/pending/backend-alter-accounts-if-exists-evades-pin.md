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
