import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { getPool, isHafAvailable } from './db.js';
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
import { getArgon2QueueDepth, getArgon2InFlight } from './lib/argon2-semaphore.js';
import signupVerifyRouter from './routes/signup-verify.js';
import custodyRouter from './routes/custody.js';
import contactRouter from './routes/contact.js';
import blogRouter from './routes/blog.js';
import accountsRouter from './routes/accounts.js';
import settingsRouter from './routes/settings.js';
import claimsRouter from './routes/claims.js';
import orcidRouter from './routes/orcid.js';

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
  const pevoConfig: Record<string, string | number> = {};
  if (config.appTag) pevoConfig.appTag = config.appTag;
  if (config.appVersion) pevoConfig.appVersion = config.appVersion;
  if (config.discordUrl) pevoConfig.discordUrl = config.discordUrl;
  if (config.githubUrl) pevoConfig.githubUrl = config.githubUrl;
  pevoConfig.maxUploadSize = config.maxUploadSize;
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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Hive-Username', 'X-Hive-Signature', 'X-Hive-Timestamp'],
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
  app.use('/api/papers/:author/:permlink/claims', claimsRouter);
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
  app.use('/api/auth', signupVerifyRouter);
  app.use('/api/custody', custodyRouter);
  app.use('/api/bridge', bridgeRouter);
  app.use('/api/contact', contactRouter);
  app.use('/api/accounts', readLimiter, accountsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/orcid', orcidRouter);
  app.use('/api/blog', readLimiter, blogRouter);

  // Health check. Exposes argon2 semaphore saturation synchronously so
  // operators see the backend-argon2-jslevel-concurrency-cap counter
  // without depending on pino async-transport drainage under OOM. A
  // non-zero `argon2_queue_depth` on a healthy production instance
  // indicates the auth-path semaphore is saturated (expected under
  // bursty login/signup traffic; sustained >0 is a load signal).
  //
  // Rate-limited via the shared readLimiter to prevent unauthenticated
  // high-resolution polling of argon2 saturation state, which would
  // otherwise give an attacker real-time feedback for tuning a DoS against
  // the semaphore queue. The static cap (MAX_CONCURRENT_ARGON2_OPS) is
  // deliberately NOT exposed — it's a fixed deployment constant with no
  // live-operator value, and publishing it narrows the search space for
  // queue-DoS reconnaissance.
  app.get('/api/health', readLimiter, (_req, res) => {
    res.json({
      status: 'ok',
      haf_available: isHafAvailable(),
      redis_available: isRedisAvailable(),
      argon2_queue_depth: getArgon2QueueDepth(),
      argon2_in_flight: getArgon2InFlight(),
      timestamp: new Date().toISOString(),
    });
  });

  // ── robots.txt ─────────────────────────────────────────────────
  app.get('/robots.txt', (_req, res) => {
    const baseUrl = config.appUrl.replace(/\/$/, '');
    res.type('text/plain').send(
      `User-agent: *\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`,
    );
  });

  // ── sitemap.xml ───────────────────────────────────────────────
  const staticPaths = ['/', '/papers', '/about', '/faq', '/getting-started', '/contact', '/researchers', '/stats', '/search', '/accreditation', '/bridge', '/publish', '/blog'];

  app.get('/sitemap.xml', async (_req, res) => {
    const baseUrl = config.appUrl.replace(/\/$/, '');
    const urls: string[] = [];

    // Build hreflang alternates for a given path (without locale)
    const hreflangLinks = (path: string) =>
      SUPPORTED_LOCALES_ARR.map(
        loc => `    <xhtml:link rel="alternate" hreflang="${loc}" href="${escHtml(baseUrl)}/${loc}${path}" />`,
      ).concat(
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${escHtml(baseUrl)}/en${path}" />`,
      ).join('\n');

    const url = (path: string, freq: string, priority: string, lastmod?: string) => {
      let entry = `  <url>\n    <loc>${escHtml(baseUrl)}/en${path}</loc>\n    <changefreq>${freq}</changefreq>\n    <priority>${priority}</priority>`;
      if (lastmod) entry += `\n    <lastmod>${lastmod}</lastmod>`;
      entry += `\n${hreflangLinks(path)}`;
      return entry + '\n  </url>';
    };

    // Static pages
    for (const p of staticPaths) {
      urls.push(url(p, p === '/' || p === '/papers' ? 'daily' : 'monthly', p === '/' ? '1.0' : '0.5'));
    }

    // Dynamic paper pages from HAF
    try {
      const pool = getPool();
      if (pool) {
        const { rows } = await pool.query<{ author: string; permlink: string; updated: string }>(
          `SELECT c.author, c.permlink, c.last_update::date::text AS updated
           FROM hive.comments_view c
           WHERE c.parent_author = '' AND c.parent_permlink = $1
             AND c.json_metadata ->> 'app' LIKE $2
             AND (c.json_metadata -> $1 ->> 'type') IN ('paper', 'bridge_paper')
           ORDER BY c.last_update DESC
           LIMIT 5000`,
          [config.appTag, `${config.appTag}/%`],
        );
        for (const r of rows) {
          urls.push(url(`/paper/${r.author}/${r.permlink}`, 'weekly', '0.8', r.updated));
        }
      }
    } catch {
      // Serve sitemap with static pages only if HAF is unavailable
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>`;
    res.type('application/xml').send(xml);
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

  // ── SEO meta injection ──────────────────────────────────────────
  const paperRouteRe = /^\/([a-z]{2})\/paper\/([^/]+)\/([^/]+)$/;
  const profileRouteRe = /^\/([a-z]{2})\/profile\/([^/]+)$/;
  const defaultTitle = 'PEvO - Open Scientific Publishing';
  const defaultDesc = 'Open scientific publication and interactive peer evaluation on a permanent, open record. Non-profit, transparent, forkable.';

  // Static page meta for SEO (title suffix " — PEvO" added automatically)
  const staticPageMeta: Record<string, { title: string; desc: string }> = {
    '/about':           { title: 'About', desc: 'Learn how PEvO brings transparent, permanent scientific publishing and peer review to an open record.' },
    '/faq':             { title: 'FAQ', desc: 'Frequently asked questions about publishing, reviewing, and evaluating scientific work on PEvO.' },
    '/getting-started': { title: 'Getting Started', desc: 'How to set up your account, publish your first paper, and start reviewing on PEvO.' },
    '/contact':         { title: 'Contact', desc: 'Get in touch with the PEvO team for questions, feedback, or collaboration.' },
    '/papers':          { title: 'Papers', desc: 'Browse open-access scientific papers published and peer-reviewed on PEvO.' },
    '/search':          { title: 'Search', desc: 'Search scientific papers, authors, and reviews on PEvO.' },
    '/researchers':     { title: 'Researchers', desc: 'Explore accredited researchers and their contributions on PEvO.' },
    '/stats':           { title: 'Statistics', desc: 'Platform statistics: papers published, reviews submitted, and researcher activity on PEvO.' },
    '/accreditation':   { title: 'Accreditation', desc: 'Verify your researcher identity to participate in peer review on PEvO.' },
    '/bridge':          { title: 'Bridge', desc: 'Import and discuss existing scientific papers from external sources on PEvO.' },
    '/publish':         { title: 'Publish', desc: 'Submit your scientific paper for open peer review on PEvO.' },
  };

  // ── Locale routing ───────────────────────────────────────────────
  const SUPPORTED_LOCALES = new Set(['ar', 'cs', 'da', 'de', 'en', 'es', 'fa', 'fr', 'he', 'it', 'nl', 'pl', 'pt', 'sv', 'tr', 'zh']);
  const SUPPORTED_LOCALES_ARR = [...SUPPORTED_LOCALES];
  // Paths that must never get a locale redirect
  const NO_LOCALE_PREFIXES = new Set(['api', 'assets', 'messages']);
  const NO_LOCALE_FILES = new Set(['robots.txt', 'sitemap.xml', 'favicon.ico']);

  function detectLocale(req: express.Request): string {
    // 1. Cookie
    const cookie = req.cookies?.PEVO_LOCALE || parseCookie(req.headers.cookie, 'PEVO_LOCALE');
    if (cookie && SUPPORTED_LOCALES.has(cookie)) return cookie;
    // 2. Accept-Language header
    const accept = req.get('accept-language');
    if (accept) {
      const langs = accept
        .split(',')
        .map(part => {
          const [lang, qPart] = part.trim().split(';');
          const q = qPart ? parseFloat(qPart.replace('q=', '')) : 1;
          return { code: lang.trim().slice(0, 2).toLowerCase(), q };
        })
        .sort((a, b) => b.q - a.q);
      for (const l of langs) {
        if (SUPPORTED_LOCALES.has(l.code)) return l.code;
      }
    }
    // 3. Fallback
    return 'en';
  }

  function parseCookie(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : undefined;
  }

  function buildHreflangTags(path: string): string {
    const baseUrl = config.appUrl.replace(/\/$/, '');
    const tags = SUPPORTED_LOCALES_ARR.map(
      loc => `<link rel="alternate" hreflang="${loc}" href="${baseUrl}/${loc}${path}" />`,
    );
    tags.push(`<link rel="alternate" hreflang="x-default" href="${baseUrl}/en${path}" />`);
    return tags.join('\n  ');
  }

  const botUaRe = /bot|crawl|spider|slurp|facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegram|discord|preview|fetch|gptbot|chatgpt|claude|anthropic|perplexity|cohere|bingpreview|google-extended/i;

  async function injectPaperMeta(html: string, author: string, permlink: string, reqUrl: string, isBot: boolean, pathWithoutLocale: string, locale: string): Promise<string> {
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
      reqUrl ? `<link rel="canonical" href="${escAttr(reqUrl)}" />` : '',
    ].filter(Boolean).join('\n  ');

    // JSON-LD structured data for scholarly articles
    const pevoMeta = (meta[config.appTag] || {}) as Record<string, unknown>;
    const jsonLd: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'ScholarlyArticle',
      headline: title,
      description: desc,
      author: { '@type': 'Person', name: author },
      datePublished: (post.created as string || '').split('T')[0],
      dateModified: (post.last_update as string || '').split('T')[0],
      publisher: { '@type': 'Organization', name: 'PEvO', url: config.appUrl },
    };
    if (reqUrl) jsonLd.url = reqUrl;
    if (pevoMeta.discipline) jsonLd.about = pevoMeta.discipline;
    if (Array.isArray(pevoMeta.keywords) && pevoMeta.keywords.length) jsonLd.keywords = pevoMeta.keywords;

    const baseUrl = config.appUrl.replace(/\/$/, '');
    const breadcrumb = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Papers', item: `${baseUrl}/${locale}/papers` },
        { '@type': 'ListItem', position: 2, name: title },
      ],
    };
    const jsonLdScript = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>\n  <script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>`;

    const hreflangTags = buildHreflangTags(pathWithoutLocale);

    let result = html
      .replace(`<title>${defaultTitle}</title>`, `<title>${escHtml(title)} — PEvO</title>`)
      .replace(
        `<meta name="description" content="${defaultDesc}" />`,
        `<meta name="description" content="${escAttr(desc)}" />\n  ${ogTags}\n  ${jsonLdScript}\n  ${hreflangTags}`,
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
  app.get('{*splat}', async (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return next();
    }
    if (!indexHtml) return next();

    // ── Locale extraction (L6) ────────────────────────────────────
    const segments = req.path.replace(/^\//, '').split('/');
    const firstSeg = segments[0]?.toLowerCase() || '';

    // Skip locale logic for static files and special routes
    if (NO_LOCALE_PREFIXES.has(firstSeg) || NO_LOCALE_FILES.has(firstSeg)) {
      return next();
    }

    let locale: string;
    let pathWithoutLocale: string; // path with locale stripped, e.g. /paper/alice/foo

    if (SUPPORTED_LOCALES.has(firstSeg)) {
      locale = firstSeg;
      pathWithoutLocale = '/' + segments.slice(1).join('/') || '/';
    } else {
      // Bare path — 302 redirect to locale-prefixed version
      const detected = detectLocale(req);
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(302, `/${detected}${req.path}${qs}`);
    }

    // ── SEO meta injection (L7) ───────────────────────────────────
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const hreflangTags = buildHreflangTags(pathWithoutLocale);

    // Inject paper-specific meta tags for SEO / link previews
    const paperMatch = req.path.match(paperRouteRe);
    if (paperMatch && SUPPORTED_LOCALES.has(paperMatch[1])) {
      try {
        const isBot = botUaRe.test(req.get('user-agent') || '');
        const html = await injectPaperMeta(indexHtml, paperMatch[2], paperMatch[3], fullUrl, isBot, pathWithoutLocale, locale);
        return res.type('html').send(html);
      } catch {
        // Fall through to generic HTML on any error
      }
    }

    // Inject meta for profile pages
    const profileMatch = req.path.match(profileRouteRe);
    if (profileMatch && SUPPORTED_LOCALES.has(profileMatch[1])) {
      try {
        const username = decodeURIComponent(profileMatch[2]);
        const pageTitle = `${username} — PEvO`;
        const desc = `Researcher profile for ${username} on PEvO — publications, reviews, and reputation.`;
        const ogTags = [
          `<meta property="og:title" content="${escAttr(pageTitle)}" />`,
          `<meta property="og:description" content="${escAttr(desc)}" />`,
          `<meta property="og:type" content="profile" />`,
          `<meta property="og:url" content="${escAttr(fullUrl)}" />`,
          `<meta name="twitter:card" content="summary" />`,
          `<link rel="canonical" href="${escAttr(fullUrl)}" />`,
        ].join('\n  ');

        const personLd = {
          '@context': 'https://schema.org',
          '@type': 'Person',
          name: username,
          url: fullUrl,
        };
        const personLdScript = `<script type="application/ld+json">${JSON.stringify(personLd)}</script>`;

        const html = indexHtml
          .replace(`<title>${defaultTitle}</title>`, `<title>${escHtml(pageTitle)}</title>`)
          .replace(
            `<meta name="description" content="${defaultDesc}" />`,
            `<meta name="description" content="${escAttr(desc)}" />\n  ${ogTags}\n  ${personLdScript}\n  ${hreflangTags}`,
          );
        return res.type('html').send(html);
      } catch {
        // Fall through to generic HTML
      }
    }

    // Inject title + meta for static pages (lookup by path without locale)
    const pageMeta = staticPageMeta[pathWithoutLocale];
    if (pageMeta) {
      const pageTitle = `${pageMeta.title} — PEvO`;
      const ogTags = [
        `<meta property="og:title" content="${escAttr(pageTitle)}" />`,
        `<meta property="og:description" content="${escAttr(pageMeta.desc)}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:url" content="${escAttr(fullUrl)}" />`,
        `<meta name="twitter:card" content="summary" />`,
        `<link rel="canonical" href="${escAttr(fullUrl)}" />`,
      ].join('\n  ');

      const html = indexHtml
        .replace(`<title>${defaultTitle}</title>`, `<title>${escHtml(pageTitle)}</title>`)
        .replace(
          `<meta name="description" content="${defaultDesc}" />`,
          `<meta name="description" content="${escAttr(pageMeta.desc)}" />\n  ${ogTags}\n  ${hreflangTags}`,
        );
      return res.type('html').send(html);
    }

    // Generic page — still inject hreflang
    const html = indexHtml.replace('</head>', `  ${hreflangTags}\n</head>`);
    res.type('html').send(html);
  });

  // Error handler
  app.use(errorHandler);

  return app;
}
