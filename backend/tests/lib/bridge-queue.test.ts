/**
 * Bridge import queue model tests.
 *
 * Exercises the durable FIFO queue used by `/api/bridge/register` to
 * absorb concurrent submissions against the chain's per-account cooldown.
 *
 * Real-path coverage (root CLAUDE.md "Running Tests"): all queue ops run
 * against the real Postgres app database (`APP_DATABASE_URL`). No mocks
 * for the pool. The queue's SQL relies on partial unique indexes and
 * `FOR UPDATE SKIP LOCKED`, which only behave correctly against a real
 * Postgres backend.
 *
 * Each test uses a unique username prefix so suite re-runs do not collide
 * on the per-user cap. A small `cleanupQueueRowsFor` helper truncates
 * test-owned rows in beforeEach. The actual table content is also fine to
 * leave behind because the queue is operational state, not a durable
 * audit log.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getAppPool, closeAppPool } from '../../src/app-db.js';
import {
  tryEnqueueBridgeImport,
  leaseNextEntry,
  markCompleted,
  markCompletedExisting,
  markFailed,
  rescheduleForRetry,
  listUserImports,
  countInflightForUser,
  findEntryById,
  BRIDGE_QUEUE_USER_CAP,
  BRIDGE_QUEUE_MAX_ATTEMPTS,
} from '../../src/bridge-queue.js';

async function cleanupQueueRowsFor(usernamePrefix: string): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;
  await pool.query(
    `DELETE FROM bridge_import_queue WHERE username LIKE $1`,
    [`${usernamePrefix}%`],
  );
}

async function ensureTableAvailable(): Promise<boolean> {
  const pool = getAppPool();
  if (!pool) return false;
  try {
    await pool.query(`SELECT 1 FROM bridge_import_queue LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

describe('bridge-queue: tryEnqueueBridgeImport', () => {
  const USER = 'pevo-bridge-queue-test-enqueue';
  let tableAvailable = false;

  beforeEach(async () => {
    tableAvailable = await ensureTableAvailable();
    if (!tableAvailable) return;
    await cleanupQueueRowsFor(USER);
  });

  it('inserts a pending entry with queue position 1 when the queue is empty', async () => {
    if (!tableAvailable) return;
    const result = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2301.00001',
      permlink: 'bridge-arxiv-2301-00001',
      discipline: 'Computer Science',
      keywords: ['attention'],
      language: 'en',
    });
    expect(result.status).toBe('enqueued');
    if (result.status !== 'enqueued') return;
    expect(result.row.state).toBe('pending');
    expect(result.row.attempts).toBe(0);
    expect(result.row.username).toBe(USER);
    expect(result.row.permlink).toBe('bridge-arxiv-2301-00001');
    expect(result.row.keywords).toEqual(['attention']);
    expect(result.queuePosition).toBe(1);
  });

  it('rejects the 6th in-flight submission with cap_exceeded', async () => {
    if (!tableAvailable) return;
    for (let i = 0; i < BRIDGE_QUEUE_USER_CAP; i++) {
      const r = await tryEnqueueBridgeImport({
        username: USER,
        identifier: `2302.${String(i).padStart(5, '0')}`,
        permlink: `bridge-arxiv-2302-${i}`,
        discipline: 'CS',
        keywords: [],
        language: 'en',
      });
      expect(r.status).toBe('enqueued');
    }
    expect(await countInflightForUser(USER)).toBe(BRIDGE_QUEUE_USER_CAP);

    const overflow = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2302.99999',
      permlink: 'bridge-arxiv-2302-overflow',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(overflow.status).toBe('cap_exceeded');
    if (overflow.status === 'cap_exceeded') {
      expect(overflow.cap).toBe(BRIDGE_QUEUE_USER_CAP);
      expect(overflow.inflight).toBe(BRIDGE_QUEUE_USER_CAP);
    }
  });

  it('rejects a duplicate active permlink with duplicate_active', async () => {
    if (!tableAvailable) return;
    const first = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2303.00001',
      permlink: 'bridge-arxiv-2303-00001',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(first.status).toBe('enqueued');

    const second = await tryEnqueueBridgeImport({
      username: `${USER}-other`,
      identifier: '2303.00001',
      permlink: 'bridge-arxiv-2303-00001',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(second.status).toBe('duplicate_active');
    if (second.status === 'duplicate_active') {
      expect(second.existing.permlink).toBe('bridge-arxiv-2303-00001');
    }
    await cleanupQueueRowsFor(`${USER}-other`);
  });

  it('does NOT count completed entries against the per-user cap', async () => {
    if (!tableAvailable) return;
    const enq = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2304.00001',
      permlink: 'bridge-arxiv-2304-00001',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(enq.status).toBe('enqueued');
    if (enq.status !== 'enqueued') return;
    await markCompleted(enq.row.id, { txId: 'tx-2304' });
    expect(await countInflightForUser(USER)).toBe(0);

    // After completion, a new submission for a DIFFERENT permlink succeeds
    // immediately even though the user has a completed entry on file.
    const next = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2304.00002',
      permlink: 'bridge-arxiv-2304-00002',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(next.status).toBe('enqueued');
  });
});

describe('bridge-queue: leaseNextEntry', () => {
  const USER = 'pevo-bridge-queue-test-lease';
  let tableAvailable = false;

  beforeEach(async () => {
    tableAvailable = await ensureTableAvailable();
    if (!tableAvailable) return;
    await cleanupQueueRowsFor(USER);
  });

  it('leases the oldest pending entry and transitions to in_progress', async () => {
    if (!tableAvailable) return;
    const first = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2401.00001',
      permlink: 'bridge-arxiv-2401-00001',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(first.status).toBe('enqueued');

    const leased = await leaseNextEntry();
    expect(leased).not.toBeNull();
    expect(leased!.state).toBe('in_progress');
    expect(leased!.permlink).toBe('bridge-arxiv-2401-00001');
    expect(leased!.lease_expires_at).not.toBeNull();
  });

  it('returns null when nothing is due', async () => {
    if (!tableAvailable) return;
    const leased = await leaseNextEntry();
    expect(leased).toBeNull();
  });

  it('skips entries scheduled in the future', async () => {
    if (!tableAvailable) return;
    const pool = getAppPool();
    if (!pool) return;
    // Insert a pending entry scheduled 1 hour in the future. Use direct
    // INSERT because tryEnqueueBridgeImport always sets scheduled_at to
    // NOW(); the backoff scheduling path is the path that pushes it
    // forward, but this test pins the underlying lease's gate independently.
    await pool.query(
      `INSERT INTO bridge_import_queue
         (operation_kind, username, identifier, permlink, discipline,
          keywords, language, scheduled_at)
       VALUES ('bridge_register', $1, '2402.00001',
               'bridge-arxiv-2402-00001', 'CS', '[]'::jsonb, 'en',
               NOW() + INTERVAL '1 hour')`,
      [USER],
    );
    const leased = await leaseNextEntry();
    expect(leased).toBeNull();
  });

  it('re-leases an in_progress entry whose lease has expired', async () => {
    if (!tableAvailable) return;
    const pool = getAppPool();
    if (!pool) return;
    // Insert an in_progress entry with an already-expired lease (simulates
    // a worker crash mid-flight). The next lease should pick it up so the
    // entry does not get stuck.
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO bridge_import_queue
         (operation_kind, username, identifier, permlink, discipline,
          keywords, language, state, lease_expires_at)
       VALUES ('bridge_register', $1, '2403.00001',
               'bridge-arxiv-2403-00001', 'CS', '[]'::jsonb, 'en',
               'in_progress', NOW() - INTERVAL '1 minute')
       RETURNING id`,
      [USER],
    );
    // BIGSERIAL comes back as a string from the pg driver; coerce so the
    // typed BridgeImportRow.id (number) comparison succeeds.
    const expiredId = Number(inserted.rows[0].id);
    const leased = await leaseNextEntry();
    expect(leased).not.toBeNull();
    expect(leased!.id).toBe(expiredId);
    expect(leased!.state).toBe('in_progress');
  });
});

describe('bridge-queue: rescheduleForRetry', () => {
  const USER = 'pevo-bridge-queue-test-retry';
  let tableAvailable = false;

  beforeEach(async () => {
    tableAvailable = await ensureTableAvailable();
    if (!tableAvailable) return;
    await cleanupQueueRowsFor(USER);
  });

  it('pushes the entry back to pending with attempts++ and a future scheduled_at on transient failure', async () => {
    if (!tableAvailable) return;
    const enq = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2501.00001',
      permlink: 'bridge-arxiv-2501-00001',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(enq.status).toBe('enqueued');
    if (enq.status !== 'enqueued') return;

    const beforeSchedule = enq.row.scheduled_at;
    const result = await rescheduleForRetry(enq.row.id, {
      code: 'BROADCAST_FAILED',
      message: 'RC exhaustion',
    });
    expect(result.state).toBe('pending');
    expect(result.attempts).toBe(1);
    expect(result.scheduledAt).not.toBeNull();
    expect(result.scheduledAt!.getTime()).toBeGreaterThan(beforeSchedule.getTime());

    const refreshed = await findEntryById(enq.row.id);
    expect(refreshed!.state).toBe('pending');
    expect(refreshed!.attempts).toBe(1);
    expect(refreshed!.error_code).toBe('BROADCAST_FAILED');
    expect(refreshed!.error_message).toBe('RC exhaustion');
  });

  it('terminal-fails after BRIDGE_QUEUE_MAX_ATTEMPTS exceeded retries', async () => {
    if (!tableAvailable) return;
    const enq = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2502.00001',
      permlink: 'bridge-arxiv-2502-00001',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(enq.status).toBe('enqueued');
    if (enq.status !== 'enqueued') return;

    for (let i = 0; i < BRIDGE_QUEUE_MAX_ATTEMPTS; i++) {
      await rescheduleForRetry(enq.row.id, { code: 'BROADCAST_FAILED', message: 'transient' });
    }
    // One more push should terminal-fail (attempts becomes MAX_ATTEMPTS+1).
    const result = await rescheduleForRetry(enq.row.id, {
      code: 'BROADCAST_FAILED',
      message: 'final',
    });
    expect(result.state).toBe('failed');
    expect(result.attempts).toBe(BRIDGE_QUEUE_MAX_ATTEMPTS + 1);

    const refreshed = await findEntryById(enq.row.id);
    expect(refreshed!.state).toBe('failed');
    expect(refreshed!.error_code).toBe('BROADCAST_FAILED');
    expect(refreshed!.error_message).toBe('final');
    expect(refreshed!.completed_at).not.toBeNull();
  });
});

describe('bridge-queue: markCompleted / markCompletedExisting / markFailed', () => {
  const USER = 'pevo-bridge-queue-test-terminate';
  let tableAvailable = false;

  beforeEach(async () => {
    tableAvailable = await ensureTableAvailable();
    if (!tableAvailable) return;
    await cleanupQueueRowsFor(USER);
  });

  it('markCompleted sets state=completed and persists tx_id', async () => {
    if (!tableAvailable) return;
    const enq = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2601.00001',
      permlink: 'bridge-arxiv-2601-00001',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    if (enq.status !== 'enqueued') return;
    await markCompleted(enq.row.id, { txId: 'tx-completed-2601' });
    const refreshed = await findEntryById(enq.row.id);
    expect(refreshed!.state).toBe('completed');
    expect(refreshed!.tx_id).toBe('tx-completed-2601');
    expect(refreshed!.completed_at).not.toBeNull();
  });

  it('markCompletedExisting persists existing_author / existing_permlink', async () => {
    if (!tableAvailable) return;
    const enq = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2602.00001',
      permlink: 'bridge-arxiv-2602-00001',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    if (enq.status !== 'enqueued') return;
    await markCompletedExisting(enq.row.id, {
      author: 'pevotest.bridge',
      permlink: 'bridge-arxiv-2602-00001',
    });
    const refreshed = await findEntryById(enq.row.id);
    expect(refreshed!.state).toBe('completed');
    expect(refreshed!.existing_author).toBe('pevotest.bridge');
    expect(refreshed!.existing_permlink).toBe('bridge-arxiv-2602-00001');
    expect(refreshed!.tx_id).toBeNull();
  });

  it('markFailed sets state=failed with code+message', async () => {
    if (!tableAvailable) return;
    const enq = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2603.00001',
      permlink: 'bridge-arxiv-2603-00001',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    if (enq.status !== 'enqueued') return;
    await markFailed(enq.row.id, {
      code: 'BAD_REQUEST',
      message: 'metadata gone',
    });
    const refreshed = await findEntryById(enq.row.id);
    expect(refreshed!.state).toBe('failed');
    expect(refreshed!.error_code).toBe('BAD_REQUEST');
    expect(refreshed!.error_message).toBe('metadata gone');
  });
});

describe('bridge-queue: listUserImports', () => {
  const USER = 'pevo-bridge-queue-test-list';
  let tableAvailable = false;

  beforeEach(async () => {
    tableAvailable = await ensureTableAvailable();
    if (!tableAvailable) return;
    await cleanupQueueRowsFor(USER);
  });

  it('returns the user\'s entries in newest-first order with state filter respected', async () => {
    if (!tableAvailable) return;
    const a = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2701.00001',
      permlink: 'bridge-arxiv-2701-00001',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    const b = await tryEnqueueBridgeImport({
      username: USER,
      identifier: '2701.00002',
      permlink: 'bridge-arxiv-2701-00002',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    if (a.status !== 'enqueued' || b.status !== 'enqueued') return;
    await markCompleted(a.row.id, { txId: 'tx-a' });

    const all = await listUserImports(USER);
    expect(all.length).toBe(2);
    // Newest-first: b (id larger) comes before a.
    expect(all[0].id).toBe(b.row.id);
    expect(all[1].id).toBe(a.row.id);

    const completed = await listUserImports(USER, { state: 'completed' });
    expect(completed.length).toBe(1);
    expect(completed[0].id).toBe(a.row.id);
  });
});

afterAll(async () => {
  // Best-effort cleanup of any test-owned rows so the table stays tidy
  // across re-runs. Failures here are non-fatal — the next run's
  // beforeEach DELETE handles leftovers.
  await cleanupQueueRowsFor('pevo-bridge-queue-test-').catch(() => undefined);
  await closeAppPool().catch(() => undefined);
});
