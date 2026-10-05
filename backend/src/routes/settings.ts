import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { createSmtpTransporter } from '../lib/smtp.js';
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
import { runWithArgon2Slot } from '../lib/argon2-semaphore.js';
import { handleArgonError, ARGON_HANDLED } from '../lib/argon2-error-handler.js';
import { requestAbortSignal } from '../lib/request-abort-signal.js';
import { hashEmailForLogs, maskEmail } from '../lib/log-pii.js';
import {
  changeEmailFreshAuthTarget,
  computeFreshAuthTargetHash,
  consumeFreshAuthToken,
  deleteAccountFreshAuthTarget,
  setPasswordFreshAuthTarget,
  type FreshAuthMechanism,
  type FreshAuthVerifyFailureReason,
} from '../lib/fresh-auth.js';
import { custodyClaimFor } from '../lib/custody-claim.js';

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

function sendVerificationEmail(to: string, token: string): Promise<void> {
  if (!config.smtpHost) {
    throw new Error('SMTP not configured');
  }
  const transporter = createSmtpTransporter();

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
      custody: custodyClaimFor(row),
      pendingChange: row.pending_email !== null,
      hasPassword: row.password_hash !== null,
    });
  } catch (err) {
    logger.error(
      { event: 'settings.email_get.failed', route: 'settings.email-get', username, err },
      'Failed to fetch email status',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch email status');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/settings/email — Add or change email
// ─────────────────────────────────────────────────────────────
//
// The change-email branch (existing row, including the re-issue branch an
// unverified state G row takes) is a critical action per ARCHITECTURE.md
// § 6.5 invariant #1 — a stolen JWT must not be a one-step takeover vector.
// When authenticated via Bearer JWT (the only auth path that can be replayed
// without a fresh signature), the request body MUST carry a
// `fresh_auth_proof` whose mechanism matches what the account has
// registered:
//
//   State A (password, no orcid)  : 'password' only
//   State B (password + orcid)    : 'password' OR 'orcid'
//   State C (orcid, no password)  : 'orcid' only
//   State D (upgraded)            : 'orcid' when linked. The password
//                                   issuer refuses a non-light claim; a
//                                   password proof minted while the row was
//                                   still light stays consumable until it
//                                   expires (the upgrade sweeps session
//                                   proofs only)
//   State G (Keychain + email)    : 'orcid' when linked (the password issuer
//                                   refuses the row's non-light claim)
//
// Keychain (Hive-signature) requests skip the body-proof check entirely — the
// per-request signed canonical message IS the fresh proof and is already
// timestamp + replay-bounded by `verifyHiveSignature`.
//
// The Add-flow no-row branch (Keychain user with no `accounts` row yet) is
// kept on the Hive-signature path by an explicit JWT rejection, not by the
// absence of a JWT: `POST /api/auth/session` mints a JWT for any
// Keychain-signed caller whether or not a row exists, and account deletion
// leaves earlier JWTs live. A row-less caller has no registered factor a
// body proof could match, so on the signature path the no-row INSERT is
// gated by the Hive-signature freshness alone. The discriminator below reads
// `req.hiveAuthMethod` set by the unified `verifyHiveSignature` middleware:
// the JWT-success branch sets it to `'jwt'`, the signature-success branch
// sets it to `'signature'`.
//
// Handler order (load-bearing — closes the 401-vs-409 enumeration oracle):
//   (1) Body validation (400 on shape error; no state disclosure).
//   (2) SELECT existing row by username (drives Add vs re-issue vs Change
//       discrimination and supplies the snapshot used by the SMTP-fail
//       restore path).
//   (3) On an existing row (Change or re-issue) + JWT path: consume
//       fresh-auth proof + mechanism check. MUST fire BEFORE the
//       duplicate-email SELECT below; without this ordering, a JWT-only
//       attacker (no proof) could probe candidate emails and read
//       registration state from the 409-vs-401 differential.
//   (4) On Add branch: reject JWT auth. This guard is what keeps the no-row
//       INSERT on the Hive-signature path: `POST /api/auth/session` mints a
//       JWT for a row-less Keychain caller, and account deletion leaves
//       earlier JWTs live.
//   (5) Duplicate-email SELECTs (409 on hit) — only reached on valid proof
//       or via the Keychain path.
//   (6) INSERT (Add); on an existing row whose email is still unverified
//       (state G with a hex verify_token), re-issue the add-flow
//       verification by UPDATE of email, verify_token and expires_at with
//       the pending_email triple cleared; otherwise UPDATE (Change) the
//       pending_email triple.
//   (7) Send verification email. SMTP failure follows the catch-warn-200
//       status-code-oracle convention (`agents/docs/solutions/conventions/
//       timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`): catch,
//       log warn, return uniform 200. DB write rolls back: DELETE on Add;
//       snapshot-restore scoped by the just-written token on re-issue and
//       on Change (the scope guards against a concurrent request having
//       already overwritten the row — restore no-ops in that case rather
//       than clobbering its in-flight state).
router.post('/email', writeLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Valid email is required');
  }
  const { email } = parsed.data;
  const username = req.hiveUsername!;

  // JWT-vs-Keychain discriminator. The Hive-signature path runs after JWT in
  // `verifyHiveSignature` and is fresh per-request; we only require a body
  // proof on the JWT path.
  const isJwtPath = req.hiveAuthMethod === 'jwt';

  try {
    // Read existing row first: drives Add vs re-issue vs Change
    // discrimination, supplies the mechanism check in the fresh-auth gate,
    // and snapshots the prior pending_email triple (plus email, verify_token
    // and expires_at for the re-issue branch) for the SMTP-fail restore
    // path. Reading before the duplicate-email SELECTs below is required so
    // the fresh-auth gate can fire before the dupe check on the JWT path
    // (item (3) in the handler-order block above).
    const { rows: existing } = await pool.query<{
      id: number;
      email: string;
      verify_token: string | null;
      expires_at: Date | null;
      password_hash: string | null;
      orcid: string | null;
      pending_email: string | null;
      pending_email_token: string | null;
      pending_email_expires_at: Date | null;
    }>(
      `SELECT id, email, verify_token, expires_at, password_hash, orcid,
              pending_email, pending_email_token, pending_email_expires_at
         FROM accounts WHERE username = $1`,
      [username],
    );

    if (existing.length === 0) {
      // Add-flow JWT-rejection guard. A JWT does reach this branch:
      // `POST /api/auth/session` mints one for any Keychain-signed caller
      // whether or not a row exists, and deleting the row leaves earlier
      // JWTs live. A row-less caller has no registered factor a fresh-auth
      // proof could match, so this guard is what keeps the no-row INSERT on
      // the Hive-signature path, where the per-request signature is the
      // fresh proof.
      if (isJwtPath) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
      }
    } else if (isJwtPath) {
      // Existing-row JWT-path fresh-auth gate (change and re-issue alike) —
      // MUST run before the duplicate-email SELECT below (see handler-order
      // item (3)).
      const proof = (req.body as { fresh_auth_proof?: unknown })?.fresh_auth_proof;
      const proofToken = typeof proof === 'string' ? proof : undefined;
      const expectedTargetHash = computeFreshAuthTargetHash(
        changeEmailFreshAuthTarget(username),
      );
      const result = await consumeFreshAuthToken(proofToken, username, expectedTargetHash);
      if (!result.valid) {
        logger.warn(
          {
            event: 'settings.email_post.fresh_auth_rejected',
            route: 'settings.email-post',
            username,
            reason: result.reason,
          },
          'settings.email change-email rejected — fresh-auth proof invalid',
        );
        // Mirror the sibling mapping in the `custody.broadcast`
        // consent-path `consumeFreshAuthToken` result handler in
        // `custody.ts`: binding violations (token issued for a different
        // user / target / kind) → 403; "no valid proof present" outcomes
        // → 401. The SPA error-router branches on status code (401 →
        // re-login, 403 → wrong-account/wrong-proof), so all three routes
        // that consume the fresh-auth primitive must emit the same signal
        // for the same class of failure.
        const status =
          result.reason === 'username_mismatch' ||
          result.reason === 'target_mismatch' ||
          result.reason === 'kind_mismatch'
            ? 403
            : 401;
        return sendError(
          res,
          status,
          'FRESH_AUTH_REQUIRED',
          'Re-authentication required to change your email. Please complete the fresh-auth challenge and retry.',
          { reason: result.reason },
        );
      }

      // Mechanism must match a factor the account has registered (§ 6.5
      // invariant #2). Closed-default: a mechanism that isn't registered
      // on this account is treated as a wrong-mechanism failure even if
      // the proof itself verified cryptographically — a password proof
      // on a passwordless account is structurally invalid.
      const { password_hash, orcid } = existing[0];
      const mechanism: FreshAuthMechanism = result.mechanism;
      const hasPassword = password_hash !== null;
      const hasOrcid = orcid !== null;
      const mechanismAccepted =
        (mechanism === 'password' && hasPassword) ||
        (mechanism === 'orcid' && hasOrcid);
      if (!mechanismAccepted) {
        logger.warn(
          {
            event: 'settings.email_post.fresh_auth_wrong_mechanism',
            route: 'settings.email-post',
            username,
            mechanism,
            has_password: hasPassword,
            has_orcid: hasOrcid,
          },
          'settings.email change-email rejected — fresh-auth proof mechanism not registered on account',
        );
        // Synthesized reason — see the FreshAuthVerifyFailureReason
        // doc-comment in fresh-auth.ts. The typed const forces a compile
        // error if a future narrowing of the union drops the value.
        const reason: FreshAuthVerifyFailureReason = 'wrong_mechanism';
        return sendError(
          res,
          401,
          'FRESH_AUTH_REQUIRED',
          'Re-authentication required to change your email. Please complete the fresh-auth challenge and retry.',
          { reason },
        );
      }
    }

    // Duplicate-email checks run AFTER the fresh-auth gate above so a
    // JWT-only attacker without a proof cannot enumerate registered emails
    // via the 409-vs-401 status-code differential. `IS DISTINCT FROM` rather
    // than `!=` so a row whose `username` is NULL, such as a pending signup
    // row (states E and F, ARCHITECTURE.md § 6.1), counts as another
    // account. `NULL != $2` is NULL, which would skip that row, and writing
    // its address anyway collides with the `accounts.email` UNIQUE
    // constraint: here as a 500 on Add and re-issue, and at the link's swap
    // on Change.
    const { rows: dupeRows } = await pool.query<{ id: number }>(
      'SELECT id FROM accounts WHERE email = $1 AND username IS DISTINCT FROM $2',
      [email, username],
    );
    if (dupeRows.length > 0) {
      return sendError(res, 409, 'DUPLICATE', 'This email is already associated with another account');
    }

    const { rows: pendingDupeRows } = await pool.query<{ id: number }>(
      'SELECT id FROM accounts WHERE pending_email = $1 AND username IS DISTINCT FROM $2',
      [email, username],
    );
    if (pendingDupeRows.length > 0) {
      return sendError(res, 409, 'DUPLICATE', 'This email is already associated with another account');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + EMAIL_TOKEN_EXPIRY_MS);

    // A row found by username with a non-NULL verify_token is a state G row
    // whose email is still unverified (ARCHITECTURE.md § 6.1: signup rows
    // carry no username, and both signup finalizes clear the token in the
    // same UPDATE that sets the username).
    const reissue = existing.length > 0 && existing[0].verify_token !== null;

    if (existing.length === 0) {
      // Add flow: INSERT new row (Keychain user, no password).
      await pool.query(
        `INSERT INTO accounts (email, username, verify_token, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [email, username, token, expiresAt],
      );
    } else if (reissue) {
      // Unverified state G row: re-issue the add-flow verification for the
      // new address rather than queueing a change behind an email that was
      // never proven. The new token replaces the old one, so the earlier
      // link stops working, and any pending change the row picked up while
      // unverified is dropped with it.
      await pool.query(
        `UPDATE accounts
         SET email = $1,
             verify_token = $2,
             expires_at = $3,
             pending_email = NULL,
             pending_email_token = NULL,
             pending_email_expires_at = NULL
         WHERE username = $4`,
        [email, token, expiresAt, username],
      );
    } else {
      // Change flow: set pending_email fields.
      await pool.query(
        `UPDATE accounts
         SET pending_email = $1,
             pending_email_token = $2,
             pending_email_expires_at = $3
         WHERE username = $4`,
        [email, token, expiresAt, username],
      );
    }

    // Send verification email. SMTP failure follows the catch-warn-200
    // status-code-oracle convention: catch, log warn, fall through to a
    // uniform 200. Emitting 500 only on the known-identity path would be a
    // status-code oracle; the fresh-auth gate above does not change the
    // convention's logic (once DB state is written + secondary effect
    // fails, the user-facing semantic is "we have your change queued; the
    // mail will retry; visit settings to see status" rather than 500).
    try {
      await sendVerificationEmail(email, token);
    } catch (mailErr) {
      logger.warn(
        {
          event: 'settings.email_post.smtp_send_failed',
          route: 'settings.email-post',
          email_hash: hashEmailForLogs(email),
          username,
          err: mailErr,
        },
        'SMTP send failed',
      );
      // Roll back the DB write this request made so the row doesn't carry a
      // token that the user has no verify link for. On Add, DELETE the
      // just-INSERTed row. On re-issue, restore the snapshotted email,
      // verify_token and expires_at together with the pending_email triple,
      // which puts the earlier link back in force. On Change, restore the
      // snapshotted pending_email triple. Each restore applies only if THIS
      // request's UPDATE is still the row's current state, scoped by the
      // just-written token in the column that UPDATE wrote it to. A
      // concurrent email request that already overwrote the row sees the
      // restore no-op here, intended: don't clobber its in-flight state.
      //
      // The rollback query is itself wrapped in an inner try/catch: if the
      // rollback throws (Postgres deadlock, statement timeout, transient
      // pool blip), the error must NOT escape to the outer 500 handler.
      // Letting it escape would convert the uniform-200 SMTP-fail semantic
      // into a 500 for some inputs and not others, re-opening the
      // status-code enumeration oracle that the catch-warn-200 shape closes
      // (an attacker who can induce rollback contention could drive the 500
      // branch differentially). On rollback failure we emit a distinct warn
      // discriminator and fall through to the same uniform 200. The
      // discriminator fires ONLY on the rollback-failure path, preserving
      // the logging-minimal posture on the normal SMTP-fail path.
      try {
        if (existing.length === 0) {
          await pool.query('DELETE FROM accounts WHERE username = $1 AND verify_token = $2', [username, token]);
        } else {
          const prior = existing[0];
          const restoreResult = reissue
            ? await pool.query(
                `UPDATE accounts
                   SET email = $1,
                       verify_token = $2,
                       expires_at = $3,
                       pending_email = $4,
                       pending_email_token = $5,
                       pending_email_expires_at = $6
                   WHERE username = $7 AND verify_token = $8`,
                [
                  prior.email, prior.verify_token, prior.expires_at,
                  prior.pending_email, prior.pending_email_token, prior.pending_email_expires_at,
                  username, token,
                ],
              )
            : await pool.query(
                `UPDATE accounts
                   SET pending_email = $1,
                       pending_email_token = $2,
                       pending_email_expires_at = $3
                   WHERE username = $4 AND pending_email_token = $5`,
                [prior.pending_email, prior.pending_email_token, prior.pending_email_expires_at, username, token],
              );
          // Observability: distinguish "rolled back successfully" from
          // "raced — a concurrent email request already overwrote the row so
          // this restore's token-scoped WHERE no-op'd." Operators responding
          // to an SMTP-outage incident otherwise can't tell the two cases
          // apart from the single smtp_send_failed warn above. Fires only on
          // the race path — normal SMTP-fail emits one warn.
          if (restoreResult.rowCount === 0) {
            logger.warn(
              {
                event: 'settings.email_post.smtp_fail_restore_raced',
                route: 'settings.email-post',
                email_hash: hashEmailForLogs(email),
                username,
              },
              'SMTP-fail restore skipped — a concurrent email request already overwrote the row',
            );
          }
        }
      } catch (rollbackErr) {
        // Rollback itself failed. Swallow it so the SMTP-fail path stays
        // uniform 200 (see the inner-try rationale above); emit a distinct
        // discriminator so an operator can see the row may be left carrying
        // the token this request wrote with no deliverable verify link: on
        // Add, the just-INSERTed row; on re-issue, the replaced email with
        // its re-issued verify_token and expires_at (the pending_email
        // triple already cleared); on Change, the pending_email triple.
        // Mirrors the sibling smtp_send_failed warn's field shape.
        logger.warn(
          {
            event: 'settings.email_post.smtp_fail_rollback_failed',
            route: 'settings.email-post',
            email_hash: hashEmailForLogs(email),
            username,
            err: rollbackErr,
          },
          'SMTP-fail rollback query failed',
        );
      }
      // Fall through to the uniform 200 below — do NOT return 500.
    }

    sendOk(res, { message: 'Verification email sent' });
  } catch (err) {
    logger.error(
      {
        event: 'settings.email_post.failed',
        route: 'settings.email-post',
        email_hash: hashEmailForLogs(email),
        username,
        err,
      },
      'Email add/change failed',
    );
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
    // Add flow first (verify_token match), scoped to rows the add flow could
    // have created. Its INSERT always names the username. The signup INSERTs
    // in `routes/auth.ts` leave the username NULL, and signup rows keep it
    // NULL until a finalize sets it in the same UPDATE that clears the token,
    // while carrying their own tokens in the same column (random hex in state
    // E, `confirmed:` in state F, ARCHITECTURE.md § 6.1). A signup token
    // therefore finds no row here and falls through to the not-found 400
    // below, the same answer an unknown token gets, expired or not: telling
    // the two apart would be a signup-state oracle.
    const { rows: addRows } = await pool.query<{
      id: number;
      expires_at: Date | null;
    }>(
      'SELECT id, expires_at FROM accounts WHERE verify_token = $1 AND username IS NOT NULL',
      [token],
    );

    if (addRows.length > 0) {
      const row = addRows[0];
      if (row.expires_at && new Date() > new Date(row.expires_at)) {
        return sendError(res, 400, 'INVALID_TOKEN', 'Verification link has expired. Please request a new one.');
      }
      // Keyed on the presented token as well as the row: re-adding an email
      // on an unverified row replaces its token, and a link for the earlier
      // address must not verify the later one if that write lands between
      // the lookup and this clear. When it does, the link's token is gone
      // and it gets the not-found answer it would get a moment later.
      const cleared = await pool.query(
        `UPDATE accounts SET verify_token = NULL, expires_at = NULL
          WHERE id = $1 AND verify_token = $2 AND username IS NOT NULL`,
        [row.id, token],
      );
      if (cleared.rowCount === 0) {
        return sendError(res, 400, 'INVALID_TOKEN', 'Invalid or expired verification link');
      }
      return sendOk(res, { verified: true });
    }

    // Change flow (pending_email_token match). Not narrowed like the add
    // flow: a non-NULL `pending_email_token` is written only by this file's
    // `POST /email` handler, on a row found by username, so a signup row
    // never carries one and no signup token can match here.
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

      // Clicking the link proves control of the new address, which is now
      // the row's email, so the email is verified: verify_token and
      // expires_at are cleared with the swap. On a row whose email was
      // already verified the token is already NULL, and expires_at holds at
      // most a leftover signup-link expiry, which no reader consults on a
      // row whose token is NULL. On a row that took this flow before its
      // first email was verified (state G with a hex token, from before
      // unverified rows were routed to the re-issue branch) it marks the
      // row verified.
      await pool.query(
        `UPDATE accounts
         SET email = pending_email,
             pending_email = NULL,
             pending_email_token = NULL,
             pending_email_expires_at = NULL,
             verify_token = NULL,
             expires_at = NULL
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
    logger.error(
      { event: 'settings.email_verify.failed', route: 'settings.email-verify', err },
      'Email verification failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Verification failed');
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/settings/email — Delete email and associated data
// ─────────────────────────────────────────────────────────────
//
// This is the de-facto account-erasure / right-to-erasure path: it runs
// `DELETE FROM accounts WHERE username = $1` plus related deletes and
// anonymizes `custody_audit_log`, taking the row to the no-row case through
// ARCHITECTURE.md § 6.3's deletion exit. Erasing the account mutates/destroys
// an auth factor, so it is a critical action per § 6.6 and the JWT alone is
// never sufficient per § 6.4.
//
// JWT-path fresh-auth gate (mirrors the change-email branch of
// `POST /api/settings/email`): when authenticated via Bearer JWT (the only
// auth path replayable without a fresh signature), the request body MUST
// carry a `fresh_auth_proof` bound to the delete-account target. The proof's
// `action` is `delete_account` (distinct from change-email / set-password),
// so a proof minted for one action cannot be replayed against another — the
// target-hash bind rejects a cross-action proof with `target_mismatch`. The
// mechanism must match a factor the account has registered:
//
//   State A (password, no orcid)  : 'password' only
//   State B (password + orcid)    : 'password' OR 'orcid'
//   State C (orcid, no password)  : 'orcid' only
//   State D (upgraded)            : 'orcid' when linked. The password
//                                   issuer refuses a non-light claim; a
//                                   password proof minted while the row was
//                                   still light stays consumable until it
//                                   expires (the upgrade sweeps session
//                                   proofs only)
//   State G (Keychain + email)    : 'orcid' when linked (the password issuer
//                                   refuses the row's non-light claim)
//
// Keychain (Hive-signature) requests skip the body-proof check entirely — the
// per-request signed canonical message IS the fresh proof and is already
// timestamp + replay-bounded by `verifyHiveSignature`. The discriminator
// below reads `req.hiveAuthMethod` set by the unified middleware.
router.delete('/email', writeLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const parsed = deleteSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Confirmation required');
  }

  const username = req.hiveUsername!;

  // JWT-vs-Keychain discriminator. The Hive-signature path runs after JWT in
  // `verifyHiveSignature` and is fresh per-request; we only require a body
  // proof on the JWT path.
  const isJwtPath = req.hiveAuthMethod === 'jwt';

  try {
    const { rows } = await pool.query<{
      id: number;
      custody: string | null;
      upgraded_at: string | null;
      password_hash: string | null;
      orcid: string | null;
    }>(
      'SELECT id, custody, upgraded_at, password_hash, orcid FROM accounts WHERE username = $1',
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

    // JWT-path fresh-auth gate. Runs AFTER the row-existence check (so a
    // missing-own-row still reads as a stale session) and BEFORE the
    // destructive transaction, so a replayed JWT alone cannot erase the
    // account. The Keychain (signature) path is fresh at the middleware and
    // requires no body proof, consistent with the change-email branch.
    if (isJwtPath) {
      const proof = (req.body as { fresh_auth_proof?: unknown })?.fresh_auth_proof;
      const proofToken = typeof proof === 'string' ? proof : undefined;
      const expectedTargetHash = computeFreshAuthTargetHash(
        deleteAccountFreshAuthTarget(username),
      );
      const result = await consumeFreshAuthToken(proofToken, username, expectedTargetHash);
      if (!result.valid) {
        logger.warn(
          {
            event: 'settings.email_delete.fresh_auth_rejected',
            route: 'settings.email-delete',
            username,
            reason: result.reason,
          },
          'settings.email account-delete rejected — fresh-auth proof invalid',
        );
        // Same status mapping as the change-email / set-password handlers:
        // binding violations (token issued for a different user / target /
        // kind) → 403; "no valid proof present" outcomes → 401. The SPA
        // error-router branches on status code (401 → re-login, 403 →
        // wrong-account/wrong-proof), so every route that consumes the
        // fresh-auth primitive emits the same signal for the same class of
        // failure.
        const status =
          result.reason === 'username_mismatch' ||
          result.reason === 'target_mismatch' ||
          result.reason === 'kind_mismatch'
            ? 403
            : 401;
        return sendError(
          res,
          status,
          'FRESH_AUTH_REQUIRED',
          'Re-authentication required to delete your account data. Please complete the fresh-auth challenge and retry.',
          { reason: result.reason },
        );
      }

      // Mechanism must match a factor the account has registered (§ 6.4).
      // Closed-default: a mechanism that isn't registered on this account is
      // treated as a wrong-mechanism failure even if the proof itself
      // verified cryptographically — a password proof on a passwordless
      // account is structurally invalid.
      const mechanism: FreshAuthMechanism = result.mechanism;
      const hasPassword = row.password_hash !== null;
      const hasOrcid = row.orcid !== null;
      const mechanismAccepted =
        (mechanism === 'password' && hasPassword) ||
        (mechanism === 'orcid' && hasOrcid);
      if (!mechanismAccepted) {
        logger.warn(
          {
            event: 'settings.email_delete.fresh_auth_wrong_mechanism',
            route: 'settings.email-delete',
            username,
            mechanism,
            has_password: hasPassword,
            has_orcid: hasOrcid,
          },
          'settings.email account-delete rejected — fresh-auth proof mechanism not registered on account',
        );
        // Synthesized reason — see the FreshAuthVerifyFailureReason
        // doc-comment in fresh-auth.ts. The typed const forces a compile
        // error if a future narrowing of the union drops the value.
        const reason: FreshAuthVerifyFailureReason = 'wrong_mechanism';
        return sendError(
          res,
          401,
          'FRESH_AUTH_REQUIRED',
          'Re-authentication required to delete your account data. Please complete the fresh-auth challenge and retry.',
          { reason },
        );
      }
    }

    // Log if light account user will lose login access
    if (custodyClaimFor(row) === 'light') {
      logger.warn(
        {
          event: 'settings.email_delete.light_account_login_loss',
          route: 'settings.email-delete',
          username,
        },
        'Light account user deleting email — will lose login access',
      );
    }

    // Single transaction: record the `email_deleted` audit row, anonymize
    // every prior audit row for this username (NULL the PII-derived
    // columns + the username link), then delete the application-side rows.
    //
    // Anonymize-on-delete instead of DELETE preserves the forensic trail
    // across the right-to-erasure path: the forensic columns (operation_type,
    // tx_id, block_num, created_at, auth_mechanism, fresh_auth_outcome)
    // survive so an operator triaging incident traffic can still see that an
    // event happened, while the username link and the PII-derived columns
    // (user_agent, session_id) are erased. The retained tx_id/block_num are
    // references to public Hive transactions the user themselves signed
    // (inherently public on-chain data), so they are out of scope for erasure.
    // Per the column COMMENT on `custody_audit_log.username` (set in migration
    // 009): username is nullable for exactly this purpose; the prior
    // account-delete path wiped the entire row history, giving an attacker who
    // triggered `email_deleted` a one-call audit-log wipe.
    //
    // Order matters: the `email_deleted` INSERT comes BEFORE the anonymize
    // UPDATE so the just-inserted row is itself swept up and anonymized (its
    // username NULLed) by the same WHERE-username-matches UPDATE. The reverse
    // order (UPDATE then INSERT) would leave the `email_deleted` row bound to
    // the live username, defeating the erasure for that very row.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
        [username, 'email_deleted'],
      );

      await client.query(
        'UPDATE custody_audit_log SET username = NULL, user_agent = NULL, session_id = NULL WHERE username = $1',
        [username],
      );
      // Remove any two-phase recovery staging row for this username. A staging
      // row carries a third-party plaintext email (the would-be new address)
      // and an offline-crackable argon2id password hash; under data
      // minimization neither may outlive the deleted account. The whole
      // accounts row is removed below, so the consumed staging row's username
      // link would be orphaned anyway — there is no forensic value in keeping
      // it once the account is gone. Deleting it also closes the stale-bind
      // hijack: a re-signed-up username can no longer have an old staged swap
      // applied to it via phase-2 verify.
      await client.query('DELETE FROM pending_recovery WHERE username = $1', [username]);
      await client.query('DELETE FROM notification_preferences WHERE username = $1', [username]);
      await client.query('DELETE FROM accounts WHERE username = $1', [username]);

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    sendOk(res, { deleted: true });
  } catch (err) {
    logger.error(
      { event: 'settings.email_delete.failed', route: 'settings.email-delete', username, err },
      'Email deletion failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete email data');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/settings/set-password — Opt into password login (null-hash accounts only)
// Auth: verifyHiveSignature (Keychain) or Bearer JWT.
// This is the "set from null" operation; rotating an existing password is a
// separate flow (not yet implemented) that must require the current password.
//
// Re-auth contract (see ARCHITECTURE.md § 6.4): JWT alone is not
// sufficient. The request body MUST
// carry a `fresh_auth_proof` minted via `POST /api/orcid/start { mode:
// 'fresh_auth', action: 'set_password' }` followed by `POST
// /api/orcid/callback`. The proof's `mechanism` MUST be `'orcid'`: the
// handler reaches the proof only for a null-hash account, which has no
// password to base a password-mechanism proof on, so a password-mechanism
// proof on this branch is structurally invalid. Closes the JWT-only
// escalation path described in ARCHITECTURE.md § 6.5 invariant #1 (a stolen
// JWT would otherwise let an attacker set a password they know, then chain
// `/custody/fresh-auth` → `/custody/broadcast` for full account takeover).
// ─────────────────────────────────────────────────────────────
router.post('/set-password', writeLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const username = req.hiveUsername!;
  const { password } = req.body || {};

  if (!isPasswordValid(password)) {
    return sendError(res, 400, 'VALIDATION_ERROR', PASSWORD_POLICY_MESSAGE);
  }

  try {
    const { rows } = await pool.query<{
      id: number;
      password_hash: string | null;
      orcid: string | null;
      verify_token: string | null;
    }>(
      'SELECT id, password_hash, orcid, verify_token FROM accounts WHERE username = $1',
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

    // A row found by username with a non-NULL verify_token is a state G row
    // (ARCHITECTURE.md § 6.1) whose settings-registered email is still
    // unverified: signup rows carry no username, and both signup finalizes
    // clear the token in the same UPDATE that sets the username. This route
    // refuses such a row a password until the email is verified, as the
    // ORCID callback's link and accredit modes refuse it an ORCID
    // (`refuseUnverifiedEmailRow` in `routes/orcid.ts`), so neither route
    // gives a factor to an unverified row that has none. The hourly signup
    // cleanup (`ABANDONED_ACCOUNT_ROWS`) deletes an unverified G row whose
    // link has expired only while it carries no password and no ORCID,
    // releasing the address. Runs before the ORCID requirement and the proof
    // consume, so a row with an ORCID linked is refused here without
    // spending its proof.
    if (rows[0].verify_token !== null) {
      return sendError(
        res,
        409,
        'PENDING_UNVERIFIED',
        'Verify your email before setting a password.',
      );
    }

    // Only ORCID-verified accounts can opt into password login. A NULL hash
    // does not imply an ORCID: per ARCHITECTURE.md § 6.1 it is also the
    // starting shape of a self-custody row that registered an email
    // (state G), which need not carry one. Requiring one keeps the
    // "set-password on null-hash account" invariant narrow: eligibility
    // follows the one factor the fresh-auth gate accepts, so a null-hash row
    // without an ORCID, whether reached today or by a future path that nulls
    // the hash, gets 403 here rather than inheriting eligibility from the
    // missing hash alone.
    if (!rows[0].orcid) {
      return sendError(
        res,
        403,
        'ORCID_REQUIRED',
        'Set-password requires a linked ORCID account',
      );
    }

    // Fresh ORCID re-auth gate (see ARCHITECTURE.md § 6.4 + § 6.5
    // invariant #1). Runs AFTER eligibility checks so the rejection path
    // doesn't widen the oracle surface beyond what an attacker holding a
    // valid JWT can already probe (null-hash and unverified-email detection
    // are already available via `GET /api/settings/email`'s `hasPassword`
    // and `verified` fields for the JWT-holder). The check runs BEFORE the
    // argon2 hash so a missing / bad proof short-circuits before paying
    // argon2 wall-time.
    //
    // Why no sentinel burn: the bad-proof / good-proof timing differential
    // is an accepted residual per
    // `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md`.
    // The attacker must already hold a valid JWT to reach this gate (the
    // route is behind `verifyHiveSignature`), and `hasPassword` (the
    // equivalent null-hash / password-set distinction this timing oracle
    // would leak) is already discoverable to a JWT-holder via
    // `GET /api/settings/email`'s `hasPassword` field. Burning argon2 on
    // the rejection path to equalize would double the rejection-path
    // response time and burn argon2 capacity on invalid traffic for zero
    // additional security since the attacker already knows the answer
    // through a cheaper channel.
    const rawProof = (req.body as { fresh_auth_proof?: unknown })?.fresh_auth_proof;
    const proofToken = typeof rawProof === 'string' ? rawProof : undefined;
    const expectedTargetHash = computeFreshAuthTargetHash(
      setPasswordFreshAuthTarget(username),
    );
    const proofResult = await consumeFreshAuthToken(proofToken, username, expectedTargetHash);
    if (!proofResult.valid) {
      logger.warn(
        {
          event: 'settings.set_password.fresh_auth_rejected',
          route: 'settings.set-password',
          username,
          reason: proofResult.reason,
        },
        'set-password rejected — fresh-auth proof invalid',
      );
      // Mirror the canonical mapping in the `custody.broadcast`
      // consent-path `consumeFreshAuthToken` result handler in `custody.ts`
      // and the sibling change-email handler at `POST /api/settings/email`:
      // binding violations (token issued for a different user / target /
      // kind) → 403; "no valid proof present" outcomes → 401. The SPA
      // error-router branches on status code (401 → re-login, 403 →
      // wrong-account/wrong-proof), so every route that consumes the
      // fresh-auth primitive must emit the same signal for the same class
      // of failure.
      const status =
        proofResult.reason === 'username_mismatch' ||
        proofResult.reason === 'target_mismatch' ||
        proofResult.reason === 'kind_mismatch'
          ? 403
          : 401;
      return sendError(
        res,
        status,
        'FRESH_AUTH_REQUIRED',
        'Re-authentication required. Complete the ORCID fresh-auth challenge and retry.',
        { reason: proofResult.reason },
      );
    }
    // Closed-default per ARCHITECTURE.md § 6.4: a null-hash account has no
    // registered password factor, so a password-mechanism proof here is
    // structurally invalid (would only arise from misuse or a bug
    // elsewhere). Reject 401 — the proof is consumed-but-not-honored.
    if (proofResult.mechanism !== 'orcid') {
      logger.warn(
        {
          event: 'settings.set_password.fresh_auth_wrong_mechanism',
          route: 'settings.set-password',
          username,
          mechanism: proofResult.mechanism,
        },
        'set-password rejected — fresh-auth proof has unexpected mechanism',
      );
      // Synthesized reason — see the FreshAuthVerifyFailureReason
      // doc-comment in fresh-auth.ts. The typed const forces a compile
      // error if a future narrowing of the union drops the value.
      const reason: FreshAuthVerifyFailureReason = 'wrong_mechanism';
      return sendError(
        res,
        401,
        'FRESH_AUTH_REQUIRED',
        'Re-authentication required. Complete the ORCID fresh-auth challenge and retry.',
        { reason },
      );
    }

    const passwordHash = await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS), { signal: abortSignal });
    await pool.query(
      'UPDATE accounts SET password_hash = $1 WHERE id = $2',
      [passwordHash, rows[0].id],
    );

    sendOk(res, { message: 'Password set. You can now log in with your email/username and this password.' });
  } catch (err) {
    if (handleArgonError(res, err) === ARGON_HANDLED) return;
    logger.error(
      { event: 'settings.set_password.failed', route: 'settings.set-password', username, err },
      'Failed to set password',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to set password');
  }
});

export default router;
