# BACKEND-REPUTATION-BATCH-SQL-ERROR-SILENT-ADVANCE — `computeReputationBatch` SQL failure silently advances `cycle:last` and wipes `prev_scores`

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #10 high severity, correctness)
**Priority:** P1 (any HAF transient looks identical to a successful empty cycle, permanently advancing `cycle:last` and zeroing voter weights for the next cycle)

## Problem

[reputation.ts:1051-1054](backend/src/reputation.ts#L1051-L1054) catches its own SQL errors in `computeReputationBatch` and returns an empty Map. The outer loop in [reputation-batch.ts:332-369](backend/src/reputation-batch.ts#L332-L369) then has `batchResults.size === 0`, the `pipeline.exec()` is a no-op, but the Lua call **still** runs `SET cycle:last = cycle` and `DEL sentinel`.

Outcome: a SQL failure looks identical to a successful empty cycle.
- `cycle:last` advances permanently.
- In-process `prevScores` becomes `{}`.
- The next cycle's `voter_weights` takes the bootstrap `1.0` arm for every voter until Redis rehydrates.

Fires on any HAF transient.

## Goal

Stop conflating SQL failure with an empty cycle. A failure must NOT advance `cycle:last`.

### Suggested approach

1. **Primary fix:** stop swallowing the SQL error in `computeReputationBatch` ([reputation.ts:1051-1054](backend/src/reputation.ts#L1051-L1054)) — let it throw. The outer try/catch in `runBatchReputation` already handles errors by bailing without advancing `cycle:last`.
2. **Belt-and-suspenders:** in `reputation-batch.ts`, before the sentinel SET / `cycle:last` advance, check `if (batchResults.size === 0 && users.length > 0) break` so a genuinely-empty result from a non-empty user list also bails.

## Acceptance

- Regression test: inject a SQL failure into `computeReputationBatch` for a non-empty user list; assert `cycle:last` is NOT advanced and `prevScores` is not wiped.
- Regression test: a genuinely empty user list (no accredited users) still completes cleanly without advancing.
- Existing batch happy-path tests stay green.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Compounds with #1 (cycle off-by-one) and #2 (co-author claim zero score) — the three together explain why production reputation has been near-zero. Land #1 first; this and #2 are independent.
- The catch in `computeReputationBatch` may have been intended to keep the batch loop from aborting on a single-user query failure. If so, the right fix is per-user-try (already happens for a different reason elsewhere?) — verify the original intent before just removing the catch. If per-user resilience is the goal, throw at the batch level but catch per-user inside.

## Cross-references

- [backend/src/reputation.ts](backend/src/reputation.ts) lines 1051-1054 (`computeReputationBatch` catch).
- [backend/src/reputation-batch.ts](backend/src/reputation-batch.ts) lines 332-369 (outer batch loop, sentinel SET, Lua call).
- HAF-query review run `w274tijk0` rank #10.
