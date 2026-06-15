---
title: Reputation scores stay frozen after a calc/config deploy — reset cycle:last to backfill
date: 2026-06-15
category: conventions
module: backend/src
problem_type: convention
component: background_job
severity: high
applies_when:
  - Deploying a reputation calc, weight, or HAF-CTE change and expecting existing scores to refresh
  - A profile shows a reputation/paper score that does not match what current code computes against live HAF, for hours after a deploy
  - Triaging a "reputation looks wrong / stuck" report before changing any code
  - Tempted to conclude the reputation calc is broken because a profile shows a stale value
tags:
  - reputation
  - cycle-last
  - batch-job
  - redis
  - stale-cache
  - deploy-procedure
  - operations
---

## Problem

After deploying a reputation calc/config fix, accredited-user profiles keep showing the OLD, pre-fix scores indefinitely. The deployed calc is correct, yet `getReputationScore` returns the stale value for hours.

Concrete instance: `beta.pevo.science` showed `pevo.science` with `score=5 / papers=0`, while the corrected current code computes `score=5.4 / papers=0.2` for the same account (an accredited 100% vote on the paper plus an accredited 100% upvote on a review, each contributing ~0.2 once the voter's own rep-5 weight `sqrt(5/100) ≈ 0.22` is applied). The root cause is not in the calculation — it is that the cycle-based batch refuses to recompute cycles it already finalized, so the corrected code never re-runs against the already-stored block ranges.

## Symptoms

- A profile's reputation does not match what current code computes against live HAF, and stays wrong for hours after a calc/config deploy.
- The Redis prod key `${appTag}:reputation:batch:<user>` holds a real computed value with a populated breakdown, e.g. `{"score":5,"breakdown":{"papers":0,"reviews":0,...}}` — NOT the provisional-only shape.
- The cursor `${appTag}:reputation:cycle:last` is SET to a finalized cycle number (e.g. `75`), not empty.
- Batch logs look completely healthy: `Batch reputation cycle complete`, `Batch reputation computation complete`, or `already up to date` — no errors, no skipped-cycle warnings.
- Re-running `computeReputationBatch([user], prevScores, undefined)` directly against live HAF (head block) produces the CORRECTED score, proving the code is right and the stored value is stale.
- It self-heals on its own only when the next cycle fully elapses (`cycle_blocks` ≈ 28,800 blocks ≈ 1 day), which can be many hours away.

## What Didn't Work

- **Hypothesis: votes used effective (rshares-based) weight, so a 0-rshares vote was dropped.** FALSE. `operation_vote_view.weight` is the DECLARED op weight, not the rshares-derived effective weight — verified against HAF, a 100% vote with 0 rshares reads `weight=10000`. The calc already consumes the declared percentage.
- **Hypothesis: a stale Docker bundle was serving old calc code.** Ruled out by `docker inspect <backend> --format '{{.Created}}'` cross-referenced against `git log` of `reputation.ts` / `hafsql.ts` / `reputation-batch.ts` since the build time — the deployed image's calc matched HEAD behaviorally.
- **Hypothesis: a buggy member prune was wiping the score, or the CYCLE_SWAP Lua was broken.** Ruled out — the prod key was present with a real value (not deleted), and the swap Lua RENAMEs staging→prod correctly in isolation.
- **Hypothesis: the batch never persisted at all.** A real but DIFFERENT failure mode, and the most useful one to distinguish. Never-persisted presents as `cycle:last` EMPTY plus ZERO `batch:<user>` prod keys (route serves only the provisional fallback). The frozen-cycle case is the opposite: `cycle:last` is SET and real prod keys EXIST holding stale values.

## Solution

Reset the cycle cursor so the next batch run recomputes every finalized cycle from scratch with the corrected code. Idempotent, ~30s; the atomic staging→prod Lua swap overwrites the stale prod keys, so no other cleanup is needed.

```bash
PW=$(grep '^REDIS_PASSWORD=' .env | cut -d= -f2-)
docker exec <redis-container> redis-cli -a "$PW" --no-auth-warning DEL ${appTag}:reputation:cycle:last
docker restart <backend-container>   # batch fires ~10s after boot (startBatchReputation's setTimeout); or wait up to 1h for the hourly tick
```

Verify the corrected value landed:

```bash
docker exec <redis-container> redis-cli -a "$PW" --no-auth-warning GET ${appTag}:reputation:batch:<user>
# expect the corrected score, e.g. {"score":5.4,"breakdown":{"papers":0.2,...}}
```

Deleting `cycle:last` makes `runBatchComputation` read `lastComputedCycle = -1`, so `startCycle = 0` and it replays every cycle from genesis up to the current fully-elapsed cycle, re-staging and atomically swapping each one's prod keys.

## Why This Works

`runBatchComputation` (`backend/src/reputation-batch.ts`) is a forward-only catch-up loop. It reads `${appTag}:reputation:cycle:last`, sets `startCycle = lastComputedCycle + 1`, and short-circuits entirely when `lastComputedCycle >= currentCycle`. Reputation cycles are block ranges (`cycle_blocks` default 28,800 ≈ 1 day), and each finalized cycle's `{score, breakdown}` is written to `${appTag}:reputation:batch:<user>` with no TTL via the atomic CYCLE_SWAP Lua.

Once cycles `0..N` were finalized and stored by an OLDER code/config version, deploying corrected code does NOT recompute those ranges — they are behind the cursor, so the loop never revisits them. They stay frozen until either the NEXT cycle fully elapses (potentially many hours) or the cursor is reset.

The reader is the second half of the trap: `getReputationScore` / `getBatchReputationMap` are cache-only. They read the prod batch key and never recompute live — there is no read-through-to-HAF path. So every profile request returns the frozen value verbatim, and because the batch never errors (it correctly concludes there is no new cycle), the logs report healthy completion the whole time.

## Distinguishing invariant (triage before touching anything)

A present prod key with a real breakdown is NOT the provisional fallback, and telling them apart routes you to the right fix:

- **Provisional fallback** — shape `{"score":<bonus>,"breakdown":{"papers":0,"reviews":0,"citations":0,"accreditation":<bonus>}}`, written NX by the accreditation-seed path at boot/accreditation time. The route returns it only when no real cycle value exists yet.
- **Frozen real value** — a present key whose breakdown carries non-bonus, cycle-derived numbers. Present key with a real breakdown ⇒ the batch computed it; if wrong, it is frozen-cycle.
- **Absent key** — the batch never persisted (separate failure): `cycle:last` empty, no prod keys, route serves only the provisional fallback.

## Prevention

- **Reset `cycle:last` after any calc or config deploy that changes scoring.** A formula change, a weight change that bypasses the on-chain `update_weights` path, or a HAF-CTE fix does not retroactively recompute finalized cycles. Make `DEL ${appTag}:reputation:cycle:last` + backend restart a standard post-deploy step whenever scoring math changed.
- **Use the present-key-vs-absent-key test to triage "stale/wrong reputation" reports before touching code.** `GET cycle:last` and `GET ${appTag}:reputation:batch:<user>`: SET cursor + present real-breakdown key ⇒ frozen-cycle (reset the cursor); empty cursor + absent key ⇒ the batch never ran (investigate the batch job / HAF / Redis — do NOT just reset the cursor).
- **Confirm the deployed image's calc matches HEAD before concluding frozen.** `docker inspect <backend> --format '{{.Created}}'`, then `git log` of `reputation.ts` / `hafsql.ts` / `reputation-batch.ts` since that timestamp — non-behavioral commits mean the deployed calc equals HEAD, so a wrong stored value is frozen, not a stale bundle.
- **Reproduce the calc directly against live HAF to isolate "calc wrong" vs "value stale."** Run `computeReputationBatch([user], prevScores, undefined)` via tsx (`cycleEndBlock` undefined scores against head). Bridge-account paper credit requires `HIVE_BRIDGE_ACCOUNT` set to the real bridge account plus a dummy `PEVO_BRIDGE_POSTING_KEY` or `config.ts` throws.
- **Suggested future hardening: stamp a calc-version (or hash) beside `cycle:last`.** Persist a calc-version key alongside the cursor and have `runBatchComputation` reset `lastComputedCycle` to `-1` whenever the running code's calc-version differs from the stored one — a scoring-logic deploy then auto-triggers a full recompute with no manual `DEL`, closing the frozen-cycle window structurally instead of relying on an operator remembering the post-deploy step.

## Related

- `agents/docs/solutions/conventions/reputation-cycle-last-must-not-advance-on-failure-2026-06-06.md` — the complementary half of the same `cycle:last` invariant: that doc protects against the cursor wrongly ADVANCING past a failed/in-progress cycle (a write bug); this doc covers the operator deliberately needing to roll it BACK after a corrected calc deploy. Together they describe "must not advance on failure" and "must be resettable on a calc change."
- `agents/docs/solutions/architecture-patterns/rolling-window-depth-must-exceed-run-cadence-stride-2026-06-14.md` — sibling of the same structural class: a monotonic cursor/watermark that advances each run and never re-reads behind it, causing permanent non-recomputation of already-passed work.
