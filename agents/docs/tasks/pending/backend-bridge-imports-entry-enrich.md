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

## Architect review (2026-05-27) — HELD PENDING FIXES (round 1)

`/ce-code-review` on commit `8b1ce01d` (correctness, adversarial, testing, maintainability, project-standards, api-contract, data-migrations, reliability; security/`ce-agent-native-reviewer` skipped per scope/PEvO). The feature is sound: correctness traced the `author` derivation / `eta_seconds` / `queue_position` subquery / INSERT column-placeholder alignment clean; data-migrations confirms migration 015 is a textbook-safe additive nullable column matching the 008-014 `schema_migrations` tracking convention; project-standards and maintainability clean (the `etaSecondsForPosition` dedup and `BridgeImportListRow` separation are good, the test-mock carve-out header satisfies (a)(b)(c) with `verifyHiveSignature` real). Two P2 test-assertion gaps hold (each tied to this task's own acceptance criteria); the contract-doc fix is architect-owned and already landed; the P3s are dismissed.

1. **(P2, conf 100 — testing) The collision entry's `title` is never asserted.** The enriched-shape test seeds the collision row with `title: TITLE` but asserts only `state`, `existing_author`, and `author` on it — not `title`. The acceptance criterion covers the collision entry's fields; add `expect(collideEntry.title).toBe(TITLE)` so a regression in collision-path title serialization is caught.

2. **(P2, conf 100 — testing) The pending entry's `eta_seconds` is asserted only as `number >= 0`, not pinned.** The pending row is the sole non-terminal entry in the test's DB slice, so its `queue_position` must be 1 and `etaSecondsForPosition(1)` is 0. Replace the `typeof`/`>= 0` pair with `expect(pendingEntry.eta_seconds).toBe(0)` — this pins both the correlated `queue_position` subquery (must be 1) and the formula, matching the 202 path's position-1 assertion. Optionally add a second pending row (distinct user) and assert `queue_position = 2` / `eta_seconds = BRIDGE_CHAIN_COOLDOWN_MS/1000` so the subquery is exercised behaviorally for position > 1.

Landed by architect (NOT implementer scope): `agents/docs/api-contracts/bridge.md` — the 202 `/register` example now lists `title`/`author`/`eta_seconds`, the prose notes `entry.eta_seconds == top-level eta_seconds` at enqueue, and the `author` field doc clarifies a terminal `failed` entry is `null`.

Dismissed / not held (P3 advisory): `author` reflecting the live `config.hiveBridgeAccount` rather than a persisted broadcaster (single-instance, stable config); unbounded `title` length / control chars from external metadata (hardening, not a beta blocker); an `in_progress` entry showing a non-zero ETA (best-effort display by design); the `queue_position` correlated subquery's global scan lacking a covering `(state, id)` index (beta-scale fine — revisit only if `/imports` latency surfaces); the `serializeQueueRow(row, queuePosition?)` optional-param footgun (both call sites pass it). The `failed`/`null-title` round-trip and `in_progress` serializer paths are uncovered but low-risk; fold in with the two held assertions if convenient.

When items 1-2 land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; round-2 review scopes to the fix commit(s) only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
