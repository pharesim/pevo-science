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

## Decision (architect 2026-05-11): Direction A — canonical migration

**Chosen direction: A.** Migrate both sites to `sendError(...)` with the divergent fields placed inside `error.details`.

### Corrections to this task's framing

The task body's description of the canonical shape (above this section) is **wrong**. The actual canonical shape, per `backend/src/response.ts:37-43`, is:

```json
{
  "status": "error",
  "error": {
    "code": "...",
    "message": "...",
    "details": { ... }
  }
}
```

`details` is nested INSIDE `error`, NOT at top level. The frontend `ApiRequestError` constructor at `frontend/src/api.js:60` reads `errorBody.error.details` and exposes it as `err.details`, consistent with this shape.

### Status of the two sites at time of decision (line numbers refreshed)

- **`backend/src/routes/bridge.ts:413-420` (LOCK_HELD branch, formerly :318):** the LOCK_HELD rename landed alongside `backend-bridge-write-haf-lag-and-retry-amplification` round-2. The current shape already matches canonical — `error: { code: 'LOCK_HELD', message, details: { retriable: true } }`. **No wire-shape change needed; pure helper migration.**
- **`backend/src/routes/bridge.ts:435-444` (DUPLICATE-existing branch, formerly :340):** still diverges — `existing_author` and `existing_permlink` are siblings to `code`/`message` at the `error` level, not inside `details`. **Wire shape changes: `body.error.existing_author` → `body.error.details.existing_author` (same for `existing_permlink`).**

### Why A and not B/C

- **B (preserve divergence) rejected.** No consumer is depending on the current divergent shape — grep of `frontend/src/` and `frontend/tests/` for `existing_author`/`existing_permlink` returns zero hits, and `backend/tests/` has no fixture asserting the DUPLICATE-existing path. The "deeply baked consumer" risk that would have justified B doesn't exist; B would lock in inconsistency for no gain.
- **C (extend `sendError`) rejected.** No third divergent site has been identified (`auth.ts:801` is intentionally un-migratable for a different reason — top-level `data` alongside `error`). C's cost (every existing `sendError` call site must handle the new optional inside-`error` nesting) is real; A's cost is one route file + one doc line.

### Out-of-scope nudges resolved

- **Wire-shape direction for the contract doc:** Direction A. The contract doc update lands in this same commit (see `agents/docs/api-contracts/bridge.md` change in the architect's unblock commit).
- **Whether to extend `sendError`:** no.
- **Whether `auth.ts:801` is in scope:** no (per the task body's explicit Out-of-scope clause).

### Refreshed acceptance criteria (supersedes original "## Acceptance" above, except where noted)

1. **`bridge.ts:413-420` (LOCK_HELD):** replace the open-coded `res.status(409).json(...)` block with `sendError(res, 409, 'LOCK_HELD', message, { retriable: true })`. Zero wire-shape change; the existing `bridge-haf-lag-locks.test.ts:390-391` assertions on `body.error.code` and `body.error.details` should pass unchanged.

2. **`bridge.ts:435-444` (DUPLICATE-existing):** replace with `sendError(res, 409, 'DUPLICATE', message, { existing_author: existing.author, existing_permlink: existing.permlink })`. Wire shape now matches the canonical: `body.error.details.existing_author`, `body.error.details.existing_permlink`.

3. **Tests:** no existing test fixture currently asserts the DUPLICATE-existing 409 path (verified at architect re-review 2026-05-11 — `grep -rn "DUPLICATE.*existing\|existing_author\|existing_permlink" backend/tests/` returns zero hits). The implementer SHOULD add a single fixture asserting `body.error.code === 'DUPLICATE'` and `body.error.details.existing_author`/`existing_permlink` on the new wire shape — this closes the pre-existing coverage gap while the migration is fresh. Place in `backend/tests/routes/bridge.test.ts` near the LOCK_HELD coverage in `bridge-haf-lag-locks.test.ts`.

4. **No frontend lockstep needed.** Architect verified zero consumers of these fields in `frontend/src/` and `frontend/tests/`. If the implementer's grep reveals a consumer (e.g. one landed between this decision and pickup), file a paired `ui-bridge-envelope-shape-update.md` task and block this task on it — but do not assume it's needed.

5. **Contract doc:** `agents/docs/api-contracts/bridge.md:144` has been updated in the architect's unblock commit to specify `error.details.existing_author` / `error.details.existing_permlink` as part of the DUPLICATE 409 response. Implementer does NOT need to edit `api-contracts/`; the doc already describes the target shape.

6. **`auth.ts:801` remains intentionally un-migratable** (top-level `data` alongside `error`). Out of scope. No follow-up task needed.

### Implementer pickup notes

- This is now a small, mechanical change: 2 sites in `bridge.ts`, 1 new test, no doc edits, no frontend edits.
- The LOCK_HELD migration in particular has no behavioral risk — the wire shape is already canonical, the helper just owns the JSON emit.
- The DUPLICATE migration's wire change is a genuine breaking change for any unknown consumer, but architect verified none exist today. If you find one mid-implementation, hold and ping the architect.

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

## [BLOCKED by Architect] (backend startup triage 2026-05-07)

Per the task body's "Decision (architect-owned, must be made before implementer picks up)" section, the wire-shape direction (A: canonical `details` migration / B: preserve divergence / C: extend `sendError`) must land in this file before backend can pick the task up. Moving to `blocked/` so the architect's startup scan surfaces it. Backend will pick up immediately after the architect lands the chosen direction in the "Decision" section and `git mv`s back to `pending/`.

## [UNBLOCKED] (architect 2026-05-11)

Wire-shape decision landed in the "## Decision (architect 2026-05-11): Direction A" section above. Direction A (canonical migration to `error.details`) is the chosen path. Refreshed acceptance criteria + frontend/test verification + contract doc spec are all in that block. Moving to `pending/` for backend pickup.
