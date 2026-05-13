import { config } from './config.js';
import { isHafConfigured, closeHafPool, getPool } from './db.js';
import { initAppDb, closeAppPool } from './app-db.js';
import { createApp } from './app.js';
import { validateConfig, checkOrcidProcessSafety, BootFatalError } from './startup-checks.js';
import { startBlockWatcher, stopBlockWatcher } from './block-watcher.js';
import { startDigestScheduler, stopDigestScheduler } from './digest.js';
import { startIpfsCleanup, stopIpfsCleanup } from './ipfs-cleanup.js';
import { startBatchReputation, stopBatchReputation, repairAbandonedBatchState } from './reputation-batch.js';
import { disconnectRedis } from './redis.js';
import { checkHiveNodes } from './hive.js';
import { startRetractionCache } from './routes/papers.js';
import { startStatsCache } from './routes/stats.js';
import { getGenesisBlock } from './hafsql.js';
import { startReputationWeightsCache, backfillAccreditationSeeds } from './reputation.js';
import { startWotThresholdCache } from './wot.js';
import { startAccountClaimer, stopAccountClaimer } from './account-creation.js';
import { startSignupCleanup, stopSignupCleanup } from './signup-cleanup.js';
import { drainArgon2Queue, startArgon2AbortReporter, stopArgon2AbortReporter } from './lib/argon2-semaphore.js';
import { startDecrementQueueDrainer, stopDecrementQueueDrainer } from './lib/pending-decrement-queue.js';
import { logger } from './logger.js';
import { flushAndExit } from './lib/flush-and-exit.js';
import type { Server } from 'http';

// ── Boot-fatal flush+exit watchdog ──────────────────────────
//
// Round-4 hold #1 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
// `flushAndExit` lives in `src/lib/flush-and-exit.ts` so the boot path AND
// the unit-test canary at `tests/lib/flush-and-exit.test.ts` share the
// exact same implementation. The watchdog ensures `process.exit(1)` is
// reached even when pino's `flush(cb)` callback never fires (back-pressured
// stdout, wedged worker thread). See the helper's own docblock for the
// full rationale.

// ── Uncaught error handlers ─────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  flushAndExit();
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection — shutting down');
  flushAndExit();
});

// ── Startup ─────────────────────────────────────────────────
//
// Round-4 hold #1 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
// Wrap the synchronous boot in a try/catch so a `BootFatalError` thrown
// from `validateConfig()` / `initBridgePostingKeyCache()` unwinds the call
// stack before `createApp()` / `initAppDb()` can run. The round-3 flush-
// exit shape returned synchronously to this module and let `createApp()` +
// `initAppDb()` (which runs DB migrations!) execute during the async flush
// window on a fatal-misconfigured boot. The throw-then-catch shape blocks
// that window — control reaches the catch BEFORE any post-validate boot
// code runs. Unexpected throws are logged once here (boot-fatal sites
// already logged before throwing `BootFatalError`, so we suppress the
// re-log on that subclass to avoid noise).
//
// CONSTRAINT: validateConfig and createApp MUST remain synchronous and at
// module-evaluation scope. Introducing await or moving these into a .then
// chain would route BootFatalError to the wrong handler (e.g.
// initAppDb().catch logged as 'Failed to initialize app database'),
// defeating the structured boot-fatal path.
//
// Round-5 hold #5 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
// `app` is narrowed via the `if (app) { ... }` block below rather than a
// `throw err;` at the end of the catch. The previous re-throw propagated
// `BootFatalError` to module-evaluation scope, where Node routed it to the
// `uncaughtException` handler — which logged a synthetic 'Uncaught
// exception — shutting down' fatal AND called `flushAndExit()` again (two
// timers, two flush calls, duplicate log line). Falling through to the
// positive `if (app)` guard avoids the re-entry; `flushAndExit()` from the
// catch block is the sole exit path for boot-fatal cases.
let app: ReturnType<typeof createApp> | undefined;
try {
  validateConfig();
  app = createApp();
} catch (err) {
  if (!(err instanceof BootFatalError)) {
    logger.fatal({ err }, 'Boot failed — unexpected throw during startup');
  }
  flushAndExit();
}
let server: Server;

if (app) {
  const bootedApp = app;
  initAppDb()
    .then(async () => {
      // Warm genesis block cache before accepting traffic
      const hafPool = getPool();
      if (hafPool) await getGenesisBlock(hafPool);

      // Start periodic cache refreshes before accepting traffic
      await startRetractionCache();

      server = bootedApp.listen(config.port, () => {
        // Warm expensive shared HAF caches in the background (non-blocking).
        // repairAbandonedBatchState fires unconditionally at boot so a HAF
        // outage or lock contention does not delay crash detection on the
        // reputation batch path (BACKEND-REPUTATION-SSOT round-2 hold #2).
        Promise.all([
          startReputationWeightsCache(),
          startWotThresholdCache(),
          startStatsCache(),
          backfillAccreditationSeeds(),
          repairAbandonedBatchState(),
        ]).catch((err) => logger.warn({ err }, 'Background cache warmup failed'));
        logger.info({ port: config.port, haf: isHafConfigured(), appDb: !!config.appDatabaseUrl }, 'PEvO backend started');

        // Production-only: warn if Redis is unavailable, because ORCID OAuth
        // state then falls back to an in-memory map that is NOT multi-process safe.
        checkOrcidProcessSafety();

        if (isHafConfigured()) {
          startBlockWatcher();
        }

        // Start email digest scheduler if SMTP is configured
        if (config.smtpHost) {
          startDigestScheduler();
        }

        // Start IPFS orphan cleanup job
        startIpfsCleanup();

        // Start nightly batch reputation computation (v3 voter weight convergence)
        startBatchReputation();

        // Start account creation token claimer (every 24h)
        startAccountClaimer();

        // Start pending signup cleanup (every 1h)
        startSignupCleanup();

        // Start periodic argon2 abort-summary reporter (every 60s).
        // Surfaces silent ArgonAbortError events to operators at LOG_LEVEL=info.
        startArgon2AbortReporter();

        // Start in-process pending-decrement drainer for the
        // /api/accreditation/verify broadcast-attempt counter. Drains DECRs
        // queued during a Redis flap on the route's compensation path.
        startDecrementQueueDrainer();

        // Non-blocking: check Hive API node connectivity at startup
        void checkHiveNodes();
      });
    })
    .catch((err) => {
      // Round-4 hold #1 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
      // route through `flushAndExit()` so the fatal line drains under the 2s
      // watchdog (a hung-flush callback no longer hangs the boot indefinitely).
      logger.fatal({ err }, 'Failed to initialize app database');
      flushAndExit();
    });
}

// ── Graceful shutdown ───────────────────────────────────────
// Re-entrancy guard: SIGTERM and SIGINT both call shutdown(), and under
// high-latency pool drain a second signal can land before the first
// completes. closeHafPool() / closeAppPool() each follow a non-atomic
// `if (pool) { await pool.end(); pool = null; }` shape — two concurrent
// drains both observe pool !== null, both call pool.end(), and pg.Pool
// throws "called end on a pool more than once" on the second invocation.
// Flip a module-level flag synchronously on first entry so subsequent
// signals are no-ops.
let shutdownStarted = false;

async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) {
    logger.debug({ signal }, 'Duplicate shutdown signal received, ignored');
    return;
  }
  shutdownStarted = true;

  logger.info({ signal }, 'Shutdown signal received — draining connections');

  stopBlockWatcher();
  stopDigestScheduler();
  stopIpfsCleanup();
  stopBatchReputation();
  stopAccountClaimer();
  stopSignupCleanup();
  stopArgon2AbortReporter();
  stopDecrementQueueDrainer();

  // Reject any auth requests parked in the argon2 semaphore queue. Without
  // this, `server.close()` waits for them until the 30s force-timeout fires,
  // then kills the socket mid-handshake instead of flushing a clean 503.
  // In-flight argon2 ops are NOT interrupted; they complete normally.
  drainArgon2Queue();

  // Stop accepting new connections, wait up to 30s for in-flight requests
  if (server) {
    await new Promise<void>((resolve) => {
      const forceTimeout = setTimeout(() => {
        logger.warn('Forced shutdown after 30s timeout');
        resolve();
      }, 30_000);

      server.close(() => {
        clearTimeout(forceTimeout);
        resolve();
      });
    });
  }

  // Close pools and Redis
  await Promise.allSettled([
    closeHafPool(),
    closeAppPool(),
    disconnectRedis(),
  ]);

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
