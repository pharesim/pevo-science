# BACKEND-RETIRE-BRIDGE-UPDATE-ROUTE — remove `POST /api/bridge/update` and helpers

**Owner:** Backend Agent
**Created:** 2026-05-06 (filed at archive of `backend-continuation-post-author-consent-gate.md`, A6)
**Priority:** P3

## Problem

Bridge papers are immutable post-publish (per the policy ratified at `backend-continuation-post-author-consent-gate.md` round-4 user triage; documented by the companion architect task `architect-bridge-paper-immutability-doc.md`). The update path is dead code:

- `POST /api/bridge/update` route in `backend/src/routes/bridge.ts`
- `bridgeUpdateLockKey` helper (Redis lock for bridge update broadcasts)
- Related tests in `backend/tests/routes/bridge.test.ts` and `backend/tests/routes/bridge-haf-lag-locks.test.ts`

Keeping dead code around is a maintenance tax; it also presents an attractive nuisance for any future contributor who tries to re-enable bridge updates without first relaxing the immutability policy in ARCH.md.

## Goal

Remove the bridge-update route and its supporting helpers. Defense-in-depth in `extractAuthorizedContinuationAuthors` (the Option-b carve-out admitting `config.hiveBridgeAccount` as a bridge-paper continuation author) stays in place — that carve-out belongs to the gate's invariants, not to the update flow.

## Acceptance

1. **Remove the route.** Delete `POST /api/bridge/update` from `backend/src/routes/bridge.ts`. Remove any imports / handlers that become unused as a result.

2. **Remove the lock helper.** Delete `bridgeUpdateLockKey` and any callers. If the helper sits in a shared module alongside other bridge helpers that ARE still used, narrow the deletion to the dead helper only.

3. **Remove tests.** Delete the bridge-update tests in `backend/tests/routes/bridge.test.ts` and `backend/tests/routes/bridge-haf-lag-locks.test.ts`. Other tests in those files (publish flow, HAF-lag-lock canaries unrelated to update) stay.

4. **Verify.** `npx tsc --noEmit` clean. Targeted vitest on the bridge tests + canonical-walker tests + continuation-author-gate tests stays green. Bridge-paper publish flow unaffected.

5. **Out of scope.** The Option-b carve-out in `extractAuthorizedContinuationAuthors` stays. The bridge writer flow (`POST /api/bridge` and the writer's broadcast helpers) stays. Only the post-publish update path is removed.

## Coordination

- Pairs with `ui-retire-bridge-sync-affordance.md` (UI side of the same retirement) and `architect-bridge-paper-immutability-doc.md` (doc side). All three can land independently; lockstep is not required. The UI affordance is harmless if the backend route is removed first (frontend would surface a clear 404); the inverse is also fine (frontend button becomes a no-op until the architect doc rewrite lands).
