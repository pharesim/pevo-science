import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { getAccreditedSet } from '../accreditation.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { findBridgeDuplicate } from '../bridge-haf.js';
import { assertNever } from '../util/assertNever.js';
import {
  parseIdentifier,
  resolveToCanonical,
  bridgePermlink,
  lookupPreprint,
} from '../bridge.js';
import {
  tryEnqueueBridgeImport,
  listUserImports,
  etaSecondsForPosition,
  BRIDGE_QUEUE_USER_CAP,
  type BridgeImportRow,
} from '../bridge-queue.js';

// ──────────────────────────────────────────────
// Bridge read-then-write race protection
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
// Lock TTL of 35s is the same default the ORCID lock uses: exceeds the 30s
// broadcast timeout (DEFAULT_BROADCAST_TIMEOUT_MS in hive.ts) so a slow
// broadcast does not lose its lock mid-flight. The TTL is NOT extended on
// BroadcastTimeoutError here (unlike the ORCID lock's timeout-extension
// path) — bridge writes carry a deterministic permlink under a single
// bridge account, and the 502/504 envelope already includes
// verify_before_retry so the client knows not to retry blindly. If
// duplicate-broadcast-after-timeout becomes a measured problem, port the
// ORCID lock-TTL extension behavior separately.
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
// re-acquired). The 0-return is surfaced as a structured warn so operators
// can detect TTL-exceeded broadcast cascades (the broadcast outlasted the
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
// Consume-on-success-only: `/register` emits TWO retriable-true error shapes
// (409 LOCK_HELD when a sibling request holds the per-permlink lock; 503
// SERVICE_UNAVAILABLE when the HAF duplicate-check throws under transient
// outage). Without this flag, a SPA auto-retry loop on `details.retriable`
// burns the per-IP 10/hour budget during a single LOCK_HELD cascade or HAF
// outage event; the originating IP then 429s legitimate registrations for
// the remainder of the rolling window. Per `RateLimitConfig.skipFailedRequests`
// JSDoc the refund branch keys on ANY `res.statusCode >= 400` (4xx AND 5xx).
//
// Mounted AFTER `verifyHiveSignature` + `validateRegisterBody` on the route
// chain so that body-malformed 400s and unsigned/invalid-signature 401s
// never reach the limiter (and therefore never refund a slot). That guard
// closes a CPU/Hive-RPC amplification surface: with the limiter mounted
// first, an attacker spraying malformed bodies from a single IP would
// trigger one ECDSA recovery + one `hiveClient.database.getAccounts` RPC
// call per probe (because `verifyHiveSignature` runs before any 4xx
// short-circuit), and `skipFailedRequests` would refund every slot. The
// reorder matches the `accreditationVerifyLimiter` sibling precedent in
// `accreditation.ts` (validate-then-limit).
//
// The surviving 4xx/5xx slot-refund paths under the new order are all
// downstream of the limiter:
//   - 403 NOT_ACCREDITED  — fires AFTER `getAccreditedSet([username])`
//   - 400 BAD_REQUEST     — "Could not resolve identifier" fires AFTER
//                            `resolveToCanonical` (arXiv/Crossref HTTP)
//   - 400 BAD_REQUEST     — "No preprint found" fires AFTER
//                            `lookupPreprint` (CrossRef/PubMed HTTP)
//   - 409 LOCK_HELD       — fires AFTER per-permlink SETNX (Redis)
//   - 409 DUPLICATE       — fires AFTER `checkExistingBridge` (HAF SELECT)
//   - 503 SERVICE_UNAVAILABLE / 500 INTERNAL_ERROR — fail-closed on HAF
//                            outage / resolver throw
//
// Each of these is cheap enough to accept on the refund path at PEvO
// single-instance scale: external resolvers (`resolveToCanonical`,
// `lookupPreprint`) have their own per-host rate caps and timeouts; the
// HAF duplicate-check is a single indexed lookup; per-permlink SETNX is a
// one-shot Redis op. The truly expensive boundary is the Hive broadcast,
// which only ever runs on the success path and stays bounded by the
// per-IP 10/hour success cap that `skipFailedRequests` preserves
// (successful 2xx still consumes a slot).
const registerLimiter = rateLimit({
  name: 'bridge-register',
  windowMs: 3_600_000,
  max: 10,
  keyFn: byIp,
  skipFailedRequests: true,
});

// Body-shape validation extracted to a middleware so that malformed-body 400s
// short-circuit BEFORE `registerLimiter`. With the limiter ahead of body
// validation, every malformed-body probe would still run `verifyHiveSignature`
// (ECDSA recovery + one `getAccounts` RPC) per attempt and refund the slot
// under `skipFailedRequests` — an unbounded CPU/RPC amplification surface.
// The handler still re-derives the typed fields from `req.body`; this
// middleware only gates the required-field presence + non-empty-string shape.
//
// Content-Type guard (first check): a request whose `Content-Type` is not
// `application/json` is rejected up-front with 415, BEFORE any `body.<field>`
// access. The only body parser mounted is `express.json` (which matches on
// `application/json`); under Express 5 a non-JSON or absent Content-Type
// leaves `req.body === undefined`, so the subsequent `body.identifier` read
// would throw a TypeError that bubbles to the global error handler as 500.
// That 500 path is itself a CPU/RPC amplification bypass distinct from the
// malformed-JSON-body case the middleware-reorder closed: `verifyHiveSignature`
// has already paid ECDSA recovery + a `getAccounts` RPC by the time
// `validateRegisterBody` runs, yet the request never reaches `registerLimiter`
// (no slot is consumed, so there is nothing to refund and nothing to bound the
// per-IP cost). An attacker holding any valid posting key can sign a canonical
// message with the empty-body hash (`JSON.stringify(undefined ?? {})` === '{}')
// and replay it with fresh timestamps under non-JSON Content-Type indefinitely.
// Failing fast on the Content-Type closes that path: the 415 short-circuits
// before the limiter (slot untouched) and the TypeError read is dead code.
// 415 is sent with the existing `BAD_REQUEST` error code to keep the error
// envelope within the established code enum while preserving the HTTP-415
// unsupported-media-type semantic that integrators expect.
function validateRegisterBody(req: Request, res: Response, next: NextFunction): void {
  if (!req.is('application/json')) {
    sendError(res, 415, 'BAD_REQUEST', 'Content-Type must be application/json');
    return;
  }
  const body = req.body as { identifier?: unknown; discipline?: unknown };
  if (!body.identifier || typeof body.identifier !== 'string' || body.identifier.trim().length === 0) {
    sendError(res, 400, 'BAD_REQUEST', 'Field "identifier" is required');
    return;
  }
  if (!body.discipline || typeof body.discipline !== 'string' || body.discipline.trim().length === 0) {
    sendError(res, 400, 'BAD_REQUEST', 'Field "discipline" is required');
    return;
  }
  next();
}

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
  // Required (not optional). Both callers always pass the result of
  // `resolveToCanonical`, and this required positional precedes the required
  // `callerLabel` parameter, so the parameter list parses cleanly under
  // strict TS. Defensive null-handling stays in place via the `??` fallback.
  resolvedParsed: { type: 'arxiv' | 'doi'; id: string } | null,
  // Caller label threads into the HAF-failure warn log so it emits
  // route: 'bridge.check' when called from /check and route:
  // 'bridge.register' when called from /register. Without this, the
  // route-keyed operator-dashboard filter on `route: 'bridge.register'`
  // false-alerts on every /check HAF blip. The literal-union type is
  // required with no default — that forces every new call site to pick a
  // label explicitly so a future caller can't silently inherit
  // 'bridge.register' and reintroduce the false-alert this parameter was
  // added to prevent.
  callerLabel: 'bridge.register' | 'bridge.check',
): Promise<BridgeCheckResult> {
  const parsed = resolvedParsed ?? parseIdentifier(identifier);
  if (!parsed || (parsed.type !== 'arxiv' && parsed.type !== 'doi')) {
    return { status: 'ok', exists: false, author: null, permlink: null, title: null, created: null };
  }

  // Narrow to the canonical {arxiv|doi} shape the shared helper expects
  // before the bridgePermlink call below (control-flow narrows the `.type`
  // read, not the whole ParsedIdentifier object).
  const canonical = { type: parsed.type, id: parsed.id };
  const permlink = bridgePermlink(parsed);

  try {
    // Two-query HAF duplicate lookup (source-field match + deterministic
    // permlink fallback, both pinned to the bridge account) shared with the
    // worker's pre-broadcast reconciliation via `findBridgeDuplicate`.
    const dup = await findBridgeDuplicate(canonical, permlink);
    if (dup) {
      return { status: 'ok', exists: true, author: dup.author, permlink: dup.permlink, title: dup.title, created: dup.created };
    }
  } catch (err) {
    // Fail-closed signal for /register. The route handler converts this to
    // 503 + {retriable: true} so a HAF outage can't license a duplicate
    // broadcast. /check (read-only) preserves the prior fail-open behavior
    // by mapping the signal back to {exists: false}. The event field is
    // parameterized on callerLabel so operator dashboards filtering on
    // `route: 'bridge.register'` don't false-alert on /check HAF blips.
    logger.warn(
      { err, identifier, permlink, event: `${callerLabel}.haf_check_failed`, route: callerLabel },
      // route field carries the fail-open vs. fail-closed disposition;
      // this path fires from /register (fail-closed → 503) AND /check
      // (fail-open → 200) so the human-readable message stays
      // disposition-neutral. Operator dashboards key on structured fields,
      // not message text.
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

    // Resolve checkExistingBridge OUTSIDE getOrSet so the haf_unavailable
    // sentinel never lands in the 30s cache. QueryCache caches any non-null
    // object; the prior `hafCache.getOrSet(..., checkExistingBridge, 30_000)`
    // poisoned subsequent /check calls with `{exists: false}` for up to 30s
    // after HAF recovered in 1-2s. The cache is now probed for the ok shape
    // only and writes through only the ok shape; haf_unavailable bypasses
    // the cache entirely.
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
    // broadcast. The `assertNever` call guards the `BridgeCheckResult`
    // discriminated union so a future 3rd variant compiles into a build
    // error rather than silently falling through to the ok branch.
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

/**
 * Map a queue row's state + error_code + result fields to a status shape
 * suitable for the SPA's "My imports" surface. The wire fields stay close
 * to the queue's persisted shape so the UI can render queue position,
 * retry-attempt count, and terminal outcomes without a parallel vocabulary.
 *
 * This is the provisional v1 wire shape; the formal field set is documented
 * in `agents/docs/api-contracts/bridge.md` (GET /api/bridge/imports). The
 * `/api/bridge/imports` response is the source of truth the contract tracks.
 */
function serializeQueueRow(row: BridgeImportRow, queuePosition?: number | null): Record<string, unknown> {
  const nonTerminal = row.state === 'pending' || row.state === 'in_progress';
  return {
    id: row.id,
    operation_kind: row.operation_kind,
    identifier: row.identifier,
    title: row.title,
    permlink: row.permlink,
    // Resolved Hive author of the completed post. On a permlink-collision
    // short-circuit the entry completes pointing at the existing post, so the
    // author is existing_author; on a fresh broadcast it is the bridge account.
    // Null while non-terminal (and on failed, which never produced a post).
    author: row.state === 'completed' ? (row.existing_author ?? config.hiveBridgeAccount) : null,
    discipline: row.discipline,
    keywords: row.keywords,
    language: row.language,
    state: row.state,
    attempts: row.attempts,
    scheduled_at: row.scheduled_at.toISOString(),
    // Best-effort dispatch estimate for non-terminal entries; null for terminal
    // ones and when no position is available. Same formula as the 202 response.
    eta_seconds: nonTerminal && typeof queuePosition === 'number' ? etaSecondsForPosition(queuePosition) : null,
    tx_id: row.tx_id,
    error_code: row.error_code,
    error_message: row.error_message,
    existing_author: row.existing_author,
    existing_permlink: row.existing_permlink,
    created_at: row.created_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
  };
}

router.post('/register', verifyHiveSignature, validateRegisterBody, registerLimiter, async (req: Request, res: Response) => {
  const username = req.hiveUsername!;
  // `validateRegisterBody` middleware has already gated identifier + discipline
  // presence + non-empty-string shape; re-derive the typed fields here for
  // the handler's remaining work. The non-null assertions are sound because
  // the middleware short-circuited any request that would have left these
  // unset; TypeScript can't see that across the middleware boundary.
  const { identifier, discipline, keywords, language } = req.body as {
    identifier: string;
    discipline: string;
    keywords?: string[];
    language?: string;
  };

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
    return sendError(res, 400, 'BAD_REQUEST', 'Could not resolve identifier. Try pasting a DOI or arXiv ID directly.');
  }

  // Metadata-fetch is done synchronously so a failure discovered at enqueue
  // surfaces to the submitter immediately (with no queue entry created),
  // rather than enqueueing a submission that would only fail later at
  // dispatch.
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

  // Pre-enqueue HAF duplicate check. If the preprint is already registered
  // on PEvO, return the existing record synchronously rather than enqueue a
  // submission that will short-circuit at dispatch (the worker would mark
  // the entry completed with `existing_*` set, but synchronous resolution
  // is the better UX). Retain the per-permlink Redis dedup-lock on this
  // critical section so two simultaneous submissions for the same
  // identifier serialize, matching the pre-queue race-protection contract.
  const permlink = bridgePermlink(parsed);
  const lockKey = bridgeRegisterLockKey(permlink);
  const lockState = await acquireBridgeLock(lockKey);
  if (lockState.state === 'held') {
    logger.warn(
      {
        event: 'bridge.register.lock_contention_held',
        route: 'bridge.register',
        identifier,
        permlink,
        username,
      },
      'bridge /register lock contended; another request for this preprint is in progress',
    );
    return sendError(
      res,
      409,
      'LOCK_HELD',
      'A registration for this preprint is already in progress',
      { retriable: true },
    );
  }

  try {
    const existing = await checkExistingBridge(identifier, parsed, 'bridge.register');
    if (existing.status === 'haf_unavailable') {
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
      return assertNever(existing);
    }

    // Enqueue. Per-user cap and active-duplicate (already in queue)
    // checks happen atomically inside `tryEnqueueBridgeImport`.
    let enqueueResult;
    try {
      enqueueResult = await tryEnqueueBridgeImport({
        username,
        identifier,
        title: meta.title,
        permlink,
        discipline: discipline.trim(),
        keywords: keywords ?? [],
        language: language ?? 'en',
      });
    } catch (err) {
      logger.error(
        {
          err,
          route: 'bridge.register',
          identifier,
          username,
          permlink,
          event: 'bridge.register.enqueue_failed',
        },
        'bridge /register enqueue failed',
      );
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to enqueue bridge paper registration');
    }

    if (enqueueResult.status === 'cap_exceeded') {
      return sendError(
        res,
        429,
        'RATE_LIMITED',
        `You have ${enqueueResult.inflight} in-flight imports (cap ${enqueueResult.cap}). Submission resumes once one completes.`,
        { retriable: true, inflight: enqueueResult.inflight, cap: enqueueResult.cap },
      );
    }
    if (enqueueResult.status === 'duplicate_active') {
      // A sibling submission for the same permlink is already pending or
      // in-progress (likely a concurrent submission from the same user).
      // Return the existing in-flight entry as the canonical reference.
      return sendError(
        res,
        409,
        'DUPLICATE',
        'This preprint is already queued for import',
        {
          existing_entry_id: enqueueResult.existing.id,
          existing_entry_state: enqueueResult.existing.state,
        },
      );
    }

    // Successful enqueue. Return 202 Accepted with the entry's queue
    // position and a best-effort ETA derived from the chain cooldown.
    // Position 1 dispatches on the next worker tick (cooldown permitting);
    // each subsequent slot adds one chain-cooldown window.
    const etaSeconds = etaSecondsForPosition(enqueueResult.queuePosition);
    res.status(202).json({
      status: 'ok',
      data: {
        entry: serializeQueueRow(enqueueResult.row, enqueueResult.queuePosition),
        queue_position: enqueueResult.queuePosition,
        eta_seconds: etaSeconds,
        source: {
          type: meta.source_type,
          doi: meta.doi,
          arxiv_id: meta.arxiv_id,
          url: meta.source_url,
        },
      },
    });
  } catch (err) {
    logger.error(
      {
        err,
        route: 'bridge.register',
        identifier,
        username,
        permlink,
        event: 'bridge.register.internal_error',
      },
      'bridge /register unexpected throw — defaulted to 500',
    );
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to register bridge paper');
  } finally {
    if (lockState.state === 'acquired') {
      await releaseBridgeLock(lockKey, lockState.nonce, lockState.acquiredAtMs, 'bridge.register', permlink);
    }
  }
});

// ──────────────────────────────────────────────
// GET /api/bridge/imports
//
// Caller's own bridge import queue entries. Used by the SPA's "My imports"
// surface to render pending / in-progress / completed / failed entries
// with their reasons. Authenticated; no per-account targeting (the route
// always reads `req.hiveUsername`'s entries).
//
// The shape returned is the union of fields a UI needs to render the
// surface — entry state, attempts, scheduled_at (so the UI can show "next
// retry in N seconds"), tx_id on success, error_code+error_message on
// failure, and existing_* on permlink-collision short-circuits. It is
// documented in `agents/docs/api-contracts/bridge.md` (GET /api/bridge/imports).
// ──────────────────────────────────────────────
router.get('/imports', verifyHiveSignature, async (req: Request, res: Response) => {
  const username = req.hiveUsername!;
  const stateParam = typeof req.query.state === 'string' ? req.query.state : undefined;
  const allowedStates = ['pending', 'in_progress', 'completed', 'failed'] as const;
  let state: typeof allowedStates[number] | undefined;
  if (stateParam !== undefined) {
    const found = allowedStates.find((s) => s === stateParam);
    if (!found) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid state filter');
    }
    state = found;
  }
  // Guard the limit before it reaches SQL. A non-numeric value parses to
  // NaN, which slips past `?? 50` in listUserImports (NaN is not null) and
  // reaches `LIMIT NaN`, a Postgres error surfacing as a 500. Reject any
  // non-positive-integer up front; over-200 values are clamped downstream.
  let limit: number | undefined;
  if (typeof req.query.limit === 'string') {
    const parsed = Number(req.query.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid limit (must be a positive integer)');
    }
    limit = parsed;
  }
  try {
    const rows = await listUserImports(username, { state, limit });
    sendOk(res, {
      entries: rows.map((row) => serializeQueueRow(row, row.queue_position)),
      cap: BRIDGE_QUEUE_USER_CAP,
    });
  } catch (err) {
    logger.error(
      { err, username, route: 'bridge.imports', event: 'bridge.imports.internal_error' },
      'bridge /imports unexpected throw',
    );
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list bridge imports');
  }
});

export default router;
