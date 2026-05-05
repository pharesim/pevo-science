---
title: "Migrations and initAppDb() are dual sources of schema truth — new column additions must update BOTH paths in the same commit"
date: 2026-05-05
category: conventions
module: backend/src
problem_type: convention
component: database
severity: high
applies_when:
  - "Writing a new migration under `backend/migrations/NNN_*.sql` that adds or alters a column on an existing table"
  - "Reviewing a PR that touches `backend/migrations/` — verify the diff also touches `backend/src/app-db.ts`"
  - "Diagnosing why an INSERT in code references a column that the table doesn't have, only on fresh containers"
  - "An audit-log INSERT or other fire-and-forget DB write looks correct in tests but the row never lands in production"
related_components:
  - testing_framework
  - tooling
tags:
  - migration
  - initappdb
  - schema-drift
  - dual-source
  - silent-data-loss
  - audit-log
---

# Migrations and initAppDb() are dual sources of schema truth — new column additions must update BOTH paths in the same commit

## Context

PEvO has TWO sources of schema truth for app-database tables:

1. **`backend/migrations/NNN_*.sql`** — the prod-authoritative migration set, run by `./deploy.sh migrate`. New columns and tables are added here.
2. **`backend/src/app-db.ts:initAppDb()`** — an in-process bootstrap that runs on every backend startup and writes `CREATE TABLE ... IF NOT EXISTS` blocks for the core app-DB tables. This path exists so a fresh dev/CI container with a blank Postgres can boot the backend without first running migrations.

A backend implementer reasonably assumes "I wrote the migration; the schema is updated." That assumption holds for any database that ran the migration before the backend started. It silently fails for databases bootstrapped via `initAppDb()` first — fresh `docker compose up` clones, brand-new CI volumes, or any new prod node that boots before `./deploy.sh migrate` lands. On those environments, `initAppDb()` creates the table with whatever shape was hard-coded INTO `app-db.ts` at the time, missing any column added later by migration.

This trap surfaced twice already: once for `notification_preferences.last_digest_block` (which has its own retroactive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` block at `backend/src/app-db.ts:47`) and again on `2026-05-05` during `/ce-code-review` of `backend-coauthor-trust-model` Phase 2 round 3 — migration `005_custody_audit_consent_ops.sql` added four columns to `custody_audit_log` and `initAppDb()` was not updated. The downstream INSERT in `backend/src/custody-audit.ts:46` references all eight columns; on a fresh container, the missing four columns cause the INSERT to fail. The audit write is fire-and-forget (`.catch(() => {})` at `backend/src/routes/custody.ts:472`), so the broadcast succeeds and the audit row is silently lost.

## Guidance

When writing a migration that adds or alters a column on an `initAppDb()`-managed table, IN THE SAME COMMIT:

1. Write the migration file under `backend/migrations/NNN_*.sql` as usual.
2. In `backend/src/app-db.ts:initAppDb()`, either:
   - Update the inline `CREATE TABLE ... IF NOT EXISTS` block to list every column (preferred when the table's full shape is still ergonomic to maintain in one place), OR
   - Append a matching `ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <col> <type>;` block AFTER the `CREATE TABLE` (matches the existing pattern at `app-db.ts:47` for `notification_preferences.last_digest_block`).
3. Use `IF NOT EXISTS` everywhere. `initAppDb()` runs every backend start; the migration runs once per `./deploy.sh migrate`. Idempotence is what makes the dual-source survivable — neither path conflicts when the column is already there.

Tables managed by `initAppDb()` (as of 2026-05-05): `accounts`, `notification_preferences`, `custody_audit_log`, plus any others that have `CREATE TABLE` blocks in `backend/src/app-db.ts`. Verify the current set by reading the file before deciding whether the dual-source rule applies — tables that exist only as migration-created (e.g., HAF-companion tables) don't need the second update.

## Why This Matters

- **Silent data loss.** The downstream consumers of `initAppDb()`-managed tables tend to be fire-and-forget writes (audit logs, notification queue inserts, telemetry rows) wrapped in `.catch(() => {})` so the user-facing happy path doesn't break on a logging failure. A column-mismatch INSERT throws inside the `.catch`, the row is dropped, and the user-facing operation succeeds. The drop is invisible to monitoring and to the user. Operators discover it only when they query the table for forensic correlation and find rows are missing.
- **Tests don't catch it.** Test suites typically run against a Postgres instance that has migrations applied (the carve-out happy path). The dual-source bug only surfaces when `initAppDb()` runs first against a virgin DB. CI's fresh-container test phase does exercise this path, but only if the test suite asserts on the dropped row's presence — and most fire-and-forget audit tests assert on the broadcast outcome, not the audit row.
- **Deployment-path-dependent.** Two engineers can both run "the same code" against "the same migration" and get different table shapes depending on which runs first. Cross-environment debugging gets correspondingly slow.
- **Reverse-direction is also a risk.** If a column is DROPPED via migration but the inline `CREATE TABLE` in `initAppDb()` still lists it, fresh containers re-create the dropped column with whatever default `app-db.ts` carries — diverging the fresh-container schema from the migrated-prod schema in the opposite direction. Same rule, same fix: keep the two paths in sync per commit.

## When to Apply

- Writing a new migration that touches `accounts`, `notification_preferences`, `custody_audit_log`, or any other table whose `CREATE TABLE` block exists in `backend/src/app-db.ts`.
- Reviewing a backend PR whose diff includes `backend/migrations/*.sql` — the diff MUST also touch `backend/src/app-db.ts` for `initAppDb()`-managed tables, or the omission is the finding.
- Designing fire-and-forget write paths against an `initAppDb()`-managed table — be aware the column-existence assumption can fail on fresh containers.
- During `/ce-code-review`, the data-migrations persona should explicitly check this: when a migration touches an app-DB table, scan the diff for a corresponding `app-db.ts` change. Absence is a P1 silent-data-loss finding by default.

## Examples

### Adding a column — the dual-update commit

Migration `005_custody_audit_consent_ops.sql`:

```sql
ALTER TABLE custody_audit_log
  ADD COLUMN IF NOT EXISTS auth_mechanism TEXT,
  ADD COLUMN IF NOT EXISTS fresh_auth_outcome TEXT,
  ADD COLUMN IF NOT EXISTS session_id TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT;
```

Companion edit in `backend/src/app-db.ts:initAppDb()` (mirroring the existing `notification_preferences.last_digest_block` retrofit at line 47):

```ts
await pool.query(`
  CREATE TABLE IF NOT EXISTS custody_audit_log (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    tx_id TEXT,
    block_num BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

// Idempotent column additions — mirrors backend/migrations/005_custody_audit_consent_ops.sql
// so fresh containers that boot via initAppDb() before migrations land still write a complete row.
await pool.query(`
  ALTER TABLE custody_audit_log
    ADD COLUMN IF NOT EXISTS auth_mechanism TEXT,
    ADD COLUMN IF NOT EXISTS fresh_auth_outcome TEXT,
    ADD COLUMN IF NOT EXISTS session_id TEXT,
    ADD COLUMN IF NOT EXISTS user_agent TEXT;
`);
```

Both paths are now idempotent and consistent. Either order produces the same final shape.

### Detection during review

When `/ce-code-review` runs on a diff that includes `backend/migrations/NNN_*.sql`:

1. Identify the target table(s) in the migration.
2. `grep -n "CREATE TABLE.*<table-name>\|ALTER TABLE <table-name>" backend/src/app-db.ts` — does any block exist?
3. If yes (the table is `initAppDb()`-managed), the diff MUST also touch `backend/src/app-db.ts`. Otherwise file as a P1 silent-data-loss finding.
4. If no (the table is migration-only), the dual-source rule doesn't apply.

## Related

- `agents/docs/tasks/pending/backend-coauthor-trust-model.md` — round-3 → round-4 hold item #2 captures the original incident this convention generalizes from.
- `backend/src/app-db.ts:47` — pre-existing `notification_preferences.last_digest_block` retrofit illustrates the same pattern bit once before. The fix shape there is the model for future column additions.
- `agents/docs/solutions/conventions/correlated-options-discriminated-union-2026-04-28.md` — different concern (type-system correlation of related fields). This convention is about schema-source correlation, not type-system correlation.
- Root `CLAUDE.md` "Local Dev Deployment" section — `./deploy.sh migrate` runs migrations; the fact that `initAppDb()` shadows-creates tables on every backend start is not surfaced there. Future refresh of that section could cross-reference this convention.
