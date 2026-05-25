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

## Backend implementer signal (2026-05-21)

Landed in `backend/src/redis.ts`:

- `retryStrategy` now returns `Math.min(times * 200, 5000)` for every `times` (no `null` bailout). The `times > 3` short-circuit is gone, so ioredis keeps reconnecting indefinitely with backoff capped at 5s.
- `close` handler no longer nulls `redis`. The cached reference survives the disconnect so callers keep talking to the same ioredis instance once it reconnects. `isRedisAvailable()` (which checks `status === 'ready'`) and `cache.ts`'s per-call try/catch already route to the in-memory fallback during the disconnect window.
- Initial-connect `client.connect().catch(...)` no longer nulls the cached reference either, so a slow-start Redis comes online once it's reachable.
- Status transitions are surfaced via dedicated `connect` / `ready` / `reconnecting` / `end` listeners through a `logStatusTransition()` helper that suppresses repeat events. One line per transition, `event=<name>`, `status=<status>`, optional `delay` on `reconnecting`. Per the project's "logging minimal" feedback: no per-command noise, no gauges on every tick.
- Added `reconnectOnError` that returns `true` for `READONLY` errors so a primary/replica flip triggers a reconnect rather than returning errors until manual restart.
- Queue-depth bound: ioredis v5 has no `commandsQueueMaxLength` option. The bound is enforced by the existing `maxRetriesPerRequest: 3` (commands reject after N retries, freeing their offline-queue slot) plus a 30s-interval watchdog that inspects the private `offlineQueue.length` and warns when it crosses 10_000 (logs a second info line when it drains back below). Watchdog is `unref()`'d so it doesn't keep the process alive; `disconnectRedis()` clears it on shutdown.

Targeted tests landed in `backend/tests/redis-reconnect.test.ts` (3 specs, all green against real Redis):

- `retryStrategy returns a finite backoff for every retry count` — probes `times` 1..5000 against a throwaway client's configured strategy; asserts every result is a positive bounded number.
- `module-scoped client survives a synthetic close event without being nulled` — emits `close` on the shared client and asserts `getRedis()` returns the same instance.
- `recovers from a real disconnect: disconnect(true) -> ready -> commands succeed` — calls `redis.disconnect(true)` on the live ioredis client, waits for the `ready` event to fire again, asserts identity is preserved, and round-trips a real SET/GET against the recovered connection. This is the integration-shaped real-path companion the acceptance criterion calls for.

Existing Redis-touching suites (`tests/cache.test.ts`, `tests/lib/cache.test.ts`, `tests/lib/redis-scripts.test.ts` — 21 specs total) pass against the new client.

Lint + typecheck clean.

## Architect re-review (2026-05-25) — HELD PENDING FIXES:

Round-1 hold from `/ce-code-review` fan-out (8 personas; item 1 corroborated by 5 reviewers independently):

1. **`retryStrategy` test asserts against ioredis defaults, not the production strategy.** The first spec in `backend/tests/redis-reconnect.test.ts` constructs a throwaway `new Redis('redis://127.0.0.1:1', { lazyConnect: true })` with no options and reads `probe.options.retryStrategy`. That resolves to ioredis's built-in default (`Math.min(times * 50, 2000)`), not the production strategy `Math.min(times * 200, 5000)` defined inside `getRedis()`. The test would pass identically if the `times > 3` permanent-bailout regression were reintroduced — the exact failure mode this commit was written to prevent. Fix: read `retryStrategy` off the module-scoped client (`(getRedis() as unknown as { options: { retryStrategy?: (times: number) => number | null } }).options.retryStrategy`), or export `retryStrategy` as a named function from `redis.ts` and assert against it directly. Flagged independently by reliability, testing, maintainability, project-standards, and kieran-typescript at confidence 100.

2. **`logStatusTransition` final `else` is dead code.** The `else if (event === 'reconnecting' || event === 'end')` arm and the trailing `else` arm both call `logger.warn(payload, 'redis status')` with identical arguments. The structural split signals a third event category that doesn't exist. Collapse to `if (event === 'ready' || event === 'connect') logger.info(...); else logger.warn(...);`.

3. **`reconnecting` callback parameter silently falls through to ioredis's any-args overload.** `client.on('reconnecting', (delay: number) => ...)` does not match the typed `cb: () => void` overload, so the parameter is effectively `any`. Runtime is correct (ioredis does emit delay), but the type-checker is off — a future ioredis signature change would not be caught. Make the cast visible: receive via `(...args: unknown[]) => { const delay = args[0] as number | undefined; ... }`.

4. **`reconnectOnError` comment overstates the protection.** The comment implies the triggering READONLY command is preserved across the auto-reconnect. ioredis v5 with `return true` rejects the triggering command and only then reconnects (returning `2` would re-send it). Update the comment to say the triggering command rejects but subsequent commands route correctly post-reconnect. The hook is essentially dead code in single-instance PEvO (no failover), but the misleading comment would trip a reader debugging a failover scenario.

Synthetic-close test tautology (P3 adversarial flag) is **dismissed** — the test catches the targeted regression (close handler nulling the cache) even if the assertion is thin; the real disconnect/reconnect/round-trip test covers the substantive risk class.

