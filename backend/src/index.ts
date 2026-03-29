import { config } from './config.js';
import { isHafAvailable, closeHafPool } from './db.js';
import { initAppDb, closeAppPool } from './app-db.js';
import { createApp } from './app.js';
import { validateConfig } from './startup-checks.js';
import { startBlockWatcher, stopBlockWatcher } from './block-watcher.js';
import { startDigestScheduler, stopDigestScheduler } from './digest.js';
import { disconnectRedis } from './redis.js';
import { checkHiveNodes } from './hive.js';
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
  .then(() => {
    server = app.listen(config.port, () => {
      logger.info({ port: config.port, haf: isHafAvailable(), appDb: !!config.appDatabaseUrl }, 'PEvO backend started');

      if (isHafAvailable()) {
        startBlockWatcher();
      }

      // Start email digest scheduler if SMTP is configured
      if (config.smtpHost) {
        startDigestScheduler();
      }

      // Non-blocking: check Hive API node connectivity at startup
      checkHiveNodes();
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
