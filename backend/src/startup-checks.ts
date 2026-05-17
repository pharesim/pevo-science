import { PrivateKey } from '@hiveio/dhive';
import { config } from './config.js';
import { HIVE_ACCOUNT_NAME_REGEX } from './lib/hive-account-name.js';
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
 *
 * Whitespace-only carve-out (round-3 item 4): a copy-paste artifact like
 * `PEVO_ADMIN_POSTING_KEY=' '` would otherwise fall through to dhive's generic
 * `'Non-base58 character'` message, leading operators to misdiagnose copy-paste
 * artifacts as key corruption. Emit a recognizable "empty or whitespace-only"
 * message before dhive sees the bad input.
 */
export function validatePostingKeyFormat(value: string, envVar: string): string | null {
  if (!value) return null;
  if (!value.trim()) {
    return `${envVar} — empty or whitespace-only value (likely a copy-paste artifact; check the key was pasted without a leading/trailing space)`;
  }
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
 * canonical account-name shape. Returns `null` for unset (preserves optional
 * semantics for callers passing empty strings) or for a valid name; returns
 * an error string otherwise.
 *
 * Why: empty/whitespace values for `HIVE_BRIDGE_ACCOUNT` (or the analogous
 * admin/onboard/anon/blog-author vars) silently exclude all bridge papers
 * via `validPevoPaperWhere`'s author pin, with no boot-time signal. The same
 * defect class applies to any author-pinned query: a blank or canonically-
 * malformed account name yields a query that matches nothing, but produces
 * no error. Validate at boot so a deploy-time misconfiguration fails loudly.
 *
 * Round-3 (item 1): tightened from the legacy `/^[a-z][a-z0-9.-]{2,15}$/` to
 * Hive's canonical shape via the shared `HIVE_ACCOUNT_NAME_REGEX` constant.
 * The legacy regex accepted canonically-invalid names like `pevo.` (trailing
 * dot), `a..b` (consecutive dots), `a-bc-` (trailing hyphen), `.abc` (leading
 * dot) — all of which would survive boot and silently mismatch every chain
 * query, defeating this validator's stated purpose.
 *
 * The explicit `.trim()` guard below is belt-and-suspenders so whitespace-only
 * input gets a recognizable error message (the canonical regex would also
 * reject it, but the message would be less actionable).
 */
export function validateAccountNameFormat(value: string, envVar: string): string | null {
  if (!value) return null;
  if (!value.trim()) {
    return `${envVar} — empty or whitespace-only value (a blank account name silently excludes all matching content from author-pinned queries)`;
  }
  if (!HIVE_ACCOUNT_NAME_REGEX.test(value)) {
    return `${envVar} — invalid Hive account-name format (must match canonical Hive shape: dot-separated segments, each [a-z][a-z0-9-]*[a-z0-9] of length 3-16, overall ≤16 chars; got: ${JSON.stringify(value)})`;
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
  // the request lifecycle. Coverage: 3 distinct config keys (admin/bridge/anon); re-derive the
  // call-site map via `grep -rn "PrivateKey\.fromString(config" backend/src/`.
  const adminKeyError = validatePostingKeyFormat(config.pevoAdminPostingKey, 'PEVO_ADMIN_POSTING_KEY');
  if (adminKeyError) missing.push(`  ${adminKeyError}`);
  const bridgeKeyError = validatePostingKeyFormat(config.pevoBridgePostingKey, 'PEVO_BRIDGE_POSTING_KEY');
  if (bridgeKeyError) missing.push(`  ${bridgeKeyError}`);
  const anonKeyError = validatePostingKeyFormat(config.pevoAnonPostingKey, 'PEVO_ANON_POSTING_KEY');
  if (anonKeyError) missing.push(`  ${anonKeyError}`);

  // Validate Hive account-name env vars. Empty/whitespace values silently exclude all
  // author-pinned content (e.g. `validPevoPaperWhere` pins on hiveBridgeAccount, blog
  // routes pin on blogAuthor); malformed values would similarly mismatch on every chain
  // query. All vars below have defaults in config.ts so the resolved values are never
  // undefined, but a deploy-time misconfiguration (`HIVE_BRIDGE_ACCOUNT='   '`) survives
  // the `||` fallback and reaches the resolved config. Validate resolved values rather
  // than `process.env.*` so the check covers the actual values used by queries.
  // Coverage: 5 distinct config-sourced Hive account-name fields; re-derive the
  // consumer map via `grep -rn "config\.\w*Account\b\|config\.blogAuthor" backend/src/`.
  const accountChecks: Array<{ value: string; envVar: string }> = [
    { value: config.hiveAdminAccount, envVar: 'HIVE_ADMIN_ACCOUNT' },
    { value: config.hiveBridgeAccount, envVar: 'HIVE_BRIDGE_ACCOUNT' },
    { value: config.hiveOnboardAccount, envVar: 'HIVE_ONBOARD_ACCOUNT' },
    { value: config.hiveAnonAccount, envVar: 'HIVE_ANON_ACCOUNT' },
    { value: config.blogAuthor, envVar: 'BLOG_AUTHOR' },
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
    // Round-4 hold #1 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
    // log then THROW — do NOT call `logger.flush(() => process.exit(1))` here.
    // Returning after the round-3 flush-exit left the call stack intact:
    // `validateConfig()` returned synchronously to `index.ts`, and the
    // module-level `createApp()` / `initAppDb()` lines below it kept running
    // during the async flush window. Migrations would execute on a fatal-
    // misconfigured boot; `app.listen` could even bind. Throw a structured
    // `BootFatalError` so the call stack unwinds — `index.ts`'s top-level
    // boot wrapper catches it and routes through the single
    // `flushAndExit()` watchdog (flush + 2s setTimeout fallback so a
    // wedged transport doesn't hang the boot indefinitely).
    logger.error('Required config missing:\n' + missing.join('\n'));
    throw new BootFatalError('validateConfig: required configuration missing');
  }

  // After all string-format validations pass, parse the bridge posting key
  // ONCE at boot and cache the resulting `PrivateKey` instance. This serves
  // two purposes:
  //   (a) Catches any residual parse failure that the format validator might
  //       have missed (defense in depth — `validatePostingKeyFormat` already
  //       calls `PrivateKey.fromString`, so this is redundant in the happy
  //       path, but cheap insurance against future divergence).
  //   (b) Removes the per-request `PrivateKey.fromString` call site from the
  //       broadcast path. If a malformed WIF ever slipped past the format
  //       validator, the resulting AssertionError used to surface inside the
  //       broadcast try-catch (mis-classified as 502 BROADCAST_FAILED) AND
  //       leaked the WIF-derived `actual`/`expected` Buffer slices into
  //       operator logs (the `err` serializer redact policy in `logger.ts`
  //       now strips those, but eliminating the throw site is the better
  //       defense). Cached `PrivateKey` instances are immutable; reusing
  //       one across requests is safe.
  initBridgePostingKeyCache();
}

// ── Bridge posting key cache ───────────────────────────────
//
// Populated by `validateConfig()` at boot once the WIF format check passes,
// keyed by the WIF source string. The keying serves two purposes:
//   (a) Lets tests that override `config.pevoBridgePostingKey` (e.g., via
//       `vi.mock`) get a parsed `PrivateKey` matching the override on the
//       first request after the change, without requiring a manual cache
//       reset between tests.
//   (b) Catches the (vanishingly rare) case where production rotates the
//       WIF in-place; the cache invalidates on the next access.
// `null` when `pevoBridgePostingKey` is unset (production deployments
// without bridge custody enabled), per the existing optional-key semantics
// in `routes/bridge.ts:33` and `routes/claims.ts:203`.

interface BridgeKeyCacheEntry {
  source: string;
  parsed: PrivateKey;
}

let cachedBridgePostingKey: BridgeKeyCacheEntry | null = null;

function initBridgePostingKeyCache(): void {
  if (!config.pevoBridgePostingKey) {
    cachedBridgePostingKey = null;
    return;
  }
  try {
    cachedBridgePostingKey = {
      source: config.pevoBridgePostingKey,
      parsed: PrivateKey.fromString(config.pevoBridgePostingKey),
    };
  } catch (err) {
    // The format validator above runs `PrivateKey.fromString` on the same
    // value; a throw here means a defect in the validator (e.g., a future
    // dhive change widened the parse surface) rather than a genuine
    // misconfiguration. Log via the redact-policy logger so the
    // AssertionError's `actual`/`expected` Buffer slices DON'T reach
    // operator logs, then exit. Never log the WIF itself.
    // Round-3 hold #2 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
    // pino's destination transport is async by default; `process.exit(1)`
    // would otherwise tear down the runtime before the buffered fatal line
    // drains. Flush before exit so the boot-fatal log is observable to
    // operators.
    // Round-4 hold #1 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
    // log fatal then THROW — do NOT call `logger.flush(() => process.exit(1))`
    // here. The round-3 flush-exit at this site left the call stack intact:
    // `initBridgePostingKeyCache()` returned synchronously to
    // `validateConfig()`, which returned synchronously to `index.ts`,
    // and the module-level `createApp()` / `initAppDb()` lines below kept
    // running during the async flush window (migrations would execute on a
    // fatal-misconfigured boot; `app.listen` could even bind). Throw a
    // structured `BootFatalError` so the call stack unwinds — `index.ts`'s
    // top-level boot wrapper catches it and routes through the single
    // `flushAndExit()` watchdog (flush + 2s setTimeout fallback so a
    // wedged transport doesn't hang the boot indefinitely).
    logger.fatal(
      { err, envVar: 'PEVO_BRIDGE_POSTING_KEY' },
      'Bridge posting key parse failed at boot — refusing to start. ' +
      'The format validator passed but PrivateKey.fromString threw; ' +
      'this indicates a validator/dhive divergence. Investigate before deploying.',
    );
    throw new BootFatalError('initBridgePostingKeyCache: parse divergence');
  }
}

/**
 * Round-4 hold #1 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
 * structured boot-fatal sentinel. Thrown by `validateConfig()` /
 * `initBridgePostingKeyCache()` after a fatal log so the call stack unwinds
 * to the top-level boot wrapper in `index.ts`. The wrapper catches it and
 * routes through the single `flushAndExit()` watchdog (flush + 2s timer
 * fallback) so the boot-fatal log line drains before exit AND so a wedged
 * pino transport cannot hang the boot indefinitely.
 *
 * Why a dedicated subclass: identifies "expected boot-fatal we already
 * logged about" vs. "unexpected throw we still need to log" at the catch
 * site. The wrapper logs once for unexpected throws, NOT for `BootFatalError`
 * (the boot-fatal sites already logged the user-actionable detail before
 * throwing — re-logging would be noise).
 *
 * Accepts `ErrorOptions` so re-throw sites can pass `{cause: err}` to
 * preserve the underlying error chain (ES2022 native; pino's err serializer
 * walks `.cause` recursively). Existing call sites that pass only a message
 * continue to work unchanged (`options` is optional and forwarded directly
 * to `super`). Other existing boot-fatal sites (`validateConfig`,
 * `initBridgePostingKeyCache`) currently throw without a cause; adopting
 * the `{cause: err}` form there is a separate refactor.
 */
export class BootFatalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BootFatalError';
  }
}

/**
 * Returns the parsed bridge posting key (cached at boot), or `null` when
 * `PEVO_BRIDGE_POSTING_KEY` is unset.
 *
 * Once boot succeeds AND `config.pevoBridgePostingKey` is not mutated
 * post-boot, this accessor returns the cached `PrivateKey` without
 * re-parsing. The lazy-fallback path below (cache miss + key configured)
 * is a test-and-rotation-only branch; production paths reach it only
 * post-validator (the validator at `validateConfig()` runs before any
 * request-handling code, populating the cache).
 *
 * All production bridge-WIF call sites in `routes/` MUST NOT call
 * `PrivateKey.fromString(config.pevoBridgePostingKey)` directly — use this
 * accessor (or `getRequiredBridgePostingKey()` when null is unacceptable)
 * instead. As of BACKEND-BRIDGE-KEY-CLAIMS-ROUTE-MIGRATION (commit
 * `83c6a28`), this covers both `routes/bridge.ts` and `routes/claims.ts`.
 * Two reasons:
 *   1. The parse result is immutable; recomputing it per request is waste.
 *   2. The parse path can throw `AssertionError` whose `.actual`/`.expected`
 *      Buffer slices are derived from the WIF; even with the redact policy
 *      in `logger.ts` stripping them post-hoc, eliminating the throw site
 *      is the stronger guarantee. The startup validator above is the
 *      single throw site for production bridge-WIF callers; once boot
 *      succeeds, no request-time call to `PrivateKey.fromString` on this
 *      key from `routes/bridge.ts` or `routes/claims.ts` is reachable.
 *      Re-derive the call-site map via
 *      `grep -rn "PrivateKey\.fromString(config.pevoBridgePostingKey" backend/src/routes/`
 *      — the expected hit count is zero.
 *
 * Cache miss + key configured: parses lazily, then caches. This keeps the
 * accessor safe to call before `validateConfig()` has run (test harnesses
 * that bypass startup validation, scripts that import bridge.ts, etc.).
 *
 * BACKEND-BRIDGE-KEY-LAZY-FALLBACK-THROW-SITE-CLOSURE (approach 2,
 * behavior-preserving): the lazy parse below is wrapped in try/catch.
 * Successful parses populate the cache as before; failed parses throw
 * `BridgeKeyLazyParseDivergence` (a sanitized sibling of
 * `BridgeKeyCacheUnpopulated`) instead of letting dhive's raw
 * `AssertionError` (with WIF-derived `.actual`/`.expected` Buffer slices)
 * escape. The redact policy in `logger.ts` is the existing post-hoc
 * mitigation; this catch-and-rewrap is the structural defense-in-depth
 * complement so the AssertionError surface never reaches a logger from
 * THIS site even if the redact policy were ever reverted.
 */
export function getCachedBridgePostingKey(): PrivateKey | null {
  const source = config.pevoBridgePostingKey;
  if (!source) {
    cachedBridgePostingKey = null;
    return null;
  }
  if (cachedBridgePostingKey && cachedBridgePostingKey.source === source) {
    return cachedBridgePostingKey.parsed;
  }
  // Source changed (test override, in-place rotation) or cache is unset.
  // Parse lazily. The try/catch is the throw-site-closure for the lazy
  // fallback (BACKEND-BRIDGE-KEY-LAZY-FALLBACK-THROW-SITE-CLOSURE,
  // approach 2): on parse failure, re-throw a structured, redact-safe
  // sibling error (`BridgeKeyLazyParseDivergence`) WITHOUT the dhive
  // AssertionError's `.actual`/`.expected` properties (which carry
  // WIF-derived Buffer slices). Successful parses populate the cache and
  // return as before — behavior preserving for the existing
  // lazy-fallback / in-place-rotation tests.
  let parsed: PrivateKey;
  try {
    parsed = PrivateKey.fromString(source);
  } catch {
    // Intentionally swallow the raw error: its shape (an AssertionError
    // with `.actual`/`.expected` Buffer slices DERIVED from the WIF) is
    // exactly the leak surface this rewrap closes. Pass NOTHING from the
    // caught error to the new error — no message interpolation, no
    // `cause` linkage. Operators distinguish this divergence from the
    // null-cache case via the distinct error class name; the format
    // validator's boot-time fatal log is the operator-actionable trigger
    // (this throw is the request-lifecycle backstop).
    throw new BridgeKeyLazyParseDivergence();
  }
  cachedBridgePostingKey = { source, parsed };
  return cachedBridgePostingKey.parsed;
}

/**
 * Structured error class thrown by {@link getRequiredBridgePostingKey} when
 * the cache is unpopulated. Subclassing keeps `err.constructor.name`
 * (which the redact serializer in `logger.ts` projects into the output's
 * `type` field) deterministic. Operator alerts and log greps can key on
 * `err.type === 'BridgeKeyCacheUnpopulated'` from the redacted payload.
 *
 * Round-3 hold #6 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT).
 */
export class BridgeKeyCacheUnpopulated extends Error {
  constructor(message?: string) {
    super(message ?? (
      'Bridge posting key cache is unpopulated. ' +
      'Either PEVO_BRIDGE_POSTING_KEY is unset, or boot validation was bypassed in this context.'
    ));
    this.name = 'BridgeKeyCacheUnpopulated';
  }
}

/**
 * Structured error class thrown by the lazy-fallback path of
 * {@link getCachedBridgePostingKey} when `PrivateKey.fromString(source)`
 * rejects the configured WIF at request time.
 *
 * Why a dedicated subclass: dhive's raw failure mode here is
 * `AssertionError` whose `.actual`/`.expected` are Buffer slices derived
 * FROM the WIF. The redact policy in `logger.ts` strips those keys post-
 * hoc (Layer-B `serializers.err`), but the structural defense — never
 * letting that error shape escape this site — is the stronger guarantee
 * (BACKEND-BRIDGE-KEY-LAZY-FALLBACK-THROW-SITE-CLOSURE, approach 2). The
 * subclass carries:
 *   - a fixed redact-safe message (no source interpolation);
 *   - no `.actual` / `.expected` / `.operator` / `.cause` linkage to the
 *     swallowed dhive error;
 *   - a deterministic `name` / `constructor.name` so the redact
 *     serializer in `logger.ts` projects `type:
 *     'BridgeKeyLazyParseDivergence'` for operator dashboards.
 *
 * Production reachability: the format validator at boot
 * (`validatePostingKeyFormat`) runs `PrivateKey.fromString` on the same
 * source value during `validateConfig()`. A throw at the lazy-fallback
 * path therefore implies validator/dhive divergence (e.g., a future dhive
 * change widened the parse surface), not a malformed-key
 * misconfiguration; both are operator-actionable. The boot-fatal log
 * already carried the user-actionable detail; this throw is the
 * request-lifecycle backstop.
 */
export class BridgeKeyLazyParseDivergence extends Error {
  constructor(message?: string) {
    super(message ?? (
      'Bridge posting key lazy-fallback parse failed at request time. ' +
      'Boot-time format validation passed but PrivateKey.fromString rejected the same source value here. ' +
      'This indicates a validator/dhive divergence; investigate before continuing to serve traffic.'
    ));
    this.name = 'BridgeKeyLazyParseDivergence';
  }
}

/**
 * Required-key accessor for production bridge call sites. Returns the
 * parsed bridge posting key when configured; throws a structured, redact-
 * safe error when the cache is null (i.e., `PEVO_BRIDGE_POSTING_KEY`
 * unset or never initialized).
 *
 * Round-3 hold #6 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
 * `routes/bridge.ts:233` and `:366` previously used the non-null assertion
 * `getCachedBridgePostingKey()!` after `assertBridgeKeyConfigured(res)`.
 * That guard checks `config.pevoBridgePostingKey` (the source string), NOT
 * the cache contents — a future change that nulls the cache while config
 * stays truthy would silently produce `null!.toString()` → TypeError. This
 * helper ties type narrowing to the cache contents directly, so a null
 * cache surfaces as a recognizable, redact-safe error rather than a
 * scary runtime TypeError that lands in operator logs.
 *
 * The thrown error has a clear shape (`type: 'BridgeKeyCacheUnpopulated'`)
 * that operators / dashboards can key on. The message is plain ASCII and
 * carries no secret-derived material — it's safe to log via the project-
 * wide redact policy without further scrubbing.
 *
 * Adopted by `routes/bridge.ts` (rounds 3-4 of the parent task) and
 * `routes/claims.ts:216, :314` (BACKEND-BRIDGE-KEY-CLAIMS-ROUTE-MIGRATION,
 * commit `83c6a28`). All production bridge-WIF broadcast call sites
 * funnel through this helper.
 */
export function getRequiredBridgePostingKey(): PrivateKey {
  const cached = getCachedBridgePostingKey();
  if (cached === null) {
    throw new BridgeKeyCacheUnpopulated();
  }
  return cached;
}

/**
 * Test-only hook to reset the cache. Production code MUST NOT call this.
 * Used by `tests/startup-checks.test.ts` to exercise the init path with
 * varying config without leaking state across test cases.
 */
export function _resetBridgePostingKeyCacheForTests(): void {
  cachedBridgePostingKey = null;
}

/**
 * Test-only hook to drive the init path directly. Production code calls
 * this transitively via `validateConfig()`. Used by tests that want to
 * exercise the success path with a freshly-set key.
 */
export function _initBridgePostingKeyCacheForTests(): void {
  initBridgePostingKeyCache();
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
