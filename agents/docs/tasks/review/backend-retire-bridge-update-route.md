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

## Architect re-review (2026-05-06) — HELD PENDING FIXES

`/ce-code-review` on `e647abb` came back clean on correctness, security, project-standards, and the test-coverage delta. Architect-owned contract-doc edits (TODO Architect items 1-3 above) remain deferred to archive — they will land in a single architect-zone commit when this task finally clears.

Three classes of stale `/update` reference, however, must be cleaned up before this task archives. The deletion's stated goal — "remove the attractive nuisance for any future contributor who tries to re-enable bridge updates" — is undercut as long as live code/tests continue to cite `/update` as the runtime mechanism for bridge-paper continuations or carry dead handler shape on a typo-protection interface.

1. **`backend/src/helpers.ts:84`** — comment in `extractAuthorizedContinuationAuthors` cites `bridge.ts /update path` as rationale for the Option-b carve-out. Reword to anchor on the immutability policy: e.g., "bridge papers are immutable post-publish; the bridge account vouches for original-preprint authors who lack on-chain identity, gating continuations (reviews/discussions only) on the bridge account." The Option-b carve-out itself stays — it is now strictly defense-in-depth under the immutability policy.

2. **`backend/tests/routes/continuation-author-gate.test.ts:153, 422, 461`** — three design-rationale comments name `bridge.ts /update path` as the live continuation mechanism for the bridge account. Tests themselves are correct (the Option-b carve-out is exercised via canonical-walker / continuation-author-gate paths); only the embedded prose is stale. Reword each site to reference the immutability policy and the Option-b carve-out instead of the deleted route.

3. **`backend/src/lib/broadcast-error.ts:115-118`** — `LogContext.newVersion?: number` and `LogContext.sourceIdentifier?: string` are dead optional fields after `/update` deletion. Both have zero call sites in `backend/src/` per the kieran-typescript reviewer's grep. The JSDoc on line 115 still says "Bridge paper version after an /update broadcast". Delete the two fields and the JSDoc that introduces them — leaving `?:` optional fields with no live producer undermines the typo-protection contract `LogContext` was introduced to provide.

When all three are landed, `git mv` this file back to `tasks/review/`. The architect's re-review will run `/ce-code-review` scoped to the new commits (not the whole task history) and either archive or append a new hold block.

[TODO Architect-followup at archive] Per finding 9 of this review pass, the architect already edited `agents/docs/tasks/review/ui-coauthor-continuation-publishing.md` lines 26 and 73 in the same commit that filed this hold block, dropping the stale `/api/bridge/update` rationale. No further cross-task edits remain.

## Backend re-review signal (2026-05-06, main-tree SHA `60841e4`)

All three architect hold items landed in commit `60841e4`:

1. **`backend/src/helpers.ts:81-91`** — extractAuthorizedContinuationAuthors's bridge-paper bullet rewords the rationale to anchor on the immutability policy. Removed the line citing "bridge papers' canonical update path IS the bridge account itself (bridge.ts /update posts a continuation under config.hiveBridgeAccount)". The Option-b carve-out itself stays as documented; the doc-string now describes it as "strictly defense-in-depth under the immutability policy".

2. **`backend/tests/routes/continuation-author-gate.test.ts:152-160, :419-430, :463-464`** — three design-rationale comments rewored on the immutability + Option-b-carve-out framing. Architect's hold cited lines 153/422/461; actual sites were 153/424/463 (small line-number drift since the architect's grep). Test logic unchanged. Post-fix grep `grep -n "/update\|bridge.ts /update\|bridge /update" backend/tests/routes/continuation-author-gate.test.ts backend/src/helpers.ts` returns zero hits, confirming the in-scope sweep is complete.

3. **`backend/src/lib/broadcast-error.ts`** — deleted `LogContext.newVersion?: number` and `LogContext.sourceIdentifier?: string` plus the two JSDoc lines that introduced them (the `attempt_n` JSDoc above and `identifier` JSDoc below now sit adjacent). Pre-deletion grep `grep -rn "newVersion\b\|sourceIdentifier\b" backend/src backend/tests` returned only the two declarations, zero callers — confirming the architect's kieran-typescript-reviewer call-site finding.

### Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/routes/continuation-author-gate.test.ts tests/routes/canonical-root-walker.test.ts tests/routes/bridge.test.ts tests/routes/bridge-haf-lag-locks.test.ts` — 4 files / 60 specs / 0 failures.
- `npm run lint` — 0 errors. (Pre-existing 2 `no-explicit-any` warnings on `seed-phrase.ts:26-27` are out of scope, same as round-1.)

### Working-tree-state note for the architect

The hold-block content from the architect's commit `41705ca` was sitting uncommitted in the working tree when backend picked this up at startup — `git show 41705ca --stat` reports 0 bytes changed for `backend-retire-bridge-update-route.md` (only the rename + sibling-task edits were captured). The hold-block content has now been committed alongside the round-2 fixes' task-file changes in this commit (the same commit that performs the `git mv` from pending/ to review/). No content was modified inside the architect's hold block — backend appended only this re-review signal block underneath, per the protocol.

### Out of scope (honored)

- TODO Architect items 1-3 (contract-doc edits in `agents/docs/api-contracts/bridge.md` and `agents/docs/api-contracts/common.md`) remain deferred to architect's archive-time commit per backend CLAUDE.md.
- TODO Architect-followup at archive (sibling-task edits to `ui-coauthor-continuation-publishing.md`) was already landed by the architect in commit `41705ca` per the architect's own note above; no further cross-task edits required.
