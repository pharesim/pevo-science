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
import { findExistingAccreditation, lookupAccreditationBroadcastIdempotency } from '../lib/idempotency.js';
import { getPool, isHafConfigured } from '../db.js';

/** How long a verification token stays valid before it expires. */
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Consume-on-success-only: the 3/24h cap exists to bound the email-send
// expense (one SMTP roundtrip + one issued verification token per allowed
// slot), not to penalize transient SMTP/mail-provider failures. Without this
// flag, a `sendMail` throw or an empty-smtpHost 500 burns one of the user's
// three daily slots; three transient outages in 24h lock them out of
// accreditation requests entirely. Per `RateLimitConfig.skipFailedRequests`
// JSDoc, the refund branch keys on ANY `res.statusCode >= 400` — 4xx
// responses (400 validation, 422 non-institutional email) ALSO refund the
// slot. That is acceptable here because every 4xx path short-circuits before
// `storeToken` and `sendMail`, so probing only costs Redis-rate-limit ops
// with no SMTP/token side effects. A future change that inserts an expensive
// operation BEFORE the institutional-email check must add its own throttle —
// the limiter's symmetric refund will not rate-limit pre-handler probes.
// Mirrors the `upgradeLimiter` shape in `custody.ts`.
const accreditationRequestLimiter = rateLimit({ name: 'accred-req', windowMs: 24 * 60 * 60_000, max: 3, keyFn: byAccount, skipFailedRequests: true });
// The /verify limiter caps per-IP requests but must refund the slot on
// failure responses. During a HAF outage the existing-accreditation gate
// returns 503 `ACCREDITATION_GATE_UNAVAILABLE` with `details.retriable:
// true`; the user's expected behaviour is to refresh-and-retry once HAF
// recovers. Without `skipFailedRequests`, each 503 burns one of the 5
// slots per 60s and the legitimate user trips 429 RATE_LIMITED before
// HAF comes back. Per `RateLimitConfig.skipFailedRequests` JSDoc the
// refund branch keys on ANY `res.statusCode >= 400`, including 4xx:
// `BAD_REQUEST` (invalid/expired token), `INTERNAL_ERROR` (missing admin
// key), `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` / `POST_BROADCAST_OPERATOR_REQUIRED`
// (502), `ACCREDITATION_GATE_UNAVAILABLE` / `SERVICE_UNAVAILABLE` (503,
// pre-INCR counter failed), `BROADCAST_TIMEOUT` (504). The 4xx refund is
// acceptable here because `BAD_REQUEST` is the only client-error path on
// /verify and it short-circuits BEFORE any expensive work (HAF probes,
// broadcast), so probing only costs Redis-rate-limit ops with no chain
// side effects. Mirrors the `accreditationRequestLimiter` shape above
// and `upgradeLimiter` in `custody.ts`.
const accreditationVerifyLimiter = rateLimit({ name: 'accred-verify', windowMs: 60_000, max: 5, keyFn: byIp, skipFailedRequests: true });

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

export function broadcastAttemptsKey(token: string): string {
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
 * Status discriminator for `decrementBroadcastAttempts` (round-3 hold #6).
 *
 * The decrement compensates a pre-incremented broadcast attempt that
 * resolved to a 504 BROADCAST_TIMEOUT (round-2 hold #2): the cap is meant
 * to bound retries on definitive chain rejections, not punish transient
 * slow-Hive timeouts (3 unlucky attempts would force a fresh email under
 * the 3/24h per-account limit). Pre-INCR is necessary for the atomic
 * concurrent-claim guarantee (4 parallel /verify calls must enqueue at
 * most `cap` broadcasts); decrement-after-timeout is the simplest shape
 * that preserves both that guarantee and the verify-then-retry UX. `DECR`
 * on a missing key resolves to -1; the floor at 0 (via DEL when `after<0`)
 * keeps the counter from going negative if a parallel
 * deleteBroadcastAttempts (success path) raced ahead of this decrement.
 *
 *   `'decremented'`       — the counter was successfully decremented (Redis
 *                            DECR landed, OR no-Redis in-memory fallback ran).
 *   `'enqueued_for_drain'` — Redis was configured at INCR time but is now
 *                            unavailable (mid-request flap). The decrement
 *                            was enqueued for the periodic drain cycle and
 *                            an internal warn fired. Caller may emit a
 *                            site-specific structured event so a degraded
 *                            decrement is dashboard-keyable per call site.
 *
 * Round-4 hold #3: the `'failed'` arm was dropped — the immediate-DECR
 * throw path re-throws (so the route's outer catch handles it) and never
 * returned `'failed'` in practice. If a future caller wants a non-throwing
 * failure return, add the arm back at that point with its narrowing site.
 *
 * Returning a discriminator (round-3 hold #6) lets call sites switch on the
 * degraded path WITHOUT the helper having to know each caller's structured-
 * log event name. The internal `broadcast_decrement_redis_unavailable` warn
 * continues to fire from inside the helper for the broader operator-
 * correlation signal; callers add their site-specific event on top.
 */
export type DecrementBroadcastAttemptsResult =
  | 'decremented'
  | 'enqueued_for_drain';

async function decrementBroadcastAttempts(
  token: string,
  attemptId?: string,
): Promise<DecrementBroadcastAttemptsResult> {
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
        return 'decremented';
      } catch (decrErr) {
        // DECR threw during a Redis flap (mid-request unavailability, OOM,
        // evicted-to-read-only). Enqueue for retry by the periodic drain
        // cycle so the counter eventually returns to its pre-INCR value
        // rather than staying inflated until the 24h TTL, then re-throw.
        // Re-throwing preserves the existing outer-catch
        // `accred_verify_broadcast_decrement_failed` warn (the route's
        // per-request signal) — the queue handles recovery, the outer-catch
        // warn handles operator correlation.
        if (attemptId) {
          enqueueDecrement({ token, attemptId, key });
        }
        throw decrErr;
      }
    }
    // If Redis was reachable at INCR time but is unavailable now (mid-request
    // flap), the in-memory map has no record of the Redis-side counter and a
    // silent fallback would leave the Redis-side counter inflated until 24h
    // TTL with no operator signal. Emit a structured warn here so operators
    // can correlate counter drift with Redis incidents; the sibling
    // `accred_verify_broadcast_decrement_failed` event covers the
    // throw-during-DECR case but not this silent-noop case.
    //
    // Also enqueue for the periodic drain cycle so the counter is decremented
    // when Redis recovers, instead of sitting inflated until the 24h TTL.
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
    // Round-3 hold #6: return a status discriminator so the hit-branch
    // caller (and any future caller) can emit a site-specific degraded
    // event alongside the helper-internal warn.
    return 'enqueued_for_drain';
  }
  // No Redis configured at all → in-memory fallback path.
  const current = memoryBroadcastAttempts.get(token);
  if (current === undefined) return 'decremented';
  if (current <= 1) {
    memoryBroadcastAttempts.delete(token);
  } else {
    memoryBroadcastAttempts.set(token, current - 1);
  }
  return 'decremented';
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

// Grace-period record for the AbortError-after-success cascade. The SPA's
// 30s AbortSignal.timeout can fire AFTER the backend has committed the on-
// chain broadcast and deleted the pending token but BEFORE the 200 envelope
// lands at the client. The SPA's retriable-error UX then sends the same
// token again; without this record the route falls through to 400
// BAD_REQUEST and the user enters the "Request New" cascade despite the
// broadcast already succeeding. Keyed on `sha256(token)` (full digest, not
// the truncated `hashTokenForLogs` form) so the record cannot be mined
// from log lines. 24h TTL matches the original token TTL — symmetric
// window covers any retry the user is likely to attempt on the same day.
//
// Revoke-after-broadcast trade-off: the record carries only {username,
// tx_id} and does NOT re-verify current chain state on retry. A user
// revoked between the original successful broadcast and the retry
// receives a cached "Accreditation confirmed" 200, even though their on-
// chain accreditation has been revoked. This is the accepted trade-off
// for the idempotency-record approach: re-running the existing-
// accreditation gate on every retry would re-introduce HAF-dependency
// (and a 503 ACCREDITATION_GATE_UNAVAILABLE failure mode) on the
// idempotent retry path. WoT-revoke is an operator-only-reversible
// action and the window where a revoke lands within 24h of a successful
// broadcast is narrow at PEvO scale.
const ACCREDITATION_COMPLETED_TTL_SECONDS = 24 * 60 * 60;

interface AccreditationCompletionRecord {
  username: string;
  tx_id: string;
}

// Key strategy asymmetry: Redis side hashes the token via sha256 (full
// digest) so the key cannot be mined from MONITOR/slow-log output or
// any operator log surface that might one day enumerate keys. In-memory
// side keys on the raw token string because process memory already
// exposes the token (the pending-row store next door, `memoryTokens`,
// also keys raw), so hashing inside the process buys nothing while
// adding indirection. The asymmetry is intentional and load-bearing:
// any future refactor unifying the stores would change the threat model
// for the Redis side. Restart drops this Map — the in-memory fallback
// is flap-resilience for the single-process lifetime, not a sustained
// Redis-less deployment mode. Restart-induced loss is the accepted
// trade-off (a restart within the 24h grace-period window recreates
// the original AbortError-after-success cascade for tokens whose
// completion record lived only in memory).
const memoryAccreditationCompletions = new Map<
  string,
  { record: AccreditationCompletionRecord; expires_at: number }
>();

function accreditationCompletedKey(token: string): string {
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  return `${config.appTag}:accreditation-completed:${digest}`;
}

/**
 * Atomic write of the completion record + delete of the pending token on
 * the broadcast-success path. The two operations execute serially in one
 * Redis MULTI pipeline so a concurrent /verify retry cannot observe the
 * "token deleted, record absent" half-state that produces the original
 * 400 cascade. Partial-failure within the pipeline (SET succeeds, DEL
 * fails or vice versa) is tolerated: a record without a token-delete
 * leaves the pending token in place (next /verify finds the pending row
 * and re-runs the existing-accreditation gate which short-circuits on
 * the chain-side accredit op); a token-delete without a record returns
 * 400 same as today (the pre-task baseline). The counter side-key delete
 * is sequential after the pipeline — its lifetime is bounded by the
 * token TTL, so a brief lingering counter between pipeline and counter
 * delete is harmless.
 *
 * Pipeline-rejection class (Redis-down mid-pipeline, connection drop,
 * ioredis internal error) is caught locally — the in-memory writes that
 * follow MUST execute even when the Redis pipeline throws, so a Redis-
 * present-but-pipeline-rejects scenario still gets the in-memory grace-
 * period record. Without the inner catch, the function would reject and
 * the outer best-effort wrapper would warn and skip the in-memory writes
 * entirely, breaking the flap-resilience contract.
 */
async function recordAccreditationCompletion(
  token: string,
  username: string,
  txId: string,
): Promise<void> {
  const payload: AccreditationCompletionRecord = { username, tx_id: txId };
  const serialized = JSON.stringify(payload);
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis
        .multi()
        .set(accreditationCompletedKey(token), serialized, 'EX', ACCREDITATION_COMPLETED_TTL_SECONDS)
        .del(`${config.appTag}:pending_accred:${token}`)
        .exec();
    } catch (pipelineErr) {
      logger.warn(
        {
          event: 'accreditation.verify.completion_record_pipeline_failed',
          route: 'accreditation.verify',
          username,
          token_hash: hashTokenForLogs(token),
          err: pipelineErr instanceof Error ? pipelineErr : new Error(String(pipelineErr)),
        },
        'accreditation.verify completion-record Redis pipeline failed — falling through to in-memory fallback',
      );
    }
  }
  memoryAccreditationCompletions.set(token, {
    record: payload,
    expires_at: Date.now() + ACCREDITATION_COMPLETED_TTL_SECONDS * 1000,
  });
  memoryTokens.delete(token);
  await deleteBroadcastAttempts(token);
}

async function readAccreditationCompletion(
  token: string,
): Promise<AccreditationCompletionRecord | null> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      const raw = await redis.get(accreditationCompletedKey(token));
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof (parsed as { username?: unknown }).username !== 'string' ||
            typeof (parsed as { tx_id?: unknown }).tx_id !== 'string'
          ) {
            logger.warn(
              {
                event: 'accreditation.verify.completion_record_invalid_shape',
                route: 'accreditation.verify',
                token_hash: hashTokenForLogs(token),
              },
              'accreditation.verify completion record shape invalid — falling through to 400',
            );
            return null;
          }
          return parsed as AccreditationCompletionRecord;
        } catch {
          return null;
        }
      }
    } catch {
      // Redis flap mid-read falls through to the in-memory map.
    }
  }
  const cached = memoryAccreditationCompletions.get(token);
  if (!cached) return null;
  if (Date.now() > cached.expires_at) {
    memoryAccreditationCompletions.delete(token);
    return null;
  }
  return cached.record;
}

/**
 * Best-effort wrapper around `deleteToken` used by branches that have already
 * written or are about to write a final response envelope (200 success and
 * idempotency-hit paths on /verify; 500 SMTP-failure cleanup paths on
 * /request). A Redis hiccup on cleanup must NOT propagate to Express's
 * async-error handler (`ERR_HTTP_HEADERS_SENT` would be the visible symptom
 * on the success branches; envelope-shape regression to the express-default
 * HTML 500 would be the symptom on the /request 500 branches — both
 * captured by `helper-extraction-express5-response-ordering-2026-04-28.md`).
 * Caller passes `event` + `msg` discriminators so operators can correlate
 * the orphan back to the specific branch that observed the failure; the
 * 24h token TTL is the backstop. The discriminator string convention is to
 * prefix the event with the calling route (`accreditation.request.*` vs
 * `accreditation.verify.*`) — log search keys on that.
 */
/**
 * Best-effort wrapper around `recordAccreditationCompletion` used on the
 * /verify broadcast-success path AFTER `seedAccreditationBonus` succeeds.
 * Mirrors `deleteTokenBestEffort`'s shape because the same response-
 * ordering hazard applies: the 200 envelope has not been written yet,
 * but a propagating Redis error on the completion-record write must not
 * reach Express's async-error handler over the in-flight 200 (closes
 * the response-ordering class documented at `helper-extraction-express5-
 * response-ordering-2026-04-28.md`). The internal pipeline-rejection
 * catch in `recordAccreditationCompletion` handles the Redis-down-mid-
 * pipeline class; this outer wrapper catches any other failure mode
 * (e.g., the in-memory writes themselves throwing, or unexpected
 * exceptions from the helper).
 */
async function recordAccreditationCompletionBestEffort(
  token: string,
  username: string,
  txId: string,
  email: string,
): Promise<void> {
  try {
    await recordAccreditationCompletion(token, username, txId);
  } catch (recordErr) {
    logger.warn(
      {
        event: 'accreditation.verify.completion_record_failed_post_success',
        route: 'accreditation.verify',
        username,
        email_hash: hashEmailForLogs(email),
        token_hash: hashTokenForLogs(token),
        err: recordErr instanceof Error ? recordErr : new Error(String(recordErr)),
      },
      'accreditation.verify completion record + token cleanup failed on broadcast success — orphan TTLs out',
    );
  }
}

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
        route: event.startsWith('accreditation.request.') ? 'accreditation.request' : 'accreditation.verify',
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
  // Redis handles TTL automatically; just clean in-memory maps.
  const now = new Date();
  for (const [t, p] of memoryTokens) {
    if (now > p.expires_at) memoryTokens.delete(t);
  }
  // Grace-period completion records are lazily evicted on access in
  // `readAccreditationCompletion`, but under normal Redis-up operation
  // those reads never hit the in-memory branch — entries would
  // accumulate until process restart. Sweep here for parity with the
  // sibling `memoryTokens` cleanup.
  const nowMs = Date.now();
  for (const [t, c] of memoryAccreditationCompletions) {
    if (nowMs > c.expires_at) memoryAccreditationCompletions.delete(t);
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
          err: mailErr instanceof Error ? mailErr : new Error(String(mailErr)),
        },
        'Failed to send verification email',
      );
      // Wrap deleteToken in best-effort cleanup so a Redis hiccup on cleanup
      // does not propagate to Express 5's default async-error handler and
      // bypass the {error:{code,message}} envelope. See `deleteTokenBestEffort`
      // JSDoc + `helper-extraction-express5-response-ordering-2026-04-28.md`.
      await deleteTokenBestEffort(
        token,
        hive_username,
        email,
        'accreditation.request.sendmail_throw_token_cleanup_failed',
        'Token cleanup failed after SMTP sendMail threw',
      );
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
    await deleteTokenBestEffort(
      token,
      hive_username,
      email,
      'accreditation.request.smtp_host_missing_token_cleanup_failed',
      'Token cleanup failed after SMTP host not configured',
    );
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

  // Per-request attempt identifier used by the in-process pending-decrement
  // queue. Generated once per /verify call so a duplicate enqueue (e.g. retry
  // within the same request lifetime) is idempotent — the queue is keyed on
  // attemptId.
  const attemptId = crypto.randomBytes(8).toString('hex');

  const pending = await getToken(token);
  if (!pending) {
    // Grace-period idempotency: a prior /verify on this same token may
    // have committed the on-chain broadcast and deleted the pending row
    // before the SPA's AbortSignal.timeout fired. Without this check the
    // user's retry falls through to 400 and cascades through "Request
    // New". The completion record returns the same envelope shape the
    // original fresh-success flight would have emitted, so the SPA's
    // existing success-state handler renders without branching.
    //
    // The record is NOT re-verified against current chain state — a
    // revoke landing between the original broadcast and the retry
    // returns the cached 200. Accepted trade-off (see the
    // `memoryAccreditationCompletions` declaration block for the full
    // rationale: re-running the gate would re-introduce HAF dependency
    // on the idempotent retry path).
    const completion = await readAccreditationCompletion(token);
    if (completion) {
      return sendOk(res, {
        message: 'Accreditation confirmed',
        username: completion.username,
        tx_id: completion.tx_id,
      });
    }
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired token');
  }

  // Broadcast accreditation custom_json to Hive
  if (!config.pevoAdminPostingKey) {
    await deleteToken(token);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
  }

  // Round-3 hold #7: ordering is (a) compute idempotency_key, (b) HAF
  // probe (no state change), (c) if hit -> 200 short-circuit (no cap
  // consumed), (d) if miss -> increment cap, broadcast. The probe ran
  // AFTER the pre-INCR in earlier rounds, which produced the mixed-
  // envelope class adversarial A3 surfaced: under cap exhaustion AND a
  // confirmed-on-chain accreditation, concurrent retries could receive
  // 502 BROADCAST_ATTEMPT_LIMIT_EXCEEDED on retry N+1 while retry N
  // returned 200 outcome:'already_landed' — same logical op, two
  // outcomes. Moving the probe ahead of the INCR mirrors the F2
  // fresh-auth hoist ordering principle: checks that depend on state
  // changing should run AFTER checks that establish whether the
  // operation is needed at all. The probe is read-only and has no
  // ordering constraint with the cap counter; the cap exists to bound
  // chain ops, and a hit consumes zero chain ops.
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
  // carrying this idempotency_key, return its tx_id without re-broadcasting
  // AND without consuming a cap slot. Token cleanup follows the existing
  // post-broadcast convention.
  //
  // Round-2 F1 / round-3 hold #7: on the HAF-hit branch we run
  // seedAccreditationBonus (original spec acceptance #2(b)) but NO cap
  // decrement is needed because the probe runs before the INCR — no slot
  // was claimed. Both seed and token cleanup are best-effort under their
  // existing try/catch wrappers. A PERMANENT bonus-seed throw surfaces as
  // a 502 POST_BROADCAST_OPERATOR_REQUIRED via F3's severity
  // discrimination (programmer-error class — operator-actionable, not
  // auto-reconciled).
  const hafPool = isHafConfigured() ? getPool() : null;
  if (hafPool) {
    // User-level "is this account already accredited?" gate. Runs BEFORE the
    // per-token idempotency-key check (which catches retries of the SAME
    // /verify call) so the multi-token coexistence class is closed: two
    // pending tokens for the same user produce different `idempotency_key`s
    // (the key is `sha256(token:username)`), so the per-token check misses
    // across tokens. The user-level gate catches that case via the
    // `account` payload field — independent of which token the second
    // /verify call carried.
    //
    // Order: validation → existing-accreditation gate → idempotency check →
    // broadcast. Each layer fires only if the prior didn't short-circuit;
    // both layers run BEFORE the broadcast-attempt cap pre-INCR so a hit
    // here consumes zero cap slots (mirrors the round-3 hold #7 reordering
    // for the per-token check). Token cleanup follows the existing
    // best-effort wrap pattern. `seedAccreditationBonus` is NOT re-invoked
    // on gate-hit because the prior /verify that produced the on-chain
    // accredit op already seeded the bonus (or the next reputation batch
    // cycle / boot-time `backfillAccreditationSeeds` reconciles if it
    // didn't).
    try {
      const existingForUser = await findExistingAccreditation(hafPool, pending.hive_username);
      if (existingForUser) {
        // Round-1 hold #4: metadata-update invariant. Gate-hit short-circuits
        // before the pending row's metadata (full_name, institution, field
        // captured at /request) would be embedded into a fresh accredit op.
        // This is correct under the current product model: there is no
        // `update_accreditation` custom_op, no UI affordance for editing
        // accreditation metadata post-verification, and the only path that
        // could re-issue an accredit op with new metadata is a second
        // /request → /verify flow. Profile metadata is one-shot at first
        // /verify; the gate-hit discard is intentional. If a future product
        // change introduces an updateable-metadata flow, this branch needs
        // a paired design pass (broadcast a fresh accredit op, distinct
        // `update_accreditation` op type, or reject metadata changes at
        // /request when an accreditation exists). The gate's revoke-aware
        // semantics (round-1 hold #1) preserve the re-accreditation path
        // after revoke — that flow DOES rebroadcast with fresh metadata.
        logger.info(
          {
            event: 'accreditation.verify.existing_accreditation_hit',
            route: 'accreditation.verify',
            username: pending.hive_username,
            email_hash: hashEmailForLogs(pending.email),
            tx_id: existingForUser.tx_id,
          },
          'accreditation.verify existing-accreditation gate hit — returning prior tx_id without re-broadcasting',
        );
        await deleteTokenBestEffort(
          token,
          pending.hive_username,
          pending.email,
          'accreditation.verify.existing_accreditation_hit_token_cleanup_failed',
          'accreditation.verify existing-accreditation gate token cleanup failed — orphan TTLs out',
        );
        return sendOk(res, {
          message: 'Accreditation confirmed',
          username: pending.hive_username,
          tx_id: existingForUser.tx_id,
          outcome: 'already_accredited',
        });
      }
    } catch (gateErr) {
      // Round-2's revoke-handling fix (the gate now considers latest of
      // ('accredit','revoke')) reshaped what fallthrough means here: a
      // catch-and-degrade would let a fresh broadcast OVERRIDE a chain-
      // recorded revoke during HAF outage, not just permit a bounded
      // duplicate accredit. Under PEvO's operator-only-reversible revoke
      // semantic (architect disposition α, 2026-05-16), that override is a
      // structural gap, not an accepted bounded class. So when the gate
      // query throws we surface 503 SERVICE_UNAVAILABLE and preserve the
      // token (no deleteTokenBestEffort) so the user can retry once HAF
      // recovers. The rate-limit counter is not incremented either: this
      // path short-circuits before the pre-INCR slot claim.
      logger.warn(
        {
          event: 'accreditation.verify.existing_accreditation_gate_unavailable',
          route: 'accreditation.verify',
          username: pending.hive_username,
          email_hash: hashEmailForLogs(pending.email),
          err: gateErr instanceof Error ? gateErr : new Error(String(gateErr)),
        },
        'accreditation.verify existing-accreditation gate HAF query failed — returning 503 SERVICE_UNAVAILABLE; token preserved for retry',
      );
      // Server-driven backoff cadence (30s default). The SPA's
      // ApiRequestError infrastructure (frontend/src/api.js:28-33,63-71)
      // parses Retry-After into `err.retryAfterSeconds`; emitting it
      // here lets layered consumers (SPA + nginx + any future
      // auto-retry middleware) share a coherent floor instead of each
      // picking its own cadence. 30s is a reasonable HAF-outage
      // recovery default — operator-tunable if needed.
      res.set('Retry-After', '30');
      return sendError(
        res,
        503,
        'ACCREDITATION_GATE_UNAVAILABLE',
        'Verification temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }

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
        // F1 part 2: seed the accreditation bonus on the hit branch too.
        // Permanent throws (TypeError/SyntaxError/RangeError re-thrown by
        // `seedAccreditationBonus`) surface as 502
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
    res.set('Retry-After', '30');
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
    // user-facing message asks the user to contact support instead of
    // saying "will reconcile automatically" (round-3 hold #3 corrected the
    // prior "support has been notified" copy to an honest "please contact
    // support" until alerting actually fires). The permanent class is
    // operator-actionable and the next batch cycle will NOT self-heal a
    // shape regression in `getReputationWeights()` output.
    //
    // Seed must run BEFORE the completion record is written. A
    // PostBroadcastWriteError on the seed-bonus throw surfaces 502
    // POST_BROADCAST_OPERATOR_REQUIRED to the user; if the completion
    // record were written first, the user's retry would find the
    // record and receive a cached 200 — silently masking the 502's
    // operator-actionable signal. The retry-finds-400 outcome on a
    // seed-permanent-throw is the correct UX: first call surfaces 502
    // (operator pager), the retry surfaces 400 (token consumed), and
    // the user reports the inconsistency rather than seeing it
    // smoothed over.
    try {
      await seedAccreditationBonus(pending.hive_username);
    } catch (seedErr) {
      throw new PostBroadcastWriteError(result.id, seedErr, 'reputation_seed', 'permanent');
    }

    // Atomic completion-record write + pending-token delete on the
    // broadcast-success path. Replaces the prior plain `deleteToken`
    // call so the AbortError-after-success cascade closes: a retry on
    // the same token finds the completion record and returns the
    // identical 200 envelope. Wrapped in best-effort because a Redis
    // hiccup post-success must NOT propagate to Express's async-error
    // handler over the in-flight 200 envelope (closes the response-
    // ordering class documented at `helper-extraction-express5-
    // response-ordering-2026-04-28.md`).
    await recordAccreditationCompletionBestEffort(
      token,
      pending.hive_username,
      result.id,
      pending.email,
    );

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
        // Round-4 hold #1: capture the discriminator the helper introduced
        // in round-3 hold #6. `'enqueued_for_drain'` means Redis was
        // configured at INCR time but unavailable at DECR time (mid-request
        // flap). The helper-internal `broadcast_decrement_redis_unavailable`
        // warn fires for the broader operator-correlation signal; this
        // site-specific event lets a dashboard/alert key on the timeout
        // call site (vs other future decrement callers) without parsing
        // message strings.
        const decrStatus = await decrementBroadcastAttempts(token, attemptId);
        if (decrStatus === 'enqueued_for_drain') {
          logger.warn(
            {
              event: 'accreditation.verify.timeout_decrement_degraded',
              route: 'accreditation.verify',
              username: pending.hive_username,
              attempt_id: attemptId,
              token_hash: hashTokenForLogs(token),
            },
            'accreditation.verify counter decrement after timeout: enqueued for drain (Redis degraded mid-request)',
          );
        }
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
    // outcome === 'post_broadcast' (PostBroadcastWriteError): the chain
    // op landed but the seed-bonus throw fired BEFORE the completion
    // record + token-delete pair ran, so the pending token is still
    // alive at this point. Clean it up best-effort so a retry surfaces
    // 400 BAD_REQUEST (no pending row, no completion record) rather
    // than masking the 502's operator-actionable signal under a cached
    // grace-period 200. The 502 has already been written via
    // `handleBroadcastError`; the cleanup is wrapped best-effort to
    // avoid the headers-sent ordering hazard.
    //
    // This branch ONLY fires on PERMANENT seed-bonus errors
    // (TypeError/SyntaxError/RangeError rethrown from
    // `seedAccreditationBonus` per `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS`).
    // Transient cascade errors stay swallowed inside the cascade fn. The
    // user-facing envelope is 502 POST_BROADCAST_OPERATOR_REQUIRED, NOT
    // POST_BROADCAST_FAILED — the missed bonus will NOT self-heal via the
    // next reputation batch cycle (the next cycle re-derives from
    // `getReputationWeights()` which is the source of the shape regression
    // that caused the rethrow). Operator action required.
    else if (outcome === 'post_broadcast') {
      await deleteTokenBestEffort(
        token,
        pending.hive_username,
        pending.email,
        'accreditation.verify.post_broadcast_token_cleanup_failed',
        'accreditation.verify token cleanup failed after post-broadcast write error — orphan TTLs out',
      );
    }
  }
});

// Cleanup expired tokens periodically
setInterval(() => {
  cleanupExpiredTokens().catch((err) => {
    logger.error(
      {
        event: 'accreditation.cleanup.failed',
        route: 'accreditation.cleanup',
        err: err instanceof Error ? err : new Error(String(err)),
      },
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
