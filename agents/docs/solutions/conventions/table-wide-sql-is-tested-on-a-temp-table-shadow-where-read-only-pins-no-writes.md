---
title: "A table-wide SQL script is tested on a temporary-table shadow, and READ ONLY cannot pin that its step writes nothing there"
date: 2026-10-05
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: medium
related_components:
  - database
applies_when:
  - "Testing a SQL file that names a table unqualified and acts on every row matching a predicate (an operator repair, a one-time DELETE or UPDATE), against the shared Postgres the backend suite runs on"
  - "Other test files commit rows of the shape the script matches, so a committed or unscoped run would race them"
  - "A test must pin that a step (a listing, a dry run, a count) writes nothing, and the step runs against a temporary table"
  - "Reaching for BEGIN READ ONLY as the proof that a statement does not write"
tags:
  - postgres
  - temporary-tables
  - test-isolation
  - read-only-transactions
  - transaction-id
  - operator-scripts
---

# A table-wide SQL script is tested on a temporary-table shadow, and READ ONLY cannot pin that its step writes nothing there

## Context

An operator repair under `backend/scripts` is a pair of SQL files: a listing and a `DELETE FROM accounts WHERE <shape>` that names the table unqualified and spans the whole table. Its test has to run both files verbatim, with no scoping added, and assert exact results: which rows go, that the listing writes nothing, and that a second delete removes nothing.

The backend suite runs on one shared database (the recipe in root `CLAUDE.md` points it at `pevo_app`), two files at a time, and other files commit rows of the very shape such a predicate matches mid-run (`backend/tests/routes/auth.test.ts` commits `(email NULL, orcid)` rows for its `ORCID_ALREADY_LINKED` specs, and two migration tests, `accounts-orcid-unique` and `accounts-custody-upgraded-align`, insert rows with neither a verify token nor a username outside any rollback). Every scoping trick the suite usually relies on fails here:

- A marker on the seeded emails (`email LIKE 'run_123_%'`) cannot be added to the script without testing a different statement, and an ORCID-path row has no email to mark.
- Running the file on public `accounts` inside `BEGIN ... ROLLBACK` stops it committing, but the unscoped DELETE still sees and row-locks other files' committed rows, so its `RETURNING` list and every count drift with whatever else is running, and a second run's `rowCount === 0` would be flaky under READ COMMITTED.

## Guidance

**Shadow the table in the test's own session.** On a dedicated pool connection, create a temporary table with the real one's shape, under the real one's name:

```ts
const client = await getAppPool()!.connect();
try {
  await client.query('CREATE TEMPORARY TABLE accounts (LIKE public.accounts INCLUDING ALL)');
  const { rows } = await client.query<{ shadowed: boolean }>(
    `SELECT to_regclass('accounts') = to_regclass('pg_temp.accounts') AS shadowed`,
  );
  if (!rows[0].shadowed) throw new Error('accounts does not resolve to the temporary table');
  // seed rows (autocommit), then:
  await client.query('BEGIN');
  try {
    await body(client, ids); // runs the script files verbatim
  } finally {
    await client.query('ROLLBACK');
  }
} finally {
  client.release(true);
}
```

`shadowAccounts` in `backend/tests/scripts/repair-locked-signup-rows.test.ts` is the worked instance. Each piece carries weight:

- **Name resolution.** Postgres searches the session's temporary schema before the `search_path` schemas whenever `pg_temp` is not listed explicitly, so the script's unqualified `accounts` reaches only the seeded rows. Counts are exact and nothing locks another file's rows. `INCLUDING ALL` copies the real table's defaults, CHECK constraints and unique indexes, so the seeds must satisfy the same rules.
- **The guard.** `to_regclass('accounts') = to_regclass('pg_temp.accounts')` refuses a connection where the name would reach the real table (a `search_path` that lists `pg_temp` after `public`). The seeds run in autocommit, so the guard is their only defence against committing into public `accounts`.
- **The rollback.** A script edited to name `public.accounts` explicitly bypasses the shadow; inside the rolled-back transaction it then fails the assertions and commits nothing.
- **`client.release(true)`.** A temporary table made outside a transaction lives as long as the session, and a pooled connection's session outlives the spec. `release(true)` destroys the connection. With plain `release()`, the pool hands the same connection to the next spec, whose `CREATE TEMPORARY TABLE` fails `42P07 relation "accounts" already exists`.

**Pin "writes nothing" with the transaction id, not READ ONLY.** PostgreSQL forbids INSERT, UPDATE, DELETE and MERGE in a read-only transaction only when the target is not a temporary table, so `BEGIN READ ONLY` around a step aimed at the shadow proves nothing: a listing turned into a writer (`WITH touched AS (UPDATE accounts ... RETURNING id) SELECT ...`) still runs. Observed on the dev server (16.13): an INSERT into a temporary table inside `BEGIN READ ONLY` succeeds and assigns a transaction id, while `CREATE TEMPORARY TABLE` inside one is refused with `25006`, which is one more reason the shadow is built before any such transaction starts.

Ask for the transaction id instead. Any row written to any table, temporary or not, assigns the top-level transaction an xid; a transaction that only does plain reads never gets one:

```ts
const res = await client.query(sql);
const xid = await client.query<{ xid: string | null }>(
  'SELECT txid_current_if_assigned()::text AS xid',
);
return { rows: res.rows, wrote: xid.rows[0].xid !== null };
```

`runStep` in the same file does this inside the transaction `shadowAccounts` opened after seeding, so the seeds' own writes are not counted. Pair the assertion with a positive control: the delete step's `wrote` is `true`, which shows the probe sees writes to the temporary table at all.

## Why This Matters

Without the shadow, a test of a table-wide script either alters the script to scope it, and then tests a statement nobody runs, or races every file that commits rows of the matched shape, and fails intermittently on someone else's data. A committed run can delete those rows outright.

Without the transaction-id probe, a READ ONLY wrapper is the obvious way to pin a read-only step, and against the shadow it is vacuous: it stays green while the step writes. The trap is silent because the same wrapper does refuse writes to permanent tables, so a quick check against a real table seems to confirm it.

## When to Apply

- Any test that runs a `backend/scripts` SQL file, or any other table-wide statement, verbatim against the shared database.
- Any "this step writes nothing" assertion where the step's target may be a temporary table. Against permanent tables READ ONLY works, but the transaction-id probe works for both.

Limits of the probe and the shadow:

- `nextval()` is non-transactional and usually assigns no xid (only a call that WAL-logs the sequence takes one), so a step that only burns sequence values can pass the probe.
- `LIKE ... INCLUDING ALL` copies a SERIAL column's default as written, `nextval('accounts_id_seq'::regclass)`, so seeding the shadow draws ids from the real table's sequence. Nothing reaches the real table, but its ids gain gaps, as with any rolled-back insert.
- The shadow covers unqualified references only. A schema-qualified statement reaches the real table, which is why the rollback stays.

## Examples

Mutation probes on a copy of the test confirmed:

- Dropping either conjunct of the delete's predicate, or of the listing's, turned the test red with the exact extra ids it caught.
- A listing rewritten as a data-modifying CTE turned the "writes nothing" spec red through `wrote === true`.
- The delete rewritten as `DELETE FROM public.accounts` turned the test red (the shadow's rows remained), and read-only counts of the real table before and after showed nothing committed.
- `client.release()` in place of `release(true)` turned the next spec red with `42P07`.

Operator SQL that is not a migration also needs a way into the database: the postgres service mounts only `backend/migrations`, so the operator pipes the file into the container (`docker compose exec -T postgres psql -U pevo -d pevo_app -v ON_ERROR_STOP=1 -f - < backend/scripts/<file>.sql`; the delete adds `--single-transaction`). The headers of `backend/scripts/repair-locked-signup-rows-count.sql` and `-delete.sql` carry the exact commands.

The shadow is not a mock carve-out under root `CLAUDE.md`: the test runs real Postgres behind the real `getAppPool()`, executes the script files verbatim, and its header says `Mock carve-out: none`.

## Related

- [test-teardown-wildcard-delete-shared-id-band-parallel-workers-2026-06-14.md](test-teardown-wildcard-delete-shared-id-band-parallel-workers-2026-06-14.md): the same race on shared `accounts` under parallel workers, fixed by scoping the DELETE to exact ids. That fix is unavailable when the unscoped DELETE is the code under test, which is the case this entry covers.
- [vitest-retry-fire-and-forget-side-effect-poisoning-2026-05-04.md](vitest-retry-fire-and-forget-side-effect-poisoning-2026-05-04.md): why a test's own DELETEs are scoped to its seeded rows, and why a retried spec must not inherit state a failed attempt committed.
- [sql-grammar-questions-are-settled-against-a-nonexistent-relation-2026-09-16.md](sql-grammar-questions-are-settled-against-a-nonexistent-relation-2026-09-16.md): another way to ask the shared server a question without touching real data, and what a subagent brief that reaches that server must forbid.
- [../architecture-patterns/recursive-chain-cte-two-phase-canonical-path-2026-06-10.md](../architecture-patterns/recursive-chain-cte-two-phase-canonical-path-2026-06-10.md): the other way to aim production SQL at synthetic rows, by rewriting its `FROM` targets with a drift guard. Its harness uses a private single-connection pool that `afterAll` ends, so a plain `release()` is safe there; on the shared `getAppPool()` it is not.
- [tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md](tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md): the rule behind the positive control and the mutation probes.
- [migrations-sole-schema-authority-2026-05-25.md](migrations-sole-schema-authority-2026-05-25.md): `backend/migrations` as the sole schema authority, with boot failing closed on an unapplied file.
