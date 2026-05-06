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

## Backend implementation note (2026-05-06)

Code-side acceptance landed:

- `backend/src/routes/bridge.ts` — deleted `POST /api/bridge/update`, `bridgeUpdateLockKey` helper, and the `updateLimiter` rate-limit binding. Narrowed the `BE-BRIDGE-WRITE-HAF-LAG` header comment to /register-only. Pruned now-orphan imports (`hiveClient`, `parseMeta`, `isPevoBridgePaper`). Option-b carve-out in `extractAuthorizedContinuationAuthors` (helpers.ts) untouched per the spec; `acquireBridgeLock` / `releaseBridgeLock` / `BRIDGE_LOCK_*` primitives kept (still used by /register).
- `backend/tests/routes/bridge.test.ts` — deleted the `/update` auth-headers describe, the `/update` 503-misconfig spec, and the entire `BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — /update timeout discrimination` describe. Pruned the now-unused `databaseCall` mock; narrowed file-header doc + the misconfig-503 describe header.
- `backend/tests/routes/bridge-haf-lag-locks.test.ts` — deleted the `BE-BRIDGE-WRITE-HAF-LAG — /update concurrent same-paper lock` describe and the now-unused `databaseCall` mock + matching `afterEach` import. Narrowed file-header doc.

Verification:
- `npx tsc --noEmit` — clean.
- `npx vitest run tests/routes/bridge.test.ts tests/routes/bridge-haf-lag-locks.test.ts tests/routes/bridge-paper-author-gate.test.ts tests/routes/canonical-root-walker.test.ts tests/routes/continuation-author-gate.test.ts` — 5 files / 73 specs / 0 failures.
- `npm run lint` — 0 errors. (Pre-existing 2 `no-explicit-any` warnings in `seed-phrase.ts` are outside this task's scope.)

[TODO Architect] (contract-doc cleanup at archive)

Three contract-doc edits are gated behind this task and are architect-owned per backend CLAUDE.md:

1. `agents/docs/api-contracts/bridge.md` — delete the entire `### POST /api/bridge/update` section (currently lines 152-190 inclusive, including the leading `---` separator on line 150 if no other section follows).
2. `agents/docs/api-contracts/common.md` line ~75 (the `503 SERVICE_UNAVAILABLE` row) — drop `/api/bridge/update` from the enumerated bridge-account-broadcast paths in the prose: "emitted by bridge-account broadcast paths (`/api/bridge/register`, ~~`/api/bridge/update`,~~ and the admin-on-bridge-paper branches of …)".
3. `agents/docs/api-contracts/common.md` line ~179 (the rate-limit table) — delete the `| POST /api/bridge/update | 10 requests | per IP per hour |` row.

No prose-only cross-references in other in-flight task files (e.g. `backend-broadcast-idempotency-cluster-followup.md`, `ui-coauthor-continuation-publishing.md`, `backend-bridge-custody-broadcast-discrimination.md`) need rewriting on the architect's plate; those files will resolve their own references as they archive.
