---
title: "Forward-cursor feeds must fetch newest-first; a client rewind can mask a fetch-cap skip; co-consumers of one query can need opposite fetch orders"
date: 2026-06-09
category: architecture-patterns
module: backend/notifications
problem_type: architecture_pattern
component: caching
severity: high
applies_when:
  - "A forward-advancing cursor (next poll resumes strictly after the last delivered key) reads a cursor-agnostic cached batch computed with a SQL ORDER BY ... LIMIT"
  - "One shared query/fetch helper serves consumers with different access patterns (a real-time feed vs a completeness-oriented drain)"
  - "A client-side cursor adjustment (rewind, skip-ahead, retry-at-offset) compensates for a server pagination boundary"
  - "Removing or simplifying a defensive client-side pagination hack"
  - "An ORDER BY ... LIMIT over a wide window lacks a deterministic same-key tie-breaker"
related_components:
  - database
tags: [cursor, pagination, fetch-order, has-more, notifications, caching, tie-breaker]
---

# Forward-cursor feeds must fetch newest-first; a client rewind can mask a fetch-cap skip; co-consumers of one query can need opposite fetch orders

## Context

This is the fetch-DIRECTION companion to [[cursor-agnostic-cache-must-dominate-result-set]], which covers fetch SIZE (decoupling the internal fetch cap from the response limit so the cached batch dominates every cursor's slice). Same surface — `fetchNotificationsFromHaf` / `applySinceBlockFilter` in the notifications path, the per-`(account, limit)` cached window batch, the integer block cursor applied in-app via a strict `>` filter — but three different traps, all rooted in the shape `ORDER BY block_num ASC LIMIT <cap>` over a wide window floor.

A latent stall was filed: a single Hive block holding more than the response `limit` events for one account freezes the feed (the response slices mid-block, the SPA rewinds its cursor to `latest_block - 1` on `has_more`, and never advances past that block). The obvious-looking fix — "deliver whole blocks and drop the client rewind" — was proven by adversarial design verification to be **strictly worse than the status quo**, and tracing the root cause showed it was entangled with a separate route ">CAP starvation" residual and a digest re-send cascade. The three reusable lessons below are what survived that verification.

## Guidance

### 1. A forward-cursor "what's new" feed must fetch NEWEST-first, not oldest-first.

When the cached batch is `ORDER BY <key> ASC LIMIT <cap>` over a wide floor, it is the OLDEST `cap` rows. A forward cursor that has caught up to near the head sits ABOVE all of them, so the in-app `> cursor` filter strips the entire batch while the newest in-window rows sit beyond the `LIMIT` cut, unreachable. The feed silently truncates (or parks at the cap-top with `events: []`, `has_more: true`). Fetch `ORDER BY <key> DESC LIMIT <cap>` (the NEWEST `cap` rows, reversed to ascending for the consumer) so a caught-up cursor always sees recent activity. The bell-feed history for an account with more than `cap` in-window rows is then bounded to the newest `cap` (older rows are covered by a completeness consumer like an email digest), which is the correct trade for a "recent activity" surface.

This is a DISTINCT axis from the domination doc: that one is about fetch *quantity* (cap vs response limit); this one is about *which end* the `LIMIT` keeps. Both can bite the same query.

### 2. Before deleting a defensive client-side cursor hack, prove which edge it actually defends — trace EVERY truncation point.

The SPA rewind (`re-poll at latest_block - 1` on `has_more`) was introduced to recover events that the *response `limit`* cut mid-block. But it was also, silently, the only thing preventing a skip at the *internal fetch-cap* edge: the cached batch's `ORDER BY block_num` had no deterministic tie-breaker, so the `LIMIT` could cut THROUGH a block at the batch's truncated tail, leaving `latest_block` partial. The rewind kept the cursor from advancing past that partial block. Removing the rewind without first guaranteeing the batch never exposes a cap-truncated block converts a lossless stall into a PERMANENT silent skip plus a multi-day stall. The lesson: a pagination hack often defends more than one boundary. Enumerate every truncation point (response limit AND internal fetch cap AND any non-deterministic ordering) and prove each is independently safe before simplifying. The safe shape here is to drop the partial boundary block inside the shared fetch (return only whole blocks) AND add a deterministic same-key tie-breaker, so the consumer never sees a cap-truncated block and the cursor can advance unconditionally.

### 3. Two consumers of ONE shared query can need OPPOSITE fetch orders.

The SPA bell feed (real-time, "show me recent activity", old gaps acceptable) wants newest-first. The email digest (completeness, drain everything since the last cursor without skipping, over multiple cadences) wants oldest-first. They legitimately share the strict `>` cursor filter, but forcing one fetch order on both is what entangled the two tasks and produced a P1 digest re-send cascade (oldest-first + "advance only when not `has_more`" never advances for a sustained >cap-window account, re-emailing the same oldest batch every cadence). Resolve it by parametrizing the fetch DIRECTION on the shared helper (`direction: 'asc' | 'desc'`) while keeping the strict-`>` filter shared, and push the partial-boundary-block drop into the shared helper so BOTH directions are safe. Do not collapse two different access patterns onto one fetch order to "avoid drift" — the shared filter is the anti-drift surface; the fetch order is a per-consumer parameter.

## Why This Matters

All three failure modes are silent and self-confirming: the route returns a well-formed `events: []` (or a truncated page) with `has_more` that does not trip any error path, and the polling client parks or advances normally. The chain (the source of truth) has the rows; the fetch shape makes them unreachable, converting a performance layer into a silent correctness authority — the same class the domination doc flags, on a different axis. They are also attacker-constructible at low cost: an accredited actor flooding a victim with cheap distinct-permlink events pushes the victim's in-window count past the cap and starves their feed. And the "obvious" fix (drop the hack) is the dangerous one — only adversarial, multi-lens verification (a counterexample-hunter lens against the proposed algorithm, plus a completeness-critic lens that surfaced the already-filed sibling tasks) caught that it regressed. For a fix touching a shared query consumed by multiple surfaces, grep the task tree for the same root-cause symptom before scoping; the "contained, keeps the integer cursor" framing hid a cross-task entanglement.

## When to Apply

- Designing or reviewing any forward-cursor feed backed by a cursor-agnostic cached batch with a SQL `ORDER BY ... LIMIT`. Ask: does the `LIMIT` keep the end the cursor is moving toward? (For a forward feed near head, that is the newest end → `DESC`.)
- Before removing or simplifying a client-side pagination compensation (rewind, skip, retry-at-offset): enumerate every server truncation boundary it might be silently covering.
- When one fetch helper is consumed by surfaces with different completeness/recency needs: parametrize the fetch order, share only the cursor filter.
- Whenever an `ORDER BY ... LIMIT` over a wide window can tie on the sort key: add a deterministic monotonic tie-breaker (in PEvO, the HAF op `id`, per [[hive-primitive-aware-design-rules-for-pevo-custom-json-ops]] Rule 2) so the cut is reproducible across cache recomputations.
- Single-instance scale note: a residual that requires an absurd per-block volume (here, more than `cap` recipient-relevant events for one account in one 3s block) is acceptable to document-and-defer rather than fix, because PEvO is single-instance and accredited-only; the only amplifier (a citation-array fan-out) is capped by a paper-existence join at the victim's real paper count. Graceful deferral (the row surfaces once the window floor slides) beats a contract-breaking composite cursor.

## Examples

Starvation by fetch direction (`cap` rows above the floor, cursor caught up near head):

```
-- OLDEST-first (broken for a caught-up forward cursor):
--   ORDER BY block_num ASC LIMIT 1000  -> batch = oldest 1000 rows above floor
--   cursor near head -> filter(block_num > cursor) strips ALL 1000
--   newest rows sit beyond the LIMIT cut -> feed silently empty + has_more=true (parks)

-- NEWEST-first (correct):
--   ORDER BY block_num DESC LIMIT 1000  (reversed to ascending for the consumer)
--   cursor near head -> filter keeps the newest undelivered rows -> feed shows recent activity
```

The rewind masking a cap-edge skip (no tie-breaker on `ORDER BY block_num`):

```
window has 1010 in-window rows; the cap-boundary block N holds 20 of them (rows #991..#1010).
ORDER BY block_num ASC LIMIT 1000 returns 990 older rows + an ARBITRARY 10 of block N's 20.
  - WITH the rewind (status quo): has_more=true -> client re-polls at latest_block-1, never
    advances past N -> lossless stall (annoying but no data loss).
  - WITHOUT the rewind, naive "advance to latest_block": cursor moves past N -> N's other 10
    rows (and everything beyond the cap) are skipped PERMANENTLY -> strictly worse.
  - FIX: shared fetch drops the partial boundary block (return rows with block_num < max when the
    cap was hit) AND adds `ORDER BY block_num <dir>, id <dir>` -> the consumer never sees a
    cap-truncated block, so advancing to latest_block is always safe and the rewind is removable.
```

Opposite fetch orders, one shared filter:

```ts
// Shared helper: parametrize direction, share the strict-> filter, drop the partial boundary block.
fetchNotificationsFromHaf(account, windowFloor, CAP, /* direction */ 'desc') // route: newest-first feed
fetchNotificationsFromHaf(account, windowFloor, CAP, /* direction */ 'asc')  // digest: oldest-first drain
// filterEventsAfter(events, cursor) // strict > — identical for both; the anti-drift surface
```

## Related

- [[cursor-agnostic-cache-must-dominate-result-set]] — the fetch-SIZE sibling at the same `applySinceBlockFilter` / `fetchNotificationsFromHaf` surface. That doc: decouple the internal cap from the response limit so the batch dominates every cursor slice. This doc: also get the fetch DIRECTION right, drop the partial cap-boundary block, and let co-consumers pick opposite orders. Read together.
- [[hive-primitive-aware-design-rules-for-pevo-custom-json-ops]] Rule 2 — the HAF op `id` monotonic tie-breaker convention that makes the `LIMIT` cut deterministic.
- [[single-flight-coalescing-amplifies-cache-invalidation-race]] and [[per-request-memo-catch-block-negative-cache-contract]] — neighboring failure classes at the same `QueryCache` layer.
