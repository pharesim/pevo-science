import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import nodemailer from 'nodemailer';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { sendOk, sendError } from '../response.js';
import { config } from '../config.js';
import { rateLimit, byIp, byAccount } from '../middleware/rateLimit.js';
import { isInstitutionalEmail } from '../email-validator.js';
import { getAppPool } from '../app-db.js';
import { hiveClient } from '../hive.js';
import { logger } from '../logger.js';

const router = Router();
const SESSION_EXPIRY = '24h';
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const SIGNUP_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const MAX_LOGIN_FAILURES = 20;

// Username format: 3-16 chars, lowercase a-z, 0-9, dots/hyphens not at start/end
const USERNAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
const BAD_SEGMENT_RE = /[.-]{2}/; // No consecutive dots/hyphens

// Rate limiters
const sessionLimiter = rateLimit({ name: 'auth-session', windowMs: 3_600_000, max: 10, keyFn: byAccount });
const signupLimiter = rateLimit({ name: 'auth-signup', windowMs: 3_600_000, max: 10, keyFn: byIp });
const loginLimiter = rateLimit({ name: 'auth-login', windowMs: 3_600_000, max: 10, keyFn: byIp });
const resetRequestLimiter = rateLimit({ name: 'auth-reset-request', windowMs: 3_600_000, max: 5, keyFn: byIp });
const resetLimiter = rateLimit({ name: 'auth-reset', windowMs: 3_600_000, max: 5, keyFn: byIp });

// ─────────────────────────────────────────────────────────────
// POST /api/auth/session — Keychain-based JWT session (existing)
// ─────────────────────────────────────────────────────────────
router.post('/session', verifyHiveSignature, sessionLimiter, (req: Request, res: Response) => {
  const custody = req.hiveCustody || 'self';
  const token = jwt.sign(
    { sub: req.hiveUsername, custody },
    config.sessionSecret,
    { expiresIn: SESSION_EXPIRY },
  );
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();
  sendOk(res, { token, expires_at: expiresAt, custody });
});

// ─────────────────────────────────────────────────────────────
// GET /api/auth/username-available — Check Hive username availability
// ─────────────────────────────────────────────────────────────
router.get('/username-available', async (req: Request, res: Response) => {
  const { username } = req.query;
  if (!username || typeof username !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Username is required');
  }
  const normalized = username.trim().toLowerCase();
  if (!USERNAME_RE.test(normalized) || BAD_SEGMENT_RE.test(normalized)) {
    return sendOk(res, { available: false, reason: 'invalid_format' });
  }
  try {
    const [account] = await hiveClient.database.getAccounts([normalized]);
    sendOk(res, { available: !account, reason: account ? 'taken' : null });
  } catch (err) {
    logger.error({ err }, 'Username availability check failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Could not check username availability');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/signup — Light account signup (LA6)
// ─────────────────────────────────────────────────────────────
router.post('/signup', signupLimiter, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Registration not available');

  const { email, password, username, link_existing, full_name, institution, field, orcid } = req.body || {};
  const linkFlow = link_existing === true;

  // Validate required fields
  if (!email || typeof email !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Email is required');
  }
  if (!password || typeof password !== 'string' || password.length < 10) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Password must be at least 10 characters');
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Password must contain lowercase letters, uppercase letters, and numbers');
  }
  if (!linkFlow && (!username || typeof username !== 'string')) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Username is required');
  }
  if (!full_name || typeof full_name !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Full name is required');
  }
  if (!institution || typeof institution !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Institution is required');
  }
  if (!field || typeof field !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Field of research is required');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = !linkFlow && username ? username.trim().toLowerCase() : null;

  // Validate institutional email domain
  if (!isInstitutionalEmail(normalizedEmail)) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Only institutional email addresses are accepted');
  }

  // Validate username format (new accounts only)
  if (normalizedUsername && (!USERNAME_RE.test(normalizedUsername) || BAD_SEGMENT_RE.test(normalizedUsername))) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Username must be 3-16 characters, lowercase letters/numbers/dots/hyphens, not starting or ending with dots/hyphens');
  }

  try {
    // Check email not already registered
    const { rows: emailRows } = await pool.query<{ username: string }>(
      'SELECT username FROM light_accounts WHERE email = $1',
      [normalizedEmail],
    );
    if (emailRows.length > 0) {
      return sendError(res, 409, 'DUPLICATE', 'Email already registered');
    }

    // Check no pending signup with this email
    const { rows: pendingEmail } = await pool.query<{ id: number }>(
      'SELECT id FROM pending_signups WHERE email = $1 AND expires_at > NOW()',
      [normalizedEmail],
    );
    if (pendingEmail.length > 0) {
      return sendError(res, 409, 'DUPLICATE', 'A verification email has already been sent to this address');
    }

    if (normalizedUsername) {
      // New account: check username availability on Hive
      const [account] = await hiveClient.database.getAccounts([normalizedUsername]);
      if (account) {
        return sendError(res, 409, 'DUPLICATE', 'Username is already taken on Hive');
      }

      // Check no pending signup with this username
      const { rows: pendingUser } = await pool.query<{ id: number }>(
        'SELECT id FROM pending_signups WHERE username = $1 AND expires_at > NOW()',
        [normalizedUsername],
      );
      if (pendingUser.length > 0) {
        return sendError(res, 409, 'DUPLICATE', 'Username already has a pending signup');
      }
    }

    // Hash password with argon2id
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    // Generate verification token
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_EXPIRY_MS);

    // Store pending signup with accreditation fields
    const safeOrcid = orcid && typeof orcid === 'string' ? orcid.trim() : null;
    if (normalizedUsername) {
      await pool.query(
        `INSERT INTO pending_signups (username, email, password_hash, link_flow, full_name, institution, field, orcid, verify_token, expires_at)
         VALUES ($1, $2, $3, FALSE, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (username) DO UPDATE SET
           email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           full_name = EXCLUDED.full_name,
           institution = EXCLUDED.institution,
           field = EXCLUDED.field,
           orcid = EXCLUDED.orcid,
           verify_token = EXCLUDED.verify_token,
           expires_at = EXCLUDED.expires_at,
           created_at = NOW()`,
        [normalizedUsername, normalizedEmail, passwordHash, full_name.trim(), institution.trim(), field.trim(), safeOrcid, verifyToken, expiresAt],
      );
    } else {
      // Link flow: no username yet, insert by email (unique constraint)
      await pool.query(
        `INSERT INTO pending_signups (username, email, password_hash, link_flow, full_name, institution, field, orcid, verify_token, expires_at)
         VALUES (NULL, $1, $2, TRUE, $3, $4, $5, $6, $7, $8)`,
        [normalizedEmail, passwordHash, full_name.trim(), institution.trim(), field.trim(), safeOrcid, verifyToken, expiresAt],
      );
    }

    // Send verification email
    if (config.smtpHost) {
      try {
        const transporter = nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpPort === 465,
          auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
        });

        const verifyUrl = `${config.appUrl}/signup/verify?token=${verifyToken}`;
        await transporter.sendMail({
          from: config.smtpFrom,
          to: normalizedEmail,
          subject: 'PEvO - Verify your email',
          text: `Welcome to PEvO!\n\nPlease verify your email to complete your registration:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you did not sign up for PEvO, you can safely ignore this email.\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
        });
      } catch (mailErr) {
        logger.error({ err: (mailErr as Error).message }, 'Failed to send verification email');
        // Delete the pending signup since we couldn't send the email
        await pool.query('DELETE FROM pending_signups WHERE verify_token = $1', [verifyToken]);
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send verification email');
      }
    } else if (process.env.NODE_ENV !== 'production') {
      logger.info({ username: normalizedUsername, verifyToken }, 'Verification email skipped (SMTP not configured)');
    }

    sendOk(res, {
      message: `Verification email sent to ${maskEmail(normalizedEmail)}`,
      expires_at: expiresAt.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'Signup failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Registration failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/login — Password-based login (LA8)
// ─────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Login not available');

  const { username, email_or_username, password } = req.body || {};
  const loginId = email_or_username || username;

  if (!loginId || typeof loginId !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Username or email is required');
  }
  if (!password || typeof password !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Password is required');
  }

  const normalized = loginId.trim().toLowerCase();

  try {
    // Look up by username or email
    const { rows } = await pool.query<{
      username: string;
      password_hash: string;
      upgraded_at: string | null;
      login_failures: number;
    }>(
      `SELECT username, password_hash, upgraded_at,
              COALESCE((SELECT COUNT(*) FROM custody_audit_log
                WHERE custody_audit_log.username = light_accounts.username
                  AND operation_type = 'login_failure'
                  AND created_at > NOW() - INTERVAL '1 hour'), 0)::int AS login_failures
       FROM light_accounts
       WHERE username = $1 OR email = $1`,
      [normalized],
    );

    if (rows.length === 0) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials');
    }

    const account = rows[0];

    // Check account lockout (20 failures in the last hour)
    if (account.login_failures >= MAX_LOGIN_FAILURES) {
      return sendError(res, 403, 'ACCOUNT_LOCKED', 'Account temporarily locked due to too many failed attempts. Reset your password or try again later.');
    }

    // Verify password
    const valid = await argon2.verify(account.password_hash, password);
    if (!valid) {
      // Log failed attempt for lockout tracking
      await pool.query(
        'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
        [account.username, 'login_failure'],
      );
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials');
    }

    // Determine custody mode
    const custody = account.upgraded_at ? 'self' : 'light';

    const token = jwt.sign(
      { sub: account.username, custody },
      config.sessionSecret,
      { expiresIn: SESSION_EXPIRY },
    );
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();

    sendOk(res, { token, expires_at: expiresAt, custody, username: account.username });
  } catch (err) {
    logger.error({ err }, 'Login failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Login failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/reset-request — Request password reset email (LA13)
// ─────────────────────────────────────────────────────────────
router.post('/reset-request', resetRequestLimiter, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Email is required');
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // Look up account by email
    const { rows } = await pool.query<{ username: string }>(
      'SELECT username FROM light_accounts WHERE email = $1',
      [normalizedEmail],
    );

    // Always return success to prevent email enumeration
    if (rows.length === 0) {
      sendOk(res, { message: 'If an account exists with that email, a reset link has been sent.' });
      return;
    }

    const { username } = rows[0];

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);

    await pool.query(
      'UPDATE light_accounts SET reset_token = $1, reset_token_expires_at = $2 WHERE username = $3',
      [resetToken, expiresAt, username],
    );

    // Send reset email
    if (config.smtpHost) {
      try {
        const transporter = nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpPort === 465,
          auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
        });

        const resetUrl = `${config.appUrl}/auth/reset?token=${resetToken}`;
        await transporter.sendMail({
          from: config.smtpFrom,
          to: normalizedEmail,
          subject: 'PEvO - Password reset',
          text: `You requested a password reset for your PEvO account.\n\nReset your password here:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you did not request this, you can safely ignore this email.\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
        });
      } catch (mailErr) {
        logger.error({ err: (mailErr as Error).message }, 'Failed to send reset email');
        // Clear the token since we couldn't send the email
        await pool.query(
          'UPDATE light_accounts SET reset_token = NULL, reset_token_expires_at = NULL WHERE username = $1',
          [username],
        );
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send reset email');
      }
    } else if (process.env.NODE_ENV !== 'production') {
      logger.info({ username, resetToken }, 'Reset email skipped (SMTP not configured)');
    }

    sendOk(res, { message: 'If an account exists with that email, a reset link has been sent.' });
  } catch (err) {
    logger.error({ err }, 'Password reset request failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Password reset request failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/reset — Set new password using reset token (LA13)
// ─────────────────────────────────────────────────────────────
router.post('/reset', resetLimiter, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const { token, password } = req.body || {};
  if (!token || typeof token !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Reset token is required');
  }
  if (!password || typeof password !== 'string' || password.length < 10) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Password must be at least 10 characters');
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Password must contain lowercase letters, uppercase letters, and numbers');
  }

  try {
    // Look up the token — use timing-safe comparison via SQL
    const { rows } = await pool.query<{
      username: string;
      reset_token_expires_at: Date;
    }>(
      'SELECT username, reset_token_expires_at FROM light_accounts WHERE reset_token = $1',
      [token],
    );

    if (rows.length === 0) {
      return sendError(res, 400, 'INVALID_TOKEN', 'Invalid or expired reset token');
    }

    const account = rows[0];
    if (new Date() > account.reset_token_expires_at) {
      // Clear expired token
      await pool.query(
        'UPDATE light_accounts SET reset_token = NULL, reset_token_expires_at = NULL WHERE username = $1',
        [account.username],
      );
      return sendError(res, 400, 'INVALID_TOKEN', 'Reset token has expired');
    }

    // Hash new password
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    // Update password, clear reset token, invalidate all existing sessions
    await pool.query(
      `UPDATE light_accounts
       SET password_hash = $1,
           reset_token = NULL,
           reset_token_expires_at = NULL,
           sessions_invalidated_at = NOW()
       WHERE username = $2`,
      [passwordHash, account.username],
    );

    // Audit log (non-blocking)
    pool.query(
      'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
      [account.username, 'password_reset'],
    ).catch(() => {});

    sendOk(res, { message: 'Password has been reset. Please log in with your new password.' });
  } catch (err) {
    logger.error({ err }, 'Password reset failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Password reset failed');
  }
});

// ─── Helpers ─────────────────────────────────────────────────

function maskEmail(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '***@***';
  const [local, domain] = parts;
  const tld = domain.slice(domain.lastIndexOf('.'));
  const maskedLocal = local.length <= 2 ? '***' : local[0] + '***' + local[local.length - 1];
  return `${maskedLocal}@***${tld}`;
}

export default router;
