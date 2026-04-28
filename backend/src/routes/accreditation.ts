import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { PrivateKey } from '@hiveio/dhive';
import { config } from '../config.js';
import { broadcastJsonWithTimeout } from '../hive.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate, accreditationRequestSchema, accreditationVerifySchema } from '../validation.js';
import { rateLimit, byAccount, byIp } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';
import { isInstitutionalEmail } from '../email-validator.js';
import { hashEmailForLogs } from '../lib/log-pii.js';
import { seedAccreditationBonus } from '../reputation.js';

/** How long a verification token stays valid before it expires. */
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Per-token broadcast-attempt cap. Bounds the broadcast-retry amplification
 * window opened by the 504 BROADCAST_TIMEOUT envelope at /api/accreditation/verify
 * (see BE-VERIFY-BROADCAST-ATTEMPTS-CAP). Each call to /verify that reaches
 * the broadcast site increments a per-token counter; once the counter exceeds
 * this cap, the token is destroyed and the caller is forced to request a
 * fresh token via /api/accreditation/request.
 */
const MAX_BROADCAST_ATTEMPTS = 3;

const accreditationRequestLimiter = rateLimit({ name: 'accred-req', windowMs: 24 * 60 * 60_000, max: 3, keyFn: byAccount });
const accreditationVerifyLimiter = rateLimit({ name: 'accred-verify', windowMs: 60_000, max: 5, keyFn: byIp });

const router = Router();

// ──────────────────────────────────────────────
// Token store: app database with in-memory fallback
// ──────────────────────────────────────────────

interface PendingAccreditation {
  hive_username: string;
  full_name: string;
  institution: string;
  field: string;
  email: string;
  orcid: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

// In-memory fallback when APP_DATABASE_URL is not configured
const memoryTokens = new Map<string, PendingAccreditation>();
// Per-token broadcast-attempt counters for the in-memory (no-Redis) path.
// On the Redis path, counts live under
// `${config.appTag}:pending_accred_broadcast_attempts:${token}` and are
// incremented atomically with INCR.
const memoryBroadcastAttempts = new Map<string, number>();

function broadcastAttemptsKey(token: string): string {
  return `${config.appTag}:pending_accred_broadcast_attempts:${token}`;
}

/**
 * Atomically claim the next broadcast-attempt slot for `token`. Returns the
 * post-increment count. Caller treats `count > MAX_BROADCAST_ATTEMPTS` as
 * "cap exceeded — destroy token, surface limit-exceeded envelope".
 *
 * The TTL on the Redis key is anchored to `pending.expires_at` so the counter
 * never outlives the token it gates. Setting TTL only on the first INCR keeps
 * the counter from being silently extended by every retry (which would let an
 * attacker keep a token alive past 24h via spam).
 */
async function incrementBroadcastAttempts(pending: PendingAccreditation): Promise<number> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    const key = broadcastAttemptsKey(pending.token);
    const count = await redis.incr(key);
    if (count === 1) {
      const ttl = Math.max(1, Math.ceil((pending.expires_at.getTime() - Date.now()) / 1000));
      await redis.expire(key, ttl);
    }
    return count;
  }
  const next = (memoryBroadcastAttempts.get(pending.token) ?? 0) + 1;
  memoryBroadcastAttempts.set(pending.token, next);
  return next;
}

async function deleteBroadcastAttempts(token: string): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.del(broadcastAttemptsKey(token));
  }
  memoryBroadcastAttempts.delete(token);
}

async function storeToken(pending: PendingAccreditation): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    const ttl = Math.max(1, Math.ceil((pending.expires_at.getTime() - Date.now()) / 1000));
    await redis.set(`${config.appTag}:pending_accred:${pending.token}`, JSON.stringify(pending), 'EX', ttl);
  }
  memoryTokens.set(pending.token, pending);
}

async function getToken(token: string): Promise<PendingAccreditation | null> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    const raw = await redis.get(`${config.appTag}:pending_accred:${token}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...parsed, expires_at: new Date(parsed.expires_at), created_at: new Date(parsed.created_at) };
    }
  }
  const pending = memoryTokens.get(token);
  if (!pending) return null;
  if (new Date() > pending.expires_at) {
    memoryTokens.delete(token);
    return null;
  }
  return pending;
}

async function deleteToken(token: string): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.del(`${config.appTag}:pending_accred:${token}`);
  }
  memoryTokens.delete(token);
  // Counter is scoped to the token's life — a fresh token always starts
  // from zero, so we drop the side-key whenever the token itself is dropped.
  await deleteBroadcastAttempts(token);
}

async function cleanupExpiredTokens(): Promise<void> {
  // Redis handles TTL automatically; just clean in-memory map
  const now = new Date();
  for (const [t, p] of memoryTokens) {
    if (now > p.expires_at) memoryTokens.delete(t);
  }
}

function maskEmail(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '***@***';
  const [local, domain] = parts;
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : domain;
  const maskedLocal = local.length <= 2 ? `${local[0]}***` : `${local[0]}***`;
  return `${maskedLocal}@***${tld}`;
}


// ──────────────────────────────────────────────
// POST /api/accreditation/request
// ──────────────────────────────────────────────

router.post('/request', verifyHiveSignature, accreditationRequestLimiter, validate(accreditationRequestSchema), async (req: Request, res: Response) => {
  const hive_username = req.hiveUsername!;
  const { full_name, institution, field, email, orcid } = req.body;

  if (!isInstitutionalEmail(email)) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Only institutional email addresses are accepted');
  }

  // Generate verification token
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

  const pending: PendingAccreditation = {
    hive_username,
    full_name,
    institution,
    field,
    email,
    orcid: orcid || '',
    token,
    expires_at: expiresAt,
    created_at: new Date(),
  };
  await storeToken(pending);

  // Send verification email
  if (config.smtpHost) {
    try {
      const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
      });

      const verifyUrl = `${config.appUrl}/accreditation/verify?token=${token}`;
      await transporter.sendMail({
        from: config.smtpFrom,
        to: email,
        subject: 'PEvO - Verify your accreditation',
        text: `Hello ${full_name},\n\nPlease verify your email to complete your PEvO accreditation:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
      });
    } catch (mailErr) {
      logger.error({ err: (mailErr as Error).message }, 'Failed to send verification email');
      await deleteToken(token);
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send verification email');
    }
  } else {
    logger.error({ hive_username }, 'SMTP not configured — cannot send verification email');
    await deleteToken(token);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Email service not configured');
  }

  sendOk(res, {
    message: `Verification email sent to ${maskEmail(email)}`,
    expires_at: expiresAt.toISOString(),
  });
});

// ──────────────────────────────────────────────
// POST /api/accreditation/verify
// ──────────────────────────────────────────────

router.post('/verify', accreditationVerifyLimiter, validate(accreditationVerifySchema), async (req: Request, res: Response) => {
  const { token } = req.body;

  const pending = await getToken(token);
  if (!pending) {
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired token');
  }

  // Broadcast accreditation custom_json to Hive
  if (!config.pevoAdminPostingKey) {
    await deleteToken(token);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
  }

  // Per-token broadcast-attempt cap (BE-VERIFY-BROADCAST-ATTEMPTS-CAP).
  // The 504 BROADCAST_TIMEOUT envelope deliberately preserves the token so
  // the legitimate caller can verify chain state and retry; that survival
  // window is also a retry-amplification axis (each retry enqueues a fresh
  // broadcast at the dhive layer, and Hive does not deduplicate identical
  // custom_json ops). INCR atomically claims the next slot before broadcasting,
  // so the cap holds even under concurrent retries on the same token.
  const attempts = await incrementBroadcastAttempts(pending);
  if (attempts > MAX_BROADCAST_ATTEMPTS) {
    logger.warn(
      {
        username: pending.hive_username,
        email_hash: hashEmailForLogs(pending.email),
        attempts,
        cap: MAX_BROADCAST_ATTEMPTS,
      },
      'accreditation.verify broadcast attempt cap exceeded; destroying token',
    );
    await deleteToken(token);
    return sendError(res, 502, 'BROADCAST_FAILED', 'Broadcast attempt limit exceeded. Request a fresh accreditation email.', { retriable: false });
  }

  const evidenceHash = crypto
    .createHash('sha256')
    .update(`${pending.email}:${pending.hive_username}:${pending.token}`)
    .digest('hex');

  const customJsonPayload = {
    action: 'accredit',
    account: pending.hive_username,
    name: pending.full_name,
    institution: pending.institution,
    field: pending.field,
    method: 'email',
    evidence_hash: evidenceHash,
    timestamp: new Date().toISOString(),
  };

  try {
    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    const result = await broadcastJsonWithTimeout(
      { id: config.appTag, json: JSON.stringify(customJsonPayload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );

    await deleteToken(token);
    await seedAccreditationBonus(pending.hive_username);

    sendOk(res, {
      message: 'Accreditation confirmed',
      username: pending.hive_username,
      tx_id: result.id,
    });
  } catch (err) {
    const outcome = handleBroadcastError(res, err, {
      timeoutMsg: 'Broadcasting accreditation timed out',
      failMsg: 'Failed to broadcast accreditation to Hive',
      logContext: { username: pending.hive_username, email_hash: hashEmailForLogs(pending.email) },
      routeLabel: 'accreditation.verify',
    });
    // On timeout: do NOT deleteToken — the 504 is retriable-after-verify, so
    // the token must survive its 24h TTL so the caller can retry after
    // verifying chain state (the broadcast outcome is uncertain).
    // On failure: the chain rejected the broadcast (retriable=false per the
    // envelope). The accreditation attempt is terminal for this token — delete
    // it so it cannot be reused. A new token is obtained via
    // /api/accreditation/request.
    //
    // The cleanup is wrapped in a local try/catch because handleBroadcastError
    // has already written the 502 response. If deleteToken rejects (Redis
    // hiccup, connection drop, evicted-to-read-only), letting the rejection
    // propagate to Express 5's async error handler would attempt to write a
    // 500 over the already-sent 502 → ERR_HTTP_HEADERS_SENT. Swallow the
    // error: the token will TTL out within 24h, and an orphaned token is
    // harmless because the broadcast already failed terminally.
    if (outcome === 'failure') {
      try {
        await deleteToken(token);
      } catch (deleteErr) {
        // Include `token` in the structured fields so operators can correlate
        // the orphan against Redis state during the 24h TTL window. Per
        // agents/docs/solutions/runtime-errors/helper-extraction-express5-response-ordering-2026-04-28.md
        // ("Survivor log fields for orphan resources").
        logger.error(
          { err: deleteErr, token, username: pending.hive_username },
          'accreditation.verify token cleanup failed after broadcast failure — orphan will TTL out',
        );
      }
    }
  }
});

// Cleanup expired tokens periodically
setInterval(() => {
  cleanupExpiredTokens().catch((err) => {
    logger.error({ err }, 'Failed to cleanup expired accreditation tokens');
  });
}, 60 * 60 * 1000);

export default router;
