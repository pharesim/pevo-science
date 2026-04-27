import { config } from './config.js';
import { isHafAvailable, closeHafPool, getPool } from './db.js';
import { initAppDb, closeAppPool } from './app-db.js';
import { createApp } from './app.js';
import { validateConfig, checkOrcidProcessSafety } from './startup-checks.js';
import { startBlockWatcher, stopBlockWatcher } from './block-watcher.js';
import { startDigestScheduler, stopDigestScheduler } from './digest.js';
import { startIpfsCleanup, stopIpfsCleanup } from './ipfs-cleanup.js';
import { startBatchReputation, stopBatchReputation } from './reputation-batch.js';
import { disconnectRedis } from './redis.js';
import { checkHiveNodes } from './hive.js';
import { startRetractionCache } from './routes/papers.js';
import { startStatsCache } from './routes/stats.js';
import { getGenesisBlock } from './hafsql.js';
import { startActiveAuthorsCache, startReputationWeightsCache } from './reputation.js';
import { startWotThresholdCache } from './wot.js';
import { startAccountClaimer, stopAccountClaimer } from './account-creation.js';
import { startSignupCleanup, stopSignupCleanup } from './signup-cleanup.js';
import { drainArgon2Queue } from './lib/argon2-semaphore.js';
import { logger } from './logger.js';
import type { Server } from 'http';

// ── Uncaught error handlers ─────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection — shutting down');
  process.exit(1);
});

// ── Startup ─────────────────────────────────────────────────
validateConfig();

const app = createApp();
let server: Server;

initAppDb()
  .then(async () => {
    // Warm genesis block cache before accepting traffic
    const hafPool = getPool();
    if (hafPool) await getGenesisBlock(hafPool);

    // Start periodic cache refreshes before accepting traffic
    await startRetractionCache();

    server = app.listen(config.port, () => {
      // Warm expensive shared HAF caches in the background (non-blocking)
      Promise.all([
        startActiveAuthorsCache(),
        startReputationWeightsCache(),
        startWotThresholdCache(),
        startStatsCache(),
      ]).catch((err) => logger.warn({ err }, 'Background cache warmup failed'));
      logger.info({ port: config.port, haf: isHafAvailable(), appDb: !!config.appDatabaseUrl }, 'PEvO backend started');

      // Production-only: warn if Redis is unavailable, because ORCID OAuth
      // state then falls back to an in-memory map that is NOT multi-process safe.
      checkOrcidProcessSafety();

      if (isHafAvailable()) {
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

      // Start account creation token claimer (every 6h)
      startAccountClaimer();

      // Start pending signup cleanup (every 1h)
      startSignupCleanup();

      // Non-blocking: check Hive API node connectivity at startup
      void checkHiveNodes();
    });
  })
  .catch((err) => {
    logger.fatal({ err }, 'Failed to initialize app database');
    process.exit(1);
  });

// ── Graceful shutdown ───────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received — draining connections');

  stopBlockWatcher();
  stopDigestScheduler();
  stopIpfsCleanup();
  stopBatchReputation();
  stopAccountClaimer();
  stopSignupCleanup();

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
