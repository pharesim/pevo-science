import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { getCachedBridgePostingKey } from '../startup-checks.js';
import { getPool, isHafAvailable } from '../db.js';
import { hiveClient, broadcastSendOperationsWithTimeout } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parseMeta, isPevoBridgePaper } from '../helpers.js';
import { getAccreditedSet } from '../accreditation.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { T, validPevoPaperWhere } from '../hafsql.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';
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
// /register and /update both follow a read-then-write pattern (HAF lookup of
// existing-paper / previous-version, then broadcast). Without serialization,
// two concurrent calls for the same identifier (or same author+permlink) both
// see "no duplicate" / "version: N", both broadcast, and HAF ends up with
// duplicate top-level posts under the bridge account or a clobbered version
// counter. Pattern mirrors `withOrcidBindingLock` in routes/orcid.ts:
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

function bridgeUpdateLockKey(author: string, permlink: string): string {
  return `${config.appTag}:bridge_update_lock:${author}:${permlink}`;
}

type BridgeLockState =
  | { state: 'acquired'; nonce: string }
  | { state: 'held' }
  | { state: 'unavailable' };

// SETNX-lock acquisition. Returns 'held' when another request owns the key,
// 'unavailable' on Redis outage (caller degrades to the unlocked path —
// accept the narrow race rather than fail-closed: a Redis-down 503 on every
// /register would be more user-hostile than the rare duplicate-broadcast
// during a Redis flap). Caller MUST call releaseBridgeLock(key, nonce) in
// finally on the 'acquired' state.
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
    if (result === 'OK') return { state: 'acquired', nonce };
    return { state: 'held' };
  } catch (err) {
    logger.error(
      { err, lockKey, event: 'bridge.lock.redis_outage' },
      'bridge lock acquisition failed — redis outage, degrading to unlocked path',
    );
    return { state: 'unavailable' };
  }
}

async function releaseBridgeLock(lockKey: string, nonce: string): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.eval(BRIDGE_RELEASE_LOCK_LUA, 1, lockKey, nonce);
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
const updateLimiter = rateLimit({ name: 'bridge-update', windowMs: 3_600_000, max: 10, keyFn: byIp });

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
    logger.error({ err, identifier }, 'Preprint lookup failed');
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

async function checkExistingBridge(identifier: string, resolvedParsed?: { type: 'arxiv' | 'doi'; id: string } | null): Promise<BridgeCheckResult> {
  const parsed = resolvedParsed ?? parseIdentifier(identifier);
  if (!parsed || (parsed.type !== 'arxiv' && parsed.type !== 'doi')) {
    return { status: 'ok', exists: false, author: null, permlink: null, title: null, created: null };
  }

  const permlink = bridgePermlink(parsed);

  try {
    // Check all possible authors by querying HAF first
    const pool = getPool();
    if (pool && isHafAvailable()) {
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
    // behavior by mapping the signal back to {exists: false}.
    logger.warn(
      { err, identifier, permlink, event: 'bridge.register.haf_check_failed', route: 'bridge.register' },
      'Bridge check HAF query failed — failing closed, surfacing 503 to caller',
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

    const cacheKey = `bridge-check:${parsed.type}:${parsed.id}`;
    const result = await hafCache.getOrSet(cacheKey, () => checkExistingBridge(identifier, parsed), 30_000);
    // Read-only path stays fail-open: a HAF blip on /check returns
    // exists=false (the legacy shape) so the UI doesn't pop a 503 banner on
    // every preprint-resolve. The fail-closed policy is intentionally only on
    // /register where the consequence of a bad answer is a duplicate
    // broadcast.
    if (result.status === 'haf_unavailable') {
      sendOk(res, { exists: false, author: null, permlink: null, title: null, created: null });
    } else {
      const { status: _omit, ...payload } = result;
      sendOk(res, payload);
    }
  } catch (err) {
    logger.error({ err, identifier }, 'Bridge check failed');
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
    logger.error({ err, identifier, username }, 'Identifier resolution failed');
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to resolve identifier');
  }
  if (!parsed) {
    return sendError(res, 400, 'BAD_REQUEST', 'Could not resolve identifier — try pasting a DOI or arXiv ID directly');
  }

  // BE-BRIDGE-WRITE-HAF-LAG: claim the per-permlink lock BEFORE the HAF
  // duplicate-check so two concurrent /register calls for the same identifier
  // serialize on Redis (loser gets 409). The lock spans the entire
  // read-then-broadcast window and is released in finally on every exit
  // path. On Redis outage we degrade to the unlocked path (the prior shape)
  // so a Redis flap can't 503 every registration.
  const permlink = bridgePermlink(parsed);
  const lockKey = bridgeRegisterLockKey(permlink);
  const lockState = await acquireBridgeLock(lockKey);
  if (lockState.state === 'held') {
    return res.status(409).json({
      status: 'error',
      error: {
        code: 'DUPLICATE',
        message: 'A registration for this preprint is already in progress',
        details: { retriable: true },
      },
    });
  }

  try {
    // Check for duplicates (now race-free against concurrent /register
    // siblings for the same identifier, modulo the unlocked-degrade window
    // when Redis is unavailable).
    const existing = await checkExistingBridge(identifier, parsed);
    if (existing.status === 'haf_unavailable') {
      // Fail-closed: do NOT broadcast on a HAF outage — duplicate-check is
      // unreliable and a successful broadcast under those conditions could
      // create a duplicate top-level post under the bridge account.
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Bridge duplicate-check is temporarily unavailable. Please retry shortly.', { retriable: true });
    }
    if (existing.exists) {
      return res.status(409).json({
        status: 'error',
        error: {
          code: 'DUPLICATE',
          message: 'This preprint is already registered on PEvO',
          existing_author: existing.author,
          existing_permlink: existing.permlink,
        },
      });
    }

    // Fetch metadata from source
    let meta;
    try {
      meta = await lookupPreprint(identifier);
    } catch (err) {
      logger.error({ err, identifier, username }, 'Preprint metadata fetch failed during registration');
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch preprint metadata from source');
    }
    if (!meta) {
      return sendError(res, 400, 'BAD_REQUEST', 'No preprint found for the given identifier');
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

    try {
      // Use the boot-cached parsed key. `assertBridgeKeyConfigured` above
      // already returned 503 if the WIF env var is unset, so the cache is
      // guaranteed populated when we reach here. The non-null assertion
      // documents that invariant.
      const key = getCachedBridgePostingKey()!;
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
      return handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting bridge paper registration timed out',
        failMsg: 'Failed to broadcast bridge paper registration to Hive',
        logContext: { author: config.hiveBridgeAccount, permlink, username },
        routeLabel: 'bridge.register',
      });
    }
  } finally {
    if (lockState.state === 'acquired') {
      await releaseBridgeLock(lockKey, lockState.nonce);
    }
  }
});

// ──────────────────────────────────────────────
// POST /api/bridge/update
// ──────────────────────────────────────────────

router.post('/update', updateLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const username = req.hiveUsername!;
  const { permlink } = req.body as { permlink?: string };

  if (!permlink) {
    return sendError(res, 400, 'BAD_REQUEST', 'Field "permlink" is required');
  }

  // Verify accreditation
  const accreditedSet = await getAccreditedSet([username]);
  if (!accreditedSet.has(username)) {
    return sendError(res, 403, 'FORBIDDEN', 'Only accredited researchers can update bridge papers');
  }

  if (!assertBridgeKeyConfigured(res)) return;

  // BE-BRIDGE-WRITE-HAF-LAG: lock keyed on (bridge_account, permlink) BEFORE
  // the get_content read so two concurrent /update calls for the same paper
  // serialize. Without the lock, both reads can see version=N and both
  // broadcast version=N+1, clobbering one update. With the lock, the second
  // call gets 409 and the client retries (which then reads the freshly
  // updated paper as version=N+1 and increments to N+2 correctly).
  const lockKey = bridgeUpdateLockKey(config.hiveBridgeAccount, permlink);
  const lockState = await acquireBridgeLock(lockKey);
  if (lockState.state === 'held') {
    return res.status(409).json({
      status: 'error',
      error: {
        code: 'DUPLICATE',
        message: 'An update for this bridge paper is already in progress',
        details: { retriable: true },
      },
    });
  }

  try {
    // Fetch the existing bridge paper (always under bridge account)
    let existingMeta: Record<string, unknown> | null = null;
    let existingPevo: Record<string, unknown> | null = null;

    try {
      const post = await hiveClient.database.call('get_content', [config.hiveBridgeAccount, permlink]);
      if (!post || !post.author || post.parent_permlink !== config.appTag) {
        return sendError(res, 404, 'NOT_FOUND', 'Bridge paper not found');
      }

      existingMeta = parseMeta(post.json_metadata);
      if (!isPevoBridgePaper(existingMeta, post.author)) {
        return sendError(res, 404, 'NOT_FOUND', 'Bridge paper not found');
      }

      existingPevo = (existingMeta[config.appTag] || {}) as Record<string, unknown>;
    } catch (err) {
      logger.error({ err, author: config.hiveBridgeAccount, permlink, username }, 'Failed to fetch existing bridge paper');
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch existing bridge paper');
    }

    // Only the original registerer can update
    const source = existingPevo.source as Record<string, unknown> | undefined;
    const registeredBy = source?.registered_by as string | undefined;
    if (registeredBy !== username) {
      return sendError(res, 403, 'FORBIDDEN', 'Only the original registerer can update a bridge paper');
    }

    const sourceIdentifier = (source?.doi as string) || (source?.arxiv_id as string);
    if (!sourceIdentifier) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Bridge paper has no source identifier');
    }

    // Re-fetch metadata from source
    let freshMeta;
    try {
      freshMeta = await lookupPreprint(sourceIdentifier);
    } catch (err) {
      logger.error({ err, sourceIdentifier, author: config.hiveBridgeAccount, permlink, username }, 'Failed to re-fetch preprint metadata for update');
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch updated metadata from source');
    }
    if (!freshMeta) {
      return sendError(res, 400, 'BAD_REQUEST', 'Source metadata could not be retrieved');
    }

    const previousVersion = (existingPevo.version as number) || 1;
    const newVersion = previousVersion + 1;

    const body = buildBridgeBody(freshMeta, username);
    const jsonMetadata = buildBridgeMetadata(
      freshMeta,
      username,
      (existingPevo.discipline as string) || '',
      (existingPevo.keywords as string[]) || [],
      (existingPevo.language as string) || 'en',
      newVersion,
      freshMeta.title,
      body,
      config.hiveBridgeAccount,
      permlink,
    );

    try {
      // Use the boot-cached parsed key. `assertBridgeKeyConfigured` above
      // already returned 503 if the WIF env var is unset, so the cache is
      // guaranteed populated when we reach here. The non-null assertion
      // documents that invariant.
      const key = getCachedBridgePostingKey()!;
      const result = await broadcastSendOperationsWithTimeout(
        [
          ['comment', {
            parent_author: '',
            parent_permlink: config.appTag,
            author: config.hiveBridgeAccount,
            permlink,
            title: freshMeta.title.length > 256 ? freshMeta.title.slice(0, 253) + '...' : freshMeta.title,
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

      sendOk(res, {
        author: config.hiveBridgeAccount,
        permlink,
        tx_id: result.id,
        previous_version: previousVersion,
        new_version: newVersion,
      });
    } catch (err) {
      return handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting bridge paper update timed out',
        failMsg: 'Failed to broadcast bridge paper update to Hive',
        logContext: { author: config.hiveBridgeAccount, permlink, username, newVersion },
        routeLabel: 'bridge.update',
      });
    }
  } finally {
    if (lockState.state === 'acquired') {
      await releaseBridgeLock(lockKey, lockState.nonce);
    }
  }
});

export default router;
