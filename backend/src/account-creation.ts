import { PrivateKey } from '@hiveio/dhive';
import { BroadcastTimeoutError, broadcastSendOperationsWithTimeout, hiveClient } from './hive.js';
import { config } from './config.js';
import { getRedis } from './redis.js';
import { logger } from './logger.js';

const CLAIM_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLAIMS_PER_TX = 50; // max claim_account ops per transaction
let claimTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Redis cache TTL for the on-chain `pending_claimed_accounts` counter.
 * Short window: stale-by-≤10s either pre-rejects a signup that would have
 * succeeded (user sees a retriable error, harmless) or admits a signup that
 * loses the consensus race (translated by `createClaimedAccount` into the
 * same retriable response). Both failure modes are graceful.
 */
const PENDING_COUNTER_CACHE_TTL_MS = 10_000;

/**
 * Build the cache key for the on-chain `pending_claimed_accounts` counter.
 * AppTag-prefixed per the Redis convention (root CLAUDE.md / `reference_redis_app_tag`).
 */
function pendingCounterCacheKey(): string {
  return `${config.appTag}:hive:pending_claimed_accounts:${config.hiveOnboardAccount}`;
}

/**
 * Build a batch of N claim_account operations.
 */
function buildClaimOps(n: number): Array<['claim_account', { creator: string; fee: string; extensions: never[] }]> {
  return Array.from({ length: n }, () => ['claim_account', {
    creator: config.hiveOnboardAccount,
    fee: '0.000 HIVE',
    extensions: [],
  }]);
}

/**
 * Read the onboarding account's on-chain `pending_claimed_accounts` counter.
 * Returns the numeric counter, or `null` if the account lookup fails or the
 * field is missing (older/exotic API responses). dhive's `ExtendedAccount`
 * type does not declare `pending_claimed_accounts`, but every current Hive
 * node returns it on `get_accounts`; we access it via a narrow cast.
 */
async function fetchPendingClaimedAccounts(accountName: string): Promise<number | null> {
  const [account] = await hiveClient.database.getAccounts([accountName]);
  if (!account) return null;
  const raw = (account as unknown as { pending_claimed_accounts?: number | string })
    .pending_claimed_accounts;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  return Number.isFinite(n) ? n : null;
}

/**
 * Read `pending_claimed_accounts` for `config.hiveOnboardAccount`, with a
 * short Redis cache (10s TTL). The consume path runs on the signup hot path,
 * so we don't want to hammer Hive APIs for every capacity check.
 *
 * Returns `null` if the chain read fails AND nothing is cached.
 *
 * Exported for unit testing only.
 */
export async function getCachedPendingClaimedAccounts(): Promise<number | null> {
  const redis = getRedis();
  const key = pendingCounterCacheKey();

  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached !== null) {
        const n = parseInt(cached, 10);
        if (Number.isFinite(n)) return n;
      }
    } catch (err) {
      logger.debug({ err }, 'pending_claimed_accounts cache read failed; falling through to chain read');
    }
  }

  const fresh = await fetchPendingClaimedAccounts(config.hiveOnboardAccount);
  if (fresh === null) return null;

  if (redis) {
    try {
      await redis.set(key, String(fresh), 'PX', PENDING_COUNTER_CACHE_TTL_MS);
    } catch (err) {
      logger.debug({ err }, 'pending_claimed_accounts cache write failed; continuing without cache');
    }
  }

  return fresh;
}

/**
 * Invalidate the cached `pending_claimed_accounts` counter so the next read
 * goes back to the chain. Called after every successful `claim_account` or
 * `create_claimed_account` broadcast.
 *
 * Exported for unit testing only.
 */
export async function invalidatePendingClaimedAccountsCache(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const cacheKey = pendingCounterCacheKey();
  try {
    await redis.del(cacheKey);
  } catch (err) {
    // Cache-del failure surfaces as a stale `pending_claimed_accounts` view
    // for up to the 10s TTL window. The two call sites have different stale-
    // cache failure modes:
    //   - After `claimAccountTokens` successfully claims more capacity, a
    //     missed invalidation leaves the cached counter stale-low (or zero),
    //     so `createClaimedAccount` pre-rejects legitimate signups with a
    //     retriable error until the TTL expires.
    //   - After `createClaimedAccount` consumes capacity, a missed
    //     invalidation leaves the cached counter stale-high, so the next
    //     consume call passes the pre-broadcast capacity check and races
    //     against the chain. The losing broadcast surfaces as a chain
    //     rejection, translated to the same retriable error shape —
    //     graceful, but the user pays a round-trip we could have avoided
    //     with a fresh read.
    // Warn so operators have a visible anchor to correlate signup-impact
    // incidents (stale-low) or extra broadcast traffic (stale-high) back to
    // a specific Redis failure.
    logger.warn(
      { err, cacheKey, event: 'account_creation.cache.invalidate_failed' },
      'pending_claimed_accounts cache invalidation failed',
    );
  }
}

/**
 * Claim account creation tokens in batched transactions until RC is exhausted.
 * Packs multiple claim_account ops per tx, then retries with smaller batches
 * when RC runs low. Stops when even a single claim fails.
 *
 * No DB mirror: per BE-ACCOUNT-CREATION-TOKENS-DROP, the on-chain
 * `pending_claimed_accounts` counter on `config.hiveOnboardAccount` is the
 * canonical view of available capacity. On `BroadcastTimeoutError` we log the
 * outcome and break the loop; the next 24h cycle reads chain state fresh and
 * decides whether to claim more.
 *
 * Exported for unit testing only; production callers use
 * `startAccountClaimer()` which schedules this on a 24h interval.
 */
export async function claimAccountTokens(): Promise<void> {
  const activeKey = process.env.HIVE_ONBOARD_ACTIVE_KEY;
  if (!activeKey) {
    logger.warn('Account token claim skipped — HIVE_ONBOARD_ACTIVE_KEY not set');
    return;
  }

  const key = PrivateKey.fromString(activeKey);
  let claimed = 0;
  let batchSize = CLAIMS_PER_TX;
  let timedOut = false;

  while (batchSize >= 1) {
    try {
      await broadcastSendOperationsWithTimeout(buildClaimOps(batchSize), key);
      claimed += batchSize;
      // Successful broadcast advanced the chain counter — invalidate cache so
      // the consume path reads a fresh value on the next signup.
      await invalidatePendingClaimedAccountsCache();
    } catch (err) {
      if (err instanceof BroadcastTimeoutError) {
        // Two-phase-timeout ambiguity: the broadcast may or may not have
        // landed. We no longer mirror the counter in a DB, so there is
        // nothing to reconcile. Log structured outcome and break; the next
        // 24h cycle reads chain state fresh.
        logger.error(
          { err, batchSize },
          'claim_account broadcast timed out — outcome ambiguous, breaking claim loop',
        );
        timedOut = true;
        // Invalidate the cache anyway — if the broadcast did land, the next
        // reader should see the fresh counter rather than a now-stale value.
        await invalidatePendingClaimedAccountsCache();
        break;
      }
      // Not enough RC for this batch size — try smaller
      batchSize = Math.floor(batchSize / 2);
    }
  }

  // Trailing log: report the on-chain counter as our pending-token view.
  let pending: number | null = null;
  try {
    pending = await fetchPendingClaimedAccounts(config.hiveOnboardAccount);
  } catch (err) {
    logger.warn({ err }, 'claimAccountTokens trailing chain read failed');
  }

  if (timedOut) {
    logger.info({ claimed, pending_claimed_accounts: pending }, 'Account token claim batch ended on broadcast timeout');
  } else if (claimed > 0) {
    logger.info({ claimed, pending_claimed_accounts: pending }, 'Account token claim batch complete — RC exhausted');
  } else {
    logger.info({ pending_claimed_accounts: pending }, 'No tokens claimed — insufficient RC');
  }
}

/**
 * Consume an account creation token and create a Hive account.
 * Returns the transaction result or throws on failure.
 *
 * Capacity is checked against the on-chain `pending_claimed_accounts` counter
 * (cached in Redis with a 10s TTL). Concurrent `create_claimed_account`
 * broadcasts are serialized by Hive consensus, not by a DB lock — a losing
 * race surfaces as a chain rejection which we translate to the same retriable
 * error response shape as the pre-broadcast check.
 */
export async function createClaimedAccount(
  newUsername: string,
  ownerPubKey: string,
  activePubKey: string,
  postingPubKey: string,
  memoPubKey: string,
): Promise<{ id: string; block_num: number }> {
  const activeKey = process.env.HIVE_ONBOARD_ACTIVE_KEY;
  if (!activeKey) throw new Error('HIVE_ONBOARD_ACTIVE_KEY not set');

  // Pre-broadcast capacity check against the on-chain counter. If the chain
  // read failed we treat it as zero-capacity and surface the same retriable
  // error — better to retry than to broadcast blind.
  const pending = await getCachedPendingClaimedAccounts();
  if (pending === null || pending <= 0) {
    throw new Error('No account creation tokens available');
  }

  try {
    const key = PrivateKey.fromString(activeKey);
    const result = await broadcastSendOperationsWithTimeout(
      [['create_claimed_account', {
        creator: config.hiveOnboardAccount,
        new_account_name: newUsername,
        owner: {
          weight_threshold: 1,
          account_auths: [],
          key_auths: [[ownerPubKey, 1]],
        },
        active: {
          weight_threshold: 1,
          account_auths: [],
          key_auths: [[activePubKey, 1]],
        },
        posting: {
          weight_threshold: 1,
          account_auths: [],
          key_auths: [[postingPubKey, 1]],
        },
        memo_key: memoPubKey,
        json_metadata: '',
        extensions: [],
      }]],
      key,
    );

    // Successful broadcast decremented the counter — invalidate cache.
    await invalidatePendingClaimedAccountsCache();
    return result;
  } catch (err) {
    // Translate consensus-rejection-on-counter to the same retriable error
    // shape as the pre-broadcast capacity check. Any node that says the
    // creator has insufficient pending claims (lost race) surfaces as a
    // chain error containing one of these specific phrases. Other broadcast
    // failures (timeouts, network errors, signature rejection) propagate
    // unchanged.
    //
    // Tight alternation matches only the two known consensus-rejection
    // strings — broader patterns (e.g. "no claim" anywhere in the message)
    // can swallow unrelated transient errors and mask their diagnostic
    // context behind the retriable shape.
    const msg = err instanceof Error ? err.message : String(err);
    if (/assertion failed: pending_claimed_accounts|no available account creation/i.test(msg)) {
      // Preserve the original error context in operator logs before we
      // collapse it to the retriable shape — the underlying message and
      // stack are otherwise lost across the throw boundary.
      logger.warn(
        { err, event: 'account_creation.broadcast.consensus_rejected' },
        'create_claimed_account rejected by chain consensus — translating to retriable',
      );
      // Counter changed under us — make sure the next reader sees fresh state.
      await invalidatePendingClaimedAccountsCache();
      throw new Error('No account creation tokens available');
    }
    throw err;
  }
}

/**
 * Start the background token claiming job (every 24 hours).
 * Claims as many tokens as RC allows in each cycle.
 */
export function startAccountClaimer(): void {
  if (!config.claimAccountTokens) {
    logger.info('Account token claiming disabled (CLAIM_ACCOUNT_TOKENS=false)');
    return;
  }
  if (!config.hiveOnboardAccount || !process.env.HIVE_ONBOARD_ACTIVE_KEY) {
    logger.info('Account claimer disabled — HIVE_ONBOARD_ACCOUNT or HIVE_ONBOARD_ACTIVE_KEY not set');
    return;
  }

  // Claim immediately on startup, then every 24h
  void claimAccountTokens();

  claimTimer = setInterval(() => { void claimAccountTokens(); }, CLAIM_INTERVAL_MS);
  claimTimer.unref();
  logger.info('Account creation token claimer started (every 24h, claims until RC exhausted)');
}

/**
 * Stop the background token claiming job.
 */
export function stopAccountClaimer(): void {
  if (claimTimer) {
    clearInterval(claimTimer);
    claimTimer = null;
  }
}
