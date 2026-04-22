import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { sendOk, sendError } from '../response.js';
import { config } from '../config.js';
import { rateLimit, byIp, byAccount } from '../middleware/rateLimit.js';
import { isInstitutionalEmail } from '../email-validator.js';
import { getAppPool } from '../app-db.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { logger } from '../logger.js';
import { decryptKey } from '../custody-crypto.js';
import { isPasswordValid, PASSWORD_POLICY_MESSAGE } from '../lib/password-policy.js';
import { ARGON2_OPTIONS } from '../lib/argon2-options.js';
import { runWithArgon2Slot, ArgonQueueFullError } from '../lib/argon2-semaphore.js';
import { hashEmailForLogs } from '../lib/log-pii.js';

// ─── Per-route Zod body schemas (BE-REQUEST-BODY-TYPING-ZOD) ────
//
// These schemas replace the `req.body as any` + `field as string` casts
// that previously existed across these 3 handlers. Each schema narrows
// req.body to a real TypeScript type via z.infer, so downstream code
// gets type-safe destructuring without unsafe casts.
//
// Incremental migration: only /login, /signup, and /recover are covered
// here. Business validation (isEmail / isPasswordValid / etc.) still
// runs after the schema parse; Zod handles shape only. Status codes and
// error-code strings remain unchanged.
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

// BE-ZOD-MIGRATION-EXTENSION: schemas for /resend-verification,
// /reset-request, /reset. Same flat-error pattern as the 3 round-1
// schemas — shape only, business validation (isEmail, isPasswordValid)
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
const SESSION_EXPIRY = '24h';
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const SIGNUP_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const MAX_LOGIN_FAILURES = 20;

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
// Concurrency / libuv note: argon2.verify runs on the libuv thread pool
// (default UV_THREADPOOL_SIZE=4). argon2's `parallelism=4` option means each
// verify effectively holds 4 libuv threads for its duration. At
// UV_THREADPOOL_SIZE=16, that allows ~4 concurrent argon2 ops (16 / 4 = 4),
// NOT 16 — the common confusion that made the initial cap insufficient. The
// JS-level semaphore at lib/argon2-semaphore.ts is the deterministic cap
// (`runWithArgon2Slot` caps concurrent ops at MAX_CONCURRENT_ARGON2_OPS,
// derived from the same `pool / parallelism` math). The env knob above is
// libuv headroom so the semaphore can fill its slots without queueing at
// the pool layer. Every argon2.hash / argon2.verify on auth paths (incl.
// burnSentinel's internal verify) goes through runWithArgon2Slot; the sole
// exception is the module-load SENTINEL_ARGON2_HASH_PROMISE below, which
// runs exactly once and cannot saturate anything. Queue depth is exposed
// via /api/health (`argon2_queue_depth`) so operators see saturation events
// synchronously, independent of pino async-transport drainage under OOM.
//
// Fail-loud guard: if UV_THREADPOOL_SIZE is unset or below 16 in the
// environment, reject at module-load rather than serving traffic with a
// hidden saturation oracle. The semaphore (when landed) will relax this
// to advisory; until then it's a hard invariant for burnSentinel
// determinism. Silenced when running under Vitest (VITEST=true is set
// by the runner itself) so unit tests don't need the env knob. Production
// startup MUST set UV_THREADPOOL_SIZE; the Dockerfile and docker-compose
// environment both carry it.
if (!process.env.VITEST) {
  const pool = Number(process.env.UV_THREADPOOL_SIZE);
  if (!Number.isFinite(pool) || pool < 16) {
    throw new Error(
      `UV_THREADPOOL_SIZE must be >= 16 for burnSentinel determinism (got ${process.env.UV_THREADPOOL_SIZE ?? 'unset'}); the JS-level semaphore (backend-argon2-jslevel-concurrency-cap) is the real cap, this env value is libuv headroom.`,
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
  logger.error({ err }, 'SENTINEL_ARGON2_HASH_PROMISE rejected at startup — timing-equalization oracle would be silently open; exiting');
  // Drain the pino transport worker before exit; in dev the transport runs in
  // a worker thread and a bare process.exit() can lose the final log line.
  // pino's thread-stream.flush(cb) uses timeout=Infinity, so a deadlocked
  // worker (same OOM conditions that killed argon2 at startup) would hang the
  // flush callback forever, leaving the process alive with a permanently-
  // rejected sentinel and a silently-open timing oracle that no supervisor
  // can restart. Guard with a 2s timeout fallback so the supervisor always
  // gets a clean exit.
  const t = setTimeout(() => process.exit(1), 2000);
  t.unref();
  if (typeof logger.flush === 'function') {
    logger.flush(() => {
      clearTimeout(t);
      process.exit(1);
    });
  } else {
    // no flush callback pending; exit directly
    process.exit(1);
  }
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
// Timing tests assert ≥35ms (floor) rather than ≥50ms because argon2.verify at
// our ARGON2_OPTIONS (64 MiB, time=3) runs 42-55ms median on reference hardware
// but can drop to the high-20s on faster CI hosts. 35ms still kills the
// sentinel-removal mutation (35× margin above the pre-sentinel ~1ms path).
// The 35ms floor is named TIMING_ORACLE_FLOOR_MS in recover.test.ts.
export async function burnSentinel(input: string): Promise<void> {
  try {
    const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
    // Clip attacker-controlled oversize input before handing it to argon2:
    // argon2.verify rejects >4096-byte inputs early, which would turn the
    // burn into a noop and reopen the oracle. 1024 bytes is well under the
    // limit and matches the compute cost of any realistic password.
    const safeInput = input.length > 1024 ? input.slice(0, 1024) : input;
    await runWithArgon2Slot(() => argon2.verify(sentinelHash, safeInput));
  } catch (err) {
    // ArgonQueueFullError MUST propagate so route handlers can translate it
    // into 503. Swallowing here would return ~0ms from burnSentinel under
    // queue-full conditions and reopen the timing oracle under DoS load —
    // the opposite of what the JS-level semaphore is for.
    if (err instanceof ArgonQueueFullError) throw err;
    logger.warn({ err }, 'argon2 sentinel burn failed — timing oracle may be open');
  }
}

// Shared catch-block handler: translate ArgonQueueFullError → 503 before
// the generic 500 branch. Factored out so every auth route that touches
// argon2 (directly via runWithArgon2Slot or transitively via burnSentinel)
// handles queue saturation consistently. Returns true if it handled the
// error, false otherwise (caller falls through to its own 500 branch).
function handleArgonQueueFull(res: Response, err: unknown): boolean {
  if (err instanceof ArgonQueueFullError) {
    sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Authentication service temporarily overloaded. Please retry.');
    return true;
  }
  return false;
}

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
    if (!institution || institution.length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Institution is required');
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
    // Check-order note (BE-SIGNUP-INSTITUTIONAL-GATE-ORDERING): this
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
          if (password) await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS)).catch((err) => {
            logger.warn({ err }, 'argon2 signup-dup burn failed — timing oracle may be open');
          });
          return sendError(res, 409, 'DUPLICATE', 'Email already registered');
        }
        if (existingRows[0].verify_token.startsWith('confirmed:')) {
          if (password) await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS)).catch((err) => {
            logger.warn({ err }, 'argon2 signup-dup burn failed — timing oracle may be open');
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
      ? await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS))
      : null;

    const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_EXPIRY_MS);

    // ORCID signups skip email verification — go directly to confirmed state
    if (verifiedOrcid) {
      const confirmed = `confirmed:${crypto.randomBytes(32).toString('hex')}`;

      if (normalizedEmail) {
        // ORCID + email: upsert with ON CONFLICT
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
          [normalizedEmail, passwordHash, resolvedName, resolvedInstitution, resolvedField, verifiedOrcid, confirmed, expiresAt],
        );
      } else {
        // ORCID-only (no email): plain insert
        await pool.query(
          `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [null, null, resolvedName, resolvedInstitution, resolvedField, verifiedOrcid, confirmed, expiresAt],
        );
      }

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
        const transporter = nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpPort === 465,
          auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
        });

        const verifyUrl = `${config.appUrl}/signup/verify?token=${verifyToken}`;
        await transporter.sendMail({
          from: config.smtpFrom,
          to: normalizedEmail!,
          subject: 'PEvO - Verify your email',
          text: `Welcome to PEvO!\n\nPlease verify your email to complete your registration:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you did not sign up for PEvO, you can safely ignore this email.\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
        });
      } catch (mailErr) {
        logger.error({ err: (mailErr as Error).message }, 'Failed to send verification email');
        // Delete the account row since we couldn't send the email
        await pool.query('DELETE FROM accounts WHERE verify_token = $1', [verifyToken]);
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send verification email');
      }
    } else {
      logger.error(
        { email_hash: normalizedEmail ? hashEmailForLogs(normalizedEmail) : null },
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
    if (handleArgonQueueFull(res, err)) return;
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
      await burnSentinel(password);
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
      passwordValid = await runWithArgon2Slot(() => argon2.verify(account.password_hash!, password));
    } else {
      await burnSentinel(password);
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

    // SMTP-failure status-code oracle (BE-AUTH-SMTP-STATUS-CODE-ORACLE):
    // this known-email branch MUST NOT return 500 when sendMail throws. If it
    // did, an attacker inducing an SMTP outage would observe 500 = "pending
    // signup exists for this email + matches this password" vs 200 = any other
    // shape (unknown email, wrong password, already-active, already-confirmed)
    // — a status-code oracle that bypasses the wall-time equalization work.
    // See `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`.
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
      } catch (err) {
        logger.warn({ err, route: 'auth.resend-verification', emailKnown: 'known' }, 'SMTP send failed');
        // Fall through to uniform 200 below.
      }
    }

    sendOk(res, { message: 'If that email has a pending signup, a new verification link has been sent.' });
  } catch (err) {
    if (handleArgonQueueFull(res, err)) return;
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
      // Unknown-account path: burn sentinel to match the known-account
      // wrong-password wall-time below. Closes the username/email-enumeration
      // oracle for unauthenticated attackers. Status-code stays 401 (matches
      // wrong-password); only timing is closed.
      await burnSentinel(password);
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
      await burnSentinel(password);
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
    const valid = await runWithArgon2Slot(() => argon2.verify(account.password_hash, password));
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
    if (handleArgonQueueFull(res, err)) return;
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
    // oracle on the known-email path is a separate concern (tracked as
    // `backend-resend-verification-smtp-timing.md`); this closes the
    // cheap-early-return half only.
    if (rows.length === 0) {
      await burnSentinel(normalizedEmail);
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

    // Send reset email.
    //
    // SMTP-failure status-code oracle (BE-AUTH-SMTP-STATUS-CODE-ORACLE): the
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
      } catch (err) {
        logger.warn({ err, route: 'auth.reset-request', emailKnown: 'known' }, 'SMTP send failed');
        // Fall through to uniform 200. Do NOT clear the reset token: a
        // legitimate user whose send failed transiently may retry and get a
        // working email on the SMTP relay's next attempt window.
      }
    } else {
      logger.warn({ route: 'auth.reset-request', emailKnown: 'known' }, 'SMTP not configured — reset email not sent');
    }

    sendOk(res, { message: 'If an account exists with that email, a reset link has been sent.' });
  } catch (err) {
    if (handleArgonQueueFull(res, err)) return;
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
    const passwordHash = await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS));

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
    if (handleArgonQueueFull(res, err)) return;
    logger.error({ err }, 'Password reset failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Password reset failed');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/recover — Account recovery (seed phrase or ORCID)
// ─────────────────────────────────────────────────────────────
const recoverLimiter = rateLimit({ name: 'auth-recover', windowMs: 3_600_000, max: 10, keyFn: byIp });

router.post('/recover', recoverLimiter, async (req: Request, res: Response) => {
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
      memo_key_enc: Buffer | null;
      iv_memo: Buffer | null;
      orcid: string | null;
      custody: string | null;
      upgraded_at: string | null;
    }>(
      `SELECT id, username, memo_key_enc, iv_memo, orcid, custody, upgraded_at
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
        await burnSentinel(new_password!);
      }
      return sendError(res, 404, 'NOT_FOUND', 'Account not found');
    }

    const account = rows[0];

    // ── Method A: Seed-phrase recovery via memo key comparison ──
    if (memo_key) {
      if (!account.memo_key_enc || !account.iv_memo) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Account does not support seed phrase recovery');
      }

      let storedMemoKey: string;
      try {
        storedMemoKey = decryptKey(account.username, account.memo_key_enc, account.iv_memo);
      } catch (err) {
        logger.error({ err, username: account.username }, 'Failed to decrypt memo key during recovery');
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
    }
    // ── Method B: ORCID recovery ──
    else if (orcid_token) {
      if (!account.orcid) {
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
    }

    // Check new email isn't taken by another active account
    const { rows: emailRows } = await pool.query<{ id: number }>(
      'SELECT id FROM accounts WHERE email = $1 AND id != $2',
      [normalizedEmail, account.id],
    );
    if (emailRows.length > 0) {
      return sendError(res, 409, 'DUPLICATE', 'Email already in use');
    }

    // Hash new password if provided; otherwise null (ORCID recovery without
    // password re-establishes the account but leaves password-login disabled
    // until the user opts in via /api/settings/set-password).
    const passwordHash = passwordProvided
      ? await runWithArgon2Slot(() => argon2.hash(new_password!, ARGON2_OPTIONS))
      : null;

    // Update account: new password (or null), new email, invalidate all sessions
    await pool.query(
      `UPDATE accounts
       SET password_hash = $1,
           email = $2,
           sessions_invalidated_at = NOW()
       WHERE id = $3`,
      [passwordHash, normalizedEmail, account.id],
    );

    // Audit log
    pool.query(
      'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
      [account.username, 'account_recovery'],
    ).catch(() => {});

    // Issue new JWT
    const custody = account.upgraded_at ? 'self' : (account.custody || 'light');
    const token = jwt.sign(
      { sub: account.username, custody },
      config.sessionSecret,
      { expiresIn: SESSION_EXPIRY },
    );
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();

    sendOk(res, { token, expires_at: expiresAt, custody, username: account.username });
  } catch (err) {
    if (handleArgonQueueFull(res, err)) return;
    logger.error({ err }, 'Account recovery failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Account recovery failed');
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
