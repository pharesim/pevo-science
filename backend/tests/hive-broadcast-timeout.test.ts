/**
 * Unit test for broadcastJsonWithTimeout.
 *
 * Justification for the mocked `hiveClient.broadcast.json`: the behavior under
 * test is the wrapper's wall-clock timeout contract, not dhive's on-wire
 * broadcast semantics. A real Hive node broadcast would take 2-10s on the
 * happy path and cannot be reliably induced to hang past 30s from an
 * integration test. Mocking dhive is the only way to exercise the
 * slow-broadcast failure mode deterministically. Per root CLAUDE.md
 * carve-out: no `verifyHiveSignature` or auth middleware mocking here — the
 * wrapper lives in src/hive.ts and has no middleware surface.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PrivateKey } from '@hiveio/dhive';
import {
  broadcastJsonWithTimeout,
  BroadcastTimeoutError,
  hiveClient,
} from '../src/hive.js';

const DUMMY_KEY = PrivateKey.fromSeed('pevo-test-seed-only');
const DUMMY_PAYLOAD = {
  id: 'pevotest',
  json: '{}',
  required_auths: [],
  required_posting_auths: ['pevo.admin'],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('broadcastJsonWithTimeout', () => {
  it('passes through the resolved result on the happy path', async () => {
    const expected = { id: 'tx-hash-abc', block_num: 100, expired: false, trx_num: 0 };
    vi.spyOn(hiveClient.broadcast, 'json').mockResolvedValueOnce(expected as never);

    const result = await broadcastJsonWithTimeout(DUMMY_PAYLOAD, DUMMY_KEY);
    expect(result).toEqual(expected);
  });

  it('throws BroadcastTimeoutError when the underlying broadcast hangs', async () => {
    // Hanging broadcast: never resolves, never rejects.
    vi.spyOn(hiveClient.broadcast, 'json').mockImplementationOnce(
      () => new Promise(() => {}) as never,
    );

    const start = Date.now();
    await expect(
      broadcastJsonWithTimeout(DUMMY_PAYLOAD, DUMMY_KEY, 200),
    ).rejects.toBeInstanceOf(BroadcastTimeoutError);
    const elapsed = Date.now() - start;
    // Helper should reject at ~timeoutMs, not wait for the hanging fetch.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(500);
  });

  it('propagates underlying broadcast errors unchanged', async () => {
    const chainError = new Error('Invalid authority: insufficient posting auth');
    vi.spyOn(hiveClient.broadcast, 'json').mockRejectedValueOnce(chainError);

    await expect(broadcastJsonWithTimeout(DUMMY_PAYLOAD, DUMMY_KEY)).rejects.toBe(
      chainError,
    );
  });
});
