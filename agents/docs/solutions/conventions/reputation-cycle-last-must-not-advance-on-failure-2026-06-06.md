---
title: A failed or in-progress reputation cycle must never advance cycle:last — only a verified-complete swap or a legitimately empty cycle may
date: 2026-06-06
category: conventions
module: backend/src
problem_type: convention
component: background_job
severity: high
applies_when:
  - Editing the cycle loop in `runBatchComputation` (reputation-batch.ts), especially anything between the head-block read and the atomic Lua swap
  - Adding or changing error handling in `computeReputationBatch` or any helper it calls (head read, weights load, batch CTE query)
  - Adding a new step to the staging pipeline or the CYCLE_SWAP Lua script
  - Reviewing a change that touches `cycle:last`, the staging keys, the in-progress sentinel, or `prevScores`
  - Tempted to catch-and-return-empty inside a batch computation "for resilience"
tags:
  - reputation
  - cycle-last
  - batch-job
  - error-propagation
  - redis
  - fail-closed
  - swallowed-errors
---

## Context

The reputation batch advances a Redis cursor (`cycle:last`) after scoring each cycle, and the scored snapshot becomes `prevScores`, the input for the next cycle's voter weights. Production reputation silently collapsed to `accreditation_bonus` only because three independent defects each let a non-successful cycle advance that cursor, and the `lastComputedCycle >= currentCycle` short-circuit then froze the mis-scored snapshot forever:

1. `computeReputationBatch` caught its own SQL errors and returned an empty map, making any HAF transient indistinguishable from a legitimately empty cycle. The catch LOOKED like deliberate per-user resilience, but the batch is one whole-corpus query: the `totals` CTE CROSS JOINs every target user, so a successful query always returns one row per user. There was never a per-user loop to protect; the catch only hid whole-batch failures.
2. The cycle loop scored the in-progress cycle (whose end block exceeds head), and the `cycle_ref` exact block lookup returned zero rows for it, collapsing every structural arm (papers, reviews, citations) to NULL before the snapshot froze.
3. ioredis `pipeline.exec()` resolves with per-command `[err, result]` tuples and does not throw, so a failed staging SET could let the sentinel SET and atomic Lua swap run on a partially staged set.

## Guidance

A cycle may advance `cycle:last` through exactly two doors: the atomic CYCLE_SWAP Lua after a fully verified compute-and-stage, or the documented no-op advance for a legitimately empty cycle (zero accredited users). Every failure path must stop BEFORE the sentinel SET and swap, leaving `cycle:last` and the prod keys (the `prevScores` source) untouched, so the next scheduled run retries the same cycle. Three layers enforce this:

- `computeReputationBatch` re-throws on SQL failure (logged, then `throw err`); the outer try/catch in `runBatchComputation` bails without reaching the swap. Do not reintroduce catch-and-return-empty inside the batch computation.
- The cycle loop breaks when `cycleEndBlock > headBlock` (in-progress cycle), before the empty-user no-op advance, so an in-progress cycle can advance through neither door. `cycle_ref` additionally degrades to the latest existing block (`<=` + `ORDER BY block_num DESC LIMIT 1`) instead of an empty set if a stray in-progress end block ever reaches it.
- The staging `pipeline.exec()` result is inspected per command; any error tuple breaks before the sentinel SET. Belt-and-suspenders: an empty `batchResults` for a non-empty user list also breaks, because that combination is structurally impossible on success.

When adding a new step to this sequence, place its failure check before the sentinel SET, and prefer `break`/re-throw over any default value that resembles a legitimate empty result.

## Why This Matters

A wrongly advanced `cycle:last` is not self-healing: the short-circuit prevents recomputation, the mis-scored snapshot poisons `prevScores`, and voter weights silently revert to bootstrap-uniform 1.0. The failure is invisible (no crash, scores merely wrong), which is why it survived in production until a multi-lens review. Fail-closed-without-advancing converts the same faults into a one-cycle delay that retries on the next scheduled run.

## When to Apply

Any change to `reputation-batch.ts` / `reputation.ts` touching the cycle loop, batch query, staging pipeline, CYCLE_SWAP Lua, or their error handling. Also when reviewing: treat "catch returns an empty collection" inside whole-corpus batch code as a red flag and verify what the caller does with an empty result.

## Examples

The defect shape (do not reintroduce):

```typescript
} catch (err) {
  logger.error({ err }, 'batch failed');
  return results; // empty Map — caller treats it as a legitimately empty cycle and advances
}
```

The enforced shape:

```typescript
} catch (err) {
  logger.error({ err }, 'batch failed');
  throw err; // outer catch in runBatchComputation bails; cycle:last untouched; next run retries
}
```

And at the staging step:

```typescript
const results = await pipeline.exec();
if (!results || results.some(([err]) => err !== null)) {
  logger.error({ cycle, userCount: users.length }, 'staging pipeline per-command error; bailing without advancing cycle:last');
  break; // before the sentinel SET and atomic swap
}
```

The one intentional advance-on-empty: a cycle with zero accredited users advances `cycle:last` as a no-op. That is settled behavior — an elapsed empty cycle is complete, not failed. Do not "fix" it to stop advancing.
