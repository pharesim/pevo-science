/**
 * Unit tests for broadcastJsonWithTimeout, broadcastSendOperationsWithTimeout,
 * and broadcastAdminCustomJson.
 *
 * Justification for the mocked `hiveClient.broadcast.{json,sendOperations}`:
 * the behavior under test is the wrapper's wall-clock timeout contract (and,
 * for `broadcastAdminCustomJson`, the admin custom_json envelope shape it
 * assembles), not dhive's on-wire broadcast semantics. A real Hive node
 * broadcast would take 2-10s on the happy path and cannot be reliably induced
 * to hang past 30s from an integration test. Mocking dhive is the only way to
 * exercise the slow-broadcast failure mode deterministically, and spying
 * `hiveClient.broadcast.json` is the only way to capture the exact
 * `{ id, required_auths, required_posting_auths }` envelope the real
 * `broadcastAdminCustomJson` emits without burning a chain write per test.
 * The focus of every spec here is wrapper / envelope shape, NOT cryptographic
 * auth: these are src/hive.ts helper unit tests with no middleware surface, so
 * no `verifyHiveSignature` / `MOCK_VERIFY_SIGNATURE` is involved. The
 * `broadcastAdminCustomJson` happy path sets a valid throwaway WIF on
 * `config.pevoAdminPostingKey` locally (restored in `finally`) purely so the
 * real helper passes its unset-key guard and reaches the broadcast call.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PrivateKey } from '@hiveio/dhive';
import {
  broadcastJsonWithTimeout,
  broadcastSendOperationsWithTimeout,
  broadcastAdminCustomJson,
  AdminKeyNotConfiguredError,
  BroadcastTimeoutError,
  hiveClient,
} from '../src/hive.js';
import { config } from '../src/config.js';

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

// Round-5 hold #1 (BE-HANDLE-BROADCAST-ERROR-HELPER): the canonical
// input-validation site is the wrapper entry, NOT the constructor. The
// constructor guard is unreachable in production: the only throw site is
// inside `setTimeout(() => reject(new BroadcastTimeoutError(timeoutMs)))`,
// where a synchronous constructor throw fires before `reject()` is called,
// escapes to `process.on('uncaughtException')`, and crashes the process. The
// wrapper-entry guard catches the same invariant before the timer is
// scheduled or dhive is invoked, so the throw propagates as a normal
// async-function rejection that reaches the route's catch and produces a 502
// `BROADCAST_FAILED` envelope.
//
// Mutation kill: removing `assertFinitePositiveTimeoutMs(...)` from the
// wrapper entry sends control through to the `setTimeout` closure, where the
// constructor guard fires synchronously and either (a) crashes the test
// process via uncaughtException (Vitest typically surfaces this as a non-zero
// exit + "Unhandled error" log) or (b) hangs forever waiting for a
// rejection that never arrives. Either failure mode flips these specs red.
describe('broadcastJsonWithTimeout input validation (wrapper-entry guard)', () => {
  it('rejects with RangeError on NaN timeoutMs without scheduling a timer or invoking dhive', async () => {
    const broadcastSpy = vi.spyOn(hiveClient.broadcast, 'json');
    await expect(
      broadcastJsonWithTimeout(DUMMY_PAYLOAD, DUMMY_KEY, Number.NaN),
    ).rejects.toThrow(RangeError);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('rejects with RangeError on +Infinity timeoutMs', async () => {
    const broadcastSpy = vi.spyOn(hiveClient.broadcast, 'json');
    await expect(
      broadcastJsonWithTimeout(DUMMY_PAYLOAD, DUMMY_KEY, Number.POSITIVE_INFINITY),
    ).rejects.toThrow(RangeError);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('rejects with RangeError on -Infinity timeoutMs', async () => {
    const broadcastSpy = vi.spyOn(hiveClient.broadcast, 'json');
    await expect(
      broadcastJsonWithTimeout(DUMMY_PAYLOAD, DUMMY_KEY, Number.NEGATIVE_INFINITY),
    ).rejects.toThrow(RangeError);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('rejects with RangeError on zero timeoutMs', async () => {
    const broadcastSpy = vi.spyOn(hiveClient.broadcast, 'json');
    await expect(
      broadcastJsonWithTimeout(DUMMY_PAYLOAD, DUMMY_KEY, 0),
    ).rejects.toThrow(RangeError);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('rejects with RangeError on negative timeoutMs', async () => {
    const broadcastSpy = vi.spyOn(hiveClient.broadcast, 'json');
    await expect(
      broadcastJsonWithTimeout(DUMMY_PAYLOAD, DUMMY_KEY, -1),
    ).rejects.toThrow(RangeError);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('passes a finite positive timeoutMs through to the broadcast (positive control)', async () => {
    const expected = { id: 'tx-hash-positive-control', block_num: 1, expired: false, trx_num: 0 };
    vi.spyOn(hiveClient.broadcast, 'json').mockResolvedValueOnce(expected as never);

    const result = await broadcastJsonWithTimeout(DUMMY_PAYLOAD, DUMMY_KEY, 5000);
    expect(result).toEqual(expected);
  });
});

describe('broadcastSendOperationsWithTimeout input validation (wrapper-entry guard)', () => {
  it('rejects with RangeError on NaN timeoutMs without scheduling a timer or invoking dhive', async () => {
    const broadcastSpy = vi.spyOn(hiveClient.broadcast, 'sendOperations');
    await expect(
      broadcastSendOperationsWithTimeout(DUMMY_OPERATIONS, DUMMY_KEY, Number.NaN),
    ).rejects.toThrow(RangeError);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('rejects with RangeError on +Infinity timeoutMs', async () => {
    const broadcastSpy = vi.spyOn(hiveClient.broadcast, 'sendOperations');
    await expect(
      broadcastSendOperationsWithTimeout(DUMMY_OPERATIONS, DUMMY_KEY, Number.POSITIVE_INFINITY),
    ).rejects.toThrow(RangeError);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('rejects with RangeError on -Infinity timeoutMs', async () => {
    const broadcastSpy = vi.spyOn(hiveClient.broadcast, 'sendOperations');
    await expect(
      broadcastSendOperationsWithTimeout(DUMMY_OPERATIONS, DUMMY_KEY, Number.NEGATIVE_INFINITY),
    ).rejects.toThrow(RangeError);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('rejects with RangeError on zero timeoutMs', async () => {
    const broadcastSpy = vi.spyOn(hiveClient.broadcast, 'sendOperations');
    await expect(
      broadcastSendOperationsWithTimeout(DUMMY_OPERATIONS, DUMMY_KEY, 0),
    ).rejects.toThrow(RangeError);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('rejects with RangeError on negative timeoutMs', async () => {
    const broadcastSpy = vi.spyOn(hiveClient.broadcast, 'sendOperations');
    await expect(
      broadcastSendOperationsWithTimeout(DUMMY_OPERATIONS, DUMMY_KEY, -1),
    ).rejects.toThrow(RangeError);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('passes a finite positive timeoutMs through to the broadcast (positive control)', async () => {
    const expected = { id: 'tx-hash-positive-control-2', block_num: 2, expired: false, trx_num: 0 };
    vi.spyOn(hiveClient.broadcast, 'sendOperations').mockResolvedValueOnce(expected as never);

    const result = await broadcastSendOperationsWithTimeout(DUMMY_OPERATIONS, DUMMY_KEY, 5000);
    expect(result).toEqual(expected);
  });
});

// Pins the admin custom_json envelope assembled by the REAL
// `broadcastAdminCustomJson` — the one place every admin-broadcast call site
// shares the `id` / `required_auths` / `required_posting_auths` shape and the
// admin posting key. Every call-site test mocks this helper and rebuilds the
// envelope in-test, so a drift in the real helper's `required_posting_auths`
// (e.g. to `required_auths`, or to a wrong account) would pass those suites
// green. Driving the real helper into a spied `hiveClient.broadcast.json` and
// reading back the captured operation closes that gap. The unset-key spec
// independently pins the `AdminKeyNotConfiguredError` guard that the call-site
// mocks never exercise. `config.pevoAdminPostingKey` is mutated locally and
// restored in `finally` so neither spec leaks state into sibling tests.
describe('broadcastAdminCustomJson admin-envelope shape', () => {
  // A valid throwaway WIF so the real helper's `PrivateKey.fromString` parse
  // and unset-key guard both pass; the broadcast itself is spied, so this key
  // never signs a real chain write.
  const VALID_ADMIN_WIF = PrivateKey.fromSeed('pevo-admin-envelope-test').toString();

  it('emits id=config.appTag, required_auths=[], required_posting_auths=[config.hiveAdminAccount] through the real helper', async () => {
    const savedKey = config.pevoAdminPostingKey;
    config.pevoAdminPostingKey = VALID_ADMIN_WIF;
    const broadcastSpy = vi
      .spyOn(hiveClient.broadcast, 'json')
      .mockResolvedValueOnce({ id: 'admin-tx', block_num: 1, expired: false, trx_num: 0 } as never);
    try {
      await broadcastAdminCustomJson({ action: 'accredit', account: 'someone' });

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      const [op] = broadcastSpy.mock.calls[0] as unknown as [
        { id: string; required_auths: unknown[]; required_posting_auths: unknown[]; json: string },
        unknown,
      ];
      expect(op.id).toBe(config.appTag);
      // Empty active-auth array (admin signs with posting authority only).
      expect(op.required_auths).toEqual([]);
      // Single posting authority: the configured admin account.
      expect(op.required_posting_auths).toEqual([config.hiveAdminAccount]);
    } finally {
      config.pevoAdminPostingKey = savedKey;
    }
  });

  it('throws AdminKeyNotConfiguredError and never broadcasts when the admin key is unset', async () => {
    const savedKey = config.pevoAdminPostingKey;
    config.pevoAdminPostingKey = '';
    const broadcastSpy = vi.spyOn(hiveClient.broadcast, 'json');
    try {
      await expect(
        broadcastAdminCustomJson({ action: 'accredit', account: 'someone' }),
      ).rejects.toBeInstanceOf(AdminKeyNotConfiguredError);
      expect(broadcastSpy).not.toHaveBeenCalled();
    } finally {
      config.pevoAdminPostingKey = savedKey;
    }
  });
});
