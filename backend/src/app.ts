import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { isHafAvailable } from './db.js';
import { isRedisAvailable } from './redis.js';
import { hiveClient } from './hive.js';
import { extractAbstract, parseMeta, isPevoAnyPaper } from './helpers.js';
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

  // Build inline config script content for CSP hash computation
  const pevoConfig: Record<string, string> = {};
  if (config.appTag) pevoConfig.appTag = config.appTag;
  if (config.appVersion) pevoConfig.appVersion = config.appVersion;
  if (config.discordUrl) pevoConfig.discordUrl = config.discordUrl;
  if (config.githubUrl) pevoConfig.githubUrl = config.githubUrl;
  // Only inject ipfsGateway if it's a public URL (not an internal Docker hostname).
  // When unset, the frontend falls back to /api/ipfs/ which proxies through the backend.
  if (config.ipfsGatewayUrl && /^https?:\/\/(?!ipfs[:/])/.test(config.ipfsGatewayUrl)) {
    pevoConfig.ipfsGateway = config.ipfsGatewayUrl;
  }
  const configScriptContent = `window.__PEVO_CONFIG__=${JSON.stringify(pevoConfig)};`;
  const configScriptHash = crypto.createHash('sha256').update(configScriptContent).digest('base64');

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-eval'", `'sha256-${configScriptHash}'`], // Alpine.js needs unsafe-eval; hash for inline config
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", ...config.hiveApiNodes, 'https://pubpeer.com'],
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
    origin: config.appUrl || false, // deny cross-origin by default; allow configured origin for external consumers
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

  // Inline config script tag (content + hash computed above for CSP)
  const configScript = `<script>${configScriptContent}</script>`;

  // Read index.html once and inject config before </head>
  const indexPath = path.join(publicDir, 'index.html');
  let indexHtml: string | null = null;
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    indexHtml = raw.replace('</head>', `${configScript}\n</head>`);
  } catch {
    // index.html not built yet — will 404 on requests
  }

  // ── SEO meta injection for paper pages ──────────────────────────
  const paperRouteRe = /^\/paper\/([^/]+)\/([^/]+)$/;
  const defaultTitle = 'PEvO - Open Scientific Publishing';
  const defaultDesc = 'Open scientific publication and interactive peer evaluation on a permanent, open record. Non-profit, transparent, forkable.';

  const botUaRe = /bot|crawl|spider|slurp|facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegram|discord|preview|fetch|gptbot|chatgpt|claude|anthropic|perplexity|cohere|bingpreview|google-extended/i;

  async function injectPaperMeta(html: string, author: string, permlink: string, reqUrl: string, isBot: boolean): Promise<string> {
    const post = await hiveClient.database.call('get_content', [author, permlink]);
    if (!post || !post.author || post.parent_permlink !== config.appTag) return html;

    const meta = parseMeta(post.json_metadata);
    if (!isPevoAnyPaper(meta)) return html;

    const title = (post.title as string) || defaultTitle;
    const body = post.body as string;
    const abstract = extractAbstract(body);
    const desc = abstract.slice(0, 200);

    const ogTags = [
      `<meta property="og:title" content="${escAttr(title)}" />`,
      `<meta property="og:description" content="${escAttr(desc)}" />`,
      `<meta property="og:type" content="article" />`,
      reqUrl ? `<meta property="og:url" content="${escAttr(reqUrl)}" />` : '',
      `<meta name="twitter:card" content="summary" />`,
    ].filter(Boolean).join('\n  ');

    let result = html
      .replace(`<title>${defaultTitle}</title>`, `<title>${escHtml(title)} — PEvO</title>`)
      .replace(
        `<meta name="description" content="${defaultDesc}" />`,
        `<meta name="description" content="${escAttr(desc)}" />\n  ${ogTags}`,
      );

    // For bots, inject the full body so they can index the content
    if (isBot) {
      const articleHtml = `<article style="display:none" id="seo-body"><h1>${escHtml(title)}</h1>${escHtml(body)}</article>`;
      result = result.replace('</body>', `${articleHtml}\n</body>`);
    }

    return result;
  }

  function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // SPA catch-all: serve index.html for any non-API GET request.
  // This enables client-side routing — the Alpine.js SPA handles its own routes.
  // API 404s are NOT intercepted; they fall through to the error handler.
  app.get('*', async (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return next();
    }
    if (!indexHtml) return next();

    // Inject paper-specific meta tags for SEO / link previews
    const paperMatch = req.path.match(paperRouteRe);
    if (paperMatch) {
      try {
        const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const isBot = botUaRe.test(req.get('user-agent') || '');
        const html = await injectPaperMeta(indexHtml, paperMatch[1], paperMatch[2], fullUrl, isBot);
        return res.type('html').send(html);
      } catch {
        // Fall through to generic HTML on any error
      }
    }

    res.type('html').send(indexHtml);
  });

  // Error handler
  app.use(errorHandler);

  return app;
}
