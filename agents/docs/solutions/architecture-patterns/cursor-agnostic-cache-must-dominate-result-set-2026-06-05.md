---
title: "Cursor-agnostic cached batch must dominate every cursor's result set it serves"
date: 2026-06-05
category: architecture-patterns
module: backend/notifications-cache
problem_type: architecture_pattern
component: caching
severity: high
applies_when:
  - "A cache key omits a per-request parameter (cursor, page, sort, filter) so requests share one computed value"
  - "The cached value is computed with a SQL LIMIT or equivalent cap applied at fetch time rather than at response time"
  - "The post-cache step can only subtract from the cached value (filter, slice) and never re-fetch"
  - "A shared cached batch serves callers whose filter predicates differ (cursors, time windows, page offsets)"
  - "Designing any canonical-cached-unit plus per-request-filter surface"
related_components:
  - database
tags: [caching, cursor, pagination, limit, has-more, notifications, cache-key, domination-invariant]
---

# Cursor-agnostic cached batch must dominate every cursor's result set it serves

## Context

Found during architect review of the notifications window-cache change (commit `bbd5e480`, `backend/src/routes/notifications.ts`); three independent review personas (correctness, adversarial, security) converged on the same defect pair. To stop every SPA poll from being a cache miss, the route dropped the client's `since_block` cursor from the cache key (key: `notifications:${account}:${limit}`), computed the batch against a fixed window floor (chain head minus 100k blocks), and re-applied the cursor in-app via `applySinceBlockFilter`. Each half is correct in isolation; the failure emerges from composition with the SQL `LIMIT`:

```ts
// The cached batch is the OLDEST `limit` events above the floor:
//   SQL: ... ORDER BY block_num ASC LIMIT $3   ($3 = the response limit)
// The in-app filter can only subtract from it:
const events = batch.events.filter((e) => e.block_num > sinceBlock);
const has_more = events.length >= batch.events.length && batch.has_more;
```

Two defects follow:

1. **Window-batch starvation.** Once a client's cursor passes the top of the oldest-`limit` batch, the filter strips everything while newer events sit beyond the LIMIT cut, inside the window but unreachable. Every poll hits the same cached slice, so any account accruing more than `limit` events per window gets a silently frozen feed (response: `events: [], has_more: false` with no error signal). An accredited attacker can construct the freeze with roughly `limit` cheap distinct-permlink events targeting a victim, suppressing subsequent legitimate notifications.
2. **`has_more` forced false by filter subtraction.** `events.length >= batch.events.length` holds only when the filter removed nothing, so any cursor that trims even one event reports `has_more: false` even when the batch's own truncation flag proves events exist beyond the cut.

## Guidance

When a cache drops a per-request parameter from its key so requests can share one computed value, the cached value must **dominate** every parameter slice it will serve: the correct, complete response for ANY valid parameter value must be computable from the cached value alone.

A `LIMIT` applied at compute time binds the cached value to exactly one slice (the first-N in fetch order). Every other slice silently loses the data the cut excluded. So: **decouple the internal fetch cap from the response limit.**

```ts
// BEFORE (starvation-prone): fetch cap == response limit
const batch = await hafCache.getOrSet(
  `notifications:${account}:${limit}`,
  () => fetchNotificationsFromHaf(account, windowFloor, limit),
  TTL_MS, true,
);
const events = batch.events.filter((e) => e.block_num > sinceBlock);
const has_more = events.length >= batch.events.length && batch.has_more; // false if anything filtered

// AFTER (dominant cached value): internal cap decoupled, slice at response time
const INTERNAL_CAP = 500; // bounds HAF cost; large enough to cover any in-window cursor
const batch = await hafCache.getOrSet(
  `notifications:${account}:${INTERNAL_CAP}`,
  () => fetchNotificationsFromHaf(account, windowFloor, INTERNAL_CAP),
  TTL_MS, true,
);
const filtered = batch.events.filter((e) => e.block_num > sinceBlock);
const page = filtered.slice(0, limit);
const has_more = filtered.length > limit || batch.has_more;
// MANDATORY companion: when filtered is empty (or under-fills) while batch.has_more
// is true, fall through to a direct per-cursor HAF query for that request. Returning
// has_more=true with an unadvanced latest_block (the empty-filter fallback echoes the
// caller's cursor) spins the client in a same-cursor re-poll loop.
```

`has_more` must be derived relative to the caller's parameter over the capped batch: events remain beyond the returned page (`filtered.length > limit`), or the internal cap itself truncated (`batch.has_more` propagates; a fetcher that returns fewer rows than the cap reports `has_more=false`, so no extra length guard is needed). If even the internal cap cannot dominate (unbounded per-window volume), either the parameter returns to the cache key, or the route detects the under-served case (`batch.has_more && filtered.length < limit`) and falls through to a direct per-parameter query; the fall-through is not optional for the empty-filtered case, per the loop note above.

The quick test before shipping this shape: "with the cache computed as first-N in fetch order, is there a valid parameter value whose correct response includes rows beyond N?" If yes, the cached value is not dominant and the design is broken.

## Why This Matters

The failure mode is silent and self-confirming: the route returns a well-formed empty response, `has_more: false` actively tells the consumer the feed is drained, no exception fires, and the client parks or advances its cursor normally. It is also attacker-constructible at low cost. The project-wide rule that caches are performance layers over authoritative data is violated structurally: the authority (HAF) has the rows, but the cache shape makes them unreachable, which converts a performance layer into a silent correctness authority.

## When to Apply

- Reviewing or designing any cache whose key omits a parameter the response depends on; check all three conditions in `applies_when` together, since each is individually fine.
- Live PEvO sites of the shape: `applySinceBlockFilter` over the per-(account,limit) notifications window batch (`backend/src/routes/notifications.ts`); the canonical-per-paper comment tree sorted/sliced in JS (`paginateTree` in `backend/src/routes/comments.ts`), where dominance holds only because the canonical fetch has no SQL LIMIT; the digest's wide-floor fetch with `last_digest_block` applied as an in-app cursor (`runDigest` in `backend/src/digest.ts`).

## Examples

Concrete starvation trace (`limit=3`, window events at blocks 101-110, client cursor at 105):

- Cached batch = oldest 3 = `[101, 102, 103]`, `has_more=true`
- Filter `> 105` yields `[]`; response: `events: []`, `latest_block: 105`, `has_more: false`
- Events 106-110 exist inside the window and stay invisible until the floor crawls past 103 (days later)

With `INTERNAL_CAP=500`: all ten events are in the batch, the filter keeps `[106..110]`, the page delivers up to `limit` of them, and `has_more` reflects the remainder.

## Related

- [[caching-wrapper-discriminated-union-poisoning]] (`agents/docs/solutions/conventions/caching-wrapper-discriminated-union-poisoning-2026-05-11.md`): sibling failure class at the same shared-batch layer; that doc covers caching the wrong VALUE (failure sentinels), this one covers caching insufficient QUANTITY (non-dominant batch).
- [[single-flight-coalescing-amplifies-cache-invalidation-race]] (`agents/docs/solutions/conventions/single-flight-coalescing-amplifies-cache-invalidation-race-2026-05-20.md`): cache-write correctness for the same `QueryCache` layer.
- [[per-request-memo-catch-block-negative-cache-contract]] (`agents/docs/solutions/conventions/per-request-memo-catch-block-negative-cache-contract-2026-05-06.md`): within-request counterpart in the caching-under-degradation design space.
- Fix prescription for the canonical instance lives with the notifications cache work in the task tree (hold items: internal-cap decoupling; cursor-relative `has_more`).
