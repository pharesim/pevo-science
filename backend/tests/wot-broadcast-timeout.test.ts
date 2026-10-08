/**
 * `broadcastWotAccreditation` tagged-union outcomes (timeout / happy /
 * chain_error), the skip for a vouchee that already holds an accredit op, and
 * the ever-sanctioned refusal.
 *
 * WoT membership is live (a threshold drop self-heals with no `revoke` op), so
 * there is no longer a revocation cascade to exercise: the broadcast surface is
 * the enrollment op this function emits.
 *
 * Carve-out (root CLAUDE.md "Running Tests"): `getPool()`, Redis (null, so
 * `hafCache` runs in memory), `hasUnliftedSanction`, the reputation seed, and
 * the Hive broadcast are mocked so the broadcast-outcome surface can be driven
 * deterministically — a real broadcast landing or timing out cannot be
 * produced reliably against a live Hive node, and this is a service-level unit
 * with no route (cryptographic verification is out of scope; there is no
 * `verifyHiveSignature` here). The vouch-status read is NOT mocked: it runs
 * against the mocked pool, which returns the `vouchStatusSelect` single-row
 * `{ self_method, self_pinned, vouches }` shape.
 * Real-path companion: `backend/tests/wot-vouch-status-select-real-postgres.test.ts` [self_pinned]
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  hafQueryMock,
  broadcastJsonMock,
  hasUnliftedSanctionMock,
  seedAccreditationBonusMock,
} = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
  broadcastJsonMock: vi.fn(),
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

vi.mock('../src/accreditation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/accreditation.js')>()),
  hasUnliftedSanction: hasUnliftedSanctionMock,
}));

vi.mock('../src/reputation.js', async () => {
  const actual = await vi.importActual<typeof import('../src/reputation.js')>('../src/reputation.js');
  return {
    ...actual,
    seedAccreditationBonus: seedAccreditationBonusMock,
  };
});

const { broadcastWotAccreditation, getVouchStatus, vouchStatusCacheKey } = await import('../src/wot.js');
const { BroadcastTimeoutError } = await import('../src/hive.js');
const { hafCache } = await import('../src/cache.js');
const { config } = await import('../src/config.js');
const { PrivateKey } = await import('@hiveio/dhive');

// Stub a posting key so the early-return ("key not configured") path doesn't
// short-circuit coverage. The mocked broadcast never signs with it, but
// PrivateKey.fromString(...) runs first and needs a valid-checksum WIF.
const originalAdminKey = config.pevoAdminPostingKey;
const TEST_WIF = PrivateKey.fromSeed('pevo-wot-broadcast-timeout-test-seed').toString();

const ELIGIBLE_VOUCHES = [
  { voucher: 'a', relationship: 'colleague', timestamp: '2026-01-01' },
  { voucher: 'b', relationship: 'colleague', timestamp: '2026-01-02' },
  { voucher: 'c', relationship: 'colleague', timestamp: '2026-01-03' },
];

// Drive the vouch-status read to "eligible" (3 vouches >= default threshold 3). The
// real vouchStatusSelect returns ONE row: { self_method, self_pinned, vouches }.
// The default row is a vouchee with no accred_pinned row.
function mockEligibleVouchStatus(self: Record<string, unknown> = { self_method: null, self_pinned: false }) {
  hafQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('active_vouches') && sql.includes('ORDER BY av.event_timestamp')) {
      return {
        rows: [
          {
            ...self,
            vouches: ELIGIBLE_VOUCHES,
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
  hasUnliftedSanctionMock.mockReset();
  seedAccreditationBonusMock.mockReset();
  // Defaults: not sanctioned, reputation seed no-ops.
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
    expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
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

  // `accredited_accounts_all` is warm and lacks the vouchee, as it does for up
  // to its TTL after the vouchee's accredit op is indexed. The vouchee holds an
  // accred_pinned row, so no broadcast fires, whatever the row's method.
  it.each([
    ['an authority-pinned', 'email'],
    ['a wot', 'wot'],
    ['a method-less', null],
  ])('skips (no broadcast) when the vouchee holds %s accredit op the cached accredited set lacks', async (_label, method) => {
    await hafCache.set('accredited_accounts_all', ['a', 'b', 'c'], 10 * 60_000, true);
    mockEligibleVouchStatus({ self_method: method, self_pinned: true });
    broadcastJsonMock.mockResolvedValue({ id: 'tx-over-existing-op' });

    const result = await broadcastWotAccreditation('alice');
    expect(result).toEqual({ ok: false, reason: 'skipped' });
    expect(broadcastJsonMock).not.toHaveBeenCalled();
  });

  it('skips (no broadcast) when the vouch-status row carries no self_pinned column', async () => {
    mockEligibleVouchStatus({ self_method: null });
    broadcastJsonMock.mockResolvedValue({ id: 'tx-unknown-presence' });

    const result = await broadcastWotAccreditation('alice');
    expect(result).toEqual({ ok: false, reason: 'skipped' });
    expect(broadcastJsonMock).not.toHaveBeenCalled();
  });

  it('skips (no broadcast) when the cached vouch status carries no self_pinned field', async () => {
    // A cache miss would read this row and broadcast.
    mockEligibleVouchStatus();
    await hafCache.set(vouchStatusCacheKey('alice'), {
      username: 'alice',
      vouch_count: 3,
      threshold: 3,
      vouches: ELIGIBLE_VOUCHES,
      eligible: true,
      accreditation_method: null,
    }, 60_000);
    broadcastJsonMock.mockResolvedValue({ id: 'tx-unknown-presence' });

    const result = await broadcastWotAccreditation('alice');
    expect(result).toEqual({ ok: false, reason: 'skipped' });
    expect(broadcastJsonMock).not.toHaveBeenCalled();
  });

  it('refuses with reason "sanctioned" (no broadcast) when the vouchee has an un-lifted sanction', async () => {
    // A sanctioned account has no accred_pinned row, so it passes the presence
    // check; only the ever-sanctioned guard distinguishes it from a
    // never-enrolled account.
    mockEligibleVouchStatus();
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
              self_method: null,
              self_pinned: false,
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

describe('getVouchStatus', () => {
  it('leaves self_pinned off the status it returns', async () => {
    mockEligibleVouchStatus({ self_method: 'email', self_pinned: true });

    const status = await getVouchStatus('alice');
    expect(Object.keys(status!).sort()).toEqual(
      ['accreditation_method', 'eligible', 'threshold', 'username', 'vouch_count', 'vouches'],
    );
  });
});
