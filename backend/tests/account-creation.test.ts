/**
 * Unit tests for claimAccountTokens — specifically the round-2 hold fix
 * requiring BroadcastTimeoutError discrimination in the claim-batch loop.
 *
 * Justification for the `getAppPool()` + `broadcastSendOperationsWithTimeout`
 * mocks (per root CLAUDE.md carve-out): the assertion under test is that a
 * timeout during `claim_account` broadcast makes the loop BREAK (not halve
 * batchSize and retry), because a timeout leaves outcome ambiguous — the
 * tx may have landed on chain. Seeding a real DB + inducing a wall-clock
 * >30s hang from a real Hive node per-test is impractical; the behavior
 * under test is purely the catch-site discrimination. `verifyHiveSignature`
 * and other middleware are NOT mocked here; this function has no route
 * surface. A real-HAF broadcast-success path is covered by the existing
 * `hive-broadcast-timeout.test.ts` (wrapper-level) and by the in-production
 * behavior of `startAccountClaimer` running against the real chain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { MockBroadcastTimeoutError, sendOperationsMock, poolQueryMock } = vi.hoisted(() => ({
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
}));

vi.mock('../src/hive.js', () => ({
  BroadcastTimeoutError: MockBroadcastTimeoutError,
  broadcastSendOperationsWithTimeout: sendOperationsMock,
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

describe('claimAccountTokens — BroadcastTimeoutError discrimination', () => {
  beforeEach(() => {
    process.env.HIVE_ONBOARD_ACTIVE_KEY = TEST_WIF;
    sendOperationsMock.mockReset();
    poolQueryMock.mockReset();
    // Trailing count query (runs after the claim loop regardless of exit path).
    poolQueryMock.mockResolvedValue({ rows: [{ count: '0' }] });
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
    // No INSERT into account_creation_tokens on the timeout branch — only the
    // trailing count SELECT should run.
    const insertCalls = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO account_creation_tokens'),
    );
    expect(insertCalls).toHaveLength(0);
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
