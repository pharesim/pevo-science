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

## Architect re-review (2026-05-06, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on commit `60841e4` with 6 reviewers (correctness at opus; testing/maintainability/project-standards/learnings/kieran-typescript at sonnet). All three round-1 hold items verified addressed verbatim:

- **Item 1 (helpers.ts:84 JSDoc reword)** — old "/update path" prose removed; new text anchors on immutability + Option-b carve-out as defense-in-depth.
- **Item 2 (continuation-author-gate.test.ts three comment sites at 153/422/461 architect-cited / 153/424/463 actual)** — line drift acknowledged in backend signal; all three sites reworded on the immutability + Option-b framing.
- **Item 3 (LogContext.newVersion + sourceIdentifier deletion)** — both fields plus their JSDoc cleanly removed; kieran-typescript reviewer's grep confirms zero callers; `npx tsc --noEmit` clean per backend signal.

The round-2 fixes are correct on their own terms. However, the architect's own round-1 grep was scoped to the three cited files, missing one additional `/update`-class stale reference. Project-wide grep at re-review surfaces it.

### Items to address (round-3)

**1. (P2) Stale task-file forward-reference at `backend/src/routes/papers.ts:1126`.** Inside the `resolveContinuationChain` JSDoc, the bullet about bridge-paper Option-b cites `backend-retire-bridge-update-route.md` by path: "The bridge update flow is being retired (see `backend-retire-bridge-update-route.md`) which makes `chain.length === 1` for bridge papers in practice". When this task archives, the file at that path is `git rm`'d (per the archive protocol — prepend to `tasks-archive.md`, trim, delete the per-task file). The cross-reference rots **at the exact moment of archive**. Same class as the round-1 hold items; my round-1 grep was scoped narrowly to the three cited files and missed this site.

   Cross-corroboration from `learnings-researcher` (`conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` + `conventions/load-bearing-greps-at-signal-block-write-time-2026-05-06.md`): the convention is to run a project-wide grep at signal-block-write-time. Backend's signal-block grep was scoped to the architect's cited files only, inheriting the architect's narrow scope. The convention says project-wide grep should run regardless of hold-block scope.

   Fix: edit `backend/src/routes/papers.ts:1125-1127` to drop the task-file citation while keeping the substantive content:

   ```
    * stays locked to `{bridgeAccount}` for bridge chains. Bridge papers are
    * immutable post-publish, which makes `chain.length === 1` for bridge
    * papers in practice; the cumulative-extension path here is defense-in-depth.
   ```

   Two-line change. After the fix, run `grep -rn "backend-retire-bridge-update-route\|/api/bridge/update\|bridgeUpdateLockKey\|updateLimiter\|bridge\.ts /update" backend/src backend/tests` project-wide and include the output in the round-3 signal block, confirming zero hits before `git mv pending/ → review/`.

### Items dismissed during architect triage (round-2)

- **(P3, originally rated P1 by maintainability) JSDoc "gating" overstates the helper's role at `backend/src/helpers.ts:84-89`.** Maintainability flagged that the new JSDoc says "gating continuations (reviews/discussions only) on the bridge account" but `extractAuthorizedContinuationAuthors` returns a `Set<string>` and performs no gating; the actual gate is downstream (SQL `c.author = ANY(...)` filter + JS set-membership in `papers.ts`). Dismissed at P3 (not the maintainability reviewer's P1): the function is named `extractAuthorizedContinuationAuthors`, not `gateContinuations`, so the function-name itself signals "extract"; "gating" is contextual shorthand for "the gate (downstream) uses this set to limit allowed accounts to bridge". Sloppy architect-dictated prose, but contextually understandable. Architect-authored imprecision in the round-1 hold dictation — owned but not load-bearing enough to warrant a round-3 fix.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. Architect's round-3 review will run `/ce-code-review` scoped to the round-3 commit and either archive (along with the deferred TODO Architect contract-doc cleanups, in a separate architect-zone commit) or append a new hold block. Round-3 should be small enough that a clean pass is the expected outcome.

## Backend re-review signal (2026-05-06, main-tree SHA `<TBD>`)

Round-3's single hold item lands in this commit. Architect's hold cited `backend/src/routes/papers.ts:1125-1127`; actual stale-citation lines were `:1126-1129` (small drift, anticipated by the architect's note that "the architect's grep was scoped narrowly and the drift could be larger than expected"). The 4-line stale block was replaced with the architect's verbatim 3-line text.

### Item resolution

**Item 1 (P2) — Stale task-file forward-reference at `papers.ts`.** Edit at lines 1126-1129 (was 1125-1127 in the architect's grep). Old text:

```
 * stays locked to `{bridgeAccount}` for bridge chains. The bridge update
 * flow is being retired (see `backend-retire-bridge-update-route.md`)
 * which makes `chain.length === 1` for bridge papers in practice; the
 * cumulative-extension path here is defense-in-depth.
```

New text (architect's verbatim):

```
 * stays locked to `{bridgeAccount}` for bridge chains. Bridge papers are
 * immutable post-publish, which makes `chain.length === 1` for bridge
 * papers in practice; the cumulative-extension path here is defense-in-depth.
```

The substantive content survives — bridge-paper Option-b carve-out is preserved by construction at the cumulative-set helper level; `chain.length === 1` invariant for bridge papers carries forward; cumulative-extension path is defense-in-depth. Only the rotting task-file cross-reference is dropped.

### Project-wide grep (per architect's signal-block-write-time convention)

```
grep -rn "backend-retire-bridge-update-route\|/api/bridge/update\|bridgeUpdateLockKey\|updateLimiter\|bridge\.ts /update" backend/src backend/tests
```

Exit code 1, zero hits. Confirms the in-scope sweep is complete: no remaining citation of the retired route, the deleted helper, the deleted limiter binding, or the deleted comment-anchor in either `backend/src` or `backend/tests`.

### Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean (2 pre-existing `no-explicit-any` warnings on `seed-phrase.ts:26-27`, out of scope, same as round-1/round-2).
- Targeted vitest deferred to the parent agent's serialized full-suite pass after worker merge. The change is JSDoc-only — no runtime semantics altered, no test outcome can shift.

### Out-of-scope items honored

- TODO Architect items 1-3 (contract-doc edits in `agents/docs/api-contracts/bridge.md` and `agents/docs/api-contracts/common.md`) remain deferred to the architect's archive-time commit per backend CLAUDE.md.
- TODO Architect-followup at archive (sibling-task edits to `ui-coauthor-continuation-publishing.md`) — already landed by the architect in commit `41705ca` per the architect's own round-1 note.
- Round-2 dismissed item (helpers.ts:84-89 "gating" prose imprecision) — left unchanged per the architect's dismissal.

### Working-tree-state note

This round was implemented directly in the main checkout, not a worktree fan-out worker. Two consecutive `isolation: "worktree"` dispatches for this task hit a worktree-base-drift bug (worker worktrees branched from `2616cc1` (2026-05-01) instead of current main HEAD, missing 7 commits including `e647abb` which retired the route in the first place). Workers correctly stopped per dispatch instructions rather than `git reset --hard` to fix the base. The 2-line JSDoc edit was small enough to land in the parent's main checkout without losing the fan-out's serialization properties; sibling workers (bridge-key round-5, auth-converge) which DID branch correctly from `7b8cf0a` continue independently in their own worktrees. The base-drift bug appears specific to certain agentId-prefix patterns; root cause unknown, not investigated as part of this task.
