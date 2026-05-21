# BACKEND-INITAPPDB-SCHEMA-DRIFT-FIX — Remove initAppDb's CREATE TABLEs; migrations are sole schema authority

**Owner:** backend
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-3-data-integrity-guardian.md` + `chunk-3-data-migrations-reviewer.md` + `chunk-7-reliability-reviewer.md`)
**Priority:** P0

## Context

Two interacting bugs produce a P0 schema-drift hazard on fresh deploys:

1. `backend/src/app-db.ts` `initAppDb()` runs on every startup and issues `CREATE TABLE IF NOT EXISTS accounts (… email TEXT NOT NULL …)`. The header comment now acknowledges this as "dual-source schema path for fresh-container boots" — the drift is documented, but not resolved.
2. `backend/migrations/002_nullable_email.sql` drops `NOT NULL` from `accounts.email`. Because `initAppDb` already created the table with `NOT NULL`, the migration's `ALTER COLUMN ... DROP NOT NULL` no-ops on the IF-NOT-EXISTS-already path **only if** the column already lacks the constraint — but on fresh deploys, the column was just created WITH the constraint by `initAppDb`.
3. `deploy.sh cmd_restart` runs `cmd_up; cmd_migrate` — backend boots before migrations run. The bootstrap path wins.

Net effect on a fresh deploy: ORCID-only signups fail because `email IS NULL` violates `NOT NULL`. Constraint sets diverge silently by deploy order. Every future migration is at risk of the same no-op trap.

Also adjacent: `initAppDb` is missing the `last_digest_block_non_negative` CHECK constraint that `001_schema.sql:10` defines (audit P1, same chunk).

## Goal

Migrations become the single source of truth for the application schema.

1. **Delete** the `CREATE TABLE IF NOT EXISTS` blocks from `initAppDb()`. Keep only application-level initialization that is genuinely runtime-only (cache priming, schema-version probe, etc., if any).
2. **Reorder** `deploy.sh cmd_restart` so migrations run before `cmd_up`. The migrate target should be idempotent (it already is) so re-running it on top of a previously-migrated DB is a no-op.
3. **Add startup probe**: on backend boot, query for the presence of a critical migration marker (e.g., a row in a `schema_migrations` tracking table, or `pg_attribute` for a column added in a known recent migration). If absent, fail loud — do not auto-create.
4. **Document** the rule in `agents/docs/ARCHITECTURE.md` § migrations: "Migrations are authoritative. Application code never issues DDL on startup."

The schema-migrations tracking table itself is a P1 audit finding (chunk-3-data-migrations-reviewer.md "no schema_migrations tracking"). Decide here whether to introduce that table as part of this task or as a follow-up.

## Non-goals

- Backfilling DOWN scripts for existing migrations. Separate audit P1.
- Migrating to a heavier framework (knex, Prisma migrations, sqitch). The current `.sql` + numeric-prefix scheme is fine if migrations are authoritative.
- Adding `CONCURRENTLY` to index migrations retroactively. Separate concern.

## Acceptance

- `backend/src/app-db.ts` `initAppDb()` issues zero `CREATE TABLE` statements.
- `deploy.sh cmd_restart` runs migrations before bringing the backend up.
- A test verifies that on a freshly-created Postgres database, an ORCID-only signup (where `email IS NULL`) succeeds after running migrations cold.
- Backend startup logs a clear error if the schema is older than the code's expected migration set.

## References

- Audit chunks:
  - `.context/audit-2026-04-21/chunk-3-data-integrity-guardian.md` (P0: initAppDb schema drift).
  - `.context/audit-2026-04-21/chunk-3-data-migrations-reviewer.md` (P0: same finding from migrations lens).
  - `.context/audit-2026-04-21/chunk-7-reliability-reviewer.md` (P1: cmd_restart applies migrations after backend is already up).
