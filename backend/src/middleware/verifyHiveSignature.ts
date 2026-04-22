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
  if (isRedisAvailable()) {
    try {
      const redis = getRedis()!;
      // SETNX returns 1 if key was set (new), 0 if already existed (replay)
      const result = await redis.set(`${config.appTag}:replay:${signature}`, '1', 'EX', SEEN_SIGNATURES_TTL_SEC, 'NX');
      return result === null; // null means key already existed
    } catch (err) {
      logger.warn({ err }, 'Redis replay check failed, falling back to in-memory');
    }
  }
  // In-memory fallback
  if (seenSignatures.has(signature)) return true;
  return false;
}

function recordSignatureInMemory(signature: string): void {
  seenSignatures.set(signature, Date.now());
}

declare global {
  namespace Express {
    interface Request {
      hiveUsername?: string;
      hiveCustody?: 'light' | 'self';
    }
  }
}

export async function verifyHiveSignature(req: Request, res: Response, next: NextFunction) {
  // 1. Check for Bearer JWT first
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, config.sessionSecret) as { sub: string; custody?: 'light' | 'self'; iat?: number };
      req.hiveUsername = payload.sub;
      req.hiveCustody = payload.custody || 'self';

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
            logger.warn({ err: dbErr }, 'Session invalidation check failed — allowing request');
          }
        }
      }

      return next();
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

  // Timestamp validation: enforce 60s window
  const ts = new Date(timestamp).getTime();
  if (isNaN(ts) || Math.abs(Date.now() - ts) > MAX_SIGNATURE_AGE_MS) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Request timestamp expired or invalid (must be within 60 seconds)');
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

    // Record signature in memory fallback (Redis already recorded via SETNX above)
    if (!isRedisAvailable()) recordSignatureInMemory(signature);

    req.hiveUsername = username;
    req.hiveCustody = 'self';
    next();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Signature verification failed');
    sendError(res, 401, 'UNAUTHORIZED', 'Signature verification failed');
  }
}
