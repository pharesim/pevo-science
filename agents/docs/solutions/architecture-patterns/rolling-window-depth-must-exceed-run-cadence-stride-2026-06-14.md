---
title: "A rolling-window batch consumer permanently misses events when its window depth is shorter than its run-cadence stride"
date: 2026-06-14
category: architecture-patterns
module: backend/src/digest.ts + backend/src/notification-queries.ts
problem_type: architecture_pattern
component: background_job
severity: high
applies_when:
  - "Designing a periodic consumer that re-fetches over a rolling block/time window floor and advances a watermark each run"
  - "A consumer that drops a cap-truncated boundary block and relies on a later run to recover it once the window floor slides"
  - "Choosing or changing the run cadence (daily/weekly) of a job that reads a fixed-depth rolling window"
  - "Reasoning about whether a 'recovered on a later run' claim actually holds across the job's cadence"
tags:
  - rolling-window
  - cadence
  - watermark
  - cursor
  - digest
  - notifications
  - deferred-recovery
  - permanent-drop
related_components:
  - background_job
  - database
---

# A rolling-window batch consumer permanently misses events when its window depth is shorter than its run-cadence stride

## Context

PEvO's email digest (`runDigest`) consumes `fetchNotificationsFromHaf` over a wide rolling window floor (`NOTIFICATION_WINDOW_BLOCKS` = 100,000 blocks, about 3.5 days at 3s/block) and advances `last_digest_block` to the highest delivered block on each non-empty run. A cap-truncated partial boundary block is dropped and "recovered later" by design: when the forward-sliding floor ages the already-delivered older blocks below the floor, the previously-dropped block becomes the oldest-kept rows (no longer the cap-truncated end) and gets delivered whole.

That deferred-recovery story holds only under a hidden precondition: the window must still contain the dropped block on a later run. Whether it does depends entirely on the relationship between the window **depth** and the run-cadence **stride**.

## Guidance

For any rolling-window consumer with deferred-recovery semantics, the **window depth must exceed the maximum run-cadence stride**. Recovery-by-floor-slide is valid only when `stride < window depth`; once the per-run floor advance exceeds the window depth, an event that fell between the previous run's floor and this run is below the next run's floor before it can be re-read — a permanent miss, not a deferred one.

Compute both quantities in the same unit before trusting a recovery claim:

- **Window depth** = how far back the floor reaches each run (here ~100,000 blocks ≈ 3.5 days).
- **Cadence stride** = how far the floor advances between runs = cadence interval / block time.

Then:

- **stride < depth** (the safe regime): a dropped/missed event stays in-window for the next few runs and is recovered. PEvO's daily cadence has stride ≈ 28,800 blocks, well under the 100,000 window — recovery works.
- **stride > depth** (the broken regime): the event is below the floor by the next run. PEvO's weekly cadence has stride ≈ 201,600 blocks, over 2x the window — a block dropped at run N is gone by run N+1, a permanent drop. More fundamentally, a 3.5-day window paired with a 7-day cadence structurally misses ~half of every week regardless of any truncation, because half the inter-run span is never inside any run's window.

## Why This Matters

The "recovered on a later run" framing is seductive and was asserted unconditionally in the digest's own docblocks across several review rounds before the cadence arithmetic was done. It is true for the cadence the job usually runs at (daily) and false for a cadence the same code also supports (weekly) — so the prose certified a recovery that does not occur. A consumer whose window is shorter than its cadence stride is not "eventually consistent with a lag"; it has a standing blind spot equal to (stride − depth) every cycle, and any event landing there is never delivered. When the regime is unavoidable (e.g. a window depth fixed by query cost and a cadence fixed by product), state the permanent-miss span as a bounded accepted residual in the code, anchored on the two constants — do not describe it as deferred recovery.

## When to Apply

When designing or changing any periodic job that reads a fixed-depth rolling window and advances a watermark, and when reviewing a "dropped now, recovered later" claim on such a consumer. Derive stride from the cadence and depth from the window constant, and confirm `stride < depth` before trusting deferred recovery. If the job supports multiple cadences, check the SLOWEST one — the recovery property can hold at one cadence and silently fail at another over the same code path. This is a distinct facet from `cursor-agnostic-cache-must-dominate-result-set` (cache-key domination) and `forward-cursor-feed-newest-first-and-rewind-masks-cap-edge` (cap-edge masking); those concern a single fetch's correctness, this concerns the across-runs relationship between window depth and cadence.
