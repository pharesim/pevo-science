import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { PrivateKey } from '@hiveio/dhive';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { sendOk, sendError } from '../response.js';
import { config } from '../config.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { getAppPool } from '../app-db.js';
import { broadcastSendOperationsWithTimeout, BroadcastTimeoutError } from '../hive.js';
import { decryptKey } from '../custody-crypto.js';
import { logCustodyBroadcast } from '../custody-audit.js';
import { logger } from '../logger.js';
import { runWithArgon2Slot } from '../lib/argon2-semaphore.js';
import { burnSentinel } from './auth.js';
import { handleArgonError, ARGON_HANDLED } from '../lib/argon2-error-handler.js';
import { requestAbortSignal } from '../lib/request-abort-signal.js';
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

  // Hoisted to the outer try-scope (round-2 hold #5): both the inner
  // (broadcast-path) and outer (db / decrypt / key-parse) catch reference the
  // same operation context. A pre-fix outer catch only logged `{ err, username }`
  // — operators investigating a `decryptKey` throw lost the operation context.
  // Computed up-front from the validated `operations` array; the structured
  // `op_types` (string[]) and `op_count` (number) are what dashboards key on
  // (round-2 hold #5: a comma-joined string can't be filtered by a single op
  // type in JSON-log queries, and a multi-op transaction's chain rejection at
  // op[1] can't be correlated with the bundle without the array shape).
  // `opTypes` (legacy comma-joined) stays threaded into `logCustodyBroadcast`
  // because the audit-log table column is a single TEXT field; the structured
  // pino fields are the per-attempt operator-log signal.
  const op_types = operations.map((op: [string, unknown]) => op[0]);
  const op_count = op_types.length;
  const opTypes = op_types.join(',');

  // Per-attempt audit-log signal (round-2 hold #4 — close audit-log blind
  // spot). The DB-side `logCustodyBroadcast` writes only on success; this
  // pino-side structured event fires on EVERY attempt with
  // outcome ∈ {success, failure, timeout}. Operators correlate
  // `event:'custody_broadcast_attempt'` to spot retry-amplification before the
  // full idempotency design (filed as
  // `backend-broadcast-idempotency-cluster-followup.md`) lands. `attempt_n` is
  // 1 today — each /broadcast call is a fresh request without retry counting;
  // the field is forward-compat for the idempotency cluster's per-key counter.
  function logBroadcastAttempt(outcome: 'success' | 'failure' | 'timeout', extra?: Record<string, unknown>) {
    const fields = {
      username,
      op_types,
      op_count,
      attempt_n: 1,
      outcome,
      event: 'custody_broadcast_attempt',
      ...(extra ?? {}),
    };
    if (outcome === 'success') {
      logger.info(fields, 'custody.broadcast attempt');
    } else {
      logger.warn(fields, 'custody.broadcast attempt');
    }
  }

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
    try {
      const result = await broadcastSendOperationsWithTimeout(operations, key);

      // Audit log (DB write, non-blocking) — captures only the success path.
      logCustodyBroadcast(username, opTypes, result.id, result.block_num).catch(() => {});
      // Pino-side per-attempt signal (round-2 hold #4 — every attempt logged).
      logBroadcastAttempt('success', { tx_id: result.id, block_num: result.block_num });

      return sendOk(res, {
        tx_id: result.id,
        block_num: result.block_num,
      });
    } catch (err) {
      // Pino-side per-attempt signal for the broadcast catch path. The
      // outcome label discriminates timeout vs. failure so dashboards can
      // separate the two without parsing the inner-helper's stable suffix.
      const outcome: 'failure' | 'timeout' = err instanceof BroadcastTimeoutError ? 'timeout' : 'failure';
      logBroadcastAttempt(outcome);
      return handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting signed operation timed out',
        failMsg: 'Failed to broadcast signed operation to Hive',
        logContext: { username, op_types, op_count },
        routeLabel: 'custody.broadcast',
      });
    }
  } catch (err) {
    // Outer catch: db / decrypt / PrivateKey.fromString errors. Round-2 hold
    // #5: include the structured `op_types` + `op_count` so operators don't
    // lose the operation context when the failure is upstream of the
    // broadcast. `event:'custody_broadcast_internal_error'` discriminates
    // this branch from the broadcast-path event so dashboards filter cleanly.
    logger.error(
      { err, username, op_types, op_count, event: 'custody_broadcast_internal_error' },
      'Custodial broadcast failed (non-chain error)',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to broadcast transaction');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/custody/upgrade — Notify backend that key upgrade completed (LA12)
// ─────────────────────────────────────────────────────────────
router.post('/upgrade', verifyHiveSignature, upgradeLimiter, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
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
      password_hash: string | null;
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

    // Load-bearing null-guard for ORCID-only accounts. The reachable path
    // today: an ORCID-verified account (`password_hash=NULL`, `custody=NULL`
    // or `'orcid'`) signs in via /api/orcid/callback, which mints a JWT with
    // `custody: account.custody || 'light'` (orcid.ts ~line 456). The `||`
    // defaults the JWT claim to `'light'` whenever the DB column is null/
    // falsy. That JWT then passes the `custody !== 'light'` gate above and
    // reaches this branch with `account.password_hash === null`. Without
    // this guard, execution hits `argon2.verify(null, password)` → synchronous
    // TypeError → 500 in ~0ms, reopening the wall-time / status-code oracle
    // the burnSentinel work exists to close. The orcid.ts `||` default
    // versus this route's gate is the underlying invariant violation; that
    // is tracked separately. The null-guard here is the local fix. Burn the
    // sentinel to match the wrong-password branch wall-time and return the
    // same 401 + audit-log entry that branch emits so internal observers
    // cannot distinguish a null-hash account from an ordinary wrong-password
    // attempt. See BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT.
    if (!account.password_hash) {
      await burnSentinel(password, abortSignal);
      logCustodyBroadcast(username, 'upgrade_failure').catch(() => {});
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid password');
    }

    // Verify password re-entry. Canonical hoist pattern (see the
    // `/resume-signup` handler in `signup-verify.ts` and
    // BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT) — pin the narrowed type for
    // the runWithArgon2Slot closure body.
    const passwordHash = account.password_hash;
    const valid = await runWithArgon2Slot(() => argon2.verify(passwordHash, password), { signal: abortSignal });
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
    if (handleArgonError(res, err, { logContext: { username } }) === ARGON_HANDLED) return;
    logger.error({ err, username }, 'Custody upgrade failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Upgrade failed');
  }
});

export default router;
