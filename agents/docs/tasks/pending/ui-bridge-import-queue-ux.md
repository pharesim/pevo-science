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

## UI implementation note (2026-05-26) → review

Bound against the live `bridge.md` contract (not the predating consumer sketch). Landed:

- **Queued state (202).** `bridge.js` reads `queue_position`/`eta_seconds` off the 202 body, sets a `queued` step rendering position + ETA inline, links to `/my-imports`, and no longer redirects to a paper (the old synchronous `success` step + 3s redirect was removed). Consumes the already-shipped `bridge.queued*` keys.
- **Per-user cap.** Discriminated on `err.code === 'RATE_LIMITED' && err.details?.cap !== undefined` so the per-IP limiter (same code, no `details.cap`) falls through to the generic transient-error path. The cap surface (`bridge.userCap*`) is styled distinctly (amber remediation vs. crimson transient error).
- **My imports.** `my-imports.js` `loadEntries()` now fetches via the new `fetchBridgeImports()` (`src/api.js`, bearer-JWT, mirrors `fetchNotifications`); `adaptEntry()` absorbs field-name differences; failed entries re-POST `/register` (contract retry model) behind a re-entrancy guard. New shared `src/lib/format-eta.js` for the `eta_seconds` → localized label.

**Field-name adaptations (`adaptEntry`) against `bridge.md`:** `submitted_at`←`created_at`, `failure_reason`←`error_message`, `retriable`←`state === 'failed'` (no per-entry flag in the contract). 

**i18n:** consumed only already-shipped keys (`bridge.queued*`, `bridge.userCap*`, `myImports.*`). No new keys, no `STUBS.md` change. (`bridge.stepSuccess` is now orphaned but left in place, harmless.)

**[For architect — design gap, not blocking]** Completed entries from `GET /api/bridge/imports` carry no resolved bridge-author field, and `window.__PEVO_CONFIG__` does not expose the bridge account, so the "View paper" link only renders on the `existing_author` permlink-collision case; for a freshly broadcast bridge paper the link is suppressed (graceful degradation) rather than rendered broken. If completed entries should always link to the paper, the backend should add the resolved `author` to the entry shape or expose the bridge account in the injected config. Left as graceful degradation rather than guessing.

**Verification:** all touched/new unit suites pass (`pages-bridge`, `pages-my-imports`, `lib-format-eta`); `tests/e2e/bridge-import-queue.spec.js` passes (backend test-mode, dev routing restored after). Production `vite build` succeeds.

## Architect review (2026-05-26) — HELD PENDING FIXES (round 1):

`/ce-code-review` on the implementing diff (commits `5eb66f81` scaffold + `e53306fd` wiring; 9 personas — correctness + adversarial on Opus, api-contract/reliability/julik-frontend-races/testing/maintainability/project-standards/learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO). The substantive logic is correct — the queued/cap state machine, the per-IP-vs-per-user cap discrimination (`details.cap` presence), `formatEta` edge cases, the LOCK_HELD retry loop, and `bridge.js`'s own `_mounted` teardown guards all verified. The fixes below block archive. Land them, then `git mv` this file back to `tasks/review/`.

1. **(P1) `my-imports.js` has no teardown guard — add `createTimerGuard` + `_mounted` + `destroy()`.** `myImportsPage` is the only async page in `frontend/src/pages/` that does not spread `createTimerGuard()` (every sibling does, and `bridge.js` in this same diff does). `frontend/src/components/page-mount.js` calls `Alpine.destroyTree` on route change, so a `loadEntries()`/`retryEntry()`/`handleConnect()` that resolves after navigation writes reactive state (`this.entries`/`this.error`/`this.loading`/`this.retryingId`) and fires a toast on a destroyed component. Spread `createTimerGuard()` into the factory, add `destroy() { this._teardownTimers(); }`, and gate every post-`await` write with `if (!this._mounted) return;` (and `if (this._mounted) this.loading = false;` in the `finally`), matching the established pattern.

2. **(P2) `retryingId` scalar cannot serialize concurrent retries of distinct entries.** The `this.retryingId === entry.id` guard blocks a double-click on the same row but not a second retry on a different failed entry while the first is in flight; both reach `await registerBridgePaper`, and the success-reload race can re-enqueue. Backend dedups a re-POST of an active entry (`DUPLICATE`/`LOCK_HELD`), but the UI should not lean on that. Simplest fix: a single `isRetrying` boolean (one retry at a time) or a `Set` of in-flight ids; update the template `:disabled` binding accordingly.

3. **(P2) `retryEntry` swallows `DUPLICATE`/`RATE_LIMITED`+cap/`LOCK_HELD` into a generic toast.** A cap-hit or duplicate during retry shows the same misleading "try again" `common.error`. Discriminate `err.code` in the `retryEntry` catch before the generic fallback, mirroring `handleRegister`'s existing discrimination, so the user gets actionable feedback.

4. **(P3) `retriable` is hardcoded to `state === 'failed'`; derive it from `error_code`.** Per `bridge.md`'s `error_code` values, a terminal `BAD_REQUEST` (source gone) is not retriable, while `BROADCAST_*`/`SERVICE_UNAVAILABLE` are. The current hardcode shows a Retry on terminal failures whose re-POST deterministically re-fails, and leaves the `cannotRetry` template branch permanently dead. Derive `retriable` from `error_code` so the dead branch renders and guaranteed-fail retries are suppressed.

5. **(P3) `loadEntries` has no in-flight guard.** Concurrent calls (init + retry-success reload + error-banner Retry) last-writer-wins on `this.entries`. Benign today (idempotent reads, double skeleton flash) but a one-line `if (this.loading) return;` closes it.

6. **(P3) `queuedDetailText` fabricates "position 1" when the 202 omits `queue_position`.** `queue_position` is normally present per contract, so this is defensive: when `queuedPosition` is null, render a position-agnostic queued string rather than asserting a position the backend never sent.

7. **(P3) Delete the orphaned `bridge.stepSuccess` i18n key.** The synchronous-success step was replaced by `queued`; the key is unreferenced across `frontend/src` and `frontend/tests`. Remove it from `en.json` and all 15 locale stubs (and its `STUBS.md` row if present).

8. **(P3) Re-anchor the "earlier consumer sketch" comment.** The `adaptEntry` docblock in `my-imports.js` references the task file's predating consumer sketch, which becomes a dead pointer when this task archives (root `CLAUDE.md` "Comment anchors"). Reword to anchor on the stable `bridge.md` `GET /api/bridge/imports` contract instead.

9. **(P3) Document the full view-model shape.** The view-model docblock omits `discipline`, `keywords`, and `language`, which `adaptEntry` produces and `retryEntry` reads back when re-POSTing. Add them.

10. **(gated on `backend-bridge-imports-entry-enrich`) Wire title labels, per-row ETA, and the View-paper link for ALL completed entries.** This is the flagged design gap, resolved as "enrich the backend contract" (architect + user, 2026-05-26). `bridge.md`'s `GET /api/bridge/imports` entry now documents `title`, `eta_seconds`, and a resolved `author`; the backend task populates them. Once that lands: the `adaptEntry` seam already reads `wire.title`/`wire.eta_seconds`, so the only consumer edit is widening `author: wire.existing_author ?? null` to `wire.author ?? wire.existing_author ?? null` and dropping the `?demo=1`-only synthetic `title`/`eta_seconds` masking. **This item alone is gated on the backend task; items 1–9 are independent and land now** — which is why this file goes to `pending/`, not `blocked/`.

While addressing the above, also add the unit coverage the review found missing (fold into the relevant fix, do not over-harden): teardown-during-fetch (item 1), two concurrent `retryEntry` calls on distinct entries (item 2), a completed entry WITHOUT `existing_author`/`author` asserting the link is suppressed (until item 10 lands) then rendered (after), `badgeClass` switch, and `init(disconnected)`/`handleConnect`-rejection branches.

Verified-clean, no action: the synchronous-flag-before-await idempotency guard is satisfied (`retryingId` is set before the `await`) and the `finally` resets are unconditional — both compliant with the documented conventions. Dismissed: malformed/hostile wire `id` collapsing the `x-for :key` (confidence below the review gate; the contract guarantees a non-null unique `id`, and Alpine `x-text` auto-escapes so no XSS path).

