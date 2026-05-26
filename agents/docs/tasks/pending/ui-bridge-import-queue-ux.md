# UI-BRIDGE-IMPORT-QUEUE-UX — async submission UX + My imports surface

**Owner:** UI Agent
**Created:** 2026-05-21
**Priority:** P2

## Problem

The bridge import endpoint (`POST /api/bridge/register`) is moving from synchronous broadcast to async enqueue + `202 Accepted` with queue position and ETA (see `backend-bridge-import-queue.md`). The current frontend submission flow assumes synchronous success/failure and single-paper-at-a-time interaction. It has:

- no visible surface for queued or pending imports
- no handling for the new per-user concurrent-pending cap rejection
- no way for a user to see import status without keeping the submitting tab open

## Goal

Make the bridge import UX honest about the chain's pacing: surface queue position + ETA on submission, render the per-user cap rejection usefully, and add a "My imports" surface so users can come back later and see whether their pending imports completed.

## Scope

- **Submission response handling.** Show "Queued — position N, estimated completion in X" inline on `202`. Differentiate visually from the prior synchronous success state.
- **Per-user cap rejection.** Render the new cap-rejection 4xx with a clear message and remediation hint ("you have 5 pending imports; submission resumes once one completes"). Do not make it look like a transient chain error.
- **"My imports" surface.** New page or panel listing the current user's recent bridge import entries with state badges (pending / in-progress / completed / failed-with-reason). Reachable from the user's profile or main nav — exact placement to be decided during implementation. Reachable without keeping the submitting tab open.
- **Completion outcomes.** Completed entries link to the resulting on-chain bridge paper. Failed entries surface the reason and offer a retry-submission action where the failure class permits it (e.g., metadata source transient outage).

## Acceptance

- Submitting a bridge import shows queue position and ETA inline, without blocking the page.
- Submitting beyond the per-user cap shows the rejection reason and remediation hint, distinguishable from a transient chain error.
- "My imports" surface lists the current user's recent bridge import entries with correct state; completed entries link to the bridge paper, failed entries show the reason.
- Closing the submitting tab does not lose visibility of pending imports — opening "My imports" later shows current state.

## Out of scope

- Backend queue implementation, status endpoint shape, and submission-API semantics — see `backend-bridge-import-queue.md`.
- Push notifications on completion — the "My imports" surface is the visibility channel for v1.
- Bulk-submit UI (submitting N papers in one form) — single-paper submission is the current pattern and stays.

## Dependency

`backend-bridge-import-queue.md` defines the new `/api/bridge/register` response shape and the status endpoint(s) this surface consumes. UI scaffolding (component layout, design exploration, mocked data flows) can start in parallel; full integration depends on backend completion. Coordinate the status endpoint shape with the backend agent during their implementation rather than waiting for them to land first.

## Source

Brainstorm 2026-05-21 with user. The UX requirements (queue position + ETA, per-user cap surface, "My imports" view, completion visibility without keeping a tab open) emerged from the user-facing implications of the queue model selected on the backend side.

## Cross-references

- `backend-bridge-import-queue.md` — sibling backend task; defines the new response shape and status endpoint.
- `frontend/src/` — existing bridge import submission UI lives in the paper authoring flow.

[BLOCKED by Backend] (2026-05-21) — Sibling task `backend-bridge-import-queue.md` is still in `agents/docs/tasks/pending/`. Full integration is gated on:

- New `POST /api/bridge/register` 202 response shape (queue position + ETA representation).
- Per-user-cap rejection error code and `error.details` shape.
- Status endpoint(s) for "My imports" list (URL, query params, response shape).
- Retry-submission semantics (re-POST identifier vs. dedicated retry endpoint).
- `api-contracts/bridge.md` updates for the above.

**Scaffolding landed in this pass (consumable while backend implements):**

- New i18n keys for queued/cap-rejected states (in the `bridge` namespace) and the full `myImports` namespace, English source + stub rows for all 15 non-English locales, with `STUBS.md` sweep entry under `### Added 2026-05-21 (UI-BRIDGE-IMPORT-QUEUE-UX)`.
- New `/my-imports` page at `frontend/src/pages/my-imports.js`, registered in `pages/index.js` and routed by `router.js`. Auth-gated; signed-in users see the empty state in production; the `?demo=1` query param renders representative entries spanning pending / in-progress / completed / failed for design review.
- "My imports" link in the authenticated user dropdown (`frontend/index.html`), parallel to the Settings link.

**Consumer-side shape the UI binds against today** (see the docblock at the top of `frontend/src/pages/my-imports.js`):

```
{
  id:            string,
  identifier:    string,           // user-submitted DOI / arXiv / URL
  title:         string | null,
  state:         'pending' | 'in_progress' | 'completed' | 'failed',
  submitted_at:  ISO-8601 string,
  completed_at:  ISO-8601 string | null,
  author:        string | null,    // bridge account (completed only)
  permlink:      string | null,
  failure_reason:string | null,
  retriable:     boolean,
}
```

This is a starting point for backend-side shape negotiation, not a contract. Backend may name fields differently or split state into separate fields; the UI adapter (`loadEntries`) absorbs the difference.

**Still gated on backend (unwritten in this pass):**

- Wiring `registerBridgePaper()` to handle the 202 response and render the queued state with position + ETA on the bridge submission page (uses the already-shipped `bridge.queued*` keys).
- Rendering the per-user-cap rejection on the bridge submission page (uses the already-shipped `bridge.userCap*` keys).
- Replacing the empty stub in `my-imports.js` `loadEntries()` with a real fetch and an ETA-formatter that consumes `myImports.etaMinutes` / `etaHours` / `etaUnknown`.
- E2E coverage of the new submission flow and the My imports surface.

Move back to `pending/` once `backend-bridge-import-queue.md` archives and the new endpoints are documented in `agents/docs/api-contracts/bridge.md`.

## Architect unblock (2026-05-26)

Both gates are met; returning to `pending/`. `backend-bridge-import-queue` archived 2026-05-26, and `agents/docs/api-contracts/bridge.md` now documents the full surface this task binds against:

- `POST /api/bridge/register` → HTTP 202 `EnqueueBridgePaperResponse` with `queue_position` and `eta_seconds` (the queued-state shape).
- Per-user in-flight cap (5) → `RATE_LIMITED` (429), `error.details: { retriable, inflight, cap }`; resumes once one in-flight import completes.
- `GET /api/bridge/imports` → the "My imports" status/list endpoint (full field reference in `bridge.md`).
- Retry model → re-POST `/register` (no dedicated retry endpoint); a `failed` entry is not "in-flight" so it re-enqueues, while an active `pending`/`in_progress` duplicate returns `DUPLICATE`/`LOCK_HELD`.

Remaining work is all UI-side and is the task body, not a blocker: wire `registerBridgePaper()` to the 202 queued state and the cap rejection, replace `my-imports.js` `loadEntries()`'s empty stub with a real fetch against `GET /api/bridge/imports` (the `loadEntries` adapter absorbs any field-name differences from the consumer shape sketched above), add the ETA formatter, and add E2E coverage. Confirm the documented field names against the live `bridge.md` shape before binding — the earlier consumer sketch in this file predates the contract and was explicitly "not a contract."
