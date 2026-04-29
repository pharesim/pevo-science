# BACKEND-A1-EXTEND-LOCK-MISSING-EVENT-DISCRIMINATION — distinguish self-expire vs sibling-DEL vs Redis-eviction at lock-extension time

**Owner:** Backend Agent
**Created:** 2026-04-30 (architect, surfaced by cluster 2 task 1+2 round-3 review — reliability conf 80 + adversarial conf 60 cross-reviewer convergence)
**Priority:** P3

## Problem

The `extendBindingLockOnTimeoutOrLog` helper in `backend/src/routes/orcid.ts` fires `event: 'a1_extend_lock_missing'` when `redis.expire(lockKey, 120)` returns 0. Three distinct operational causes collapse to this single signal:

1. **Self-expire** — the lock TTL (~35s) elapsed naturally before extension. This means HAF indexing-lag preamble (acquireLock → broadcast attempt → BroadcastTimeoutError → reach the extend call) ate the entire window. **Operator action: investigate Hive node latency / HAF backlog.**
2. **Sibling DEL** — a sibling process explicitly released the lock via `releaseBindingLock`'s Lua CAS. This shouldn't happen mid-broadcast (the sibling can't acquire the same orcid_id while we hold it, modulo same-tick contention which writes a different anchor). **Operator action: investigate the sibling's lifecycle; potential lock-helper bug.**
3. **Redis eviction** — Redis under memory pressure flushed the key via `allkeys-lru` or similar policy. **Operator action: investigate Redis memory + eviction policy; consider scale-up.**

The single `lock_missing` event tag can't discriminate between these. Operator gets the same signal for "HAF lag exceeded the bound" (a routine cause-of-day) vs "Redis is under memory pressure" (a serious infrastructure regression).

## Why now

- The branch is **operationally reachable** in normal traffic, not just exceptional. Adversarial review surfaced that DB/HAF preamble can consume the 5s headroom between the 35s lock TTL and the 30s broadcast timeout, so case (1) fires more often than the helper's design originally framed.
- Without discrimination, the event is forensic-only at best — operators can't page on case (3) (real infra incident) without false-paging on case (1) (routine).
- Cluster 2 task 1+2's `chain-write-timeout-ambiguous-outcome` convention demands that operator anchors enable cause discrimination at the dashboard layer; this anchor partially fails that bar.

## Goal

Add a structured field to the `lock_missing` event payload (or split into multiple event literals) that lets operator dashboards distinguish the three causes.

## Proposed shapes

### Option A — `cause:` discriminator field

Read `redis.pttl(lockKey)` immediately before `redis.expire(lockKey, 120)`. If the pttl read returns `-2` (key missing), capture that. After expire returns 0, log the captured pttl-state alongside:

- `cause: 'expired_or_evicted'` (pttl was -2 before expire — the key was already missing). Could still be either case 1 or case 3, but can't distinguish further with Redis primitives alone.
- `cause: 'released_by_sibling'` (pttl was a positive value before expire but expire returned 0 — race between pttl read and expire call; more likely a sibling DEL'd the key in the gap).

Cases (1) and (3) remain conflated in this shape; the dashboard can correlate (1)-vs-(3) via co-occurrence with `event:'haf_lag_high'` (if such an anchor exists) or with Redis memory metrics.

### Option B — separate event literals

Drop `lock_missing` as a single literal. Emit one of:

- `event: 'a1_extend_already_expired'` — `redis.exists` before extend returned 0 AND there's no co-occurring sibling release log within the same request lifecycle.
- `event: 'a1_extend_redis_evicted'` — separately attributable via Redis memory check at extend time (probe `INFO memory` evicted_keys counter; correlate spikes with this anchor).
- `event: 'a1_extend_sibling_release'` — sibling release detected (rare; sibling shouldn't hold the same orcid_id during a broadcast).

Heavier but clearer per-cause dashboards.

### Recommendation

**Option A** is the lighter implementation. Option B requires Redis-side observability that PEvO doesn't have today (no Prometheus / Loki integration per cluster 2 task 1+2 agent-native review). Land Option A; revisit Option B if/when PEvO adds metric-based observability.

## Acceptance

1. **Read pttl before expire.** Inside `extendBindingLockOnTimeoutOrLog`, before `redis.expire(lockKey, EXTEND_TTL_SECONDS)`, do `const ttl = await redis.pttl(lockKey);` and capture the result.
2. **Add `cause:` field to the warn payload.** When `expire` returns 0, emit:
   - `cause: 'expired_or_evicted'` if `ttl === -2` (key missing at pttl-read time)
   - `cause: 'released_during_extend'` if `ttl > 0` at pttl-read time but `expire` returned 0 (race window between reads)
   - `cause: 'unknown'` for any other shape
3. **Test coverage.** Extend `tests/routes/orcid.test.ts`'s `a1_extend_lock_missing` matrix to cover both shapes:
   - Lock seeded then DEL'd between pttl and expire (race window — exercise via spy ordering).
   - Lock never seeded (pttl returns -2 first call).
4. **Document in convention.** Append a note to `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` documenting the per-cause anchor shape so the next operator runbook can key on it.

## Out of scope

- Adding Redis memory observability infrastructure (Prometheus, Loki, dashboards). Track separately if/when PEvO adds metric infrastructure.
- Mitigating the underlying cause (extending TTL further, restructuring the helper to be cause-aware before extension). The fix is observational, not behavioral.
- Sibling-DEL race investigation. If case 2 fires in production, the lock-helper has a separate bug worth its own task.

## Source

`/ce-code-review` cluster 2 task 1+2 round-3 review (2026-04-29):
- reliability finding R5 (P3 conf 80): "a1_extend_lock_missing event conflates self-expire vs eviction vs DEL"
- adversarial finding adv-3 (P3 conf 60): "branch is operationally reachable when DB/HAF preamble eats the 5s headroom"
- Cross-reviewer corroboration via cluster aggregation.

## Cross-references

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — operator anchor convention this task extends.
- `backend/src/routes/orcid.ts` `extendBindingLockOnTimeoutOrLog` helper.
- `backend-orcid-lock-ttl-extend-on-timeout.md` (in `tasks/review/`) — predecessor; this task is a follow-up that doesn't block its archive.
