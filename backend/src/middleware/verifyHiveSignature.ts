import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Signature, PublicKey, cryptoUtils } from '@hiveio/dhive';
import { hiveClient } from '../hive.js';
import { sendError } from '../response.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * Middleware that verifies a Hive Keychain signature.
 *
 * Expects headers:
 *   X-Hive-Username:  the Hive account name
 *   X-Hive-Signature: hex-encoded signature of the message
 *   X-Hive-Message:   the original message that was signed (optional — defaults to request body hash)
 *   X-Hive-Timestamp: ISO 8601 timestamp of when the message was signed (required for replay prevention)
 *
 * Attaches `req.hiveUsername` on success.
 */

const MAX_SIGNATURE_AGE_MS = 60_000; // 60 seconds
const SEEN_SIGNATURES_TTL_MS = 5 * 60_000; // 5 minutes

// In-memory replay cache (replaced by Redis in production via rateLimit)
const seenSignatures = new Map<string, number>();

// Cleanup interval
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [sig, ts] of seenSignatures) {
    if (now - ts > SEEN_SIGNATURES_TTL_MS) seenSignatures.delete(sig);
  }
}, 60_000);
cleanupInterval.unref();

declare global {
  namespace Express {
    interface Request {
      hiveUsername?: string;
    }
  }
}

export async function verifyHiveSignature(req: Request, res: Response, next: NextFunction) {
  // 1. Check for Bearer JWT first
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, config.sessionSecret) as { sub: string };
      req.hiveUsername = payload.sub;
      return next();
    } catch (err) {
      logger.debug({ err }, 'JWT verification failed, falling back to Hive signature check');
    }
  }

  // 2. Existing Hive signature verification
  const username = req.headers['x-hive-username'] as string | undefined;
  const signature = req.headers['x-hive-signature'] as string | undefined;
  const message = req.headers['x-hive-message'] as string | undefined;
  const timestamp = req.headers['x-hive-timestamp'] as string | undefined;

  if (!username || !signature) {
    return sendError(res, 401, 'UNAUTHORIZED', 'X-Hive-Username and X-Hive-Signature headers are required');
  }

  // Replay prevention: reject if we've seen this exact signature recently
  if (seenSignatures.has(signature)) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Signature already used — replay rejected');
  }

  // Timestamp validation: if provided, enforce 60s window
  if (timestamp) {
    const ts = new Date(timestamp).getTime();
    if (isNaN(ts) || Math.abs(Date.now() - ts) > MAX_SIGNATURE_AGE_MS) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Request timestamp expired or invalid (must be within 60 seconds)');
    }
  }

  try {
    // Fetch the account's public posting key from the chain
    const [account] = await hiveClient.database.getAccounts([username]);
    if (!account) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Hive account not found');
    }

    const postingPubKeys = account.posting.key_auths.map(([key]) => key.toString());

    // Build the message to verify.
    // If X-Hive-Message is provided, use it directly (for Keychain flows that sign custom messages).
    // Otherwise, bind to the request: method + path + timestamp + body hash.
    let msgToVerify: string;
    if (message) {
      msgToVerify = message;
    } else {
      const bodyHash = cryptoUtils.sha256(JSON.stringify(req.body || '')).toString('hex');
      const parts = [req.method, req.path, bodyHash];
      if (timestamp) parts.push(timestamp);
      msgToVerify = parts.join(':');
    }

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

    // Record signature to prevent replay
    seenSignatures.set(signature, Date.now());

    req.hiveUsername = username;
    next();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Signature verification failed');
    sendError(res, 401, 'UNAUTHORIZED', 'Signature verification failed');
  }
}
