# BACKEND-REDIS-CLIENT-PERMANENT-BAILOUT — Redis client must recover from transient disconnect

**Owner:** backend
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-3-reliability-reviewer.md`)
**Priority:** P1 (reliability)

## Context

`backend/src/redis.ts` configures the ioredis client with:

```ts
retryStrategy(times) {
  if (times > 3) return null;
  ...
}
```

When ioredis's `retryStrategy` returns `null`, the client gives up and stops reconnecting. The `close` handler then nulls the module-scoped cache reference. Subsequent calls to `getRedis()` go through the lazy-init path which hits the same retry strategy and bails out the same way after 3 attempts.

Net effect: any Redis blip lasting longer than the 3-retry backoff window (a few seconds, depending on backoff) permanently degrades the backend until restart. Rate limits, signature replay caches, anonymous-review mappings, batch reputation, IPFS hot-cache — all silently fall back to in-memory shadow stores or just don't work.

The fallback shadow stores have their own audit findings (in-memory growth unbounded, multi-instance divergence, heap-dump privacy surface). They are not a substitute for actual reconnection.

## Goal

Let ioredis handle reconnection the way it was designed to:

1. **Remove the `times > 3` bailout** in `retryStrategy`. Return a backoff value (e.g., `Math.min(times * 200, 5000)`) indefinitely.
2. **Keep the close handler from nulling the cached reference.** The reference can stay; ioredis will reconnect on its own and queued commands will flush.
3. **Surface Redis status to the operator.** Add a `redis_connected` gauge or a log line on `connect`/`end`/`reconnecting`/`ready` events so operators can see when Redis is degraded.
4. **Bound queued command memory.** ioredis's default `enableOfflineQueue: true` queues commands while disconnected; under a long outage this can grow unboundedly. Cap with `commandsQueueMaxLength` (e.g., 10_000), and have the queue overflow path surface in logs.

## Non-goals

- Removing the in-memory shadow stores entirely. They have their own audit task (`feedback_in_memory_shadow_corrects_durability`); separate cleanup.
- Reworking which paths use Redis vs in-memory. Scope to the client reconnect behavior.

## Acceptance

- `redis.ts` `retryStrategy` returns a finite backoff value for every `times` value (no `null` return).
- Close handler does not null the cached client reference.
- A test runs the backend, kills Redis for ~10s, restarts Redis, and asserts subsequent Redis-backed operations succeed without backend restart.
- Operator-visible log line on reconnection.

## References

- Audit chunk: `.context/audit-2026-04-21/chunk-3-reliability-reviewer.md` (P1: Redis client never recovers from transient disconnect).
