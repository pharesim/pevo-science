import Redis from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';
import { loadAllScripts } from './lib/redis-scripts.js';

let redis: Redis | null = null;
// Track last logged status so transitions are surfaced exactly once.
// Operators get one line per state change (connect, ready, reconnecting,
// end, error-during-reconnect) and no per-command noise.
let lastLoggedStatus: string | null = null;
// Watchdog interval for the offline-queue depth probe. Held on the
// module so disconnectRedis() can clear it on shutdown.
let queueWatchdog: NodeJS.Timeout | null = null;
// Suppress repeated "queue still over threshold" warnings — log on each
// crossing of the threshold (low -> high), not on every interval tick.
let queueOverThreshold = false;

// Queue-depth thresholds. ioredis has no `commandsQueueMaxLength` option;
// the bound is enforced by `maxRetriesPerRequest` (individual commands
// reject after N retries, freeing their queue slot) plus this watchdog
// that surfaces sustained queue growth to the operator log.
const OFFLINE_QUEUE_WARN_THRESHOLD = 10_000;
const QUEUE_WATCHDOG_INTERVAL_MS = 30_000;

// Per-command latency ceiling. A Redis server that accepts the connection
// but stalls on an individual command (Lua cache pressure under OOM, half-
// open socket post-network-partition, NOSCRIPT recovery against a flushed
// scripts cache) would otherwise hang the awaiting caller indefinitely:
// `maxRetriesPerRequest` governs connection-level retry, not per-command
// timeout. 5000ms is generous vs. steady-state command durations on the
// hot paths (accreditation /verify pre-INCR, reputation-batch lock
// release — both well under 100ms) while bounding worst-case stalls to a
// magnitude operators and HTTP clients can act on. Timed-out commands
// reject with an ioredis-side timeout error and route through callers'
// existing catch handlers (e.g. the accreditation /verify pre-INCR 503
// SERVICE_UNAVAILABLE branch).
const REDIS_COMMAND_TIMEOUT_MS = 5_000;

function logStatusTransition(client: Redis, event: string, detail?: Record<string, unknown>): void {
  // Skip if the client emitted the same event twice in a row (e.g. two
  // `reconnecting` events back-to-back during a flap). Transition logs
  // are for human operators, not for tracing every event-loop tick.
  if (lastLoggedStatus === event) return;
  lastLoggedStatus = event;
  const payload = { event, status: client.status, ...(detail ?? {}) };
  if (event === 'ready' || event === 'connect') {
    logger.info(payload, 'redis status');
  } else if (event === 'reconnecting' || event === 'end') {
    logger.warn(payload, 'redis status');
  } else {
    logger.warn(payload, 'redis status');
  }
}

function getOfflineQueueLength(client: Redis): number {
  // `offlineQueue` is private in ioredis but is the only way to inspect
  // queue depth without monkey-patching `sendCommand`. The cast is the
  // shape ioredis uses internally (a `denque` instance with a `.length`
  // accessor). If a future ioredis upgrade renames or removes this
  // field, the watchdog silently returns 0 — degrades to "no depth
  // visibility" rather than crashing the process.
  const queue = (client as unknown as { offlineQueue?: { length?: number } }).offlineQueue;
  return queue?.length ?? 0;
}

function startQueueWatchdog(client: Redis): void {
  if (queueWatchdog) return;
  queueWatchdog = setInterval(() => {
    if (redis !== client) {
      // Client got swapped out (disconnectRedis cycle). Drop the watchdog.
      if (queueWatchdog) {
        clearInterval(queueWatchdog);
        queueWatchdog = null;
      }
      return;
    }
    const depth = getOfflineQueueLength(client);
    if (depth >= OFFLINE_QUEUE_WARN_THRESHOLD && !queueOverThreshold) {
      queueOverThreshold = true;
      logger.warn(
        { offlineQueueLength: depth, threshold: OFFLINE_QUEUE_WARN_THRESHOLD, status: client.status },
        'redis offline queue depth crossed warn threshold',
      );
    } else if (depth < OFFLINE_QUEUE_WARN_THRESHOLD && queueOverThreshold) {
      queueOverThreshold = false;
      logger.info(
        { offlineQueueLength: depth, threshold: OFFLINE_QUEUE_WARN_THRESHOLD, status: client.status },
        'redis offline queue drained below warn threshold',
      );
    }
  }, QUEUE_WATCHDOG_INTERVAL_MS);
  queueWatchdog.unref();
}

export function getRedis(): Redis | null {
  if (redis) return redis;
  if (!config.redisUrl) return null;

  const client = new Redis(config.redisUrl, {
    // Bounded per-command retry budget. After N retries the command
    // rejects with `MaxRetriesPerRequestError`, freeing its slot in
    // the offline queue. This is ioredis's primary queue-growth
    // bounder (no `commandsQueueMaxLength` option exists in v5).
    maxRetriesPerRequest: 3,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    lazyConnect: true,
    // Indefinite reconnect backoff. ioredis handles transient
    // disconnects natively; a finite cap (the prior `times > 3`
    // bailout) turned blips into permanent degradation.
    retryStrategy(times) {
      return Math.min(times * 200, 5000);
    },
    // Trigger reconnect on READONLY errors so a Sentinel/primary
    // failover flips the client to the new primary rather than
    // returning errors until manual restart.
    reconnectOnError(err) {
      if (err.message.startsWith('READONLY')) return true;
      return false;
    },
  });

  client.on('error', (err) => {
    // Per-error logging stays at error level so existing ops dashboards
    // continue to pick up real failures. Status-transition logs (info
    // for connect/ready, warn for reconnecting/end) live on the
    // separate event handlers below.
    logger.error({ err }, 'Redis connection error');
  });

  client.on('connect', () => {
    logStatusTransition(client, 'connect');
  });

  client.on('ready', () => {
    logStatusTransition(client, 'ready');
    loadAllScripts(client).catch((err) => {
      logger.warn({ err }, 'Redis SCRIPT LOAD failed; evalScript will fall back to EVAL until next reconnect');
    });
  });

  client.on('reconnecting', (delay: number) => {
    logStatusTransition(client, 'reconnecting', { delay });
  });

  client.on('end', () => {
    logStatusTransition(client, 'end');
  });

  client.on('close', () => {
    // Cached reference is intentionally preserved. ioredis will reconnect
    // per `retryStrategy`; nulling the reference here would force the
    // next `getRedis()` call to construct a fresh client and race the
    // existing reconnect loop.
    //
    // Callers route to in-memory fallback via `isRedisAvailable()` (which
    // checks `status === 'ready'`) or via the per-call try/catch shape
    // in `cache.ts`. Both work whether the client is mid-reconnect or
    // permanently dead; this handler does not need to gate them.
  });

  redis = client;
  startQueueWatchdog(client);

  // Connect async — callers check isRedisAvailable() before use. Failure
  // here does NOT null the cached reference: ioredis will retry per
  // `retryStrategy` and emit `connect`/`ready` once the server is
  // reachable. The error log surfaces the initial-connect failure to
  // the operator; subsequent transitions surface on status events.
  client.connect().catch((err) => {
    logger.warn({ err }, 'Redis initial connect failed; ioredis will keep retrying');
  });

  return redis;
}

export function isRedisAvailable(): boolean {
  return redis !== null && redis.status === 'ready';
}

export async function disconnectRedis(): Promise<void> {
  if (queueWatchdog) {
    clearInterval(queueWatchdog);
    queueWatchdog = null;
  }
  if (redis) {
    await redis.quit().catch((err) => { logger.debug({ err }, 'Redis quit failed during disconnect'); });
    redis = null;
    lastLoggedStatus = null;
    queueOverThreshold = false;
  }
}
