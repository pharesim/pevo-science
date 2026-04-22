import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { PrivateKey } from '@hiveio/dhive';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { sendOk, sendError } from '../response.js';
import { config } from '../config.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { getAppPool } from '../app-db.js';
import { broadcastSendOperationsWithTimeout } from '../hive.js';
import { decryptKey } from '../custody-crypto.js';
import { logCustodyBroadcast } from '../custody-audit.js';
import { logger } from '../logger.js';
import { runWithArgon2Slot } from '../lib/argon2-semaphore.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';

const router = Router();

// Allowed Hive operations for custodial broadcast
const ALLOWED_OPS = new Set(['comment', 'vote', 'custom_json']);

const broadcastLimiter = rateLimit({ name: 'custody-broadcast', windowMs: 60_000, max: 30, keyFn: byAccount });
const upgradeLimiter = rateLimit({ name: 'custody-upgrade', windowMs: 3_600_000, max: 1, keyFn: byAccount });

// ─────────────────────────────────────────────────────────────
// POST /api/custody/broadcast — Sign and broadcast operations for light accounts (LA9)
// ─────────────────────────────────────────────────────────────
router.post('/broadcast', verifyHiveSignature, broadcastLimiter, async (req: Request, res: Response) => {
  const username = req.hiveUsername;
  const custody = req.hiveCustody;

  if (!username) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  // Only light (custodial) accounts can use this endpoint
  if (custody !== 'light') {
    return sendError(res, 403, 'FORBIDDEN', 'This endpoint is only for custodial accounts. Use Hive Keychain to sign transactions.');
  }

  const { operations } = req.body || {};
  if (!Array.isArray(operations) || operations.length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Operations array is required');
  }

  // Validate each operation
  for (const op of operations) {
    if (!Array.isArray(op) || op.length !== 2) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Each operation must be a [type, params] tuple');
    }

    const [opType, opParams] = op;

    // Check operation is in allowlist
    if (!ALLOWED_OPS.has(opType)) {
      return sendError(res, 403, 'FORBIDDEN', `Operation '${opType}' is not allowed for custodial accounts`);
    }

    // Enforce author/voter matches JWT subject
    if (opType === 'comment') {
      if (opParams.author !== username) {
        return sendError(res, 403, 'FORBIDDEN', `Comment author must be '${username}'`);
      }
      // Validate app tag in json_metadata
      try {
        const meta = typeof opParams.json_metadata === 'string'
          ? JSON.parse(opParams.json_metadata)
          : opParams.json_metadata;
        if (!meta.app || !String(meta.app).startsWith(config.appTag)) {
          return sendError(res, 400, 'VALIDATION_ERROR', `json_metadata.app must start with '${config.appTag}'`);
        }
      } catch {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid json_metadata');
      }
    } else if (opType === 'vote') {
      if (opParams.voter !== username) {
        return sendError(res, 403, 'FORBIDDEN', `Voter must be '${username}'`);
      }
    } else if (opType === 'custom_json') {
      // Only allow revote custom_json, and enforce sender is the authenticated user
      const auths = opParams.required_posting_auths;
      if (!Array.isArray(auths) || auths.length !== 1 || auths[0] !== username) {
        return sendError(res, 403, 'FORBIDDEN', `required_posting_auths must be ['${username}']`);
      }
      if (opParams.id !== config.appTag) {
        return sendError(res, 400, 'VALIDATION_ERROR', `custom_json id must be '${config.appTag}'`);
      }
      try {
        const payload = typeof opParams.json === 'string' ? JSON.parse(opParams.json) : opParams.json;
        const allowedActions = ['revote', 'claim_authorship', 'approve_authorship', 'revoke_authorship'];
        if (!allowedActions.includes(payload.action)) {
          return sendError(res, 403, 'FORBIDDEN', `Only ${allowedActions.join(', ')} custom_json actions are allowed for custodial accounts`);
        }
      } catch {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid custom_json payload');
      }
    }
  }

  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  try {
    // Fetch and decrypt the posting key
    const { rows } = await pool.query<{
      posting_key_enc: Buffer;
      iv_posting: Buffer;
      upgraded_at: string | null;
    }>(
      'SELECT posting_key_enc, iv_posting, upgraded_at FROM accounts WHERE username = $1',
      [username],
    );

    if (rows.length === 0) {
      // 401, not 404 — authed endpoint, missing-own-row ≡ stale session
      // (especially relevant for light-account Bearer JWTs that may outlive
      // the underlying account row).
      return sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
    }

    const account = rows[0];
    if (account.upgraded_at) {
      return sendError(res, 403, 'FORBIDDEN', 'Account has been upgraded to self-custody. Use Hive Keychain.');
    }

    if (!account.posting_key_enc || !account.iv_posting) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Posting key not available');
    }

    // Decrypt key — held in memory only for this request
    const postingKeyWif = decryptKey(username, account.posting_key_enc, account.iv_posting);
    const key = PrivateKey.fromString(postingKeyWif);

    // Broadcast. Scoped try/catch so BroadcastTimeoutError is discriminated
    // into a 504 envelope via handleBroadcastError, and non-timeout chain
    // errors land in a 502 envelope. Non-broadcast errors (db, decrypt,
    // key parse) fall through to the outer 500 INTERNAL_ERROR.
    const opTypes = operations.map((op: [string, unknown]) => op[0]).join(',');
    try {
      const result = await broadcastSendOperationsWithTimeout(operations, key);

      // Audit log (non-blocking)
      logCustodyBroadcast(username, opTypes, result.id, result.block_num).catch(() => {});

      return sendOk(res, {
        tx_id: result.id,
        block_num: result.block_num,
      });
    } catch (err) {
      return handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting signed operation timed out',
        failMsg: 'Failed to broadcast signed operation to Hive',
        logContext: { username, opTypes },
        routeLabel: 'custody.broadcast',
      });
    }
  } catch (err) {
    logger.error({ err, username }, 'Custodial broadcast failed (non-chain error)');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to broadcast transaction');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/custody/upgrade — Notify backend that key upgrade completed (LA12)
// ─────────────────────────────────────────────────────────────
router.post('/upgrade', verifyHiveSignature, upgradeLimiter, async (req: Request, res: Response) => {
  const username = req.hiveUsername;
  const custody = req.hiveCustody;

  if (!username) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  if (custody !== 'light') {
    return sendError(res, 403, 'FORBIDDEN', 'Only custodial accounts can upgrade');
  }

  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Password is required');
  }

  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  try {
    const { rows } = await pool.query<{
      password_hash: string;
      posting_key_enc: Buffer | null;
      upgraded_at: string | null;
    }>(
      'SELECT password_hash, posting_key_enc, upgraded_at FROM accounts WHERE username = $1',
      [username],
    );

    if (rows.length === 0) {
      // 401, not 404 — authed endpoint, missing-own-row ≡ stale session.
      return sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
    }

    const account = rows[0];
    if (account.upgraded_at) {
      return sendError(res, 409, 'ALREADY_UPGRADED', 'Account has already been upgraded to self-custody');
    }

    // Verify password re-entry
    const valid = await runWithArgon2Slot(() => argon2.verify(account.password_hash, password));
    if (!valid) {
      logCustodyBroadcast(username, 'upgrade_failure').catch(() => {});
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid password');
    }

    // Overwrite and NULL encrypted keys, set upgraded_at
    await pool.query(
      `UPDATE accounts
       SET posting_key_enc = NULL, iv_posting = NULL,
           memo_key_enc = NULL, iv_memo = NULL,
           upgraded_at = NOW()
       WHERE username = $1`,
      [username],
    );

    // Audit log (non-blocking)
    logCustodyBroadcast(username, 'upgrade').catch(() => {});

    // Issue new JWT with custody: "self"
    const token = jwt.sign(
      { sub: username, custody: 'self' },
      config.sessionSecret,
      { expiresIn: '24h' },
    );
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    sendOk(res, { custody: 'self', token, expires_at: expiresAt });
  } catch (err) {
    logger.error({ err, username }, 'Custody upgrade failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Upgrade failed');
  }
});

export default router;
