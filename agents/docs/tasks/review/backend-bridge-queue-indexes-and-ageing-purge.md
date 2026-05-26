# BACKEND-BRIDGE-QUEUE-INDEXES-AND-AGEING-PURGE — add the missing queue indexes and the ageing-purge job the migration comment already promises

**Owner:** Backend Agent
**Created:** 2026-05-25 (architect, surfaced by /ce-code-review performance + data-migrations reviewers at review of `backend-bridge-import-queue` commit `0ccefe14`)
**Priority:** P3 (forward-looking — invisible at beta scale; becomes relevant only as `bridge_import_queue` grows. The misleading migration comment is the one immediate item.)

## Problem

Migration 010's `bridge_import_queue` has two unindexed query paths and an unimplemented purge the schema comment claims exists:

1. **Re-lease branch unindexed.** `leaseNextEntry`'s CTE includes `(state = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW())` — the crash-recovery re-lease path. The only `state`-scoped index, `idx_bridge_import_queue_pending_due`, is partial `WHERE state = 'pending'` and does not cover `in_progress`. The OR branch falls back to a scan.
2. **Cooldown-seed query unindexed.** `getLastSuccessfulBroadcastAt` runs `WHERE state = 'completed' AND tx_id IS NOT NULL ORDER BY completed_at DESC ... LIMIT 1` on every worker tick with no supporting index.
3. **Ageing purge is asserted but absent.** The migration 010 header comment states the table holds short-term state and "ageing purges retire rows," but no purge job exists. Completed/failed rows therefore grow unbounded, which is both a doc-vs-reality mismatch and what eventually degrades the two unindexed queries above and the `computeQueuePosition` count.

At the current volume ceiling (hundreds of imports/day, terminal in minutes-to-hours) none of this is measurable. It becomes real only if the table is never pruned.

## Goal

Add the two indexes, implement the ageing-purge the comment already promises (or correct the comment if the purge is deliberately deferred), so the queue's long-term behavior matches its documented design.

## Scope / Acceptance

- New migration (011+) adding:
  - `CREATE INDEX IF NOT EXISTS idx_bridge_import_queue_inprogress_expired ON bridge_import_queue (lease_expires_at) WHERE state = 'in_progress';`
  - a partial index supporting the last-success seed, e.g. `... (completed_at DESC) WHERE state = 'completed' AND tx_id IS NOT NULL;`
- An ageing-purge that retires terminal rows (`completed`/`failed`) older than a configurable retention window — implemented in-process (a low-frequency tick alongside the existing worker, or a dedicated interval) OR as a documented operator step. If the team decides to defer the purge, instead **correct the migration 010 comment** so it does not assert a purge that does not exist.
- Decide the retention window (propose a default that keeps recent history for the "My imports" surface — e.g. completed/failed older than N days — and name the assumption so it can be tuned).
- `npm run typecheck`, `npm run lint`, migrations apply cleanly via `./deploy.sh migrate`, and `initAppDb`'s boot-time `schema_migrations` verification still passes with the new migration present.

## Out of scope

- The per-user concurrent-pending cap counts only `pending`/`in_progress`, so the purge does not affect cap accounting.
- Index tuning beyond the two named above — only add an index when a query path needs it.

## References

- `backend/migrations/010_bridge_import_queue.sql` — the table, its current indexes, and the "ageing purges retire rows" comment to honor or correct.
- `backend/src/bridge-queue.ts` — `leaseNextEntry`, `getLastSuccessfulBroadcastAt`, `computeQueuePosition`.
- `backend/src/app-db.ts` — `initAppDb` boot-time migration verification (new migration must be reflected so a fresh container does not fail the check).

## Backend implementation note (2026-05-26, working tree)

Decisions made under the latitude this task grants:

- **Migration number is 013, not 011.** `011_accounts_signup_binding_hash.sql` and `012_pending_recovery.sql` already exist; `013_bridge_import_queue_indexes.sql` is the next free number. It adds the two named partial indexes (`idx_bridge_import_queue_inprogress_expired` on `(lease_expires_at) WHERE state = 'in_progress'` for `leaseNextEntry`'s re-lease branch; `idx_bridge_import_queue_last_success` on `(completed_at DESC) WHERE state = 'completed' AND tx_id IS NOT NULL` for the cooldown seed) and self-records in `schema_migrations` so `verifyAppDbMigrations` stays green. Applied cleanly via `./deploy.sh migrate` (both `CREATE INDEX`es + the tracking row); both indexes verified present in `pevo_app`.
- **Purge implemented, not deferred** — honoring migration 010's "ageing purges retire rows" comment rather than weakening it. `purgeAgedTerminalEntries(retentionMs)` (`bridge-queue.ts`) deletes `state IN ('completed','failed') AND completed_at < threshold`; pending/in_progress rows are never touched, so the per-user cap accounting is unaffected (matches the out-of-scope note). The threshold is computed in JS to avoid an int4 interval-multiplier overflow on the ms retention.
- **Retention default: 30 days**, named in the `BRIDGE_QUEUE_RETENTION_MS` const docblock as the tunable assumption ("generous for recent imports at beta volume"). The "My imports" surface keeps a month of history.
- **Purge runs in-process** on a dedicated low-frequency ticker (`PURGE_TICK_MS = 6h`) started in `startBridgeWorker` and cleared in `stopBridgeWorker`, separate from the 5s dispatch tick so a slow purge never delays a broadcast. Errors are swallowed (non-fatal maintenance).
- **No purge index added**, per the out-of-scope "only add an index when a query path needs it" — the purge runs every few hours and a seq scan over terminal rows is fine at this volume.

Coverage: a real-Postgres test in `tests/lib/bridge-queue.test.ts` asserts aged completed/failed rows are retired while a recent completed row and an old pending row are kept. `npm run typecheck` + `npm run lint` clean; bridge suites green against real Postgres + Redis.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
