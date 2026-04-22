/**
 * Unit tests for claimAccountTokens — covers (1) round-2 hold fix requiring
 * BroadcastTimeoutError discrimination in the claim-batch loop and (2)
 * post-timeout chain-reconcile behavior added by BE-CLAIM-ACCOUNT-CHAIN-RECONCILE.
 *
 * Justification for the `getAppPool()`, `broadcastSendOperationsWithTimeout`,
 * and `hiveClient.database.getAccounts` mocks (per root CLAUDE.md carve-out):
 * the assertions under test are (a) that a timeout during `claim_account`
 * broadcast makes the loop BREAK (not halve batchSize and retry), and (b)
 * that after a timeout the reconciler reads the on-chain
 * `pending_claimed_accounts` counter and INSERTs delta rows. Seeding a real
 * DB + inducing a wall-clock >30s hang from a real Hive node per-test is
 * impractical; the behavior under test is the catch-site discrimination
 * plus the chain-read + counter-delta INSERT logic. `verifyHiveSignature`
 * and other middleware are NOT mocked here; this function has no route
 * surface. A real-HAF broadcast-success path is covered by the existing
 * `hive-broadcast-timeout.test.ts` (wrapper-level) and by the in-production
 * behavior of `startAccountClaimer` running against the real chain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  MockBroadcastTimeoutError,
  sendOperationsMock,
  poolQueryMock,
  getAccountsMock,
} = vi.hoisted(() => ({
  MockBroadcastTimeoutError: class BroadcastTimeoutError extends Error {
    public readonly timeoutMs: number;
    constructor(timeoutMs: number) {
      super(`Hive broadcast timed out after ${timeoutMs}ms`);
      this.name = 'BroadcastTimeoutError';
      this.timeoutMs = timeoutMs;
    }
  },
  sendOperationsMock: vi.fn(),
  poolQueryMock: vi.fn(),
  getAccountsMock: vi.fn(),
}));

vi.mock('../src/hive.js', () => ({
  BroadcastTimeoutError: MockBroadcastTimeoutError,
  broadcastSendOperationsWithTimeout: sendOperationsMock,
  hiveClient: {
    database: {
      getAccounts: getAccountsMock,
    },
  },
}));

vi.mock('../src/app-db.js', () => ({
  getAppPool: () => ({ query: poolQueryMock }),
}));

// Config stubbed so PrivateKey.fromString / hiveOnboardAccount resolve without
// touching real env. HIVE_ONBOARD_ACTIVE_KEY must be a valid WIF so
// PrivateKey.fromString doesn't throw at the top of claimAccountTokens.
vi.mock('../src/config.js', () => ({
  config: {
    hiveOnboardAccount: 'pevo.admin',
    claimAccountTokens: true,
  },
}));

const TEST_WIF = '5KKaVFkiC7E8SysRb8xuiu53Kcg7khbwzbr2WgCmWQLh3yt58mN';

/** Build a minimal Hive account response with the given pending counter. */
function accountWithPending(pending: number): unknown {
  return { name: 'pevo.admin', pending_claimed_accounts: pending };
}

describe('claimAccountTokens — BroadcastTimeoutError discrimination', () => {
  beforeEach(() => {
    process.env.HIVE_ONBOARD_ACTIVE_KEY = TEST_WIF;
    sendOperationsMock.mockReset();
    poolQueryMock.mockReset();
    getAccountsMock.mockReset();
    // Default: trailing count query (runs after the claim loop regardless of
    // exit path). Individual tests may override for reconcile INSERTs.
    poolQueryMock.mockResolvedValue({ rows: [{ count: '0' }] });
    // Default: no chain advance (reconcile yields 0). Individual tests
    // override for delta scenarios.
    getAccountsMock.mockResolvedValue([accountWithPending(100)]);
  });

  afterEach(() => {
    delete process.env.HIVE_ONBOARD_ACTIVE_KEY;
    vi.restoreAllMocks();
  });

  it('breaks out of the batch loop on BroadcastTimeoutError (no halve, no retry)', async () => {
    // First broadcast times out. Without the discrimination fix the loop would
    // then retry with batchSize=25, 12, 6, 3, 1 — 6 calls total.
    sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await claimAccountTokens();

    // Exactly one broadcast attempt — the loop broke on BroadcastTimeoutError
    // instead of halving batchSize and retrying.
    expect(sendOperationsMock).toHaveBeenCalledTimes(1);
  });

  it('halves batchSize and retries on non-timeout errors (RC exhaustion path preserved)', async () => {
    // A plain chain error (e.g. insufficient RC) should still trigger the
    // halving retry behavior — the fix only discriminates BroadcastTimeoutError.
    sendOperationsMock.mockRejectedValue(new Error('Insufficient RC'));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await claimAccountTokens();

    // Halving sequence: 50 -> 25 -> 12 -> 6 -> 3 -> 1 -> 0 (exits the while).
    // That's 6 broadcast attempts.
    expect(sendOperationsMock).toHaveBeenCalledTimes(6);
  });
});

describe('claimAccountTokens — post-timeout chain reconcile', () => {
  beforeEach(() => {
    process.env.HIVE_ONBOARD_ACTIVE_KEY = TEST_WIF;
    sendOperationsMock.mockReset();
    poolQueryMock.mockReset();
    getAccountsMock.mockReset();
    poolQueryMock.mockResolvedValue({ rows: [{ count: '0' }] });
  });

  afterEach(() => {
    delete process.env.HIVE_ONBOARD_ACTIVE_KEY;
    vi.restoreAllMocks();
  });

  it('inserts N token rows when the chain counter advanced by N during a timed-out broadcast (full landing)', async () => {
    // pre-broadcast counter = 100, post-broadcast counter = 150: full 50-op
    // batch landed on chain despite the broadcast timing out. Reconciler
    // should INSERT 50 rows.
    getAccountsMock
      .mockResolvedValueOnce([accountWithPending(100)]) // pre-broadcast
      .mockResolvedValueOnce([accountWithPending(150)]); // post-timeout
    sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await claimAccountTokens();

    const insertCalls = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO account_creation_tokens'),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toEqual([50]);
    // Only one broadcast attempt — the timeout broke the loop (no halving).
    expect(sendOperationsMock).toHaveBeenCalledTimes(1);
    // Two chain reads: pre-broadcast + post-timeout reconcile.
    expect(getAccountsMock).toHaveBeenCalledTimes(2);
  });

  it('inserts partial count when only some claim ops landed before timeout', async () => {
    // pre=100, post=130: 30 of the 50 ops landed. Reconciler INSERTs 30.
    getAccountsMock
      .mockResolvedValueOnce([accountWithPending(100)])
      .mockResolvedValueOnce([accountWithPending(130)]);
    sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await claimAccountTokens();

    const insertCalls = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO account_creation_tokens'),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toEqual([30]);
  });

  it('inserts nothing when the chain counter did not advance (broadcast never landed)', async () => {
    // pre=100, post=100: nothing landed. Reconciler INSERTs 0 rows.
    getAccountsMock
      .mockResolvedValueOnce([accountWithPending(100)])
      .mockResolvedValueOnce([accountWithPending(100)]);
    sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await claimAccountTokens();

    const insertCalls = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO account_creation_tokens'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('clamps reconcile delta to batchSize when another actor advanced the counter concurrently', async () => {
    // pre=100, post=200: +100 on chain but we only broadcast 50. A parallel
    // admin-account actor added the extra. Only INSERT up to batchSize (50).
    getAccountsMock
      .mockResolvedValueOnce([accountWithPending(100)])
      .mockResolvedValueOnce([accountWithPending(200)]);
    sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await claimAccountTokens();

    const insertCalls = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO account_creation_tokens'),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toEqual([50]);
  });

  it('skips reconcile when the pre-broadcast chain read fails', async () => {
    // Pre-broadcast getAccounts throws. Reconciler has no baseline so it
    // cannot compute delta — logs and skips (no INSERT).
    getAccountsMock.mockRejectedValueOnce(new Error('chain read failed'));
    sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await claimAccountTokens();

    const insertCalls = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO account_creation_tokens'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('skips reconcile when the post-timeout chain read fails', async () => {
    // Pre-broadcast read succeeds; post-timeout read throws. Reconciler
    // cannot compute delta — logs and skips (no INSERT).
    getAccountsMock
      .mockResolvedValueOnce([accountWithPending(100)])
      .mockRejectedValueOnce(new Error('chain read failed'));
    sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await claimAccountTokens();

    const insertCalls = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO account_creation_tokens'),
    );
    expect(insertCalls).toHaveLength(0);
  });
});
