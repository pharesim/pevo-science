/**
 * Ageing purge for the `pending_recovery` staging table.
 *
 * Real-path test against the app Postgres: seeds rows directly, runs the real
 * `purgeAgedPendingRecovery`, and asserts the DELETE predicate. No mocking —
 * the purge is a single DELETE keyed on `dispute_expires_at`, and rows are
 * isolated by a unique per-run username marker + tracked ids so the assertions
 * never depend on other rows the shared dev DB may carry. `describe.skipIf`
 * skips when the app DB is unreachable (light dev configs).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { getAppPool } from '../src/app-db.js';
import { purgeAgedPendingRecovery } from '../src/recovery-purge.js';

let dbReachable = false;
{
  const pool = getAppPool();
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  }
}

const MARKER = `purge-test-${randomBytes(6).toString('hex')}`;

async function insertRow(usernameSuffix: string, disputeExpiresAt: Date): Promise<number> {
  const pool = getAppPool()!;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pending_recovery
       (username, new_email, new_password_hash, verify_token_hash, verify_expires_at,
        dispute_token_hash, dispute_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      `${MARKER}-${usernameSuffix}`,
      `${usernameSuffix}@example.test`,
      'argon2id$staged$hash',
      randomBytes(32),
      disputeExpiresAt, // verify window mirrors dispute window for the fixture
      randomBytes(32),
      disputeExpiresAt,
    ],
  );
  return rows[0].id;
}

async function rowExists(id: number): Promise<boolean> {
  const pool = getAppPool()!;
  const { rowCount } = await pool.query('SELECT 1 FROM pending_recovery WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

describe.skipIf(!dbReachable)('pending_recovery ageing purge', () => {
  const created: number[] = [];

  afterEach(async () => {
    if (created.length) {
      const pool = getAppPool()!;
      await pool.query('DELETE FROM pending_recovery WHERE id = ANY($1::int[])', [created.splice(0)]);
    }
  });

  it('deletes rows whose dispute window closed past the grace, keeps fresh rows', async () => {
    // Expired: dispute window closed 100 days ago (well past the 24h grace).
    const expiredId = await insertRow('expired', new Date(Date.now() - 100 * 24 * 3600_000));
    // Fresh: dispute window still open (1 day in the future).
    const freshId = await insertRow('fresh', new Date(Date.now() + 24 * 3600_000));
    created.push(expiredId, freshId);

    const deleted = await purgeAgedPendingRecovery();
    expect(deleted).toBeGreaterThanOrEqual(1);

    expect(await rowExists(expiredId)).toBe(false); // purged
    expect(await rowExists(freshId)).toBe(true); // survived
  });

  it('keeps a row still inside the retention grace (recently-closed dispute window)', async () => {
    // Dispute window closed 1h ago, but the default grace is 24h — still
    // inside the grace, so the row is NOT yet purged.
    const recentId = await insertRow('recent', new Date(Date.now() - 3600_000));
    created.push(recentId);

    await purgeAgedPendingRecovery(); // default 24h grace

    expect(await rowExists(recentId)).toBe(true);
  });

  it('honors a custom grace window', async () => {
    // Dispute window closed 2h ago; a 1h grace purges it, a 24h grace keeps it.
    const id = await insertRow('custom-grace', new Date(Date.now() - 2 * 3600_000));
    created.push(id);

    await purgeAgedPendingRecovery(1 * 3600_000); // 1h grace → 2h-old row is past it
    expect(await rowExists(id)).toBe(false);
  });
});
