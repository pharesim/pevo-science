/**
 * Unit tests for broadcastJsonWithTimeout and broadcastSendOperationsWithTimeout.
 *
 * Justification for the mocked `hiveClient.broadcast.{json,sendOperations}`:
 * the behavior under test is the wrapper's wall-clock timeout contract, not
 * dhive's on-wire broadcast semantics. A real Hive node broadcast would take
 * 2-10s on the happy path and cannot be reliably induced to hang past 30s
 * from an integration test. Mocking dhive is the only way to exercise the
 * slow-broadcast failure mode deterministically. Per root CLAUDE.md
 * carve-out: no `verifyHiveSignature` or auth middleware mocking here — the
 * wrappers live in src/hive.ts and have no middleware surface.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PrivateKey } from '@hiveio/dhive';
import {
  broadcastJsonWithTimeout,
  broadcastSendOperationsWithTimeout,
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
const DUMMY_OPERATIONS = [
  [
    'claim_account',
    { creator: 'pevo.admin', fee: '0.000 HIVE', extensions: [] },
  ],
] as never;

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

describe('broadcastSendOperationsWithTimeout', () => {
  it('passes through the resolved result on the happy path', async () => {
    const expected = { id: 'tx-hash-def', block_num: 200, expired: false, trx_num: 0 };
    vi.spyOn(hiveClient.broadcast, 'sendOperations').mockResolvedValueOnce(
      expected as never,
    );

    const result = await broadcastSendOperationsWithTimeout(DUMMY_OPERATIONS, DUMMY_KEY);
    expect(result).toEqual(expected);
  });

  it('throws BroadcastTimeoutError when the underlying broadcast hangs', async () => {
    // Hanging broadcast: never resolves, never rejects.
    vi.spyOn(hiveClient.broadcast, 'sendOperations').mockImplementationOnce(
      () => new Promise(() => {}) as never,
    );

    const start = Date.now();
    await expect(
      broadcastSendOperationsWithTimeout(DUMMY_OPERATIONS, DUMMY_KEY, 200),
    ).rejects.toBeInstanceOf(BroadcastTimeoutError);
    const elapsed = Date.now() - start;
    // Helper should reject at ~timeoutMs, not wait for the hanging fetch.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(500);
  });

  it('propagates underlying broadcast errors unchanged', async () => {
    const chainError = new Error('Insufficient RC');
    vi.spyOn(hiveClient.broadcast, 'sendOperations').mockRejectedValueOnce(chainError);

    await expect(
      broadcastSendOperationsWithTimeout(DUMMY_OPERATIONS, DUMMY_KEY),
    ).rejects.toBe(chainError);
  });
});

// Round-4 hold #1 (BE-HANDLE-BROADCAST-ERROR-HELPER): the constructor must
// reject non-finite or non-positive timeoutMs at the single throw site so the
// `details.timeout_ms` envelope field and operator-log payload can never carry
// NaN / Infinity / 0 / negative values. Pinning the invariant at the source
// of truth is the round-4 architect prescription (vs. a downstream sanitiser).
describe('BroadcastTimeoutError constructor input validation', () => {
  it('throws RangeError on NaN timeoutMs', () => {
    expect(() => new BroadcastTimeoutError(Number.NaN)).toThrow(RangeError);
  });

  it('throws RangeError on positive Infinity timeoutMs', () => {
    expect(() => new BroadcastTimeoutError(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('throws RangeError on negative Infinity timeoutMs', () => {
    expect(() => new BroadcastTimeoutError(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });

  it('throws RangeError on zero timeoutMs', () => {
    expect(() => new BroadcastTimeoutError(0)).toThrow(RangeError);
  });

  it('throws RangeError on negative timeoutMs', () => {
    expect(() => new BroadcastTimeoutError(-1)).toThrow(RangeError);
  });

  it('constructs successfully on a finite positive timeoutMs', () => {
    const err = new BroadcastTimeoutError(30_000);
    expect(err).toBeInstanceOf(BroadcastTimeoutError);
    expect(err.timeoutMs).toBe(30_000);
    expect(err.message).toContain('30000ms');
  });
});
