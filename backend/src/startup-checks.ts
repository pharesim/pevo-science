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

  // Validate posting-key WIF format if present. Both keys are optional (resolveBridgePostingKey
  // already covers the bridge≠admin presence error); a malformed value, however, must fail
  // boot so a runtime PrivateKey.fromString throw never reaches the request lifecycle.
  const adminKeyError = validatePostingKeyFormat(config.pevoAdminPostingKey, 'PEVO_ADMIN_POSTING_KEY');
  if (adminKeyError) missing.push(`  ${adminKeyError}`);
  const bridgeKeyError = validatePostingKeyFormat(config.pevoBridgePostingKey, 'PEVO_BRIDGE_POSTING_KEY');
  if (bridgeKeyError) missing.push(`  ${bridgeKeyError}`);

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
