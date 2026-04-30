import { PrivateKey } from '@hiveio/dhive';
import { config } from './config.js';
import { logger } from './logger.js';
import { getRedis, isRedisAvailable } from './redis.js';

interface EnvCheck {
  key: string;
  value: string;
  required: boolean;
  description: string;
}

/**
 * Validate that a posting-key WIF parses cleanly via `PrivateKey.fromString`.
 * Returns `null` for unset (preserves optional-key semantics) or a parsed value;
 * returns an error string naming the env var and the dhive error class otherwise.
 *
 * Why: the only realistic production trigger for `PrivateKey.fromString` rejecting
 * mid-request is a malformed configured key, which doesn't change at runtime. The
 * wrapper catch in `withOrcidBindingLock`'s acquired branch otherwise routes such
 * a sync throw as a 504 BROADCAST_TIMEOUT (`outcome:'uncertain'`, `verify_before_retry:true`),
 * paging broadcast-on-call when the actual root cause is admin-key configuration.
 * Failing boot loudly removes that mislabeled trigger from the request lifecycle.
 */
export function validatePostingKeyFormat(value: string, envVar: string): string | null {
  if (!value) return null;
  try {
    PrivateKey.fromString(value);
    return null;
  } catch (err) {
    const errClass = err instanceof Error ? err.constructor.name : 'Error';
    const errMsg = err instanceof Error ? err.message : String(err);
    return `${envVar} — invalid WIF format (${errClass}: ${errMsg})`;
  }
}

/**
 * Validate that a Hive account-name env var is non-blank and matches Hive's
 * account-name shape. Returns `null` for unset (preserves optional semantics
 * for callers passing empty strings) or for a valid name; returns an error
 * string otherwise.
 *
 * Why: empty/whitespace values for `HIVE_BRIDGE_ACCOUNT` (or the analogous
 * admin/onboard/anon vars) silently exclude all bridge papers via
 * `validPevoPaperWhere`'s author pin, with no boot-time signal. The same
 * defect class applies to any author-pinned query: a blank account name
 * yields a query that matches nothing, but produces no error. Validate at
 * boot so a deploy-time misconfiguration fails loudly.
 *
 * Regex matches `backend/src/routes/anonymousReview.ts:147` precedent
 * (`^[a-z][a-z0-9.-]{2,15}$`): lowercase start, 3-16 chars total, lowercase
 * alphanumeric + dots + hyphens. Whitespace-only input fails the regex
 * (leading space ≠ lowercase letter); the explicit `.trim()` guard below
 * is belt-and-suspenders so the error message is recognizable.
 */
export function validateAccountNameFormat(value: string, envVar: string): string | null {
  if (!value) return null;
  if (!value.trim()) {
    return `${envVar} — empty or whitespace-only value (a blank account name silently excludes all matching content from author-pinned queries)`;
  }
  if (!/^[a-z][a-z0-9.-]{2,15}$/.test(value)) {
    return `${envVar} — invalid Hive account-name format (must match /^[a-z][a-z0-9.-]{2,15}$/, got: ${JSON.stringify(value)})`;
  }
  return null;
}

export function validateConfig(): void {
  const checks: EnvCheck[] = [
    { key: 'HAF_DATABASE_URL', value: config.hafDatabaseUrls.join(','), required: true, description: 'HAF SQL (comma-separated for failover)' },
    { key: 'APP_DATABASE_URL', value: config.appDatabaseUrl, required: false, description: 'App database (tokens, mappings)' },
    { key: 'PEVO_ADMIN_POSTING_KEY', value: config.pevoAdminPostingKey, required: false, description: `Posting key for admin account (${config.hiveAdminAccount}) — accreditation & bridge posting disabled without it` },
    { key: 'PEVO_ANON_POSTING_KEY', value: config.pevoAnonPostingKey, required: false, description: `Posting key for anon account (${config.hiveAnonAccount}) — anonymous reviews disabled without it` },
    { key: 'ANON_REVIEW_ENCRYPTION_KEY', value: config.anonReviewEncryptionKey, required: false, description: 'Anonymous review encryption — anonymous reviews disabled without it' },
    { key: 'SMTP_HOST', value: config.smtpHost, required: false, description: 'Email verification' },
  ];

  const missing: string[] = [];
  const warnings: string[] = [];

  for (const check of checks) {
    if (!check.value) {
      if (check.required) {
        missing.push(`  ${check.key} — ${check.description}`);
      } else {
        warnings.push(`  ${check.key} — ${check.description} (feature disabled)`);
      }
    }
  }

  // Validate encryption key format if present
  if (config.anonReviewEncryptionKey) {
    if (!/^[0-9a-f]{64}$/i.test(config.anonReviewEncryptionKey)) {
      missing.push('  ANON_REVIEW_ENCRYPTION_KEY — must be 64 hex characters (256-bit key)');
    }
  }

  // Validate previous encryption key format if present (for key rotation)
  if (config.anonReviewEncryptionKeyPrev) {
    if (!/^[0-9a-f]{64}$/i.test(config.anonReviewEncryptionKeyPrev)) {
      missing.push('  ANON_REVIEW_ENCRYPTION_KEY_PREV — must be 64 hex characters (256-bit key)');
    }
  }

  // Validate posting-key WIF format if present. All three keys are optional (resolveBridgePostingKey
  // already covers the bridge≠admin presence error; admin/anon-disabled features degrade gracefully);
  // a malformed value, however, must fail boot so a runtime PrivateKey.fromString throw never reaches
  // the request lifecycle. Coverage map (verified via `grep -rn "PrivateKey\.fromString(config"`):
  //   - PEVO_ADMIN_POSTING_KEY  (orcid, accreditation, papers, claims, signup-verify, wot)
  //   - PEVO_BRIDGE_POSTING_KEY (bridge, claims)
  //   - PEVO_ANON_POSTING_KEY   (anonymousReview)
  const adminKeyError = validatePostingKeyFormat(config.pevoAdminPostingKey, 'PEVO_ADMIN_POSTING_KEY');
  if (adminKeyError) missing.push(`  ${adminKeyError}`);
  const bridgeKeyError = validatePostingKeyFormat(config.pevoBridgePostingKey, 'PEVO_BRIDGE_POSTING_KEY');
  if (bridgeKeyError) missing.push(`  ${bridgeKeyError}`);
  const anonKeyError = validatePostingKeyFormat(config.pevoAnonPostingKey, 'PEVO_ANON_POSTING_KEY');
  if (anonKeyError) missing.push(`  ${anonKeyError}`);

  // Validate Hive account-name env vars. Empty/whitespace values silently exclude all
  // author-pinned content (e.g. `validPevoPaperWhere` pins on hiveBridgeAccount); malformed
  // values would similarly mismatch on every chain query. All four vars have defaults in
  // config.ts so the resolved values are never undefined, but a deploy-time misconfiguration
  // (`HIVE_BRIDGE_ACCOUNT='   '`) survives the `||` fallback and reaches the resolved config.
  // Validate resolved values rather than `process.env.*` so the check covers the actual values
  // used by queries.
  const accountChecks: Array<{ value: string; envVar: string }> = [
    { value: config.hiveAdminAccount, envVar: 'HIVE_ADMIN_ACCOUNT' },
    { value: config.hiveBridgeAccount, envVar: 'HIVE_BRIDGE_ACCOUNT' },
    { value: config.hiveOnboardAccount, envVar: 'HIVE_ONBOARD_ACCOUNT' },
    { value: config.hiveAnonAccount, envVar: 'HIVE_ANON_ACCOUNT' },
  ];
  for (const { value, envVar } of accountChecks) {
    const err = validateAccountNameFormat(value, envVar);
    if (err) missing.push(`  ${err}`);
  }

  // In production, APP_URL should be explicitly set (not the default localhost)
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && (!config.appUrl || config.appUrl === 'http://localhost:3000')) {
    warnings.push('  APP_URL — should be set to the real frontend URL in production');
  }

  if (warnings.length > 0) {
    logger.warn('Optional config not set:\n' + warnings.join('\n'));
  }

  if (missing.length > 0) {
    logger.error('Required config missing:\n' + missing.join('\n'));
    process.exit(1);
  }
}

/**
 * Warn loudly when the ORCID in-memory fallbacks would be active in a multi-
 * process deployment. The OAuth state map (`orcidStates`) and nonce map
 * (`orcidVerified`) live on a single Node process when Redis is unavailable.
 * Under PM2/cluster/k8s-replicas, the /start request and the /callback request
 * can land on different workers, so a user who started the flow would see
 * "invalid state" on callback. This check runs asynchronously a few seconds
 * after boot, giving the lazy Redis client time to connect before we judge it.
 */
export function checkOrcidProcessSafety(): void {
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) return;

  // Touch the client so the lazy-connect path fires, then give it a moment.
  getRedis();
  setTimeout(() => {
    if (!isRedisAvailable()) {
      logger.error(
        { component: 'orcid' },
        'Redis is not available and NODE_ENV=production — ORCID OAuth state falls back to an in-memory map that is NOT shared across workers. ' +
        'Multi-process deployments (PM2 cluster mode, k8s replicas, any load balancer in front of multiple Node instances) WILL break the /start → /callback handoff: ' +
        'a callback landing on a different worker than the one that handled /start sees "Invalid or expired state parameter". ' +
        'Provision Redis (set REDIS_URL) before serving production traffic, or run a single process.',
      );
    }
  }, 5000);
}
