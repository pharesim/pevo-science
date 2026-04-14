import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { PrivateKey } from '@hiveio/dhive';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { sendOk, sendError } from '../response.js';
import { config } from '../config.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { getAppPool } from '../app-db.js';
import { hiveClient } from '../hive.js';
import { generateKeysFromNewSeed } from '../seed-phrase.js';
import { encryptKey } from '../custody-crypto.js';
import { createClaimedAccount } from '../account-creation.js';
import { logger } from '../logger.js';

const router = Router();
const SESSION_EXPIRY = '24h';
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const SIGNUP_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

const verifyLimiter = rateLimit({ name: 'signup-verify', windowMs: 3_600_000, max: 10, keyFn: byIp });
const resumeLimiter = rateLimit({ name: 'signup-resume', windowMs: 3_600_000, max: 5, keyFn: byIp });
const confirmLimiter = rateLimit({ name: 'signup-confirm', windowMs: 3_600_000, max: 10, keyFn: byIp });
const linkLimiter = rateLimit({ name: 'signup-link', windowMs: 3_600_000, max: 10, keyFn: byIp });

// ─────────────────────────────────────────────────────────────
// POST /api/auth/verify — Verify email token, return seed phrase (LA7 step 1)
// For new accounts: returns seed phrase for user to confirm
// For linked accounts: returns challenge for Keychain signature
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
      username: string;
      email: string;
      password_hash: string;
      linked_username: string | null;
      expires_at: Date;
    }>(
      'SELECT id, username, email, password_hash, linked_username, expires_at FROM pending_signups WHERE verify_token = $1',
      [token],
    );

    if (rows.length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired verification token');
    }

    const pending = rows[0];
    if (new Date() > new Date(pending.expires_at)) {
      await pool.query('DELETE FROM pending_signups WHERE id = $1', [pending.id]);
      return sendError(res, 400, 'BAD_REQUEST', 'Verification token has expired');
    }

    if (pending.linked_username) {
      // Linked account flow (LA23): return a challenge for Keychain signature
      const challenge = crypto.randomBytes(32).toString('hex');
      // Store challenge temporarily (reuse verify_token column)
      await pool.query(
        'UPDATE pending_signups SET verify_token = $1 WHERE id = $2',
        [`challenge:${challenge}`, pending.id],
      );

      return sendOk(res, {
        flow: 'link',
        username: pending.username,
        linked_username: pending.linked_username,
        challenge,
      });
    }

    // New account flow: generate seed phrase
    const { mnemonic, keys } = await generateKeysFromNewSeed(pending.username);

    // Store the seed phrase info temporarily (encrypted in memory, not persisted)
    // The confirm endpoint will need the token + seed phrase words to proceed
    // We store a hash of the mnemonic to verify re-entry
    const mnemonicHash = crypto.createHash('sha256').update(mnemonic).digest('hex');
    await pool.query(
      'UPDATE pending_signups SET verify_token = $1 WHERE id = $2',
      [`confirmed:${mnemonicHash}:${JSON.stringify(keys)}`, pending.id],
    );

    sendOk(res, {
      flow: 'new',
      username: pending.username,
      seed_phrase: mnemonic,
    });
  } catch (err) {
    logger.error({ err }, 'Email verification failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Verification failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/resume-signup — Resume an abandoned signup
// Email was already verified but user didn't complete confirm/link step.
// Authenticates via email + password, re-generates seed phrase or challenge.
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
      username: string;
      email: string;
      password_hash: string;
      linked_username: string | null;
      verify_token: string;
    }>(
      'SELECT id, username, email, password_hash, linked_username, verify_token FROM pending_signups WHERE email = $1',
      [normalizedEmail],
    );

    if (rows.length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid email or password');
    }

    const pending = rows[0];

    // Verify password
    const passwordValid = await argon2.verify(pending.password_hash, password);
    if (!passwordValid) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid email or password');
    }

    // Reset expiry
    const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_EXPIRY_MS);

    if (pending.linked_username) {
      const challenge = crypto.randomBytes(32).toString('hex');
      await pool.query(
        'UPDATE pending_signups SET verify_token = $1, expires_at = $2 WHERE id = $3',
        [`challenge:${challenge}`, expiresAt, pending.id],
      );

      return sendOk(res, {
        flow: 'link',
        username: pending.username,
        linked_username: pending.linked_username,
        challenge,
      });
    }

    // New account flow: generate fresh seed phrase
    const { mnemonic, keys } = await generateKeysFromNewSeed(pending.username);
    const mnemonicHash = crypto.createHash('sha256').update(mnemonic).digest('hex');
    await pool.query(
      'UPDATE pending_signups SET verify_token = $1, expires_at = $2 WHERE id = $3',
      [`confirmed:${mnemonicHash}:${JSON.stringify(keys)}`, expiresAt, pending.id],
    );

    sendOk(res, {
      flow: 'new',
      username: pending.username,
      seed_phrase: mnemonic,
    });
  } catch (err) {
    logger.error({ err }, 'Resume signup failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Resume failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/confirm — Confirm seed phrase and finalize account (LA7 step 2)
// ─────────────────────────────────────────────────────────────
router.post('/confirm', confirmLimiter, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const { username, seed_phrase } = req.body || {};
  if (!username || typeof username !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Username is required');
  }
  if (!seed_phrase || typeof seed_phrase !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Seed phrase is required');
  }

  const normalizedUsername = username.trim().toLowerCase();

  try {
    const { rows } = await pool.query<{
      id: number;
      username: string;
      email: string;
      password_hash: string;
      verify_token: string;
    }>(
      `SELECT id, username, email, password_hash, verify_token
       FROM pending_signups WHERE username = $1 AND verify_token LIKE 'confirmed:%'`,
      [normalizedUsername],
    );

    if (rows.length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'No pending confirmed signup for this username');
    }

    const pending = rows[0];
    const tokenParts = pending.verify_token.split(':');
    const storedMnemonicHash = tokenParts[1];
    const storedKeysJson = tokenParts.slice(2).join(':');

    // Verify the seed phrase matches
    const providedHash = crypto.createHash('sha256').update(seed_phrase.trim()).digest('hex');
    if (providedHash !== storedMnemonicHash) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Seed phrase does not match');
    }

    const keys = JSON.parse(storedKeysJson) as {
      owner: { private: string; public: string };
      active: { private: string; public: string };
      posting: { private: string; public: string };
      memo: { private: string; public: string };
    };

    // Create the Hive account
    const createResult = await createClaimedAccount(
      pending.username,
      keys.owner.public,
      keys.active.public,
      keys.posting.public,
      keys.memo.public,
    );

    // Encrypt and store posting + memo keys
    const postingEnc = encryptKey(pending.username, keys.posting.private);
    const memoEnc = encryptKey(pending.username, keys.memo.private);

    // Create light_accounts row
    await pool.query(
      `INSERT INTO light_accounts (username, password_hash, email, posting_key_enc, iv_posting, memo_key_enc, iv_memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        pending.username,
        pending.password_hash,
        pending.email,
        postingEnc.ciphertext,
        postingEnc.iv,
        memoEnc.ciphertext,
        memoEnc.iv,
      ],
    );

    // Broadcast accreditation custom_json
    if (config.pevoAdminPostingKey) {
      try {
        const evidenceHash = crypto
          .createHash('sha256')
          .update(`${pending.email}:${pending.username}:signup`)
          .digest('hex');

        const adminKey = PrivateKey.fromString(config.pevoAdminPostingKey);
        await hiveClient.broadcast.json(
          {
            id: config.appTag,
            json: JSON.stringify({
              action: 'accredit',
              account: pending.username,
              name: pending.username,
              institution: '',
              field: '',
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
        logger.error({ err: (accErr as Error).message }, 'Failed to broadcast accreditation — account created but not accredited');
      }
    }

    // Delete pending signup
    await pool.query('DELETE FROM pending_signups WHERE id = $1', [pending.id]);

    // Issue JWT session
    const jwtToken = jwt.sign(
      { sub: pending.username, custody: 'light' },
      config.sessionSecret,
      { expiresIn: SESSION_EXPIRY },
    );
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();

    sendOk(res, {
      token: jwtToken,
      expires_at: expiresAt,
      custody: 'light',
      username: pending.username,
      block_num: createResult.block_num,
    });
  } catch (err) {
    logger.error({ err }, 'Account confirmation failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Account creation failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/link — Link existing Hive account after email verification (LA23)
// Requires Keychain signature proving ownership of the linked account
// ─────────────────────────────────────────────────────────────
router.post('/link', linkLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const { username, challenge } = req.body || {};
  if (!username || typeof username !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Username is required');
  }
  if (!challenge || typeof challenge !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Challenge is required');
  }

  const normalizedUsername = username.trim().toLowerCase();

  // The Keychain signature must be from the linked account
  const signingUsername = req.hiveUsername;

  try {
    const { rows } = await pool.query<{
      id: number;
      username: string;
      email: string;
      password_hash: string;
      linked_username: string;
      verify_token: string;
    }>(
      `SELECT id, username, email, password_hash, linked_username, verify_token
       FROM pending_signups WHERE username = $1 AND verify_token = $2`,
      [normalizedUsername, `challenge:${challenge}`],
    );

    if (rows.length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired link request');
    }

    const pending = rows[0];

    // Verify the signing user matches the linked account
    if (signingUsername !== pending.linked_username) {
      return sendError(res, 403, 'FORBIDDEN', `Signature must be from ${pending.linked_username}`);
    }

    // Create light_accounts row with no encrypted keys (self-custody from start)
    const now = new Date();
    await pool.query(
      `INSERT INTO light_accounts (username, password_hash, email, upgraded_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [pending.linked_username, pending.password_hash, pending.email, now, now],
    );

    // Broadcast accreditation custom_json
    if (config.pevoAdminPostingKey) {
      try {
        const evidenceHash = crypto
          .createHash('sha256')
          .update(`${pending.email}:${pending.linked_username}:link`)
          .digest('hex');

        const adminKey = PrivateKey.fromString(config.pevoAdminPostingKey);
        await hiveClient.broadcast.json(
          {
            id: config.appTag,
            json: JSON.stringify({
              action: 'accredit',
              account: pending.linked_username,
              name: pending.linked_username,
              institution: '',
              field: '',
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
        logger.error({ err: (accErr as Error).message }, 'Failed to broadcast accreditation for linked account');
      }
    }

    // Delete pending signup
    await pool.query('DELETE FROM pending_signups WHERE id = $1', [pending.id]);

    // Issue JWT session
    const jwtToken = jwt.sign(
      { sub: pending.linked_username, custody: 'self' },
      config.sessionSecret,
      { expiresIn: SESSION_EXPIRY },
    );
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();

    sendOk(res, {
      token: jwtToken,
      expires_at: expiresAt,
      custody: 'self',
      username: pending.linked_username,
    });
  } catch (err) {
    logger.error({ err }, 'Account linking failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Account linking failed');
  }
});

export default router;
