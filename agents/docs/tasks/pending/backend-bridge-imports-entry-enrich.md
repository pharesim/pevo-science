# BACKEND-BRIDGE-IMPORTS-ENTRY-ENRICH — add title, eta_seconds, and resolved author to the queue-entry shape

**Owner:** Backend Agent
**Created:** 2026-05-26 (architect, from the `ui-bridge-import-queue-ux` review)
**Priority:** P2

## Problem

The "My imports" surface (`frontend/src/pages/my-imports.js`) binds against `GET /api/bridge/imports` and wants to (a) label each row with the paper title, (b) show a per-row ETA for non-terminal entries, and (c) link completed entries to the resulting bridge paper. The current entry shape provides none of these:

- No `title` → every live row falls back to the raw identifier as its label.
- No `eta_seconds` → every pending/in-progress row renders "ETA unknown".
- No resolved `author` for freshly broadcast papers (only `existing_author`, set on the permlink-collision short-circuit) → the "View paper" link is suppressed for the common case (fresh broadcast), satisfying the task's "completed entries link to the bridge paper" acceptance criterion only on collisions.

The gap was masked during UI development because the page's `?demo=1` rows inject synthetic `title`/`eta_seconds`/`author` that the real wire shape does not carry. Surfaced by `/ce-code-review` (api-contract + testing personas) during the `ui-bridge-import-queue-ux` review.

The contract in `agents/docs/api-contracts/bridge.md` (`GET /api/bridge/imports` → `BridgeImportListResult`) has been updated to document all three fields. This task makes the backend emit them.

## Requirements

### R1 — `title`

Emit `title: string | null` on each entry. The source preprint title is resolved at register time (the synchronous metadata fetch in the `/register` flow that yields `BAD_REQUEST` when the identifier does not resolve). Persist it on the queue row at enqueue and return it on the list. `null` only if metadata had not resolved when the row was created.

### R2 — `eta_seconds`

Emit `eta_seconds: number | null` per non-terminal (`pending`/`in_progress`) entry, derived from the entry's queue position and the 5-minute chain cooldown, on the same basis as the `/register` 202 `eta_seconds` (position 1 dispatches next tick → 0). `null` for terminal (`completed`/`failed`) entries and when no estimate is available. Reuse the existing 202 ETA derivation rather than introducing a second formula.

### R3 — resolved `author`

Emit `author: string | null`: the Hive author of the resulting bridge post (`HIVE_BRIDGE_ACCOUNT`), populated once `state` is `completed`; `null` while non-terminal. On a permlink-collision short-circuit it equals `existing_author`. Together with the existing `permlink`, this lets the SPA build the completed-post link for every completed entry without the bridge account being injected into the frontend config separately.

## Acceptance

- `GET /api/bridge/imports` returns `title`, `eta_seconds`, and `author` per the updated `bridge.md` entry field reference.
- Integration test (real app DB / HAF per project test conventions) asserting: a completed fresh-broadcast entry carries `author === HIVE_BRIDGE_ACCOUNT` and a non-null `title`; a permlink-collision entry carries `author === existing_author`; a pending entry carries a numeric `eta_seconds` and `author === null`.
- No change to the `state` filter / `limit` semantics or the `cap` field.

## Out of scope

- The UI wiring that consumes these fields. The held `ui-bridge-import-queue-ux` task carries the consumer-side change (View-paper link for all completed entries, per-row ETA, title labels). The `adaptEntry()` seam already reads `wire.title`/`wire.eta_seconds`; the only consumer edit gated on this task is widening `author: wire.existing_author ?? null` to `wire.author ?? wire.existing_author ?? null` and dropping the demo-only masking. Coordinate the field names against `bridge.md` (already documented) rather than the UI's predating consumer sketch.

## Cross-references

- `agents/docs/api-contracts/bridge.md` — `GET /api/bridge/imports` entry shape (updated 2026-05-26 with `title`/`eta_seconds`/`author`).
- `agents/docs/tasks/pending/ui-bridge-import-queue-ux.md` — UI consumer, held pending fixes; the title/ETA/author wiring item there is gated on this task.
- `backend-bridge-import-queue` (archived 2026-05-26) — the queue model and the `/register` 202 `eta_seconds` derivation this reuses.
