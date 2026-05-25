import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { z } from 'zod';
import { sendOk, sendError } from '../response.js';
import { config } from '../config.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { getAppPool } from '../app-db.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { logger } from '../logger.js';
import { decryptKey } from '../custody-crypto.js';
import { isPasswordValid, PASSWORD_POLICY_MESSAGE } from '../lib/password-policy.js';
import { ARGON2_OPTIONS } from '../lib/argon2-options.js';
import { runWithArgon2Slot } from '../lib/argon2-semaphore.js';
import { handleArgonError, ARGON_HANDLED } from '../lib/argon2-error-handler.js';
import { requestAbortSignal } from '../lib/request-abort-signal.js';
import { createSmtpTransporter } from '../lib/smtp.js';
import { maskEmail, sha256HexDigest } from '../lib/log-pii.js';
import { burnSentinel, SESSION_EXPIRY, SESSION_EXPIRY_MS } from './auth.js';

const router = Router();

const RecoverBodySchema = z.object({
  username: z.string().min(1),
  new_email: z.string().min(1),
  // Non-empty when present: ''→parse-reject, null/undefined→optional.
  // The previous shape `z.string().optional().nullable()` also accepted
  // empty strings, which the downstream `passwordProvided` guard
  // rejected at a later layer. Pushing the min-length up to the schema
  // layer makes the 400 VALIDATION_ERROR fail loudly on ''.
  new_password: z.string().min(1).optional().nullable(),
  memo_key: z.string().optional(),
  orcid_token: z.string().optional(),
});

// Two-phase memo-key recovery windows. The new-email verification token gates
// the swap (phase 2); it expires after the same 24h window the signup-verify
// token uses so a legitimate user has a full day to confirm. The dispute token
// mailed to the OLD email is intentionally longer-lived (48h) so the previous
// owner has a wider window to react and void a hostile rebind even if they
// notice it a day late. The dispute window starts at staging time, so a swap
// that already applied (within the first 24h) is still disputable for the
// remainder of the 48h via the audit trail.
const RECOVERY_VERIFY_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const RECOVERY_DISPUTE_TOKEN_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48 hours

// Extract the DOMAIN of an email for the old-email notification. The
// notification names only the new email's domain, never the full address, so a
// passive attacker who staged a hostile rebind cannot confirm the exact target
// mailbox from a leaked notification. Returns '(unknown)' for malformed input
// rather than throwing — the notification is best-effort and must not 500.
function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return '(unknown)';
  return email.slice(at + 1);
}

// ─────────────────────────────────────────────────────────────
// POST /api/auth/recover — Account recovery (seed phrase or ORCID)
// ─────────────────────────────────────────────────────────────
const recoverLimiter = rateLimit({ name: 'auth-recover', windowMs: 3_600_000, max: 10, keyFn: byIp });

router.post('/recover', recoverLimiter, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const parsed = RecoverBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body');
  }
  const { username, memo_key, orcid_token, new_email, new_password } = parsed.data;

  // Business-required guards (Zod enforced shape only).
  if (!memo_key && !orcid_token) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Either memo_key or orcid_token is required for recovery');
  }
  if (memo_key && orcid_token) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Supply exactly one of memo_key or orcid_token, not both');
  }

  // Password is optional on ORCID recovery — null/omitted → password_hash = NULL.
  // For seed-phrase recovery it remains required (that is the only credential the
  // user proved knowledge of, so we force a fresh password rather than leaving the
  // account passwordless). If supplied on either path, enforce signup strength.
  const passwordProvided = new_password !== null && new_password !== undefined && new_password !== '';
  if (orcid_token && !memo_key) {
    // ORCID path: password optional
    if (passwordProvided && !isPasswordValid(new_password)) {
      return sendError(res, 400, 'VALIDATION_ERROR', PASSWORD_POLICY_MESSAGE);
    }
  } else {
    // Seed-phrase path: password required
    if (!passwordProvided || !isPasswordValid(new_password)) {
      return sendError(res, 400, 'VALIDATION_ERROR', PASSWORD_POLICY_MESSAGE);
    }
  }

  const normalizedUsername = username.trim().toLowerCase();
  const normalizedEmail = new_email.trim().toLowerCase();

  try {
    // Look up active account by username
    const { rows } = await pool.query<{
      id: number;
      username: string;
      email: string | null;
      memo_key_enc: Buffer | null;
      iv_memo: Buffer | null;
      orcid: string | null;
      custody: string | null;
      upgraded_at: string | null;
    }>(
      `SELECT id, username, email, memo_key_enc, iv_memo, orcid, custody, upgraded_at
       FROM accounts WHERE username = $1 AND verify_token IS NULL`,
      [normalizedUsername],
    );

    if (rows.length === 0) {
      // Unknown-username path: burn sentinel ONLY when the happy-path would
      // run argon2.hash on new_password. For ORCID-recovery-without-password,
      // the happy path skips argon2 entirely (~5-15ms); burning sentinel on
      // the unknown-username branch (~50ms) would INVERT the oracle —
      // unknown would be slower than known-ORCID-no-password, exploitable by
      // any attacker holding an ORCID token. Gate on passwordProvided so the
      // unknown/known wall-times match for each caller shape.
      if (passwordProvided) {
        await burnSentinel(new_password!, abortSignal);
      }
      return sendError(res, 404, 'NOT_FOUND', 'Account not found');
    }

    const account = rows[0];

    // ── Method A: Seed-phrase recovery via memo key comparison ──
    // Two-phase: a verified memo key STAGES the swap (it does not apply it).
    // The new email must prove control via a mailed token (phase 2) before
    // `email` / `password_hash` change. Whoever holds the seed phrase can no
    // longer silently capture the account's contact path; they must also
    // control the mailbox they are rebinding to, and the previous owner is
    // notified with a dispute link. See migration 012_pending_recovery.sql.
    if (memo_key) {
      if (!account.memo_key_enc || !account.iv_memo) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Account does not support seed phrase recovery');
      }

      let storedMemoKey: string;
      try {
        storedMemoKey = decryptKey(account.username, account.memo_key_enc, account.iv_memo);
      } catch (err) {
        logger.error(
          {
            event: 'auth.recover.memo_decrypt_failed',
            route: 'auth.recover',
            err,
            username: account.username,
          },
          'Failed to decrypt memo key during recovery',
        );
        return sendError(res, 500, 'INTERNAL_ERROR', 'Recovery failed');
      }

      // Constant-time comparison (handle different lengths safely)
      const providedBuf = Buffer.from(memo_key, 'utf8');
      const storedBuf = Buffer.from(storedMemoKey, 'utf8');
      const match = providedBuf.length === storedBuf.length &&
        crypto.timingSafeEqual(providedBuf, storedBuf);

      if (!match) {
        pool.query(
          'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
          [account.username, 'recovery_failure'],
        ).catch(() => {});
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid recovery credentials');
      }

      // Check new email isn't taken by another active account. Runs AFTER memo
      // verification so an attacker without the seed phrase cannot probe
      // email-in-use status (409) vs not (proceed) — the check is gated behind
      // proof of the recovery factor.
      const { rows: emailRows } = await pool.query<{ id: number }>(
        'SELECT id FROM accounts WHERE email = $1 AND id != $2',
        [normalizedEmail, account.id],
      );
      if (emailRows.length > 0) {
        return sendError(res, 409, 'DUPLICATE', 'Email already in use');
      }

      // Hash the new password now (phase 1) so the plaintext is never
      // persisted and the argon2 cost is paid once. The seed-phrase path
      // always supplies a password (enforced above), so this is non-null.
      const newPasswordHash = await runWithArgon2Slot(
        () => argon2.hash(new_password!, ARGON2_OPTIONS),
        { signal: abortSignal },
      );

      // Mint the two tokens. The verify token gates the swap (mailed to the
      // NEW address); the dispute token voids it (mailed to the OLD address).
      const verifyToken = crypto.randomBytes(32).toString('hex');
      const disputeToken = crypto.randomBytes(32).toString('hex');
      const verifyTokenHash = crypto.createHash('sha256').update(verifyToken).digest();
      const disputeTokenHash = crypto.createHash('sha256').update(disputeToken).digest();
      const verifyExpiresAt = new Date(Date.now() + RECOVERY_VERIFY_TOKEN_EXPIRY_MS);
      const disputeExpiresAt = new Date(Date.now() + RECOVERY_DISPUTE_TOKEN_EXPIRY_MS);
      const requestIpHash = req.ip ? sha256HexDigest(req.ip) : null;
      const oldEmail = account.email;
      const oldEmailHash = oldEmail ? sha256HexDigest(oldEmail) : null;

      // A new staging request supersedes any prior un-consumed one for this
      // username (re-issued link, changed-mind on the new address). Delete
      // stale rows then insert, in one transaction so a concurrent phase-2 on
      // a stale token cannot interleave with the supersede.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM pending_recovery WHERE username = $1 AND consumed_at IS NULL',
          [account.username],
        );
        await client.query(
          `INSERT INTO pending_recovery
             (username, new_email, new_password_hash,
              verify_token_hash, verify_expires_at,
              dispute_token_hash, dispute_expires_at,
              request_ip_hash, old_email_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            account.username,
            normalizedEmail,
            newPasswordHash,
            verifyTokenHash,
            verifyExpiresAt,
            disputeTokenHash,
            disputeExpiresAt,
            requestIpHash,
            oldEmailHash,
          ],
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      // Notify the NEW email with the verification link (phase-2 proof of
      // control). SMTP failures must NOT 500: per the timing-equalization
      // SMTP-failure-mode convention, mail-send failures log warn and the
      // route still returns its success envelope. A user whose verify mail
      // failed transiently can re-issue by re-running phase 1.
      if (config.smtpHost) {
        try {
          const transporter = createSmtpTransporter();
          const verifyUrl = `${config.appUrl}/recover/verify?token=${verifyToken}`;
          await transporter.sendMail({
            from: config.smtpFrom,
            to: normalizedEmail,
            subject: 'PEvO - Confirm your account recovery',
            text: `A recovery request was made for your PEvO account.\n\nConfirm this new email address to complete recovery:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you did not request this, you can safely ignore this email and no change will be made.\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
          });
        } catch (mailErr) {
          logger.warn(
            { event: 'auth.recover.verify_smtp_send_failed', route: 'auth.recover', err: mailErr },
            'Recovery verify email send failed',
          );
        }
      } else {
        logger.warn(
          { event: 'auth.recover.verify_smtp_not_configured', route: 'auth.recover' },
          'SMTP not configured — recovery verify email not sent',
        );
      }

      // Notify the OLD email so the prior owner can dispute. Name only the new
      // email DOMAIN, never the full address, and include the dispute link.
      // Same SMTP-failure posture as above. Skip entirely when the account had
      // no email (ORCID-only origin) — there is no prior owner to notify.
      if (oldEmail) {
        if (config.smtpHost) {
          try {
            const transporter = createSmtpTransporter();
            const disputeUrl = `${config.appUrl}/recover/dispute?token=${disputeToken}`;
            await transporter.sendMail({
              from: config.smtpFrom,
              to: oldEmail,
              subject: 'PEvO - Account recovery requested',
              text: `A recovery request was made for your PEvO account using your seed phrase.\n\nIf this was you, no action is needed; the change completes once the new email address (${emailDomain(normalizedEmail)}) is confirmed.\n\nIf this was NOT you, dispute it here within 48 hours to stop the change:\n\n${disputeUrl}\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
            });
          } catch (mailErr) {
            logger.warn(
              { event: 'auth.recover.dispute_smtp_send_failed', route: 'auth.recover', err: mailErr },
              'Recovery dispute notification send failed',
            );
          }
        } else {
          logger.warn(
            { event: 'auth.recover.dispute_smtp_not_configured', route: 'auth.recover' },
            'SMTP not configured — recovery dispute notification not sent',
          );
        }
      }

      // Phase 1 complete. No JWT, no swap. The caller must click the link in
      // the new mailbox to finalize via POST /api/auth/recover/verify.
      return sendOk(res, {
        recovery: 'pending_verification',
        message: `Confirm the recovery by clicking the link sent to ${maskEmail(normalizedEmail)}.`,
      });
    }

    // ── Method B: ORCID recovery ──
    // ORCID recovery is severed once the account has upgraded to self-custody.
    // Post-upgrade the account is under on-chain (Keychain) control and the
    // platform holds no keys; allowing the original ORCID link to still
    // trigger a server-side email/password rebind would let an attacker
    // holding that ORCID link recover an account no longer under platform
    // custody. Gate on `upgraded_at IS NULL` (state D is excluded). The 401 +
    // generic message matches the no-ORCID branch so the route does not become
    // an upgrade-state oracle.
    if (orcid_token) {
      if (account.upgraded_at || !account.orcid) {
        if (account.upgraded_at) {
          logger.warn(
            {
              event: 'auth.recover.orcid_after_upgrade_rejected',
              route: 'auth.recover',
              username: account.username,
            },
            'ORCID recovery rejected — account upgraded to self-custody',
          );
        }
        return sendError(res, 401, 'UNAUTHORIZED', 'Account does not have a verified ORCID');
      }

      // Look up verified ORCID from nonce
      let verifiedOrcidId: string | null = null;
      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        const raw = await redis.get(`${config.appTag}:orcid_verified:${orcid_token}`);
        if (raw) {
          await redis.del(`${config.appTag}:orcid_verified:${orcid_token}`);
          const parsed = JSON.parse(raw) as { orcid_id: string };
          verifiedOrcidId = parsed.orcid_id;
        }
      } else {
        const { orcidVerified } = await import('./orcid.js');
        const entry = orcidVerified.get(orcid_token);
        if (entry && entry.expires > Date.now()) {
          verifiedOrcidId = entry.orcid_id;
          orcidVerified.delete(orcid_token);
        }
      }

      if (!verifiedOrcidId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid or expired ORCID token');
      }

      if (verifiedOrcidId !== account.orcid) {
        pool.query(
          'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
          [account.username, 'recovery_failure'],
        ).catch(() => {});
        return sendError(res, 401, 'UNAUTHORIZED', 'ORCID does not match account');
      }

      // Check new email isn't taken by another active account. Runs AFTER
      // ORCID verification so the check is gated behind proof of the factor.
      const { rows: emailRows } = await pool.query<{ id: number }>(
        'SELECT id FROM accounts WHERE email = $1 AND id != $2',
        [normalizedEmail, account.id],
      );
      if (emailRows.length > 0) {
        return sendError(res, 409, 'DUPLICATE', 'Email already in use');
      }

      // ORCID recovery applies immediately: the fresh OAuth round-trip already
      // proves control of the registered ORCID factor, which is the email-side
      // proof the memo-key path lacked. Hash new password if provided;
      // otherwise null (passwordless ORCID recovery leaves password-login
      // disabled until the user opts in via /api/settings/set-password).
      const passwordHash = passwordProvided
        ? await runWithArgon2Slot(() => argon2.hash(new_password!, ARGON2_OPTIONS), { signal: abortSignal })
        : null;

      await pool.query(
        `UPDATE accounts
         SET password_hash = $1,
             email = $2,
             sessions_invalidated_at = NOW()
         WHERE id = $3`,
        [passwordHash, normalizedEmail, account.id],
      );

      pool.query(
        'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
        [account.username, 'account_recovery'],
      ).catch(() => {});

      const custody = account.upgraded_at ? 'self' : (account.custody || 'light');
      const token = jwt.sign(
        { sub: account.username, custody },
        config.sessionSecret,
        { expiresIn: SESSION_EXPIRY },
      );
      const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();

      return sendOk(res, { token, expires_at: expiresAt, custody, username: account.username });
    }

    // Unreachable: the business-required guards above enforce exactly one of
    // memo_key / orcid_token. Defensive 400 in case a future refactor drops a
    // guard.
    return sendError(res, 400, 'VALIDATION_ERROR', 'Either memo_key or orcid_token is required for recovery');
  } catch (err) {
    if (handleArgonError(res, err) === ARGON_HANDLED) return;
    logger.error(
      { event: 'auth.recover.failed', route: 'auth.recover', err },
      'Account recovery failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Account recovery failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/recover/verify — Phase 2 of memo-key recovery
// Apply the staged email/password swap once the new mailbox proves control.
// ─────────────────────────────────────────────────────────────
const RecoverTokenBodySchema = z.object({
  token: z.string().min(1),
});

router.post('/recover/verify', recoverLimiter, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const parsed = RecoverTokenBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body');
  }
  const { token } = parsed.data;
  const tokenHash = crypto.createHash('sha256').update(token).digest();

  try {
    // Resolve the staging row by verify-token digest. The plaintext token only
    // ever existed in the mailed link; we look up by its SHA-256.
    // The forensic digests (request_ip_hash, old_email_hash) are written at
    // phase 1 and persist on this row; phase 2 does not re-read them — the
    // consumed row IS the durable forensic record (see the apply transaction
    // below for why the digests live here rather than in custody_audit_log).
    const { rows } = await pool.query<{
      id: number;
      username: string;
      new_email: string;
      new_password_hash: string | null;
      verify_expires_at: Date;
      disputed_at: Date | null;
      consumed_at: Date | null;
    }>(
      `SELECT id, username, new_email, new_password_hash, verify_expires_at,
              disputed_at, consumed_at
       FROM pending_recovery WHERE verify_token_hash = $1`,
      [tokenHash],
    );

    if (rows.length === 0) {
      return sendError(res, 400, 'INVALID_TOKEN', 'Invalid or expired recovery link');
    }
    const staged = rows[0];

    if (staged.consumed_at) {
      return sendError(res, 400, 'INVALID_TOKEN', 'This recovery link has already been used.');
    }
    if (staged.disputed_at) {
      // The prior owner voided this swap. Generic INVALID_TOKEN so the link
      // does not become a dispute-status oracle to the link-holder.
      return sendError(res, 400, 'INVALID_TOKEN', 'Invalid or expired recovery link');
    }
    if (new Date() > new Date(staged.verify_expires_at)) {
      return sendError(res, 400, 'INVALID_TOKEN', 'Recovery link has expired. Please start recovery again.');
    }

    // Re-resolve the account at apply time: it may have been deleted or
    // upgraded between phase 1 and phase 2. An upgraded account is now under
    // self-custody (Keychain); a stale staged memo-key swap must not apply.
    const { rows: acctRows } = await pool.query<{
      id: number;
      username: string;
      custody: string | null;
      upgraded_at: string | null;
    }>(
      'SELECT id, username, custody, upgraded_at FROM accounts WHERE username = $1 AND verify_token IS NULL',
      [staged.username],
    );
    if (acctRows.length === 0 || acctRows[0].upgraded_at) {
      return sendError(res, 400, 'INVALID_TOKEN', 'Invalid or expired recovery link');
    }
    const account = acctRows[0];

    // Re-check the new email is still free (a concurrent signup could have
    // claimed it between phase 1 and phase 2).
    const { rows: emailRows } = await pool.query<{ id: number }>(
      'SELECT id FROM accounts WHERE email = $1 AND id != $2',
      [staged.new_email, account.id],
    );
    if (emailRows.length > 0) {
      return sendError(res, 409, 'DUPLICATE', 'Email already in use');
    }

    // Apply the swap, consume the staging row, and record the recovery in the
    // audit log — all in one transaction. The recovery's forensic digests
    // (requesting-IP digest, old-email digest, timestamp) live on the
    // CONSUMED `pending_recovery` row, which is NOT swept by the account-delete
    // anonymizer (that sweep touches only custody_audit_log /
    // notification_preferences / accounts). So the forensic trail survives even
    // the email-delete path: the consumed staging row records who initiated the
    // swap and from where, durably and independently of the account row.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE accounts
         SET password_hash = COALESCE($1, password_hash),
             email = $2,
             sessions_invalidated_at = NOW()
         WHERE id = $3`,
        [staged.new_password_hash, staged.new_email, account.id],
      );
      await client.query(
        'UPDATE pending_recovery SET consumed_at = NOW() WHERE id = $1',
        [staged.id],
      );
      await client.query(
        'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
        [account.username, 'account_recovery'],
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    const custody = account.upgraded_at ? 'self' : (account.custody || 'light');
    const token2 = jwt.sign(
      { sub: account.username, custody },
      config.sessionSecret,
      { expiresIn: SESSION_EXPIRY },
    );
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();

    sendOk(res, { token: token2, expires_at: expiresAt, custody, username: account.username });
  } catch (err) {
    logger.error(
      { event: 'auth.recover_verify.failed', route: 'auth.recover-verify', err },
      'Account recovery verification failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Account recovery failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/recover/dispute — Old email-holder voids a staged recovery
// Clicking the dispute link from the OLD mailbox stops the swap (or, if it
// already applied within the dispute window, marks it disputed for forensics).
// ─────────────────────────────────────────────────────────────
router.post('/recover/dispute', recoverLimiter, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const parsed = RecoverTokenBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body');
  }
  const { token } = parsed.data;
  const tokenHash = crypto.createHash('sha256').update(token).digest();

  try {
    const { rows } = await pool.query<{
      id: number;
      username: string;
      dispute_expires_at: Date;
      disputed_at: Date | null;
      consumed_at: Date | null;
    }>(
      `SELECT id, username, dispute_expires_at, disputed_at, consumed_at
       FROM pending_recovery WHERE dispute_token_hash = $1`,
      [tokenHash],
    );

    if (rows.length === 0) {
      return sendError(res, 400, 'INVALID_TOKEN', 'Invalid or expired dispute link');
    }
    const staged = rows[0];

    if (new Date() > new Date(staged.dispute_expires_at)) {
      return sendError(res, 400, 'INVALID_TOKEN', 'Dispute link has expired.');
    }

    // Mark disputed (idempotent if clicked twice). The phase-2 verify handler
    // refuses to apply a disputed row; this is the kill switch for a hostile
    // rebind the prior owner did not authorize. A disputed-after-consumed row
    // is recorded as the forensic signal that the swap applied but was later
    // contested. Emit the audit row regardless so the operator sees the
    // dispute even on an already-applied swap.
    await pool.query(
      'UPDATE pending_recovery SET disputed_at = COALESCE(disputed_at, NOW()) WHERE id = $1',
      [staged.id],
    );
    pool.query(
      'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
      [staged.username, 'recovery_dispute'],
    ).catch(() => {});

    sendOk(res, {
      disputed: true,
      message: 'The recovery request has been stopped. No change has been made to your account.',
    });
  } catch (err) {
    logger.error(
      { event: 'auth.recover_dispute.failed', route: 'auth.recover-dispute', err },
      'Account recovery dispute failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Dispute failed');
  }
});

export default router;
