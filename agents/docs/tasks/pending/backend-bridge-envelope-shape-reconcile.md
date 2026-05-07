# BACKEND-BRIDGE-ENVELOPE-SHAPE-RECONCILE — migrate `bridge.ts:318, :340` open-coded envelopes + reconcile non-canonical `details` placement

**Owner:** Backend Agent (with potential UI lockstep, see Coordination)
**Created:** 2026-05-07 (filed at architect review of `backend-error-envelope-helper-sweep.md`, maintainability finding M1)
**Priority:** P2

## Problem

The error-envelope sweep (`backend-error-envelope-helper-sweep`, archived 2026-05-07, commit `89ec691`) migrated the 2 named open-coded envelope sites (`app.ts:402` JSON-404 fallthrough, `errorHandler.ts:11-14`) to `sendError()`. A `grep -rn "status: 'error'" backend/src/` audit at architect review surfaced two MORE open-coded envelopes left behind in `routes/bridge.ts`:

- **`bridge.ts:318`** (DUPLICATE-with-lock-held branch) — open-coded `{ status: 'error', error: { code, message, retriable } }`. The `retriable` field is INSIDE `error`, not at top-level `details`.
- **`bridge.ts:340`** (DUPLICATE-with-existing-bridge branch) — open-coded `{ status: 'error', error: { code, message, existing_author, existing_permlink } }`. Same pattern: extra fields inside `error`.

For comparison, `sendError(res, status, code, message, details?)` produces the canonical shape:

```json
{
  "status": "error",
  "error": { "code": "...", "message": "..." },
  "details": { ... }
}
```

The 2 bridge.ts sites diverge from this shape — extra fields nested INSIDE `error` rather than at top-level `details`. So migrating them to `sendError()` requires either:

- **(Wire-shape direction A) Migrate to canonical `details`.** Move `retriable`, `existing_author`, `existing_permlink` to the `details` arg of `sendError`. Wire shape changes from `body.error.X` to `body.details.X`. Frontend code reading those fields must update in lockstep.
- **(Wire-shape direction B) Preserve current divergence.** Two envelope shapes coexist in the project — canonical via `sendError`, plus the bridge.ts variant where extra fields live inside `error`. Document the divergence; do not migrate.
- **(Wire-shape direction C) Extend `sendError`.** Add a parameter to `sendError` allowing callers to nest additional fields inside `error`. Changes the canonical shape for everyone (every consumer now needs to handle the optional inside-`error` extension). Architectural decision.

Note: `auth.ts:801` is a third open-coded envelope site, but it carries a TOP-LEVEL `data` field alongside `error` — `sendError` cannot emit this shape. That site is intentionally un-migratable to the canonical helper without expanding the helper signature; out of scope here.

## Decision (architect-owned, must be made before implementer picks up)

The architect must decide between A / B / C **before this task is unblocked**. Recommended: pick A (canonical migration) if the frontend lockstep cost is bounded, or B (preserve divergence) if any consumer's expectations are deeply baked. C (extend `sendError`) is the most intrusive option and should only be picked if a third diverging site is also expected.

This task starts in `tasks/pending/` but the implementer should NOT pick it up until the architect lands the wire-shape decision in this task file (replace this section with the decision rationale + chosen direction).

## Acceptance (assumes direction A; adjust per architect decision above)

1. **Update `agents/docs/api-contracts/bridge.md`** with the decided wire shape for the DUPLICATE 409 responses on `/api/bridge/register` and `/api/bridge/update`. Architect-owned; coordinate via [TODO Architect] in this task file if the contract needs to change before implementer code lands.

2. **Migrate `bridge.ts:318`** (DUPLICATE-with-lock-held). Replace inline `res.status(409).json({ status: 'error', error: { code: 'DUPLICATE', message, retriable: true } })` (or current shape) with `sendError(res, 409, 'DUPLICATE', message, { retriable: true })` (direction A) OR document the preserved-divergence rationale (direction B).

3. **Migrate `bridge.ts:340`** (DUPLICATE-with-existing-bridge). Same pattern with `existing_author` / `existing_permlink` moved to the `details` arg.

4. **Frontend lockstep update** if direction A is chosen. The frontend currently reads `body.error.retriable`, `body.error.existing_author`, `body.error.existing_permlink` (or whatever fields are nested). After the wire-shape change, those reads become `body.details.retriable`, etc. Coordinate with UI agent: if the UI work is non-trivial, file a paired task `ui-bridge-envelope-shape-update.md` and block this task on it.

5. **Tests.** Existing bridge route tests should pass with the migrated wire shape. If wire shape changes, update test fixtures explicitly. Add no new tests beyond what the migration requires.

6. **`auth.ts:801` is intentionally un-migratable** to the canonical `sendError` shape because it carries a top-level `data` field alongside `error`. Out of scope for this task; flag a separate task only if `auth.ts:801` ever becomes load-bearing for envelope discipline.

## Out of scope

- Extending `sendError`'s signature to support arbitrary extra fields inside `error` (direction C above) — if chosen as the wire-shape direction, this task expands to include the helper extension, plus a sweep of every existing `sendError` call site to verify backward compatibility. The architect should reconsider scoping in that case.
- Migrating other open-coded envelope sites elsewhere in the repo (none identified outside `auth.ts:801` and the 2 bridge.ts sites in this task; the `app.ts:402` and `errorHandler.ts:11-14` sites already migrated by the parent task).
- Adopting `sendError` for non-error response paths (`sendOk` exists for those; not in scope here).
- Changing the canonical envelope shape definition in `agents/docs/api-contracts/common.md` — architect-owned; if direction A's `details` migration requires it, file a [TODO Architect] note in this task body.

## Coordination

- Surfaced from architect review of `backend-error-envelope-helper-sweep.md` (commit `89ec691`), maintainability finding M1.
- May require UI agent coordination for the lockstep frontend update (direction A only).
- The `error-envelope-helper-sweep` task is archived (2026-05-07); its acceptance was correctly scope-bound to 2 named sites despite the "sweep" framing in the title. This task picks up the residual unmigrated sites + the wire-shape question.

## Cross-references

- `agents/docs/tasks-archive.md` `BACKEND-ERROR-ENVELOPE-HELPER-SWEEP` (archived 2026-05-07) — parent task; M1 finding details.
- `backend/src/response.ts` — canonical `sendError` definition.
- `agents/docs/api-contracts/bridge.md` — bridge route error documentation; affected by direction A.
- `agents/docs/api-contracts/common.md` — canonical envelope shape; possibly affected if direction C is chosen.
