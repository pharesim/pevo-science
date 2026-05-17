import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { getRequiredBridgePostingKey } from '../startup-checks.js';
import { getPool, isHafConfigured } from '../db.js';
import { broadcastSendOperationsWithTimeout, BroadcastTimeoutError } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { getAccreditedSet } from '../accreditation.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { T, validPevoPaperWhere } from '../hafsql.js';
import { handleBroadcastError, makeLogBroadcastAttempt } from '../lib/broadcast-error.js';
import { assertNever } from '../util/assertNever.js';
import {
  parseIdentifier,
  resolveToCanonical,
  bridgePermlink,
  lookupPreprint,
  buildBridgeBody,
  buildBridgeMetadata,
} from '../bridge.js';

// ──────────────────────────────────────────────
// BE-BRIDGE-WRITE-HAF-LAG — read-then-write race protection
//
// /register follows a read-then-write pattern (HAF duplicate lookup, then
// broadcast). Without serialization, two concurrent calls for the same
// identifier both see "no duplicate", both broadcast, and HAF ends up with
// duplicate top-level posts under the bridge account. Pattern mirrors
// `withOrcidBindingLock` in routes/orcid.ts:
//   * SET <key> <nonce> NX EX <ttl> before the read.
//   * Hold the lock until broadcast resolves (success / 502 / 504).
//   * Lua-CAS release on the per-acquisition nonce so a stale lock from a
//     different request can't be released by accident.
//
// Lock TTL of 35s is the same default the ORCID lock uses: above the 30s
// broadcast timeout (DEFAULT_BROADCAST_TIMEOUT_MS in hive.ts) so a slow
// broadcast does not lose its lock mid-flight. We do NOT extend the TTL on
// BroadcastTimeoutError here (unlike orcid's A.1) — bridge writes carry a
// deterministic permlink under a single bridge account, and the 502/504
// envelope already includes verify_before_retry so the client knows not to
// retry blindly. If duplicate-broadcast-after-timeout becomes a measured
// problem, port the A.1 lock-TTL extension separately.
const BRIDGE_LOCK_TTL_SECONDS = 35;
const BRIDGE_LOCK_NONCE_RE = /^[0-9a-f]{32}$/;
const BRIDGE_RELEASE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

function bridgeRegisterLockKey(permlink: string): string {
  return `${config.appTag}:bridge_register_lock:${permlink}`;
}

type BridgeLockState =
  | { state: 'acquired'; nonce: string; acquiredAtMs: number }
  | { state: 'held' }
  | { state: 'unavailable' };

// SETNX-lock acquisition. Returns 'held' when another request owns the key,
// 'unavailable' on Redis outage (caller degrades to the unlocked path —
// accept the narrow race rather than fail-closed: a Redis-down 503 on every
// /register would be more user-hostile than the rare duplicate-broadcast
// during a Redis flap). Caller MUST call releaseBridgeLock(key, nonce,
// acquiredAtMs) in finally on the 'acquired' state.
async function acquireBridgeLock(lockKey: string): Promise<BridgeLockState> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return { state: 'unavailable' };
  const nonce = crypto.randomBytes(16).toString('hex');
  // Mirrors orcid.ts LOCK_NONCE_RE invariant: BRIDGE_RELEASE_LOCK_LUA does
  // byte-for-byte equality under Lua, so a future refactor changing the
  // nonce encoding away from printable-ASCII hex would silently never match
  // and the CAS would no-op. The check is cheap and forecloses the drift.
  if (!BRIDGE_LOCK_NONCE_RE.test(nonce)) {
    logger.error(
      { lockKey, event: 'bridge.lock.nonce_drift' },
      'bridge lock nonce shape invariant violated — code defect, degrading to unlocked path',
    );
    return { state: 'unavailable' };
  }
  try {
    const result = await redis.set(lockKey, nonce, 'EX', BRIDGE_LOCK_TTL_SECONDS, 'NX');
    if (result === 'OK') return { state: 'acquired', nonce, acquiredAtMs: Date.now() };
    return { state: 'held' };
  } catch (err) {
    logger.error(
      { err, lockKey, event: 'bridge.lock.redis_outage' },
      'bridge lock acquisition failed — redis outage, degrading to unlocked path',
    );
    return { state: 'unavailable' };
  }
}

// Lua CAS returns 1 when the stored nonce matched and DEL fired, 0 when the
// key was absent or held a different nonce (TTL expired and a sibling
// re-acquired). Round-2 hold item #7: surface the 0-return as a structured
// warn so operators see TTL-exceeded cascades (the broadcast outlasted the
// lock TTL — likely under load, slow Hive node, or external API stall). The
// `wallClockMs` field lets the dashboard correlate against
// BRIDGE_LOCK_TTL_SECONDS without rebuilding the timeline from logs.
async function releaseBridgeLock(
  lockKey: string,
  nonce: string,
  acquiredAtMs: number,
  routeLabel: string,
  permlink: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    const ret = await redis.eval(BRIDGE_RELEASE_LOCK_LUA, 1, lockKey, nonce);
    if (ret === 0) {
      logger.warn(
        {
          lockKey,
          permlink,
          route: routeLabel,
          wallClockMs: Date.now() - acquiredAtMs,
          ttlSeconds: BRIDGE_LOCK_TTL_SECONDS,
          event: 'bridge.lock.release_no_op',
        },
        'bridge lock release no-op: TTL expired or sibling re-acquired',
      );
    }
  } catch (err) {
    // Best-effort release. Lock self-expires after BRIDGE_LOCK_TTL_SECONDS.
    logger.warn({ err, lockKey, event: 'bridge.lock.release_failed' }, 'Failed to release bridge lock');
  }
}

const router = Router();

// Shared misconfig surface: when PEVO_BRIDGE_POSTING_KEY is unset, any handler
// that would otherwise broadcast (or authorize a broadcast) under the bridge
// account must return the same distinct 503 SERVICE_UNAVAILABLE so operators
// see one consistent error code+message across /api/bridge/* and /api/papers/*
// claim approve/revoke. Returns true when configured (caller proceeds); returns
// false after sending the 503 (caller returns).
export function assertBridgeKeyConfigured(res: Response): boolean {
  if (!config.pevoBridgePostingKey) {
    sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Bridge posting key not configured');
    return false;
  }
  return true;
}

// Per-endpoint rate limiters (per API contract)
const lookupLimiter = rateLimit({ name: 'bridge-lookup', windowMs: 60_000, max: 20, keyFn: byIp });
const registerLimiter = rateLimit({ name: 'bridge-register', windowMs: 3_600_000, max: 10, keyFn: byIp });

// ──────────────────────────────────────────────
// GET /api/bridge/lookup?identifier=...
// ──────────────────────────────────────────────

router.get('/lookup', lookupLimiter, async (req: Request, res: Response) => {
  const identifier = req.query.identifier as string;
  if (!identifier || identifier.trim().length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'Query parameter "identifier" is required');
  }

  try {
    const result = await lookupPreprint(identifier);
    if (!result) {
      return sendError(res, 404, 'NOT_FOUND', 'No preprint found for the given identifier');
    }
    sendOk(res, result);
  } catch (err) {
    logger.error(
      { err, identifier, route: 'bridge.lookup', event: 'bridge.lookup.internal_error' },
      'Preprint lookup failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch preprint metadata');
  }
});

// ──────────────────────────────────────────────
// GET /api/bridge/check?identifier=...
// ──────────────────────────────────────────────

// Result of checkExistingBridge:
//   * 'ok' + exists/author/... — HAF was reachable (or skipped by design when
//     parsed-identifier is unsupported); the duplicate-check is authoritative
//     within the freshness bound of HAF indexing.
//   * 'haf_unavailable' — HAF query threw. Previously this branch silently
//     returned `{exists: false}` and the /register handler proceeded with
//     broadcast, allowing duplicate registration during HAF outage. Now the
//     route handler converts this signal to 503 SERVICE_UNAVAILABLE
//     {retriable: true} so the client retries instead of clobbering. /check
//     keeps the fail-open behavior (read-only path, no risk of duplicate
//     write) — the discriminator lets each caller pick its own policy.
type BridgeCheckResult =
  | {
      status: 'ok';
      exists: boolean;
      author: string | null;
      permlink: string | null;
      title: string | null;
      created: Date | null;
    }
  | { status: 'haf_unavailable' };

async function checkExistingBridge(
  identifier: string,
  // Round-3 hold item #3: required (not optional). Both callers always pass
  // the result of `resolveToCanonical`, and a required positional precedes the
  // required `callerLabel` below, so the parameter list parses cleanly under
  // strict TS. Defensive null-handling stays in place via the `??` fallback.
  resolvedParsed: { type: 'arxiv' | 'doi'; id: string } | null,
  // Round-2 hold item #4: thread the caller label so the HAF-failure warn log
  // emits route: 'bridge.check' when called from /check and route:
  // 'bridge.register' when called from /register. Without this, the
  // route-keyed operator-dashboard filter on `route: 'bridge.register'`
  // false-alerts on every /check HAF blip. Round-3 hold item #3: no default
  // value — the literal-union forces every new call site to pick a label
  // explicitly so a future caller can't silently inherit 'bridge.register'
  // and reintroduce the false-alert this parameter was added to prevent.
  callerLabel: 'bridge.register' | 'bridge.check',
): Promise<BridgeCheckResult> {
  const parsed = resolvedParsed ?? parseIdentifier(identifier);
  if (!parsed || (parsed.type !== 'arxiv' && parsed.type !== 'doi')) {
    return { status: 'ok', exists: false, author: null, permlink: null, title: null, created: null };
  }

  const permlink = bridgePermlink(parsed);

  try {
    // Check all possible authors by querying HAF first
    const pool = getPool();
    if (pool && isHafConfigured()) {
      // Metadata check: find by source DOI or arXiv ID. Pin to the bridge
      // account so a spoofer can't preempt a canonical bridge import by
      // posting a comment with the same source DOI under their own account.
      const sourceField = parsed.type === 'doi' ? 'doi' : 'arxiv_id';
      const bridgePaperWhere = validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$2', bridgeAccountParam: '$5', source: 'bridge' });
      const result = await pool.query(
        `SELECT c.author, c.permlink, c.title, c.created
         FROM ${T.comments} c
         WHERE c.parent_author = '' AND c.parent_permlink = $2
           AND ${bridgePaperWhere}
           AND c.json_metadata ->> 'app' LIKE $3
           AND (c.json_metadata -> $2 -> 'source' ->> $4) = $1
         LIMIT 1`,
        [parsed.id, config.appTag, `${config.appTag}/%`, sourceField, config.hiveBridgeAccount],
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return { status: 'ok', exists: true, author: row.author, permlink: row.permlink, title: row.title, created: row.created };
      }

      // Also check by deterministic permlink (also pinned to bridge account).
      const permlinkBridgeWhere = validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$2', bridgeAccountParam: '$4', source: 'bridge' });
      const permlinkResult = await pool.query(
        `SELECT c.author, c.permlink, c.title, c.created
         FROM ${T.comments} c
         WHERE c.parent_author = '' AND c.parent_permlink = $2
           AND c.permlink = $1
           AND ${permlinkBridgeWhere}
           AND c.json_metadata ->> 'app' LIKE $3
         LIMIT 1`,
        [permlink, config.appTag, `${config.appTag}/%`, config.hiveBridgeAccount],
      );
      if (permlinkResult.rows.length > 0) {
        const row = permlinkResult.rows[0];
        return { status: 'ok', exists: true, author: row.author, permlink: row.permlink, title: row.title, created: row.created };
      }
    }
  } catch (err) {
    // BE-BRIDGE-WRITE-HAF-LAG fail-closed signal. The /register route handler
    // converts this to 503 + {retriable: true} so a HAF outage can't license a
    // duplicate broadcast. /check (read-only) preserves the prior fail-open
    // behavior by mapping the signal back to {exists: false}. The event field
    // is parameterized on callerLabel so operator dashboards filtering on
    // `route: 'bridge.register'` don't false-alert on /check HAF blips.
    logger.warn(
      { err, identifier, permlink, event: `${callerLabel}.haf_check_failed`, route: callerLabel },
      // Round-3 hold item #4: route field carries the fail-open vs.
      // fail-closed disposition; this path fires from /register (fail-closed
      // → 503) AND /check (fail-open → 200) so the human-readable message
      // stays disposition-neutral. Operator dashboards key on structured
      // fields, not message text.
      'Bridge HAF query failed',
    );
    return { status: 'haf_unavailable' };
  }

  return { status: 'ok', exists: false, author: null, permlink: null, title: null, created: null };
}

router.get('/check', lookupLimiter, async (req: Request, res: Response) => {
  const identifier = req.query.identifier as string;
  if (!identifier || identifier.trim().length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'Query parameter "identifier" is required');
  }

  try {
    const parsed = await resolveToCanonical(identifier);
    if (!parsed) {
      return sendError(res, 400, 'BAD_REQUEST', 'Could not resolve identifier — try pasting a DOI or arXiv ID directly');
    }

    // Round-2 hold item #2: resolve checkExistingBridge OUTSIDE getOrSet so
    // the haf_unavailable sentinel never lands in the 30s cache. QueryCache
    // caches any non-null object; the prior `hafCache.getOrSet(...,
    // checkExistingBridge, 30_000)` poisoned subsequent /check calls with
    // `{exists: false}` for up to 30s after HAF recovered in 1-2s. We now
    // probe the cache for the ok shape only and write through only the ok
    // shape; haf_unavailable bypasses the cache entirely.
    const cacheKey = `bridge-check:${parsed.type}:${parsed.id}`;
    type OkShape = Extract<BridgeCheckResult, { status: 'ok' }>;
    let result: BridgeCheckResult;
    const cached = await hafCache.get<OkShape>(cacheKey);
    if (cached !== undefined) {
      result = cached;
    } else {
      result = await checkExistingBridge(identifier, parsed, 'bridge.check');
      if (result.status === 'ok') {
        await hafCache.set(cacheKey, result, 30_000);
      }
    }
    // Read-only path stays fail-open: a HAF blip on /check returns
    // exists=false (the legacy shape) so the UI doesn't pop a 503 banner on
    // every preprint-resolve. The fail-closed policy is intentionally only on
    // /register where the consequence of a bad answer is a duplicate
    // broadcast. Round-2 hold item #3: assertNever guards the discriminated
    // union so a future 3rd variant compiles into a build error rather than
    // silently falling through to the ok branch.
    if (result.status === 'haf_unavailable') {
      sendOk(res, { exists: false, author: null, permlink: null, title: null, created: null });
    } else if (result.status === 'ok') {
      const { status: _omit, ...payload } = result;
      sendOk(res, payload);
    } else {
      return assertNever(result);
    }
  } catch (err) {
    logger.error(
      { err, identifier, route: 'bridge.check', event: 'bridge.check.internal_error' },
      'Bridge check failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to check bridge paper status');
  }
});

// ──────────────────────────────────────────────
// POST /api/bridge/register
// ──────────────────────────────────────────────

router.post('/register', registerLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const username = req.hiveUsername!;
  const { identifier, discipline, keywords, language } = req.body as {
    identifier?: string;
    discipline?: string;
    keywords?: string[];
    language?: string;
  };

  if (!identifier || typeof identifier !== 'string' || identifier.trim().length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'Field "identifier" is required');
  }

  if (!discipline || typeof discipline !== 'string' || discipline.trim().length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'Field "discipline" is required');
  }

  // Verify accreditation
  const accreditedSet = await getAccreditedSet([username]);
  if (!accreditedSet.has(username)) {
    return sendError(res, 403, 'FORBIDDEN', 'Only accredited researchers can register bridge papers');
  }

  if (!assertBridgeKeyConfigured(res)) return;

  // Resolve identifier to canonical DOI or arXiv ID
  let parsed;
  try {
    parsed = await resolveToCanonical(identifier);
  } catch (err) {
    logger.error(
      { err, identifier, username, route: 'bridge.register', event: 'bridge.register.identifier_resolution_failed' },
      'Identifier resolution failed',
    );
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to resolve identifier');
  }
  if (!parsed) {
    return sendError(res, 400, 'BAD_REQUEST', 'Could not resolve identifier — try pasting a DOI or arXiv ID directly');
  }

  // Round-2 hold item #6: hoist lookupPreprint OUT of the lock critical
  // section. CrossRef (15s timeout) + PubMed (15s) + DOI scrape (10s) on top
  // of the broadcast (~30s) can push wall-clock past the 35s lock TTL,
  // causing the lock to expire mid-flight and a sibling to re-acquire under
  // a new nonce. The lookup is a pure external metadata fetch with no chain
  // state, so it does not need lock protection; after the hoist the in-lock
  // wall-clock is HAF query (~100ms) + broadcast (~30s), comfortably under
  // BRIDGE_LOCK_TTL_SECONDS.
  let meta;
  try {
    meta = await lookupPreprint(identifier);
  } catch (err) {
    logger.error(
      { err, identifier, username, route: 'bridge.register', event: 'bridge.register.metadata_fetch_failed' },
      'Preprint metadata fetch failed during registration',
    );
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch preprint metadata from source');
  }
  if (!meta) {
    return sendError(res, 400, 'BAD_REQUEST', 'No preprint found for the given identifier');
  }

  // BE-BRIDGE-WRITE-HAF-LAG: claim the per-permlink lock BEFORE the HAF
  // duplicate-check so two concurrent /register calls for the same identifier
  // serialize on Redis (loser gets 409 LOCK_HELD). The lock spans the entire
  // read-then-broadcast window and is released in finally on every exit
  // path. On Redis outage we degrade to the unlocked path (the prior shape)
  // so a Redis flap can't 503 every registration.
  const permlink = bridgePermlink(parsed);
  const lockKey = bridgeRegisterLockKey(permlink);
  const lockState = await acquireBridgeLock(lockKey);
  if (lockState.state === 'held') {
    // Round-2 hold item #1: 409 LOCK_HELD (NOT DUPLICATE). Discriminates
    // from the existing-duplicate 409 below so SPA / integrators can switch
    // on err.code without parsing the message string. LOCK_HELD is
    // retriable (the other request will land on chain and the next attempt
    // will hit the DUPLICATE path); existing-duplicate is terminal.
    return sendError(
      res,
      409,
      'LOCK_HELD',
      'A registration for this preprint is already in progress',
      { retriable: true },
    );
  }

  try {
    // Check for duplicates (now race-free against concurrent /register
    // siblings for the same identifier, modulo the unlocked-degrade window
    // when Redis is unavailable).
    const existing = await checkExistingBridge(identifier, parsed, 'bridge.register');
    if (existing.status === 'haf_unavailable') {
      // Fail-closed: do NOT broadcast on a HAF outage — duplicate-check is
      // unreliable and a successful broadcast under those conditions could
      // create a duplicate top-level post under the bridge account.
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Bridge duplicate-check is temporarily unavailable. Please retry shortly.', { retriable: true });
    } else if (existing.status === 'ok') {
      if (existing.exists) {
        return sendError(
          res,
          409,
          'DUPLICATE',
          'This preprint is already registered on PEvO',
          {
            existing_author: existing.author,
            existing_permlink: existing.permlink,
          },
        );
      }
    } else {
      // Round-2 hold item #3: exhaustiveness guard on BridgeCheckResult so a
      // future variant becomes a compile error instead of silently falling
      // through to broadcast.
      return assertNever(existing);
    }

    // Build and broadcast the Hive post under the bridge account
    const body = buildBridgeBody(meta, username);
    const jsonMetadata = buildBridgeMetadata(
      meta,
      username,
      discipline || '',
      keywords || [],
      language || 'en',
      1,
      meta.title,
      body,
      config.hiveBridgeAccount,
      permlink,
    );

    // Per-attempt audit-log signal (BACKEND-BROADCAST-ATTEMPT-HELPER-
    // EXTRACTION). Same pattern as `custody.broadcast.attempt` — fires on
    // EVERY broadcast attempt (success/failure/timeout) so operators can
    // correlate retry-amplification. The shared `makeLogBroadcastAttempt`
    // factory enforces level-dispatch + spread-after-literal symmetry with
    // the custody site; only the event-label literal differs.
    //
    // `attempt_n` is INTENTIONALLY OMITTED here, same rationale as the
    // custody site. The idempotency layer landed (HAF dedup + tx_id replay
    // short-circuit), but that arc did NOT add a per-attempt counter. A
    // hardcoded `attempt_n: 1` would silently report "no retries" to
    // dashboards keyed on the field for retry-amplification alerts, masking
    // the very signal the alert exists to surface. The slot stays absent
    // until a per-key counter mechanism exists; alerts fire on missing-field
    // rather than reading a constant 1 as ground truth.
    const op_types = ['comment', 'comment_options'];
    const op_count = op_types.length;
    const logBroadcastAttempt = makeLogBroadcastAttempt(
      'bridge.register.attempt',
      {
        route: 'bridge.register',
        username,
        author: config.hiveBridgeAccount,
        permlink,
        identifier,
        op_types,
        op_count,
      },
    );

    try {
      // Use the boot-cached parsed key. `assertBridgeKeyConfigured` above
      // already returned 503 if the WIF env var is unset, so the cache is
      // guaranteed populated when we reach here. Round-3 hold #6
      // (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT) replaced
      // the prior non-null assertion `getCachedBridgePostingKey()!` with
      // the `getRequiredBridgePostingKey()` accessor that throws a
      // structured `BridgeKeyCacheUnpopulated` error if the cache is null.
      // The throw is unreachable on the happy path; it surfaces as a
      // recognizable shape (instead of a silent `null!.toString()`
      // TypeError) if a future change ever desyncs the cache from the
      // config-truthiness check.
      const key = getRequiredBridgePostingKey();
      const result = await broadcastSendOperationsWithTimeout(
        [
          ['comment', {
            parent_author: '',
            parent_permlink: config.appTag,
            author: config.hiveBridgeAccount,
            permlink,
            title: meta.title.length > 256 ? meta.title.slice(0, 253) + '...' : meta.title,
            body,
            json_metadata: JSON.stringify(jsonMetadata),
          }],
          ['comment_options', {
            author: config.hiveBridgeAccount,
            permlink,
            max_accepted_payout: '1000000.000 HBD',
            percent_hbd: 0,
            allow_votes: true,
            allow_curation_rewards: true,
            extensions: [],
          }],
        ],
        key,
      );

      logBroadcastAttempt('success', { tx_id: result.id });

      sendOk(res, {
        author: config.hiveBridgeAccount,
        permlink,
        tx_id: result.id,
        source: {
          type: meta.source_type,
          doi: meta.doi,
          arxiv_id: meta.arxiv_id,
          url: meta.source_url,
        },
      });
    } catch (err) {
      // Pino-side per-attempt signal for the broadcast catch path. The
      // outcome label discriminates timeout vs. failure so dashboards can
      // separate the two without parsing the inner-helper's stable suffix.
      // Mirrors the custody.ts pattern at the matching catch site.
      const outcome: 'failure' | 'timeout' = err instanceof BroadcastTimeoutError ? 'timeout' : 'failure';
      logBroadcastAttempt(outcome);
      return handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting bridge paper registration timed out',
        failMsg: 'Failed to broadcast bridge paper registration to Hive',
        logContext: { author: config.hiveBridgeAccount, permlink, username },
        routeLabel: 'bridge.register',
      });
    }
  } finally {
    if (lockState.state === 'acquired') {
      await releaseBridgeLock(lockKey, lockState.nonce, lockState.acquiredAtMs, 'bridge.register', permlink);
    }
  }
});

export default router;
