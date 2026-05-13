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
import { handleArgonError, ARGON_HANDLED } from '../lib/argon2-error-handler.js';
import { requestAbortSignal } from '../lib/request-abort-signal.js';
import { hashEmailForLogs, safeHashEmailForLogs } from '../lib/log-pii.js';
import { seedAccreditationBonus } from '../reputation.js';
import { getAccreditedSet } from '../accreditation.js';
import {
  handleBroadcastError,
  PostBroadcastWriteError,
  classifyPostBroadcastSeverity,
  type HandleBroadcastErrorOpts,
  type PostBroadcastFailedStep,
} from '../lib/broadcast-error.js';

const router = Router();

const SESSION_EXPIRY = '24h';
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const SIGNUP_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

// Username format: 3-16 chars, lowercase a-z, 0-9, dots/hyphens not at start/end
const USERNAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
const BAD_SEGMENT_RE = /[.-]{2}/;

/**
 * Verify the supplied posting private key derives a public key that matches
 * one of the authorized posting keys on the named Hive account.
 *
 * Used by the stuck-account recovery path (Option C / BACKEND-SIGNUP-VERIFY-
 * STUCK-ACCOUNT-RECOVERY): when a user retries /confirm after a broadcast
 * failure, the original verify_token has been consumed (verify_token = NULL
 * after the pg activation step). The supplied posting_private becomes the
 * auth proof for the resume — anyone who owns the Hive account's posting
 * authority can recover the session.
 *
 * Returns false on any error (malformed key, Hive lookup failure, no match);
 * the caller then routes to the standard "Invalid or expired auth token"
 * 400 to avoid leaking which failure mode occurred.
 */
async function verifyPostingKeyAuthorized(username: string, postingPrivate: string): Promise<boolean> {
  try {
    const supplied = PrivateKey.fromString(postingPrivate);
    const suppliedPubKey = supplied.createPublic().toString();
    const [hiveAcct] = await hiveClient.database.getAccounts([username]);
    if (!hiveAcct) return false;
    const authorizedPostingPubKeys = hiveAcct.posting.key_auths.map(
      ([key]: [string | PublicKey, number]) => key.toString(),
    );
    return authorizedPostingPubKeys.includes(suppliedPubKey);
  } catch (err) {
    logger.warn(
      { err, username },
      'signup_verify stuck-recovery key-ownership check failed',
    );
    return false;
  }
}

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
    logger.error(
      { event: 'signup_verify.verify.failed', route: 'signup-verify.verify', err },
      'Email verification failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Verification failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/resume-signup — Resume an abandoned signup (SF5)
// Authenticates via email + password, resets expiry, returns { flow: 'choose' }
// ─────────────────────────────────────────────────────────────
router.post('/resume-signup', resumeLimiter, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
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
      password_hash: string | null;
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
      await burnSentinel(password, abortSignal);
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid email or password');
    }

    const account = rows[0];

    // Only allow resume if email was already verified but account not yet active.
    // Burn sentinel on the non-confirmed branch too so accounts in any non-
    // resumable lifecycle state (null verify_token, unverified verify_token)
    // cost the same wall-time as the confirmed + wrong-password branch below.
    if (!account.verify_token || !account.verify_token.startsWith('confirmed:')) {
      await burnSentinel(password, abortSignal);
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid email or password');
    }

    // ORCID-only accounts (confirmed via ORCID, no password set) have
    // password_hash = NULL. Calling argon2.verify(null, ...) throws a
    // TypeError, which would diverge wall-time from the wrong-password
    // branch and create a confirmed-state oracle. Burn sentinel to match
    // argon2.verify wall-time, then reject uniformly.
    if (!account.password_hash) {
      await burnSentinel(password, abortSignal);
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid email or password');
    }

    // Verify password.
    //
    // Canonical hoist pattern (see BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT):
    // `accounts.password_hash` is `string | null` in the schema (ORCID-only
    // accounts have no password). After the `if (!account.password_hash)`
    // guard above proves it non-null at this line, TypeScript narrows
    // `account.password_hash` to `string` in the local scope — but the
    // narrowing does NOT carry across the closure boundary inside
    // `runWithArgon2Slot`. Re-reading `account.password_hash` from the
    // closure would force a non-null assertion (`!`) or a re-guard. The
    // closure-local `const passwordHash` pins the narrowed type for the
    // closure body so neither workaround is needed. Mirror this pattern at
    // every other `argon2.verify(account.password_hash, ...)` call site.
    //
    // Preconditions for the hoist to be load-bearing (apply ALL three before
    // adding the pattern at a new site, otherwise it is cargo-culted):
    //   1. The property's static type is nullable (or otherwise needs
    //      narrowing) — e.g., `password_hash: string | null`.
    //   2. A control-flow guard above proves it non-null at runtime — e.g.,
    //      `if (!account.password_hash) return ...;`.
    //   3. The consumer is inside a closure that captures the parent object
    //      by reference (TS de-narrows mutable property accesses at the
    //      closure boundary; the boundary itself is load-bearing here, not
    //      the async-ness — synchronous closures over mutable property
    //      accesses also lose narrowing).
    const passwordHash = account.password_hash;
    const passwordValid = await runWithArgon2Slot(() => argon2.verify(passwordHash, password), { signal: abortSignal });
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
    if (handleArgonError(res, err) === ARGON_HANDLED) return;
    logger.error(
      {
        event: 'signup_verify.resume_signup.failed',
        route: 'signup-verify.resume-signup',
        email_hash: hashEmailForLogs(normalizedEmail),
        err,
      },
      'Resume signup failed',
    );
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
    // Look up account by auth token (must be in confirmed state).
    //
    // `email` is `string | null`: ORCID-only signups (auth.ts /signup with
    // verifiedOrcid + no email) insert with `accounts.email = NULL`. Mistyping
    // it as `string` would compile-pass `hashEmailForLogs(account.email)` in
    // the broadcast catch below, which then throws TypeError on `null.trim()`
    // and converts a recoverable `logger.error + 200 + JWT` flow into a 500.
    type SignupRow = {
      id: number;
      email: string | null;
      password_hash: string | null;
      full_name: string;
      institution: string;
      field: string;
      orcid: string | null;
    };
    const { rows } = await pool.query<SignupRow>(
      `SELECT id, email, password_hash, full_name, institution, field, orcid
       FROM accounts WHERE verify_token = $1`,
      [auth_token],
    );

    // Stuck-account recovery detection (BACKEND-SIGNUP-VERIFY-STUCK-ACCOUNT
    // -RECOVERY, Option C). Chain step 1 (`createClaimedAccount`) is
    // single-use and pg step 2 clears verify_token; a second /confirm with
    // the same auth_token gets 0 rows on the lookup above. To let the user
    // recover their stuck account (chain account created + pg keys stored
    // + accreditation broadcast failed), fall back to a username-keyed
    // lookup for a row that ALREADY completed steps 1-2 with this username.
    //
    // Auth proof for the fallback: the user must supply a posting_private
    // matching one of the authorized posting keys on the Hive account.
    // verify_token has already been consumed and isn't recoverable from
    // pg; the supplied private key is the user's proof-of-ownership for
    // the resume path.
    let account: SignupRow | null = rows[0] ?? null;
    let resumeStuck = false;
    if (!account) {
      const stuckLookup = await pool.query<SignupRow>(
        `SELECT id, email, password_hash, full_name, institution, field, orcid
         FROM accounts
         WHERE username = $1
           AND verify_token IS NULL
           AND custody = 'light'
           AND posting_key_enc IS NOT NULL`,
        [normalizedUsername],
      );
      if (stuckLookup.rows.length > 0) {
        // Verify the supplied posting_private corresponds to an authorized
        // posting key on the Hive account. Without this, anyone who knew a
        // stuck username could request a session by submitting arbitrary
        // keys.
        const ownershipOk = await verifyPostingKeyAuthorized(normalizedUsername, posting_private);
        if (ownershipOk) {
          account = stuckLookup.rows[0];
          resumeStuck = true;
        }
      }
    }

    if (!account) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired auth token');
    }

    // Steps 1 and 2 (create_claimed_account + pg activation) only fire on
    // the first attempt. On a stuck-resume, the chain account exists and
    // pg already carries `username`, `custody = 'light'`, encrypted keys;
    // jump straight to the broadcast block. `createResult` is constructed
    // synthetically for the stuck path; only `block_num` is consumed
    // downstream in the response body.
    let createResult: { block_num: number } = { block_num: 0 };
    if (!resumeStuck) {
      // Check Hive username availability
      const [existingAccount] = await hiveClient.database.getAccounts([normalizedUsername]);
      if (existingAccount) {
        return sendError(res, 409, 'DUPLICATE', 'Username is already taken on Hive');
      }

      // Create the Hive account
      createResult = await createClaimedAccount(
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
    }

    // Broadcast accreditation custom_json + seed reputation in a single
    // discrimination block. Mirrors orcid.ts handleAccredit so a broadcast
    // failure produces 502 BROADCAST_FAILED / 504 BROADCAST_TIMEOUT, and a
    // post-broadcast cascade failure (permanent seed error) produces 502
    // POST_BROADCAST_FAILED with `failed_step:'reputation_seed'`. Without
    // this, prior code returned 200 + JWT for an account whose chain op
    // never landed (the "dangling JWT" class — BACKEND-REPUTATION-SSOT
    // round-1 hold #8).
    //
    // Stuck-resume path (BACKEND-SIGNUP-VERIFY-STUCK-ACCOUNT-RECOVERY,
    // Option C): if we detected the user is in stuck state above, first
    // probe HAF for an existing accreditation custom_json. A prior attempt
    // whose broadcast was ambiguous (timeout / network failure mid-flight)
    // may have actually landed on chain; re-broadcasting would emit a
    // second accreditation event for the same user. Per
    // `chain-write-timeout-ambiguous-outcome-2026-04-22`, probe-before-
    // retry is the canonical handling.
    if (config.pevoAdminPostingKey) {
      // Recovery message: tell the stuck user (or the operator reading
      // the response) that retrying /confirm with the same input is
      // safe and idempotent under Option C. Discriminate at the response
      // level so the SPA can render an appropriate retry CTA.
      const recoveryHint = 'You may retry POST /api/auth/confirm with the same auth_token, username, and keys to recover this session.';
      const broadcastErrOpts: HandleBroadcastErrorOpts = {
        timeoutMsg: `Broadcasting accreditation timed out. ${recoveryHint}`,
        failMsg: `Failed to broadcast accreditation to Hive. ${recoveryHint}`,
        logContext: {
          email_hash: safeHashEmailForLogs(account.email) ?? undefined,
          username: normalizedUsername,
          orcid: account.orcid ?? undefined,
          resume_stuck: resumeStuck,
        },
        routeLabel: 'signup_verify.confirm',
        postBroadcastMsgFn: (failedStep: PostBroadcastFailedStep) =>
          failedStep === 'reputation_seed'
            ? 'Your account is created and accredited on Hive. Your reputation score will update at the next scheduled cycle.'
            : `Your account is created and accredited on Hive (step ${failedStep} pending operator reconciliation).`,
      };

      // HAF probe BEFORE broadcasting on the stuck-resume path. If the
      // user is already accredited on chain (prior ambiguous-outcome
      // broadcast actually landed), skip the broadcast and proceed to
      // the seed step. The seed is idempotent under SET NX so a re-seed
      // is safe.
      let probeFoundAccreditation = false;
      if (resumeStuck) {
        try {
          const accredSet = await getAccreditedSet([normalizedUsername]);
          probeFoundAccreditation = accredSet.has(normalizedUsername);
        } catch (probeErr) {
          // Don't fail the resume on a HAF probe error — fall through to
          // re-broadcast. Worst case: a duplicate accreditation custom_json
          // lands on chain (the SQL reads the most recent and de-dupes).
          logger.warn(
            { err: probeErr, username: normalizedUsername },
            'signup_verify.confirm HAF probe for existing accreditation failed; falling through to broadcast retry',
          );
        }
      }

      let txId: string;
      if (probeFoundAccreditation) {
        // Skip broadcast — already on chain. Use a sentinel tx_id so the
        // PostBroadcastWriteError envelope still carries something
        // greppable if seedAccreditationBonus throws here.
        txId = 'haf-probe-already-accredited';
        logger.info(
          { username: normalizedUsername },
          'signup_verify.confirm stuck-resume: HAF probe found existing accreditation; skipping broadcast',
        );
      } else {
        const evidenceHash = crypto
          .createHash('sha256')
          .update(`${account.email}:${normalizedUsername}:signup`)
          .digest('hex');

        const adminKey = PrivateKey.fromString(config.pevoAdminPostingKey);
        let result: Awaited<ReturnType<typeof broadcastJsonWithTimeout>>;
        try {
          result = await broadcastJsonWithTimeout(
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
        } catch (err) {
          handleBroadcastError(res, err, broadcastErrOpts);
          return;
        }
        txId = result.id;
      }

      // Post-broadcast cascade. Chain op confirmed (or already on chain);
      // any throw here is a downstream failure, not an ambiguous-outcome
      // class. Discriminate via PostBroadcastWriteError so the catch
      // emits 502 POST_BROADCAST_FAILED with `outcome:'confirmed'` +
      // `tx_id` + `failed_step` instead of 504 / 502 BROADCAST_FAILED.
      const currentStep: PostBroadcastFailedStep = 'reputation_seed';
      try {
        await seedAccreditationBonus(normalizedUsername);
      } catch (postErr) {
        // Pass severity explicitly so a permanent-class (TypeError) post-
        // broadcast failure routes through the operator-required code path
        // instead of the default 'transient' user copy claiming automatic
        // reconciliation. seedAccreditationBonus re-throws only permanent-
        // class errors per broadcast-error.ts:47-55 (BACKEND-REPUTATION-SSOT
        // round-2 hold #1; mirror orcid.ts:886).
        handleBroadcastError(
          res,
          new PostBroadcastWriteError(txId, postErr, currentStep, classifyPostBroadcastSeverity(postErr)),
          broadcastErrOpts,
        );
        return;
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
    logger.error(
      { event: 'signup_verify.confirm.failed', route: 'signup-verify.confirm', err },
      'Account confirmation failed',
    );
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
    // Look up account by auth token (must be in confirmed state).
    // `email` is `string | null` for the same ORCID-only-signup reason
    // documented at the sibling /confirm pg query above.
    type LinkRow = {
      id: number;
      email: string | null;
      password_hash: string | null;
      full_name: string;
      institution: string;
      field: string;
      orcid: string | null;
    };
    const { rows } = await pool.query<LinkRow>(
      `SELECT id, email, password_hash, full_name, institution, field, orcid
       FROM accounts WHERE verify_token = $1`,
      [auth_token],
    );

    // Stuck-account recovery detection (BACKEND-SIGNUP-VERIFY-STUCK-ACCOUNT
    // -RECOVERY, Option C). Symmetric to /confirm: if a prior /link attempt
    // consumed the verify_token (pg activation step) but the accreditation
    // broadcast failed, the user is locked out by the verify_token lookup
    // failing. Recover by username-keyed fallback. Auth proof comes from
    // the verifyHiveSignature middleware above (the user proved they own
    // the Hive account by signing the request), so no additional key-
    // ownership check is needed here.
    let account: LinkRow | null = rows[0] ?? null;
    let resumeStuck = false;
    if (!account) {
      const stuckLookup = await pool.query<LinkRow>(
        `SELECT id, email, password_hash, full_name, institution, field, orcid
         FROM accounts
         WHERE username = $1
           AND verify_token IS NULL
           AND custody = 'self'`,
        [hiveUsername],
      );
      if (stuckLookup.rows.length > 0) {
        account = stuckLookup.rows[0];
        resumeStuck = true;
      }
    }

    if (!account) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired link request');
    }

    if (!resumeStuck) {
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
    }

    // Broadcast accreditation custom_json + seed reputation in a single
    // discrimination block. See /confirm above for full rationale
    // (BACKEND-REPUTATION-SSOT round-1 hold #8). Mirrors the orcid.ts
    // handleLink pattern: broadcast failure → 502/504; post-broadcast
    // permanent seed failure → 502 POST_BROADCAST_FAILED.
    //
    // Stuck-resume path (BACKEND-SIGNUP-VERIFY-STUCK-ACCOUNT-RECOVERY,
    // Option C): if we detected the user is in stuck state above, first
    // probe HAF for an existing accreditation custom_json. See /confirm
    // above for the full rationale of HAF probe-before-retry.
    if (config.pevoAdminPostingKey) {
      const recoveryHint = 'You may retry POST /api/auth/link with the same auth_token and signed request to recover this session.';
      const broadcastErrOpts: HandleBroadcastErrorOpts = {
        timeoutMsg: `Broadcasting accreditation timed out. ${recoveryHint}`,
        failMsg: `Failed to broadcast accreditation to Hive. ${recoveryHint}`,
        logContext: {
          email_hash: safeHashEmailForLogs(account.email) ?? undefined,
          username: hiveUsername,
          orcid: account.orcid ?? undefined,
          resume_stuck: resumeStuck,
        },
        routeLabel: 'signup_verify.link',
        postBroadcastMsgFn: (failedStep: PostBroadcastFailedStep) =>
          failedStep === 'reputation_seed'
            ? 'Your Hive account is linked and accredited on Hive. Your reputation score will update at the next scheduled cycle.'
            : `Your Hive account is linked and accredited on Hive (step ${failedStep} pending operator reconciliation).`,
      };

      let probeFoundAccreditation = false;
      if (resumeStuck) {
        try {
          const accredSet = await getAccreditedSet([hiveUsername]);
          probeFoundAccreditation = accredSet.has(hiveUsername);
        } catch (probeErr) {
          logger.warn(
            { err: probeErr, username: hiveUsername },
            'signup_verify.link HAF probe for existing accreditation failed; falling through to broadcast retry',
          );
        }
      }

      let txId: string;
      if (probeFoundAccreditation) {
        txId = 'haf-probe-already-accredited';
        logger.info(
          { username: hiveUsername },
          'signup_verify.link stuck-resume: HAF probe found existing accreditation; skipping broadcast',
        );
      } else {
        const evidenceHash = crypto
          .createHash('sha256')
          .update(`${account.email}:${hiveUsername}:link`)
          .digest('hex');

        const adminKey = PrivateKey.fromString(config.pevoAdminPostingKey);
        let result: Awaited<ReturnType<typeof broadcastJsonWithTimeout>>;
        try {
          result = await broadcastJsonWithTimeout(
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
        } catch (err) {
          handleBroadcastError(res, err, broadcastErrOpts);
          return;
        }
        txId = result.id;
      }

      const currentStep: PostBroadcastFailedStep = 'reputation_seed';
      try {
        await seedAccreditationBonus(hiveUsername);
      } catch (postErr) {
        // See /confirm above for severity rationale (round-2 hold #1).
        handleBroadcastError(
          res,
          new PostBroadcastWriteError(txId, postErr, currentStep, classifyPostBroadcastSeverity(postErr)),
          broadcastErrOpts,
        );
        return;
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
    logger.error(
      { event: 'signup_verify.link.failed', route: 'signup-verify.link', err },
      'Account linking failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Account linking failed');
  }
});

export default router;
