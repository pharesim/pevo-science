# UI-RETIRE-BRIDGE-SYNC-AFFORDANCE — remove "Bridge sync" button and supporting code

**Owner:** UI Agent
**Created:** 2026-05-06 (filed at archive of `backend-continuation-post-author-consent-gate.md`, A6)
**Priority:** P3

## Problem

The paper-detail page surfaces a "Bridge sync" button that triggers `POST /api/bridge/update` on the backend. Bridge papers are immutable post-publish (per the policy ratified at `backend-continuation-post-author-consent-gate.md` round-4 user triage). The button is dead UX; clicking it accomplishes nothing meaningful and risks confusing users.

## Goal

Remove the "Bridge sync" affordance and all its supporting code from the frontend.

## Acceptance

1. **Remove the button.** Delete the "Bridge sync" button from the paper-detail page (Alpine.js component / template).

2. **Remove the handler.** Delete `handleBridgeSync()` (or whatever the click handler is named) and `updateBridgePaper()` (the API helper).

3. **Remove i18n keys.** Delete the related entries from the i18n bundle:
   - `bridge.syncing`
   - `bridge.syncButton`
   - `bridge.syncSuccess`
   - `bridge.syncFailed`
   (Verify final key list in `frontend/src/i18n/` — names above are illustrative.)

4. **Verify.** Page renders without errors; no broken references; targeted UI smoke (open a bridge paper detail page, confirm no console errors, no missing translations). E2E suite stays green.

5. **Out of scope.** Other bridge-paper UI surfaces (the bridge writer's publish flow, bridge-paper claim UX, the bridge identity badge) stay.

## Coordination

- Pairs with `backend-retire-bridge-update-route.md` (backend side) and `architect-bridge-paper-immutability-doc.md` (doc side). All three can land independently.
- If the backend route ships first, the button becomes a no-op until this UI task lands. If this UI task ships first, the route still exists but is never invoked from PEvO surfaces. Either order is safe.

---

## UI implementer signal (2026-05-06, commit `7a1251e`)

Acceptance items 1-3 landed in `ui(bridge): retire bridge sync affordance from paper-detail` (commit `7a1251e`):
- (1) "Bridge sync" button removed from paper-detail page.
- (2) `handleBridgeSync` handler + `syncLoading` state + `updateBridgePaper` API helper removed.
- (3) `bridge.syncing`, `bridge.syncButton`, `bridge.syncSuccess`, `bridge.syncFailed` keys removed from all 16 locale files.
- Matching unit test removed from `frontend/tests/unit/pages-paper-detail.test.js`.
- Sibling `bridge.sourcePanel` + `bridge.viewSource` i18n keys preserved (still in use by source-attribution panel).
- No implementer signal block written at the time of the commit (process hygiene gap); the commit message + diff is the implicit signal. Architect's intake review verifies the work landed cleanly.

---

## Architect re-review (2026-05-11) — HELD PENDING FIXES

`/ce-code-review` ran on commit `7a1251e` with 4 reviewer personas (correctness, testing, maintainability, project-standards at sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). The retirement is clean — button, handler, API helper, and i18n keys all removed consistently across 16 locales. The unit test removal is scoped correctly (was bridge-sync-specific only). Sibling i18n keys (`bridge.sourcePanel`, `bridge.viewSource`) preserved correctly for the source-attribution panel that remains. No collateral coverage lost. One small comment-rot issue surfaced that the architect held to keep this task from archiving with content that becomes wrong once the companion backend retirement task (`backend-retire-bridge-update-route.md`) archives.

### Items to address (single small fix)

**1. (P3, anchor 75, cross-reviewer correctness + maintainability) Stale `/api/bridge/update` references in 2 inline comments.** Two sites:
   - `frontend/src/pages/paper-detail.js:290-291` — HTML comment reads "Bridge papers update via /api/bridge/update; the SPA edit flow doesn't apply." The `!isBridgePaper` Edit-affordance gate at the next line IS load-bearing, but the comment justifies the gate by reference to a soon-to-be-retired endpoint.
   - `frontend/tests/unit/pages-paper-detail.test.js:211` — mirror comment with the same wording.

   Once `backend-retire-bridge-update-route.md` archives (and `/api/bridge/update` ceases to exist in source), these comments become factually wrong: they cite an endpoint that doesn't exist.

   Fix: replace the `/api/bridge/update` reference at both sites with the substantive policy rationale — bridge papers are immutable post-publish per the keystone policy ratified at `backend-continuation-post-author-consent-gate.md` round-4 (Hive-side: re-publish from source, not via the SPA edit flow). Architect-suggested wording (not binding):
   ```
   // Bridge papers are immutable post-publish per the keystone policy (Hive-side
   // re-publish from source). The SPA edit flow does not apply; the
   // `!isBridgePaper` gate below suppresses the Edit affordance for bridge papers.
   ```
   Identical wording at both sites keeps them in sync. About 3 lines each, 6 lines total.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. Architect's re-review scopes `/ce-code-review` to the round-2 commit only. Item is comment-only; clean pass + archive is the expected outcome.

### Archive ordering note

This task's archive should happen AFTER `backend-retire-bridge-update-route.md` archives, so the rewritten comment text accurately describes the post-retirement state of the codebase.