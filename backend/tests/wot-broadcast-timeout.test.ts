/**
 * BE-WOT-BROADCAST-TIMEOUT-HANDLING — deterministic coverage for
 * `broadcastWotAccreditation` tagged-union outcomes and `cascadeRevocation`
 * aggregate-budget / per-vouchee timeout semantics.
 *
 * Justification for mocked `getPool()` + mocked `broadcastJsonWithTimeout`
 * (per root CLAUDE.md carve-out):
 *   - The behavior under test is the timeout / partial-cascade surface of
 *     `wot.ts`, not dhive's on-wire broadcast semantics or HAF's query
 *     planner. A real-HAF variant would need a seeded voucher → N vouchees
 *     graph AND a way to induce a 30s broadcast timeout against Hive; the
 *     first is seed-and-wait per test (HAF indexing lag), and the second
 *     cannot be reliably induced from an integration test at all.
 *   - `verifyHiveSignature` and other middleware are NOT mocked — the
 *     behaviors under test live in `wot.ts` below the route layer, and we
 *     exercise those functions directly (not via supertest).
 *   - Real-HAF parity for the non-timeout paths is covered by
 *     `backend/tests/routes/wot.test.ts` (auth + happy-path listing).
 *
 * Parallels the mocking shape already used by `accreditations-revoke.test.ts`.
 *
 * Carve-out clause-(a) extension for `invalidateOnRevocation` /
 * `seedAccreditationBonus` mocks (BACKEND-REPUTATION-SSOT round-2 hold #9):
 *   - These are business-logic functions (not pool/cache/third-party), so
 *     they fall outside the "shared pool/cache helpers" carve-out scope and
 *     require explicit per-test justification.
 *   - Real path that's impractical: the production trigger is a real
 *     cascade broadcast landing (or timing out) on chain — broadcast
 *     outcomes are non-deterministic at unit test scope, and the
 *     timeout-ambiguous path requires inducing a 30s timeout, which cannot
 *     be done reliably against Hive. Mocking the two cascade-fn calls lets
 *     this file pin one specific risk class — **call-ordering of
 *     `invalidateOnRevocation` BEFORE `broadcastJsonWithTimeout` on the
 *     timeout-ambiguous path** (per `chain-write-timeout-ambiguous-outcome-
 *     2026-04-22` convention). Without the mocks, the assertion can't
 *     observe the ordering deterministically.
 *   - Real-path companion: `tests/routes/reputation-lifecycle.test.ts`
 *     exercises `invalidateOnRevocation` end-to-end against real Redis,
 *     covering the structural behavior (cache key DEL on revoke). The
 *     companion's risk class is "behavioral DEL fires" — orthogonal to
 *     this file's "call-ordering on timeout" risk class. Both must hold;
 *     each pinned by a different test that exercises a different part of
 *     the integrated path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  hafQueryMock,
  broadcastJsonMock,
  accreditedSetMock,
  thresholdMock,
  invalidateOnRevocationMock,
  seedAccreditationBonusMock,
} = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
  broadcastJsonMock: vi.fn(),
  accreditedSetMock: vi.fn(),
  thresholdMock: vi.fn(),
  invalidateOnRevocationMock: vi.fn(),
  seedAccreditationBonusMock: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock, connect: () => Promise.reject(new Error('not used')) }),
  isHafConfigured: () => true,
  closeHafPool: async () => {},
}));

vi.mock('../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

vi.mock('../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../src/hive.js')>('../src/hive.js');
  return {
    ...actual,
    broadcastJsonWithTimeout: broadcastJsonMock,
  };
});

vi.mock('../src/accreditation.js', () => ({
  getAccreditedSet: accreditedSetMock,
}));

vi.mock('../src/reputation.js', async () => {
  const actual = await vi.importActual<typeof import('../src/reputation.js')>('../src/reputation.js');
  return {
    ...actual,
    invalidateOnRevocation: invalidateOnRevocationMock,
    seedAccreditationBonus: seedAccreditationBonusMock,
  };
});

const { broadcastWotAccreditation, cascadeRevocation, PartialCascadeError, getWotThreshold } =
  await import('../src/wot.js');
const { BroadcastTimeoutError } = await import('../src/hive.js');
const { hafCache } = await import('../src/cache.js');
const { config } = await import('../src/config.js');
const { PrivateKey } = await import('@hiveio/dhive');

// Stub a posting key so the early-return ("key not configured") path doesn't
// short-circuit our coverage. The mocked broadcastJsonWithTimeout never
// actually signs with it, but `PrivateKey.fromString(...)` runs first and
// needs a valid-checksum WIF.
const originalAdminKey = config.pevoAdminPostingKey;
const TEST_WIF = PrivateKey.fromSeed('pevo-wot-broadcast-timeout-test-seed').toString();

afterEach(() => {
  (config as { pevoAdminPostingKey: string }).pevoAdminPostingKey = originalAdminKey;
});

beforeEach(async () => {
  await hafCache.clear();
  (config as { pevoAdminPostingKey: string }).pevoAdminPostingKey = TEST_WIF;
  hafQueryMock.mockReset();
  broadcastJsonMock.mockReset();
  accreditedSetMock.mockReset();
  thresholdMock.mockReset();
  invalidateOnRevocationMock.mockReset();
  seedAccreditationBonusMock.mockReset();
  accreditedSetMock.mockResolvedValue(new Set<string>());
  invalidateOnRevocationMock.mockResolvedValue(undefined);
  seedAccreditationBonusMock.mockResolvedValue(undefined);
});

describe('BE-WOT-BROADCAST-TIMEOUT-HANDLING — broadcastWotAccreditation tagged union', () => {
  it('returns {ok:false, reason:"timeout"} when the broadcast helper times out', async () => {
    // Drive the vouch-status path: return 3 vouches so `eligible` is true.
    hafQueryMock.mockImplementation(async (sql: string) => {
      // Vouch-status query for the vouchee.
      if (sql.includes('active_vouches') && sql.includes('ORDER BY av.event_timestamp')) {
        return {
          rows: [
            { voucher: 'a', relationship: 'colleague', event_timestamp: '2026-01-01' },
            { voucher: 'b', relationship: 'colleague', event_timestamp: '2026-01-02' },
            { voucher: 'c', relationship: 'colleague', event_timestamp: '2026-01-03' },
          ],
        };
      }
      // Threshold params query: no rows => default 3.
      return { rows: [] };
    });

    broadcastJsonMock.mockImplementationOnce(async () => {
      throw new BroadcastTimeoutError(30_000);
    });

    const result = await broadcastWotAccreditation('alice');
    expect(result).toEqual({
      ok: false,
      reason: 'timeout',
      err: expect.any(BroadcastTimeoutError),
    });
  });

  it('returns {ok:true, txId} on the happy path', async () => {
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('active_vouches') && sql.includes('ORDER BY av.event_timestamp')) {
        return {
          rows: [
            { voucher: 'a', relationship: 'x', event_timestamp: '2026-01-01' },
            { voucher: 'b', relationship: 'x', event_timestamp: '2026-01-02' },
            { voucher: 'c', relationship: 'x', event_timestamp: '2026-01-03' },
          ],
        };
      }
      return { rows: [] };
    });
    broadcastJsonMock.mockResolvedValueOnce({ id: 'tx-happy-abc' });

    const result = await broadcastWotAccreditation('alice');
    expect(result).toEqual({ ok: true, txId: 'tx-happy-abc' });
  });

  it('returns {ok:false, reason:"chain_error"} on a non-timeout broadcast failure', async () => {
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('active_vouches') && sql.includes('ORDER BY av.event_timestamp')) {
        return {
          rows: [
            { voucher: 'a', relationship: 'x', event_timestamp: '2026-01-01' },
            { voucher: 'b', relationship: 'x', event_timestamp: '2026-01-02' },
            { voucher: 'c', relationship: 'x', event_timestamp: '2026-01-03' },
          ],
        };
      }
      return { rows: [] };
    });
    const chainErr = new Error('Invalid authority');
    broadcastJsonMock.mockRejectedValueOnce(chainErr);

    const result = await broadcastWotAccreditation('alice');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('chain_error');
      expect(result.err).toBe(chainErr);
    }
  });
});

/**
 * Helpers to drive cascadeRevocation's HAF query pattern.
 *
 * The cascade does three query shapes per vouchee:
 *  1) "find vouchees of revokedAccount" — one per cascade level.
 *  2) "is this vouchee WoT-accredited?" — per vouchee.
 *  3) "recount remaining vouches excluding revoker" — per vouchee.
 *
 * We route each shape to a distinct fixture response.
 */
function makeCascadeHafMock(opts: {
  // map from revokedAccount => child vouchees to cascade to
  childrenByRevoker: Record<string, string[]>;
  // vouchees treated as wot-accredited below threshold (will be revoked)
  wotVouchees: Set<string>;
}) {
  return async (sql: string, params: unknown[]) => {
    // Shape 3: recount — most specific; matches the `av.voucher != $N+1`
    // predicate that only the recount query uses.
    if (sql.includes('COUNT(*)::int')) {
      return { rows: [{ cnt: 0 }] };
    }
    // Shape 2: WoT-accredited check — matches the `SELECT method FROM
    // active_accreditations` projection.
    if (sql.includes('SELECT method FROM active_accreditations')) {
      const vouchee = params[params.length - 1] as string;
      if (opts.wotVouchees.has(vouchee)) return { rows: [{ method: 'wot' }] };
      return { rows: [] };
    }
    // Shape 1: find vouchees — matches the `SELECT av.vouchee FROM
    // active_vouches` projection.
    if (sql.includes('SELECT av.vouchee')) {
      const revoker = params[params.length - 1] as string;
      const kids = opts.childrenByRevoker[revoker] ?? [];
      return { rows: kids.map((v) => ({ vouchee: v })) };
    }
    // Threshold params loader / fallback.
    return { rows: [] };
  };
}

describe('BE-WOT-BROADCAST-TIMEOUT-HANDLING — cascadeRevocation per-vouchee timeout', () => {
  it('continues cascade when a middle vouchee times out (under aggregate budget)', async () => {
    hafQueryMock.mockImplementation(
      makeCascadeHafMock({
        childrenByRevoker: { boss: ['v1', 'v2', 'v3'] },
        wotVouchees: new Set(['v1', 'v2', 'v3']),
      }),
    );

    // v1 succeeds, v2 times out, v3 succeeds. All return quickly so the
    // aggregate budget (60s) is not approached.
    broadcastJsonMock.mockImplementation(async (payload: { json: string }) => {
      const parsed = JSON.parse(payload.json) as { account: string };
      if (parsed.account === 'v2') throw new BroadcastTimeoutError(30_000);
      return { id: `tx-${parsed.account}` };
    });

    const completed = await cascadeRevocation('boss');
    // v1 and v3 landed; v2's timeout was logged and skipped.
    expect(completed).toEqual(['tx-v1', 'tx-v3']);
    expect(broadcastJsonMock).toHaveBeenCalledTimes(3);
  });
});

// BACKEND-REPUTATION-SSOT round-1 hold #29: cascadeRevocation must call
// invalidateOnRevocation for every cascaded vouchee, AND must do so even on
// the BroadcastTimeoutError-ambiguous branch (round-1 hold #7 — moved BEFORE
// broadcast so a chain-revoked-but-cache-positive leak cannot arise from a
// timed-out broadcast). Wiring coverage; the lifecycle test exercises
// invalidateOnRevocation directly but not the wot.ts call site.
describe('BACKEND-REPUTATION-SSOT round-1 hold #29 — cascadeRevocation invalidateOnRevocation wiring', () => {
  it('fires invalidateOnRevocation for every cascaded vouchee on the success path', async () => {
    hafQueryMock.mockImplementation(
      makeCascadeHafMock({
        childrenByRevoker: { boss: ['v1', 'v2', 'v3'] },
        wotVouchees: new Set(['v1', 'v2', 'v3']),
      }),
    );
    broadcastJsonMock.mockImplementation(async (payload: { json: string }) => {
      const parsed = JSON.parse(payload.json) as { account: string };
      return { id: `tx-${parsed.account}` };
    });

    const completed = await cascadeRevocation('boss');
    expect(completed).toEqual(['tx-v1', 'tx-v2', 'tx-v3']);
    // Every cascaded vouchee got invalidated.
    expect(invalidateOnRevocationMock).toHaveBeenCalledTimes(3);
    const invalidatedUsers = invalidateOnRevocationMock.mock.calls.map((c) => c[0]);
    expect(new Set(invalidatedUsers)).toEqual(new Set(['v1', 'v2', 'v3']));
  });

  it('fires invalidateOnRevocation BEFORE broadcast on the timeout-ambiguous path (hold #7)', async () => {
    hafQueryMock.mockImplementation(
      makeCascadeHafMock({
        childrenByRevoker: { boss: ['v1'] },
        wotVouchees: new Set(['v1']),
      }),
    );

    // Capture call order via Date.now() ticks: the invalidate must run before
    // the broadcast (defended fix for the timeout-ambiguous leak).
    const order: Array<'invalidate' | 'broadcast'> = [];
    invalidateOnRevocationMock.mockImplementation(async () => {
      order.push('invalidate');
    });
    broadcastJsonMock.mockImplementation(async () => {
      order.push('broadcast');
      throw new BroadcastTimeoutError(30_000);
    });

    const completed = await cascadeRevocation('boss');
    expect(completed).toEqual([]); // timeout produced no completed tx ids
    expect(invalidateOnRevocationMock).toHaveBeenCalledTimes(1);
    expect(invalidateOnRevocationMock).toHaveBeenCalledWith('v1');
    // Critical wiring assertion: invalidate ran BEFORE broadcast.
    expect(order).toEqual(['invalidate', 'broadcast']);
  });
});

describe('BE-WOT-BROADCAST-TIMEOUT-HANDLING — cascadeRevocation aggregate budget', () => {
  it('throws PartialCascadeError when aggregate budget is exceeded', async () => {
    vi.useFakeTimers();
    try {
      // 4 vouchees. We'll advance the clock past the 60s budget between
      // iterations so the loop aborts after the first revocation lands.
      hafQueryMock.mockImplementation(
        makeCascadeHafMock({
          childrenByRevoker: { boss: ['v1', 'v2', 'v3', 'v4'] },
          wotVouchees: new Set(['v1', 'v2', 'v3', 'v4']),
        }),
      );

      broadcastJsonMock.mockImplementation(async (payload: { json: string }) => {
        const parsed = JSON.parse(payload.json) as { account: string };
        // After v1 lands, jump wall-clock past the 60s budget so the next
        // iteration's deadline check fires.
        if (parsed.account === 'v1') {
          vi.setSystemTime(Date.now() + 61_000);
        }
        return { id: `tx-${parsed.account}` };
      });

      await expect(cascadeRevocation('boss')).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof PartialCascadeError)) return false;
        expect(err.rootRevocation).toBe('boss');
        expect(err.completed).toEqual(['tx-v1']);
        // v2, v3, v4 are pending.
        expect(err.pending).toEqual(['v2', 'v3', 'v4']);
        return true;
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Suppress linter on unused import (kept to document the export surface).
void getWotThreshold;
