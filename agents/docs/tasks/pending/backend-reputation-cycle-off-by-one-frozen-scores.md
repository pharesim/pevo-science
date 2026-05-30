# BACKEND-REPUTATION-CYCLE-OFF-BY-ONE-FROZEN-SCORES — in-progress cycle scored with only `accreditation_bonus`, then permanently frozen

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #1 high severity, correctness)
**Priority:** P0 (production reputation is essentially `accreditation_bonus` only since deployment)

## Problem

Two compounding bugs in the reputation cycle collapse every cycle to `accreditation_bonus` only and then freeze that mis-scored snapshot forever.

1. **Off-by-one in `cycleEndBlock`.** [reputation-batch.ts:263-301](backend/src/reputation-batch.ts#L263-L301) computes `currentCycle = floor((headBlock - genesis) / cycleBlocks)`, which is the IN-PROGRESS cycle. For that cycle, `cycleEndBlock` is strictly greater than `headBlock`. The batch loop scores it anyway.

2. **`cycle_ref` equality lookup returns 0 rows for the in-progress cycle.** [reputation.ts:410-414](backend/src/reputation.ts#L410-L414) does `WHERE b.block_num = $6 - 1`. For an in-progress cycle whose `cycleEndBlock > headBlock`, no row matches. `paper_scores`, `review_scores`, and `citation_scores` (lines 742, 846, 977) all `CROSS JOIN cycle_ref`, so every structural arm collapses to NULL/0.

3. **`lastComputedCycle >= currentCycle` short-circuit then prevents recomputation.** The mis-scored snapshot becomes `prev_scores` for the next cycle's `voter_weights`, silently reverting to bootstrap-uniform `1.0` voter weights from then on.

Tests use a past `cycleEndBlock` and miss this entirely. Net effect: production reputation is essentially `accreditation_bonus` only since deployment — papers, reviews, and citations contribute nothing.

## Goal

Fix both bugs so only fully-elapsed cycles are scored, and add defense-in-depth so the same bug class cannot recur via either path.

### Suggested approach

1. **[reputation-batch.ts](backend/src/reputation-batch.ts):** add `if (cycleEndBlock > headBlock) break;` inside the loop so only fully-elapsed cycles are scored.
2. **[reputation.ts](backend/src/reputation.ts) `cycle_ref`:** replace the equality lookup with `WHERE b.block_num <= $6 - 1 ORDER BY b.block_num DESC LIMIT 1`. This is the defense-in-depth arm — if a future caller passes an in-progress `cycleEndBlock`, the query still returns the most recent block instead of an empty set.

## Acceptance

- A regression test where `head - genesis = cycleBlocks * 1.5` asserts:
  - Cycle 0 has non-zero `papers` / `reviews` / `citations` breakdowns for an active user.
  - Cycle 1 is NOT yet computed (loop breaks before scoring it).
- Existing batch tests stay green.
- One real-HAF cycle run on dev confirms `papers`/`reviews`/`citations` are non-zero for a known-active accredited user, where they were zero before the fix.
- Comment anchors clean (no task slug, round number, line number, SHA).
- `npm run typecheck` + `npm run lint` clean from `backend/`.

## Notes

- Ordering: this is independent and can land first. Findings #2 (co-author claim zero-score) and #10 (SQL error silent advance) compound the same "reputation broken" theme but are independent fixes.
- Operational implication: once this lands, the next cycle batch will recompute every accredited user's reputation against the structural arms for the first time. Expect score deltas — they're the correction, not a regression.

## Cross-references

- [backend/src/reputation-batch.ts](backend/src/reputation-batch.ts) lines 263-301 (`computeReputationBatch` cycle loop).
- [backend/src/reputation.ts](backend/src/reputation.ts) lines 410-414 (`cycle_ref` CTE), 742 (paper_scores), 846 (review_scores), 977 (citation_scores).
- HAF-query review run `w274tijk0` rank #1.
