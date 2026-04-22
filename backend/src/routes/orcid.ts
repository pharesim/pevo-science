import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PrivateKey } from '@hiveio/dhive';
import { config } from '../config.js';
import { hiveClient, broadcastJsonWithTimeout } from '../hive.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { getAppPool } from '../app-db.js';
import { getPool } from '../db.js';
import { T, getCachedGenesisBlock } from '../hafsql.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';

const router = Router();

// ORCID iD format: four groups of four digits separated by hyphens, with the
// last character optionally 'X' (ISO 7064 MOD 11-2 checksum token). We do not
// validate the checksum itself — ORCID validates that upstream at token
// exchange. This guard is format-only defense-in-depth to prevent a malformed
// or adversarial orcid_id from ORCID's token response being interpolated into
// Redis key builders, the pub.orcid.org API path, or on-chain custom_json
// payloads. Exploitability is bounded today (fetch host is pinned, Redis uses
// binary-safe RESP, on-chain payloads are admin-signed), but this closes the
// surface for future callers (e.g. an admin UI rendering orcid_id in HTML).
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

type OrcidMode = 'signup' | 'login' | 'accredit' | 'link';
const VALID_MODES: ReadonlySet<string> = new Set(['signup', 'login', 'accredit', 'link']);
const AUTHENTICATED_MODES: ReadonlySet<string> = new Set(['accredit', 'link']);

const ORCID_STATE_TTL = 600; // 10 minutes
const ORCID_VERIFIED_TTL = 1800; // 30 minutes
// Short TTL covers the 3-30s HAF-indexing-lag window after a successful
// accredit/link broadcast, during which findAccreditedAccountWithOrcid would
// otherwise not see the fresh binding and two concurrent binds could slip
// through. 120s is the upper bound on block-watcher catch-up under load.
const ORCID_BINDING_CACHE_TTL = 120;
// SETNX lock TTL sits above the 30s wall-clock bound enforced by
// broadcastJsonWithTimeout (see backend/src/hive.ts) so a legitimately slow
// broadcast does not lose its lock mid-flight. dhive itself does not enforce
// a per-request broadcast timeout — our helper does. The nonce-owned Lua-CAS
// release (see releaseBindingLock) closes the lock-stomp window even if the
// TTL is exceeded, but keeping the TTL above the helper-enforced bound avoids
// the failure mode entirely for honest traffic.
const ORCID_BINDING_LOCK_TTL_SECONDS = 35;
// Advertised in the lock-contention 409 Retry-After header. Not coupled to
// the lock TTL above: 10s is a realistic client backoff for "mid-broadcast
// from a different request", while the TTL bounds the worst-case hold.
const ORCID_BINDING_LOCK_RETRY_AFTER_SECONDS = 10;

// Redlock CAS release: only DEL the lock key when its value matches the nonce
// the caller acquired with. Prevents lock-stomp when holder A stalls past the
// TTL, the lock auto-expires, holder B acquires the same key, and A's finally
// runs. Without the CAS, A's stalled-then-finally DEL would delete B's lock
// and the double-broadcast this lock exists to prevent becomes possible again.
//
// Encoding contract: the Lua string-equality `KEYS[1] == ARGV[1]` is a byte-
// exact compare. The acquire path MUST keep the nonce as a printable-ASCII
// string (current: 32-char lowercase hex from crypto.randomBytes(16).toString
// ('hex')). A future refactor introducing raw buffers, base64 padding chars,
// or any non-ASCII encoding can silently break the CAS: nonces would never
// match, every release would no-op, and locks would always wait the full TTL
// instead of releasing promptly. The runtime invariant in acquireBindingLock
// enforces this at the source so a drift surfaces as a throw at acquire-time,
// not as a silent latency regression.
const RELEASE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

// Enforced at acquire-time so the Lua byte-equality contract above cannot
// drift silently. Matches the shape of crypto.randomBytes(16).toString('hex').
const LOCK_NONCE_RE = /^[0-9a-f]{32}$/;

// In-memory fallbacks when Redis is unavailable
const orcidStates = new Map<string, { mode: OrcidMode; username?: string; timestamp: number; expires: number }>();
const orcidVerified = new Map<string, { orcid_id: string; works_count: number; name: string; expires: number }>();

// Periodic cleanup of expired in-memory entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of orcidStates) {
    if (v.expires <= now) orcidStates.delete(k);
  }
  for (const [k, v] of orcidVerified) {
    if (v.expires <= now) orcidVerified.delete(k);
  }
}, 5 * 60_000);

const startLimiter = rateLimit({ name: 'orcid-start', windowMs: 60_000, max: 10, keyFn: byIp });
const callbackLimiter = rateLimit({ name: 'orcid-callback', windowMs: 60_000, max: 10, keyFn: byIp });

// Derive redirect URI at runtime (no env var needed)
function getRedirectUri(): string {
  return `${config.appUrl}/orcid/callback`;
}

// Runs verifyHiveSignature inline outside the Express middleware chain.
// Returns the authenticated username on success. Returns null when the
// middleware has already terminated the response (the caller must return
// without sending more data) — typically because auth failed. The resolve-on-
// finish listener protects against verifyHiveSignature's catch path, which
// sends an error without calling `next()` and would otherwise leave this
// Promise pending forever.
async function authenticateRequest(req: Request, res: Response): Promise<string | null> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    res.once('finish', () => settle(resolve));
    res.once('close', () => settle(resolve));
    verifyHiveSignature(req, res, (err?: unknown) => {
      settle(err ? () => reject(err) : resolve);
    });
  });
  if (res.headersSent) return null;
  const username = req.hiveUsername;
  if (!username) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required for this mode');
    return null;
  }
  return username;
}

// ─────────────────────────────────────────────────────────────
// POST /api/orcid/start — Initiate ORCID OAuth for any mode
// ─────────────────────────────────────────────────────────────

router.post('/start', startLimiter, async (req: Request, res: Response) => {
  if (!config.orcidClientId || !config.orcidClientSecret) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'ORCID integration is not configured');
  }

  const { mode } = req.body as { mode?: string };
  if (!mode || !VALID_MODES.has(mode)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'mode must be one of: signup, login, accredit, link');
  }

  // Authenticated modes require a valid session
  let username: string | undefined;
  if (AUTHENTICATED_MODES.has(mode)) {
    const authed = await authenticateRequest(req, res);
    if (!authed) return;
    username = authed;
  }

  const state = crypto.randomBytes(16).toString('hex');
  const stateKey = `${config.appTag}:orcid_state:${state}`;
  const stateData: Record<string, unknown> = { mode, timestamp: Date.now() };
  if (username) stateData.username = username;

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(stateKey, JSON.stringify(stateData), 'EX', ORCID_STATE_TTL);
  } else {
    orcidStates.set(state, {
      mode: mode as OrcidMode,
      username,
      timestamp: Date.now(),
      expires: Date.now() + ORCID_STATE_TTL * 1000,
    });
  }

  const redirectUrl = `${config.orcidBaseUrl}/oauth/authorize?` +
    `client_id=${encodeURIComponent(config.orcidClientId)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('/authenticate')}` +
    `&redirect_uri=${encodeURIComponent(getRedirectUri())}` +
    `&state=${state}`;

  sendOk(res, { redirect_url: redirectUrl });
});

// ─────────────────────────────────────────────────────────────
// POST /api/orcid/callback — Complete ORCID OAuth for any mode
// ─────────────────────────────────────────────────────────────

router.post('/callback', callbackLimiter, async (req: Request, res: Response) => {
  if (!config.orcidClientId || !config.orcidClientSecret) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'ORCID integration is not configured');
  }

  const { code, state } = req.body as { code?: string; state?: string };
  if (!code || !state) {
    return sendError(res, 400, 'BAD_REQUEST', 'code and state are required');
  }

  // State is read but not consumed until after auth passes, so a legitimate
  // initiator can retry /callback without being forced back through ORCID OAuth
  // if auth fails. The outer try/catch wraps state-read + auth + state-consume
  // + token-exchange so any infrastructure throw (Redis flap on GET/DEL, auth
  // dispatch error) becomes a clean 500 instead of an unhandled rejection; on
  // that path the DEL never runs, preserving state-not-consumed-on-error for
  // symmetry with the state-not-consumed-on-403 contract.
  const stateKey = `${config.appTag}:orcid_state:${state}`;
  const redis = getRedis();
  const redisReady = redis && isRedisAvailable();

  try {
    let storedMode: OrcidMode | null = null;
    let storedUsername: string | undefined;

    if (redisReady) {
      const raw = await redis.get(stateKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { mode: OrcidMode; username?: string };
          storedMode = parsed.mode;
          storedUsername = parsed.username;
        } catch {
          // Invalid stored state — fall through to BAD_REQUEST
        }
      }
    } else {
      const entry = orcidStates.get(state);
      if (entry && entry.expires > Date.now()) {
        storedMode = entry.mode;
        storedUsername = entry.username;
      }
    }

    if (!storedMode) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired state parameter');
    }

    // Authenticated modes: require the caller to be the same user that initiated /start.
    // Closes the state-hijack path where an attacker with a victim's state could complete
    // link/accredit with their own ORCID code and rewrite the victim's accreditation.
    if (AUTHENTICATED_MODES.has(storedMode)) {
      const callerUsername = await authenticateRequest(req, res);
      if (!callerUsername) return;
      if (callerUsername !== storedUsername) {
        return sendError(res, 403, 'FORBIDDEN', 'Callback caller does not match initiator');
      }
    }

    // Auth passed (or mode is public). Consume state now so it can't be replayed.
    if (redisReady) {
      await redis.del(stateKey);
    } else {
      orcidStates.delete(state);
    }

    // Exchange code for access token
    const tokenRes = await fetch(`${config.orcidBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.orcidClientId,
        client_secret: config.orcidClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: getRedirectUri(),
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      logger.error({ status: tokenRes.status, body: errBody }, 'ORCID token exchange failed');
      return sendError(res, 400, 'BAD_REQUEST', 'Failed to exchange authorization code');
    }

    const tokenData = await tokenRes.json() as { orcid: string; name?: string; access_token?: string };
    const orcidId = tokenData.orcid;
    if (!orcidId) {
      return sendError(res, 400, 'BAD_REQUEST', 'ORCID response missing orcid field');
    }
    if (!ORCID_RE.test(orcidId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
    }

    const orcidName = tokenData.name || '';

    // Dispatch to mode handler
    switch (storedMode) {
      case 'signup':
        return await handleSignup(res, orcidId, orcidName, tokenData.access_token);
      case 'login':
        return await handleLogin(res, orcidId);
      case 'accredit':
        return await handleAccredit(res, orcidId, orcidName, storedUsername!, tokenData.access_token);
      case 'link':
        return await handleLink(res, orcidId, storedUsername!);
    }
  } catch (err) {
    logger.error({ err }, 'ORCID callback failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'ORCID verification failed');
  }
});

// ─────────────────────────────────────────────────────────────
// Mode handlers
// ─────────────────────────────────────────────────────────────

async function handleSignup(
  res: Response,
  orcidId: string,
  orcidName: string,
  accessToken?: string,
): Promise<void> {
  const externalWorksCount = await countExternalWorks(orcidId, accessToken);

  if (externalWorksCount < config.orcidMinWorks) {
    sendError(res, 422, 'VALIDATION_ERROR',
      `ORCID profile has ${externalWorksCount} externally-sourced work(s), but at least ${config.orcidMinWorks} are required`);
    return;
  }

  // Store verified ORCID data with nonce
  const nonce = crypto.randomBytes(16).toString('hex');
  const verifiedData = { orcid_id: orcidId, works_count: externalWorksCount, name: orcidName };

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(verifiedData), 'EX', ORCID_VERIFIED_TTL);
  } else {
    orcidVerified.set(nonce, { ...verifiedData, expires: Date.now() + ORCID_VERIFIED_TTL * 1000 });
  }

  sendOk(res, {
    mode: 'signup',
    orcid_token: nonce,
    orcid_id: orcidId,
    works_count: externalWorksCount,
    name: orcidName,
  });
}

async function handleLogin(res: Response, orcidId: string): Promise<void> {
  if (!ORCID_RE.test(orcidId)) {
    sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
    return;
  }

  const pool = getAppPool();
  if (!pool) {
    sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');
    return;
  }

  const result = await pool.query<{ username: string; custody: string }>(
    `SELECT username, custody FROM accounts WHERE orcid = $1 AND username IS NOT NULL LIMIT 1`,
    [orcidId],
  );

  if (result.rows.length === 0) {
    // `orcid_id` must live inside `error.details` so it survives the ApiError
    // envelope. Top-level siblings are not part of the envelope contract and
    // get dropped by strict parsers.
    sendError(res, 404, 'NO_ACCOUNT', 'No account linked to this ORCID. Please sign up first.', { orcid_id: orcidId });
    return;
  }

  const account = result.rows[0];
  const token = jwt.sign(
    { sub: account.username, custody: account.custody || 'light' },
    config.sessionSecret,
    { expiresIn: '24h' },
  );
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  sendOk(res, {
    mode: 'login',
    token,
    expires_at: expiresAt,
    custody: account.custody || 'light',
    username: account.username,
  });
}

async function handleAccredit(
  res: Response,
  orcidId: string,
  orcidName: string,
  username: string,
  accessToken?: string,
): Promise<void> {
  if (!ORCID_RE.test(orcidId)) {
    sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
    return;
  }

  // Check if already accredited
  const { getAccreditedSet } = await import('../accreditation.js');
  const accreditedSet = await getAccreditedSet([username]);
  if (accreditedSet.has(username)) {
    sendError(res, 422, 'VALIDATION_ERROR', 'Account is already accredited');
    return;
  }

  const externalWorksCount = await countExternalWorks(orcidId, accessToken);

  if (externalWorksCount < config.orcidMinWorks) {
    sendError(res, 422, 'VALIDATION_ERROR',
      `ORCID profile has ${externalWorksCount} externally-sourced work(s), but at least ${config.orcidMinWorks} are required`);
    return;
  }

  if (!config.pevoAdminPostingKey) {
    sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
    return;
  }

  const existingBinding = await findAccreditedAccountWithOrcid(orcidId);
  if (existingBinding && existingBinding !== username) {
    // Durable-binding 409: the ORCID is bound to another account on-chain or
    // in the HAF-lag cache. Not retriable; the caller must rebind via that
    // account or wait for a revoke. Contract omits `retriable` to distinguish
    // from the transient lock-contention 409 emitted by withOrcidBindingLock.
    sendError(res, 409, 'ORCID_ALREADY_LINKED', 'This ORCID is already linked to another account');
    return;
  }

  await withOrcidBindingLock(res, orcidId, async () => {
    const customJsonPayload = {
      action: 'accredit',
      account: username,
      name: orcidName || username,
      institution: '',
      field: '',
      method: 'orcid',
      orcid: orcidId,
      evidence_hash: crypto.createHash('sha256').update(`orcid:${orcidId}:${username}`).digest('hex'),
      timestamp: new Date().toISOString(),
    };

    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    const result = await broadcastJsonWithTimeout(
      { id: config.appTag, json: JSON.stringify(customJsonPayload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );

    // Cache the binding so a concurrent bind request in the HAF-lag window sees
    // it via findAccreditedAccountWithOrcid() before the chain op is indexed.
    await cacheOrcidBinding(orcidId, username);

    // Update orcid column in accounts (if light account row exists)
    await updateAccountOrcid(username, orcidId);

    sendOk(res, {
      mode: 'accredit',
      message: 'Accreditation via ORCID confirmed',
      username,
      orcid: orcidId,
      tx_id: result.id,
    });
  });
}

async function handleLink(
  res: Response,
  orcidId: string,
  username: string,
): Promise<void> {
  if (!ORCID_RE.test(orcidId)) {
    sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
    return;
  }

  // Fetch existing accreditation to preserve fields
  const existing = await getExistingAccreditation(username);
  if (!existing) {
    sendError(res, 422, 'VALIDATION_ERROR', 'Account is not accredited');
    return;
  }

  if (!config.pevoAdminPostingKey) {
    sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
    return;
  }

  const existingBinding = await findAccreditedAccountWithOrcid(orcidId);
  if (existingBinding && existingBinding !== username) {
    // Durable-binding 409. See handleAccredit counterpart for contract notes.
    sendError(res, 409, 'ORCID_ALREADY_LINKED', 'This ORCID is already linked to another account');
    return;
  }

  await withOrcidBindingLock(res, orcidId, async () => {
    const customJsonPayload = {
      action: 'accredit',
      account: username,
      name: existing.name,
      institution: existing.institution,
      field: existing.field,
      method: existing.method,
      orcid: orcidId,
      evidence_hash: crypto.createHash('sha256').update(`orcid:${orcidId}:${username}`).digest('hex'),
      timestamp: new Date().toISOString(),
    };

    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    const result = await broadcastJsonWithTimeout(
      { id: config.appTag, json: JSON.stringify(customJsonPayload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );

    // Cache the binding so a concurrent bind request in the HAF-lag window sees
    // it via findAccreditedAccountWithOrcid() before the chain op is indexed.
    await cacheOrcidBinding(orcidId, username);

    // Update orcid column in accounts (if light account row exists)
    await updateAccountOrcid(username, orcidId);

    sendOk(res, {
      mode: 'link',
      message: 'ORCID linked successfully',
      username,
      orcid: orcidId,
      tx_id: result.id,
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────

function orcidBindingCacheKey(orcidId: string): string {
  return `${config.appTag}:orcid_binding:${orcidId}`;
}

function orcidBindingLockKey(orcidId: string): string {
  return `${config.appTag}:orcid_binding_lock:${orcidId}`;
}

// Discriminator returned by acquireBindingLock. The 'acquired' variant
// carries the per-acquisition nonce that releaseBindingLock compares against
// under the Redlock CAS contract.
type BindingLockState =
  | { state: 'acquired'; nonce: string }
  | { state: 'held' }
  | { state: 'unavailable' };

// SETNX-lock acquisition keyed on orcid_id. Closes the same-event-loop-tick
// TOCTOU race that the orcid_binding cache alone cannot: the cache is written
// only AFTER broadcast returns, so two concurrent bind requests for the same
// orcid_id (different usernames) can both pass the empty-binding check, both
// broadcast, and both write their own cache entries. The lock is claimed
// BEFORE broadcast; the loser gets 409. EX=35s bounds the hold — above the
// 30s dhive timeout so a slow-but-alive broadcast does not lose its lock.
//
// Lock value is a per-acquisition random nonce (NOT the username) so the
// nonce-owned Lua-CAS release in releaseBindingLock distinguishes holders.
// Usernames alone cannot: the same user racing two tabs shares a username but
// needs distinct ownership identities for the TTL-expired-then-stomp scenario.
//
// Returns a discriminated union:
//   { state: 'acquired', nonce } — caller holds the lock; must call
//                                  releaseBindingLock(orcidId, nonce) later.
//   { state: 'held' }            — another request holds the lock; caller
//                                  must surface 409.
//   { state: 'unavailable' }     — Redis down or threw; caller degrades to
//                                  the cache-less HAF-only path (accept the
//                                  narrow race in degraded mode rather than
//                                  failing closed). A warn has been logged.
async function acquireBindingLock(orcidId: string): Promise<BindingLockState> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return { state: 'unavailable' };
  const nonce = crypto.randomBytes(16).toString('hex');
  // Runtime invariant: RELEASE_LOCK_LUA compares stored value byte-for-byte
  // under Lua string equality. If a future refactor changes the nonce encoding
  // away from printable-ASCII hex, the CAS would silently never match. Throw
  // here so the drift surfaces at acquire-time rather than as locks that never
  // release before TTL.
  if (typeof nonce !== 'string' || !LOCK_NONCE_RE.test(nonce)) {
    throw new Error('orcid binding lock nonce shape invariant violated');
  }
  try {
    const result = await redis.set(
      orcidBindingLockKey(orcidId),
      nonce,
      'EX',
      ORCID_BINDING_LOCK_TTL_SECONDS,
      'NX',
    );
    if (result === 'OK') return { state: 'acquired', nonce };
    return { state: 'held' };
  } catch (err) {
    logger.warn({ err, orcidId }, 'ORCID binding lock acquisition failed — degrading to HAF-only path');
    return { state: 'unavailable' };
  }
}

// Release via Lua CAS: only DEL when the current value equals our nonce.
// See RELEASE_LOCK_LUA comment for why the CAS matters (lock-stomp window).
async function releaseBindingLock(orcidId: string, nonce: string): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, orcidBindingLockKey(orcidId), nonce);
  } catch (err) {
    // Best-effort release. On failure the lock self-expires after the TTL.
    logger.warn({ err, orcidId }, 'Failed to release ORCID binding lock');
  }
}

/**
 * Acquire → run → release wrapper for the ORCID binding lock. Encapsulates
 * the acquire/try/finally scaffolding that handleAccredit and handleLink
 * otherwise duplicate, and makes the nonce flow internal so callers can't
 * accidentally call releaseBindingLock with the wrong nonce.
 *
 * Behavior per lock state:
 *   'held'        — wrapper sends 409 ORCID_ALREADY_LINKED with Retry-After
 *                   header and details.retriable=true; callback is NOT run.
 *   'acquired'    — callback runs inside try/finally; release happens under
 *                   nonce CAS in finally (success and throw paths both release).
 *   'unavailable' — callback runs WITHOUT a lock (Redis-optional degrade to
 *                   cache-less HAF-only path); no release needed.
 *
 * The wrapper swallows no exceptions from `fn`; they propagate to the outer
 * /callback try/catch which maps them to 500 INTERNAL_ERROR.
 *
 * IMPORTANT — response-sending contract: on the 'held' state the wrapper sends
 * the 409 response itself. Callers MUST NOT send another response after the
 * await returns, regardless of lock state. Today both callers (handleAccredit,
 * handleLink) have no code after `await withOrcidBindingLock(...)` and are
 * safe; a future caller that appends post-await logic risks a double-send /
 * "Cannot set headers after they are sent" crash. If post-await work is ever
 * needed, move it INSIDE the `fn` callback, or refactor the wrapper to return
 * a discriminator instead of sending the 409 directly.
 */
async function withOrcidBindingLock(
  res: Response,
  orcidId: string,
  fn: () => Promise<void>,
): Promise<void> {
  const lock = await acquireBindingLock(orcidId);
  if (lock.state === 'held') {
    res.setHeader('Retry-After', String(ORCID_BINDING_LOCK_RETRY_AFTER_SECONDS));
    sendError(
      res,
      409,
      'ORCID_ALREADY_LINKED',
      'This ORCID is currently being linked by another request',
      { retriable: true, retry_after_seconds: ORCID_BINDING_LOCK_RETRY_AFTER_SECONDS },
    );
    return;
  }
  try {
    await fn();
  } finally {
    if (lock.state === 'acquired') await releaseBindingLock(orcidId, lock.nonce);
  }
}

/**
 * Cache the ORCID → username binding for the HAF-indexing-lag window.
 * Best-effort: swallow Redis errors (availability over consistency; the HAF
 * path remains the source of truth once the chain op is indexed).
 */
async function cacheOrcidBinding(orcidId: string, username: string): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.set(orcidBindingCacheKey(orcidId), username, 'EX', ORCID_BINDING_CACHE_TTL);
  } catch (err) {
    // Keep the swallow (availability over consistency; HAF is authoritative)
    // but emit at error-level so persistent failures surface on the pager. A
    // sustained Redis cache-write outage silently degrades the 120s HAF-lag
    // TOCTOU protection: a concurrent bind arriving before HAF indexes the op
    // will see neither cache nor HAF and can slip past the 409 guard. warn
    // level typically isn't paged; error is the right tier for "mitigation is
    // degraded, investigate the Redis path." Behavior unchanged (still swallows
    // per availability-over-consistency contract).
    logger.error(
      { err, orcidId, username },
      'orcid binding cache write failed — HAF-lag TOCTOU window may be longer than expected',
    );
  }
}

/**
 * Look up the recent-binding cache for an ORCID.
 * Returns the cached username, or null when no entry exists or Redis is
 * unavailable. Caller falls back to HAF on null. On a transient Redis read
 * error the service degrades gracefully: HAF remains authoritative and the
 * 409 guard still fires once the op is indexed.
 */
async function getCachedOrcidBinding(orcidId: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return null;
  try {
    return await redis.get(orcidBindingCacheKey(orcidId));
  } catch (err) {
    logger.warn({ err, orcidId }, 'Failed to read ORCID binding cache');
    return null;
  }
}

async function countExternalWorks(orcidId: string, _accessToken?: string): Promise<number> {
  const worksRes = await fetch(`https://pub.orcid.org/v3.0/${orcidId}/works`, {
    headers: { Accept: 'application/json' },
  });

  if (!worksRes.ok) {
    logger.error({ status: worksRes.status, orcidId }, 'ORCID works fetch failed');
    throw new Error('Failed to fetch ORCID works');
  }

  const worksData = await worksRes.json() as {
    group?: Array<{
      'work-summary'?: Array<{
        source?: { 'source-orcid'?: { path?: string } };
      }>;
    }>;
  };

  // Count works where source ORCID differs from profile owner (externally sourced).
  // Self-asserted works have source-orcid.path === the profile owner's ORCID iD.
  // External sources (Crossref, Scopus, DataCite) have a different source-orcid.path.
  let count = 0;
  if (worksData.group) {
    for (const group of worksData.group) {
      const summaries = group['work-summary'] || [];
      const hasExternalSource = summaries.some((s) => {
        const sourceOrcid = s.source?.['source-orcid']?.path;
        return sourceOrcid && sourceOrcid !== orcidId;
      });
      if (hasExternalSource) count++;
    }
  }
  return count;
}

async function findAccreditedAccountWithOrcid(orcidId: string): Promise<string | null> {
  // Cache-first: check the recent-binding cache before HAF. Closes the
  // 3-30s HAF-indexing-lag TOCTOU window where two concurrent bind requests
  // for the same ORCID could both pass findAccreditedAccountWithOrcid() before
  // either had been indexed. The cache is written by handleAccredit / handleLink
  // right after broadcast. On Redis outage we fall through to the HAF path so
  // the service stays available (Redis is optional by design).
  const cached = await getCachedOrcidBinding(orcidId);
  if (cached) return cached;

  const pool = getPool();
  // Fail closed when HAF is unavailable: returning null would silently bypass
  // the 409 duplicate-bind guard in handleAccredit/handleLink and let the admin
  // key sign two accreditations for the same ORCID. The outer try/catch in
  // /callback maps the throw to a 500.
  if (!pool) throw new Error('HAF unavailable — cannot verify ORCID binding');

  // Latest authorized on-chain accredit op carrying this ORCID. Filter by
  // accreditationAuthorities so a self-broadcast custom_json can't poison the check.
  const recent = await pool.query<{ account: string | null }>(
    `SELECT cj.json::jsonb ->> 'account' AS account
     FROM ${T.customJson} cj
     WHERE cj.custom_id = $2
       AND cj.json::jsonb ->> 'action' = 'accredit'
       AND cj.json::jsonb ->> 'orcid' = $1
       AND cj.required_posting_auths ?| $4::text[]
       AND cj.block_num >= $3
     ORDER BY cj.block_num DESC
     LIMIT 1`,
    [orcidId, config.appTag, getCachedGenesisBlock(), config.accreditationAuthorities],
  );
  if (recent.rows.length === 0) return null;
  const account = recent.rows[0].account;
  if (!account) return null;

  // Re-check the account's latest authorized action. The binding is live only
  // if that action is still an 'accredit' carrying THIS orcid; a subsequent
  // 'revoke' clears it, and a subsequent 'accredit' with a different orcid
  // means the account rebound to another identity (freeing this orcid).
  const status = await pool.query<{ action: string | null; orcid: string | null }>(
    `SELECT cj.json::jsonb ->> 'action' AS action,
            cj.json::jsonb ->> 'orcid' AS orcid
     FROM ${T.customJson} cj
     WHERE cj.custom_id = $2
       AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
       AND cj.json::jsonb ->> 'account' = $1
       AND cj.required_posting_auths ?| $4::text[]
       AND cj.block_num >= $3
     ORDER BY cj.block_num DESC
     LIMIT 1`,
    [account, config.appTag, getCachedGenesisBlock(), config.accreditationAuthorities],
  );
  if (status.rows.length === 0) return null;
  const latest = status.rows[0];
  if (latest.action !== 'accredit' || latest.orcid !== orcidId) return null;
  return account;
}

async function getExistingAccreditation(username: string): Promise<{
  name: string; institution: string; field: string; method: string; orcid?: string;
} | null> {
  const pool = getPool();
  if (!pool) return null;

  // Filter by accreditationAuthorities so a self-broadcast custom_json (signed
  // by the target account's own posting key) cannot masquerade as a real
  // accreditation and unlock the /link flow. See SEC-AUTH-BYPASS.
  const result = await pool.query(
    `SELECT cj.json FROM ${T.customJson} cj
     WHERE cj.custom_id = $2
       AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
       AND cj.json::jsonb ->> 'account' = $1
       AND cj.required_posting_auths ?| $4::text[]
       AND cj.block_num >= $3
     ORDER BY cj.block_num DESC
     LIMIT 1`,
    [username, config.appTag, getCachedGenesisBlock(), config.accreditationAuthorities],
  );
  if (result.rows.length === 0) return null;

  const payload = typeof result.rows[0].json === 'string'
    ? JSON.parse(result.rows[0].json)
    : result.rows[0].json;

  if (payload.action === 'revoke') return null;
  return {
    name: payload.name || username,
    institution: payload.institution || '',
    field: payload.field || '',
    method: payload.method || 'email',
    orcid: payload.orcid || undefined,
  };
}

async function updateAccountOrcid(username: string, orcidId: string): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE accounts SET orcid = $1 WHERE username = $2`,
      [orcidId, username],
    );
  } catch (err) {
    logger.warn({ err, username }, 'Failed to update accounts.orcid (row may not exist for self-custody user)');
  }
}

// Export the in-memory verified map so auth.ts signup can consume nonces
export { orcidVerified };

// Test-only exports: SEC-002-TOCTOU-LOCK Lua CAS multi-holder correctness is
// the primary safety property of the Redlock release path, but the other
// specs only exercise it indirectly (self-release on success, self-release on
// broadcast throw, TTL expiry). Expose the release helper so a unit spec can
// assert that releaseBindingLock(orcidId, wrongNonce) refuses to delete a lock
// held under a different nonce. A regression to plain DEL (no CAS) would pass
// every other spec in the file but fail this one. NOT for production import.
export { releaseBindingLock as __test_releaseBindingLock };

export default router;
