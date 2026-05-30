import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Signature, cryptoUtils } from '@hiveio/dhive';
import { hiveClient } from '../hive.js';
import { sendError } from '../response.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { getAppPool } from '../app-db.js';
import { buildCanonicalAuthMessage } from '../lib/authMessage.js';

/**
 * Middleware that verifies a Hive Keychain signature.
 *
 * Expects headers:
 *   X-Hive-Username:  the Hive account name
 *   X-Hive-Signature: hex-encoded signature of the request-bound message
 *   X-Hive-Timestamp: ISO 8601 timestamp of when the message was signed (required)
 *
 * The signed message must be request-bound in this exact format:
 *   {APP_TAG}-auth|v1|{METHOD}|{path}|{sha256_hex(body)}|{timestamp}
 *
 * where path is req.originalUrl minus any query string (e.g. /api/auth/session
 * rather than router-relative /session), and body is JSON.stringify(req.body || {}).
 * This prevents cross-dApp, cross-deployment, cross-endpoint, and body-tamper
 * replay attacks.
 *
 * Attaches `req.hiveUsername` on success.
 */

const MAX_SIGNATURE_AGE_MS = 60_000; // 60 seconds
// Small forward-skew tolerance for client clock drift. The accepted window is
// past-biased: [Date.now() - MAX_SIGNATURE_AGE_MS, Date.now() + SIGNATURE_FUTURE_SKEW_MS].
// Mirrors the custody upgrade-proof timestamp form so the two auth paths agree.
const SIGNATURE_FUTURE_SKEW_MS = 5_000;
const SEEN_SIGNATURES_TTL_SEC = 300; // 5 minutes

// In-memory replay cache — fallback when Redis is unavailable
const seenSignatures = new Map<string, number>();

// Cleanup interval for in-memory fallback
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [sig, ts] of seenSignatures) {
    if (now - ts > SEEN_SIGNATURES_TTL_SEC * 1000) seenSignatures.delete(sig);
  }
}, 60_000);
cleanupInterval.unref();

async function isReplaySignature(signature: string): Promise<boolean> {
  // The in-memory store is an UNCONDITIONAL backstop: a signature recorded on a
  // prior successful verification must be detected regardless of Redis state on
  // EITHER request. Reading it only on the Redis-down/throw branch missed the
  // throw-then-recover ordering — request 1's SETNX throws (so the Redis key is
  // never written), the sig lives only in seenSignatures; Redis recovers; then
  // request 2's SETNX succeeds against the now-absent key and reports "new". OR-ing
  // the in-memory hit with the Redis result closes that window. Pairs with the
  // unconditional recordSignatureInMemory on the success path.
  const seenInMemory = seenSignatures.has(signature);
  if (isRedisAvailable()) {
    try {
      const redis = getRedis()!;
      // SETNX returns null if the key already existed (replay), non-null if new.
      const result = await redis.set(`${config.appTag}:replay:${signature}`, '1', 'EX', SEEN_SIGNATURES_TTL_SEC, 'NX');
      return result === null || seenInMemory;
    } catch (err) {
      logger.warn({ err }, 'Redis replay check failed, falling back to in-memory');
    }
  }
  return seenInMemory;
}

function recordSignatureInMemory(signature: string): void {
  seenSignatures.set(signature, Date.now());
}

declare global {
  namespace Express {
    interface Request {
      hiveUsername?: string;
      hiveCustody?: 'light' | 'self';
      /**
       * Which auth path successfully authenticated this request:
       *   - `'jwt'`       : Bearer JWT verified by `jsonwebtoken`.
       *   - `'signature'` : per-request Hive signature recovered + key-matched.
       *
       * Set only on the success branches of `verifyHiveSignature`. Route
       * handlers that need to discriminate "replayable bearer token" from
       * "fresh per-request signed message" (e.g., to require a body-level
       * `fresh_auth_proof` only on the JWT path) read this field instead of
       * re-parsing `req.headers['authorization']` themselves. Per-request
       * Hive signatures are timestamp + replay-bounded inside this
       * middleware and are themselves fresh proof; JWTs are not.
       */
      hiveAuthMethod?: 'jwt' | 'signature';
    }
  }
}

export async function verifyHiveSignature(req: Request, res: Response, next: NextFunction) {
  // 1. Check for Bearer JWT first
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, config.sessionSecret) as { sub?: unknown; custody?: 'light' | 'self' | null; iat?: number };
      // Runtime guard: the `as` cast does not validate `sub`. A JWT with
      // `sub` absent or non-string would otherwise set
      // `req.hiveUsername = undefined` and call `next()`, leaving the
      // request "authenticated" with no username. Reject the JWT path
      // and fall through to the Hive-signature branch (which 401s if no
      // signature headers are present).
      if (typeof payload.sub === 'string' && payload.sub.length > 0) {
        req.hiveUsername = payload.sub;
        req.hiveCustody = payload.custody || 'self';
        req.hiveAuthMethod = 'jwt';

        // Check session invalidation for light accounts (password reset invalidates all prior JWTs)
        if (payload.iat) {
          const pool = getAppPool();
          if (pool) {
            try {
              const { rows } = await pool.query<{ sessions_invalidated_at: Date | null }>(
                'SELECT sessions_invalidated_at FROM accounts WHERE username = $1',
                [payload.sub],
              );
              if (rows.length > 0 && rows[0].sessions_invalidated_at) {
                const invalidatedAt = Math.floor(rows[0].sessions_invalidated_at.getTime() / 1000);
                if (payload.iat < invalidatedAt) {
                  return sendError(res, 401, 'SESSION_INVALIDATED', 'Session has been invalidated. Please log in again.');
                }
              }
            } catch (dbErr) {
              // Fail closed: the session-invalidation lookup is the revocation
              // mechanism for stolen JWTs (password reset, key rotation). Honoring
              // the JWT on a DB hiccup silently re-grants every previously-revoked
              // token for the outage's duration. PEvO is single-instance, so a
              // Postgres blip is whole-product downtime, not a load-balanced edge —
              // 503 (retry) is the correct posture, not allow-through.
              logger.error({ err: dbErr }, 'Session invalidation check failed');
              return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Session check temporarily unavailable. Please retry.');
            }
          }
        }

        return next();
      }
      logger.debug('JWT missing or non-string sub claim, falling back to Hive signature check');
    } catch (err) {
      logger.debug({ err }, 'JWT verification failed, falling back to Hive signature check');
    }
  }

  // 2. Existing Hive signature verification
  const username = req.headers['x-hive-username'] as string | undefined;
  const signature = req.headers['x-hive-signature'] as string | undefined;
  const timestamp = req.headers['x-hive-timestamp'] as string | undefined;

  if (!username || !signature) {
    return sendError(res, 401, 'UNAUTHORIZED', 'X-Hive-Username and X-Hive-Signature headers are required');
  }

  if (!timestamp) {
    return sendError(res, 401, 'UNAUTHORIZED', 'X-Hive-Timestamp is required');
  }

  // Replay prevention: reject if we've seen this exact signature recently
  if (await isReplaySignature(signature)) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Signature already used — replay rejected');
  }

  // Timestamp validation: past-biased 60s window with a small forward-skew
  // tolerance. The absolute-value form previously accepted timestamps up to 60s
  // in the future as well, doubling a signature's effective usability window to
  // ~120s. Reject anything beyond the forward skew or older than the max age.
  const ts = new Date(timestamp).getTime();
  if (isNaN(ts) || ts > Date.now() + SIGNATURE_FUTURE_SKEW_MS || Date.now() - ts > MAX_SIGNATURE_AGE_MS) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Request timestamp expired or invalid (must be within 60 seconds).');
  }

  try {
    // Fetch the account's public posting key from the chain
    const [account] = await hiveClient.database.getAccounts([username]);
    if (!account) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Hive account not found');
    }

    const postingPubKeys = account.posting.key_auths.map(([key]) => key.toString());

    // Request-bound signed message with domain separator, assembled by the shared
    // helper so the frontend equivalence test drives both sides from one source.
    // path is req.originalUrl minus query string — the URL the client signs,
    // not req.path which is relative to the sub-router mount point.
    const fullPath = req.originalUrl.split('?')[0];
    const msgToVerify = buildCanonicalAuthMessage({
      appTag: config.appTag,
      method: req.method,
      path: fullPath,
      body: req.body,
      timestamp,
    });

    const msgHash = cryptoUtils.sha256(msgToVerify);
    const sig = Signature.fromString(signature);
    const recoveredKey = sig.recover(msgHash).toString();

    // Timing-safe comparison: compare each posting key with constant-time equality
    let keyMatch = false;
    for (const pubKey of postingPubKeys) {
      const a = Buffer.from(pubKey);
      const b = Buffer.from(recoveredKey);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        keyMatch = true;
        break;
      }
    }

    if (!keyMatch) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid signature — does not match account posting key');
    }

    // Always record in the in-memory store after a successful verification, even
    // when Redis is the primary replay guard. If Redis is `ready` but a later
    // SETNX throws (network blip, command timeout, OOM eviction), isReplaySignature
    // falls back to this store — which only detects the replay if the signature was
    // recorded here on the original request, regardless of Redis state at the time.
    recordSignatureInMemory(signature);

    req.hiveUsername = username;
    req.hiveCustody = 'self';
    req.hiveAuthMethod = 'signature';
    next();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Signature verification failed');
    sendError(res, 401, 'UNAUTHORIZED', 'Signature verification failed');
  }
}
