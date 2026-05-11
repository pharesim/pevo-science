/**
 * Unit tests for `account-creation.ts` after BE-ACCOUNT-CREATION-TOKENS-DROP.
 *
 * The DB mirror table (`account_creation_tokens`) was removed. Capacity is
 * now read from the on-chain `pending_claimed_accounts` counter, cached in
 * Redis (10s TTL) and invalidated on every successful broadcast.
 *
 * Justification for the `getRedis()` and `broadcastSendOperationsWithTimeout`
 * + `hiveClient.database.getAccounts` mocks (per root CLAUDE.md carve-out):
 * the assertions under test exercise (a) the catch-site discrimination of
 * `BroadcastTimeoutError` in `claimAccountTokens` (the loop must break, not
 * halve-retry), (b) the cached-then-invalidated counter contract on the
 * consume path (`createClaimedAccount`), and (c) the chain-consensus
 * rejection translation. Inducing a wall-clock >30s Hive node hang per-test
 * is impractical, and the consensus-rejection error shape is node-side
 * behavior we cannot deterministically trigger from a real broadcast.
 * `verifyHiveSignature` and other middleware are NOT mocked (these
 * functions have no route surface). A real-HAF broadcast-success path is
 * covered by `hive-broadcast-timeout.test.ts` (wrapper-level) and by the
 * production behavior of `startAccountClaimer` against the real chain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../src/logger.js';

const {
  MockBroadcastTimeoutError,
  sendOperationsMock,
  getAccountsMock,
  redisGetMock,
  redisSetMock,
  redisDelMock,
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
  getAccountsMock: vi.fn(),
  redisGetMock: vi.fn(),
  redisSetMock: vi.fn(),
  redisDelMock: vi.fn(),
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

vi.mock('../src/redis.js', () => ({
  getRedis: () => ({
    get: redisGetMock,
    set: redisSetMock,
    del: redisDelMock,
  }),
}));

// Config stubbed so PrivateKey.fromString / hiveOnboardAccount / appTag resolve
// without touching real env. HIVE_ONBOARD_ACTIVE_KEY must be a valid WIF so
// PrivateKey.fromString doesn't throw at the top of the functions under test.
vi.mock('../src/config.js', () => ({
  config: {
    appTag: 'pevotest',
    hiveOnboardAccount: 'pevo.admin',
    claimAccountTokens: true,
  },
}));

const TEST_WIF = '5KKaVFkiC7E8SysRb8xuiu53Kcg7khbwzbr2WgCmWQLh3yt58mN';
const EXPECTED_CACHE_KEY = 'pevotest:hive:pending_claimed_accounts:pevo.admin';

/** Build a minimal Hive account response with the given pending counter. */
function accountWithPending(pending: number): unknown {
  return { name: 'pevo.admin', pending_claimed_accounts: pending };
}

beforeEach(() => {
  process.env.HIVE_ONBOARD_ACTIVE_KEY = TEST_WIF;
  sendOperationsMock.mockReset();
  getAccountsMock.mockReset();
  redisGetMock.mockReset();
  redisSetMock.mockReset();
  redisDelMock.mockReset();
  // Default: cache miss; chain reads return a healthy counter.
  redisGetMock.mockResolvedValue(null);
  redisSetMock.mockResolvedValue('OK');
  redisDelMock.mockResolvedValue(1);
  getAccountsMock.mockResolvedValue([accountWithPending(100)]);
});

afterEach(() => {
  delete process.env.HIVE_ONBOARD_ACTIVE_KEY;
  vi.restoreAllMocks();
});

describe('claimAccountTokens — BroadcastTimeoutError discrimination', () => {
  it('breaks out of the batch loop on BroadcastTimeoutError (no halve, no retry)', async () => {
    sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await claimAccountTokens();

    // Exactly one broadcast attempt — the loop broke on BroadcastTimeoutError
    // instead of halving batchSize and retrying.
    expect(sendOperationsMock).toHaveBeenCalledTimes(1);
  });

  it('halves batchSize and retries on non-timeout errors (RC exhaustion path preserved)', async () => {
    sendOperationsMock.mockRejectedValue(new Error('Insufficient RC'));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await claimAccountTokens();

    // Halving sequence: 50 -> 25 -> 12 -> 6 -> 3 -> 1 -> 0 (exits the while).
    // That's 6 broadcast attempts.
    expect(sendOperationsMock).toHaveBeenCalledTimes(6);
  });

  it('does NOT INSERT into a DB table on success (table dropped)', async () => {
    // Sanity guard: if any future regression reintroduces a DB INSERT, this
    // test will fail because no `pg.Pool` mock is wired up. The function
    // must not import `getAppPool` or query a pool. We assert via module
    // shape: the file should resolve and run without any DB dependency.
    sendOperationsMock.mockResolvedValueOnce({ id: 'tx', block_num: 1 });
    sendOperationsMock.mockRejectedValue(new Error('Insufficient RC'));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await expect(claimAccountTokens()).resolves.toBeUndefined();
  });

  it('invalidates the chain-counter cache after a successful claim broadcast', async () => {
    // First batch lands; subsequent halving attempts all fail with non-timeout
    // errors (we don't care — we're asserting cache.del was called for the
    // success).
    sendOperationsMock.mockResolvedValueOnce({ id: 'tx', block_num: 1 });
    sendOperationsMock.mockRejectedValue(new Error('Insufficient RC'));

    const { claimAccountTokens } = await import('../src/account-creation.js');
    await claimAccountTokens();

    expect(redisDelMock).toHaveBeenCalledWith(EXPECTED_CACHE_KEY);
  });
});

describe('createClaimedAccount — capacity check + cache + consensus translation', () => {
  const KEY_ARGS = ['STM_owner', 'STM_active', 'STM_posting', 'STM_memo'] as const;

  it('throws retriable "No account creation tokens available" when the cached counter is 0', async () => {
    redisGetMock.mockResolvedValueOnce('0');

    const { createClaimedAccount } = await import('../src/account-creation.js');
    await expect(createClaimedAccount('alice', ...KEY_ARGS)).rejects.toThrow(
      'No account creation tokens available',
    );

    // No broadcast attempted when capacity check fails.
    expect(sendOperationsMock).not.toHaveBeenCalled();
    // No fallback chain read when the cache hit was a definite zero.
    expect(getAccountsMock).not.toHaveBeenCalled();
  });

  it('throws retriable error when the chain read returns null (pre-broadcast capacity unknown)', async () => {
    redisGetMock.mockResolvedValueOnce(null);
    getAccountsMock.mockResolvedValueOnce([]); // missing account => null

    const { createClaimedAccount } = await import('../src/account-creation.js');
    await expect(createClaimedAccount('alice', ...KEY_ARGS)).rejects.toThrow(
      'No account creation tokens available',
    );
    expect(sendOperationsMock).not.toHaveBeenCalled();
  });

  it('broadcasts when the cached counter is positive, then invalidates the cache', async () => {
    redisGetMock.mockResolvedValueOnce('5');
    sendOperationsMock.mockResolvedValueOnce({ id: 'tx', block_num: 12345 });

    const { createClaimedAccount } = await import('../src/account-creation.js');
    const result = await createClaimedAccount('alice', ...KEY_ARGS);

    expect(result).toEqual({ id: 'tx', block_num: 12345 });
    expect(sendOperationsMock).toHaveBeenCalledTimes(1);
    expect(redisDelMock).toHaveBeenCalledWith(EXPECTED_CACHE_KEY);
  });

  it('reads chain on cache miss, caches the value, and proceeds when positive', async () => {
    redisGetMock.mockResolvedValueOnce(null);
    getAccountsMock.mockResolvedValueOnce([accountWithPending(7)]);
    sendOperationsMock.mockResolvedValueOnce({ id: 'tx', block_num: 999 });

    const { createClaimedAccount } = await import('../src/account-creation.js');
    await createClaimedAccount('alice', ...KEY_ARGS);

    expect(getAccountsMock).toHaveBeenCalledWith(['pevo.admin']);
    // Cache write happened with the appTag-prefixed key and a 10s PX TTL.
    expect(redisSetMock).toHaveBeenCalledWith(EXPECTED_CACHE_KEY, '7', 'PX', 10_000);
    // Then invalidated after the successful broadcast.
    expect(redisDelMock).toHaveBeenCalledWith(EXPECTED_CACHE_KEY);
  });

  it('cache invalidation forces a fresh chain read on the next call', async () => {
    redisGetMock
      .mockResolvedValueOnce(null) // first call: miss -> chain
      .mockResolvedValueOnce(null); // second call: invalidated -> miss -> chain
    getAccountsMock
      .mockResolvedValueOnce([accountWithPending(5)])
      .mockResolvedValueOnce([accountWithPending(4)]);
    sendOperationsMock.mockResolvedValue({ id: 'tx', block_num: 1 });

    const { createClaimedAccount } = await import('../src/account-creation.js');
    await createClaimedAccount('alice', ...KEY_ARGS);
    await createClaimedAccount('bob', ...KEY_ARGS);

    // Two chain reads — invalidation between calls forced a fresh read.
    expect(getAccountsMock).toHaveBeenCalledTimes(2);
    // Two cache invalidations (one per successful broadcast).
    expect(redisDelMock).toHaveBeenCalledTimes(2);
  });

  it('translates a consensus-rejection error mentioning pending_claimed_accounts into the retriable shape', async () => {
    redisGetMock.mockResolvedValueOnce('1');
    sendOperationsMock.mockRejectedValueOnce(
      new Error('assertion failed: pending_claimed_accounts > 0'),
    );

    const { createClaimedAccount } = await import('../src/account-creation.js');
    await expect(createClaimedAccount('alice', ...KEY_ARGS)).rejects.toThrow(
      'No account creation tokens available',
    );
    // Cache was invalidated so the next reader sees fresh state.
    expect(redisDelMock).toHaveBeenCalledWith(EXPECTED_CACHE_KEY);
  });

  it('translates a consensus-rejection error mentioning "no available account creation" into the retriable shape', async () => {
    // Positive coverage for the second arm of the consensus-rejection
    // alternation. Without this, a typo or accidental deletion of the
    // `no available account creation` branch would slip past CI because the
    // sibling test above only exercises the `assertion failed:
    // pending_claimed_accounts` arm.
    redisGetMock.mockResolvedValueOnce('1');
    sendOperationsMock.mockRejectedValueOnce(
      new Error('no available account creation tokens'),
    );

    const { createClaimedAccount } = await import('../src/account-creation.js');
    await expect(createClaimedAccount('alice', ...KEY_ARGS)).rejects.toThrow(
      'No account creation tokens available',
    );
    expect(redisDelMock).toHaveBeenCalledWith(EXPECTED_CACHE_KEY);
  });

  it('propagates non-counter broadcast errors unchanged (e.g. timeouts, network errors)', async () => {
    redisGetMock.mockResolvedValueOnce('5');
    sendOperationsMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    const { createClaimedAccount } = await import('../src/account-creation.js');
    await expect(createClaimedAccount('alice', ...KEY_ARGS)).rejects.toThrow(
      /timed out/,
    );
  });

  it('does NOT translate unrelated errors that happen to mention "no claim" (regex tightened)', async () => {
    // Pre-tightening, the regex `/no[_ ]?(?:available)?[_ ]?(?:account[_ ])?claim/i`
    // matched any string containing "no" followed loosely by "claim", which
    // could swallow unrelated permission/validation errors mentioning the
    // word "claim" anywhere. The tightened regex only matches the two known
    // consensus-rejection phrases. This guard pins that contract.
    redisGetMock.mockResolvedValueOnce('5');
    sendOperationsMock.mockRejectedValueOnce(
      new Error('user has no claim history yet — unrelated validation error'),
    );

    const { createClaimedAccount } = await import('../src/account-creation.js');
    // The original error must propagate unchanged, NOT be collapsed to the
    // retriable "No account creation tokens available" string. Asserting the
    // exact thrown message pins both invariants (original preserved + not
    // translated) in a single check.
    await expect(createClaimedAccount('alice', ...KEY_ARGS)).rejects.toThrow(
      'user has no claim history yet — unrelated validation error',
    );
  });

  it('logs the consensus-rejection original error at warn before translating', async () => {
    redisGetMock.mockResolvedValueOnce('1');
    const consensusErr = new Error('assertion failed: pending_claimed_accounts > 0');
    sendOperationsMock.mockRejectedValueOnce(consensusErr);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    const { createClaimedAccount } = await import('../src/account-creation.js');
    await expect(createClaimedAccount('alice', ...KEY_ARGS)).rejects.toThrow(
      'No account creation tokens available',
    );

    // The original error context is preserved in a warn log keyed by the
    // structured event tag; without this, diagnostic context dies at the
    // throw boundary.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: consensusErr,
        event: 'account_creation.broadcast.consensus_rejected',
      }),
      expect.stringContaining('chain consensus'),
    );
  });

  it('warn-logs cache-invalidation failures with the structured event tag', async () => {
    redisGetMock.mockResolvedValueOnce('5');
    sendOperationsMock.mockResolvedValueOnce({ id: 'tx', block_num: 1 });
    redisDelMock.mockRejectedValueOnce(new Error('redis del boom'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    const { createClaimedAccount } = await import('../src/account-creation.js');
    await createClaimedAccount('alice', ...KEY_ARGS);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheKey: EXPECTED_CACHE_KEY,
        event: 'account_creation.cache.invalidate_failed',
        err: expect.any(Error),
      }),
      expect.stringContaining('cache invalidation failed'),
    );
  });

});
