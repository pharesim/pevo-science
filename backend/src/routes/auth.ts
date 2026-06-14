import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { z } from 'zod';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { sendOk, sendError } from '../response.js';
import { config } from '../config.js';
import { rateLimit, byIp, byAccount } from '../middleware/rateLimit.js';
import { isInstitutionalEmail } from '../email-validator.js';
import { getAppPool } from '../app-db.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { logger } from '../logger.js';
import { flushAndExit } from '../lib/flush-and-exit.js';
import { isPasswordValid, PASSWORD_POLICY_MESSAGE } from '../lib/password-policy.js';
import { ARGON2_OPTIONS } from '../lib/argon2-options.js';
import { runWithArgon2Slot, ShuttingDownError, isArgonSemaphoreError } from '../lib/argon2-semaphore.js';
import { handleArgonError, ARGON_HANDLED } from '../lib/argon2-error-handler.js';
import { requestAbortSignal } from '../lib/request-abort-signal.js';
import {
  hashEmailForLogs,
  maskEmail,
  safeHashEmailForLogs,
} from '../lib/log-pii.js';
import { createSmtpTransporter } from '../lib/smtp.js';
import { mintBinding, setBindingCookie } from '../signup-session-binding.js';

// ─── Per-route Zod body schemas ────
//
// These schemas replace the `req.body as any` + `field as string` casts
// that previously existed across these 3 handlers. Each schema narrows
// req.body to a real TypeScript type via z.infer, so downstream code
// gets type-safe destructuring without unsafe casts.
//
// Incremental migration: only /login and /signup are covered here (the
// /recover schema moved to routes/recover.ts with the recover handlers).
// Business validation (isEmail / isPasswordValid / etc.) still runs after
// the schema parse; Zod handles shape only. Status codes and error-code
// strings remain unchanged.
//
// Error shape: on parse failure, handlers return 400 VALIDATION_ERROR
// with a generic 'Invalid request body' message and NO `details.issues`.
// The raw zod issue array leaks schema shape (field paths, constraint
// codes, received types) to unauthenticated callers, which hardens the
// target for probing. Business validation errors (isEmail,
// isPasswordValid, etc.) continue to emit specific messages because
// those run post-parse and have their own endpoint-specific surface.

const LoginBodySchema = z.object({
  // Either `username` or `email_or_username` must be present — the
  // handler accepts both for backward compatibility with older frontend
  // builds. Both are optional in the schema; a superRefine enforces the
  // OR-required semantic. Dropping either field out of the schema
  // would 400-bounce legit frontend traffic sending the other.
  username: z.string().optional(),
  email_or_username: z.string().optional(),
  password: z.string().optional(),
}).refine(
  (b) => (b.username && b.username.length > 0) || (b.email_or_username && b.email_or_username.length > 0),
  { message: 'username or email_or_username is required', path: ['username'] },
);

const SignupBodySchema = z.object({
  email: z.string().optional(),
  password: z.string().optional(),
  full_name: z.string().optional(),
  institution: z.string().optional(),
  field: z.string().optional(),
  orcid_token: z.string().optional(),
});

// Schemas for /resend-verification,
// /reset-request, /reset. Same flat-error pattern as the earlier Zod
// schemas in this file — shape only, business validation (isEmail, isPasswordValid)
// continues to run after safeParse.
const ResendVerificationBodySchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

const ResetRequestBodySchema = z.object({
  email: z.string().min(1),
});

const ResetBodySchema = z.object({
  token: z.string().min(1),
  password: z.string().optional(),
});

const router = Router();

export const SESSION_EXPIRY = '24h';
export const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const SIGNUP_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const MAX_LOGIN_FAILURES = 20;

// /reset-request OK response message. The endpoint's enumeration-prevention
// invariant requires that BOTH branches (unknown-email + known-email) emit a
// byte-for-byte identical response. Centralized here so a wording change at
// one site cannot silently re-open the email-enumeration oracle by drifting
// the two branches apart. Both the unknown-email burn-then-200 path and the
// known-email DB-update-then-200 path must use this constant.
export const RESET_REQUEST_OK_MESSAGE = 'If an account exists with that email, a reset link has been sent.';

// Sentinel argon2id hash for timing-equalization at every "cheap" early-return
// that would otherwise distinguish a known-account branch from an unknown one
// (login unknown-account, NO_PASSWORD_SET null-hash,
// resend-verification unknown-email AND null-hash known-email, recover
// unknown-username, reset-request unknown-email, signup 409 DUPLICATE).
// Without sentinel burns, those ~1ms paths stand out against the ~50-100ms
// real-argon2 paths and let unauthenticated attackers enumerate accounts. The
// status-code axis may still differ per-endpoint, but timing does not.
// Note: on /signup 409 DUPLICATE paths we burn argon2.hash (not verify) to
// match the happy-path argon2.hash cost — see the /signup handler.
//
// Concurrency / libuv note: argon2.verify runs on the libuv thread pool.
// The JS-level semaphore at lib/argon2-semaphore.ts is the deterministic cap
// (`runWithArgon2Slot` caps concurrent ops at MAX_CONCURRENT_ARGON2_OPS,
// derived from libuv pool size and argon2 parallelism). The env knob is
// libuv headroom so the semaphore can fill its slots without queueing at
// the pool layer. Every argon2.hash / argon2.verify on auth paths (incl.
// burnSentinel's internal verify) goes through runWithArgon2Slot; the sole
// exception is the module-load SENTINEL_ARGON2_HASH_PROMISE below, which
// runs exactly once and cannot saturate anything. Argon2 semaphore
// saturation counters are deliberately NOT exposed on /api/health (publicly
// polled, would give an attacker near-real-time feedback for tuning
// parallel attacks). Operators access the counters via SSH on the host
// (`getArgon2QueueDepth` / `getArgon2InFlight` exports remain available
// for ops tooling and tests), independent of pino async-transport
// drainage under OOM.
//
// Fail-loud guard: if UV_THREADPOOL_SIZE is unset or below 16 in the
// environment, reject at module-load rather than serving traffic with a
// hidden saturation oracle. The semaphore landed at lib/argon2-semaphore.ts
// enforces the deterministic JS-level cap; this env check remains as a
// defense-in-depth libuv headroom invariant. Production startup MUST set
// UV_THREADPOOL_SIZE; the Dockerfile and docker-compose environment both
// carry it. Vitest sets UV_THREADPOOL_SIZE=16 in vitest.config.ts so the
// assertion fires identically under test.
{
  const pool = Number(process.env.UV_THREADPOOL_SIZE);
  if (!Number.isFinite(pool) || pool < 16) {
    throw new Error(
      `UV_THREADPOOL_SIZE must be >= 16 for burnSentinel determinism (got ${process.env.UV_THREADPOOL_SIZE ?? 'unset'}); the JS-level argon2 semaphore is the real concurrency cap, this env value is libuv headroom.`,
    );
  }
}

const SENTINEL_ARGON2_HASH_PROMISE: Promise<string> = argon2.hash(
  'pevo-login-timing-sentinel-v1',
  ARGON2_OPTIONS,
);

// Startup-rejection handler. If argon2.hash rejects at module load (native
// binding missing, memory pressure at boot, libuv thread exhaustion), every
// later `await SENTINEL_ARGON2_HASH_PROMISE` would throw and every sentinel
// `.catch` would silently swallow — the oracle would reopen for the whole
// process lifetime with zero operator signal. Fail loud instead: log and
// exit so the process supervisor restarts into a state that either works or
// fails loudly again. This is a security primitive; partial function is
// worse than hard fail.
SENTINEL_ARGON2_HASH_PROMISE.catch((err) => {
  logger.error(
    { event: 'auth.startup.sentinel_hash_failed', route: 'auth.startup', err },
    'SENTINEL_ARGON2_HASH_PROMISE rejected at startup — timing-equalization oracle would be silently open; exiting',
  );
  // Drain the pino transport worker before exit via the shared boot-fatal
  // helper. The helper's 2s watchdog covers the same hang risk this site's
  // inline copy used to guard against (deadlocked transport worker under
  // the OOM conditions that killed argon2 at startup). See
  // `src/lib/flush-and-exit.ts` for the full rationale.
  flushAndExit();
});

// Burn one argon2.verify cycle against the pre-computed sentinel to equalize
// wall-time with the real-verify branch at the same call site. Used at every
// early-return path whose real counterpart would otherwise pay the ~50ms
// argon2.verify cost. Silent on successful burn; log on failure so an operator
// sees the oracle reopen (argon2 native crash, OOM, libuv thread pool
// exhaustion all cause the burn to noop and the response to return in ~1ms).
//
// The caller MUST pass an explicit input (no default parameter): the
// attacker-supplied password on login/resend-verification, the email on
// reset-request, or a synthesized-but-consistent string elsewhere. Pinning the
// input to request data is cost-equivalent either way; the purpose is
// wall-time, not correctness.
//
// Oversized-input guard: argon2.verify rejects inputs > ~4096 bytes BEFORE
// entering the compute phase, which would silently short-circuit the burn
// via the catch and reopen the oracle. Clip to 1024 bytes (well below the
// argon2 ceiling) so an attacker cannot sidestep the burn by sending a long
// password / email.
//
// IMPORTANT: burnSentinel covers only the argon2.VERIFY cost. The /signup
// happy-path uses argon2.HASH (~2× the cost of verify at these options). On
// /signup 409 DUPLICATE early-returns we therefore call argon2.hash directly
// — NOT burnSentinel — so the verify-vs-hash asymmetry doesn't reopen the
// oracle along the wall-time axis. See the /signup handler for call sites.
//
// Timing tests assert ≥TIMING_ORACLE_FLOOR_MS (currently 35ms). The floor
// and its argon2-tuning rationale (why 35ms vs 50ms vs 40ms, and what to
// revisit if ARGON2_OPTIONS.memoryCost / time changes) live in
// backend/tests/support/timing-constants.ts, shared across recover.test.ts,
// signup-verify.test.ts, and auth-concurrency.test.ts.
export async function burnSentinel(input: string, signal?: AbortSignal): Promise<void> {
  try {
    const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
    // Clip attacker-controlled oversize input before handing it to argon2:
    // argon2.verify rejects >4096-byte inputs early, which would turn the
    // burn into a noop and reopen the oracle. 1024 bytes is well under the
    // limit and matches the compute cost of any realistic password.
    const safeInput = input.length > 1024 ? input.slice(0, 1024) : input;
    await runWithArgon2Slot(() => argon2.verify(sentinelHash, safeInput), { signal });
  } catch (err) {
    // Every ArgonSemaphoreError subclass MUST propagate so route handlers
    // can translate to 503 (queue-full / shutting-down) or silent return
    // (abort). Swallowing here would return ~0ms from burnSentinel under
    // queue-full / shutting-down conditions and reopen the timing oracle
    // under DoS load or during SIGTERM drain — the opposite of what the
    // JS-level semaphore is for. The single instanceof check covers all
    // three subclasses (ArgonQueueFullError, ShuttingDownError,
    // ArgonAbortError) and any future addition extending the base.
    if (isArgonSemaphoreError(err)) throw err;
    // Cross-file caller attribution: burnSentinel is imported from auth.ts AND
    // custody.ts AND signup-verify.ts AND recover.ts. The `auth.burn_sentinel.*` prefix tags
    // the FILE the emission lives in, not the calling route — operators
    // grepping for `auth.signup.*` or `auth.recover.*` will not match this
    // line even when the failing burn fired from a sibling-file caller. See
    // `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md`
    // §"File-level (non-endpoint) emissions" for the convention.
    logger.warn(
      { event: 'auth.burn_sentinel.failed', route: 'auth.burn_sentinel', err },
      'argon2 sentinel burn failed — timing oracle may be open',
    );
  }
}

// Argon2-semaphore catch-block handler factored to lib/argon2-error-handler.ts.
// Imported as `handleArgonError` above. Every catch site that wraps a
// `runWithArgon2Slot` call (directly or transitively via burnSentinel)
// invokes it as the first step in the catch block:
//
//   if (handleArgonError(res, err, { logContext }) === ARGON_HANDLED) return;
//
// Distinct log lines so operators can separate "increase capacity"
// (ArgonQueueFullError spikes under load) from "benign during rolling
// restart" (ShuttingDownError during SIGTERM drain). Both return the same
// 503 status + SERVICE_UNAVAILABLE code so clients handle them identically;
// ArgonAbortError logs at debug and returns silently because the socket is
// already gone.

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
// POST /api/auth/signup — Light account signup (LA6)
// ─────────────────────────────────────────────────────────────
router.post('/signup', signupLimiter, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Registration not available');

  const parsed = SignupBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body');
  }
  const { email, password, full_name, institution, field, orcid_token } = parsed.data;

  const hasOrcidToken = !!(orcid_token && orcid_token.length > 0);

  // Validate orcid_token first if provided — retrieve verified ORCID data
  let verifiedOrcid: string | null = null;
  let orcidName: string | null = null;
  if (hasOrcidToken) {
    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      const raw = await redis.get(`${config.appTag}:orcid_verified:${orcid_token}`);
      if (raw) {
        await redis.del(`${config.appTag}:orcid_verified:${orcid_token}`);
        const parsed = JSON.parse(raw) as { orcid_id: string; works_count: number; name?: string };
        verifiedOrcid = parsed.orcid_id;
        orcidName = parsed.name || null;
      }
    } else {
      const { orcidVerified } = await import('./orcid.js');
      const entry = orcidVerified.get(orcid_token);
      if (entry && entry.expires > Date.now()) {
        verifiedOrcid = entry.orcid_id;
        orcidName = entry.name || null;
        orcidVerified.delete(orcid_token);
      }
    }
  }

  // Validate required fields — relaxed when orcid_token is present.
  // Zod ensures every named field is either string-or-undefined; the
  // nonempty checks below are the business-required-field guards, NOT
  // type guards.
  const hasEmail = !!(email && email.length > 0);
  const hasPassword = !!(password && password.length > 0);

  if (!hasOrcidToken) {
    // Standard signup: all fields required
    if (!hasEmail) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Email is required');
    }
    if (!isPasswordValid(password)) {
      return sendError(res, 400, 'VALIDATION_ERROR', PASSWORD_POLICY_MESSAGE);
    }
    if (!full_name || full_name.length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Full name is required');
    }
    if (!field || field.length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Field of research is required');
    }
  } else {
    // ORCID signup: password required only when email is provided
    if (hasEmail && hasPassword && !isPasswordValid(password)) {
      return sendError(res, 400, 'VALIDATION_ERROR', PASSWORD_POLICY_MESSAGE);
    }
  }

  const normalizedEmail = hasEmail ? email!.trim().toLowerCase() : null;
  const isInstitutional = normalizedEmail ? isInstitutionalEmail(normalizedEmail) : false;

  // Resolve full_name: explicit value > ORCID profile name
  const resolvedName = (full_name && full_name.length > 0)
    ? full_name.trim()
    : (orcidName || '');
  const resolvedInstitution = institution ? institution.trim() : '';
  const resolvedField = field ? field.trim() : '';

  try {
    // Check email not already registered or pending (skip for no-email ORCID signups).
    //
    // Check-order note: this
    // duplicate-email check fires BEFORE the accreditation gate below.
    // If the two fired in the opposite order, an attacker could probe
    // public-domain institutional emails (mit.edu, harvard.edu, and so
    // on) and distinguish "account exists" (~50ms 409 with argon2.hash
    // burn) from "no account here" (422 in ~0ms). Running the duplicate
    // check first pushes both known-institution AND unknown-institution
    // duplicate paths through the same argon2.hash-equalized 409, so
    // registration status is not leaked on the timing axis. A non-
    // duplicate email on an unaccredited domain still returns 422 fast --
    // institution membership is public knowledge and not the signal
    // being closed here. Behavior change: an unaccredited-institution
    // duplicate-email caller previously got 422 ACCREDITATION_NOT_FOUND;
    // now they get 409 DUPLICATE, which is more accurate about their
    // actual email state. Neither path lets them complete signup.
    // Under saturation, the duplicate path returns 503 (translated from
    // `ArgonQueueFullError`/`ShuttingDownError` via `handleArgonError`)
    // rather than 409. The 503-vs-422 differential on unaccredited domains
    // is the same registration-status signal as 409-vs-422 in the non-
    // saturated case; saturation does not widen the leak, only changes the
    // registered-side status code. The unaccredited-domain registration-
    // status signal remains out-of-scope per the rationale above.
    if (normalizedEmail) {
      const { rows: existingRows } = await pool.query<{ verify_token: string | null }>(
        'SELECT verify_token FROM accounts WHERE email = $1',
        [normalizedEmail],
      );
      if (existingRows.length > 0) {
        // Already-registered 409 short-circuits before argon2.hash below. The
        // happy path on /signup pays argon2.HASH (~100ms, roughly 2× the
        // verify cost) — running burnSentinel (argon2.verify, ~50ms) here
        // would leave a ~2× wall-time gap between the 409 and the happy
        // path, reopening the enumeration oracle along the timing axis.
        // Call argon2.hash directly and discard the result: purely CPU-time
        // equalization, no persistence. Silent-catch so a native argon2
        // failure degrades the same way burnSentinel does (logged by the
        // global catch at module top when the startup hash rejects).
        // Gate on truthy `password` to avoid paying argon2 cost on
        // ORCID+email signup with no password (both 409 and happy-path are
        // ~1ms there, no oracle to close). The truthy-narrow also gives TS
        // `password: string` for the `argon2.hash` call below without an
        // `as string` cast. The hex-pending fall-through path below runs
        // argon2.hash + upsert naturally, so no burn is needed there.
        if (existingRows[0].verify_token === null) {
          if (password) await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS), { signal: abortSignal }).catch((err) => {
            // Structural collapse, behavior unchanged: the pre-refactor
            // form already enumerated all three concrete subclasses
            // (ArgonQueueFullError || ShuttingDownError || ArgonAbortError)
            // and re-threw each. The single `instanceof ArgonSemaphoreError`
            // check covers the same set via the shared abstract base and
            // any future fourth subclass extending it. Swallowing any of
            // these here would short-circuit the burn to ~0ms and reopen
            // the timing oracle under DoS / drain conditions.
            if (isArgonSemaphoreError(err)) throw err;
            logger.warn(
              { event: 'auth.signup.dup_burn_failed', route: 'auth.signup', err },
              'argon2 signup-dup burn failed — timing oracle may be open',
            );
          });
          return sendError(res, 409, 'DUPLICATE', 'Email already registered');
        }
        if (existingRows[0].verify_token.startsWith('confirmed:')) {
          if (password) await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS), { signal: abortSignal }).catch((err) => {
            // Structural collapse, behavior unchanged: see the matching
            // `verify_token === null` branch above for the rationale.
            if (isArgonSemaphoreError(err)) throw err;
            logger.warn(
              { event: 'auth.signup.dup_burn_failed', route: 'auth.signup', err },
              'argon2 signup-dup burn failed — timing oracle may be open',
            );
          });
          return sendError(res, 409, 'DUPLICATE', 'Email already verified. Please log in to continue.');
        }
        // Unverified — allow overwrite via ON CONFLICT below
      }
    }

    // Accreditation gate: institutional email OR verified ORCID required.
    // Runs AFTER the duplicate-email check above so a duplicate on a
    // non-institutional domain returns 409 DUPLICATE (accurate about
    // email state) rather than 422 ACCREDITATION_NOT_FOUND (which would
    // leak registration status to anyone probing accredited-domain
    // addresses). See the check-order note at the duplicate-email check
    // for the full rationale.
    if (!isInstitutional && !verifiedOrcid) {
      return sendError(res, 422, 'VALIDATION_ERROR', 'Either an institutional email or ORCID verification is required');
    }

    // Hash password if provided
    const passwordHash = hasPassword
      ? await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS), { signal: abortSignal })
      : null;

    const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_EXPIRY_MS);

    // ORCID signups skip email verification — go directly to confirmed state
    if (verifiedOrcid) {
      const confirmed = `confirmed:${crypto.randomBytes(32).toString('hex')}`;
      // Mint the session-binding cookie that `/confirm` and `/link` will
      // require. Store the SHA-256 of the cookie value on the row's
      // `signup_binding_hash` column. See `signup-session-binding.ts` for
      // the threat model: possession of the auth_token alone (mailbox leak,
      // Referer, login error body) must NOT be enough to complete the
      // signup with attacker-controlled keys.
      const binding = mintBinding();

      if (normalizedEmail) {
        // ORCID + email: upsert with ON CONFLICT
        await pool.query(
          `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at, signup_binding_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (email) DO UPDATE SET
             password_hash = EXCLUDED.password_hash,
             full_name = EXCLUDED.full_name,
             institution = EXCLUDED.institution,
             field = EXCLUDED.field,
             orcid = EXCLUDED.orcid,
             verify_token = EXCLUDED.verify_token,
             expires_at = EXCLUDED.expires_at,
             signup_binding_hash = EXCLUDED.signup_binding_hash,
             created_at = NOW()`,
          [normalizedEmail, passwordHash, resolvedName, resolvedInstitution, resolvedField, verifiedOrcid, confirmed, expiresAt, binding.hash],
        );
      } else {
        // ORCID-only (no email): plain insert
        await pool.query(
          `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at, signup_binding_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [null, null, resolvedName, resolvedInstitution, resolvedField, verifiedOrcid, confirmed, expiresAt, binding.hash],
        );
      }

      setBindingCookie(res, binding.cookieValue);
      sendOk(res, {
        flow: 'choose',
        auth_token: confirmed,
        expires_at: expiresAt.toISOString(),
      });
      return;
    }

    // Standard email signup — send verification email
    const verifyToken = crypto.randomBytes(32).toString('hex');

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
      [normalizedEmail, passwordHash, resolvedName, resolvedInstitution, resolvedField, null, verifyToken, expiresAt],
    );

    // Send verification email
    if (config.smtpHost) {
      try {
        const transporter = createSmtpTransporter();

        const verifyUrl = `${config.appUrl}/signup/verify?token=${verifyToken}`;
        await transporter.sendMail({
          from: config.smtpFrom,
          to: normalizedEmail!,
          subject: 'PEvO - Verify your email',
          text: `Welcome to PEvO!\n\nPlease verify your email to complete your registration:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you did not sign up for PEvO, you can safely ignore this email.\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
        });
      } catch (mailErr) {
        logger.error(
          { event: 'auth.signup.smtp_send_failed', route: 'auth.signup', err: mailErr },
          'Failed to send verification email',
        );
        // Delete the account row since we couldn't send the email
        await pool.query('DELETE FROM accounts WHERE verify_token = $1', [verifyToken]);
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send verification email');
      }
    } else {
      logger.error(
        {
          event: 'auth.signup.smtp_not_configured',
          route: 'auth.signup',
          email_hash: safeHashEmailForLogs(normalizedEmail),
        },
        'SMTP not configured — cannot send verification email',
      );
      await pool.query('DELETE FROM accounts WHERE verify_token = $1', [verifyToken]);
      return sendError(res, 500, 'INTERNAL_ERROR', 'Email service not configured');
    }

    sendOk(res, {
      message: `Verification email sent to ${maskEmail(normalizedEmail!)}`,
      expires_at: expiresAt.toISOString(),
    });
  } catch (err) {
    if (handleArgonError(res, err) === ARGON_HANDLED) return;
    logger.error(
      { event: 'auth.signup.failed', route: 'auth.signup', err },
      'Signup failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Registration failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/resend-verification — Resend verification email
// Requires email + password to prevent abuse
// ─────────────────────────────────────────────────────────────
const resendLimiter = rateLimit({ name: 'auth-resend', windowMs: 3_600_000, max: 3, keyFn: byIp });

router.post('/resend-verification', resendLimiter, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const parsed = ResendVerificationBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body');
  }
  const { email, password } = parsed.data;

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
      // wall-time below. Without this, unknown-email returns in ~1ms while
      // known-email returns in ~50ms — an enumeration oracle that undermines the
      // constant-message 200 response.
      await burnSentinel(password, abortSignal);
      return sendOk(res, { message: 'If that email has a pending signup, a new verification link has been sent.' });
    }

    const account = rows[0];

    // The null-hash (ORCID-only) branch must also burn sentinel. Without
    // this, unknown-email costs ~50ms (burn above) but known-email-with-
    // null-hash short-circuits to ~1ms, INVERTING the oracle: ~1ms now
    // means "ORCID-only account exists here." Match both branches by
    // running either the real verify OR a sentinel burn.
    let passwordValid = false;
    if (account.password_hash) {
      // Canonical hoist pattern (mirrored from the `/resume-signup`
      // handler in `signup-verify.ts`): `account.password_hash` is
      // `string | null`; the `if (account.password_hash)` check above
      // narrows it to `string` here, but the narrowing does not carry
      // into the `runWithArgon2Slot` closure body. Hoist to a local
      // const to pin the narrowed type for the closure, replacing the
      // prior non-null assertion.
      const passwordHash = account.password_hash;
      passwordValid = await runWithArgon2Slot(() => argon2.verify(passwordHash, password), { signal: abortSignal });
    } else {
      await burnSentinel(password, abortSignal);
    }
    if (!passwordValid) {
      return sendOk(res, { message: 'If that email has a pending signup, a new verification link has been sent.' });
    }

    // Already active or confirmed — no need to resend. Emit the same uniform
    // message as the unknown-email and wrong-password branches so a caller
    // supplying a correct password cannot read back the account's state
    // (active vs already-verified vs pending) via the response body. The
    // distinct messages were a privacy-leaking oracle: any password-holder
    // could probe other emails and learn whether those accounts exist and
    // what lifecycle state they're in.
    if (!account.verify_token) {
      return sendOk(res, { message: 'If that email has a pending signup, a new verification link has been sent.' });
    }
    if (account.verify_token.startsWith('confirmed:')) {
      return sendOk(res, { message: 'If that email has a pending signup, a new verification link has been sent.' });
    }

    // Generate new token and reset expiry
    const newToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_EXPIRY_MS);
    await pool.query(
      'UPDATE accounts SET verify_token = $1, expires_at = $2 WHERE id = $3',
      [newToken, expiresAt, account.id],
    );

    // SMTP-failure status-code oracle:
    // this known-email branch MUST NOT return 500 when sendMail throws. If it
    // did, an attacker inducing an SMTP outage would observe 500 = "pending
    // signup exists for this email + matches this password" vs 200 = any other
    // shape (unknown email, wrong password, already-active, already-confirmed)
    // — a status-code oracle that bypasses the wall-time equalization work.
    // See `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`.
    if (config.smtpHost) {
      try {
        const transporter = createSmtpTransporter();

        const verifyUrl = `${config.appUrl}/signup/verify?token=${newToken}`;
        await transporter.sendMail({
          from: config.smtpFrom,
          to: normalizedEmail,
          subject: 'PEvO - Verify your email',
          text: `Welcome to PEvO!\n\nPlease verify your email to complete your registration:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you did not sign up for PEvO, you can safely ignore this email.\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
        });
      } catch (err) {
        logger.warn(
          {
            event: 'auth.resend_verification.smtp_send_failed',
            route: 'auth.resend-verification',
            emailKnown: 'known',
            err,
          },
          'SMTP send failed',
        );
        // Fall through to uniform 200 below.
      }
    } else {
      logger.warn(
        {
          event: 'auth.resend_verification.smtp_not_configured',
          route: 'auth.resend-verification',
          emailKnown: 'known',
        },
        'SMTP not configured — verification email not sent',
      );
    }

    sendOk(res, { message: 'If that email has a pending signup, a new verification link has been sent.' });
  } catch (err) {
    if (handleArgonError(res, err) === ARGON_HANDLED) return;
    logger.error(
      { event: 'auth.resend_verification.failed', route: 'auth.resend-verification', err },
      'Resend verification failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to resend verification email');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/login — Password-based login (LA8)
// ─────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Login not available');

  const parsed = LoginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body');
  }
  const { username, email_or_username, password } = parsed.data;
  // Schema.refine enforces that at least one of username/email_or_username
  // is a non-empty string; loginId is therefore a non-empty string here.
  const loginId = (email_or_username || username) as string;

  if (!password) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Password is required');
  }

  const normalized = loginId.trim().toLowerCase();

  try {
    // Single-table lookup by username or email
    const { rows } = await pool.query<{
      id: number;
      email: string;
      username: string | null;
      password_hash: string | null;
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
      // Unknown-account path: burn sentinel to match the known-account
      // wrong-password wall-time below. Closes the username/email-enumeration
      // oracle for unauthenticated attackers. Status-code stays 401 (matches
      // wrong-password); only timing is closed.
      await burnSentinel(password, abortSignal);
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid credentials');
    }

    const account = rows[0];

    // ORCID-only (or otherwise password-less) accounts cannot log in with a password.
    // Return a distinct 403 so the UI can direct the user to sign in with ORCID or
    // recover via seed phrase. Must NOT collapse into the generic 401 — that would
    // make password login indistinguishable from "wrong password" and hide the
    // correct remediation path from legitimate users.
    //
    // Before returning, burn a sentinel argon2.verify so this branch takes the
    // same wall-time as the real verify branch. Otherwise a network attacker
    // can enumerate ORCID-only accounts by timing the response.
    if (!account.password_hash) {
      await burnSentinel(password, abortSignal);
      return sendError(
        res,
        403,
        'NO_PASSWORD_SET',
        'Account has no password; sign in with ORCID or recover via seed phrase',
      );
    }

    // Verify password (timing-equalized with the NO_PASSWORD_SET branch above
    // via the sentinel hash, so status-code is the only signal distinguishing
    // null-hash accounts from unknown accounts — not response wall-time).
    //
    // Canonical hoist pattern (mirrored from the `/resume-signup` handler in
    // `signup-verify.ts`): `account.password_hash` is `string | null`; the
    // `if (!account.password_hash)` early-return above proves it non-null
    // at runtime, but the narrowing does not carry across the
    // runWithArgon2Slot closure boundary. Pin the narrowed type via a
    // closure-local const.
    const passwordHash = account.password_hash;
    const valid = await runWithArgon2Slot(() => argon2.verify(passwordHash, password), { signal: abortSignal });
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
        // Email verified but signup not completed. The SPA must direct the
        // user back to /signup/verify (via /resume-signup) where a fresh
        // session-binding cookie is minted before /confirm or /link can
        // succeed. Do NOT return the auth_token in the response body: the
        // token is the row-lookup credential for /confirm and /link, and
        // returning it here leaks it to any caller who can guess a
        // username and supply the correct password (or who can read this
        // body from a referer / proxy log / browser DevTools panel).
        // /resume-signup re-binds the cookie after re-verifying the
        // password, which is the only auth proof acceptable at this stage.
        return res.status(409).json({
          status: 'error',
          error: { code: 'PENDING_SIGNUP', message: 'Your signup is not complete yet.' },
          data: { email: account.email },
        });
      }
      // Unverified — check expiry
      if (account.expires_at && new Date() > new Date(account.expires_at)) {
        await pool.query('DELETE FROM accounts WHERE id = $1', [account.id]);
        return sendError(res, 410, 'SIGNUP_EXPIRED', 'Your signup has expired. Please sign up again.');
      }
      return sendError(res, 409, 'PENDING_UNVERIFIED', 'Your email has not been verified yet.');
    }

    // Active account — check lockout. This branch runs AFTER argon2.verify
    // succeeded, so the caller has already paid the ~50ms verify cost. No
    // sentinel burn here: adding one would push correct-password-on-locked
    // to ~100ms (verify + burn) while correct-password-on-unlocked stays at
    // ~50ms (verify only), creating a 2× timing asymmetry instead of closing
    // one. The 403 ACCOUNT_LOCKED status code already discloses lockout
    // state to callers who reach this point (they supplied the correct
    // password), so timing equalization adds no privacy; it only hurts.
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
    if (handleArgonError(res, err) === ARGON_HANDLED) return;
    logger.error(
      { event: 'auth.login.failed', route: 'auth.login', err },
      'Login failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Login failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/reset-request — Request password reset email (LA13)
// ─────────────────────────────────────────────────────────────
router.post('/reset-request', resetRequestLimiter, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const parsed = ResetRequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body');
  }
  const { email } = parsed.data;

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // Look up account by email
    const { rows } = await pool.query<{ id: number; username: string | null }>(
      'SELECT id, username FROM accounts WHERE email = $1',
      [normalizedEmail],
    );

    // Always return success to prevent email enumeration. The status-code and
    // message body are already uniform; close the remaining timing oracle by
    // burning a sentinel argon2.verify on the unknown-email branch — the
    // known-email branch below runs a DB UPDATE plus `await sendMail()`
    // (100-2000ms depending on the SMTP server). Without this burn, the
    // unknown-email path returns in ~1ms and a caller can enumerate accounts
    // on the email axis by response time alone. Note: the SMTP-tail timing
    // oracle on the known-email path is a separate concern (the SMTP-tail
    // timing differential there is not equalized here); this closes the
    // cheap-early-return half only.
    if (rows.length === 0) {
      // Drain-window enumeration fix: if the sentinel burn aborts because the
      // process is shutting down, fall through to the same generic 200 the
      // steady-state path would return. Previously this re-threw
      // `ShuttingDownError` to the outer catch, which translated it to 503 via
      // `handleArgonError`. The known-email branch below never touches argon2
      // and so kept returning 200 during drain — a status-code differential
      // that re-opens the email-enumeration oracle on every rolling-deploy
      // SIGTERM window. Returning 200 here briefly "lies" about service
      // availability; in exchange the indistinguishable-response invariant the
      // burn exists to enforce is preserved end-to-end. Any other error
      // (including `ArgonQueueFullError` and `ArgonAbortError`) propagates to
      // the outer catch via `handleArgonError` so saturation still surfaces as
      // 503 and client-disconnect still short-circuits silently. See
      // `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md`
      // for the broader sub-branch oracle pattern this catch is part of. See
      // also
      // `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`
      // for the SMTP-failure-axis sibling on the same handler.
      try {
        await burnSentinel(normalizedEmail, abortSignal);
      } catch (err) {
        if (!(err instanceof ShuttingDownError)) throw err;
        // Operator visibility: the swallow is otherwise silent (no status-code
        // differential is the entire point of the fix), so without this log the
        // only signal that the suppression fired during a drain window is the
        // oracle being closed. `debug` level keeps it default-off; available
        // via LOG_LEVEL=debug for investigation. `email_hash` keeps logs CNPD-
        // compliant by hashing the address.
        logger.debug(
          {
            event: 'auth.reset_request.drain_suppression',
            route: 'auth.reset-request',
            emailKnown: 'unknown',
            email_hash: hashEmailForLogs(normalizedEmail),
          },
          'ShuttingDownError on unknown-email branch suppressed to 200 — drain window',
        );
      }
      sendOk(res, { message: RESET_REQUEST_OK_MESSAGE });
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

    // Send reset email.
    //
    // SMTP-failure status-code oracle: the
    // known-email branch MUST NOT return 500 when sendMail throws or SMTP is
    // unconfigured. If it did, an attacker inducing or waiting for an SMTP
    // outage would observe 500 = "email exists" vs 200 = "email unknown" from
    // the burnSentinel path above — full enumeration via the HTTP status code,
    // bypassing all the wall-time equalization work. See
    // `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`.
    // Log at warn so operators see the outage, then fall through to the
    // uniform 200 below regardless of SMTP outcome.
    if (config.smtpHost) {
      try {
        const transporter = createSmtpTransporter();

        const resetUrl = `${config.appUrl}/auth/reset?token=${resetToken}`;
        await transporter.sendMail({
          from: config.smtpFrom,
          to: normalizedEmail,
          subject: 'PEvO - Password reset',
          text: `You requested a password reset for your PEvO account.\n\nReset your password here:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you did not request this, you can safely ignore this email.\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
        });
      } catch (err) {
        logger.warn(
          {
            event: 'auth.reset_request.smtp_send_failed',
            route: 'auth.reset-request',
            emailKnown: 'known',
            err,
          },
          'SMTP send failed',
        );
        // Fall through to uniform 200. Do NOT clear the reset token: a
        // legitimate user whose send failed transiently may retry and get a
        // working email on the SMTP relay's next attempt window.
      }
    } else {
      logger.warn(
        {
          event: 'auth.reset_request.smtp_not_configured',
          route: 'auth.reset-request',
          emailKnown: 'known',
        },
        'SMTP not configured — reset email not sent',
      );
    }

    sendOk(res, { message: RESET_REQUEST_OK_MESSAGE });
  } catch (err) {
    if (handleArgonError(res, err) === ARGON_HANDLED) return;
    logger.error(
      { event: 'auth.reset_request.failed', route: 'auth.reset-request', err },
      'Password reset request failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Password reset request failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/reset — Set new password using reset token (LA13)
// ─────────────────────────────────────────────────────────────
router.post('/reset', resetLimiter, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  const parsed = ResetBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body');
  }
  const { token, password } = parsed.data;
  if (!isPasswordValid(password)) {
    return sendError(res, 400, 'VALIDATION_ERROR', PASSWORD_POLICY_MESSAGE);
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

    // Hash new password. isPasswordValid flow-narrowed `password` to
    // `string` via its type-predicate return (`pw is string`), so no
    // cast is needed here.
    const passwordHash = await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS), { signal: abortSignal });

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
    if (handleArgonError(res, err) === ARGON_HANDLED) return;
    logger.error(
      { event: 'auth.reset.failed', route: 'auth.reset', err },
      'Password reset failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Password reset failed');
  }
});

export default router;
