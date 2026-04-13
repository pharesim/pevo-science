import { PrivateKey } from '@hiveio/dhive';
import { hiveClient } from './hive.js';
import { config } from './config.js';
import { getAppPool } from './app-db.js';
import { logger } from './logger.js';

const CLAIM_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let claimTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Claim a free account creation token using RC from HIVE_ONBOARD_ACCOUNT.
 * Stores the token in the account_creation_tokens table.
 */
async function claimAccountToken(): Promise<void> {
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

  try {
    const key = PrivateKey.fromString(activeKey);
    await hiveClient.broadcast.sendOperations(
      [['claim_account', {
        creator: config.hiveOnboardAccount,
        fee: '0.000 HIVE',
        extensions: [],
      }]],
      key,
    );

    await pool.query('INSERT INTO account_creation_tokens DEFAULT VALUES');

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM account_creation_tokens WHERE used_at IS NULL',
    );
    logger.info(
      { pending_tokens: parseInt(rows[0].count, 10) },
      'Claimed account creation token',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to claim account creation token');
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
 * Start the background token claiming job (every 6 hours).
 */
export function startAccountClaimer(): void {
  if (!config.hiveOnboardAccount || !process.env.HIVE_ONBOARD_ACTIVE_KEY) {
    logger.info('Account claimer disabled — HIVE_ONBOARD_ACCOUNT or HIVE_ONBOARD_ACTIVE_KEY not set');
    return;
  }

  // Claim one immediately on startup
  claimAccountToken();

  claimTimer = setInterval(claimAccountToken, CLAIM_INTERVAL_MS);
  claimTimer.unref();
  logger.info('Account creation token claimer started (every 6h)');
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
