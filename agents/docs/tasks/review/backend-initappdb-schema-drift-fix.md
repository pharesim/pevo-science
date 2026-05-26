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

## Backend parent re-dispatch (2026-05-21) — HELD PENDING FIXES

The first dispatched worker (worktree-agent-ae982a5937ebf2706, commit 17e5f577) misinterpreted the task direction and produced a solution that runs **opposite** to acceptance criterion 1. Specifically:

- The worker **kept** the `CREATE TABLE IF NOT EXISTS` blocks in `initAppDb()` and synced them with migration 002's `DROP NOT NULL` on `accounts.email` plus migration 001's `last_digest_block_non_negative` CHECK constraint (using a `pg_constraint` existence guard since Postgres lacks `ADD CONSTRAINT IF NOT EXISTS`).
- The worker filed a `[TODO Architect]` note proposing to **document** dual-source-of-truth as a permanent pattern in `ARCHITECTURE.md § Migrations`, pointing at a new solutions doc `migration-and-initappdb-dual-source-schema-2026-05-05.md`.

Both of these treat the dual-source bootstrap path as a feature to preserve, when the task is explicitly to **eliminate** it (Goal #1: "Delete the `CREATE TABLE IF NOT EXISTS` blocks from `initAppDb()`"). Acceptance criterion 1 is unambiguous: "`backend/src/app-db.ts` `initAppDb()` issues zero `CREATE TABLE` statements."

The worker's other deliverables ARE useful and worth keeping in a future implementation:

- `deploy.sh cmd_restart` reorder (migrations run before backend boots — matches Goal #2).
- `backend/migrations/008_schema_migrations_tracking.sql` (informational tracking table per migration — partially matches Goal #3, modulo the startup probe).

The worker's branch (`worktree-agent-ae982a5937ebf2706`) is NOT being merged. A fresh worker will be dispatched to implement the task as written.

### Re-dispatch brief for next worker

- **Primary goal:** `initAppDb()` issues **zero** `CREATE TABLE` and **zero** `ALTER TABLE` statements. The function body should reduce to whatever genuinely-runtime initialization remains after schema DDL is removed (likely just the pool getter, plus a `schema_migrations` probe per Goal #3). If nothing genuinely-runtime remains, the function can be deleted entirely and its callers removed.
- **Migration 008 from prior worker is OK to reuse** but should be paired with a startup probe that reads from it and fails loud if expected migration N is missing.
- **deploy.sh reorder from prior worker is OK to reuse**.
- **Architect TODO for ARCHITECTURE.md § Migrations** should say "Migrations are authoritative. Application code never issues DDL on startup." — NOT a dual-source pattern doc.
- **Acceptance test**: a fresh-DB test (per-test BEGIN/ROLLBACK is fine) that drops all tables, runs migrations cold, runs `initAppDb()`, and asserts an ORCID-only signup (`email IS NULL`) succeeds. The test must fail if `initAppDb()` is ever resurrected with a `CREATE TABLE` block.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend implementer signal (2026-05-21)

Re-dispatch landed. `initAppDb()` is gone entirely; it has been replaced by `verifyAppDbMigrations()` which performs a schema-version probe only (no DDL). All callers (`backend/src/index.ts`) and incidental docblock references (`src/jobs/custody-audit-retention-sweep.ts`, `src/startup-checks.ts`, `src/lib/broadcast-error.ts`, `tests/jobs/custody-audit-retention-sweep.test.ts`, `tests/startup-checks.test.ts`, `tests/routes/ipfs-pin-durability.test.ts`) updated to the new symbol.

Changes:

- `backend/src/app-db.ts`: removed every `CREATE TABLE` / `ALTER TABLE` / `CREATE INDEX` block. The file now exports `getAppPool`, `closeAppPool`, and a new pair `verifyAppDbMigrations()` / `verifyAppDbMigrationsWith(queryable)`. The probe reads `backend/migrations/*.sql` from disk, SELECTs `schema_migrations.filename`, and throws `BootFatalError` listing any missing files. Existence check on the tracking table itself via `to_regclass('public.schema_migrations')` covers the never-migrated DB case.
- `backend/migrations/008_schema_migrations_tracking.sql`: creates `schema_migrations (filename PK, applied_at)` and backfills rows for 001 through 008. Each migration 009+ self-records via an idempotent UPSERT at the end of the file.
- `backend/migrations/009_audit_log_fk_anonymize.sql`: appended the self-record UPSERT line.
- `deploy.sh cmd_restart`: reordered to bring up postgres / redis / ipfs, run migrations, THEN start the backend. Backend now always boots against an already-migrated schema.
- `backend/tests/app-db-fresh-migrations.test.ts`: four real-Postgres sub-tests using `BEGIN; DROP SCHEMA public CASCADE; CREATE SCHEMA public; <apply all migrations>; <assertions>; ROLLBACK`. Covers (a) ORCID-only INSERT succeeds against cold-migrated schema, (b) `schema_migrations` records every file on disk, (c) `verifyAppDbMigrationsWith` throws `BootFatalError` when `schema_migrations` is missing, (d) same throw when a migration file is absent from the row set (with the file name in the message).

Verification:

- `npm run typecheck`: pass.
- `npm run lint`: pass (one pre-existing unrelated warning).
- Targeted test run: 4/4 passed on `tests/app-db-fresh-migrations.test.ts`; sibling sanity-check on `tests/migrations/accounts-orcid-unique.test.ts` and `tests/routes/ipfs-pin-durability.test.ts` also pass.
- `grep -c "CREATE TABLE" backend/src/app-db.ts` returns 0. No `ALTER TABLE`, `CREATE INDEX`, or `CREATE TRIGGER` in app-db.ts either.

[TODO Architect] `agents/docs/ARCHITECTURE.md` needs a `§ Migrations` paragraph that states: "Migrations are authoritative. Application code never issues DDL on startup. The backend's `verifyAppDbMigrations` probe in `backend/src/app-db.ts` reads `schema_migrations` on boot and aborts via `BootFatalError` if any `backend/migrations/*.sql` file present on disk lacks a row there. Operators must run `./deploy.sh migrate` (or apply the migration set manually against `APP_DATABASE_URL`) before starting the backend; `deploy.sh cmd_restart` enforces that order." Do NOT document a dual-source pattern; that path is explicitly removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Architect review (2026-05-26) — HELD PENDING FIXES

Reviewed via `/ce-code-review` on commit `ceb90317` (correctness, adversarial,
reliability, data-migrations, testing, maintainability, project-standards,
kieran-typescript, learnings) plus a deployment Go/No-Go pass. The core fix is
sound: `initAppDb` is gone, `verifyAppDbMigrations` aborts boot loudly on a
schema gap, `deploy.sh` gates on `pg_isready` and runs migrations before the
backend, the Dockerfile ships `backend/migrations`, and rollback is clean.
Deployment verdict was GO. Two items to land before archive (triaged with the
user 2026-05-26):

1. **Remove the contradictory `node-pg-migrate` tooling.** `backend/package.json`
   still ships `migrate` / `migrate:up` / `migrate:down` scripts and the
   `node-pg-migrate` dependency. The real migrate path is `deploy.sh`'s raw-psql
   loop (each `*.sql` self-records into `schema_migrations` via a trailing
   UPSERT). `node-pg-migrate` uses its own tracking table and would NOT populate
   `schema_migrations` the way the new boot probe requires — an operator running
   `npm run migrate:up` then booting hits `BootFatalError`. This directly
   contradicts the task's "migrations are the sole authority" goal. Remove the
   three scripts and the dependency (or, if any real use exists, repoint them at
   `./deploy.sh migrate`); confirm nothing in `deploy.sh` or CI invokes them.

2. **Wrap the `readdir` ENOENT path as `BootFatalError`.** In
   `listExpectedMigrations` (`backend/src/app-db.ts`), `readdir(MIGRATIONS_DIR)`
   throws a raw ENOENT if the directory is ever absent, surfacing as a generic
   "Failed to verify app database schema" rather than an actionable
   `BootFatalError` naming `MIGRATIONS_DIR`. The process still aborts loudly and
   the Dockerfile guarantees the dir ships, so this is low-severity defensive
   hardening — but cheap: catch the `readdir` throw and rethrow
   `new BootFatalError('migrations directory not found at ' + MIGRATIONS_DIR …)`.

Architect note: the `[TODO Architect]` § Migrations paragraph above is still
owed; the architect will land it in `ARCHITECTURE.md` at archive time (it
documents already-shipped, correct behavior and is not blocked by the two items
here). When the two items land, `git mv` this file back to `tasks/review/`.

## Backend re-review signal (2026-05-26, commit 315d734b)

Both hold-block items landed.

1. **node-pg-migrate tooling removed.** Dropped the `migrate` / `migrate:up` /
   `migrate:down` scripts and the `node-pg-migrate` dependency from
   `backend/package.json`, and reconciled `backend/package-lock.json` via
   `npm install` (prunes 22 now-unused packages: node-pg-migrate + its yargs /
   glob / lru-cache transitive tree; diff is removals only, no additions).
   Confirmed nothing else invokes them: `deploy.sh` runs migrations through its
   own raw-psql loop (`migrate_db()` → `psql -f`), there is no `.github/` CI
   directory, and the only remaining repo references to `node-pg-migrate` are
   this task file and the lockfile-now-removed entries. No repoint was needed
   because no real use existed.

2. **readdir ENOENT wrapped as BootFatalError.** `listExpectedMigrations` in
   `backend/src/app-db.ts` now wraps `readdir(MIGRATIONS_DIR)` in try/catch and
   rethrows `new BootFatalError('Migrations directory not found at ' +
   MIGRATIONS_DIR …, { cause: err })`. The `cause` preserves the original
   ENOENT for diagnostics. No test added: the branch is unreachable in practice
   (the Dockerfile COPYs `backend/migrations` into the image), the architect
   scoped it as low-severity defensive hardening, the same risk class
   (boot-probe gap surfacing as `BootFatalError`) is already covered by the
   missing-table and missing-row cases in `tests/app-db-fresh-migrations.test.ts`,
   and `listExpectedMigrations` is unexported so forcing the branch would require
   module-mocking `node:fs/promises` readdir, which would break the real-DB
   missing-row test in that same file.

Verification: `npm run typecheck` pass (src + tests); `npm run lint` pass (one
pre-existing unrelated warning in `author-supersession.ts`);
`tests/app-db-fresh-migrations.test.ts` 4/4 pass against real Postgres (boot
probe verified 14 migrations on disk).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
