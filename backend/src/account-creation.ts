import { PrivateKey } from '@hiveio/dhive';
import type pg from 'pg';
import { BroadcastTimeoutError, broadcastSendOperationsWithTimeout, hiveClient } from './hive.js';
import { config } from './config.js';
import { getAppPool } from './app-db.js';
import { logger } from './logger.js';

const CLAIM_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLAIMS_PER_TX = 50; // max claim_account ops per transaction
let claimTimer: ReturnType<typeof setInterval> | null = null;

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
 * Reconcile the DB `account_creation_tokens` table with the on-chain
 * `pending_claimed_accounts` counter after a `claim_account` broadcast
 * timed out with ambiguous outcome. Compares the post-broadcast counter
 * against `preCounter` and INSERTs `delta` token rows (bounded by
 * `batchSize`: extra claims from a parallel admin-account actor are not
 * ours to count).
 *
 * Returns the number of DB rows inserted. If the post-broadcast chain read
 * fails or `preCounter` was unavailable, returns 0 and logs — the next
 * claim cycle will retry from a clean state.
 */
async function reconcileClaimTimeout(
  pool: pg.Pool,
  err: BroadcastTimeoutError,
  batchSize: number,
  preCounter: number | null,
): Promise<number> {
  if (preCounter === null) {
    logger.error(
      { err, batchSize },
      'claim_account broadcast timed out — no pre-counter available, reconcile skipped',
    );
    return 0;
  }

  let postCounter: number | null;
  try {
    postCounter = await fetchPendingClaimedAccounts(config.hiveOnboardAccount);
  } catch (reconcileErr) {
    logger.error(
      { err, reconcileErr, batchSize, preCounter },
      'claim_account broadcast timed out — post-counter read failed, reconcile skipped',
    );
    return 0;
  }
  if (postCounter === null) {
    logger.error(
      { err, batchSize, preCounter },
      'claim_account broadcast timed out — post-counter unavailable, reconcile skipped',
    );
    return 0;
  }

  const rawDelta = postCounter - preCounter;
  // Clamp: negative delta is nonsense (the account burned claims between
  // reads); delta > batchSize means someone else claimed on the same
  // account during our broadcast window — only count up to our batchSize.
  const inserted = Math.max(0, Math.min(rawDelta, batchSize));

  if (inserted === 0) {
    logger.error(
      { err, batchSize, preCounter, postCounter, inserted },
      'claim_account broadcast timed out — reconciled 0/batchSize from chain (nothing landed)',
    );
    return 0;
  }

  try {
    await pool.query(
      'INSERT INTO account_creation_tokens SELECT FROM generate_series(1, $1)',
      [inserted],
    );
  } catch (dbErr) {
    logger.error(
      { err, dbErr, batchSize, preCounter, postCounter, inserted },
      'claim_account broadcast timed out — reconcile INSERT failed, DB may still diverge from chain',
    );
    return 0;
  }

  if (inserted < batchSize) {
    logger.warn(
      { err, batchSize, preCounter, postCounter, inserted },
      `claim_account broadcast timed out — reconciled ${inserted}/${batchSize} from chain (partial landing)`,
    );
  } else {
    logger.error(
      { err, batchSize, preCounter, postCounter, inserted },
      `claim_account broadcast timed out — reconciled ${inserted}/${batchSize} from chain (full landing)`,
    );
  }
  return inserted;
}

/**
 * Claim account creation tokens in batched transactions until RC is exhausted.
 * Packs multiple claim_account ops per tx, then retries with smaller batches
 * when RC runs low. Stops when even a single claim fails.
 *
 * Exported for unit testing only; production callers use
 * `startAccountClaimer()` which schedules this on a 24h interval.
 */
export async function claimAccountTokens(): Promise<void> {
  const pool = getAppPool();
  if (!pool) {
    logger.warn('Account token claim skipped — no app database');
    return;
  }

  const activeKey = process.env.HIVE_ONBOARD_ACTIVE_KEY;
  if (!activeKey) {
    logger.warn('Account token claim skipped — HIVE_ONBOARD_ACTIVE_KEY not set');
    return;
  }

  const key = PrivateKey.fromString(activeKey);
  let claimed = 0;
  let batchSize = CLAIMS_PER_TX;

  while (batchSize >= 1) {
    // Capture the on-chain pending counter BEFORE the broadcast so we can
    // reconcile if the broadcast times out with outcome uncertain. A `null`
    // pre-counter means we could not read the account; in that case we
    // cannot reconcile on timeout and will log-and-skip.
    const preCounter = await fetchPendingClaimedAccounts(config.hiveOnboardAccount)
      .catch((err) => {
        logger.warn(
          { err, account: config.hiveOnboardAccount },
          'claim_account pre-broadcast counter read failed — reconcile on timeout disabled for this batch',
        );
        return null;
      });

    try {
      await broadcastSendOperationsWithTimeout(buildClaimOps(batchSize), key);

      // Record each token individually so the count stays accurate
      await pool.query(
        'INSERT INTO account_creation_tokens SELECT FROM generate_series(1, $1)',
        [batchSize],
      );
      claimed += batchSize;
    } catch (err) {
      // A broadcast timeout is NOT an RC-exhaustion signal: the tx may have
      // landed on chain during the slow broadcast phase (dhive's preflight-
      // read-then-broadcast pattern, see `broadcastSendOperationsWithTimeout`
      // docblock). Halving and retrying would rebroadcast the same claim
      // batch and, if the first landed, double-count claims relative to the
      // DB (we only INSERT on clean resolve). Instead, read the on-chain
      // `pending_claimed_accounts` counter and INSERT any delta into the DB
      // so token count eventually catches up to chain state.
      if (err instanceof BroadcastTimeoutError) {
        const reconciled = await reconcileClaimTimeout(pool, err, batchSize, preCounter);
        claimed += reconciled;
        break;
      }
      // Not enough RC for this batch size — try smaller
      batchSize = Math.floor(batchSize / 2);
    }
  }

  try {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM account_creation_tokens WHERE used_at IS NULL',
    );
    const pending = parseInt(rows[0].count, 10);

    if (claimed > 0) {
      logger.info({ claimed, pending_tokens: pending }, 'Account token claim batch complete — RC exhausted');
    } else {
      logger.info({ pending_tokens: pending }, 'No tokens claimed — insufficient RC');
    }
  } catch (err) {
    logger.warn({ err }, 'claimAccountTokens trailing count query failed');
  }
}

/**
 * Consume an account creation token and create a Hive account.
 * Returns the transaction result or throws on failure.
 */
export async function createClaimedAccount(
  newUsername: string,
  ownerPubKey: string,
  activePubKey: string,
  postingPubKey: string,
  memoPubKey: string,
): Promise<{ id: string; block_num: number }> {
  const pool = getAppPool();
  if (!pool) throw new Error('App database not configured');

  const activeKey = process.env.HIVE_ONBOARD_ACTIVE_KEY;
  if (!activeKey) throw new Error('HIVE_ONBOARD_ACTIVE_KEY not set');

  // Reserve a token
  const { rows } = await pool.query<{ id: number }>(
    `UPDATE account_creation_tokens
     SET used_at = NOW(), used_for = $1
     WHERE id = (
       SELECT id FROM account_creation_tokens
       WHERE used_at IS NULL
       ORDER BY id LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [newUsername],
  );
  if (rows.length === 0) {
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

    return result;
  } catch (err) {
    // Release the token on broadcast failure
    await pool.query(
      'UPDATE account_creation_tokens SET used_at = NULL, used_for = NULL WHERE id = $1',
      [rows[0].id],
    );
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
