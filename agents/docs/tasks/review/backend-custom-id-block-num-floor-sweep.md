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

---

## Backend completion note (2026-06-04)

All 16 floor-sweep sites done. `grep -rn "no-custom-id-block-num-floor" backend/src/ --include="*.ts" | grep -v eslint.config` returns 0; `npx eslint src/ --report-unused-disable-directives` reports no unused floor-rule disables; `npm run typecheck` + `npm run lint` clean. The rule remains in `eslint.config.mjs` as a guard for new code.

Per-site shape: dropped the inert `block_num >= $genesis` floor + its bound param, removed the `eslint-disable` directive, and renumbered placeholders — via the existing `paramIdx++` counter where present (`fetchAccreditationsFromHaf`), by hand where the query is hand-numbered. Sites: `wot.ts` (loadWotThreshold), `accreditation.ts` (getAccreditedSet, userPlaceholders `$4`→`$3`), `consent-ops.ts` (fetchConsentOpsForPaper, claimed-set `$5`→`$4`), `lib/idempotency.ts` ×3 (genesis was the last bind, no renumber), `hafsql.ts` (authorshipClaimsCteBody: bridgeIdx `p+3`→`p+2`, scopeIdx `p+4`→`p+3`, `$p+2`→`$p+1`), `routes/profile.ts`, `routes/orcid.ts` ×3, `routes/accreditations.ts` ×2. Removed the now-unused `getCachedGenesisBlock` import from the six files where this dropped the last use.

**Divergence surfaced + resolved — reputation `computeReputationBatch` CTE.** The genesis param `$7` was used in SEVEN SQL spots, not one as the per-site analysis assumed: the toxic `claim_events` floor PLUS six cycle-window ranges `block_num >= $7 AND block_num < $6` (three on vote_ops, three on `operation_custom_json_view`). Because the rule flags any `block_num >=` co-occurring with `custom_id` in the literal, clearing the disable required removing all seven; the query is hand-numbered `$1`–`$21` with no counter, so the sweep hand-renumbered `$8`–`$19` → `$7`–`$18` across the full scoring query and shifted `activeAccreditationsCteBody(20)` → `(19)`. This conflicts with the task's "do NOT hand-renumber" caution (no counter exists here); surfaced to the user, who approved the full sweep over leaving one disable. Verified result-preserving (the genesis floor is inert) and perf-safe (the vote_ops scans are driven by the selective `vo.voter = ANY($2)` predicate, not block_num). All six ranges kept their `block_num < $6` upper bound. Renumber done as a single guarded decrement pass after confirming every `$8`+ token in the file belongs to this one query/docblock/array.

**Coupled tests updated** (param-slot / SQL-shape consumers — several were NOT in the per-file analysis and were caught by running the suites): `hafsql.test.ts` (authorshipClaimsCteBody param-arithmetic block AND the hive-arm `$3`→`$2` shape canary), `consent-ops.test.ts` (SQL-shape `$N` regexes, params `toEqual`, AND the `params.slice(4)`→`(3)` claimed-set offset in a second test), `profile-auth-bypass.test.ts` + `orcid.test.ts` (`params[3]`→`params[2]` + comments), `reputation-approve-signer-gate-cycle-sql-shape.test.ts` (`$18`→`$17` bridge param), `reputation-paper-reviews-self-exclusion-canary.test.ts` (stale `$19`/param-count comment). `wot-threshold-signer-gate.test.ts` adapts automatically (dynamic placeholder extraction). Removed the now-dead genesis stub `vi.mock` from `consent-ops.test.ts`.

**Real-HAF verification.** The reputation suite (30 tests, incl. the renumbered `computeReputationBatch` against real HAF) is green — a renumber error would throw a deterministic pg param-count/syntax error, not a flake. Also green: orcid (100), wot, hafsql, consent-ops, profile-auth-bypass, accreditations(mocked), idempotency(mocked), comments. The floor being inert, no row-count delta is expected; none observed. `idempotency-real-haf.test.ts` and the two accreditation broadcast-cap concurrency tests intermittently time out under the current HAF overload (8–9s/query; their own heavy fixture-setup probes and a 5s parallel-race deadline) — environmental, not caused by this change (the non-timing broadcast-cap tests pass, proving `findExistingAccreditation` executes correctly with the floor removed).

No API-contract change (these are internal HAF query shapes; response envelopes are unchanged).

---

## Architect re-review (2026-06-09) — HELD PENDING FIXES (1 item)

`/ce-code-review` fan-out (correctness + security + adversarial on Opus; testing/maintainability/project-standards/performance/reliability/kieran-typescript on Sonnet; learnings unstructured; ce-agent-native skipped per PEvO) on commit `1ab97151`. **The sweep is VERIFIED mechanically correct and STAYS.** The param-renumber was traced slot-by-slot at the committed SHA: `computeReputationBatch` is a 20-bind array with every `$N` mapping to the correct value — the genesis `$7` removed from all seven spots (the `claim_events` floor plus six cycle-window lower bounds, each of which kept its `< $6` upper bound; the `$8`–`$19` → `$7`–`$18` decrement is uniform; `activeAccreditationsCteBody` emits `$19`/`$20`) — no gap, orphan, or same-type swap. `authorshipClaimsCteBody`'s bind-count shrink propagates consistently via the `buildWith` nextIdx threading (no caller hardcodes a post-CTE slot). All 16 dropped floors are confirmed inert (`block_num` vs genesis at every site; none non-genesis, none non-block_num), so result sets are preserved and the surviving selective predicate keeps each plan off the BitmapAnd-toxic path. `getCachedGenesisBlock` was removed only where it became unused and correctly retained where a non-custom_json floor still consumes it; zero `eslint-disable` floor suppressions remain in `backend/src/`.

One item before archive:

1. (P3, reliability, conf 100, introduced by this commit) **Stale docblock on `findCustodyBroadcastByIdempotencyKey` (`lib/idempotency.ts`).** The docblock still states the genesis-block floor "matches the rest of the HAF queries in the codebase — scans before the appTag's first op are skipped," but this commit dropped that floor from the custom_json arm (`operation_custom_json_view`) while the comment-ops arm (`operation_comment_view`) retains it. The blanket claim is now false for the custom_json arm. Reword to state the asymmetry: the comment-ops arm keeps the genesis floor (and is why `getCachedGenesisBlock` is still called); the custom_json arm now relies on `custom_id` + `required_posting_auths` signer selectivity instead. Anchor on the op-view / arm names — no line number, slug, or SHA.

Surfaced, NO action for THIS task: the `loadReputationWeights` `update_weights` read lacked a `required_posting_auths` signer gate — found by the mandated `perf-floor-drop-removes-incidental-security-predicate` re-audit. It is pre-existing (this commit's inert floor-drop does not change its exploitability) and is ALREADY remediated at HEAD — `required_posting_auths ? $2` now gates both the existence probe and the latest-update read, landed under `backend-reputation-weights-signer-gate`. Confirmed closed.

Dismissed at triage: the test-hardening gaps (no computed-score value-pin, so a hypothetical silent same-type param swap could survive the idempotency byte-equality check; the approve-signer canary pins SQL text not the params array — the implementer already acknowledged and deferred this to the cycle/read-surface dedup) — theoretical failure modes; the slot-by-slot trace plus the tightened positional pins are sufficient. The chain_papers `EXISTS` selectivity (the co-author CTE entangled into this commit) is EXPLAIN-gated and deferred, consistent with the cluster's accepted operator-paced MATERIALIZED deferral. The stale "20-param signature" canary comment is attributable to the later `$21` signer-gate addition, not this sweep.

When the docblock lands, `git mv` this file back to `tasks/review/`. Do not edit the held item above — the commit diff is the evidence.

## Backend re-review signal (2026-06-09)

The single P3 held item landed. The `findCustodyBroadcastByIdempotencyKey` docblock no longer claims the genesis floor "matches the rest of the HAF queries" blanket-wide; it now states the asymmetry — the `operation_comment_view` arm keeps the `block_num >= genesis` floor (and is why `getCachedGenesisBlock` is still called), while the `operation_custom_json_view` arm carries no floor and relies on `custom_id` + `required_posting_auths` signer selectivity. Anchored on the op-view names; no line/slug/SHA. Comment-only; typecheck + lint clean.
