import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import argon2 from 'argon2';
import { z } from 'zod';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { sendOk, sendError } from '../response.js';
import { config } from '../config.js';
import { getAppPool } from '../app-db.js';
import { logger } from '../logger.js';
import { isPasswordValid, PASSWORD_POLICY_MESSAGE } from '../lib/password-policy.js';
import { ARGON2_OPTIONS } from '../lib/argon2-options.js';
import { runWithArgon2Slot, ArgonQueueFullError, ShuttingDownError } from '../lib/argon2-semaphore.js';

const readLimiter = rateLimit({ name: 'settings-read', windowMs: 60_000, max: 30, keyFn: byIp });
const writeLimiter = rateLimit({ name: 'settings-write', windowMs: 60_000, max: 10, keyFn: byIp });

const router = Router();

const EMAIL_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

const emailSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

const deleteSchema = z.object({
  confirm: z.literal(true),
});

function maskEmail(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '***@***';
  return parts[0][0] + '***@' + parts[1];
}

function sendVerificationEmail(to: string, token: string): Promise<void> {
  if (!config.smtpHost) {
    throw new Error('SMTP not configured');
  }
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });

  const verifyUrl = `${config.appUrl}/settings/verify-email/${token}`;
  return transporter.sendMail({
    from: config.smtpFrom,
    to,
    subject: 'PEvO - Verify your email',
    text: `Please verify your email address for PEvO:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you did not request this, you can safely ignore this email.\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
  }).then(() => {});
}

// ─────────────────────────────────────────────────────────────
// GET /api/settings/email — Return current email state
// ─────────────────────────────────────────────────────────────
router.get('/email', readLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const username = req.hiveUsername!;

  try {
    const { rows } = await pool.query<{
      email: string | null;
      verify_token: string | null;
      custody: string | null;
      upgraded_at: string | null;
      pending_email: string | null;
      password_hash: string | null;
    }>(
      'SELECT email, verify_token, custody, upgraded_at, pending_email, password_hash FROM accounts WHERE username = $1',
      [username],
    );

    if (rows.length === 0) {
      return sendOk(res, { hasEmail: false, custody: 'self', hasPassword: false });
    }

    const row = rows[0];
    sendOk(res, {
      hasEmail: row.email !== null,
      email: row.email ? maskEmail(row.email) : null,
      verified: row.verify_token === null || row.verify_token.startsWith('confirmed:'),
      custody: row.upgraded_at ? 'self' : (row.custody || 'self'),
      pendingChange: row.pending_email !== null,
      hasPassword: row.password_hash !== null,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch email status');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch email status');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/settings/email — Add or change email
// ─────────────────────────────────────────────────────────────
router.post('/email', writeLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Valid email is required');
  }
  const { email } = parsed.data;
  const username = req.hiveUsername!;

  try {
    // Check email not already used by another account
    const { rows: dupeRows } = await pool.query<{ id: number }>(
      'SELECT id FROM accounts WHERE email = $1 AND username != $2',
      [email, username],
    );
    if (dupeRows.length > 0) {
      return sendError(res, 409, 'DUPLICATE', 'This email is already associated with another account');
    }

    // Also check pending_email on other accounts
    const { rows: pendingDupeRows } = await pool.query<{ id: number }>(
      'SELECT id FROM accounts WHERE pending_email = $1 AND username != $2',
      [email, username],
    );
    if (pendingDupeRows.length > 0) {
      return sendError(res, 409, 'DUPLICATE', 'This email is already associated with another account');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + EMAIL_TOKEN_EXPIRY_MS);

    // Check if account row exists for this username
    const { rows: existing } = await pool.query<{ id: number }>(
      'SELECT id FROM accounts WHERE username = $1',
      [username],
    );

    if (existing.length === 0) {
      // Add flow: INSERT new row (Keychain user, no password)
      await pool.query(
        `INSERT INTO accounts (email, username, verify_token, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [email, username, token, expiresAt],
      );
    } else {
      // Change flow: set pending_email fields
      await pool.query(
        `UPDATE accounts
         SET pending_email = $1,
             pending_email_token = $2,
             pending_email_expires_at = $3
         WHERE username = $4`,
        [email, token, expiresAt, username],
      );
    }

    // Send verification email
    try {
      await sendVerificationEmail(email, token);
    } catch (mailErr) {
      logger.error({ err: (mailErr as Error).message }, 'Failed to send verification email');
      // Roll back: clean up the token we just wrote
      if (existing.length === 0) {
        await pool.query('DELETE FROM accounts WHERE username = $1 AND verify_token = $2', [username, token]);
      } else {
        await pool.query(
          'UPDATE accounts SET pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL WHERE username = $1',
          [username],
        );
      }
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send verification email');
    }

    sendOk(res, { message: 'Verification email sent' });
  } catch (err) {
    logger.error({ err }, 'Email add/change failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update email');
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/settings/email/verify/:token — Verify email
// ─────────────────────────────────────────────────────────────
router.get('/email/verify/:token', readLimiter, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const { token } = req.params;
  if (!token || typeof token !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Token is required');
  }

  try {
    // Check add flow first (verify_token match)
    const { rows: addRows } = await pool.query<{
      id: number;
      expires_at: Date | null;
    }>(
      'SELECT id, expires_at FROM accounts WHERE verify_token = $1',
      [token],
    );

    if (addRows.length > 0) {
      const row = addRows[0];
      if (row.expires_at && new Date() > new Date(row.expires_at)) {
        return sendError(res, 400, 'INVALID_TOKEN', 'Verification link has expired. Please request a new one.');
      }
      await pool.query(
        'UPDATE accounts SET verify_token = NULL, expires_at = NULL WHERE id = $1',
        [row.id],
      );
      return sendOk(res, { verified: true });
    }

    // Check change flow (pending_email_token match)
    const { rows: changeRows } = await pool.query<{
      id: number;
      pending_email: string;
      pending_email_expires_at: Date | null;
      email: string;
    }>(
      'SELECT id, pending_email, pending_email_expires_at, email FROM accounts WHERE pending_email_token = $1',
      [token],
    );

    if (changeRows.length > 0) {
      const row = changeRows[0];
      if (row.pending_email_expires_at && new Date() > new Date(row.pending_email_expires_at)) {
        return sendError(res, 400, 'INVALID_TOKEN', 'Verification link has expired. Please request a new one.');
      }

      const oldEmail = row.email;
      const newEmail = row.pending_email;

      await pool.query(
        `UPDATE accounts
         SET email = pending_email,
             pending_email = NULL,
             pending_email_token = NULL,
             pending_email_expires_at = NULL
         WHERE id = $1`,
        [row.id],
      );

      // Update notification_preferences.email if it matched the old email
      await pool.query(
        'UPDATE notification_preferences SET email = $1 WHERE email = $2',
        [newEmail, oldEmail],
      );

      return sendOk(res, { verified: true });
    }

    // Not found
    sendError(res, 400, 'INVALID_TOKEN', 'Invalid or expired verification link');
  } catch (err) {
    logger.error({ err }, 'Email verification failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Verification failed');
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/settings/email — Delete email and associated data
// ─────────────────────────────────────────────────────────────
router.delete('/email', writeLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const parsed = deleteSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Confirmation required');
  }

  const username = req.hiveUsername!;

  try {
    const { rows } = await pool.query<{
      id: number;
      custody: string | null;
      upgraded_at: string | null;
    }>(
      'SELECT id, custody, upgraded_at FROM accounts WHERE username = $1',
      [username],
    );

    if (rows.length === 0) {
      // 401, not 404 — for an authed endpoint reading the caller's own row,
      // "your account no longer exists" is a stale-session signal, not a
      // not-found-resource signal. The distinguishing 404 leaked account
      // deletion to an authed session-holder.
      return sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
    }

    const row = rows[0];

    // Log if light account user will lose login access
    if (row.custody === 'light' && !row.upgraded_at) {
      logger.warn({ username }, 'Light account user deleting email — will lose login access');
    }

    // Single transaction: audit log, then delete all data
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert audit log before deleting
      await client.query(
        'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
        [username, 'email_deleted'],
      );

      // Delete in FK-safe order
      await client.query('DELETE FROM custody_audit_log WHERE username = $1', [username]);
      await client.query('DELETE FROM notification_preferences WHERE username = $1', [username]);
      await client.query('DELETE FROM accounts WHERE username = $1', [username]);

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    sendOk(res, { deleted: true });
  } catch (err) {
    logger.error({ err }, 'Email deletion failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete email data');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/settings/set-password — Opt into password login (null-hash accounts only)
// Auth: verifyHiveSignature (Keychain) or Bearer JWT for light accounts.
// This is the "set from null" operation; rotating an existing password is a
// separate flow (not yet implemented) that must require the current password.
// ─────────────────────────────────────────────────────────────
router.post('/set-password', writeLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const username = req.hiveUsername!;
  const { password } = req.body || {};

  if (!isPasswordValid(password)) {
    return sendError(res, 400, 'VALIDATION_ERROR', PASSWORD_POLICY_MESSAGE);
  }

  try {
    const { rows } = await pool.query<{ id: number; password_hash: string | null; orcid: string | null }>(
      'SELECT id, password_hash, orcid FROM accounts WHERE username = $1',
      [username],
    );

    if (rows.length === 0) {
      // 401, not 404 — authed endpoint, missing-own-row ≡ stale session.
      return sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
    }

    if (rows[0].password_hash !== null) {
      return sendError(
        res,
        409,
        'PASSWORD_ALREADY_SET',
        'A password is already set for this account; use change-password (with the current password) to rotate it.',
      );
    }

    // Only ORCID-verified accounts can opt into password login. This keeps
    // the "set-password on null-hash account" invariant narrow: today only
    // the ORCID-path signup/recover leaves password_hash = NULL, and we do
    // not want future code paths that null the hash for other reasons to
    // silently inherit set-password eligibility.
    if (!rows[0].orcid) {
      return sendError(
        res,
        403,
        'ORCID_REQUIRED',
        'Set-password requires a linked ORCID account',
      );
    }

    const passwordHash = await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS));
    await pool.query(
      'UPDATE accounts SET password_hash = $1 WHERE id = $2',
      [passwordHash, rows[0].id],
    );

    sendOk(res, { message: 'Password set. You can now log in with your email/username and this password.' });
  } catch (err) {
    if (err instanceof ArgonQueueFullError) {
      logger.warn({ err }, 'argon2 queue saturated — returning 503');
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Authentication service temporarily overloaded. Please retry.');
    }
    if (err instanceof ShuttingDownError) {
      logger.info({ err }, 'argon2 semaphore shutting down — returning 503');
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Service shutting down. Please retry.');
    }
    logger.error({ err }, 'Failed to set password');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to set password');
  }
});

export default router;
