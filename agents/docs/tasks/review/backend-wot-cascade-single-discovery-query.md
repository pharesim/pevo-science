# BACKEND-WOT-CASCADE-SINGLE-DISCOVERY-QUERY — `cascadeRevocation` runs 1+2N HAF round-trips per cascade level in a trust-layer hot path

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, ranks #12 + #30 high+medium severity, performance/simplification; merged into one task per the synthesis recommendation)
**Priority:** P1 (rebuilds heavyweight `accred_ranked`+`vouch_ranked` CTEs over `operation_custom_json_view` 1+2K times per level; cascade recursion multiplies geometrically)

## Problem

After fetching a voucher's vouchees, the loop in [wot.ts:297-344](backend/src/wot.ts#L297-L344) fires two extra HAF queries per vouchee:
1. A `method='wot'` check.
2. A recount excluding the revoked voucher.

Each rebuilds the heavyweight `accred_ranked + vouch_ranked` CTEs over `operation_custom_json_view`. K vouchees = `1 + 2K` round-trips per level; cascade recursion multiplies geometrically.

Production path via `/api/wot/retract` (once #6 lands, this path is invoked correctly only for actual accreditation revocations); also invoked on every accreditation revocation.

## Goal

Replace the per-vouchee 2-query pair with a single discovery query per cascade level that returns the set of vouchees-to-revoke directly.

### Suggested approach

Single discovery query per cascade level:

```sql
WITH ...
SELECT av.vouchee
FROM active_vouches av
JOIN active_accreditations aa ON aa.account = av.vouchee AND aa.method = 'wot'
WHERE av.voucher = $revoked
GROUP BY av.vouchee
HAVING (
  SELECT COUNT(*) FROM active_vouches av2
  WHERE av2.vouchee = av.vouchee
    AND av2.voucher != $revoked
) < $threshold;
```

The loop then only broadcasts (and the per-iteration budget/deadline check stays unchanged). Drops discovery from `1+2N` to `1` per level.

## Acceptance

- Regression test: a cascade with K vouchees fires exactly 1 discovery query per level (not 1+2K), verified via mock-call count or query log.
- The set of vouchees-to-revoke matches the previous loop's selection exactly (no false positives, no false negatives). Pin with a test seeding multiple vouchees with varying recount results.
- The per-iteration budget/deadline check still fires on the broadcast loop (not the discovery query) — pin the deadline-stop behavior.
- The `PartialCascadeError` `completed` / `pending` accounting still reports correctly (interacts with #24 — `backend-cascade-pending-vouchees-include-slice`; land #24 first or together).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Subsumes rank #30 (`Two queries per vouchee in cascade can collapse to one`) — the synthesis flagged that as standalone only if this rewrite gets descoped. Merged here.
- Independent of #6 (`/api/wot/retract` wrong-account) — but #6 changes the upstream caller. Land both; either order works. After #6, `cascadeRevocation` is reserved for actual accreditation revocations, and this fix optimizes that hot path.
- Independent of #5 (vouch signer gate). Land both.

## Cross-references

- [backend/src/wot.ts](backend/src/wot.ts) lines 297-344 (cascade loop), 321-344 (per-vouchee 2-query pair), 382-397 (nested-error pending slice — task #24).
- HAF-query review run `w274tijk0` ranks #12 + #30 (merged).

---

## Architect re-review (2026-05-30) — HELD PENDING FIXES

Round-1 review on commit `ebddaf66`. SQL param binding clean; the per-iteration deadline/budget check and the `PartialCascadeError` completed/pending accounting are unchanged and correct. Three items hold archive (item 1 is a P1 correctness regression):

1. **INNER-JOIN selection-parity break** (P1, correctness). The discovery query's INNER joins on `av_all`/`aa_voucher` mean a vouchee whose count of currently-accredited, non-revoked vouchers is exactly zero never forms a `GROUP` and is silently NOT revoked — but the old 1+2K loop revoked it (recount 0 < threshold). This is the cascade-terminal case the mechanism exists to catch (an account left WoT-accredited with zero accredited vouchers); reachable in deep recursive chains and whenever an upstream revoke is already indexed when the deeper level runs. Found independently by the correctness and adversarial reviewers, both with full traces. Fix: `LEFT JOIN` `av_all`/`aa_voucher` with `HAVING COUNT(aa_voucher.account) < $threshold` (NULL-skipping) so a zero-remaining vouchee still forms a group and is selected, matching the old loop exactly.

2. **Parity test is mock-blind** (P2, tests). `makeCascadeHafMock` returns the to-be-revoked set directly, bypassing the real JOIN/HAVING SQL, so it cannot detect item 1. Add a real-path SQL regression (seeded HAF/Postgres per the test-mock carve-out) covering: a vouchee whose only accredited voucher is the revoked one (must be selected); a vouchee at exactly threshold remaining (must NOT) vs threshold-1 (must); and a non-wot vouchee (excluded). Also pin the threshold bind value (`params[last] === DEFAULT_WOT_THRESHOLD`, not just `typeof === 'number'`).

3. **CTE re-materialization** (P2, perf). The discovery query references `active_vouches`/`active_accreditations` twice each; without `MATERIALIZED` (PG12+ inlines CTEs) the heavy window scans over `operation_custom_json_view` may run 2-4x. Still far better than the old 1+2K shape, but consider adding `MATERIALIZED` — verify with `EXPLAIN (ANALYZE, BUFFERS)` on the HAF node before committing to it; do not apply blindly.

## Architect note (2026-06-05) — accounting scope addition from the cascade-pending-vouchees review

The slice(i + 1) fix (`backend-cascade-pending-vouchees-include-slice`, now itself held round-1) landed, satisfying this task's "land #24 first or together" acceptance condition. Its review surfaced that the NON-budget nested-error path has contested accounting: reviewers disagreed whether a non-PartialCascadeError thrown by a nested cascade drops the same-level remainders entirely or double-counts the current vouchee via the outer catch. The rewrite must pin completed/pending accounting for non-budget nested errors too, not only budget blows: on ANY nested failure, completed ∪ pending must cover every identified vouchee exactly once (no drops, no duplicates — duplicates also arise pre-rewrite from diamond graphs; see the dedup item held on the slice task). Add a regression case for a nested non-budget error (e.g. a HAF failure inside the recursive call after the parent-level broadcast succeeded).

## Backend re-review signal (2026-06-05, commit on main)

Round-1 hold items landed (dependency tasks cascade-pending-dedup + wot/retract-wrong-account already in base):
1. (P1) Cascade discovery query converted INNER→LEFT JOIN with a NULL-skipping HAVING (`COUNT(DISTINCT av_all.voucher) FILTER (WHERE aa_voucher.account IS NOT NULL AND av_all.voucher != $revoked) < $threshold`), giving zero-voucher parity with `revokeVoucheeIfBelowThreshold`. The query body is extracted to an exported `cascadeDiscoverySelect(revokedParam, thresholdParam)` so the real-Postgres test runs the production SQL verbatim.
2. (correctness) Non-budget nested-error double-count fixed: the inner catch now handles a non-`PartialCascadeError` nested throw directly (logs, keeps the parent in `completed` only, continues to independent siblings) instead of re-throwing into the outer catch where `pending.push` re-added the already-completed vouchee. `completed ∪ pending` now covers each vouchee exactly once.
3. (test) Removed the mock-blind parity test; added a real-Postgres regression running `cascadeDiscoverySelect()` against a live planner (FROM-redirect technique, own raw pg.Pool) covering the cascade-terminal INNER-vs-LEFT drop, the threshold boundary, and the non-wot gate, with the threshold bind VALUE pinned. Added a nested-error accounting regression. Carve-out clauses documented.
4. (MATERIALIZED) Skipped — discretionary/EXPLAIN-gated, explicitly not required.

MERGE NOTE: the worker branched from a base predating the cascade-pending-dedup landing; the cherry-pick auto-merged with that task's `[...new Set(pending)]` dedup at both `PartialCascadeError` throw sites — verified intact post-merge. The merged `cascadeRevocation` passes the full wot suite (15 timeout-test cases incl. diamond-graph multiplicity + nested-error accounting; 13 across wot.test / retract / active-vouches). `npm run typecheck` + `npm run lint` clean.

## Architect re-review (2026-06-09) — HELD PENDING FIXES (2 items)

`/ce-code-review` (correctness + adversarial on Opus; testing/performance/reliability/maintainability/project-standards/kieran-typescript on Sonnet; learnings unstructured; ce-agent-native-reviewer skipped per PEvO) on commit `aa88d470`, scoped to the round-2 fix.

Round-1 hold item 1 (INNER→LEFT JOIN cascade-terminal parity) is FIXED and well-covered: the LEFT JOIN + NULL-skipping `COUNT(DISTINCT av_all.voucher) FILTER (WHERE aa_voucher.account IS NOT NULL AND av_all.voucher != $revoked) < $threshold` HAVING gives exact parity with the old 1+2K loop PLUS the previously-dropped zero-remaining-voucher cascade-terminal case. Correctness verified the full truth table and that it matches `revokeVoucheeIfBelowThreshold`'s HAVING byte-for-byte (only the bound param differs); the real-Postgres regression runs the exported `cascadeDiscoverySelect()` verbatim and the cascade-terminal case fails RED against INNER JOIN; threshold-1-vs-exactly-threshold boundary, the non-wot gate, and the threshold bind VALUE are all pinned; carve-out clauses (a)/(b)/(c) are documented; the BitmapAnd-toxic shape is not reintroduced. MATERIALIZED stays deferred (EXPLAIN-gated, operator-paced) — confirmed NOT required.

But round-2's SECOND change — the non-budget nested-error handling — does not hold up.

### Items held (must fix before archive)

1. (P2 — correctness + testing + reliability + adversarial + learnings, five-reviewer convergence) **The non-budget nested-error inner-catch branch is unreachable, and its regression test is vacuous.** A recursive `cascadeRevocation` call cannot throw a non-`PartialCascadeError`: its own outer catch returns `[]` on any non-budget error (HAF failure, etc.). So the parent's new inner-catch "non-budget nested failure" branch is dead code, and the new accounting regression passes against the PRE-fix code too — the test scenario never produces the `PartialCascadeError` surface where the old double-count was observable, so it cannot go RED. (The round-1 architect note asking to "pin completed/pending accounting for non-budget nested errors" was premised on that path being reachable; this re-review establishes it is not — the premise was wrong, not the implementation.) Fix: REMOVE the inert non-budget branch and the vacuous test, and replace with a concise comment — anchored on behavioral semantics, NOT on a task slug / round number / SHA / line number — explaining that a nested `cascadeRevocation` returns `[]` rather than throwing on an internal (non-budget) error, so no non-`PartialCascadeError` can reach the parent loop. IF on close inspection you find a genuinely reachable non-budget throw the reviewers missed, instead KEEP the branch and make the test fail RED (construct a scenario that yields a `PartialCascadeError` AFTER the non-budget failure so `pending` is actually surfaced and the pre-fix double-count is observable). State which path you took in the re-review signal.

   Related, NOT a hold item here: because the recursive call swallows a nested HAF failure and returns `[]`, that subtree's should-be-revoked vouchees are silently lost from operator follow-up (no `completed`, no `pending`, only an error log). This is not operationally live — `cascadeRevocation` has no wired production caller; the retract path uses `revokeVoucheeIfBelowThreshold`. When a route does wire the top-level cascade, file a follow-up to surface the failed parent for operator re-cascade. If concise, document the manual-recovery step (re-run the cascade for the logged parent) where you place the simplifying comment.

2. (P3, adversarial) **`runDiscovery()` lacks a redirect-no-op guard.** The real-Postgres test's FROM-redirect splits on the `operation_custom_json_view` table literal to substitute the synthetic VALUES set; if a future CTE-alias or whitespace change makes the split a no-op, the regression would silently run against the LIVE HAF view instead of the synthetic data. Add an assertion that the redirected CTE no longer contains the real view literal (mirror the sibling `active-vouches-signer-gate.test.ts` guard) so drift fails fast instead of passing against the wrong data.

When both items land, `git mv` this file back to `tasks/review/`. Do not edit the held-items list above — the commit diff is the evidence.

## Backend re-review signal (2026-06-09)

Both items landed; moving back to `tasks/review/`.

- **Item 1 — took the REMOVE path.** Independently confirmed the non-budget inner-catch branch is unreachable: tracing `cascadeRevocation`, a recursive call can only escape via its own outer catch, which re-throws `PartialCascadeError` but turns every other error (HAF failure in the nested discovery query, missing admin key, etc.) into `return []`; and everything before the `try` is non-throwing (`getPool()` is a cached getter, the rest are early `return []`). So the recursive call throws ONLY `PartialCascadeError`, and the dead branch's `continue` never ran. (Verified the round-2 test was vacuous for the same reason: its v1 nested-discovery throw is swallowed by the recursive call's outer catch to `return []`, so the parent's inner catch is never entered — the test passed via the recursive swallow, not the branch it claimed to cover, and would pass against pre-fix code.) Replaced the dead `if/else` with a leading type-narrow guard `if (!(nestedErr instanceof PartialCascadeError)) throw nestedErr;` and a behavioral comment explaining the only-PartialCascadeError invariant; the `PartialCascadeError` fold + same-level `slice(i + 1)` + dedup re-throw is unchanged (it does load-bearing nested-progress accounting and could not be removed). The comment also records the operator manual-recovery step (re-run the cascade for the logged parent) per the item's related note. Removed the vacuous accounting test from `wot-broadcast-timeout.test.ts`.
- **Item 2.** Added `expect(redirectedCte).not.toContain(T.customJson)` immediately after the FROM-redirect in `runDiscovery`, mirroring the `active-vouches-signer-gate.test.ts` guard, so a future CTE-alias/whitespace drift that no-ops the split fails fast instead of silently running the discovery SQL against the live HAF view.
- Verification: `npm run typecheck` + `npm run lint` clean (the one lint warning is a pre-existing unused-directive in `src/lib/author-supersession.ts`, untouched). `wot-broadcast-timeout.test.ts` + `wot-retract-cascaderevocation.test.ts` 22/22 green; the three `it.skipIf(!discoveryPool)` real-Postgres discovery cases ran (0 skipped with `APP_DATABASE_URL` set), so the new redirect guard is exercised.
