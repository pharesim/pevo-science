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

## [TODO Architect] — API contract updates required

The backend changes land in this round; the contract prose in
`agents/docs/api-contracts/bridge.md` needs the architect to apply the
following updates during review (backend cannot edit `api-contracts/*.md`
per root CLAUDE.md):

1. **`POST /api/bridge/register` — change response from `200 OK` to `202 Accepted`.**
   The handler no longer broadcasts synchronously. It enqueues into the
   `bridge_import_queue` table and returns a 202 envelope shaped like:

   ```json
   {
     "status": "ok",
     "data": {
       "entry": {
         "id": 42,
         "operation_kind": "bridge_register",
         "identifier": "2301.12345",
         "permlink": "bridge-arxiv-2301-12345",
         "discipline": "Computer Science",
         "keywords": ["transformers", "attention", "NLP"],
         "language": "en",
         "state": "pending",
         "attempts": 0,
         "scheduled_at": "2026-05-21T18:00:00.000Z",
         "tx_id": null,
         "error_code": null,
         "error_message": null,
         "existing_author": null,
         "existing_permlink": null,
         "created_at": "2026-05-21T18:00:00.000Z",
         "completed_at": null
       },
       "queue_position": 1,
       "eta_seconds": 0,
       "source": { "type": "arxiv", "doi": null, "arxiv_id": "2301.12345", "url": "https://arxiv.org/abs/2301.12345" }
     }
   }
   ```

   The `tx_id` field that used to live at `data.tx_id` is no longer set
   at this point. It populates later in `data.entry.tx_id` (queried via
   `GET /api/bridge/imports`) once the worker successfully broadcasts.

2. **`POST /api/bridge/register` — new error code `RATE_LIMITED` (HTTP 429)
   for the per-user concurrent-pending cap.** Details: `{retriable: true, inflight: <number>, cap: <number>}`. Distinct from the existing IP-level `RATE_LIMITED` because `details.cap` and `details.inflight` are populated and the message reads "You have N in-flight imports (cap K). Submission resumes once one completes." Architect to choose whether to reuse the existing `RATE_LIMITED` error code or introduce a new dedicated code (e.g. `QUEUE_CAP_EXCEEDED`); backend currently emits `RATE_LIMITED`.

3. **`POST /api/bridge/register` — new `DUPLICATE` (HTTP 409) variant: `existing_entry_id` + `existing_entry_state`.** When a sibling submission for the same permlink is already pending or in-progress in the queue, the route returns 409 DUPLICATE with `details = {existing_entry_id: <number>, existing_entry_state: 'pending'|'in_progress'}`. Distinct from the existing on-chain-duplicate 409 (which carries `existing_author` + `existing_permlink`). Architect to decide whether to keep both under `DUPLICATE` (with the field set discriminating) or split into two codes.

4. **`POST /api/bridge/register` — remove the `BROADCAST_TIMEOUT` (504),
   `BROADCAST_FAILED` (502), and `SERVICE_UNAVAILABLE` (503) error sections
   under "Errors" for the synchronous broadcast.** The route no longer
   broadcasts synchronously. Those failure modes now happen inside the
   worker and surface via `data.entry.state = 'failed'` + `error_code` +
   `error_message` on the status endpoint. The 503 `SERVICE_UNAVAILABLE`
   for "Bridge posting key not configured" still applies (pre-enqueue
   misconfig guard). The `SERVICE_UNAVAILABLE` for HAF duplicate-check
   outage also still applies (pre-enqueue fail-closed).

5. **`GET /api/bridge/imports` — new endpoint.** Authenticated. Returns
   the caller's own queue entries newest-first. Query params: `state` (one
   of `pending|in_progress|completed|failed`), `limit` (1..200, default 50).
   Response:

   ```json
   {
     "status": "ok",
     "data": {
       "entries": [<entry shape per item 1>],
       "cap": 5
     }
   }
   ```

   Errors: `UNAUTHORIZED` (no signature), `BAD_REQUEST` (invalid state filter), `INTERNAL_ERROR`.

6. **Rate limit on `GET /api/bridge/imports`.** The endpoint currently
   inherits the global `notif`-style rate limit; architect to consider
   whether to add a dedicated limiter or document the existing one.
   Backend has not added a route-specific limiter.

7. **`POST /api/bridge/update`.** Out of scope per `ARCHITECTURE.md` §
   "Bridge papers" (bridge papers are immutable post-publish; the update
   route is filed for retirement in `backend-retire-bridge-update-route.md`).
   This task does not touch `/update`; it remains synchronous-broadcast
   until that retirement task lands. The contract should NOT be updated to
   point `/update` at the queue.

## Scope-cut note

This round implements the durable queue, the in-process worker, the
enqueue route semantics, the per-user cap, retry-with-backoff, the status
read endpoint, and the schema's `operation_kind` + `scheduled_at`
generality fields. Out of this round:

- Full real-Hive integration test of the worker's broadcast path (the
  worker is exercised via unit-test of its dispatch entry point and the
  queue model has end-to-end real-Postgres coverage; a real-broadcast
  e2e is impractical per-test).
- A separate `bridge.worker_started` health probe (operators can read
  the existing pino `event:'bridge.queue.worker_started'` log).
- An admin endpoint to inspect the entire queue (operators query
  Postgres directly via `SELECT * FROM bridge_import_queue`).
