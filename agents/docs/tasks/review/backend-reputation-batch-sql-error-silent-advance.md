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

## Implementation notes (2026-05-30)

**Intent verification (per Notes):** `computeReputationBatch` is a SINGLE batch query (one `pool.query` for the whole-corpus CTE; the `totals` CTE CROSS JOINs every `target_user`, so a successful query always returns one row per user). There is no per-user loop, so the catch was never preserving per-user resilience — swallowing it only hid whole-batch failures. The per-user-try alternative the task floats does not apply. Re-throwing is the correct fix.

1. **Primary (reputation.ts):** the `computeReputationBatch` catch now re-throws after logging instead of `return results`. The outer `try/catch` in `runBatchComputation` bails (logs, releases the lock in `finally`) without reaching the sentinel SET / Lua swap, so `cycle:last` is not advanced and the in-process `prevScores` reassignment (which happens after the swap) never runs. The local error log is kept — failures are rare (HAF transients), so the one extra log line at the orchestration layer is acceptable and aids layer attribution.

2. **Belt-and-suspenders (reputation-batch.ts):** before the staging/sentinel/Lua, `if (batchResults.size === 0 && users.length > 0) break`. With the primary fix a failed batch throws before reaching this, but the guard makes a future regression that resurrects empty-on-error fail safe (break, not advance). The `&& users.length > 0` arm is always true here (the empty-accredited case already `continue`d at `scoredUsers.size === 0`), kept for self-documenting intent.

**Regression tests:** new `backend/tests/routes/reputation-batch-sql-failure.test.ts`. Arm 1 injects a throw into `computeReputationBatch` for a non-empty user list (cycle:last pre-set to "0", a prod score pre-seeded) and asserts `runBatchComputation` resolves (handled internally), `cycle:last` stays "0", the pre-seeded prod key (prevScores' source) is unchanged, and no in-progress sentinel leaked. Arm 2 drives an empty accredited set and asserts `computeReputationBatch` is never called (the belt-and-suspenders never engages) and the elapsed empty cycle advances per the documented no-op-advance while the in-progress cycle stops. Carve-out header documents clauses (a)/(b)/(c).

**Verification:** new file 2/2; reputation suite green (`reputation-batch-internals`, `reputation-lifecycle`, `reputation-approve-signer-gate-cycle-sql-shape`, `reputation-prefix`, plus both cycle-boundary + sql-failure new files → 32/32); typecheck + lint clean (one pre-existing unrelated `author-supersession.ts` warning). Side benefit: `reputation-prefix.test.ts`'s real-HAF run now bails on the first post-teardown pool error instead of grinding through ~60 cycles of swallowed errors (suite 17s vs 186s).

### [Note for Architect] acceptance bullet-2 wording

Acceptance bullet 2 reads "a genuinely empty user list (no accredited users) still completes cleanly **without advancing**." The empty-accredited path is handled by the EXISTING `scoredUsers.size === 0` no-op-advance, which intentionally DOES advance `cycle:last` (defended in `reputation-batch.ts` and BACKEND-REPUTATION-SSOT round-1 hold #9: "Advancing over a legitimate empty cycle is correct"). This task's goal is FAILURE-not-advancing, not empty-cycle-not-advancing, so I kept the documented advance behavior and Arm 2 asserts it (cycle:last lands at 0 for the elapsed empty cycle; the in-progress cycle stops via the separate elapsed-cycle guard). If you intended empty-accredited cycles to stop advancing too, that is a behavior change to documented intentional code — flag it and I will split it into its own task rather than fold it in here.
