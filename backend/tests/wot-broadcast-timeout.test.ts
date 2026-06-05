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
    // The real broadcastAdminCustomJson would call the REAL
    // broadcastJsonWithTimeout (its internal call binds lexically inside
    // hive.js, not via the mocked export), reaching a live Hive node. Override
    // it to route through broadcastJsonMock with the same admin envelope so the
    // cascade/accreditation specs observe payload.json and call-count as before.
    broadcastAdminCustomJson: async (payload: Record<string, unknown>) => {
      const { config } = await import('../src/config.js');
      return broadcastJsonMock({
        id: config.appTag,
        required_auths: [],
        required_posting_auths: [config.hiveAdminAccount],
        json: JSON.stringify(payload),
      });
    },
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
 * The cascade does ONE discovery query shape per cascade level (folding
 * the previous per-vouchee accreditation-check + recount round-trips into
 * a single query that returns only the vouchees whose accreditation must
 * be revoked):
 *  - "discover wot-accredited vouchees of revokedAccount whose remaining
 *     voucher count would fall below threshold" — one per cascade level.
 *
 * The fixture filters the union of vouchees by `wotVouchees` to emulate
 * the SQL `aa_target.method = 'wot'` and HAVING-threshold gates, returning
 * only the to-be-revoked subset (matching the production query's contract).
 */
function makeCascadeHafMock(opts: {
  // map from revokedAccount => child vouchees that the discovery query
  // identifies as needing revocation (already filtered by wot+threshold).
  childrenByRevoker: Record<string, string[]>;
  // vouchees treated as wot-accredited below threshold (will be revoked);
  // children not in this set are dropped to emulate the SQL gates.
  wotVouchees: Set<string>;
}) {
  return async (sql: string, params: unknown[]) => {
    // Discovery query — matches the `JOIN active_accreditations aa_target`
    // projection (only shape emitted by cascadeRevocation post-collapse).
    if (sql.includes('SELECT av_target.vouchee')) {
      // params: [...cteParams, revokedAccount, threshold]
      const revoker = params[params.length - 2] as string;
      const kids = opts.childrenByRevoker[revoker] ?? [];
      const filtered = kids.filter((k) => opts.wotVouchees.has(k));
      return { rows: filtered.map((v) => ({ vouchee: v })) };
    }
    // Threshold params loader / fallback.
    return { rows: [] };
  };
}

// cascadeRevocation discovery-query collapse: the per-level loop must fire
// exactly one HAF discovery query (not 1+2K). Regression-pins the rewrite
// against the prior find + per-vouchee accreditation-check + per-vouchee
// recount triplet.
describe('cascadeRevocation — single discovery query per level', () => {
  it('fires exactly one HAF query for a K-vouchee level (not 1+2K)', async () => {
    hafQueryMock.mockImplementation(
      makeCascadeHafMock({
        // Leaf-only cascade: boss has 3 vouchees; none of them have further
        // vouchees, so the recursive descendants each issue exactly one
        // (zero-row) discovery query.
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
    // 1 top-level discovery + 3 leaf-level discoveries (one per cascaded
    // vouchee, all returning zero further children) = 4 HAF queries.
    // Previously: 1 + (2 * 3) = 7 for the top level alone (plus per-leaf
    // recursion). The collapse pins 4.
    expect(hafQueryMock).toHaveBeenCalledTimes(4);
  });

  it('selects only wot-accredited vouchees that fall below threshold (parity with prior loop)', async () => {
    // The fixture's `wotVouchees` set emulates the SQL gates
    // (aa_target.method = 'wot' AND HAVING count < threshold). Vouchees
    // outside the set are dropped — mirroring the previous loop's
    // per-vouchee accreditation + recount filters.
    hafQueryMock.mockImplementation(
      makeCascadeHafMock({
        childrenByRevoker: { boss: ['wot-low', 'wot-high', 'non-wot'] },
        // Only wot-low survives both gates; wot-high has >= threshold
        // remaining vouchers (not in wotVouchees), non-wot fails the method
        // gate (not in wotVouchees).
        wotVouchees: new Set(['wot-low']),
      }),
    );
    broadcastJsonMock.mockImplementation(async (payload: { json: string }) => {
      const parsed = JSON.parse(payload.json) as { account: string };
      return { id: `tx-${parsed.account}` };
    });

    const completed = await cascadeRevocation('boss');
    expect(completed).toEqual(['tx-wot-low']);
    expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
  });

  it('binds revokedAccount and threshold to the discovery query', async () => {
    // Pin the parameter slot contract: cteParams come first, then
    // revokedAccount, then threshold. Off-by-one in the bind order would
    // silently flip filter semantics.
    hafQueryMock.mockImplementation(async (_sql: string, params: unknown[]) => {
      // Capture: last two params should be revokedAccount + threshold.
      expect(params[params.length - 2]).toBe('boss');
      expect(typeof params[params.length - 1]).toBe('number');
      return { rows: [] };
    });

    await cascadeRevocation('boss');
    expect(hafQueryMock).toHaveBeenCalled();
  });
});

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

  it('folds same-level unprocessed vouchees into pending when the budget blows inside a nested cascade', async () => {
    vi.useFakeTimers();
    try {
      // boss → [v1, v2, v3]; v1 → [g1]. v1's revocation lands, then the cascade
      // recurses into v1, where the budget blows on g1's deadline check (before
      // g1 is broadcast). The nested-error catch must fold BOTH g1 (surfaced by
      // the nested level) AND v2, v3 (same-level, identified but never attempted
      // — slice(i + 1)) into pending. The asymmetry this pins: the deadline-check
      // branch already slices same-level remainders, but the nested-error branch
      // used to drop them, so v2/v3 vanished from the operator's follow-up list.
      hafQueryMock.mockImplementation(
        makeCascadeHafMock({
          childrenByRevoker: { boss: ['v1', 'v2', 'v3'], v1: ['g1'] },
          wotVouchees: new Set(['v1', 'v2', 'v3', 'g1']),
        }),
      );

      broadcastJsonMock.mockImplementation(async (payload: { json: string }) => {
        const parsed = JSON.parse(payload.json) as { account: string };
        // After v1's revocation lands, jump wall-clock past the 60s budget so
        // the nested cascade for v1's children aborts on its first deadline
        // check rather than broadcasting g1.
        if (parsed.account === 'v1') {
          vi.setSystemTime(Date.now() + 61_000);
        }
        return { id: `tx-${parsed.account}` };
      });

      await expect(cascadeRevocation('boss')).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof PartialCascadeError)) return false;
        expect(err.rootRevocation).toBe('boss');
        // Only v1's revocation broadcast landed before the nested budget blow.
        expect(err.completed).toEqual(['tx-v1']);
        // g1 (nested, never attempted) + v2, v3 (same-level slice(i + 1), never
        // attempted). Pre-fix, pending would be just ['g1'] — v2/v3 silently lost.
        // Multiplicity-sensitive: sort the raw array (not a Set) so a duplicate
        // would surface as an extra element rather than collapsing silently.
        expect([...err.pending].sort()).toEqual(['g1', 'v2', 'v3']);
        // No duplicates: the operator follow-up list serializes `pending`
        // verbatim, so a repeated account name is observable noise.
        expect(err.pending.length).toBe(new Set(err.pending).size);
        // completed ∪ pending covers every originally-identified account.
        const union = new Set([...err.completed.map((id) => id.replace('tx-', '')), ...err.pending]);
        expect(union).toEqual(new Set(['v1', 'g1', 'v2', 'v3']));
        return true;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits a shared diamond-graph vouchee exactly once in pending (dedup at throw)', async () => {
    vi.useFakeTimers();
    try {
      // Diamond: boss → [a, d]; a → [d]. `d` is reachable via two voucher edges
      // (boss→d directly AND boss→a→d). a's revocation lands, then the cascade
      // recurses into a where the budget blows on d's deadline check, surfacing
      // d via `nestedErr.pending`. Back at the boss level, d also sits in the
      // same-level slice(i + 1) after a, so without the at-throw dedup it would
      // be pushed to `pending` twice. The operator follow-up list serializes
      // `pending` verbatim, so the duplicate would be observable noise.
      hafQueryMock.mockImplementation(
        makeCascadeHafMock({
          childrenByRevoker: { boss: ['a', 'd'], a: ['d'] },
          wotVouchees: new Set(['a', 'd']),
        }),
      );

      broadcastJsonMock.mockImplementation(async (payload: { json: string }) => {
        const parsed = JSON.parse(payload.json) as { account: string };
        // After a's revocation lands, jump wall-clock past the 60s budget so the
        // nested cascade for a's children (which is just d) aborts on its first
        // deadline check rather than broadcasting d.
        if (parsed.account === 'a') {
          vi.setSystemTime(Date.now() + 61_000);
        }
        return { id: `tx-${parsed.account}` };
      });

      await expect(cascadeRevocation('boss')).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof PartialCascadeError)) return false;
        expect(err.rootRevocation).toBe('boss');
        // Only a's revocation broadcast landed before the nested budget blow.
        expect(err.completed).toEqual(['tx-a']);
        // d arrives via BOTH the nested fold and the same-level slice(i + 1).
        // Pre-fix, pending would be ['d', 'd']; the at-throw dedup collapses it.
        expect([...err.pending].sort()).toEqual(['d']);
        expect(err.pending.filter((p) => p === 'd')).toHaveLength(1);
        expect(err.pending.length).toBe(new Set(err.pending).size);
        // completed ∪ pending still covers every originally-identified account.
        const union = new Set([...err.completed.map((id) => id.replace('tx-', '')), ...err.pending]);
        expect(union).toEqual(new Set(['a', 'd']));
        return true;
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Suppress linter on unused import (kept to document the export surface).
void getWotThreshold;
