import type { Request, Response, NextFunction } from 'express';
import { sendError } from '../response.js';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyFn: (req: Request) => string;
  name: string;
}

/**
 * Creates a rate-limiting middleware.
 * Uses Redis when available, falls back to in-memory Map.
 * Returns 429 with Retry-After header when limit is exceeded.
 */
export function rateLimit(config: RateLimitConfig) {
  const memStore = new Map<string, RateLimitEntry>();
  const redisPrefix = `rl:${config.name}:`;

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
        const count = await redis.incr(redisKey);
        if (count === 1) {
          await redis.pexpire(redisKey, config.windowMs);
        }
        if (count > config.max) {
          const ttl = await redis.pttl(redisKey);
          const retryAfter = Math.ceil(Math.max(ttl, 0) / 1000);
          res.set('Retry-After', String(retryAfter));
          return sendError(res, 429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
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

    entry.timestamps.push(now);
    memStore.set(key, entry);
    next();
  };
}

/** Key by client IP address */
export function byIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
}

/** Key by verified Hive username (set by verifyHiveSignature middleware).
 *  IMPORTANT: Only use this key function AFTER verifyHiveSignature has run,
 *  otherwise it falls back to IP-based limiting. */
export function byAccount(req: Request): string {
  return req.hiveUsername || byIp(req);
}
