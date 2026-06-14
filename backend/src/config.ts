
if (!process.env.APP_TAG) {
  throw new Error('APP_TAG must be set in .env');
}
if (!process.env.APP_VERSION) {
  throw new Error('APP_VERSION must be set in .env');
}

const appTag = process.env.APP_TAG;
const appVersion = process.env.APP_VERSION;

if (!/^[a-z][a-z0-9._-]*$/.test(appTag)) {
  throw new Error('APP_TAG must start with a letter and contain only lowercase alphanumeric, dots, hyphens, underscores');
}

const hiveAdminAccount = process.env.HIVE_ADMIN_ACCOUNT || 'pevo.admin';
const hiveBridgeAccount = process.env.HIVE_BRIDGE_ACCOUNT || hiveAdminAccount;

// Bridge posting key: use dedicated key if set, otherwise fall back to admin key
// when bridge account is the same as admin (avoids entering the same key twice)
function resolveBridgePostingKey(): string {
  const explicit = process.env.PEVO_BRIDGE_POSTING_KEY || '';
  if (explicit) return explicit;
  if (hiveBridgeAccount === hiveAdminAccount) return process.env.PEVO_ADMIN_POSTING_KEY || '';
  throw new Error(
    `HIVE_BRIDGE_ACCOUNT (${hiveBridgeAccount}) differs from HIVE_ADMIN_ACCOUNT (${hiveAdminAccount}) ` +
    `but PEVO_BRIDGE_POSTING_KEY is not set. Either set the key or use the same account.`
  );
}

/**
 * Parse the HAF_WALKER_WALL_CLOCK_MS env var into a positive millisecond
 * budget, falling back to 3000ms on any non-positive/non-finite input.
 *
 * Uses `Number(...)` rather than `parseInt(..., 10)` so that `'1e3'`
 * resolves to 1000 (not 1) and `'1.5'` resolves to 1.5 (not 1). The
 * fallback is triggered by:
 *
 *   - undefined env (unset): `Number(undefined) → NaN` → not finite
 *   - empty string: `Number('') → 0` → not > 0
 *   - non-numeric string (`'disabled'`, `'3000ms'`): `Number(...) → NaN` → not finite
 *   - literal `'0'`: `Number('0') → 0` → not > 0 (would produce
 *     `setTimeout(fn, 0)` immediate-fire, every request emits
 *     wall-clock-exceeded)
 *   - negative (`'-1'`): rejected by the `> 0` check (a negative budget
 *     coerces to `setTimeout(fn, 0)` immediate-fire per ECMAScript spec
 *     identical to the literal-0 hazard)
 *
 * Exported for unit-test coverage in tests/lib/haf-walker-budget-env-parse.test.ts;
 * the integration tests in tests/routes/canonical-root-walker.test.ts override
 * `config.hafWalkerWallClockMs` directly, bypassing this parse path.
 */
export function parseHafWalkerBudget(env: string | undefined): number {
  const parsed = Number(env);
  if (!Number.isFinite(parsed) || parsed <= 0) return 3000;
  return parsed;
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  hiveApiNodes: (process.env.HIVE_API_NODES || 'https://api.hive.blog,https://api.deathwing.me,https://anyx.io,https://api.openhive.network,https://rpc.mahdiyari.info,https://hive.atexoras.com:2096,https://api.c0ff33a.uk')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),
  hafDatabaseUrls: (() => {
    const raw = process.env.HAF_DATABASE_URL || '';
    const urls = raw.split(',').map(u => u.trim()).filter(Boolean);
    if (urls.length === 0) {
      throw new Error('HAF_DATABASE_URL must be set (comma-separated for multiple nodes)');
    }
    return urls;
  })(),
  appDatabaseUrl: process.env.APP_DATABASE_URL || '',
  ipfsApiUrl: process.env.IPFS_API_URL || 'http://ipfs:5001',
  ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL || 'http://ipfs:8080',
  maxUploadSize: parseInt(process.env.MAX_UPLOAD_SIZE || String(10 * 1024 * 1024), 10),
  pinataApiKey: process.env.PINATA_API_KEY || '',
  pinataSecretKey: process.env.PINATA_SECRET_KEY || '',
  pevoAnonPostingKey: process.env.PEVO_ANON_POSTING_KEY || '',
  pevoAdminPostingKey: process.env.PEVO_ADMIN_POSTING_KEY || '',
  pevoBridgePostingKey: resolveBridgePostingKey(),
  custodyEncryptionKey: process.env.CUSTODY_ENCRYPTION_KEY || '',
  hiveOnboardAccount: process.env.HIVE_ONBOARD_ACCOUNT || hiveAdminAccount,
  claimAccountTokens: (process.env.CLAIM_ACCOUNT_TOKENS || 'true').toLowerCase() !== 'false',
  anonReviewEncryptionKey: process.env.ANON_REVIEW_ENCRYPTION_KEY || '',
  anonReviewEncryptionKeyPrev: process.env.ANON_REVIEW_ENCRYPTION_KEY_PREV || '',
  anonReviewKeyVersion: parseInt(process.env.ANON_REVIEW_KEY_VERSION || '1', 10),
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || 'noreply@pevo.science',
  contactEmail: process.env.CONTACT_EMAIL || process.env.SMTP_FROM || 'support@pevo.science',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  redisUrl: process.env.REDIS_URL ||
    (process.env.REDIS_PASSWORD ? `redis://:${process.env.REDIS_PASSWORD}@redis:6379` : ''),
  orcidClientId: process.env.ORCID_CLIENT_ID || '',
  orcidClientSecret: process.env.ORCID_CLIENT_SECRET || '',
  orcidMinWorks: parseInt(process.env.ORCID_MIN_WORKS || '3', 10),
  // Per-token broadcast-attempt cap on /api/accreditation/verify. Bounds
  // retry amplification opened by the 504 BROADCAST_TIMEOUT envelope's 24h
  // token survival window. Counts only definitive 502 BROADCAST_FAILED
  // outcomes; timeout outcomes are compensated (decrement) so transient
  // slow-Hive windows don't destroy a verified token. Flippable without
  // redeploy so operators can tighten or relax during incident response.
  verifyBroadcastAttemptsCap: parseInt(process.env.VERIFY_BROADCAST_ATTEMPTS_CAP || '3', 10),
  // Drain interval (ms) for the in-process pending-decrement queue that
  // recovers DECR calls failed during a Redis flap on /api/accreditation/verify.
  // See `startDecrementQueueDrainer` in `lib/pending-decrement-queue.ts`.
  verifyDecrementQueueDrainMs: parseInt(process.env.VERIFY_DECREMENT_QUEUE_DRAIN_MS || '30000', 10),
  // Per-request wall-clock budget (ms) for the HAF chain walkers in
  // `routes/papers.ts` (`findCanonicalRoot` + `resolveContinuationChain` +
  // cascading helper calls). Bounds worker-thread starvation under
  // degraded HAF (genuine ops degradation OR attacker-induced via separate
  // vector) — the per-query `statement_timeout=30000ms` in `db.ts` is
  // multiplied by the walker hop caps (10 backward, 50 forward) for a
  // per-request worst-case of 10-25 minutes if no per-request budget exists.
  //
  // **Real worst-case per request = `hafWalkerWallClockMs` + `statement_timeout`.**
  // The AbortSignal stops NEW queries from starting; in-flight `pool.query`
  // calls continue until PostgreSQL's `statement_timeout` (30000ms) resolves
  // them — pg v8.x does NOT support `AbortSignal` in `pool.query` (verified
  // empirically against `node_modules/pg/lib/`). Operators tuning this knob
  // downward to "tighten the budget" should know the bound is the SUM of the
  // configured value and the per-query statement_timeout, not the configured
  // value alone. Still an 18-45× improvement over the pre-fix tail at the
  // 3000ms default, so the DoS-amplifier closure is meaningfully achieved.
  //
  // Default 3000ms derivation: typical HAF response 50-200ms × expected
  // 10-15-query depth = 500-3000ms. Anything beyond is degraded HAF.
  // Operators can tune via env. See
  // `verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md`.
  //
  // Parse is delegated to `parseHafWalkerBudget` (above). The helper uses
  // `Number(...)` + `Number.isFinite(...)` + `> 0` rather than `parseInt`
  // so that `'1e3'` resolves to 1000 (not 1) and `'1.5'` resolves to 1.5
  // (not 1). Every non-positive or non-finite input (undefined, empty,
  // `'disabled'`, `'0'`, `'-1'`) falls back to 3000. The `> 0` floor is
  // load-bearing: `setTimeout(fn, 0)` and `setTimeout(fn, NaN)` both
  // coerce to immediate-fire per ECMAScript spec — every paper-detail
  // request would emit wall-clock-exceeded and surface a retriable 503.
  hafWalkerWallClockMs: parseHafWalkerBudget(process.env.HAF_WALKER_WALL_CLOCK_MS),
  orcidBaseUrl: process.env.ORCID_BASE_URL || 'https://orcid.org',
  // Public works-API host (`countExternalWorks`), separate from the OAuth host
  // above: ORCID serves /oauth/* from orcid.org but the member/works API from
  // pub.orcid.org. Overridable so an E2E stub can serve the works endpoint
  // in-network (the fetch is server-side, unreachable by browser-level mocks).
  orcidApiBaseUrl: process.env.ORCID_API_BASE_URL || 'https://pub.orcid.org',
  accreditationAuthorities: (() => {
    const extra = (process.env.ACCREDITATION_AUTHORITIES || '').split(',').map(s => s.trim()).filter(Boolean);
    return [hiveAdminAccount, ...extra];
  })(),

  sessionSecret: (() => {
    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error('SESSION_SECRET must be set');
    if (process.env.NODE_ENV === 'production' && secret.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 characters in production');
    }
    return secret;
  })(),
  unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET || process.env.SESSION_SECRET || '',

  // App identity — configurable so alpha/testing uses different namespace
  hiveAdminAccount,
  hiveAnonAccount: process.env.HIVE_ANON_ACCOUNT || 'pevo.anon',
  hiveBridgeAccount,
  appTag,
  appVersion,
  appId: `${appTag}/${appVersion}`,

  // Blog
  blogAuthor: process.env.BLOG_AUTHOR || 'pevo.science',
  blogTag: process.env.BLOG_TAG || 'pevo-blog',

  // Public URLs (injected into frontend via __PEVO_CONFIG__)
  discordUrl: process.env.DISCORD_URL || '',
  githubUrl: process.env.GITHUB_URL || '',
};
