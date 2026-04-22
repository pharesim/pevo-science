import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { PrivateKey, PublicKey } from '@hiveio/dhive';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { sendOk, sendError } from '../response.js';
import { config } from '../config.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { getAppPool } from '../app-db.js';
import { hiveClient, broadcastJsonWithTimeout } from '../hive.js';
import { encryptKey } from '../custody-crypto.js';
import { createClaimedAccount } from '../account-creation.js';
import { logger } from '../logger.js';
import { burnSentinel } from './auth.js';
import { runWithArgon2Slot } from '../lib/argon2-semaphore.js';
import { hashEmailForLogs } from '../lib/log-pii.js';

const router = Router();
const SESSION_EXPIRY = '24h';
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const SIGNUP_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

// Username format: 3-16 chars, lowercase a-z, 0-9, dots/hyphens not at start/end
const USERNAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
const BAD_SEGMENT_RE = /[.-]{2}/;

const verifyLimiter = rateLimit({ name: 'signup-verify', windowMs: 3_600_000, max: 10, keyFn: byIp });
const resumeLimiter = rateLimit({ name: 'signup-resume', windowMs: 3_600_000, max: 5, keyFn: byIp });
const confirmLimiter = rateLimit({ name: 'signup-confirm', windowMs: 3_600_000, max: 10, keyFn: byIp });
const linkLimiter = rateLimit({ name: 'signup-link', windowMs: 3_600_000, max: 10, keyFn: byIp });

// ─────────────────────────────────────────────────────────────
// POST /api/auth/verify — Verify email token (SF3)
// Marks account as confirmed, returns { flow: 'choose' }
// ─────────────────────────────────────────────────────────────
router.post('/verify', verifyLimiter, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Verification token is required');
  }

  try {
    const { rows } = await pool.query<{
      id: number;
      email: string;
      expires_at: Date;
    }>(
      'SELECT id, email, expires_at FROM accounts WHERE verify_token = $1',
      [token],
    );

    if (rows.length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired verification token');
    }

    const account = rows[0];
    if (new Date() > new Date(account.expires_at)) {
      await pool.query('DELETE FROM accounts WHERE id = $1', [account.id]);
      return sendError(res, 400, 'BAD_REQUEST', 'Verification token has expired');
    }

    // Mark as confirmed with a random token
    const confirmed = `confirmed:${crypto.randomBytes(32).toString('hex')}`;
    await pool.query(
      'UPDATE accounts SET verify_token = $1 WHERE id = $2',
      [confirmed, account.id],
    );

    sendOk(res, { flow: 'choose', email: account.email, auth_token: confirmed });
  } catch (err) {
    logger.error({ err }, 'Email verification failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Verification failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/resume-signup — Resume an abandoned signup (SF5)
// Authenticates via email + password, resets expiry, returns { flow: 'choose' }
// ─────────────────────────────────────────────────────────────
router.post('/resume-signup', resumeLimiter, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const { email, password } = req.body || {};
  if (!email || typeof email !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Email is required');
  }
  if (!password || typeof password !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Password is required');
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const { rows } = await pool.query<{
      id: number;
      password_hash: string;
      verify_token: string | null;
    }>(
      'SELECT id, password_hash, verify_token FROM accounts WHERE email = $1',
      [normalizedEmail],
    );

    if (rows.length === 0) {
      // Unknown-email path: burn sentinel to match the known-email + argon2.verify
      // wall-time below. Without this, unknown-email returns in ~1ms while the
      // known-email-in-confirmed-signup-state branch pays argon2.verify (~50ms),
      // an enumeration oracle that leaks which emails sit in a resumable state.
      // Mirrors the pattern applied across auth.ts under SEC-LOGIN-UNKNOWN-USER-TIMING.
      await burnSentinel(password);
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid email or password');
    }

    const account = rows[0];

    // Only allow resume if email was already verified but account not yet active.
    // Burn sentinel on the non-confirmed branch too so accounts in any non-
    // resumable lifecycle state (null verify_token, unverified verify_token)
    // cost the same wall-time as the confirmed + wrong-password branch below.
    if (!account.verify_token || !account.verify_token.startsWith('confirmed:')) {
      await burnSentinel(password);
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid email or password');
    }

    // Verify password
    const passwordValid = await runWithArgon2Slot(() => argon2.verify(account.password_hash, password));
    if (!passwordValid) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid email or password');
    }

    // Reset expiry
    const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_EXPIRY_MS);
    await pool.query(
      'UPDATE accounts SET expires_at = $1 WHERE id = $2',
      [expiresAt, account.id],
    );

    sendOk(res, { flow: 'choose', email: normalizedEmail, auth_token: account.verify_token });
  } catch (err) {
    logger.error({ err }, 'Resume signup failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Resume failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/confirm — Create new Hive account with client-provided keys (SF4)
// Request: { auth_token, username, keys: { owner_public, active_public, posting_public, memo_public, posting_private, memo_private } }
// ─────────────────────────────────────────────────────────────
router.post('/confirm', confirmLimiter, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const { auth_token, username, keys } = req.body || {};

  // Validate required fields
  if (!auth_token || typeof auth_token !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Auth token is required');
  }
  if (!username || typeof username !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Username is required');
  }
  if (!keys || typeof keys !== 'object') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Keys are required');
  }

  const { owner_public, active_public, posting_public, memo_public, posting_private, memo_private } = keys;
  if (!owner_public || !active_public || !posting_public || !memo_public || !posting_private || !memo_private) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'All key fields are required (owner_public, active_public, posting_public, memo_public, posting_private, memo_private)');
  }

  const normalizedUsername = username.trim().toLowerCase();

  // Validate username format
  if (!USERNAME_RE.test(normalizedUsername) || BAD_SEGMENT_RE.test(normalizedUsername)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Username must be 3-16 characters, lowercase letters/numbers/dots/hyphens, not starting or ending with dots/hyphens');
  }

  // Validate public keys are well-formed STM keys
  for (const [label, key] of [['owner', owner_public], ['active', active_public], ['posting', posting_public], ['memo', memo_public]] as const) {
    if (typeof key !== 'string' || !key.startsWith('STM')) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid ${label} public key format`);
    }
    try {
      PublicKey.fromString(key);
    } catch {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid ${label} public key`);
    }
  }

  try {
    // Look up account by auth token (must be in confirmed state)
    const { rows } = await pool.query<{
      id: number;
      email: string;
      password_hash: string;
      full_name: string;
      institution: string;
      field: string;
      orcid: string | null;
    }>(
      `SELECT id, email, password_hash, full_name, institution, field, orcid
       FROM accounts WHERE verify_token = $1`,
      [auth_token],
    );

    if (rows.length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired auth token');
    }

    const account = rows[0];

    // Check Hive username availability
    const [existingAccount] = await hiveClient.database.getAccounts([normalizedUsername]);
    if (existingAccount) {
      return sendError(res, 409, 'DUPLICATE', 'Username is already taken on Hive');
    }

    // Create the Hive account
    const createResult = await createClaimedAccount(
      normalizedUsername,
      owner_public,
      active_public,
      posting_public,
      memo_public,
    );

    // Encrypt and store posting + memo private keys
    const postingEnc = encryptKey(normalizedUsername, posting_private);
    const memoEnc = encryptKey(normalizedUsername, memo_private);

    // Activate the account: set username, keys, custody, clear verify_token
    await pool.query(
      `UPDATE accounts
       SET username = $1, custody = 'light', verify_token = NULL,
           posting_key_enc = $2, iv_posting = $3,
           memo_key_enc = $4, iv_memo = $5
       WHERE id = $6`,
      [
        normalizedUsername,
        postingEnc.ciphertext, postingEnc.iv,
        memoEnc.ciphertext, memoEnc.iv,
        account.id,
      ],
    );

    // Broadcast accreditation custom_json
    if (config.pevoAdminPostingKey) {
      try {
        const evidenceHash = crypto
          .createHash('sha256')
          .update(`${account.email}:${normalizedUsername}:signup`)
          .digest('hex');

        const adminKey = PrivateKey.fromString(config.pevoAdminPostingKey);
        await broadcastJsonWithTimeout(
          {
            id: config.appTag,
            json: JSON.stringify({
              action: 'accredit',
              account: normalizedUsername,
              name: account.full_name || normalizedUsername,
              institution: account.institution || '',
              field: account.field || '',
              orcid: account.orcid || '',
              method: 'email',
              evidence_hash: evidenceHash,
              timestamp: new Date().toISOString(),
            }),
            required_auths: [],
            required_posting_auths: [config.hiveAdminAccount],
          },
          adminKey,
        );
      } catch (accErr) {
        logger.error(
          {
            err: accErr,
            email_hash: hashEmailForLogs(account.email),
            username: normalizedUsername,
            orcid: account.orcid ?? null,
          },
          'Failed to broadcast accreditation — account created but not accredited',
        );
      }
    }

    // Issue JWT session
    const jwtToken = jwt.sign(
      { sub: normalizedUsername, custody: 'light' },
      config.sessionSecret,
      { expiresIn: SESSION_EXPIRY },
    );
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();

    sendOk(res, {
      token: jwtToken,
      expires_at: expiresAt,
      custody: 'light',
      username: normalizedUsername,
      block_num: createResult.block_num,
    });
  } catch (err) {
    logger.error({ err }, 'Account confirmation failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Account creation failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/link — Link existing Hive account after email verification (SF6)
// Requires auth_token + Keychain signature proving Hive account ownership
// ─────────────────────────────────────────────────────────────
router.post('/link', linkLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const { auth_token } = req.body || {};
  if (!auth_token || typeof auth_token !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Auth token is required');
  }

  // Hive username comes from Keychain signature
  const hiveUsername = req.hiveUsername;
  if (!hiveUsername) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Keychain signature is required');
  }

  try {
    // Look up account by auth token (must be in confirmed state)
    const { rows } = await pool.query<{
      id: number;
      email: string;
      password_hash: string;
      full_name: string;
      institution: string;
      field: string;
      orcid: string | null;
    }>(
      `SELECT id, email, password_hash, full_name, institution, field, orcid
       FROM accounts WHERE verify_token = $1`,
      [auth_token],
    );

    if (rows.length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired link request');
    }

    const account = rows[0];

    // Verify the Hive account exists
    const [hiveAccount] = await hiveClient.database.getAccounts([hiveUsername]);
    if (!hiveAccount) {
      return sendError(res, 404, 'NOT_FOUND', 'Hive account not found');
    }

    // Check the Hive account isn't already registered
    const { rows: existing } = await pool.query<{ username: string }>(
      'SELECT username FROM accounts WHERE username = $1',
      [hiveUsername],
    );
    if (existing.length > 0) {
      return sendError(res, 409, 'DUPLICATE', 'This Hive account is already linked');
    }

    // Activate: set username, custody=self, upgraded_at, clear verify_token
    const now = new Date();
    await pool.query(
      `UPDATE accounts
       SET username = $1, custody = 'self', verify_token = NULL, upgraded_at = $2
       WHERE id = $3`,
      [hiveUsername, now, account.id],
    );

    // Broadcast accreditation custom_json
    if (config.pevoAdminPostingKey) {
      try {
        const evidenceHash = crypto
          .createHash('sha256')
          .update(`${account.email}:${hiveUsername}:link`)
          .digest('hex');

        const adminKey = PrivateKey.fromString(config.pevoAdminPostingKey);
        await broadcastJsonWithTimeout(
          {
            id: config.appTag,
            json: JSON.stringify({
              action: 'accredit',
              account: hiveUsername,
              name: account.full_name || hiveUsername,
              institution: account.institution || '',
              field: account.field || '',
              orcid: account.orcid || '',
              method: 'email',
              evidence_hash: evidenceHash,
              timestamp: new Date().toISOString(),
            }),
            required_auths: [],
            required_posting_auths: [config.hiveAdminAccount],
          },
          adminKey,
        );
      } catch (accErr) {
        logger.error(
          {
            err: accErr,
            email_hash: hashEmailForLogs(account.email),
            username: hiveUsername,
            orcid: account.orcid ?? null,
          },
          'Failed to broadcast accreditation for linked account',
        );
      }
    }

    // Issue JWT session
    const jwtToken = jwt.sign(
      { sub: hiveUsername, custody: 'self' },
      config.sessionSecret,
      { expiresIn: SESSION_EXPIRY },
    );
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();

    sendOk(res, {
      token: jwtToken,
      expires_at: expiresAt,
      custody: 'self',
      username: hiveUsername,
    });
  } catch (err) {
    logger.error({ err }, 'Account linking failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Account linking failed');
  }
});

export default router;
