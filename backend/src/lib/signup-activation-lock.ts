import crypto from 'node:crypto';
import type { Response } from 'express';
import { config } from '../config.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { evalScript } from './redis-scripts.js';
import { sendError } from '../response.js';
import { logger } from '../logger.js';

/**
 * Per-auth_token activation lock for the /confirm + /link signup-finalization
 * critical section. This is the single-fire guard that lets the slow
 * `createClaimedAccount` chain broadcast run WITHOUT pinning a pg pool
 * connection across it.
 *
 * ── Why a Redis lock instead of the pg advisory lock it replaces ──
 *
 * The prior design held a `pg_advisory_xact_lock` inside a transaction that
 * also spanned the ~30s `createClaimedAccount` broadcast. That serialized the
 * double-fire race correctly but pinned one of the app pool's 5 connections
 * for the full broadcast — ~5 concurrent signups starved every other
 * pool-using route. Releasing the pg connection across the broadcast means the
 * single-fire guard can no longer be a connection-scoped pg lock (it would
 * release with the connection). This SET-NX lock survives the connection
 * release: the handler grabs short-lived pg connections only for the row read
 * and the finalize UPDATE, and holds THIS lock across the broadcast in between.
 *
 * ── Single-fire argument ──
 *
 *  1. `SET key nonce NX EX <ttl>` is atomic: at most one concurrent caller per
 *     auth_token acquires the lock; the rest observe it held.
 *  2. The holder retains the lock across `createClaimedAccount`. A concurrent
 *     same-token caller waits ({@link LOSER_WAIT_BUDGET_MS}) for release rather
 *     than broadcasting, so the single-use chain op fires at most once.
 *  3. The TTL ({@link ACTIVATION_LOCK_TTL_SECONDS}) exceeds the holder's
 *     acquire→verify_token-cleared window — two `getAccounts` reads (the chain-
 *     existence/availability check and the posting-key-proof check, each
 *     bounded by the 10s dhive timeout), encrypt, the 30s `createClaimedAccount`
 *     broadcast budget, and the finalize UPDATE, ~45s worst case under Hive-node
 *     degradation — so the lock cannot expire mid-activation and admit a second
 *     broadcaster while the first is still in flight. Any future addition to the
 *     in-lock IO path (a higher dhive timeout, a new pre-broadcast call) shrinks
 *     this margin and requires a TTL audit.
 *  4. Once the holder's finalize clears verify_token and releases, a waiter
 *     acquires, re-reads its row by verify_token, finds 0 rows, and takes the
 *     normal already-consumed reject. The waiter does NOT broadcast.
 *  5. Crash recovery does NOT rely on this lock. If the holder dies after the
 *     broadcast lands but before finalize, the lock self-expires after the
 *     TTL; a retry then re-acquires, observes via `getAccounts` that the chain
 *     account already exists, and resumes (encrypt + clear verify_token)
 *     WITHOUT re-broadcasting. The chain-existence + key-ownership proof in the
 *     handler is the crash backstop, not the lock.
 *  6. Fail-closed when Redis is unavailable. `createClaimedAccount` burns a
 *     finite claim token — an irreversible write — so this lock does NOT degrade
 *     to a no-lock / in-memory path when Redis is down (unlike idempotent ops
 *     such as the orcid/bridge locks, which degrade gracefully). If a holder
 *     acquired the Redis lock and Redis then flapped unavailable mid-broadcast,
 *     an in-process Map would have no record of that holder and a concurrent
 *     same-token caller would acquire freely and double-broadcast. So when Redis
 *     is unavailable at acquire time, or the `SET` throws after the availability
 *     check, the acquire returns the `'unavailable'` reason and the route maps
 *     it to a retriable 503 rather than proceeding lock-free. The Redis lock IS
 *     the single-fire safety argument; there is no consensus-as-fallback caveat.
 *
 * The waiter's bounded wait holds NO pg connection (it polls the lock only), so
 * a contended activation does not itself contribute to pool saturation — the
 * property this redesign exists to protect.
 */

// TTL must exceed the holder's acquire→verify_token-cleared duration so the
// lock cannot lapse mid-activation. Holder budget worst case: two getAccounts
// reads inside the lock window (chain-existence/availability check + posting-key
// proof, each bounded by the 10s dhive timeout under a degraded Hive node) +
// synchronous encryptKey + createClaimedAccount (30s broadcast timeout, hive.ts)
// + finalize UPDATE ≈ 45s; 60s leaves a 15s margin. Any future addition to the
// in-lock IO path (timeout bumps, a new pre-broadcast call) eats into that
// margin and requires a TTL audit. A holder that crashes mid-activation leaves
// the lock to self-expire after this TTL, after which a retry can re-acquire
// and resume against the already-created chain account.
const ACTIVATION_LOCK_TTL_SECONDS = 60;

// A concurrent same-token request (the "loser") waits up to this budget for the
// holder to release, then re-reads its row and converges on the already-consumed
// reject. Long enough to cover a healthy-Hive holder (broadcast well under the
// 30s timeout), short enough to bound a hung request: a holder degraded past
// this budget yields a retriable 409 LOCK_HELD rather than an indefinite hang.
const LOSER_WAIT_BUDGET_MS = 5_000;
const LOSER_POLL_INTERVAL_MS = 100;

// Retry-After (seconds) advertised on a 409 LOCK_HELD. A same-token waiter that
// could not acquire the activation lock within its wait budget backs off this
// long before retrying, so an auto-retry loop spaces its attempts past a typical
// holder's broadcast window instead of tight-looping.
const LOCK_HELD_RETRY_AFTER_SECONDS = 5;

// Hex shape of the per-acquisition nonce. The CAS release compares the stored
// value byte-for-byte; a future change to the nonce encoding that broke this
// shape would make the CAS silently never match (the lock would only ever
// release via TTL). Asserted at acquire time so the drift surfaces as a log.
const LOCK_NONCE_RE = /^[0-9a-f]{32}$/;

function activationLockKey(authToken: string): string {
  // Hash the attacker-influenced auth_token to a fixed-length key so a caller
  // submitting arbitrarily long tokens cannot inflate the Redis keyspace.
  // Mirrors the byAuthToken rate-limit key derivation in signup-verify.ts.
  const digest = crypto.createHash('sha256').update(authToken).digest('hex');
  return `${config.appTag}:signup_activation_lock:${digest}`;
}

/**
 * One non-blocking acquire attempt against Redis.
 *
 * Returns `'acquired'` when the SET-NX took the lock, `'held'` when another
 * holder owns it, and `'unavailable'` when Redis is down or the SET threw.
 * Because `createClaimedAccount` burns a finite claim token (an irreversible
 * write), there is NO in-memory fallback: a Redis-unavailable attempt fails
 * closed rather than degrading to a lock-free path that could double-broadcast.
 */
async function tryAcquireOnce(
  key: string,
  nonce: string,
): Promise<'acquired' | 'held' | 'unavailable'> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return 'unavailable';
  try {
    const result = await redis.set(key, nonce, 'EX', ACTIVATION_LOCK_TTL_SECONDS, 'NX');
    return result === 'OK' ? 'acquired' : 'held';
  } catch (err) {
    // Redis threw mid-acquire (outage between the availability check and the
    // SET). Fail closed — the caller surfaces a retriable 503 rather than
    // proceeding without the single-fire guard for an irreversible write.
    logger.error(
      { event: 'signup_activation_lock.redis_outage', err },
      'signup activation lock SET NX failed — redis outage, failing closed (503)',
    );
    return 'unavailable';
  }
}

async function releaseRedis(key: string, nonce: string): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return; // lock self-expires via TTL
  try {
    // CAS release: DEL only when the stored value still equals our nonce, so a
    // TTL-expired-then-reacquired lock owned by a later holder is never stomped.
    await evalScript(redis, 'RELEASE_LOCK_IF_TOKEN_MATCHES', [key], [nonce]);
  } catch (err) {
    // Best-effort: on failure the lock self-expires after the TTL.
    logger.warn(
      { event: 'signup_activation_lock.release_failed', err },
      'Failed to release signup activation lock; will self-expire via TTL',
    );
  }
}

export type SignupActivationLock =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; reason: 'held' | 'unavailable' };

/**
 * Acquire the per-auth_token activation lock, waiting up to
 * {@link LOSER_WAIT_BUDGET_MS} for a concurrent holder to release.
 *
 * On `{ acquired: true }` the caller MUST call `release()` (in a `finally`) once
 * the activation critical section — through the finalize UPDATE — completes.
 * On `{ acquired: false, reason: 'held' }` a concurrent activation held the lock
 * for the full wait budget; the caller surfaces a retriable 409 LOCK_HELD.
 * On `{ acquired: false, reason: 'unavailable' }` Redis is down and the lock
 * fails closed (the single-fire guard for the irreversible chain op cannot be
 * established); the caller surfaces a retriable 503.
 */
export async function acquireSignupActivationLock(authToken: string): Promise<SignupActivationLock> {
  const key = activationLockKey(authToken);
  const nonce = crypto.randomBytes(16).toString('hex');
  if (!LOCK_NONCE_RE.test(nonce)) {
    // crypto.randomBytes(16).toString('hex') is always 32 lowercase hex chars;
    // a failure here means a code-level regression of the nonce encoding that
    // would break the CAS release. Surface it loudly; fall back to the TTL.
    logger.error(
      { event: 'signup_activation_lock.nonce_drift' },
      'signup activation lock nonce shape invariant violated — code defect',
    );
  }

  const deadline = Date.now() + LOSER_WAIT_BUDGET_MS;
  for (;;) {
    const outcome = await tryAcquireOnce(key, nonce);
    if (outcome === 'acquired') {
      return {
        acquired: true,
        release: async () => {
          await releaseRedis(key, nonce);
        },
      };
    }
    // Redis-unavailable fails closed immediately — re-polling cannot establish
    // the single-fire guard, and waiting out the budget would only delay the
    // retriable 503. Only a 'held' lock is worth waiting for.
    if (outcome === 'unavailable') return { acquired: false, reason: 'unavailable' };
    if (Date.now() >= deadline) return { acquired: false, reason: 'held' };
    await new Promise((r) => setTimeout(r, LOSER_POLL_INTERVAL_MS));
  }
}

/**
 * Options for {@link withSignupActivationLock}: the per-route ceremony the
 * shared lock scaffold cannot infer.
 */
export interface WithSignupActivationLockOpts {
  /** Express response the wrapper writes the 409 LOCK_HELD / 503 / 500 envelopes to. */
  res: Response;
  /** Attacker-influenced auth_token; hashed into the lock key by acquire. */
  authToken: string;
  /**
   * Called from the outer catch when `fn` throws. Owns the route-specific
   * structured `logger.error` AND the `sendError(res, 500, ...)` write. The
   * wrapper does NOT send a 500 itself, so this MUST respond. The thrown error
   * is passed for logging.
   */
  onError: (err: unknown) => void;
}

/**
 * Wrap the per-auth_token activation-lock acquire/release + try/catch/finally
 * scaffold shared by the /confirm and /link signup-finalization handlers.
 *
 * Flow:
 *   1. {@link acquireSignupActivationLock}. On `{ acquired: false }` the wrapper
 *      sends the contention/outage envelope and resolves without calling `fn`:
 *        - `reason: 'held'` (a concurrent holder kept the lock for the full wait
 *          budget) → 409 LOCK_HELD `{ retriable: true }` with a `Retry-After`
 *          header so an auto-retry loop backs off past the holder's broadcast
 *          window instead of tight-looping (the per-token limiter refunds this
 *          409's slot, so the waiter is not charged for the holder's slowness).
 *        - `reason: 'unavailable'` (Redis is down, so the single-fire guard for
 *          the irreversible `createClaimedAccount` cannot be established) → 503
 *          SERVICE_UNAVAILABLE `{ retriable: true }`, failing closed rather than
 *          proceeding lock-free and risking a double-burned claim token.
 *      Both envelopes are identical across the two call sites, so they live here.
 *   2. On acquire, run `fn(releaseLock)`. `fn` is the route body; it MUST call
 *      `releaseLock()` once at the single-fire-critical-section boundary (after
 *      the verify_token-clearing finalize, before the slow accreditation
 *      broadcast) so a concurrent same-token waiter is not blocked across the
 *      broadcast for no single-fire benefit. The seam stays in the route
 *      because the "critical section complete" decision is route-specific;
 *      `releaseLock` is idempotent (CAS/nonce-safe), so the wrapper's `finally`
 *      re-release is a no-op on the happy path and the durable backstop if `fn`
 *      throws before reaching its own `releaseLock()`.
 *   3. If `fn` throws, `opts.onError(err)` runs (route-specific 500 log +
 *      response), then the `finally` releases the lock.
 *
 * The wrapper never writes a success envelope — `fn` owns every non-error
 * response (200, and the 4xx/5xx rejects inside the body that `return` early).
 */
export async function withSignupActivationLock(
  opts: WithSignupActivationLockOpts,
  fn: (releaseLock: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const lock = await acquireSignupActivationLock(opts.authToken);
  if (!lock.acquired) {
    if (lock.reason === 'unavailable') {
      // Redis is down, so the single-fire guard for the irreversible
      // createClaimedAccount broadcast cannot be established. Fail closed with a
      // retriable 503 rather than proceeding lock-free (which could double-burn
      // a claim token).
      sendError(
        opts.res,
        503,
        'SERVICE_UNAVAILABLE',
        'Account activation is temporarily unavailable. Please retry in a moment.',
        { retriable: true },
      );
      return;
    }
    // A concurrent activation holds the lock. Advise the client to back off
    // before retrying; the per-token rate-limiter refunds this 409's slot so an
    // auto-retry loop does not exhaust the budget while the holder finishes.
    opts.res.set('Retry-After', String(LOCK_HELD_RETRY_AFTER_SECONDS));
    sendError(
      opts.res,
      409,
      'LOCK_HELD',
      'An activation for this signup is already in progress. Please retry in a moment.',
      { retriable: true },
    );
    return;
  }

  try {
    await fn(lock.release);
  } catch (err) {
    opts.onError(err);
  } finally {
    await lock.release();
  }
}
