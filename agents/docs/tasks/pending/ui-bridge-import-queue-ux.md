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
