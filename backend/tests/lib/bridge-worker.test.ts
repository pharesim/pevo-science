/**
 * Bridge import queue worker dispatch tests.
 *
 * Exercises `dispatchEntry`, `runWorkerTick`, and `startBridgeWorker` from
 * `bridge-worker.ts` — the in-process dispatcher that pulls queue entries
 * and broadcasts them at the chain's per-account cadence.
 *
 * Test-mock carve-out (root CLAUDE.md "Carve-out for deterministic
 * edge-case coverage"):
 *
 *   (a) Real paths that are impractical here, and what we mock:
 *       - `broadcastSendOperationsWithTimeout` (`hive.js`): a unit test
 *         cannot reliably broadcast to Hive, nor induce a 30s broadcast
 *         timeout against a live node, nor force a post-broadcast outcome
 *         on demand. Mocked so each dispatch branch (success, timeout,
 *         non-timeout failure) is deterministic.
 *       - `lookupPreprint` / `resolveToCanonical` (`bridge.js`): external
 *         arXiv/Crossref fetches, non-deterministic and network-bound.
 *         Mocked so the metadata-throw and metadata-null branches fire on
 *         demand. `buildBridgeBody` / `buildBridgeMetadata` are mocked as
 *         pure transforms whose output the broadcast mock ignores.
 *       - `getPool` / `isHafConfigured` (`db.js`, the HAF pool): the
 *         worker's pre-broadcast `checkExistingOnChain` runs against HAF; a
 *         real variant needs a seeded on-chain bridge post plus indexing
 *         lag. Mocked so the haf-unavailable and permlink-collision
 *         branches are deterministic.
 *       - `getRequiredBridgePostingKey` (`startup-checks.js`): mocked so
 *         the key-cache-unpopulated terminal branch fires without a real
 *         env-loaded key.
 *       - `leaseNextEntry` (`bridge-queue.js`): partial-mocked ONLY for the
 *         `runWorkerTick` / re-entrancy / seeding tests so the worker leases
 *         a controlled entry rather than the global oldest-due row. The
 *         suite runs at `maxWorkers: 2`; a real global lease could steal a
 *         sibling file's row and corrupt its assertions.
 *       - `markCompleted` (`bridge-queue.js`): wrapped in a mock that defaults
 *         to the REAL implementation, so every test except the
 *         post-broadcast-write-failure case persists completion state for real
 *         against Postgres. The post-broadcast-write-failure branch
 *         (broadcast lands, completion write throws → reschedule with
 *         `COMPLETION_WRITE_FAILED`) is unreachable with a healthy app DB; the
 *         only way to exercise it deterministically is to force the completion
 *         write to reject after the broadcast mock resolves, so that one test
 *         overrides the wrapper to reject.
 *       Every OTHER `bridge-queue` function (`rescheduleForRetry`,
 *         `markFailed`, `markCompletedExisting`, `getLastSuccessfulBroadcastAt`,
 *         `tryEnqueueBridgeImport`, `findEntryById`) runs REAL against the
 *         Postgres app database — the queue's source of truth is never
 *         otherwise mocked. Dispatch-test rows are inserted as `in_progress`
 *         with a non-expired lease so they are invisible to a sibling's
 *         `leaseNextEntry`.
 *
 *   (b) The worker has no auth middleware — it is a background dispatcher,
 *       not a route — so there is no `verifyHiveSignature` path to preserve.
 *
 *   (c) Real-path companions for the same risk classes:
 *       - Queue state transitions (markCompleted/reschedule/markFailed/lease)
 *         run real against Postgres in `tests/lib/bridge-queue.test.ts`.
 *       - The route's real `verifyHiveSignature` + read-then-write path is
 *         covered by `tests/routes/bridge.test.ts` and
 *         `tests/routes/bridge-haf-lag-locks.test.ts`.
 *       The risk class this file pins — which terminal/reschedule branch the
 *       dispatcher routes to for each failure mode — cannot run real
 *       broadcasts, so it is covered here with the boundary mocks above.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
// Type-only import: erased at compile, so it does not load the module before
// the vi.mock factories below are applied.
import type { BridgeImportRow } from '../../src/bridge-queue.js';

const {
  broadcastMock,
  lookupPreprintMock,
  resolveToCanonicalMock,
  buildBridgeBodyMock,
  buildBridgeMetadataMock,
  getRequiredBridgePostingKeyMock,
  getPoolMock,
  isHafConfiguredMock,
  leaseNextEntryMock,
  markCompletedMock,
} = vi.hoisted(() => ({
  broadcastMock: vi.fn(),
  lookupPreprintMock: vi.fn(),
  resolveToCanonicalMock: vi.fn(),
  buildBridgeBodyMock: vi.fn(),
  buildBridgeMetadataMock: vi.fn(),
  getRequiredBridgePostingKeyMock: vi.fn(),
  getPoolMock: vi.fn(),
  isHafConfiguredMock: vi.fn(),
  leaseNextEntryMock: vi.fn(),
  markCompletedMock: vi.fn(),
}));

vi.mock('../../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hive.js')>('../../src/hive.js');
  return { ...actual, broadcastSendOperationsWithTimeout: broadcastMock };
});

vi.mock('../../src/bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/bridge.js')>('../../src/bridge.js');
  return {
    ...actual,
    lookupPreprint: lookupPreprintMock,
    resolveToCanonical: resolveToCanonicalMock,
    buildBridgeBody: buildBridgeBodyMock,
    buildBridgeMetadata: buildBridgeMetadataMock,
  };
});

vi.mock('../../src/startup-checks.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/startup-checks.js')>('../../src/startup-checks.js');
  return { ...actual, getRequiredBridgePostingKey: getRequiredBridgePostingKeyMock };
});

vi.mock('../../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
  return { ...actual, getPool: getPoolMock, isHafConfigured: isHafConfiguredMock };
});

vi.mock('../../src/bridge-queue.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/bridge-queue.js')>('../../src/bridge-queue.js');
  // `markCompletedMock` defaults to the real implementation so every test
  // EXCEPT the post-broadcast-write-failure case writes completion state for
  // real against Postgres. The COMPLETION_WRITE_FAILED test overrides it to
  // reject after the broadcast mock resolves. The default is re-established in
  // `resetMockDefaults` (mockReset clears it between tests).
  markCompletedMock.mockImplementation(actual.markCompleted);
  return { ...actual, leaseNextEntry: leaseNextEntryMock, markCompleted: markCompletedMock };
});

const { dispatchEntry, runWorkerTick, startBridgeWorker, stopBridgeWorker, _resetBridgeWorkerForTests } =
  await import('../../src/bridge-worker.js');
const { BroadcastTimeoutError } = await import('../../src/hive.js');
const { BridgeKeyCacheUnpopulated } = await import('../../src/startup-checks.js');
const {
  findEntryById,
  getLastSuccessfulBroadcastAt,
  BRIDGE_QUEUE_MAX_ATTEMPTS,
} = await import('../../src/bridge-queue.js');
// Real (unmocked) markCompleted, used to restore the delegating default after
// each test's mockReset so non-failure cases write completion for real.
const { markCompleted: realMarkCompleted } =
  await vi.importActual<typeof import('../../src/bridge-queue.js')>('../../src/bridge-queue.js');
const { getAppPool, closeAppPool } = await import('../../src/app-db.js');

const USER_PREFIX = 'pevo-bridge-worker-test';
let seq = 0;

async function tableAvailable(): Promise<boolean> {
  const pool = getAppPool();
  if (!pool) return false;
  try {
    await pool.query('SELECT 1 FROM bridge_import_queue LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

async function cleanup(): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;
  await pool.query('DELETE FROM bridge_import_queue WHERE username LIKE $1', [`${USER_PREFIX}%`]);
}

/**
 * Insert a row already leased to this (mocked) worker: state `in_progress`
 * with a lease 5 minutes out. Such a row is NOT due for `leaseNextEntry`
 * (not pending, lease not expired), so a concurrent sibling test file
 * cannot steal it. Returned typed via the real `findEntryById`.
 */
async function insertLeasedEntry(suffix: string): Promise<BridgeImportRow> {
  const pool = getAppPool();
  if (!pool) throw new Error('app pool unavailable');
  const n = seq++;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO bridge_import_queue
       (operation_kind, username, identifier, permlink, discipline,
        keywords, language, state, lease_expires_at)
     VALUES ('bridge_register', $1, $2, $3, 'CS', '[]'::jsonb, 'en',
             'in_progress', NOW() + INTERVAL '5 minutes')
     RETURNING id`,
    [`${USER_PREFIX}-${suffix}`, `worker-${suffix}-${n}`, `bridge-worker-${suffix}-${n}`],
  );
  const entry = await findEntryById(Number(rows[0].id));
  if (!entry) throw new Error('insert/find failed');
  return entry;
}

function resetMockDefaults(): void {
  broadcastMock.mockReset();
  lookupPreprintMock.mockReset();
  resolveToCanonicalMock.mockReset();
  buildBridgeBodyMock.mockReset();
  buildBridgeMetadataMock.mockReset();
  getRequiredBridgePostingKeyMock.mockReset();
  getPoolMock.mockReset();
  isHafConfiguredMock.mockReset();
  leaseNextEntryMock.mockReset();
  markCompletedMock.mockReset();
  // Default: completion writes run real against Postgres. The
  // post-broadcast-write-failure test overrides this to reject.
  markCompletedMock.mockImplementation(realMarkCompleted);

  // Happy-path defaults; individual tests override the branch they target.
  resolveToCanonicalMock.mockResolvedValue({ type: 'arxiv', id: '2401.00001' });
  lookupPreprintMock.mockResolvedValue({ title: 'Test Bridge Paper' });
  buildBridgeBodyMock.mockReturnValue('body markdown');
  buildBridgeMetadataMock.mockReturnValue({ app: 'pevotest' });
  getRequiredBridgePostingKeyMock.mockReturnValue('FAKE-PRIVATE-KEY');
  // Default: HAF not configured → checkExistingOnChain returns 'none' and
  // the broadcast path proceeds. Collision / outage tests flip these.
  isHafConfiguredMock.mockReturnValue(false);
  getPoolMock.mockReturnValue(null);
  broadcastMock.mockResolvedValue({ id: 'tx-default' });
  _resetBridgeWorkerForTests();
}

let available = false;

beforeEach(async () => {
  available = await tableAvailable();
  if (!available) return;
  await cleanup();
  resetMockDefaults();
});

afterAll(async () => {
  stopBridgeWorker();
  await cleanup().catch(() => undefined);
  await closeAppPool().catch(() => undefined);
});

describe('bridge-worker: dispatchEntry', () => {
  it('broadcast success → completed with tx_id (cooldown recorded before the completion write)', async () => {
    if (!available) return;
    broadcastMock.mockResolvedValue({ id: 'tx-success-1' });
    const entry = await insertLeasedEntry('success');
    await dispatchEntry(entry);
    const r = await findEntryById(entry.id);
    expect(r!.state).toBe('completed');
    expect(r!.tx_id).toBe('tx-success-1');
    expect(r!.completed_at).not.toBeNull();
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('broadcast timeout → pending reschedule, attempts incremented, BROADCAST_TIMEOUT', async () => {
    if (!available) return;
    broadcastMock.mockRejectedValue(new BroadcastTimeoutError(30_000));
    const entry = await insertLeasedEntry('timeout');
    await dispatchEntry(entry);
    const r = await findEntryById(entry.id);
    expect(r!.state).toBe('pending');
    expect(r!.attempts).toBe(1);
    expect(r!.error_code).toBe('BROADCAST_TIMEOUT');
  });

  it('non-timeout broadcast failure → pending reschedule, attempts incremented, BROADCAST_FAILED', async () => {
    if (!available) return;
    broadcastMock.mockRejectedValue(new Error('RC exhausted'));
    const entry = await insertLeasedEntry('bcast-fail');
    await dispatchEntry(entry);
    const r = await findEntryById(entry.id);
    expect(r!.state).toBe('pending');
    expect(r!.attempts).toBe(1);
    expect(r!.error_code).toBe('BROADCAST_FAILED');
  });

  it('retry exhaustion → terminal failed at MAX_ATTEMPTS+1', async () => {
    if (!available) return;
    const entry = await insertLeasedEntry('exhaust');
    // Pre-load the attempt counter to the cap; the next broadcast failure
    // increments past it and terminal-fails. rescheduleForRetry reads
    // attempts from the row, so the stale in-memory value does not matter.
    const pool = getAppPool();
    await pool!.query('UPDATE bridge_import_queue SET attempts = $2 WHERE id = $1', [
      entry.id,
      BRIDGE_QUEUE_MAX_ATTEMPTS,
    ]);
    broadcastMock.mockRejectedValue(new Error('still failing'));
    await dispatchEntry(entry);
    const r = await findEntryById(entry.id);
    expect(r!.state).toBe('failed');
    expect(r!.attempts).toBe(BRIDGE_QUEUE_MAX_ATTEMPTS + 1);
    expect(r!.error_code).toBe('BROADCAST_FAILED');
  });

  it('HAF unavailable → reschedule WITHOUT consuming the broadcast budget, no broadcast', async () => {
    if (!available) return;
    isHafConfiguredMock.mockReturnValue(true);
    getPoolMock.mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('HAF down')) });
    const entry = await insertLeasedEntry('haf-down');
    await dispatchEntry(entry);
    const r = await findEntryById(entry.id);
    expect(r!.state).toBe('pending');
    // Pre-broadcast outage: attempts must NOT advance, or a sustained HAF
    // outage would terminal-fail a valid submission that never broadcast.
    expect(r!.attempts).toBe(0);
    expect(r!.error_code).toBe('SERVICE_UNAVAILABLE');
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('metadata fetch throws → reschedule WITHOUT consuming budget, no broadcast', async () => {
    if (!available) return;
    lookupPreprintMock.mockRejectedValue(new Error('arxiv unreachable'));
    const entry = await insertLeasedEntry('meta-throw');
    await dispatchEntry(entry);
    const r = await findEntryById(entry.id);
    expect(r!.state).toBe('pending');
    expect(r!.attempts).toBe(0);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('metadata null → terminal failed, no broadcast', async () => {
    if (!available) return;
    lookupPreprintMock.mockResolvedValue(null);
    const entry = await insertLeasedEntry('meta-null');
    await dispatchEntry(entry);
    const r = await findEntryById(entry.id);
    expect(r!.state).toBe('failed');
    expect(r!.error_code).toBe('BAD_REQUEST');
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('key cache unpopulated → terminal failed (SERVICE_UNAVAILABLE), no broadcast', async () => {
    if (!available) return;
    getRequiredBridgePostingKeyMock.mockImplementation(() => {
      throw new BridgeKeyCacheUnpopulated();
    });
    const entry = await insertLeasedEntry('key-unpop');
    await dispatchEntry(entry);
    const r = await findEntryById(entry.id);
    expect(r!.state).toBe('failed');
    expect(r!.error_code).toBe('SERVICE_UNAVAILABLE');
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('permlink collision on chain → markCompletedExisting (no broadcast)', async () => {
    if (!available) return;
    isHafConfiguredMock.mockReturnValue(true);
    getPoolMock.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        rows: [{ author: 'pevotest.bridge', permlink: 'bridge-arxiv-existing' }],
      }),
    });
    const entry = await insertLeasedEntry('collision');
    await dispatchEntry(entry);
    const r = await findEntryById(entry.id);
    expect(r!.state).toBe('completed');
    expect(r!.existing_author).toBe('pevotest.bridge');
    expect(r!.existing_permlink).toBe('bridge-arxiv-existing');
    expect(r!.tx_id).toBeNull();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('broadcast succeeds but completion write throws → pending, attempts NOT incremented, COMPLETION_WRITE_FAILED, cooldown recorded', async () => {
    if (!available) return;
    // Broadcast lands, then the completion write fails. The dispatcher must
    // NOT treat this as a broadcast failure: it records the cooldown (so the
    // next tick is held by the cadence gate rather than re-broadcasting inside
    // the chain's window) and reschedules WITHOUT consuming the broadcast
    // budget, labelling it COMPLETION_WRITE_FAILED (not BROADCAST_FAILED).
    // The next tick's pre-broadcast on-chain reconciliation then short-circuits
    // to terminal, so this does not loop.
    broadcastMock.mockResolvedValue({ id: 'tx-completion-throws' });
    markCompletedMock.mockRejectedValue(new Error('app db write failed'));
    const entry = await insertLeasedEntry('completion-fail');

    await dispatchEntry(entry);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(markCompletedMock).toHaveBeenCalledTimes(1);
    const r = await findEntryById(entry.id);
    expect(r!.state).toBe('pending');
    // Post-broadcast write failure is not a broadcast failure: the retry
    // budget must not advance, or a flapping app DB would terminal-fail a
    // submission whose post is already on chain.
    expect(r!.attempts).toBe(0);
    expect(r!.error_code).toBe('COMPLETION_WRITE_FAILED');

    // Cooldown was recorded before the completion write, so the next tick is
    // held by the cadence gate and does not re-broadcast inside the chain's
    // ~5-minute window. Observe it via runWorkerTick: the gate returns before
    // leaseNextEntry, and no second broadcast fires.
    broadcastMock.mockClear();
    leaseNextEntryMock.mockClear();
    await runWorkerTick();
    expect(leaseNextEntryMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe('bridge-worker: runWorkerTick', () => {
  it('cadence gate: a tick within the cooldown window does not lease or broadcast', async () => {
    if (!available) return;
    // A successful dispatch records lastBroadcastMs ≈ now, closing the gate.
    broadcastMock.mockResolvedValue({ id: 'tx-gate' });
    const entry = await insertLeasedEntry('gate');
    await dispatchEntry(entry);
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    broadcastMock.mockClear();
    leaseNextEntryMock.mockClear();
    await runWorkerTick();
    // Gate returns before leaseNextEntry; nothing dispatched.
    expect(leaseNextEntryMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('re-entrancy guard: a second concurrent tick short-circuits while the first is in flight', async () => {
    if (!available) return;
    _resetBridgeWorkerForTests(); // gate open (lastBroadcastMs = 0)
    const entry = await insertLeasedEntry('reentry');
    leaseNextEntryMock.mockResolvedValue(entry);

    // Block the broadcast so the first tick stays in flight, holding the
    // re-entrancy flag, until we release it. `reachedBroadcast` resolves the
    // moment the first tick reaches the (now-blocked) broadcast, so the
    // assertions do not race the first tick's await chain.
    let release!: () => void;
    let signalReached!: () => void;
    const reachedBroadcast = new Promise<void>((resolve) => { signalReached = resolve; });
    broadcastMock.mockImplementation(() => {
      signalReached();
      return new Promise((resolve) => { release = () => resolve({ id: 'tx-reentry' }); });
    });

    const p1 = runWorkerTick(); // sets the flag synchronously, leases, blocks on broadcast
    const p2 = runWorkerTick(); // sees the flag set → returns without leasing
    await p2;
    await reachedBroadcast;
    // Only the first tick reached leaseNextEntry/broadcast.
    expect(leaseNextEntryMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    release();
    await p1;
    const r = await findEntryById(entry.id);
    expect(r!.state).toBe('completed');
  });
});

describe('bridge-worker: startBridgeWorker cooldown seed', () => {
  it('seeds lastBroadcastMs from the last successful broadcast so a restart cannot bypass the gate', async () => {
    if (!available) return;
    const pool = getAppPool();
    // A recently-completed broadcast (tx_id set) exists, so the seed closes
    // the gate and the first tick after startup does not lease.
    await pool!.query(
      `INSERT INTO bridge_import_queue
         (operation_kind, username, identifier, permlink, discipline,
          keywords, language, state, tx_id, completed_at)
       VALUES ('bridge_register', $1, $2, $3, 'CS', '[]'::jsonb, 'en',
               'completed', 'tx-seed', NOW())`,
      [`${USER_PREFIX}-seed`, `worker-seed-${seq}`, `bridge-worker-seed-${seq++}`],
    );
    _resetBridgeWorkerForTests();
    await startBridgeWorker();
    try {
      leaseNextEntryMock.mockClear();
      await runWorkerTick();
      expect(leaseNextEntryMock).not.toHaveBeenCalled();
    } finally {
      stopBridgeWorker();
    }
  });

  it('getLastSuccessfulBroadcastAt excludes collision-completed rows (tx_id NULL)', async () => {
    if (!available) return;
    const pool = getAppPool();
    // A collision-completed row (markCompletedExisting leaves tx_id NULL)
    // dated far in the future would dominate ORDER BY completed_at DESC if
    // the `tx_id IS NOT NULL` filter were dropped. It must be excluded, so
    // the seed never picks it up.
    await pool!.query(
      `INSERT INTO bridge_import_queue
         (operation_kind, username, identifier, permlink, discipline,
          keywords, language, state, existing_author, existing_permlink, completed_at)
       VALUES ('bridge_register', $1, $2, $3, 'CS', '[]'::jsonb, 'en',
               'completed', 'someone', 'bridge-existing', NOW() + INTERVAL '1 day')`,
      [`${USER_PREFIX}-collision-seed`, `worker-collision-${seq}`, `bridge-worker-collision-${seq++}`],
    );
    const last = await getLastSuccessfulBroadcastAt();
    // Never the far-future NULL-tx_id row; either null or a real broadcast's
    // (necessarily near-present) timestamp.
    if (last) expect(last.getTime()).toBeLessThan(Date.now() + 12 * 3600 * 1000);
  });
});
