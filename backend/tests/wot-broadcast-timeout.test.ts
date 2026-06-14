/**
 * `broadcastWotAccreditation` tagged-union outcomes (timeout / happy /
 * chain_error), the already-accredited skip, and the ever-sanctioned refusal.
 *
 * WoT membership is live (a threshold drop self-heals with no `revoke` op), so
 * there is no longer a revocation cascade to exercise — the broadcast surface is
 * the single enrollment op this function emits on the first threshold crossing.
 *
 * Carve-out (root CLAUDE.md "Running Tests"): `getPool()`, `getAccreditedSet`,
 * `hasUnliftedSanction`, the reputation seed, and the Hive broadcast are mocked
 * so the broadcast-outcome surface can be driven deterministically — a real
 * broadcast landing or timing out cannot be produced reliably against a live
 * Hive node, and this is a service-level unit with no route (cryptographic
 * verification is out of scope; there is no `verifyHiveSignature` here). The
 * real-path companion is the WoT vouch/retract route suite, which drives
 * `broadcastWotAccreditation` through the real accreditation/vouch reads against
 * HAF. `getVouchStatus` is NOT mocked: it runs against the mocked pool returning
 * the real `vouchStatusSelect` single-row `{ self_method, vouches }` shape, so
 * the eligibility computation under test is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  hafQueryMock,
  broadcastJsonMock,
  accreditedSetMock,
  hasUnliftedSanctionMock,
  seedAccreditationBonusMock,
} = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
  broadcastJsonMock: vi.fn(),
  accreditedSetMock: vi.fn(),
  hasUnliftedSanctionMock: vi.fn(),
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
    // broadcastAdminCustomJson's internal call to broadcastJsonWithTimeout binds
    // lexically inside hive.js, so override it to route through the mock with the
    // same admin envelope. The specs observe payload.json and call-count here.
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
  hasUnliftedSanction: hasUnliftedSanctionMock,
}));

vi.mock('../src/reputation.js', async () => {
  const actual = await vi.importActual<typeof import('../src/reputation.js')>('../src/reputation.js');
  return {
    ...actual,
    seedAccreditationBonus: seedAccreditationBonusMock,
  };
});

const { broadcastWotAccreditation } = await import('../src/wot.js');
const { BroadcastTimeoutError } = await import('../src/hive.js');
const { hafCache } = await import('../src/cache.js');
const { config } = await import('../src/config.js');
const { PrivateKey } = await import('@hiveio/dhive');

// Stub a posting key so the early-return ("key not configured") path doesn't
// short-circuit coverage. The mocked broadcast never signs with it, but
// PrivateKey.fromString(...) runs first and needs a valid-checksum WIF.
const originalAdminKey = config.pevoAdminPostingKey;
const TEST_WIF = PrivateKey.fromSeed('pevo-wot-broadcast-timeout-test-seed').toString();

// Drive getVouchStatus to "eligible" (3 vouches >= default threshold 3). The
// real vouchStatusSelect returns ONE row: { self_method, vouches }.
function mockEligibleVouchStatus() {
  hafQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('active_vouches') && sql.includes('ORDER BY av.event_timestamp')) {
      return {
        rows: [
          {
            self_method: 'wot',
            vouches: [
              { voucher: 'a', relationship: 'colleague', timestamp: '2026-01-01' },
              { voucher: 'b', relationship: 'colleague', timestamp: '2026-01-02' },
              { voucher: 'c', relationship: 'colleague', timestamp: '2026-01-03' },
            ],
          },
        ],
      };
    }
    // Threshold params query (update_params): no rows => default 3.
    return { rows: [] };
  });
}

afterEach(() => {
  (config as { pevoAdminPostingKey: string }).pevoAdminPostingKey = originalAdminKey;
});

beforeEach(async () => {
  await hafCache.clear();
  (config as { pevoAdminPostingKey: string }).pevoAdminPostingKey = TEST_WIF;
  hafQueryMock.mockReset();
  broadcastJsonMock.mockReset();
  accreditedSetMock.mockReset();
  hasUnliftedSanctionMock.mockReset();
  seedAccreditationBonusMock.mockReset();
  // Defaults: not already accredited, not sanctioned, reputation seed no-ops.
  accreditedSetMock.mockResolvedValue(new Set<string>());
  hasUnliftedSanctionMock.mockResolvedValue(false);
  seedAccreditationBonusMock.mockResolvedValue(undefined);
});

describe('broadcastWotAccreditation tagged union', () => {
  it('returns {ok:false, reason:"timeout"} when the broadcast helper times out', async () => {
    mockEligibleVouchStatus();
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

  it('returns {ok:true, txId} on the happy path and seeds the accreditation bonus', async () => {
    mockEligibleVouchStatus();
    broadcastJsonMock.mockResolvedValueOnce({ id: 'tx-happy-abc' });

    const result = await broadcastWotAccreditation('alice');
    expect(result).toEqual({ ok: true, txId: 'tx-happy-abc' });
    expect(seedAccreditationBonusMock).toHaveBeenCalledWith('alice');
    // The enrollment op is a method='wot' accredit carrying the 'wot' system marker.
    const payload = JSON.parse(broadcastJsonMock.mock.calls[0][0].json);
    expect(payload).toMatchObject({ action: 'accredit', account: 'alice', method: 'wot', issued_by: 'wot' });
  });

  it('returns {ok:false, reason:"chain_error"} on a non-timeout broadcast failure', async () => {
    mockEligibleVouchStatus();
    const chainErr = new Error('Invalid authority');
    broadcastJsonMock.mockRejectedValueOnce(chainErr);

    const result = await broadcastWotAccreditation('alice');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('chain_error');
      expect(result.err).toBe(chainErr);
    }
  });

  it('skips (no broadcast) when the vouchee is already accredited', async () => {
    mockEligibleVouchStatus();
    accreditedSetMock.mockResolvedValue(new Set(['alice']));

    const result = await broadcastWotAccreditation('alice');
    expect(result).toEqual({ ok: false, reason: 'skipped' });
    expect(broadcastJsonMock).not.toHaveBeenCalled();
  });

  it('refuses with reason "sanctioned" (no broadcast) when the vouchee has an un-lifted sanction', async () => {
    // Eligible by vouches and not already accredited (a sanction suppresses
    // membership, so the account is absent from getAccreditedSet) — only the
    // ever-sanctioned guard distinguishes this from a never-enrolled account.
    mockEligibleVouchStatus();
    accreditedSetMock.mockResolvedValue(new Set<string>());
    hasUnliftedSanctionMock.mockResolvedValue(true);

    const result = await broadcastWotAccreditation('alice');
    expect(result).toEqual({ ok: false, reason: 'sanctioned' });
    expect(broadcastJsonMock).not.toHaveBeenCalled();
    expect(seedAccreditationBonusMock).not.toHaveBeenCalled();
  });

  it('skips when the vouchee is below threshold (not eligible)', async () => {
    // Only 2 vouches < default threshold 3.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('active_vouches') && sql.includes('ORDER BY av.event_timestamp')) {
        return {
          rows: [
            {
              self_method: 'wot',
              vouches: [
                { voucher: 'a', relationship: 'colleague', timestamp: '2026-01-01' },
                { voucher: 'b', relationship: 'colleague', timestamp: '2026-01-02' },
              ],
            },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await broadcastWotAccreditation('alice');
    expect(result).toEqual({ ok: false, reason: 'skipped' });
    expect(broadcastJsonMock).not.toHaveBeenCalled();
  });
});
