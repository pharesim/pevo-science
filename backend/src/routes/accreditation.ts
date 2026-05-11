import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { createSmtpTransporter } from '../lib/smtp.js';
import { PrivateKey } from '@hiveio/dhive';
import { config } from '../config.js';
import { broadcastJsonWithTimeout } from '../hive.js';
import { handleBroadcastError, PostBroadcastWriteError } from '../lib/broadcast-error.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate, accreditationRequestSchema, accreditationVerifySchema } from '../validation.js';
import { rateLimit, byAccount, byIp } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';
import { isInstitutionalEmail } from '../email-validator.js';
import { hashEmailForLogs, hashTokenForLogs, maskEmail } from '../lib/log-pii.js';
import { evalScript } from '../lib/redis-scripts.js';
import { enqueueDecrement } from '../lib/pending-decrement-queue.js';
import { seedAccreditationBonus } from '../reputation.js';
import { lookupAccreditationBroadcastIdempotency } from '../lib/idempotency.js';
import { getPool, isHafConfigured } from '../db.js';

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
      const result = await evalScript(
        redis,
        'INCR_AND_EXPIRE_ON_ZERO_TO_ONE',
        [key],
        [String(ttl)],
      );
      return Number(result);
    }
    // Symmetric to the decrement-side
    // `accred_verify_broadcast_decrement_redis_unavailable` warn: when
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
        event: 'accreditation.verify.broadcast_increment_redis_unavailable',
        route: 'accreditation.verify',
        token_hash: hashTokenForLogs(pending.token),
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
        event: 'accreditation.verify.broadcast_decrement_redis_unavailable',
        route: 'accreditation.verify',
        token_hash: hashTokenForLogs(token),
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

/**
 * Best-effort wrapper around `deleteToken` used by the success path and the
 * idempotency-hit path (round-2 F8). Both branches have already written or
 * are about to write a 200 envelope; a Redis hiccup on cleanup must NOT
 * propagate to Express's async-error handler (`ERR_HTTP_HEADERS_SENT` would
 * be the visible symptom — the existing `helper-extraction-express5-
 * response-ordering-2026-04-28.md` learning captures the prior fire).
 * Caller passes `event` + `msg` discriminators so operators can correlate
 * the orphan back to the specific branch that observed the failure; the
 * 24h token TTL is the backstop.
 */
async function deleteTokenBestEffort(
  token: string,
  username: string,
  email: string,
  event: string,
  msg: string,
): Promise<void> {
  try {
    await deleteToken(token);
  } catch (deleteErr) {
    logger.warn(
      {
        event,
        route: 'accreditation.verify',
        username,
        email_hash: hashEmailForLogs(email),
        token_hash: hashTokenForLogs(token),
        err: deleteErr instanceof Error ? deleteErr : new Error(String(deleteErr)),
      },
      msg,
    );
  }
}

async function cleanupExpiredTokens(): Promise<void> {
  // Redis handles TTL automatically; just clean in-memory map
  const now = new Date();
  for (const [t, p] of memoryTokens) {
    if (now > p.expires_at) memoryTokens.delete(t);
  }
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
      logger.error(
        {
          event: 'accreditation.request.smtp_send_failed',
          route: 'accreditation.request',
          username: hive_username,
          email_hash: hashEmailForLogs(email),
          err: mailErr,
        },
        'Failed to send verification email',
      );
      await deleteToken(token);
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send verification email');
    }
  } else {
    logger.error(
      {
        event: 'accreditation.request.smtp_not_configured',
        route: 'accreditation.request',
        username: hive_username,
        email_hash: hashEmailForLogs(email),
      },
      'SMTP not configured — cannot send verification email',
    );
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
  // failure and cannot accumulate the counter. The cap engages on the
  // parallel-retry case: N concurrent /verify calls on the same token
  // claim slots atomically and at most `cap` broadcasts fire.
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
        event: 'accreditation.verify.broadcast_increment_failed',
        route: 'accreditation.verify',
        username: pending.hive_username,
        email_hash: hashEmailForLogs(pending.email),
        err: incrErr instanceof Error ? incrErr : new Error(String(incrErr)),
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
        event: 'accreditation.verify.broadcast_cap_exceeded',
        route: 'accreditation.verify',
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

  // Idempotency key for Option A.4 dedup. Deterministic per (token, username)
  // pair so a retry — including a retry after a 504 BROADCAST_TIMEOUT, where
  // the token is preserved per round-2 hold #2 — computes the same value, and
  // the pre-broadcast HAF lookup short-circuits to 200 instead of broadcasting
  // a duplicate accredit op signed by the admin key. Distinct from
  // `evidence_hash` (which encodes the email; staying email-free here keeps
  // the on-chain field decoupled from PII so a future schema-stability
  // promise on the dedup field does not commit us to publishing email
  // hashes too).
  const idempotencyKey = crypto
    .createHash('sha256')
    .update(`${pending.token}:${pending.hive_username}`)
    .digest('hex');

  // Pre-broadcast HAF check. If a prior /verify already landed an accredit op
  // carrying this idempotency_key, return its tx_id without re-broadcasting.
  // Token cleanup follows the existing post-broadcast convention: the token
  // has done its job once the chain op exists, regardless of whether THIS
  // request emitted the broadcast.
  //
  // Round-2 F1: on the HAF-hit branch we ALSO decrement the broadcast-attempts
  // counter (so retries that hit idempotency don't permanently consume cap
  // slots; without this, after `cap` retries the user gets 502
  // BROADCAST_ATTEMPT_LIMIT_EXCEEDED on a confirmed-on-chain accreditation
  // plus 24h /request lockout) and run seedAccreditationBonus (so the bonus
  // seed fires on the hit branch too — original spec acceptance #2(b)
  // required this; without it, the bonus is missing until the next batch
  // cycle reconciles). Both wraps are best-effort: a Redis decrement
  // failure or a transient bonus-seed failure does NOT downgrade the 200
  // (the chain op is confirmed; cap drift and missed bonus reconcile via
  // batch cycles). A PERMANENT bonus-seed throw, however, surfaces as a
  // 502 POST_BROADCAST_OPERATOR_REQUIRED via F3's severity discrimination
  // (programmer-error class — operator-actionable, not auto-reconciled).
  const hafPool = isHafConfigured() ? getPool() : null;
  if (hafPool) {
    try {
      const existing = await lookupAccreditationBroadcastIdempotency(hafPool, idempotencyKey);
      if (existing) {
        logger.info(
          {
            event: 'accreditation.verify.idempotency_hit',
            route: 'accreditation.verify',
            username: pending.hive_username,
            email_hash: hashEmailForLogs(pending.email),
            tx_id: existing.tx_id,
          },
          'accreditation.verify idempotency hit — returning existing tx_id without re-broadcasting',
        );
        // F1 part 1: decrement the cap slot the pre-INCR claim grabbed. The
        // hit path consumes ZERO chain ops, so the slot must return to the
        // pool. Failure is best-effort: the counter TTLs out with the token
        // (24h) and the user has already been told the accreditation
        // succeeded; surfacing a 5xx after the in-flight 200 would mislead.
        try {
          await decrementBroadcastAttempts(token, attemptId);
        } catch (decrErr) {
          logger.warn(
            {
              event: 'accreditation.verify.idempotency_hit_decrement_failed',
              route: 'accreditation.verify',
              username: pending.hive_username,
              email_hash: hashEmailForLogs(pending.email),
              token_hash: hashTokenForLogs(token),
              err: decrErr instanceof Error ? decrErr : new Error(String(decrErr)),
            },
            'accreditation.verify idempotency-hit decrement failed — counter TTLs out with token',
          );
        }
        // F1 part 2: seed the accreditation bonus on the hit branch too.
        // Original spec acceptance #2(b) required this; absent the seed, the
        // user shows zero accreditation_bonus until the next batch cycle
        // reconciles. Permanent throws (TypeError/SyntaxError/RangeError
        // re-thrown by `seedAccreditationBonus`) surface as 502
        // POST_BROADCAST_OPERATOR_REQUIRED carrying the EXISTING (already-
        // landed) tx_id and `failed_step: 'reputation_seed'`. Transient
        // throws stay swallowed inside the cascade fn so this branch never
        // sees them. The branch handles the error envelope locally rather
        // than re-throwing because the success-path catch is scoped to the
        // broadcast call (further down) — re-throwing would propagate to
        // the Express async-error handler instead of producing the
        // discriminated envelope.
        try {
          await seedAccreditationBonus(pending.hive_username);
        } catch (seedErr) {
          await deleteTokenBestEffort(
            token,
            pending.hive_username,
            pending.email,
            'accreditation.verify.idempotency_hit_token_cleanup_failed',
            'accreditation.verify idempotency-hit token cleanup failed (post-seed-error) — orphan TTLs out',
          );
          handleBroadcastError(
            res,
            new PostBroadcastWriteError(existing.tx_id, seedErr, 'reputation_seed', 'permanent'),
            {
              timeoutMsg: 'Broadcasting accreditation timed out',
              failMsg: 'Failed to broadcast accreditation to Hive',
              logContext: { username: pending.hive_username, email_hash: hashEmailForLogs(pending.email) },
              routeLabel: 'accreditation.verify',
            },
          );
          return;
        }
        await deleteTokenBestEffort(
          token,
          pending.hive_username,
          pending.email,
          'accreditation.verify.idempotency_hit_token_cleanup_failed',
          'accreditation.verify idempotency-hit token cleanup failed — orphan TTLs out',
        );
        return sendOk(res, {
          message: 'Accreditation confirmed',
          username: pending.hive_username,
          tx_id: existing.tx_id,
          outcome: 'already_landed',
        });
      }
    } catch (lookupErr) {
      // F22: inlined from the prior `logIdempotencySkip` helper.
      logger.warn(
        {
          event: 'accreditation.verify.idempotency_lookup_failed',
          route: 'accreditation.verify',
          username: pending.hive_username,
          email_hash: hashEmailForLogs(pending.email),
          err: lookupErr instanceof Error ? lookupErr : new Error(String(lookupErr)),
        },
        'accreditation.verify idempotency HAF lookup failed — proceeding without dedup',
      );
    }
  } else {
    // F10: event renamed from `idempotency_haf_unavailable` to
    // `idempotency_haf_unconfigured` because `isHafConfigured()` tests
    // configuration presence, not live reachability. The prior name led
    // operators to mis-read this branch as an outage signal; the new name
    // makes the config-only semantics explicit. `_lookup_failed` (above)
    // remains the real-outage discriminator.
    logger.warn(
      {
        event: 'accreditation.verify.idempotency_haf_unconfigured',
        route: 'accreditation.verify',
        username: pending.hive_username,
        email_hash: hashEmailForLogs(pending.email),
      },
      'accreditation.verify idempotency layer degraded — HAF not configured, proceeding without dedup',
    );
  }

  // F24: `embedIdempotencyKey` (the generic bundle scanner used by custody
  // /broadcast) is INTENTIONALLY not used here. The accreditation op is a
  // single known-shape `custom_json` constructed inline — splicing
  // `idempotency_key` directly into the payload literal is clearer than
  // round-tripping through the scanner, and avoids the (small) cost of
  // re-parsing/re-stringifying the JSON. The convention is: future
  // surfaces with opaque bundles use the helper; surfaces that construct
  // a single op inline embed the field directly here.
  const customJsonPayload = {
    action: 'accredit',
    account: pending.hive_username,
    name: pending.full_name,
    institution: pending.institution,
    field: pending.field,
    method: 'email',
    evidence_hash: evidenceHash,
    idempotency_key: idempotencyKey,
    timestamp: new Date().toISOString(),
  };

  try {
    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    const result = await broadcastJsonWithTimeout(
      { id: config.appTag, json: JSON.stringify(customJsonPayload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );

    // F8: wrap deleteToken on the success path in best-effort cleanup so a
    // Redis hiccup post-success cannot propagate to Express's async-error
    // handler over the in-flight 200 envelope (closes the
    // `helper-extraction-express5-response-ordering-2026-04-28.md` class
    // for this route).
    await deleteTokenBestEffort(
      token,
      pending.hive_username,
      pending.email,
      'accreditation.verify.delete_token_failed_post_success',
      'accreditation.verify token cleanup failed on broadcast success — orphan TTLs out',
    );
    // Wrap seedAccreditationBonus in PostBroadcastWriteError discipline (the
    // pattern documented at `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS` and
    // adopted by ORCID's handleAccredit / handleLink). The chain op landed by
    // this point; a seed-bonus throw is a downstream cascade failure that
    // requires operator action — `seedAccreditationBonus` only rethrows on
    // PERMANENT class errors (TypeError/SyntaxError/RangeError) because
    // transient Redis/HAF blips stay swallowed inside the cascade fn per
    // `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS`. Round-2 F3 makes that
    // severity explicit at the wrap site so handleBroadcastError emits 502
    // POST_BROADCAST_OPERATOR_REQUIRED (not POST_BROADCAST_FAILED) and the
    // user-facing message says "support has been notified" instead of "will
    // reconcile automatically" — accurate, because the permanent class is
    // operator-actionable and the next batch cycle will NOT self-heal a
    // shape regression in `getReputationWeights()` output.
    try {
      await seedAccreditationBonus(pending.hive_username);
    } catch (seedErr) {
      throw new PostBroadcastWriteError(result.id, seedErr, 'reputation_seed', 'permanent');
    }

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
          {
            event: 'accreditation.verify.broadcast_decrement_failed',
            route: 'accreditation.verify',
            username: pending.hive_username,
            email_hash: hashEmailForLogs(pending.email),
            token_hash: hashTokenForLogs(token),
            err: decrErr instanceof Error ? decrErr : new Error(String(decrErr)),
          },
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
          {
            event: 'accreditation.verify.token_cleanup_failed',
            route: 'accreditation.verify',
            username: pending.hive_username,
            email_hash: hashEmailForLogs(pending.email),
            token_hash: hashTokenForLogs(token),
            err: deleteErr instanceof Error ? deleteErr : new Error(String(deleteErr)),
          },
          'accreditation.verify token cleanup failed after broadcast failure — orphan will TTL out',
        );
      }
    }
    // outcome === 'post_broadcast' (PostBroadcastWriteError): no cleanup
    // required here. The chain op already landed and `deleteToken` already
    // ran on the success path BEFORE the seed-bonus throw, so the token is
    // gone. The user has been told the chain op is confirmed
    // (`details.outcome:'confirmed'`, `details.tx_id`).
    //
    // Round-2 F3: this branch ONLY fires on PERMANENT seed-bonus errors
    // (TypeError/SyntaxError/RangeError rethrown from
    // `seedAccreditationBonus` per `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS`).
    // Transient cascade errors stay swallowed inside the cascade fn. The
    // user-facing envelope is 502 POST_BROADCAST_OPERATOR_REQUIRED, NOT
    // POST_BROADCAST_FAILED — the missed bonus will NOT self-heal via the
    // next reputation batch cycle (the next cycle re-derives from
    // `getReputationWeights()` which is the source of the shape regression
    // that caused the rethrow). Operator action required.
  }
});

// Cleanup expired tokens periodically
setInterval(() => {
  cleanupExpiredTokens().catch((err) => {
    logger.error(
      { event: 'accreditation.cleanup.failed', route: 'accreditation.cleanup', err },
      'Failed to cleanup expired accreditation tokens',
    );
  });
}, 60 * 60 * 1000);

export default router;

// Test-only seam: tests need to drive `decrementBroadcastAttempts` and
// `incrementBroadcastAttempts` directly:
//   - decrement: assert the `if (after < 0) DEL` race-recovery branch
//     (mutation-kill: removing the DEL leaves the counter at -1) and the
//     Redis-unavailable warn.
//   - increment: assert the symmetric Redis-unavailable warn. The route
//     flow's `getToken()` falls through to the in-memory token map when
//     `isRedisAvailable()` returns false; the test seed lives only in
//     Redis, so the route flow returns 400 BAD_REQUEST before reaching
//     the pre-INCR site. A unit-style call against the helper is the
//     only way to drive the in-memory-fallback warn path deterministically.
// Routing through `__test_seams` gives the specs a stable name to call
// without making the helpers route-public symbols. NOT for production import.
export const __test_seams = {
  decrementBroadcastAttempts,
  incrementBroadcastAttempts,
} as const;
