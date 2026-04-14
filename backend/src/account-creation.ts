import { PrivateKey } from '@hiveio/dhive';
import { hiveClient } from './hive.js';
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
 * Claim account creation tokens in batched transactions until RC is exhausted.
 * Packs multiple claim_account ops per tx, then retries with smaller batches
 * when RC runs low. Stops when even a single claim fails.
 */
async function claimAccountTokens(): Promise<void> {
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
    try {
      await hiveClient.broadcast.sendOperations(buildClaimOps(batchSize), key);

      // Record each token individually so the count stays accurate
      await pool.query(
        'INSERT INTO account_creation_tokens SELECT FROM generate_series(1, $1)',
        [batchSize],
      );
      claimed += batchSize;
    } catch {
      // Not enough RC for this batch size — try smaller
      batchSize = Math.floor(batchSize / 2);
    }
  }

  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM account_creation_tokens WHERE used_at IS NULL',
  );
  const pending = parseInt(rows[0].count, 10);

  if (claimed > 0) {
    logger.info({ claimed, pending_tokens: pending }, 'Account token claim batch complete — RC exhausted');
  } else {
    logger.info({ pending_tokens: pending }, 'No tokens claimed — insufficient RC');
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
    const result = await hiveClient.broadcast.sendOperations(
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
  if (!config.hiveOnboardAccount || !process.env.HIVE_ONBOARD_ACTIVE_KEY) {
    logger.info('Account claimer disabled — HIVE_ONBOARD_ACCOUNT or HIVE_ONBOARD_ACTIVE_KEY not set');
    return;
  }

  // Claim immediately on startup, then every 24h
  claimAccountTokens();

  claimTimer = setInterval(claimAccountTokens, CLAIM_INTERVAL_MS);
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
