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
