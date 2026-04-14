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

  const { email, password, full_name, institution, field, orcid } = req.body || {};

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

  // Validate institutional email domain
  if (!isInstitutionalEmail(normalizedEmail)) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Only institutional email addresses are accepted');
  }

  try {
    // Check email not already registered or pending
    const { rows: existingRows } = await pool.query<{ verify_token: string | null }>(
      'SELECT verify_token FROM accounts WHERE email = $1',
      [normalizedEmail],
    );
    if (existingRows.length > 0) {
      if (existingRows[0].verify_token === null) {
        return sendError(res, 409, 'DUPLICATE', 'Email already registered');
      }
      if (existingRows[0].verify_token.startsWith('confirmed:')) {
        return sendError(res, 409, 'DUPLICATE', 'Email already verified. Please log in to continue.');
      }
      // Unverified — allow overwrite via ON CONFLICT below
    }

    // Hash password with argon2id
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    // Generate verification token
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_EXPIRY_MS);

    // Store signup in accounts table
    const safeOrcid = orcid && typeof orcid === 'string' ? orcid.trim() : null;
    await pool.query(
      `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         full_name = EXCLUDED.full_name,
         institution = EXCLUDED.institution,
         field = EXCLUDED.field,
         orcid = EXCLUDED.orcid,
         verify_token = EXCLUDED.verify_token,
         expires_at = EXCLUDED.expires_at,
         created_at = NOW()`,
      [normalizedEmail, passwordHash, full_name.trim(), institution.trim(), field.trim(), safeOrcid, verifyToken, expiresAt],
    );

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
        // Delete the account row since we couldn't send the email
        await pool.query('DELETE FROM accounts WHERE verify_token = $1', [verifyToken]);
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send verification email');
      }
    } else if (process.env.NODE_ENV !== 'production') {
      logger.info({ email: normalizedEmail, verifyToken }, 'Verification email skipped (SMTP not configured)');
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
// POST /api/auth/resend-verification — Resend verification email
// Requires email + password to prevent abuse
// ─────────────────────────────────────────────────────────────
const resendLimiter = rateLimit({ name: 'auth-resend', windowMs: 3_600_000, max: 3, keyFn: byIp });

router.post('/resend-verification', resendLimiter, async (req: Request, res: Response) => {
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
      // Constant-time response to prevent email enumeration
      return sendOk(res, { message: 'If that email has a pending signup, a new verification link has been sent.' });
    }

    const account = rows[0];

    const passwordValid = await argon2.verify(account.password_hash, password);
    if (!passwordValid) {
      return sendOk(res, { message: 'If that email has a pending signup, a new verification link has been sent.' });
    }

    // Already active or confirmed — no need to resend
    if (!account.verify_token) {
      return sendOk(res, { message: 'Your account is already active. Please log in.' });
    }
    if (account.verify_token.startsWith('confirmed:')) {
      return sendOk(res, { message: 'Your email is already verified. Please log in to continue your signup.' });
    }

    // Generate new token and reset expiry
    const newToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_EXPIRY_MS);
    await pool.query(
      'UPDATE accounts SET verify_token = $1, expires_at = $2 WHERE id = $3',
      [newToken, expiresAt, account.id],
    );

    if (config.smtpHost) {
      try {
        const transporter = nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpPort === 465,
          auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
        });

        const verifyUrl = `${config.appUrl}/signup/verify?token=${newToken}`;
        await transporter.sendMail({
          from: config.smtpFrom,
          to: normalizedEmail,
          subject: 'PEvO - Verify your email',
          text: `Welcome to PEvO!\n\nPlease verify your email to complete your registration:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you did not sign up for PEvO, you can safely ignore this email.\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
        });
      } catch (mailErr) {
        logger.error({ err: (mailErr as Error).message }, 'Failed to resend verification email');
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send verification email');
      }
    }

    sendOk(res, { message: 'If that email has a pending signup, a new verification link has been sent.' });
  } catch (err) {
    logger.error({ err }, 'Resend verification failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to resend verification email');
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
    // Single-table lookup by username or email
    const { rows } = await pool.query<{
      id: number;
      email: string;
      username: string | null;
      password_hash: string;
      verify_token: string | null;
      custody: string | null;
      upgraded_at: string | null;
      expires_at: Date | null;
      login_failures: number;
    }>(
      `SELECT a.id, a.email, a.username, a.password_hash, a.verify_token,
              a.custody, a.upgraded_at, a.expires_at,
              COALESCE((SELECT COUNT(*) FROM custody_audit_log
                WHERE custody_audit_log.username = a.username
                  AND operation_type = 'login_failure'
                  AND created_at > NOW() - INTERVAL '1 hour'), 0)::int AS login_failures
       FROM accounts a
       WHERE a.username = $1 OR a.email = $1`,
      [normalized],
    );

    if (rows.length === 0) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials');
    }

    const account = rows[0];

    // Verify password first (before revealing account state)
    const valid = await argon2.verify(account.password_hash, password);
    if (!valid) {
      if (account.username) {
        await pool.query(
          'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
          [account.username, 'login_failure'],
        );
      }
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials');
    }

    // Account not yet active — handle pending states
    if (account.verify_token !== null) {
      if (account.verify_token.startsWith('confirmed:')) {
        // Email verified but signup not completed — let them continue
        return res.status(409).json({
          status: 'error',
          error: { code: 'PENDING_SIGNUP', message: 'Your signup is not complete yet.' },
          data: { auth_token: account.verify_token, email: account.email },
        });
      }
      // Unverified — check expiry
      if (account.expires_at && new Date() > new Date(account.expires_at)) {
        await pool.query('DELETE FROM accounts WHERE id = $1', [account.id]);
        return sendError(res, 410, 'SIGNUP_EXPIRED', 'Your signup has expired. Please sign up again.');
      }
      return sendError(res, 409, 'PENDING_UNVERIFIED', 'Your email has not been verified yet.');
    }

    // Active account — check lockout
    if (account.login_failures >= MAX_LOGIN_FAILURES) {
      return sendError(res, 403, 'ACCOUNT_LOCKED', 'Account temporarily locked due to too many failed attempts. Reset your password or try again later.');
    }

    const custody = account.upgraded_at ? 'self' : (account.custody || 'light');

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
    const { rows } = await pool.query<{ id: number; username: string | null }>(
      'SELECT id, username FROM accounts WHERE email = $1',
      [normalizedEmail],
    );

    // Always return success to prevent email enumeration
    if (rows.length === 0) {
      sendOk(res, { message: 'If an account exists with that email, a reset link has been sent.' });
      return;
    }

    const account = rows[0];

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);

    await pool.query(
      'UPDATE accounts SET reset_token = $1, reset_token_expires_at = $2 WHERE id = $3',
      [resetToken, expiresAt, account.id],
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
          'UPDATE accounts SET reset_token = NULL, reset_token_expires_at = NULL WHERE id = $1',
          [account.id],
        );
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send reset email');
      }
    } else if (process.env.NODE_ENV !== 'production') {
      logger.info({ id: account.id, resetToken }, 'Reset email skipped (SMTP not configured)');
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
    // Look up the token
    const { rows } = await pool.query<{
      id: number;
      username: string | null;
      reset_token_expires_at: Date;
    }>(
      'SELECT id, username, reset_token_expires_at FROM accounts WHERE reset_token = $1',
      [token],
    );

    if (rows.length === 0) {
      return sendError(res, 400, 'INVALID_TOKEN', 'Invalid or expired reset token');
    }

    const account = rows[0];
    if (new Date() > account.reset_token_expires_at) {
      // Clear expired token
      await pool.query(
        'UPDATE accounts SET reset_token = NULL, reset_token_expires_at = NULL WHERE id = $1',
        [account.id],
      );
      return sendError(res, 400, 'INVALID_TOKEN', 'Reset token has expired');
    }

    // Hash new password
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    // Update password, clear reset token, invalidate all existing sessions
    await pool.query(
      `UPDATE accounts
       SET password_hash = $1,
           reset_token = NULL,
           reset_token_expires_at = NULL,
           sessions_invalidated_at = NOW()
       WHERE id = $2`,
      [passwordHash, account.id],
    );

    // Audit log (non-blocking)
    if (account.username) {
      pool.query(
        'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
        [account.username, 'password_reset'],
      ).catch(() => {});
    }

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
