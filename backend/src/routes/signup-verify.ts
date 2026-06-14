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
import { hiveClient, broadcastAdminCustomJson } from '../hive.js';
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
import {
  mintBinding,
  setBindingCookie,
  clearBindingCookie,
  extractBindingCookie,
  verifyBinding,
} from '../signup-session-binding.js';
import { withSignupActivationLock } from '../lib/signup-activation-lock.js';

const router = Router();

/**
 * Test-only injection: arm a one-shot failure of the post-`createClaimedAccount`
 * finalize UPDATE on `/confirm`, keyed by auth_token. Lets a test drive the
 * ACTUAL crash transition end-to-end — `createClaimedAccount` succeeds, the
 * chain account materializes, then the finalize UPDATE throws — instead of
 * pre-seeding the post-crash row state. The throw propagates out of the
 * activation-lock body to its catch, producing the same 500 a real
 * mid-finalize pg failure would, and leaving `verify_token` still set so a
 * retry hits the `resumeChainExists` branch.
 *
 * Gated behind the Vitest / `NODE_ENV === 'test'` runtime check (mirrors the
 * guard in `drainArgon2Queue`): outside a test process `maybeThrowInjected-
 * FinalizeFailure` returns immediately and never consults the armed set, so
 * production behaviour is untouched. The `eslint.config.mjs`
 * `no-restricted-imports` rule additionally forbids importing `__test_seams`
 * from `src/`, so no production module can arm the injection in the first place.
 */
const injectedFinalizeFailures = new Set<string>();

/**
 * Consumed at the `/confirm` finalize UPDATE site. If a one-shot failure is
 * armed for `authToken`, clear it and throw so the NEXT finalize UPDATE for the
 * same token (the retry) is NOT failed — the retry must reach the
 * `resumeChainExists` resume and finalize the row. No-op when nothing is armed
 * or when not running under a test process.
 */
function maybeThrowInjectedFinalizeFailure(authToken: string): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') return;
  if (injectedFinalizeFailures.delete(authToken)) {
    throw new Error('injected finalize UPDATE failure (test seam)');
  }
}

/**
 * The accreditation-broadcast cascade shared by /confirm and /link. Holds the
 * post-lock HAF-probe -> accredit `custom_json` broadcast -> reputation-seed
 * sequence in one place so a future change to the probe-before-retry logic,
 * the `PostBroadcastWriteError` severity classification, or the seed step lands
 * at one site instead of two. Mirrors `orcid.ts` handleAccredit / handleLink.
 *
 * The single `routeFlavor` discriminator carries every confirm-vs-link
 * difference. The evidence-hash domain suffix, the log/error `routeLabel`, and
 * the recovery-hint copy are pure functions of `routeFlavor`, so they are
 * derived from it inside `broadcastAccreditationAndSeed` (via
 * `ROUTE_FLAVOR_DERIVATION`) rather than passed alongside it — a mismatched
 * (routeFlavor, suffix/label/hint) pair is therefore unrepresentable. The caller
 * supplies only the genuinely per-call fields: the on-chain account name, the
 * row whose profile fields populate the `accredit` op, and the `isResume` /
 * `resumeStuck` gates that decide whether to HAF-probe before broadcasting.
 */
interface BroadcastAccreditationOpts {
  res: Response;
  /** 'confirm' = new light account (SF4); 'link' = existing Hive account (SF6). */
  routeFlavor: 'confirm' | 'link';
  /** On-chain account that gets accredited (and seeded). */
  username: string;
  /** Pending row supplying the accredit op's profile fields. */
  account: {
    email: string | null;
    full_name: string;
    institution: string;
    field: string;
    orcid: string | null;
  };
  /**
   * True on a resume path (stuck-recovery, or the /confirm chain-exists
   * crash-resume). Gates the HAF probe-before-rebroadcast: a prior attempt's
   * ambiguous broadcast may have landed, so re-broadcasting would emit a
   * duplicate accreditation event. See
   * `chain-write-timeout-ambiguous-outcome` for the probe-before-retry rule.
   */
  isResume: boolean;
  /** Stuck-recovery discriminator surfaced on the structured log context. */
  resumeStuck: boolean;
}

/**
 * Per-`routeFlavor` derivations for `broadcastAccreditationAndSeed`: the three
 * values that are pure functions of the discriminator. Keying them off
 * `routeFlavor` (rather than accepting them as separate opts) is what makes a
 * mismatched pair — e.g. a `confirm` flavor with the `link` evidence suffix,
 * which would silently produce a wrong on-chain `evidence_hash` — unrepresentable.
 * Mirrors `postBroadcastSuccessCopy`'s derive-from-`routeFlavor` precedent.
 *   - `evidenceSuffix` domain-separates the SHA-256 evidence hash.
 *   - `routeLabel` prefixes the structured log/error context.
 *   - `recoveryHint` is the user-facing retry instruction appended to broadcast errors.
 */
export const ROUTE_FLAVOR_DERIVATION: Record<
  'confirm' | 'link',
  { evidenceSuffix: string; routeLabel: string; recoveryHint: string }
> = {
  confirm: {
    evidenceSuffix: 'signup',
    routeLabel: 'signup_verify.confirm',
    recoveryHint:
      'You may retry POST /api/auth/confirm with the same auth_token, username, and keys to recover this session.',
  },
  link: {
    evidenceSuffix: 'link',
    routeLabel: 'signup_verify.link',
    recoveryHint:
      'You may retry POST /api/auth/link with the same auth_token and signed request to recover this session.',
  },
};

/**
 * Run the accreditation broadcast + reputation seed for a finalized signup row.
 *
 * Returns `'handled'` when it has already written a 502/504 error envelope (the
 * broadcast threw, or the post-broadcast seed cascade threw): the caller MUST
 * `return` without writing any further response. Returns `'ok'` when the
 * accreditation op is on chain (freshly broadcast or found by the HAF probe)
 * and the seed succeeded; the caller proceeds to issue the session JWT.
 *
 * Skips the broadcast entirely when `config.pevoAdminPostingKey` is unset
 * (returns `'ok'`) so a deployment without an admin posting key still finalizes
 * the account, matching the prior inline behavior.
 */
async function broadcastAccreditationAndSeed(
  opts: BroadcastAccreditationOpts,
): Promise<'ok' | 'handled'> {
  const { res, routeFlavor, username, account, isResume, resumeStuck } = opts;
  const { evidenceSuffix, routeLabel, recoveryHint } = ROUTE_FLAVOR_DERIVATION[routeFlavor];

  // No admin posting key configured: accreditation broadcast is skipped
  // silently (matches the prior `if (config.pevoAdminPostingKey)` guard) and
  // the caller still finalizes the session.
  if (!config.pevoAdminPostingKey) {
    return 'ok';
  }

  const broadcastErrOpts: HandleBroadcastErrorOpts = {
    timeoutMsg: `Broadcasting accreditation timed out. ${recoveryHint}`,
    failMsg: `Failed to broadcast accreditation to Hive. ${recoveryHint}`,
    logContext: {
      email_hash: safeHashEmailForLogs(account.email),
      username,
      orcid: account.orcid ?? undefined,
      resume_stuck: resumeStuck,
    },
    routeLabel,
    postBroadcastMsgFn: (failedStep: PostBroadcastFailedStep) =>
      postBroadcastSuccessCopy(routeFlavor, failedStep),
  };

  // HAF probe BEFORE broadcasting on a resume path. If the user is already
  // accredited on chain (a prior attempt's broadcast landed), skip the
  // broadcast and proceed to the (idempotent SET NX) seed. A probe error does
  // NOT fail the resume — fall through to re-broadcast; the read-time dedup and
  // seed SET NX backstop a duplicate custom_json.
  let probeFoundAccreditation = false;
  if (isResume) {
    try {
      const accredSet = await getAccreditedSet([username]);
      probeFoundAccreditation = accredSet.has(username);
    } catch (probeErr) {
      logger.warn(
        { err: probeErr, username },
        `${routeLabel} HAF probe for existing accreditation failed; falling through to broadcast retry`,
      );
    }
  }

  let txId: string;
  if (probeFoundAccreditation) {
    // Skip broadcast — already on chain. Sentinel tx_id so a
    // PostBroadcastWriteError envelope still carries a greppable reference if
    // the seed throws below.
    txId = 'haf-probe-already-accredited';
    logger.info(
      { username },
      `${routeLabel} stuck-resume: HAF probe found existing accreditation; skipping broadcast`,
    );
  } else {
    const evidenceHash = crypto
      .createHash('sha256')
      .update(`${account.email}:${username}:${evidenceSuffix}`)
      .digest('hex');

    let result: Awaited<ReturnType<typeof broadcastAdminCustomJson>>;
    try {
      result = await broadcastAdminCustomJson({
        action: 'accredit',
        account: username,
        name: account.full_name || username,
        institution: account.institution || '',
        field: account.field || '',
        orcid: account.orcid || '',
        method: 'email',
        evidence_hash: evidenceHash,
        // Issued by the admin account (the accreditor); see AccreditAction.
        issued_by: config.hiveAdminAccount,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleBroadcastError(res, err, broadcastErrOpts);
      return 'handled';
    }
    txId = result.id;
  }

  // Post-broadcast cascade. Chain op confirmed (or already on chain); any throw
  // here is a downstream failure, not an ambiguous-outcome class. Discriminate
  // via PostBroadcastWriteError so the catch emits 502 POST_BROADCAST_FAILED
  // (outcome:'confirmed' + tx_id + failed_step) instead of 504 / 502
  // BROADCAST_FAILED. Pass severity explicitly so a permanent-class
  // (TypeError) failure routes through the operator-required path rather than
  // the default 'transient' "automatic reconciliation" copy. seedAccreditation-
  // Bonus re-throws only permanent-class errors. Mirrors orcid.ts handleAccredit.
  const currentStep: PostBroadcastFailedStep = 'reputation_seed';
  try {
    await seedAccreditationBonus(username);
  } catch (postErr) {
    handleBroadcastError(
      res,
      new PostBroadcastWriteError(txId, postErr, currentStep, classifyPostBroadcastSeverity(postErr)),
      broadcastErrOpts,
    );
    return 'handled';
  }

  return 'ok';
}

/**
 * Per-step user-facing copy for the 502 POST_BROADCAST_FAILED envelope, keyed
 * by route flavor. 'confirm' speaks of a created light account; 'link' speaks
 * of a linked existing Hive account. Only the `reputation_seed` step is
 * reachable from `broadcastAccreditationAndSeed` today; the catch-all branch
 * keeps the copy honest if a future step is threaded through.
 */
function postBroadcastSuccessCopy(routeFlavor: 'confirm' | 'link', failedStep: PostBroadcastFailedStep): string {
  const subject = routeFlavor === 'confirm'
    ? 'Your account is created and accredited on Hive'
    : 'Your Hive account is linked and accredited on Hive';
  return failedStep === 'reputation_seed'
    ? `${subject}. Your reputation score will update at the next scheduled cycle.`
    : `${subject} (step ${failedStep} pending operator reconciliation).`;
}

const SESSION_EXPIRY = '24h';
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const SIGNUP_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

// Recovery window for stuck-account resume. The /confirm + /link stuck-recovery
// lookup is bounded to rows whose finalize UPDATE landed within this window so a
// long-since-finalized steady-state row cannot be replayed through recovery (an
// attacker holding the victim's posting key / a fresh signature could otherwise
// re-mint a session against a completed account). A crashed activation's row is
// recoverable for this long; after it, the user re-enters via the password-gated
// login flow. The finalize UPDATE bumps `accounts.updated_at = NOW()`, so the
// window measures time since the last activation, not since signup.
const STUCK_RECOVERY_WINDOW = '1 hour';

// Username format: 3-16 chars, lowercase a-z, 0-9, dots/hyphens not at start/end
const USERNAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
const BAD_SEGMENT_RE = /[.-]{2}/;

/**
 * Verify the supplied posting private key derives a public key that matches
 * one of the authorized posting keys on the named Hive account.
 *
 * Used by the stuck-account recovery path (Option C): when a user retries
 * /confirm after a broadcast failure, the original verify_token has been
 * consumed (verify_token = NULL
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

/**
 * Per-auth_token rate-limit for /confirm and /link.
 *
 * The IP limiters above (`confirmLimiter`, `linkLimiter`) bound brute-force
 * attempts from a single IP, but an attacker rotating IPs (residential
 * proxies, botnet) can bypass them and burn through the 32-byte auth_token
 * space against any single pending row. Layering a per-token limiter on top
 * means every attempt against a specific auth_token value counts against a
 * shared budget regardless of source IP — so the brute-forcer pays a
 * rate-cost on the dimension they were trying to amplify across.
 *
 * Key derivation: the raw `auth_token` body field is attacker-controlled and
 * bounded only by the 1MB body-parser limit, so keying directly on it (`tok:`
 * + raw token) lets an attacker rotating arbitrarily long distinct tokens
 * inflate the rate-limiter key set (Redis keys, or in-memory map keys on the
 * Redis-down fallback). Hash the token to a fixed-length SHA-256 hex digest so
 * the key length is constant (`tok:` + 64 hex chars) regardless of submitted
 * token length. A real `confirmed:` token is fixed-length anyway
 * (`confirmed:` + 64 hex chars from `crypto.randomBytes(32)`), so hashing does
 * not lose any legitimate distinction: the same token always maps to the same
 * bucket (per-token accumulation preserved — 5/token/hour still accumulates),
 * and distinct tokens map to distinct buckets.
 *
 * The key falls back to the IP when no auth_token is present in the body
 * (malformed request); that case is already covered by the upstream IP
 * limiter, so the fallback is essentially a no-op + double-spend on the IP
 * bucket, which is acceptable for the malformed-body path.
 *
 * The window is the same 1h as the IP limiters; max is intentionally
 * tighter (5 vs. 10) because the per-token surface is a much narrower
 * brute-force vector than per-IP and a legitimate user needs at most one
 * /confirm or one /link per auth_token.
 */
function byAuthToken(req: Request): string {
  const token = req.body?.auth_token;
  if (typeof token === 'string' && token.length > 0) {
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    return `tok:${digest}`;
  }
  return `ip:${byIp(req)}`;
}

// `refundStatusCodes: [409]` refunds the per-token slot on a 409. The motivating
// case is 409 LOCK_HELD: the slot was consumed by the concurrent activation
// holder, not the waiter, so charging the waiter for the holder's slowness would
// push an auto-retry loop into a 429 cliff with a 1h cooldown. The route's other
// 409 (DUPLICATE — the username/Hive account is already taken) is also refunded
// since it shares the code, which is benign: Hive account existence is public
// on-chain data, the limiter is keyed per auth_token (not per probed username),
// and the legitimate user simply retries with a different name. The brute-force
// vector this limiter exists to bound — 400 invalid-token spraying against one
// auth_token value — still consumes a slot on every attempt.
const confirmTokenLimiter = rateLimit({
  name: 'signup-confirm-token',
  windowMs: 3_600_000,
  max: 5,
  keyFn: byAuthToken,
  refundStatusCodes: [409],
});
const linkTokenLimiter = rateLimit({
  name: 'signup-link-token',
  windowMs: 3_600_000,
  max: 5,
  keyFn: byAuthToken,
  refundStatusCodes: [409],
});

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

    // Mark as confirmed with a random token. Mint a fresh browser-session
    // binding for this row: any prior binding (e.g., from /signup on a
    // different browser) is overwritten so that whichever browser clicked
    // the verification email link is the one bound for the upcoming
    // /confirm or /link ceremony. See `signup-session-binding.ts` for the
    // threat model.
    const confirmed = `confirmed:${crypto.randomBytes(32).toString('hex')}`;
    const binding = mintBinding();
    await pool.query(
      'UPDATE accounts SET verify_token = $1, signup_binding_hash = $2 WHERE id = $3',
      [confirmed, binding.hash, account.id],
    );

    setBindingCookie(res, binding.cookieValue);
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
      // Mirrors the timing-equalization pattern applied across auth.ts.
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
    // Canonical hoist pattern for `argon2.verify(account.password_hash, …)`
    // inside `runWithArgon2Slot`:
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

    // Reset expiry and rebind the signup session to this browser. The
    // resume path is the only way back into a confirmed-but-incomplete
    // signup that requires password proof; the prior binding (from a
    // /signup-time browser that has since been closed or switched off) is
    // overwritten so the browser completing resume is the one bound for
    // the upcoming /confirm or /link ceremony.
    const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_EXPIRY_MS);
    const binding = mintBinding();
    await pool.query(
      'UPDATE accounts SET expires_at = $1, signup_binding_hash = $2 WHERE id = $3',
      [expiresAt, binding.hash, account.id],
    );

    setBindingCookie(res, binding.cookieValue);
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
//
// Best-effort JWT contract (mirrors /link). The activation lock is released at
// the single-fire-critical-section boundary (after the verify_token-clearing
// finalize) and BEFORE the slow accreditation broadcast, so a fast same-token
// retry arriving during the ~30s accreditation window can acquire the lock, find
// the row already finalized, take the resume path, and mint a SECOND JWT. That
// second JWT is intentional, not a defect: it is minted for the SAME owner who
// already proved ownership on this path (posting-key proof), so it grants nothing
// new. The properties that DO matter are strictly held — no second
// createClaimedAccount (the chain-exists check catches it) and no second finite
// claim-token burn — with the duplicate accreditation bounded by the HAF probe +
// seedAccreditation SET-NX backstop. Forcing strict single-JWT would require
// holding the lock across the ~30s accreditation broadcast, re-introducing the
// pool-saturation this redesign exists to eliminate, so it is deliberately not done.
// ─────────────────────────────────────────────────────────────
router.post('/confirm', confirmLimiter, confirmTokenLimiter, async (req: Request, res: Response) => {
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
    signup_binding_hash: Buffer | null;
  };

  // Acquire the per-auth_token activation lock BEFORE any pg work. It is the
  // single-fire guard for the createClaimedAccount broadcast and — unlike the
  // pg advisory lock it replaces — survives the pg connection being released
  // across that ~30s broadcast, so a slow activation never pins a pool
  // connection. See `signup-activation-lock.ts` for the single-fire argument.
  // The wrapper owns the acquire/409-LOCK_HELD/finally-release ceremony; the
  // body calls `releaseLock()` at the single-fire-critical-section boundary.
  await withSignupActivationLock(
    {
      res,
      authToken: auth_token,
      onError: (err) => {
        logger.error(
          { event: 'signup_verify.confirm.failed', route: 'signup-verify.confirm', err },
          'Account confirmation failed',
        );
        sendError(res, 500, 'INTERNAL_ERROR', 'Account creation failed');
      },
    },
    async (releaseLock) => {
    let account: SignupRow | null = null;
    // verify_token already NULL — a prior attempt completed the finalize UPDATE
    // (keys stored) but its accreditation broadcast failed. Keys already stored.
    let resumeStuck = false;
    // verify_token still set but the Hive account already exists — a prior
    // attempt's createClaimedAccount landed, then the process died before the
    // finalize UPDATE (the Facet-1 crash gap this redesign closes). The retry
    // stores keys + clears verify_token WITHOUT re-broadcasting.
    let resumeChainExists = false;
    // null until the fresh path actually broadcasts createClaimedAccount. Both
    // resume paths (resumeChainExists crash-resume + verify_token-NULL stuck-
    // resume) skip the broadcast, so block_num stays null and is omitted from
    // the 200 response — a resume never created a new block, and returning
    // `block_num: 0` would be a "created in block 0" lie.
    let createResult: { block_num: number } | null = null;

    // 1. Look up the pending row by auth token. Plain pooled query — no held
    //    transaction. The activation lock (not a pg lock) gives single-fire, so
    //    each pg round-trip checks a connection out and returns it immediately.
    const { rows } = await pool.query<SignupRow>(
      `SELECT id, email, password_hash, full_name, institution, field, orcid, signup_binding_hash
       FROM accounts WHERE verify_token = $1`,
      [auth_token],
    );
    account = rows[0] ?? null;

    if (account) {
      // Session-binding check. The cookie is the authorization proof that the
      // finalizing browser is the one that initiated signup. Required for BOTH
      // the fresh path and the chain-exists crash-resume: both bind a username
      // to this identity row for the first time, so a leaked auth_token must not
      // finalize either without the cookie. (Legit crash-recovery keeps the
      // cookie — the finalize that would clear signup_binding_hash never
      // committed.) The reject shape MUST equal the no-row "invalid or expired"
      // 400 below so a leaked auth_token cannot be confirmed-as-valid via a
      // distinguishable response. Only the verify_token-NULL stuck-resume below
      // bypasses binding, gated on a posting-key ownership proof instead. See
      // `signup-session-binding.ts` for the threat model.
      const cookieValue = extractBindingCookie(req);
      const bindingOk = cookieValue !== null
        && verifyBinding(cookieValue, account.signup_binding_hash);
      if (!bindingOk) {
        logger.warn(
          {
            event: 'signup_verify.confirm.binding_rejected',
            route: 'signup-verify.confirm',
            cookie_present: cookieValue !== null,
            row_has_hash: account.signup_binding_hash !== null,
          },
          'signup_verify.confirm rejected: session-binding cookie missing or mismatched',
        );
        return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired auth token');
      }

      // Fresh vs. chain-exists crash-resume: does the Hive account already
      // exist? This getAccounts also serves as the fresh-path username-
      // availability check.
      const [existingAccount] = await hiveClient.database.getAccounts([normalizedUsername]);
      if (existingAccount) {
        // Username exists on Hive. Either a prior attempt of THIS signup created
        // it then crashed before finalize, or it belongs to someone else. The
        // posting-key ownership proof distinguishes them: only the owner of the
        // on-chain posting authority can resume; everyone else gets 409.
        const ownershipOk = await verifyPostingKeyAuthorized(normalizedUsername, posting_private);
        if (!ownershipOk) {
          return sendError(res, 409, 'DUPLICATE', 'Username is already taken on Hive');
        }
        resumeChainExists = true;
      }
    } else {
      // Token not found — verify_token already cleared. Stuck-account recovery
      // (Option C): a prior attempt finished the finalize UPDATE (username +
      // keys + custody='light', verify_token NULL) but its accreditation
      // broadcast failed. Recover via a username-keyed lookup, gated on a
      // posting-key ownership proof: the supplied posting_private must match an
      // authorized posting key on the Hive account. Binding is bypassed here
      // because the row was already bound by that prior finalize and the
      // ownership proof is the stronger per-request credential.
      const stuckLookup = await pool.query<SignupRow>(
        `SELECT id, email, password_hash, full_name, institution, field, orcid, signup_binding_hash
         FROM accounts
         WHERE username = $1
           AND verify_token IS NULL
           AND custody = 'light'
           AND posting_key_enc IS NOT NULL
           AND updated_at > NOW() - INTERVAL '${STUCK_RECOVERY_WINDOW}'`,
        [normalizedUsername],
      );
      if (stuckLookup.rows.length > 0) {
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

    // 2. Finalize. The fresh path and the chain-exists resume store keys and
    //    clear verify_token; the verify_token-NULL stuck-resume already did this
    //    in its prior attempt and only needs the accreditation step below.
    if (!resumeStuck) {
      // Encrypt BEFORE the irreversible broadcast so a misconfigured
      // CUSTODY_ENCRYPTION_KEY throws (→ 500) before any claim token is burned.
      const postingEnc = encryptKey(normalizedUsername, posting_private);
      const memoEnc = encryptKey(normalizedUsername, memo_private);

      if (!resumeChainExists) {
        // Create the Hive account. Runs with NO pg connection held — the
        // activation lock is the single-fire guard across the ~30s broadcast.
        // Do NOT move it back under a pg transaction: that reintroduces the
        // pool-saturation vector this redesign removed.
        createResult = await createClaimedAccount(
          normalizedUsername,
          owner_public,
          active_public,
          posting_public,
          memo_public,
        );
      }

      // Test-only injection point: simulate a failure of the finalize UPDATE
      // AFTER createClaimedAccount has landed (on the fresh path) but BEFORE the
      // row is durably activated. No-op outside NODE_ENV=test. Placed before the
      // UPDATE so the row is left exactly as a real mid-finalize crash would:
      // verify_token still set, posting_key_enc NULL, chain account materialized.
      maybeThrowInjectedFinalizeFailure(auth_token);

      // Activate: set username, keys, custody, clear verify_token AND the
      // signup_binding_hash (it has served its purpose; carrying it forward
      // would let a signup-ceremony cookie re-use the row). Single atomic
      // UPDATE on a short-lived pooled connection; the activation lock prevents
      // a concurrent same-token writer.
      await pool.query(
        `UPDATE accounts
         SET username = $1, custody = 'light', verify_token = NULL,
             posting_key_enc = $2, iv_posting = $3,
             memo_key_enc = $4, iv_memo = $5,
             signup_binding_hash = NULL, updated_at = NOW()
         WHERE id = $6`,
        [
          normalizedUsername,
          postingEnc.ciphertext, postingEnc.iv,
          memoEnc.ciphertext, memoEnc.iv,
          account.id,
        ],
      );
    }

    // `account` is non-null here (every reject above returns). Pin a non-null
    // const for the broadcast block (a closure / object-literal read of the
    // mutable `let` de-narrows).
    const confirmedAccount = account;
    // Both resume flavors skip createClaimedAccount and HAF-probe before
    // re-broadcasting accreditation; only the fresh path broadcasts unconditionally.
    const isResume = resumeStuck || resumeChainExists;

    // Release the activation lock NOW — the single-fire-critical section
    // (createClaimedAccount + the verify_token-clearing finalize) is complete.
    // The accreditation broadcast/seed below have their own dedup (HAF probe +
    // seed SET NX), so holding the lock across that slow step would only make a
    // concurrent same-token waiter block longer for no single-fire benefit. The
    // wrapper's `finally` re-release is a CAS/nonce-safe no-op on this happy path.
    await releaseLock();

    // Broadcast accreditation custom_json + seed reputation. The shared
    // cascade mirrors orcid.ts handleAccredit: a broadcast failure produces 502
    // BROADCAST_FAILED / 504 BROADCAST_TIMEOUT, and a post-broadcast seed
    // failure produces 502 POST_BROADCAST_FAILED with
    // `failed_step:'reputation_seed'`. Without it, prior code returned 200 + JWT
    // for an account whose chain op never landed (the "dangling JWT" class). On
    // the resume paths the cascade HAF-probes before re-broadcasting so an
    // ambiguous prior broadcast that actually landed is not duplicated.
    const cascade = await broadcastAccreditationAndSeed({
      res,
      routeFlavor: 'confirm',
      username: normalizedUsername,
      account: confirmedAccount,
      isResume,
      resumeStuck,
    });
    if (cascade === 'handled') return;

    // No sibling-token invalidation sweep is needed here: migration 007's
    // partial unique index on accounts(orcid) WHERE orcid IS NOT NULL forbids
    // a second row sharing this account's non-null orcid, and email-only
    // signups have orcid NULL (no sibling to match). A leaked sibling
    // auth_token therefore has no reachable row to replay against.
    clearBindingCookie(res);

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
      // Omit on resume paths (createResult stays null) — no new block was
      // created, so there is no block_num to report.
      ...(createResult ? { block_num: createResult.block_num } : {}),
    });
    },
  );
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/link — Link existing Hive account after email verification (SF6)
// Requires auth_token + Keychain signature proving Hive account ownership
// ─────────────────────────────────────────────────────────────
router.post('/link', linkLimiter, linkTokenLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
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
    signup_binding_hash: Buffer | null;
  };

  // Acquire the per-auth_token activation lock BEFORE any pg work — symmetric
  // to /confirm. /link has no createClaimedAccount, but the lock still single-
  // fires the activation UPDATE + accreditation and lets the Hive existence
  // check run without a held pg connection. See `signup-activation-lock.ts`.
  // The wrapper owns the acquire/409-LOCK_HELD/finally-release ceremony; the
  // body calls `releaseLock()` at the single-fire-critical-section boundary.
  await withSignupActivationLock(
    {
      res,
      authToken: auth_token,
      onError: (err) => {
        logger.error(
          { event: 'signup_verify.link.failed', route: 'signup-verify.link', err },
          'Account linking failed',
        );
        sendError(res, 500, 'INTERNAL_ERROR', 'Account linking failed');
      },
    },
    async (releaseLock) => {
    let account: LinkRow | null = null;
    // verify_token already NULL — a prior /link attempt completed the finalize
    // UPDATE (custody='self') but its accreditation broadcast failed. /link has
    // no chain-create step, so its only irreversible op (accreditation) runs
    // after finalize and is covered by this stuck-recovery — there is no
    // chain-create crash gap, hence no chain-exists resume flavor here.
    let resumeStuck = false;

    // 1. Look up the pending row by auth token. Plain pooled query — no held
    //    transaction. The activation lock (not a pg lock) gives single-fire.
    const { rows } = await pool.query<LinkRow>(
      `SELECT id, email, password_hash, full_name, institution, field, orcid, signup_binding_hash
       FROM accounts WHERE verify_token = $1`,
      [auth_token],
    );
    account = rows[0] ?? null;

    if (account) {
      // Session-binding check (fresh-link path). The reject shape matches the
      // no-row "invalid or expired" 400 below so a leaked auth_token cannot be
      // confirmed-as-valid via this side channel. See `signup-session-binding.ts`.
      const cookieValue = extractBindingCookie(req);
      const bindingOk = cookieValue !== null
        && verifyBinding(cookieValue, account.signup_binding_hash);
      if (!bindingOk) {
        logger.warn(
          {
            event: 'signup_verify.link.binding_rejected',
            route: 'signup-verify.link',
            cookie_present: cookieValue !== null,
            row_has_hash: account.signup_binding_hash !== null,
          },
          'signup_verify.link rejected: session-binding cookie missing or mismatched',
        );
        return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired link request');
      }
    } else if (req.hiveAuthMethod === 'signature') {
      // Stuck-account recovery (Option C). A prior /link attempt finished the
      // finalize UPDATE (custody='self', verify_token NULL) but its
      // accreditation broadcast failed, locking the user out of the verify_token
      // lookup. Recover via a username-keyed fallback. This bypasses the
      // session-binding check, so it is gated on a FRESH Keychain signature
      // (`hiveAuthMethod === 'signature'`), NOT a replayable Bearer JWT: a
      // stolen JWT for a stuck self-custody row must not reach the binding
      // bypass. A fresh signature is the per-request ownership proof that
      // justifies skipping the binding; JWT callers fall through to the no-row
      // 400 reject.
      const stuckLookup = await pool.query<LinkRow>(
        `SELECT id, email, password_hash, full_name, institution, field, orcid, signup_binding_hash
         FROM accounts
         WHERE username = $1
           AND verify_token IS NULL
           AND custody = 'self'
           AND updated_at > NOW() - INTERVAL '${STUCK_RECOVERY_WINDOW}'`,
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
      // Verify the Hive account exists. Runs with NO pg connection held.
      const [hiveAccount] = await hiveClient.database.getAccounts([hiveUsername]);
      if (!hiveAccount) {
        return sendError(res, 404, 'NOT_FOUND', 'Hive account not found');
      }

      // Check the Hive account isn't already registered.
      const { rows: existing } = await pool.query<{ username: string }>(
        'SELECT username FROM accounts WHERE username = $1',
        [hiveUsername],
      );
      if (existing.length > 0) {
        return sendError(res, 409, 'DUPLICATE', 'This Hive account is already linked');
      }

      // Activate: set username, custody=self, upgraded_at, clear verify_token
      // and the binding hash (it has served its purpose). Single atomic UPDATE
      // on a short-lived pooled connection; the activation lock prevents a
      // concurrent same-token writer.
      const now = new Date();
      await pool.query(
        `UPDATE accounts
         SET username = $1, custody = 'self', verify_token = NULL, upgraded_at = $2,
             signup_binding_hash = NULL, updated_at = NOW()
         WHERE id = $3`,
        [hiveUsername, now, account.id],
      );
    }

    // `account` is non-null here (every reject above returns). Pin a non-null
    // const for the broadcast block (see /confirm for the de-narrowing reason).
    const linkedAccount = account;

    // Release the activation lock NOW — the single-fire-critical section (the
    // verify_token-clearing finalize) is complete. The accreditation
    // broadcast/seed below have their own dedup, so holding the lock across
    // that slow step would only make a concurrent same-token waiter block
    // longer. The wrapper's `finally` re-release is a CAS/nonce-safe no-op here.
    await releaseLock();

    // Broadcast accreditation custom_json + seed reputation. See /confirm above
    // for full rationale (no dangling JWT for an account whose chain op never
    // landed). Mirrors the orcid.ts handleLink pattern: broadcast failure →
    // 502/504; post-broadcast permanent seed failure → 502
    // POST_BROADCAST_FAILED. /link has only the stuck-recovery resume flavor
    // (no chain-create crash gap), so `isResume` is just `resumeStuck`.
    const cascade = await broadcastAccreditationAndSeed({
      res,
      routeFlavor: 'link',
      username: hiveUsername,
      account: linkedAccount,
      isResume: resumeStuck,
      resumeStuck,
    });
    if (cascade === 'handled') return;

    // No sibling-token invalidation sweep here, for the same reason as
    // `/confirm` above: migration 007's partial unique index on
    // accounts(orcid) WHERE orcid IS NOT NULL makes a same-orcid sibling row
    // impossible, so there is nothing to invalidate.
    clearBindingCookie(res);

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
    },
  );
});

// Test-only seam: arms a one-shot failure of the `/confirm` finalize UPDATE for
// a given auth_token so a test can drive the createClaimedAccount-succeeds-then-
// finalize-fails crash transition end-to-end (the row is left in the
// resumeChainExists-recoverable state). The route handler reads the armed set
// via `maybeThrowInjectedFinalizeFailure`, which is itself a no-op unless
// NODE_ENV=test. NOT for production import — the no-restricted-imports rule in
// `eslint.config.mjs` flags any import of this seam from `src/`.
export const __test_seams = {
  failNextFinalizeUpdate(authToken: string): void {
    injectedFinalizeFailures.add(authToken);
  },
} as const;

export default router;
