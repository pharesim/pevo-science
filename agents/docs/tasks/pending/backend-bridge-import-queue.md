# BACKEND-BRIDGE-IMPORT-QUEUE — persistent FIFO queue in front of bridge-register

**Owner:** Backend Agent
**Created:** 2026-05-21
**Priority:** P2

## Problem

`POST /api/bridge/register` currently broadcasts bridge papers synchronously under the single PEvO-controlled `config.hiveBridgeAccount`. The Hive chain enforces a 1-root-post-per-5-min cooldown per account. Every bridge import across every user contends for that one global window (~288/day total).

Under any concurrent use — two users importing simultaneously, or one user backfilling a publication list — the second submission either fails the broadcast or races for the cooldown. The user-visible failure today is a chain rejection or a long wait with no progress signal.

## Goal

Absorb bridge import submissions into a persistent FIFO queue and dispatch them against the chain's per-account cadence, returning a non-blocking acknowledgement so the submitter does not need to keep a tab open.

## Scope

- **Durable queue storage** (Postgres-backed; survives backend restarts; observable via SQL). Redis remains the per-permlink dedup-lock layer only, not the queue's source of truth.
- **Worker** that pulls FIFO and dispatches at the chain's cadence. Runs in-process inside the existing backend Express server for v1 (no separate worker service).
- **`/api/bridge/register` semantics change** from synchronous broadcast to enqueue + `202 Accepted`. Response body carries queue position and a best-effort completion ETA.
- **Per-user concurrent-pending cap of 5**, enforced at enqueue. Over-cap submissions are rejected with a reason and a remediation hint ("you have 5 in-flight imports; submission resumes once one completes"). Cap is evaluated against currently-pending entries only; completed/failed entries do not count against capacity.
- **Retry with backoff** on transient chain failures (RC exhaustion, broadcast timeout, congestion). Permlink-uniqueness collisions short-circuit retry — the queue layer sits in front of the existing `bridge_register_lock` semantics rather than replacing them; on collision, return the existing on-chain record.
- **Failure surfacing.** Metadata-fetch failures discovered at enqueue are surfaced synchronously to the submitter (no queue entry created). Failures discovered at dispatch (e.g., metadata source went away between enqueue and dispatch) mark the entry failed with a reason without consuming the cooldown window for the next entry.
- **Status read endpoint(s)** for the UI to render "My imports" — caller queries their own entries by state (pending / in-progress / completed / failed with reason). Shape negotiated with the UI agent during implementation; document the chosen shape in `agents/docs/api-contracts/` as part of this task.
- **Schema generality.** Queue's persisted state shaped to admit later scheduled-broadcast and embargo-hold dispatch policies without requiring a migration. Generic `scheduled_at` / `operation_kind` field shape is the load-bearing piece; no features built on it in this scope.

## Acceptance

- Submitting 10 bridge imports back-to-back returns 10 `202` responses (or the 5th-onwards are rejected with the per-user cap reason) without blocking and without rejecting on the chain's 5-min limit.
- After closing the browser tab and reopening later, the importer can read entry status via the status endpoint and see pending entries dispatched over time.
- Two concurrent importers do not deadlock or race; FIFO is preserved across users.
- Per-user cap rejects the 6th in-flight submission for a given user; submission 6 is accepted after one of the user's pending entries drains.
- Transient broadcast failure (e.g., RC exhaustion) is retried with backoff; the entry is not marked failed on first attempt.
- Permlink collision (identifier matches an existing on-chain bridge paper) short-circuits the queue and returns the existing record.
- Backend process restart does not lose queued entries and does not double-broadcast an entry that was mid-dispatch at restart.

## Out of scope

- Multi-bridge-account fan-out (round-robin across multiple `pevo-bridge-*` accounts) — deferred until measured demand exceeds the single-account ceiling.
- Scheduled native publishing and pre-print embargo features — the schema leaves room; the features are separate scope.
- Daily per-user quotas — only the concurrent-pending cap is built. Add a daily cap later if abuse is observed.
- Posting-authority delegation flows for self-custody users — irrelevant; the bridge account is PEvO-controlled with server-side keys.
- Bridge-paper authorship-claim flow (original author joining Hive later and claiming an existing bridge paper) — separately filed per `agents/docs/ARCHITECTURE.md`.
- Push notifications on completion — the UI's "My imports" surface is the visibility channel for v1.
- Frontend changes — see `ui-bridge-import-queue-ux.md`.

## Source

Brainstorm 2026-05-21 with user. Selected Approach A (single bridge account + persistent FIFO + per-user concurrent-pending cap of 5) over multi-account fan-out (Approach B) and a synchronous 429-with-Retry-After baseline (Approach C). Per-user cap shape is concurrent-pending only, not a daily quota.

## Cross-references

- `agents/docs/ARCHITECTURE.md` — bridge papers section; bridge account is the sole vouched author, data model unchanged by this task. Architect should consider whether the queue layer warrants its own paragraph during review.
- `backend/src/bridge.ts` — bridge identifier parsing, metadata fetch, permlink construction.
- `backend/src/routes/bridge.ts` — current `/api/bridge/register` handler; existing per-permlink Redis lock (`bridge_register_lock`) sits inside this surface and stays.
- `ui-bridge-import-queue-ux.md` — sibling task for the frontend UX; coordinate the status endpoint shape during implementation.
