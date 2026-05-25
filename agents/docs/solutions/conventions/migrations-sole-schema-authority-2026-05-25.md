---
title: "Migrations are the sole schema authority — application code issues no startup DDL; boot fails closed on unapplied migrations"
date: 2026-05-25
category: conventions
module: backend/src
problem_type: convention
component: database
severity: high
applies_when:
  - "writing a migration that adds or alters a column or table"
  - "reviewing a PR that touches backend/migrations/"
  - "diagnosing a BootFatalError about schema_migrations at startup"
  - "bootstrapping a fresh dev, CI, or prod container"
  - "auditing app-db.ts or any startup path for accidental DDL"
tags:
  - migration
  - schema-migrations
  - boot-verification
  - fail-closed
  - sole-source-of-truth
  - startup-ddl
  - schema-drift
  - boot-fatal-error
supersedes:
  - migration-and-initappdb-dual-source-schema-2026-05-05.md
---

# Migrations are the sole schema authority — application code issues no startup DDL; boot fails closed on unapplied migrations

## Context

Prior to commit `ceb90317` (task `backend-initappdb-schema-drift-fix`), `backend/src/app-db.ts` exported an `initAppDb()` function that issued `CREATE TABLE ... IF NOT EXISTS` blocks at every startup. This allowed a fresh container to boot before `./deploy.sh migrate` ran. The old guidance said: "when you add or alter a column, update BOTH `initAppDb()` AND the migration file in the same commit."

That model caused silent schema drift: `initAppDb()` would shadow-create tables using its hard-coded column list. If a migration added a column that `initAppDb()` did not include, a fresh container would boot successfully but with stale-shaped tables. Audit and notification INSERT statements then silently dropped rows because the expected columns were missing — a failure mode invisible to operators and to monitoring.

Commit `ceb90317` removed all startup DDL. The dual-source model is gone.

## Guidance

**`backend/migrations/NNN_*.sql` files are the sole source of truth for the app-DB schema. Application and startup code issues zero DDL.**

`backend/src/app-db.ts` exports two functions related to schema state:

- `verifyAppDbMigrations()` — production entry point; resolves the pool from `getAppPool()` and delegates to the inner function.
- `verifyAppDbMigrationsWith(p: Queryable)` — inner implementation; exported for tests so a single-client connection can exercise the missing-table and missing-row branches without touching the shared DB.

Neither function creates tables, alters columns, or issues any DDL. Their docstrings state explicitly: "Migrations are the sole source of truth for the application schema... application code never issues DDL on startup."

**Boot contract (fail-closed):**

At boot, `verifyAppDbMigrations()` performs two checks using `listExpectedMigrations()` (reads `backend/migrations/*.sql` from disk, lexicographically sorted by numeric prefix):

1. Verifies the `schema_migrations` tracking table exists via `to_regclass`. If it is missing, throws `BootFatalError` with the message: "Run `./deploy.sh migrate` before starting the backend."
2. Verifies every `*.sql` filename on disk has a corresponding row in `schema_migrations`. If any are missing, throws `BootFatalError` listing the unapplied filenames.

If `APP_DATABASE_URL` is unset, `verifyAppDbMigrations()` returns silently with a warning — the backend can run without the app DB; routes that need it 500 with a clear error rather than crashing the whole process at boot.

**The load-bearing rule for schema changes:** when adding or altering schema, write ONLY the migration file under `backend/migrations/`. Do NOT add `CREATE TABLE` or `ALTER TABLE` to `app-db.ts` or any startup path. Fresh-container support comes exclusively from running migrations (`./deploy.sh migrate`), not from shadow DDL.

## Why This Matters

The old dual-source model produced deployment-path-dependent schema drift. A container that booted before migrations ran would inherit the `initAppDb()` column list. Subsequent migrations added columns that `initAppDb()` did not know about; re-deploying the same image re-created the table in the original shape, silently discarding data and dropping rows from audit/notification writes.

The fail-closed boot model makes this class of error impossible: a container that boots before `./deploy.sh migrate` now aborts loudly with a `BootFatalError` naming the unapplied migrations. An operator gets a clear, actionable error instead of a silently degraded system.

Adding DDL back to startup code — even with `IF NOT EXISTS` guards — reintroduces the exact drift this change eliminated. The `IF NOT EXISTS` guard does not protect against column-list staleness; it only prevents the `CREATE TABLE` from raising an error when the table already exists.

## When to Apply

- **Adding a column or table:** create a new `backend/migrations/NNN_*.sql` with the DDL. Stop there. Do not touch `app-db.ts`.
- **Reviewing a schema-touching PR:** confirm the migration file is present and correctly numbered so the boot check passes. Flag any new startup-time DDL (in `app-db.ts` or any other startup path) as a finding — it is the anti-pattern, not an acceptable fallback.
- **Diagnosing a `BootFatalError` at startup:** the error message names the missing migration files. Run `./deploy.sh migrate` to apply them.
- **Bootstrapping a fresh container (dev/CI/prod):** run `./deploy.sh migrate` before starting the backend. There is no alternative DDL path.

## Examples

### Correct — migration-only schema change

```sql
-- backend/migrations/007_add_orcid_to_users.sql
ALTER TABLE users ADD COLUMN orcid TEXT;
INSERT INTO schema_migrations (filename) VALUES ('007_add_orcid_to_users.sql')
  ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();
```

`app-db.ts` is not touched. `verifyAppDbMigrations()` picks up the new file on disk and confirms the `schema_migrations` row is present at boot.

### Wrong — companion DDL added to startup code (do not do this)

```typescript
// backend/src/app-db.ts  ← DO NOT ADD THIS
export async function verifyAppDbMigrations(): Promise<void> {
  // ...
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      orcid TEXT          -- added to match migration 007
    )
  `);
}
```

This reintroduces dual-source drift. The column list in the `CREATE TABLE` will diverge from future migrations. A fresh container that boots before `./deploy.sh migrate` will silently shadow-create the table in its current shape; subsequent migrations that add columns will not fail (because `ALTER TABLE` works on the existing table), but any container that re-runs `initAppDb()`-style code will revert to the stale shape on the next redeploy. The fail-closed boot guarantee is lost.

## Related

- `agents/docs/solutions/conventions/typescript-template-literal-sql-backtick-pitfall-2026-05-15.md` — SQL-authoring sibling doc; covers backtick vs. tagged-template pitfalls when writing migration SQL in TypeScript contexts.
- Task `backend-initappdb-schema-drift-fix` + commit `ceb90317` — removed the dual-source `initAppDb()` model and introduced `verifyAppDbMigrations()` / `verifyAppDbMigrationsWith()`.
- Root `CLAUDE.md` "Local Dev Deployment" — `./deploy.sh migrate` is the canonical command for applying migrations; `./deploy.sh restart` rebuilds, restarts, and migrates in one step.
- `agents/docs/ARCHITECTURE.md` (Migrations section) — the authoritative cross-reference that the `BootFatalError` message itself points at.
- `backend/tests/app-db-fresh-migrations.test.ts` — the guardrail test covering the cold-migrations path; exercises the `BootFatalError` branches that the old `initAppDb()` DDL would have bypassed.
