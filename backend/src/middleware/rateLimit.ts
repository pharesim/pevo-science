import type { Request, Response, NextFunction } from 'express';
import { sendError } from '../response.js';
import { getRedis } from '../redis.js';
import { config as appConfig } from '../config.js';
import { logger } from '../logger.js';
import { evalScript } from '../lib/redis-scripts.js';

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyFn: (req: Request) => string;
  name: string;
  /**
   * When true, consume a slot only on successful responses (status < 400).
   * 4xx/5xx responses are refunded after `res.on('finish')` /
   * `res.on('close')` so the limit counts SUCCESSFUL operations, not all
   * requests. This protects against two DoS patterns on expensive-but-rare
   * operations:
   *   1. Transient upstream failures (e.g. Hive RPC 503) burning the slot,
   *      locking the legitimate user out of a retry within the window.
   *   2. A stolen-JWT attacker sending malformed bodies (400 VALIDATION_ERROR)
   *      to lock out the legitimate user.
   *
   * Requests are still REJECTED with 429 when the current count is already at
   * the limit; this option only changes the consume policy on the outcome of
   * the downstream handler. Defaults to false (consume on every request).
   *
   * Implementation note: the Redis path uses an atomic Lua EVAL script
   * (INCR → check ≤ max → on overflow DECR + return 429, on success
   * PEXPIRE + return 200-pass). On `res.on('finish')` AND `res.on('close')`,
   * if status >= 400 the slot is refunded by an unconditional DECR. The
   * dual-listener pattern is required because TCP-abort / client-disconnect
   * does NOT fire `'finish'`; without `'close'` coverage a single dropped
   * connection mid-handler permanently consumes the slot for the full
   * window. A once-guard prevents double-refund when both events fire on
   * normal completion. The Redis handle is re-resolved (`getRedis()`)
   * inside the callback so a reconnect cycle between handler entry and
   * deferred fire doesn't capture a stale binding. The Lua script makes
   * the limit check + slot-consume atomic so concurrent requests for the
   * same key cannot both pass the `>= max` check and overshoot the limit
   * (the pre-Lua GET → next() → deferred-INCR pattern had a TOCTOU race
   * plus a permanent-lockout TTL bug where concurrent post-success INCRs
   * after count=1 never refreshed PEXPIRE). The in-memory fallback path
   * mirrors the same shape: push the timestamp synchronously on entry,
   * splice it back out on finish/close when status >= 400.
   *
   * Window semantic: the unconditional PEXPIRE inside the Lua makes EVERY
   * limiter (skipFailed or not) a rolling window — the TTL is refreshed on
   * every successful in-bound INCR. A bucket pinned just under `max` by a
   * steady stream of requests keeps its TTL refreshed indefinitely; the
   * window follows the most recent successful pass. For IP-keyed limiters
   * on routes shared via NAT, an attacker storming a NAT'd IP can keep
   * that bucket non-expiring; legitimate users sharing the IP see
   * sustained 429s instead of fixed-window recovery. The bound remains
   * `max` requests within any rolling 60s; the difference is when the
   * count resets. Counter-rejects (DECR-on-overflow) do NOT refresh
   * PEXPIRE, so under sustained over-`max` storms the bucket still
   * expires on the original windowMs from the last successful in-bound
   * INCR. See `RATE_LIMIT_CHECK_AND_CONSUME_LUA` for the underlying
   * mechanics. This is the intended trade-off vs. the permanent-lockout
   * bug that fixed-PEXPIRE-on-count==1 produced under concurrent INCRs.
   *
   * DO NOT use on credential-probing routes (e.g., /login, /recover) — failed
   * probes would not consume slots, enabling unlimited account enumeration.
   * The option is intended for one-shot ceremonies where failure is benign
   * (transient infrastructure error, malformed body from a hijacked session)
   * and the value at stake is operation success, not attempt-rate-limiting.
   */
  skipFailedRequests?: boolean;
}

/**
 * Creates a rate-limiting middleware.
 * Uses Redis when available, falls back to in-memory Map.
 * Returns 429 with Retry-After header when limit is exceeded.
 */
export function rateLimit(config: RateLimitConfig) {
  const memStore = new Map<string, RateLimitEntry>();
  const redisPrefix = `${appConfig.appTag}:rl:${config.name}:`;
  const skipFailed = config.skipFailedRequests === true;

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memStore) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < config.windowMs);
      if (entry.timestamps.length === 0) memStore.delete(key);
    }
  }, 60_000);
  cleanupInterval.unref();

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = config.keyFn(req);
    const now = Date.now();
    const redis = getRedis();

    if (redis) {
      try {
        const redisKey = redisPrefix + key;
        // Atomic INCR → check → DECR-or-EXPIRE in one round-trip via the
        // shared `RATE_LIMIT_CHECK_AND_CONSUME` Lua script (EVALSHA via
        // the SCRIPT-LOAD registry; falls back to EVAL on NOSCRIPT).
        // `evalScript<N>` returns `ScriptReturn[N]` (here [number, number]),
        // so no `as` cast is required. The runtime narrowing below is
        // defense-in-depth against ioredis returning a wrong-shape value
        // (older Redis, edge cases) — a non-tuple return falls through to
        // the in-memory path rather than silently 429ing all traffic.
        const result = await evalScript(
          redis,
          'RATE_LIMIT_CHECK_AND_CONSUME',
          [redisKey],
          [String(config.max), String(config.windowMs)],
        );
        if (!Array.isArray(result) || typeof result[0] !== 'number' || typeof result[1] !== 'number') {
          logger.warn(
            { event: 'rate_limit.malformed_lua_return', name: config.name, result },
            'rate_limit malformed Lua return — falling through to in-memory',
          );
          throw new Error('rate_limit malformed Lua return');
        }
        const passed = result[0] === 1;
        const pttl = result[1];
        if (!passed) {
          const retryAfter = Math.ceil(Math.max(pttl, 0) / 1000);
          res.set('Retry-After', String(retryAfter));
          return sendError(res, 429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
        }
        if (skipFailed) {
          // Refund the slot on failure (status >= 400). Register both
          // 'finish' and 'close' with a once-guard so TCP-abort / client-
          // disconnect (which fires 'close' but NOT 'finish') is covered.
          // Without 'close' coverage, an aborted upgrade (max=1/hr) would
          // permanently consume the legitimate user's slot for the full
          // hour — exactly the DoS this option is meant to prevent.
          // `getRedis()` is re-resolved inside the callback because a
          // reconnect cycle between handler entry and deferred-fire would
          // otherwise capture a stale binding.
          let refunded = false;
          const refund = () => {
            if (refunded || res.statusCode < 400) return;
            refunded = true;
            const r = getRedis();
            if (!r) return;
            void (async () => {
              try {
                await r.decr(redisKey);
              } catch (err) {
                logger.debug({ err }, 'Redis rate limit slot refund failed');
              }
            })();
          };
          res.on('finish', refund);
          res.on('close', refund);
        }
        return next();
      } catch (err) {
        logger.debug({ err }, 'Redis rate limit check failed, falling back to memory');
      }
    }

    const entry = memStore.get(key) || { timestamps: [] };
    entry.timestamps = entry.timestamps.filter((t) => now - t < config.windowMs);

    if (entry.timestamps.length >= config.max) {
      const oldestInWindow = entry.timestamps[0];
      const retryAfter = Math.ceil((oldestInWindow + config.windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return sendError(res, 429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
    }

    // Push the timestamp synchronously on entry — matches the Redis path's
    // INCR-up-front semantics. For skipFailed mode, splice it back out on
    // finish when status >= 400 (refund). This avoids the in-memory TOCTOU
    // overshoot where two concurrent requests would both pass the length
    // check and then both push on finish, exceeding `max` by 1.
    const pushedTs = now;
    entry.timestamps.push(pushedTs);
    memStore.set(key, entry);

    if (skipFailed) {
      // Same dual-listener once-guard pattern as the Redis path: 'close'
      // covers TCP-abort / client-disconnect; 'finish' covers normal
      // completion. Either-or fires on a given request, but defensive
      // double-registration with `refunded` flag prevents double-splice
      // when both fire on a clean finish-then-close sequence.
      let refunded = false;
      const refund = () => {
        if (refunded || res.statusCode < 400) return;
        refunded = true;
        const e = memStore.get(key);
        if (!e) return;
        const idx = e.timestamps.indexOf(pushedTs);
        if (idx >= 0) e.timestamps.splice(idx, 1);
      };
      res.on('finish', refund);
      res.on('close', refund);
    }

    next();
  };
}

/** Key by client IP address.
 *
 * Relies on Express's `trust proxy = 1` setting in `app.ts` to derive `req.ip`
 * from the first-in-chain `X-Forwarded-For` value appended by nginx. Without
 * that app-level setting, Express ignores XFF and `req.ip` is the peer socket
 * address, so arbitrary XFF values from clients cannot spoof the key. */
export function byIp(req: Request): string {
  return req.ip ?? 'unknown';
}

/** Key by verified Hive username (set by verifyHiveSignature middleware).
 *  IMPORTANT: Only use this key function AFTER verifyHiveSignature has run,
 *  otherwise it falls back to IP-based limiting. */
export function byAccount(req: Request): string {
  return req.hiveUsername || byIp(req);
}
