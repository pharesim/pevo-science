import express from 'express';
import path from 'node:path';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { isHafAvailable } from './db.js';
import { isRedisAvailable } from './redis.js';
import { errorHandler } from './middleware/errorHandler.js';
import { httpLogger, requestContext } from './logger.js';
import { rateLimit, byIp } from './middleware/rateLimit.js';
import papersRouter from './routes/papers.js';
import reviewsRouter from './routes/reviews.js';
import profileRouter from './routes/profile.js';
import accreditationsRouter from './routes/accreditations.js';
import accreditationRouter from './routes/accreditation.js';
import ipfsRouter from './routes/ipfs.js';
import searchRouter from './routes/search.js';
import disciplinesRouter from './routes/disciplines.js';
import statsRouter from './routes/stats.js';
import anonymousReviewRouter from './routes/anonymousReview.js';
import commentsRouter from './routes/comments.js';
import wotRouter from './routes/wot.js';
import notificationsRouter from './routes/notifications.js';
import bridgeRouter from './routes/bridge.js';
import authRouter from './routes/auth.js';
import contactRouter from './routes/contact.js';

// ── Rate limiters (per API contract) ──────────────────────────────

const readLimiter = rateLimit({ name: 'read', windowMs: 60_000, max: 120, keyFn: byIp });
const searchLimiter = rateLimit({ name: 'search', windowMs: 60_000, max: 60, keyFn: byIp });
// Notification rate limit uses byIp at app level; per-account limiting happens
// inside the route after verifyHiveSignature sets req.hiveUsername.
const notificationLimiter = rateLimit({ name: 'notif', windowMs: 300_000, max: 30, keyFn: byIp });

export function createApp() {
  const app = express();

  // Trust first proxy (nginx, load balancer) for correct IP and protocol detection
  app.set('trust proxy', 1);

  // Response compression (gzip/br for responses > 1KB)
  app.use(compression({ threshold: 1024 }));

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-eval'"], // Alpine.js needs unsafe-eval for x-data expressions
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", ...config.hiveApiNodes],
        upgradeInsecureRequests: null, // HTTPS enforced by reverse proxy, not CSP
      },
    },
    crossOriginEmbedderPolicy: false, // Allow IPFS gateway embeds
  }));

  // Structured logging with request correlation IDs
  app.use(httpLogger);

  // Propagate request ID via AsyncLocalStorage for use in DB queries and Hive API calls
  app.use((req, _res, next) => {
    requestContext.run({ reqId: req.id as string }, next);
  });

  // CORS: frontend is same-origin (served from this process).
  // Keep CORS middleware for external API consumers only.
  app.use(cors({
    origin: config.appUrl || true, // same-origin by default; allow configured origin for external consumers
    credentials: true,
    maxAge: 86400,
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Hive-Username', 'X-Hive-Signature', 'X-Hive-Message', 'X-Hive-Timestamp'],
  }));
  app.use(express.json({ limit: '1mb' }));

  // Serve compiled frontend (Vite build output in backend/public/)
  const publicDir = path.join(__dirname, '../public');
  app.use(express.static(publicDir));

  // HTTPS is enforced by the reverse proxy, not the backend.

  // Routes with per-endpoint rate limits
  // NOTE: Authenticated rate limiters (byAccount) are applied AFTER verifyHiveSignature
  // in the route handlers to prevent header spoofing bypass. The rate limiter middleware
  // on POST routes here uses byIp as a first layer; the per-account limit is checked
  // inside the route after signature verification.
  app.use('/api/papers/:author/:permlink/comments', readLimiter, commentsRouter);
  app.use('/api/papers', readLimiter, papersRouter);
  app.use('/api/reviews', anonymousReviewRouter);
  app.use('/api/reviews', readLimiter, reviewsRouter);
  app.use('/api/profile', readLimiter, profileRouter);
  app.use('/api/accreditations', readLimiter, accreditationsRouter);
  app.use('/api/accreditation', accreditationRouter);
  app.use('/api/ipfs', ipfsRouter);
  app.use('/api/search', searchLimiter, searchRouter);
  app.use('/api/disciplines', readLimiter, disciplinesRouter);
  app.use('/api/stats', readLimiter, statsRouter);
  app.use('/api/wot', readLimiter, wotRouter);
  app.use('/api/notifications', notificationLimiter, notificationsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/bridge', bridgeRouter);
  app.use('/api/contact', contactRouter);

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      haf_available: isHafAvailable(),
      redis_available: isRedisAvailable(),
      timestamp: new Date().toISOString(),
    });
  });

  // SPA catch-all: serve index.html for any non-API GET request.
  // This enables client-side routing — the Alpine.js SPA handles its own routes.
  // API 404s are NOT intercepted; they fall through to the error handler.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return next();
    }
    res.sendFile(path.join(publicDir, 'index.html'), (err) => {
      if (err) next(); // index.html not found — fall through to error handler
    });
  });

  // Error handler
  app.use(errorHandler);

  return app;
}
