import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { createSmtpTransporter } from '../lib/smtp.js';
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
import { hashEmailForLogs, hashTokenForLogs } from '../lib/log-pii.js';
import { INCR_AND_EXPIRE_ON_ZERO_TO_ONE_LUA } from '../lib/redis-scripts.js';
import { enqueueDecrement } from '../lib/pending-decrement-queue.js';
import { seedAccreditationBonus } from '../reputation.js';

/** How long a verification token stays valid before it expires. */
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

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
 * post-increment count. Caller treats
 * `count > config.verifyBroadcastAttemptsCap` as "cap exceeded — surface
 * limit-exceeded envelope" (round-3 hold #2 chose soft-block: token is NOT
 * destroyed on the cap-exceeded path; counter and token both TTL out
 * within 24h).
 *
 * INCR + conditional EXPIRE run as a single Lua call (round-2 hold #6) so a
 * crash or connection drop between the two operations cannot leave a TTL-
 * less counter stranded past the token's 24h life. EXPIRE fires on every
 * transition-to-1 (count==0 → count==1), not only on the very first write
 * (round-3 hold #7). After a pre-INCR + DECR-on-timeout cycle the counter
 * persists at 0 and a subsequent INCR re-primes EXPIRE; safety is preserved
 * because the TTL anchor `pending.expires_at` monotonically shrinks across
 * cycles, so the counter cannot outlive the token. Re-priming TTL on
 * EVERY INCR (irrespective of count) would let an attacker indefinitely
 * extend the counter past the token's natural expiration.
 */
async function incrementBroadcastAttempts(pending: PendingAccreditation): Promise<number> {
  const redis = getRedis();
  if (redis) {
    if (isRedisAvailable()) {
      const key = broadcastAttemptsKey(pending.token);
      const ttl = Math.max(1, Math.ceil((pending.expires_at.getTime() - Date.now()) / 1000));
      const result = await redis.eval(
        INCR_AND_EXPIRE_ON_ZERO_TO_ONE_LUA,
        1,
        key,
        String(ttl),
      );
      return Number(result);
    }
    // Reliability-R2 (round-4 hold): symmetric to the decrement-side
    // `accred_verify_broadcast_decrement_redis_unavailable` warn — when
    // Redis is configured but unavailable at INCR time, cap enforcement
    // silently falls through to the in-memory map (which has no record of
    // any prior Redis-side counter for this token across instances). Emit
    // a structured warn so operators have a signal that cap enforcement
    // has degraded to the in-memory fallback. Without this, an operator
    // sees the decrement-unavailable warn but no corresponding increment
    // warn during the same flap window, and cannot tell whether cap
    // enforcement was active or in-memory-fallback at INCR time.
    logger.warn(
      {
        token_hash: hashTokenForLogs(pending.token),
        event: 'accred_verify_broadcast_increment_redis_unavailable',
      },
      'accreditation.verify counter increment: Redis unavailable mid-request — cap enforcement degraded to in-memory fallback',
    );
  }
  const next = (memoryBroadcastAttempts.get(pending.token) ?? 0) + 1;
  memoryBroadcastAttempts.set(pending.token, next);
  return next;
}

/**
 * Compensating decrement when a pre-incremented broadcast attempt resolved
 * to a 504 BROADCAST_TIMEOUT outcome (round-2 hold #2). The cap is intended
 * to bound retries on definitive chain rejections — punishing transient
 * slow-Hive timeouts would force the legitimate user to re-request a fresh
 * accreditation email after 3 unlucky attempts, which itself has a 3/24h
 * per-account limit (24h lockout on a flaky Hive day).
 *
 * Pre-INCR is necessary for the atomic concurrent-claim guarantee (4
 * parallel /verify calls on the same token must enqueue exactly
 * `cap` broadcasts, not 4); decrement-after-timeout is the simplest shape
 * that preserves both that guarantee and the verify-then-retry UX.
 *
 * `DECR` on a missing key resolves to -1; the floor at 0 keeps the counter
 * from going negative if a parallel deleteBroadcastAttempts (success path)
 * raced ahead of this decrement.
 */
async function decrementBroadcastAttempts(token: string, attemptId?: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    const key = broadcastAttemptsKey(token);
    if (isRedisAvailable()) {
      try {
        const after = await redis.decr(key);
        if (after < 0) {
          // Counter was already gone (token deletion raced with the decrement);
          // either re-priming via SET 0 or DEL is fine. DEL keeps the namespace
          // clean and matches the "counter scoped to the token's life" invariant.
          await redis.del(key);
        }
        return;
      } catch (decrErr) {
        // BE-VERIFY-CAP-REDIS-FLAP-RECOVERY: the immediate DECR threw (Redis
        // flap mid-request, OOM, evicted-to-read-only). Enqueue for retry by
        // the periodic drain cycle so the counter eventually returns to its
        // pre-INCR value, then re-throw. Re-throwing preserves the existing
        // outer-catch `accred_verify_broadcast_decrement_failed` warn (the
        // route's per-request signal) — the queue handles recovery, the
        // outer-catch warn handles operator correlation.
        if (attemptId) {
          enqueueDecrement({ token, attemptId, key });
        }
        throw decrErr;
      }
    }
    // Round-3 hold #10: if Redis was reachable at INCR time but is unavailable
    // now (mid-request flap), the in-memory map has no record of the Redis-side
    // counter and a silent fallback would leave the Redis-side counter inflated
    // until 24h TTL with no operator signal. Emit a structured warn here so
    // operators can correlate counter drift with Redis incidents; the sibling
    // `accred_verify_broadcast_decrement_failed` event covers the
    // throw-during-DECR case but not this silent-noop case.
    //
    // BE-VERIFY-CAP-REDIS-FLAP-RECOVERY: also enqueue for the periodic drain
    // cycle so the counter is decremented when Redis recovers, instead of
    // sitting inflated until the 24h Redis TTL.
    if (attemptId) {
      enqueueDecrement({ token, attemptId, key });
    }
    logger.warn(
      {
        token_hash: hashTokenForLogs(token),
        event: 'accred_verify_broadcast_decrement_redis_unavailable',
      },
      'accreditation.verify counter decrement: Redis unavailable mid-request — counter may persist inflated until 24h TTL',
    );
    return;
  }
  // No Redis configured at all → in-memory fallback path.
  const current = memoryBroadcastAttempts.get(token);
  if (current === undefined) return;
  if (current <= 1) {
    memoryBroadcastAttempts.delete(token);
  } else {
    memoryBroadcastAttempts.set(token, current - 1);
  }
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
      const transporter = createSmtpTransporter();

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

  // BE-VERIFY-CAP-REDIS-FLAP-RECOVERY: per-request attempt identifier used by
  // the in-process pending-decrement queue. Generated once per /verify call so
  // a duplicate enqueue (e.g. retry within the same request lifetime) is
  // idempotent — the queue is keyed on attemptId.
  const attemptId = crypto.randomBytes(8).toString('hex');

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
  // custom_json ops). Pre-broadcast INCR atomically claims the next slot,
  // so the cap holds even under concurrent retries on the same token.
  //
  // Round-3 hold #8 — structural scope: the cap is a CONCURRENCY-BURST
  // defense, not a sequential-flood defense. Because deleteToken (see
  // `deleteToken` below) drops both the pending row AND the counter
  // side-key, and the catch-block 'failure' branch calls deleteToken on
  // the first 502, the sequential-retry case ends after one definitive
  // failure and cannot accumulate the counter. The cap engages on the parallel-retry
  // case — N concurrent /verify calls on the same token claim slots
  // atomically and at most `cap` broadcasts fire.
  //
  // Timeout outcomes decrement the counter on the catch path
  // (decrementBroadcastAttempts) so transient slow-Hive windows do not
  // permanently consume slots — only definitive 502 BROADCAST_FAILED
  // outcomes count toward the cap (round-2 hold #2).
  //
  // Round-3 hold #11: the pre-INCR call sits OUTSIDE the broadcast try
  // below, so a `redis.eval` rejection (OOM, Lua error, connection drop)
  // would propagate to Express 5's async handler → 500 INTERNAL_ERROR
  // with no retry guidance, asymmetric to the broadcast site's 502/504
  // envelope discipline. Wrap the call in a local try/catch returning
  // 503 SERVICE_UNAVAILABLE with `{ retriable: true }` per the existing
  // 503 pattern in this file's siblings (auth.ts, bridge.ts).
  //
  // Round-3 hold #2: chose soft-block (sub-option ii). On cap-exceeded,
  // surface the limit envelope but DO NOT call deleteToken — destroying
  // the token here gives a stolen-token attacker with cap+1 rotating
  // XFFs an asymmetric token-burn DoS (cheap rotating IPs vs the
  // legitimate user's 24h re-`/request` lockout under the 3/24h byAccount
  // limit). Soft-block leaves the token alive: the legitimate retry will
  // re-hit the cap until the counter TTLs out (~24h from the first INCR),
  // but the user retains the option to wait it out instead of burning a
  // fresh `/request` slot, and the Redis 24h TTL converges both keys
  // independently. Sub-options (i) accept-and-document and
  // (iii) require verifyHiveSignature were considered; (i) accepts a
  // capability-loss DoS that's cheap to mount, and (iii) imposes a UX
  // penalty on light-account users who lack ready Hive Keychain access
  // on the verify-link landing page.
  const cap = config.verifyBroadcastAttemptsCap;
  let attempts: number;
  try {
    attempts = await incrementBroadcastAttempts(pending);
  } catch (incrErr) {
    logger.warn(
      {
        err: incrErr instanceof Error ? incrErr : new Error(String(incrErr)),
        username: pending.hive_username,
        email_hash: hashEmailForLogs(pending.email),
        event: 'accred_verify_broadcast_increment_failed',
      },
      'accreditation.verify pre-INCR cap counter failed — surfacing 503 SERVICE_UNAVAILABLE',
    );
    return sendError(
      res,
      503,
      'SERVICE_UNAVAILABLE',
      'Verification temporarily unavailable. Please retry shortly.',
      { retriable: true },
    );
  }
  if (attempts > cap) {
    // Round-2 hold #5: structured `event:` discriminator so operators can
    // dashboard/alert on cap-exceeded without message-substring grep,
    // matching the sibling event anchors in routes/orcid.ts and
    // lib/broadcast-error.ts (`binding_lock_extend_*`, `lock_contention_held`,
    // `post_broadcast_msg_fn_threw`, `post_broadcast_write_failed`).
    logger.warn(
      {
        event: 'accred_verify_broadcast_cap_exceeded',
        username: pending.hive_username,
        email_hash: hashEmailForLogs(pending.email),
        token_hash: hashTokenForLogs(token),
        attempts,
        cap,
      },
      'accreditation.verify broadcast attempt cap exceeded; soft-blocking (token preserved per round-3 hold #2)',
    );
    // Round-3 hold #2 (soft-block): do NOT deleteToken on the cap-exceeded
    // path. Counter and token both TTL out within 24h independently, so the
    // legitimate user can wait for the burst to drain rather than being
    // forced into the 3/24h /request lockout window.
    //
    // Round-2 hold #1: distinct error code BROADCAST_ATTEMPT_LIMIT_EXCEEDED
    // (NOT BROADCAST_FAILED). The broadcast was never invoked when the cap
    // fires, so reusing BROADCAST_FAILED conflated client retry-pressure
    // with chain rejection — operators alerting on BROADCAST_FAILED rate
    // could not separate the two. The architect adds the corresponding row
    // to agents/docs/api-contracts/accreditation.md at archive time.
    return sendError(
      res,
      502,
      'BROADCAST_ATTEMPT_LIMIT_EXCEEDED',
      'Broadcast attempt limit exceeded. Please wait or request a fresh accreditation email.',
      { retriable: false },
    );
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
    // verifying chain state (the broadcast outcome is uncertain). Round-2
    // hold #2: also decrement the broadcast-attempt counter so a transient
    // slow-Hive window does not consume cap slots. Only definitive 502
    // BROADCAST_FAILED outcomes count toward the cap. The pre-INCR claim
    // remains necessary for atomic concurrency (4 parallel /verify calls
    // must enqueue at most `cap` broadcasts), so the shape is
    // pre-INCR-then-decrement-on-timeout rather than post-INCR-on-failure.
    //
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
    if (outcome === 'timeout') {
      try {
        await decrementBroadcastAttempts(token, attemptId);
      } catch (decrErr) {
        // Compensation failure is not user-visible (the 504 has already been
        // sent and the counter will TTL out with the token). Log so operators
        // can correlate counter drift with Redis incidents. Round-3 hold #1:
        // emit `token_hash` (12-hex sha256 prefix) instead of the raw 64-hex
        // token. The token is the SOLE credential at /api/accreditation/verify
        // (no Hive sig, no other auth) so logging the plaintext for 24h would
        // give anyone with operator-log read access the ability to replay the
        // verification and enqueue an `accredit` op signed by the admin key.
        logger.warn(
          { err: decrErr, token_hash: hashTokenForLogs(token), username: pending.hive_username, event: 'accred_verify_broadcast_decrement_failed' },
          'accreditation.verify counter decrement after timeout failed — counter may TTL out at token expiration',
        );
      }
    } else if (outcome === 'failure') {
      try {
        await deleteToken(token);
      } catch (deleteErr) {
        // Include `token_hash` (12-hex sha256 prefix) in the structured fields
        // so operators can correlate the orphan against Redis state during the
        // 24h TTL window. Round-3 hold #1: hashed, NOT plaintext (see
        // sibling timeout branch above for the plaintext-leak threat model).
        // Per agents/docs/solutions/runtime-errors/helper-extraction-express5-response-ordering-2026-04-28.md
        // ("Survivor log fields for orphan resources").
        logger.error(
          { err: deleteErr, token_hash: hashTokenForLogs(token), username: pending.hive_username },
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

// Test-only seam (round-3 hold #13, round-4 hold #3): tests need to drive
// `decrementBroadcastAttempts` and `incrementBroadcastAttempts` directly:
//   - decrement: assert the `if (after < 0) DEL` race-recovery branch
//     (mutation-kill: removing the DEL leaves the counter at -1) and the
//     Redis-unavailable warn (round-3 hold #10).
//   - increment: assert the symmetric Redis-unavailable warn
//     (round-4 hold #3c / Reliability-R2). Routing the route flow has
//     `getToken()` short-circuit on `!isRedisAvailable()` before the
//     pre-INCR site, so a unit-style call against the helper is the only
//     way to drive the in-memory-fallback warn path deterministically.
// Routing through `__test_seams` gives the specs a stable name to call
// without making the helpers route-public symbols. NOT for production import.
export const __test_seams = {
  decrementBroadcastAttempts,
  incrementBroadcastAttempts,
} as const;
