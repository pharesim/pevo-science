import crypto from 'node:crypto';
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
import { logCustodyBroadcast, type CustodyAuditExtras } from '../custody-audit.js';
import { logger } from '../logger.js';
import { runWithArgon2Slot } from '../lib/argon2-semaphore.js';
import { handleArgonError, ARGON_HANDLED } from '../lib/argon2-error-handler.js';
import { requestAbortSignal } from '../lib/request-abort-signal.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';
import {
  CONSENT_OP_ACTIONS,
  consumeFreshAuthToken,
  issueFreshAuthToken,
  type FreshAuthMechanism,
} from '../lib/fresh-auth.js';

const router = Router();

// Allowed Hive operations for custodial broadcast
const ALLOWED_OPS = new Set(['comment', 'vote', 'custom_json']);

const broadcastLimiter = rateLimit({ name: 'custody-broadcast', windowMs: 60_000, max: 30, keyFn: byAccount });
const upgradeLimiter = rateLimit({ name: 'custody-upgrade', windowMs: 3_600_000, max: 1, keyFn: byAccount });
// Tighter than broadcast: each issuance pays a full argon2.verify (~50 ms × N
// in-flight under the JS-level semaphore). 10/min/account is generous for the
// re-auth-then-broadcast UX (the user sees one prompt → one proof → one
// broadcast) and bounds the password-guess oracle even if a session is
// hijacked.
const freshAuthLimiter = rateLimit({ name: 'custody-fresh-auth', windowMs: 60_000, max: 10, keyFn: byAccount });

/** Stable session-id derived from the bearer JWT for audit-log correlation.
 *  SHA-256 of the raw token, truncated to 16 hex chars — opaque to the
 *  client, identifies the issuance session without persisting the token
 *  itself. Returns `null` when no Authorization header is present. */
function bearerSessionId(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  if (token.length === 0) return null;
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Result discriminator for `findConsentOpsInBundle`. The single-consent rule
 *  is structural: a bundle either contains zero consent ops (no fresh-auth
 *  required), exactly one consent op (fresh-auth required for that op), or
 *  more than one (rejected). */
type ConsentOpScan =
  | { kind: 'none' }
  | { kind: 'single'; action: string }
  | { kind: 'multiple' };

/** Type guard: a Hive operation is a [type, params] tuple where params is a
 *  non-null object. Replaces the round-3 `as { json?: unknown }` cast at
 *  this site (round-4 hold #8). */
function isOpTuple(op: unknown): op is [string, Record<string, unknown>] {
  return (
    Array.isArray(op) &&
    op.length === 2 &&
    typeof op[0] === 'string' &&
    typeof op[1] === 'object' &&
    op[1] !== null
  );
}

/** Scan the operations bundle for consent ops (`author_accept` /
 *  `author_resign`). Per round-4 hold #1, we explicitly reject bundles
 *  containing more than one consent op: a single fresh-auth proof gates
 *  the entire bundle, so allowing N consent ops in one call would let a
 *  compromised SPA convert one auth ceremony into N consent broadcasts
 *  (substitution-attack vector). The function returns a discriminator so
 *  the caller can distinguish "no consent op" (no proof needed) from
 *  "exactly one" (verify proof) from "multiple" (reject 400). */
function findConsentOpsInBundle(operations: unknown[]): ConsentOpScan {
  let firstAction: string | null = null;
  for (const op of operations) {
    if (!isOpTuple(op)) continue;
    const [opType, opParams] = op;
    if (opType !== 'custom_json') continue;
    const rawJson = opParams.json;
    let payload: unknown;
    try {
      payload = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
    } catch {
      continue;
    }
    if (typeof payload !== 'object' || payload === null) continue;
    const action = (payload as { action?: unknown }).action;
    if (typeof action !== 'string' || !CONSENT_OP_ACTIONS.has(action)) continue;
    if (firstAction === null) {
      firstAction = action;
    } else {
      // Second consent op detected — short-circuit with the multi-consent
      // discriminator. The caller responds 400 MULTIPLE_CONSENT_OPS without
      // consuming the proof or reaching the broadcast path.
      return { kind: 'multiple' };
    }
  }
  return firstAction === null ? { kind: 'none' } : { kind: 'single', action: firstAction };
}

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
      // Only allow specific custom_json actions, and enforce sender is the authenticated user
      const auths = opParams.required_posting_auths;
      if (!Array.isArray(auths) || auths.length !== 1 || auths[0] !== username) {
        return sendError(res, 403, 'FORBIDDEN', `required_posting_auths must be ['${username}']`);
      }
      if (opParams.id !== config.appTag) {
        return sendError(res, 400, 'VALIDATION_ERROR', `custom_json id must be '${config.appTag}'`);
      }
      try {
        const payload = typeof opParams.json === 'string' ? JSON.parse(opParams.json) : opParams.json;
        const allowedActions = [
          'revote',
          'claim_authorship',
          'approve_authorship',
          'revoke_authorship',
          // Round-3 of BACKEND-COAUTHOR-TRUST-MODEL: consent ops gate
          // continuation-chain admit. Light-account broadcast is allowed,
          // but each call also requires a fresh-auth proof (gated below).
          'author_accept',
          'author_resign',
        ];
        if (!allowedActions.includes(payload.action)) {
          return sendError(res, 403, 'FORBIDDEN', `Only ${allowedActions.join(', ')} custom_json actions are allowed for custodial accounts`);
        }
      } catch {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid custom_json payload');
      }
    }
  }

  // Round-3: consent-op operations require a per-op fresh-auth proof.
  // Round-4 hold #1: bundles with MORE THAN ONE consent op are rejected
  // with 400 MULTIPLE_CONSENT_OPS — one proof gates one consent op, never
  // an N-op consent fan-out. Verified BEFORE decrypting the posting key so
  // a missing/expired proof or multi-consent bundle never reaches the
  // broadcast path. The proof is consumed (single-use) even if the
  // broadcast itself later fails — re-broadcasting requires a fresh re-auth,
  // matching the ARCH.md "per-op" rule.
  const consentScan = findConsentOpsInBundle(operations);
  if (consentScan.kind === 'multiple') {
    logger.warn(
      {
        event: 'custody.broadcast.multiple_consent_ops_rejected',
        route: 'custody.broadcast',
        username,
        op_count: operations.length,
      },
      'custody.broadcast rejected — bundle contains multiple consent ops',
    );
    return sendError(
      res,
      400,
      'MULTIPLE_CONSENT_OPS',
      'A custody broadcast bundle may contain at most one consent operation (author_accept or author_resign). Submit each consent op in its own request with its own fresh-auth proof.',
    );
  }
  const consentAction = consentScan.kind === 'single' ? consentScan.action : null;
  let freshAuthMechanism: FreshAuthMechanism | null = null;
  if (consentAction !== null) {
    const proof = (req.body as { fresh_auth_proof?: unknown })?.fresh_auth_proof;
    const proofToken = typeof proof === 'string' ? proof : undefined;
    const result = await consumeFreshAuthToken(proofToken, username);
    if (!result.valid) {
      logger.warn(
        {
          event: 'custody.broadcast.fresh_auth_rejected',
          route: 'custody.broadcast',
          username,
          consent_action: consentAction,
          reason: result.reason,
        },
        'custody.broadcast rejected — fresh-auth proof invalid',
      );
      // Round-4 hold #10: discriminate status code on reason. `username_mismatch`
      // is a binding violation (token issued for a different user) → 403; the
      // remaining outcomes (`missing`, `expired`, `malformed`) are all
      // "no valid proof present" → 401.
      const status = result.reason === 'username_mismatch' ? 403 : 401;
      return sendError(
        res,
        status,
        'FRESH_AUTH_REQUIRED',
        'Re-authentication required to broadcast this operation. Please complete the fresh-auth challenge and retry.',
        { reason: result.reason },
      );
    }
    freshAuthMechanism = result.mechanism;
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
      event: 'custody.broadcast.attempt',
      route: 'custody.broadcast',
      username,
      op_types,
      op_count,
      attempt_n: 1,
      outcome,
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
      // Round-3: consent-op broadcasts also persist auth-mechanism + session
      // + user-agent per ARCH.md "Light-account signing of consent ops".
      // Round-4 hold #9: `auditExtras` is typed as the discriminated
      // CustodyAuditExtras union; the consent-variant constructor below pins
      // `auth_mechanism` + `fresh_auth_outcome` together (TS no longer admits
      // the half-populated shape that motivated the convention).
      const auditExtras: CustodyAuditExtras | undefined = freshAuthMechanism === null
        ? undefined
        : {
            auth_mechanism: freshAuthMechanism,
            fresh_auth_outcome: 'verified',
            session_id: bearerSessionId(req) ?? undefined,
            user_agent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
          };
      logCustodyBroadcast(username, opTypes, result.id, result.block_num, auditExtras).catch(() => {});
      // Pino-side per-attempt signal (round-2 hold #4 — every attempt logged).
      logBroadcastAttempt(
        'success',
        freshAuthMechanism === null
          ? { tx_id: result.id, block_num: result.block_num }
          : {
              tx_id: result.id,
              block_num: result.block_num,
              consent_action: consentAction,
              auth_mechanism: freshAuthMechanism,
            },
      );

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
    // broadcast. `event:'custody.broadcast.internal_error'` discriminates
    // this branch from the broadcast-path event so dashboards filter cleanly.
    logger.error(
      {
        event: 'custody.broadcast.internal_error',
        route: 'custody.broadcast',
        username,
        op_types,
        op_count,
        err,
      },
      'Custodial broadcast failed (non-chain error)',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to broadcast transaction');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/custody/fresh-auth — Mint a per-op fresh-auth proof (password path).
// Round-3 of BACKEND-COAUTHOR-TRUST-MODEL. The ORCID issuance path lives in
// `routes/orcid.ts` under `mode: 'fresh_auth'` (parallel issuance flow that
// completes a real OAuth round-trip).
// ─────────────────────────────────────────────────────────────
router.post('/fresh-auth', verifyHiveSignature, freshAuthLimiter, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
  const username = req.hiveUsername;
  const custody = req.hiveCustody;

  if (!username) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
  }
  if (custody !== 'light') {
    return sendError(res, 403, 'FORBIDDEN', 'This endpoint is only for custodial accounts. Self-custody users sign consent ops via Hive Keychain.');
  }

  const { password } = (req.body ?? {}) as { password?: unknown };
  if (typeof password !== 'string' || password.length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Password is required');
  }

  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  try {
    const { rows } = await pool.query<{
      password_hash: string | null;
      upgraded_at: string | null;
    }>(
      'SELECT password_hash, upgraded_at FROM accounts WHERE username = $1',
      [username],
    );

    if (rows.length === 0) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
    }

    const account = rows[0];
    if (account.upgraded_at) {
      return sendError(res, 403, 'FORBIDDEN', 'Account has been upgraded to self-custody. Use Hive Keychain.');
    }

    if (!account.password_hash) {
      // Password mechanism unavailable for this account (e.g., ORCID-only
      // hybrid). Direction the user toward the ORCID re-auth path. The
      // 401 + UNAUTHORIZED shape mirrors the wrong-password branch so the
      // route does not become a password-existence oracle.
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid password');
    }

    const passwordHash = account.password_hash;
    const valid = await runWithArgon2Slot(
      () => argon2.verify(passwordHash, password),
      { signal: abortSignal },
    );
    if (!valid) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid password');
    }

    const issued = await issueFreshAuthToken(username, 'password');
    return sendOk(res, {
      fresh_auth_proof: issued.token,
      expires_at: issued.expires_at,
      mechanism: issued.mechanism,
    });
  } catch (err) {
    if (handleArgonError(res, err, { logContext: { username } }) === ARGON_HANDLED) return;
    logger.error(
      { event: 'custody.fresh_auth.failed', route: 'custody.fresh-auth', username, err },
      'Fresh-auth issuance failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to issue fresh-auth proof');
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

    // BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT (Option A): the orcid.ts JWT
    // mint now uses `custody: account.custody` (no `|| 'light'` default), so
    // ORCID-only accounts carry `custody: null` in the JWT. The middleware
    // (`verifyHiveSignature.ts:84`) coerces null → `'self'`, which fails the
    // `custody !== 'light'` gate above and 403s before reaching this branch.
    // The previous round-2 null-guard (`if (!account.password_hash)` with
    // `burnSentinel` for timing-equalization) is now unreachable through
    // any documented path; the JWT-vs-DB drift is closed at the source.
    //
    // The minimal narrowing guard below is a TypeScript-narrowing belt-and-
    // suspenders for any hypothetical future direct caller that bypasses
    // `verifyHiveSignature` (e.g., a new auth path) and arrives here with a
    // null hash. No `burnSentinel` is needed: the timing-oracle attack
    // requires the path to be reachable from an attacker-issued JWT, and
    // the orcid.ts fix removes that reachability. A future direct caller
    // would be a server-internal control-flow bug, not a timing oracle.
    if (!account.password_hash) {
      logger.error(
        {
          event: 'custody.upgrade.null_hash_unreachable',
          route: 'custody.upgrade',
          username,
        },
        'Custody upgrade reached password-verify branch with null password_hash. The orcid.ts default removal should have made this unreachable; investigate any new direct caller of this route.',
      );
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
    logger.error(
      { event: 'custody.upgrade.failed', route: 'custody.upgrade', username, err },
      'Custody upgrade failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Upgrade failed');
  }
});

export default router;
