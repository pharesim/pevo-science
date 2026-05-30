# BACKEND-CUSTOM-ID-BLOCK-NUM-FLOOR-SWEEP — drop the inert `block_num >= $genesis` floor at the 16 eslint-suppressed BitmapAnd-toxic sites

**Owner:** backend
**Created:** 2026-05-30 (architect, from the `[TODO Architect]` carried out of `backend-eslint-rule-bitmapand-floor-guard`, archived 2026-05-30)
**Priority:** P2 (latent performance risk; each site is currently narrowed by an additional selective predicate, but the BitmapAnd-toxic static-SQL fingerprint is still present, and a planner-stats shift on Mahdi's HAF could flip any of them to the 503-producing plan. The floor is by-construction inert, so removing it is safe and cheap — but the param-arithmetic edit is delicate; see the warning below.)

## Problem

The ESLint rule `pevo/no-custom-id-block-num-floor` (in `backend/eslint.config.mjs`) guards against the BitmapAnd-toxic SQL shape `custom_id = $appTag AND block_num >= $genesis` against `hafsql.operation_custom_json_view`. The original two fixes (`285e7c14`, `e31c984f`) cleaned the unconstrained-namespace cases (`activeAccreditationsCteBody` is now 2-bind, no floor). When the rule landed it surfaced **16 pre-existing sites** that still carry the toxic fingerprint. Each was suppressed with an `eslint-disable-next-line pevo/no-custom-id-block-num-floor` directive carrying a per-site rationale, NOT fixed — the rule shipped as a guard for new code without forcing per-site SQL surgery in that task.

Each of the 16 sites carries an **additional selective predicate** (per-account `account = $username`, per-orcid `orcid = $orcidId`, per-key `idempotency_key = $key`, per-paper `root_author + root_permlink`, scoped `target_users`/`target_authors`, etc.) that the planner *may* favor over the BitmapAnd path. But the toxic shape is still the static-SQL fingerprint, and a planner-stats shift could flip any of them. The `block_num >= $genesis` floor is **by-construction inert**: pre-genesis PEvO-namespace `custom_json`s cannot exist, so the predicate never excludes a row. Dropping it changes no result set and removes the plan-toxic element.

## The 16 sites (verified live 2026-05-30)

Located via `grep -rn "no-custom-id-block-num-floor" backend/src/ --include="*.ts" | grep -v eslint.config`. Anchored on enclosing symbols (line numbers will drift — re-grep before editing):

- `backend/src/accreditation.ts` — `getAccreditedSet` (batch `account IN (...)` narrowing)
- `backend/src/consent-ops.ts` — `fetchConsentOps` (`root_author` + `root_permlink` + claimed-signer IN-list)
- `backend/src/hafsql.ts` — `authorshipClaimsCteBody` (optional `scope` claimer/paper-key JSONB predicates) — **CTE-body helper, see param-arithmetic warning**
- `backend/src/lib/idempotency.ts` — `findOpByIdempotencyKey`, `findAccreditationBroadcastByIdempotencyKey`, `findExistingAccreditation` (3 sites; per-key / per-account narrowing)
- `backend/src/reputation.ts` — `loadReputationWeights` existence probe (2s LOCAL `statement_timeout`), `loadReputationWeights` latest-update read (5s LOCAL `statement_timeout`), `computeReputationDelta` batch CTE (background job; sub-CTEs scoped by `target_users`/`target_authors`) (3 sites)
- `backend/src/routes/accreditations.ts` — `fetchAccreditationsFromHaf` listing (60s `hafCache.getOrSet`), `fetchAccreditationStatusFromHaf` per-account read (2 sites)
- `backend/src/routes/orcid.ts` — `getOrcidAccount` recent-binding probe (per-orcid), `getOrcidAccount` status re-check (per-account), `getExistingAccreditation` per-account read (3 sites)
- `backend/src/routes/profile.ts` — profile-page accreditation read (per-account)
- `backend/src/wot.ts` — `loadWotThreshold` (single-row latest-`update_params` read; bare/unaliased `custom_id`)

Total: 16. The fix shape per site mirrors `285e7c14` / `e31c984f`: drop the `cj.block_num >= $genesis` (or unaliased `block_num >= $genesis`) predicate AND its bound param, then remove the disable directive.

## ⚠️ Param-arithmetic warning (load-bearing)

Dropping the `$genesis` **bound param** shifts every subsequent `$N` placeholder in that query. This is the exact failure class that produced the `backend-reviews-sql-accreditation-gate-404-regression` task: a CTE's bind count changed and a downstream consumer's hardcoded param-slot assumption silently broke (there, a test mock reading `params[3]`/`params[5]` instead of `params[2]`/`params[4]`). For each site:

- Use the existing `paramIdx++` / counter pattern at the call site; do NOT hand-renumber placeholders.
- For the CTE-body helper `authorshipClaimsCteBody`: its param-count is pinned by a unit test (mirroring the `activeAccreditationsCteBody` / `retractedPapersCteBody` param-arithmetic blocks). Removing the genesis bind drops its `params.length` — **update the param-arithmetic test to the new bind count**, and audit every consumer (including any test mock that hardcodes the CTE's bind count, as `reviews.test.ts`'s `installGateResponder` does) for a stale slot assumption.
- Grep for other consumers of each edited query's param array before landing the drop.

## Goal

Audit and fix all 16 sites: drop the inert `block_num >= $genesis` floor + its bound param, confirm the remaining selective predicate keeps the result set and ordering unchanged against real HAF, then remove the `eslint-disable` directive. After the sweep, the rule has **zero** live suppressions in `backend/src/` and stands purely as a guard for new code.

May be implemented as one commit or split into per-site / per-file sub-batches (worktree fan-out is reasonable given the 9 files — but commit each site with its own real-HAF verification note; do NOT batch-drop floors without per-site row-count confirmation).

## Acceptance

- All 16 `block_num >= $genesis` floor predicates removed, with their bound params removed and placeholder arithmetic correct (counter pattern, not hand-renumbering).
- All 16 `eslint-disable-next-line pevo/no-custom-id-block-num-floor` directives removed. Verify: `grep -rn "no-custom-id-block-num-floor" backend/src/ --include="*.ts" | grep -v eslint.config` returns **0** results; `npx eslint src/ --report-unused-disable-directives` shows 0 unused floor-rule disables; `npx eslint src/` 0 errors.
- `authorshipClaimsCteBody` param-arithmetic test updated to the new (genesis-dropped) bind count and green; any test mock hardcoding a CTE bind count (e.g. `reviews.test.ts` `installGateResponder`) audited and still green.
- **Per-site real-HAF behavioral verification:** for each site, confirm the row set and ordering are unchanged vs the pre-drop query (the floor is inert, so the counts MUST match). Record the per-site confirmation in the commit/signal — a planner-only change with no row-count delta is the success signal.
- `npm run typecheck` + `npm run lint` clean from `backend/`; affected suites green (reputation, idempotency, accreditation, accreditations route, orcid route, profile route, wot, consent-ops, hafsql CTE-body tests).
- Comment anchors clean (no task slug, round number, line number, or SHA introduced; the removed disable rationales took the "pending audit per the BitmapAnd-floor sweep follow-up" phrasing with them).

## Notes / cross-references

- `backend/eslint.config.mjs` — `noCustomIdBlockNumFloorRule` (the guard); leave it in place, it protects new code.
- `agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` — the audit-discipline lesson that motivated the rule.
- Commits `285e7c14` + `e31c984f` — the canonical floor-drop fix shape and the planner reasoning.
- The `activeAccreditationsCteBody` docstring (`backend/src/hafsql.ts`) — the BitmapAnd planner rationale.
- **Interaction with `backend-getgenesisblock-fallback-no-cache` (pending):** the `$genesis` value dropped here comes from the genesis-block lookup. If removing the floor eliminates the last consumer of a genesis-block read at a given site, note it — but do NOT fold that task's caching change into this sweep; coordinate sequencing if they touch the same call path.
- Real-path discipline: per the project test rules, exercising the real query against HAF (no mock) is the verification of record for the row-count-unchanged claim. The floor being inert means any row-count delta is a bug in the edit, not an expected behavior change.
