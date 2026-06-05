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

## Implementation notes (2026-05-30)

Both arms landed as specified.

1. **Off-by-one (`runBatchComputation`, reputation-batch.ts):** added a `if (cycleEndBlock > headBlock) break;` guard immediately after `cycleEndBlock` is computed, before the accredited-account scan. `currentCycle = floor((head - genesis) / cycle_blocks)` is the in-progress cycle; its `cycleEndBlock` exceeds `head`, so it is now skipped. `break` (not `continue`) because every later cycle has a strictly larger end block. The guard sits before the empty-user no-op advance, so an in-progress cycle can no longer advance `cycle:last` even with zero accredited users.

2. **`cycle_ref` defense-in-depth (reputation.ts):** replaced the exact `WHERE b.block_num = $6 - 1` with `WHERE b.block_num <= $6 - 1 ORDER BY b.block_num DESC LIMIT 1`. Even if a future caller passes an in-progress `cycleEndBlock`, `cycle_ref` resolves the latest existing block instead of an empty set, so the `CROSS JOIN cycle_ref` arms (paper/review/citation decay age) no longer collapse to NULL. `block_num` is the blocks PK, so the bounded backward scan is O(1)-ish — no perf regression vs. the equality lookup. Comment anchored on the in-progress-end-block semantics, no slug/line/SHA.

**Regression test:** new `backend/tests/routes/reputation-batch-cycle-boundary.test.ts` with two arms. Arm 1 drives `runBatchComputation` with `head - genesis = cycle_blocks * 1.5` (controlled via mocked `getPool` head, stubbed weights/genesis/accredited/compute, real Redis) and asserts `computeReputationBatch` is called exactly once for cycle 0's end block, `cycle:last` advances to exactly `0`, and cycle 0's `{score, breakdown}` reached prod through the atomic swap — cycle 1 is never scored. Arm 2 is a HAF-free SQL-shape canary asserting the emitted `cycle_ref` uses `<= $6 - 1 ORDER BY block_num DESC` and NOT the fragile `= $6 - 1`. Carve-out header documents clauses (a)/(b)/(c) (real-path companions: lifecycle idempotency + batch-internals atomic swap).

**Real-HAF confirmation:** the pre-existing real-HAF run inside `reputation-prefix.test.ts` (genesis 105078443, head ~106837702) now logs `Cycle not fully elapsed; stopping before scoring it` for the in-progress cycle 61 — the loop correctly stops before the in-progress cycle against live chain data, where before it scored it. Elapsed cycles now resolve `cycle_ref` to a real block timestamp instead of an empty set.

**Verification:** new file 2/2 passed; existing reputation suite green (`reputation-batch-internals`, `reputation-lifecycle`, `reputation-approve-signer-gate-cycle-sql-shape`, `reputation-prefix`, `reputation-paper-reviews-self-exclusion-canary` → 29/29); `npm run typecheck` clean; `npm run lint` clean except the pre-existing unrelated `author-supersession.ts` warning.

Note: findings #2 (co-author claim zero-score) and #10 (SQL error silent advance) remain independent follow-ups; the `Cannot use a pool after calling end on the pool` errors visible in the `reputation-prefix` real-HAF log are that test's own post-teardown `runBatchComputation` call hitting the silent-swallow catch (#10's target), unrelated to this change.

## Architect re-review (2026-05-31) — HELD PENDING FIXES (1 item)

`/ce-code-review` (correctness + adversarial on Opus; testing, maintainability, project-standards, performance, kieran-typescript, reliability on Sonnet; learnings-researcher unstructured; ce-agent-native-reviewer skipped per PEvO) on the cycle-off-by-one commit. The core fix is verified CORRECT: the `cycleEndBlock > headBlock` break scores only fully-elapsed cycles and sits before the empty-user no-op advance, so an in-progress cycle can advance `cycle:last` through neither path; the boundary math is exact (`>` correctly admits the `cycleEndBlock == headBlock` elapsed cycle and skips only the in-progress one); the `cycle_ref` `<= $6 - 1 ORDER BY block_num DESC LIMIT 1` form resolves the identical block as the old equality for any elapsed cycle (no historical score shift) and degrades to latest-block instead of zero rows for a stray in-progress end block; the new query is a backward index scan on the blocks PK (no perf regression); `break` is valid because the loop is monotonic. One item holds.

### Item held (must fix before archive)

1. (P3, testing) Arm 2's `cycle_ref` SQL-shape canary asserts the predicate uses `<=` and `ORDER BY ... DESC`, and that the fragile exact `= $6 - 1` is absent, but it does NOT assert `LIMIT 1` is present. A regression that drops only `LIMIT 1` (keeping the other two tokens) would make `cycle_ref` return every block at or before the cycle end, turning the three `CROSS JOIN cycle_ref` arms into a Cartesian product and silently corrupting every score — and Arm 2 would still pass. Add an assertion that the emitted cycle query includes the single-row `LIMIT 1` clause (alongside the existing `<=` / `ORDER BY ... DESC` token assertions) so the single-row guarantee is pinned. Anchor the assertion on the SQL token, not a line number.

### Items noted, not held (no action required)

- **(project-standards, P2) Carve-out clause (c) wording ("which neither companion covers") — DISMISSED as a false positive.** This is the strict-mirror reading explicitly dismissed by `solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`. Clause (c) is risk-class equivalence: a complementary real-path companion that exercises the integrated path with real infra and catches a different mutation axis. The named companions (real-HAF `computeReputationBatch` in `reputation-lifecycle.test.ts`, real-Redis atomic swap in `reputation-batch-internals.test.ts`) satisfy that, and `reputation-prefix.test.ts` already exercises the boundary decision against live chain. No change required.
- **(correctness/adversarial/testing) Exact-boundary `cycleEndBlock == headBlock` not pinned by an executed assertion — dismissed.** The math is mechanically proven and the live-HAF run exercises real geometry.
- **(reliability, P2, pre-existing) `getHeadBlock` lacks a per-query `statement_timeout`** — filed as a separate follow-up task (`backend-reputation-gethead-statement-timeout`), out of scope here.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; the next architect review scopes `/ce-code-review` to the fix commit only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Backend re-review signal (2026-06-05, working tree)

Round-1 hold item 1 (P3, testing) landed: added a `LIMIT 1` assertion to Arm 2's `cycle_ref` SQL-shape canary in `reputation-batch-cycle-boundary.test.ts`, anchored to the cycle_ref `ORDER BY b.block_num DESC` ordering so a regression dropping only `LIMIT 1` (which would turn each `CROSS JOIN cycle_ref` arm into a Cartesian product) fails red. Test-only, assertion anchored on the SQL token. `npm run typecheck` + `npm run lint` clean.
