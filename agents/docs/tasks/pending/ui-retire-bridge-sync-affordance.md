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
