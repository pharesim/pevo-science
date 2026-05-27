import crypto from 'node:crypto';
import { config } from '../config.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { evalScript } from './redis-scripts.js';
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
 *     acquire→verify_token-cleared window — pg read + encrypt + the 30s
 *     `createClaimedAccount` broadcast budget + finalize UPDATE, ~35s worst
 *     case — so the lock cannot expire mid-activation and admit a second
 *     broadcaster while the first is still in flight.
 *  4. Once the holder's finalize clears verify_token and releases, a waiter
 *     acquires, re-reads its row by verify_token, finds 0 rows, and takes the
 *     normal already-consumed reject. The waiter does NOT broadcast.
 *  5. Crash recovery does NOT rely on this lock. If the holder dies after the
 *     broadcast lands but before finalize, the lock self-expires after the
 *     TTL; a retry then re-acquires, observes via `getAccounts` that the chain
 *     account already exists, and resumes (encrypt + clear verify_token)
 *     WITHOUT re-broadcasting. The chain-existence + key-ownership proof in the
 *     handler is the crash backstop, not the lock.
 *  6. In-memory fallback: PEvO is single-instance, so when Redis is down an
 *     in-process Map gives the same NX-with-TTL mutual exclusion within the one
 *     process. A multi-process deployment would need Redis for cross-process
 *     safety; that is out of scope by design.
 *  7. Defence in depth if the lock ever fails to serialize (e.g. Redis flaps
 *     across the acquire/release boundary): Hive consensus rejects a duplicate
 *     `create_claimed_account` for an existing account name, and the single-use
 *     `verify_token`-clearing UPDATE is the durable last-write guard.
 *
 * The waiter's bounded wait holds NO pg connection (it polls the lock only), so
 * a contended activation does not itself contribute to pool saturation — the
 * property this redesign exists to protect.
 */

// TTL must exceed the holder's acquire→verify_token-cleared duration so the
// lock cannot lapse mid-activation. Holder budget: short pg read + synchronous
// encryptKey + createClaimedAccount (30s broadcast timeout, hive.ts) + finalize
// UPDATE ≈ 35s; 60s leaves margin. A holder that crashes mid-activation leaves
// the lock to self-expire after this TTL, after which a retry can re-acquire
// and resume against the already-created chain account.
const ACTIVATION_LOCK_TTL_SECONDS = 60;
const ACTIVATION_LOCK_TTL_MS = ACTIVATION_LOCK_TTL_SECONDS * 1000;

// A concurrent same-token request (the "loser") waits up to this budget for the
// holder to release, then re-reads its row and converges on the already-consumed
// reject. Long enough to cover a healthy-Hive holder (broadcast well under the
// 30s timeout), short enough to bound a hung request: a holder degraded past
// this budget yields a retriable 409 LOCK_HELD rather than an indefinite hang.
const LOSER_WAIT_BUDGET_MS = 5_000;
const LOSER_POLL_INTERVAL_MS = 100;

// Hex shape of the per-acquisition nonce. The CAS release compares the stored
// value byte-for-byte; a future change to the nonce encoding that broke this
// shape would make the CAS silently never match (the lock would only ever
// release via TTL). Asserted at acquire time so the drift surfaces as a log.
const LOCK_NONCE_RE = /^[0-9a-f]{32}$/;

function activationLockKey(authToken: string): string {
  // Hash the attacker-influenced auth_token to a fixed-length key so a caller
  // submitting arbitrarily long tokens cannot inflate the Redis/in-memory
  // keyspace. Mirrors the byAuthToken rate-limit key derivation in
  // signup-verify.ts.
  const digest = crypto.createHash('sha256').update(authToken).digest('hex');
  return `${config.appTag}:signup_activation_lock:${digest}`;
}

// In-memory fallback store for the Redis-down path. Single-instance only: one
// process means an in-process Map reproduces SET-NX-with-TTL semantics. Entries
// are lazily expired on access (no background sweep — the key set is tiny and
// bounded by concurrent in-flight signups).
const memoryLocks = new Map<string, { nonce: string; expiresAt: number }>();

function memoryTryAcquire(key: string, nonce: string): boolean {
  const now = Date.now();
  const existing = memoryLocks.get(key);
  if (existing && existing.expiresAt > now) return false;
  memoryLocks.set(key, { nonce, expiresAt: now + ACTIVATION_LOCK_TTL_MS });
  return true;
}

function memoryRelease(key: string, nonce: string): void {
  const existing = memoryLocks.get(key);
  if (existing && existing.nonce === nonce) memoryLocks.delete(key);
}

/**
 * One non-blocking acquire attempt. Returns true if the lock was taken.
 * `mode` is captured by the caller so release targets the same backend even if
 * Redis availability flips between acquire and release.
 */
async function tryAcquireOnce(
  key: string,
  nonce: string,
): Promise<{ ok: boolean; mode: 'redis' | 'memory' }> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      const result = await redis.set(key, nonce, 'EX', ACTIVATION_LOCK_TTL_SECONDS, 'NX');
      return { ok: result === 'OK', mode: 'redis' };
    } catch (err) {
      // Redis threw mid-acquire (outage between the availability check and the
      // SET). Degrade THIS attempt to the in-memory path rather than failing
      // the signup closed — single-instance, so the Map is a sound fallback.
      logger.error(
        { event: 'signup_activation_lock.redis_outage', err },
        'signup activation lock SET NX failed — redis outage, degrading to in-memory lock',
      );
      return { ok: memoryTryAcquire(key, nonce), mode: 'memory' };
    }
  }
  return { ok: memoryTryAcquire(key, nonce), mode: 'memory' };
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
  | { acquired: false };

/**
 * Acquire the per-auth_token activation lock, waiting up to
 * {@link LOSER_WAIT_BUDGET_MS} for a concurrent holder to release.
 *
 * On `{ acquired: true }` the caller MUST call `release()` (in a `finally`) once
 * the activation critical section — through the finalize UPDATE — completes.
 * On `{ acquired: false }` a concurrent activation held the lock for the full
 * wait budget; the caller surfaces a retriable 409 LOCK_HELD.
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
    const { ok, mode } = await tryAcquireOnce(key, nonce);
    if (ok) {
      return {
        acquired: true,
        release: async () => {
          if (mode === 'redis') await releaseRedis(key, nonce);
          else memoryRelease(key, nonce);
        },
      };
    }
    if (Date.now() >= deadline) return { acquired: false };
    await new Promise((r) => setTimeout(r, LOSER_POLL_INTERVAL_MS));
  }
}
