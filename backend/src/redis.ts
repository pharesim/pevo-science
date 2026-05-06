import Redis from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';
import { loadAllScripts } from './lib/redis-scripts.js';

let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (redis) return redis;
  if (!config.redisUrl) return null;

  const client = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    retryStrategy(times) {
      if (times > 3) return null; // stop retrying
      return Math.min(times * 200, 2000);
    },
  });

  client.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });

  client.on('ready', () => {
    loadAllScripts(client).catch((err) => {
      logger.warn({ err }, 'Redis SCRIPT LOAD failed; evalScript will fall back to EVAL until next reconnect');
    });
  });

  client.on('close', () => {
    if (redis === client) {
      logger.warn('Redis connection closed — falling back to in-memory');
      redis = null;
    }
  });

  redis = client;

  // Connect async — callers check isRedisAvailable() before use
  client.connect().catch((err) => {
    logger.warn({ err }, 'Redis connection failed — falling back to in-memory');
    if (redis === client) redis = null;
  });

  return redis;
}

export function isRedisAvailable(): boolean {
  return redis !== null && redis.status === 'ready';
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit().catch((err) => { logger.debug({ err }, 'Redis quit failed during disconnect'); });
    redis = null;
  }
}
