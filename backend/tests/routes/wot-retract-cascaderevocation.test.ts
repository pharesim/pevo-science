/**
 * Regression coverage for the `POST /api/wot/retract` re-evaluation account and
 * the single-snapshot revoke decision.
 *
 * Two bugs this file pins:
 *   1. Wrong account. The retract handler used to call
 *      `cascadeRevocation(voucher)`, re-evaluating the VOUCHER's still-active
 *      vouchees (none of which lost a vouch) and never re-evaluating the VOUCHEE
 *      whose vouch was actually withdrawn. The fix routes `/retract` through
 *      `revokeVoucheeIfBelowThreshold` against the VOUCHEE behind a
 *      signer-accreditation gate, a self-target guard, and an on-chain
 *      retraction-verification poll (`pollForRetraction`).
 *   2. Two-read race. The revoke decision used to come from a SEPARATE discovery
 *      query issued after the verification poll, so a fresh vouch landing between
 *      the two reads could straddle HAF's ingestion lag and revoke an account
 *      that is at-threshold on-chain. The fix takes the revoke decision from the
 *      SAME `VouchStatus` snapshot the poll already returned: `getVouchStatus`
 *      now carries the account's own accreditation method (`self_method`) so
 *      `shouldRevokeOnRetract(status)` decides from one read.
 *
 * Both layers exercise the REAL `revokeVoucheeIfBelowThreshold`,
 * `shouldRevokeOnRetract`, `getVouchStatus`, `getAccreditedSet`, and
 * `pollForRetraction` (no `wot.js` mock — a single file cannot both mock and not
 * mock the same module, and the real functions are the point of the test):
 *   1. Lib layer — calls `revokeVoucheeIfBelowThreshold` directly with a
 *      `VouchStatus` snapshot, asserting the WoT-below-threshold case broadcasts
 *      exactly one revoke targeting the vouchee, the at-threshold and
 *      non-WoT-method cases broadcast nothing, and `invalidateOnRevocation`
 *      fires before the broadcast on the timeout-ambiguous path. A separate
 *      block exercises `getVouchStatus` against a mocked pool to pin that
 *      `self_method` and the accredited-voucher count come from one read.
 *   2. Route layer — `POST /api/wot/retract` via supertest with the REAL
 *      `verifyHiveSignature` middleware (JWT Bearer short-circuit), driving the
 *      real handler -> real accreditation gate -> real `pollForRetraction` ->
 *      real `revokeVoucheeIfBelowThreshold` through the same mocked HAF pool.
 *      Asserts the handler re-evaluates the VOUCHEE, enforces the 422/403 gates,
 *      refuses to revoke on an unverified retraction, refuses to revoke when a
 *      re-vouch keeps the account at threshold in the single read, and
 *      translates each revocation outcome into the response shape.
 *
 * Carve-out justification (per root CLAUDE.md "Running Tests"):
 *   - Mocks `getPool()` (shared pool helper — enumerated carve-out scope),
 *     `getAppPool()` (shared pool helper — used by verifyHiveSignature's
 *     `sessions_invalidated_at` lookup), and `broadcastAdminCustomJson`
 *     (third-party Hive client — in scope). A real-HAF variant would need a
 *     seeded voucher -> vouchee graph crossing the threshold AND a way to
 *     induce a broadcast timeout against a live Hive node; the first is
 *     seed-and-wait per test (HAF indexing lag) and the second cannot be
 *     reliably induced from an integration test. The signer-accreditation gate
 *     (`getAccreditedSet`) and the retraction-verification poll
 *     (`pollForRetraction` -> `getVouchStatus`) run REAL against the same mocked
 *     pool; only the pool, the broadcast, and `invalidateOnRevocation` are
 *     stubbed.
 *   - `invalidateOnRevocation` is a business-logic mock justified for the same
 *     reason as the sibling `tests/wot-broadcast-timeout.test.ts`: the
 *     timeout-ordering risk class (DEL before broadcast) cannot be observed
 *     deterministically against a live broadcast.
 *   - `verifyHiveSignature` is NOT mocked — auth runs real via the JWT Bearer
 *     short-circuit (same pattern as the sibling
 *     `tests/routes/wot-vouch-broadcast-outcomes.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { VouchStatus } from '../../src/wot.js';

const {
  hafQueryMock,
  appQueryMock,
  broadcastAdminMock,
  invalidateOnRevocationMock,
  seedAccreditationBonusMock,
} = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
  appQueryMock: vi.fn().mockResolvedValue({ rows: [] }),
  broadcastAdminMock: vi.fn(),
  invalidateOnRevocationMock: vi.fn(),
  seedAccreditationBonusMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock, connect: () => Promise.reject(new Error('not used')) }),
  isHafConfigured: () => true,
  closeHafPool: async () => {},
}));

// app-db pool: verifyHiveSignature queries `accounts.sessions_invalidated_at`
// on every JWT-authenticated request. Empty rows => the JWT is accepted as-is.
vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => ({ query: appQueryMock }),
}));

vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

vi.mock('../../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hive.js')>('../../src/hive.js');
  return {
    ...actual,
    // wot.ts broadcasts revocations via broadcastAdminCustomJson; the mock
    // observes the op payload and call-count so the revoke specs can assert
    // exactly one broadcast targeting the vouchee.
    broadcastAdminCustomJson: broadcastAdminMock,
  };
});

vi.mock('../../src/reputation.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/reputation.js')>('../../src/reputation.js');
  return {
    ...actual,
    invalidateOnRevocation: invalidateOnRevocationMock,
    seedAccreditationBonus: seedAccreditationBonusMock,
  };
});

const { revokeVoucheeIfBelowThreshold, shouldRevokeOnRetract, getVouchStatus } = await import('../../src/wot.js');
const { BroadcastTimeoutError } = await import('../../src/hive.js');
const { hafCache } = await import('../../src/cache.js');
const { config } = await import('../../src/config.js');
const { PrivateKey } = await import('@hiveio/dhive');
const { createApp } = await import('../../src/app.js');

const app = createApp();

// Stub a posting key so the "key not configured" early-return doesn't
// short-circuit coverage. The mocked broadcast never signs with it.
const originalAdminKey = config.pevoAdminPostingKey;
const TEST_WIF = PrivateKey.fromSeed('pevo-wot-retract-revoke-test-seed').toString();

const VOUCHEE = 'bob';
const VOUCHER = 'alice';

function jwtFor(username: string): string {
  return jwt.sign({ sub: username, custody: 'self' }, config.sessionSecret, { expiresIn: '1h' });
}

/**
 * Build a `VouchStatus` snapshot for the lib layer. `vouchers` is the vouchee's
 * accredited-voucher list (count drives `eligible` against threshold 3);
 * `method` is the vouchee's OWN accreditation method (drives the WoT-only revoke
 * gate).
 */
function statusFor(opts: { vouchers: string[]; method: string | null; threshold?: number }): VouchStatus {
  const threshold = opts.threshold ?? 3;
  return {
    username: VOUCHEE,
    vouch_count: opts.vouchers.length,
    threshold,
    eligible: opts.vouchers.length >= threshold,
    vouches: opts.vouchers.map((v) => ({
      voucher: v,
      relationship: 'colleague',
      timestamp: '2026-01-01T00:00:00Z',
    })),
    accreditation_method: opts.method,
  };
}

/**
 * Drive the HAF queries the real retract flow issues against the mocked pool:
 * `getAccreditedSet`'s signer-gate lookup and `getVouchStatus`'s combined
 * vouchee snapshot (vouches + own accreditation method). The discovery query
 * the old two-read path issued is GONE — the revoke decision is taken from the
 * `getVouchStatus` snapshot, so there is no separate `aa_target` recount.
 *
 * - `voucheeVouches` (default `[]`) is the vouchee's current accredited-voucher
 *   list seen by `getVouchStatus`. Empty (the retracting voucher absent) means
 *   the poll verifies the retraction on its first read; including VOUCHER means
 *   the edge persists and the poll never verifies (unverified retraction).
 * - `voucheeMethod` (default `'wot'`) is the vouchee's own accreditation method
 *   in the same snapshot. `'wot'` + below-threshold => revoke warranted.
 * - `accredited` (default true) controls whether the signer passes the
 *   `getAccreditedSet` gate.
 * - `statusThrows` makes the `getVouchStatus` read reject (HAF down). The real
 *   `getVouchStatus` swallows this to `null`, which the route fails closed on
 *   as an unverified retraction.
 * - `snapshot` captures the params of the `getVouchStatus` query so a test can
 *   assert the read targets the VOUCHEE.
 */
function makeHafMock(opts: {
  voucheeVouches?: string[];
  voucheeMethod?: string | null;
  accredited?: boolean;
  statusThrows?: boolean;
  snapshot?: { params: unknown[] | null };
}) {
  const accredited = opts.accredited ?? true;
  const voucheeVouches = opts.voucheeVouches ?? [];
  const voucheeMethod = opts.voucheeMethod === undefined ? 'wot' : opts.voucheeMethod;
  return async (sql: string, params: unknown[]) => {
    // getAccreditedSet's batch lookup (the /retract signer-accreditation gate).
    if (sql.includes('WITH ranked AS')) {
      return accredited ? { rows: [{ account: VOUCHER }] } : { rows: [] };
    }
    // getVouchStatus's combined snapshot — the only query that aggregates the
    // vouchee's vouchers (`json_agg`) AND selects its own `self_method`.
    if (sql.includes('json_agg(') && sql.includes('AS self_method')) {
      if (opts.snapshot) opts.snapshot.params = params;
      if (opts.statusThrows) throw new Error('HAF status query failed');
      return {
        rows: [
          {
            self_method: voucheeMethod,
            vouches: voucheeVouches.map((v) => ({
              voucher: v,
              relationship: 'colleague',
              timestamp: '2026-01-01T00:00:00Z',
            })),
          },
        ],
      };
    }
    // Threshold loader / fallback.
    return { rows: [] };
  };
}

beforeEach(async () => {
  await hafCache.clear();
  hafQueryMock.mockReset();
  appQueryMock.mockReset().mockResolvedValue({ rows: [] });
  broadcastAdminMock.mockReset();
  invalidateOnRevocationMock.mockReset();
  seedAccreditationBonusMock.mockReset();
  (config as { pevoAdminPostingKey: string }).pevoAdminPostingKey = TEST_WIF;
});

afterEach(() => {
  (config as { pevoAdminPostingKey: string }).pevoAdminPostingKey = originalAdminKey;
});

// ──────────────────────────────────────────────────────────────────────────
// Layer 0 — shouldRevokeOnRetract: the single-snapshot revoke predicate.
// ──────────────────────────────────────────────────────────────────────────

describe('shouldRevokeOnRetract — WoT-method AND below-threshold gate', () => {
  it('revokes a WoT account that has fallen below threshold', () => {
    expect(shouldRevokeOnRetract(statusFor({ vouchers: ['carol', 'dave'], method: 'wot' }))).toBe(true);
  });

  it('does not revoke a WoT account still at/above threshold', () => {
    expect(shouldRevokeOnRetract(statusFor({ vouchers: ['carol', 'dave', 'erin'], method: 'wot' }))).toBe(false);
  });

  it('does not revoke an email/ORCID accreditation even below threshold', () => {
    expect(shouldRevokeOnRetract(statusFor({ vouchers: ['carol'], method: 'email' }))).toBe(false);
    expect(shouldRevokeOnRetract(statusFor({ vouchers: [], method: 'orcid' }))).toBe(false);
  });

  it('does not revoke an unaccredited account', () => {
    expect(shouldRevokeOnRetract(statusFor({ vouchers: [], method: null }))).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Layer 1 — lib-level revokeVoucheeIfBelowThreshold from a status snapshot.
// ──────────────────────────────────────────────────────────────────────────

describe('revokeVoucheeIfBelowThreshold — retract-time vouchee re-evaluation', () => {
  it('revokes the VOUCHEE when its WoT accreditation has fallen below threshold', async () => {
    broadcastAdminMock.mockResolvedValue({ id: 'tx-revoke-bob' });

    const result = await revokeVoucheeIfBelowThreshold(statusFor({ vouchers: ['carol', 'dave'], method: 'wot' }));

    expect(result).toEqual({ outcome: 'revoked', txId: 'tx-revoke-bob' });

    // Exactly one revoke broadcast, and it targets the vouchee (status.username),
    // never the voucher. This is the core wrong-account regression: the old code
    // re-evaluated the voucher's still-active vouchees instead.
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0] as { action: string; account: string };
    expect(payload.action).toBe('revoke');
    expect(payload.account).toBe(VOUCHEE);
  });

  it('skips (no broadcast) when the vouchee stays at/above threshold', async () => {
    const result = await revokeVoucheeIfBelowThreshold(
      statusFor({ vouchers: ['carol', 'dave', 'erin'], method: 'wot' }),
    );

    expect(result).toEqual({ outcome: 'skipped' });
    expect(broadcastAdminMock).not.toHaveBeenCalled();
    expect(invalidateOnRevocationMock).not.toHaveBeenCalled();
  });

  it('skips (no broadcast) when the account is accredited by a non-WoT method', async () => {
    // An email/ORCID accreditation is never revoked on a vouch retract even
    // below threshold — only WoT auto-accreditations track the vouch count.
    const result = await revokeVoucheeIfBelowThreshold(statusFor({ vouchers: ['carol'], method: 'email' }));

    expect(result).toEqual({ outcome: 'skipped' });
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('issues NO HAF query of its own (decision taken from the passed snapshot)', async () => {
    await revokeVoucheeIfBelowThreshold(statusFor({ vouchers: ['carol', 'dave', 'erin'], method: 'wot' }));

    // The revoke decision reads the status snapshot, not a second discovery
    // query. The cascade's `SELECT av_target.vouchee` find query and the old
    // `FROM active_accreditations aa_target` recount must NEVER fire here.
    const cascadeFindCalls = hafQueryMock.mock.calls.filter((c) =>
      String(c[0]).includes('SELECT av_target.vouchee'));
    const recountCalls = hafQueryMock.mock.calls.filter((c) =>
      String(c[0]).includes('FROM active_accreditations aa_target'));
    expect(cascadeFindCalls).toHaveLength(0);
    expect(recountCalls).toHaveLength(0);
  });

  it('fires invalidateOnRevocation BEFORE broadcast on the timeout-ambiguous path', async () => {
    const order: Array<'invalidate' | 'broadcast'> = [];
    invalidateOnRevocationMock.mockImplementation(async () => {
      order.push('invalidate');
    });
    broadcastAdminMock.mockImplementation(async () => {
      order.push('broadcast');
      throw new BroadcastTimeoutError(30_000);
    });

    const result = await revokeVoucheeIfBelowThreshold(statusFor({ vouchers: ['carol', 'dave'], method: 'wot' }));

    expect(result).toMatchObject({ outcome: 'timeout' });
    expect(invalidateOnRevocationMock).toHaveBeenCalledWith(VOUCHEE);
    // Critical wiring: a stale positive score cannot leak past an ambiguous
    // timeout, so the DEL must precede the broadcast.
    expect(order).toEqual(['invalidate', 'broadcast']);
  });

  it('returns chain_error (no throw) when the revoke broadcast fails', async () => {
    broadcastAdminMock.mockRejectedValue(new Error('Invalid authority'));

    const result = await revokeVoucheeIfBelowThreshold(statusFor({ vouchers: ['carol', 'dave'], method: 'wot' }));

    expect(result).toMatchObject({ outcome: 'chain_error' });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Layer 1b — getVouchStatus carries the account's own accreditation method
// and the accredited-voucher count from a single read.
// ──────────────────────────────────────────────────────────────────────────

describe('getVouchStatus — single-read snapshot (vouches + self_method)', () => {
  it('exposes the accredited-voucher count and the account own method', async () => {
    const snapshot = { params: null as unknown[] | null };
    hafQueryMock.mockImplementation(
      makeHafMock({ voucheeVouches: ['carol', 'dave'], voucheeMethod: 'wot', snapshot }),
    );

    const status = await getVouchStatus(VOUCHEE);

    expect(status).not.toBeNull();
    expect(status!.vouch_count).toBe(2);
    expect(status!.accreditation_method).toBe('wot');
    // The combined snapshot reads for the VOUCHEE.
    expect(snapshot.params).not.toBeNull();
    expect(snapshot.params!).toContain(VOUCHEE);
  });

  it('still carries self_method when the account has zero accredited vouchers', async () => {
    // The all-vouches-retracted case is exactly the one the retract path must
    // revoke on: the aggregate over an empty vouches set still yields one row, so
    // self_method survives. A regression that loses the row (e.g. dropping the
    // COALESCE/single-group shape) would null the method and never revoke.
    hafQueryMock.mockImplementation(makeHafMock({ voucheeVouches: [], voucheeMethod: 'wot' }));

    const status = await getVouchStatus(VOUCHEE);

    expect(status).not.toBeNull();
    expect(status!.vouch_count).toBe(0);
    expect(status!.eligible).toBe(false);
    expect(status!.accreditation_method).toBe('wot');
    expect(shouldRevokeOnRetract(status!)).toBe(true);
  });

  it('reports a null method for an unaccredited account', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ voucheeVouches: ['carol'], voucheeMethod: null }));

    const status = await getVouchStatus(VOUCHEE);

    expect(status!.accreditation_method).toBeNull();
    expect(shouldRevokeOnRetract(status!)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Layer 2 — route-level POST /api/wot/retract (real handler + real lib fn).
// ──────────────────────────────────────────────────────────────────────────

describe('POST /api/wot/retract — re-evaluates the vouchee, not the voucher', () => {
  it('re-evaluates the VOUCHEE from one snapshot and revokes it', async () => {
    const snapshot = { params: null as unknown[] | null };
    // Verified retraction (VOUCHER edge absent) AND vouchee now below threshold,
    // WoT-accredited => revoke.
    hafQueryMock.mockImplementation(
      makeHafMock({ voucheeVouches: ['carol', 'dave'], voucheeMethod: 'wot', snapshot }),
    );
    broadcastAdminMock.mockResolvedValue({ id: 'tx-revoke-bob' });

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.revocations).toEqual(['tx-revoke-bob']);
    expect(res.body.data.revocation_outcome).toBe('revoked');
    expect(res.body.data.message).toContain('was revoked');

    // Core regression assertion: the un-vouched VOUCHEE is the re-evaluation
    // target. The snapshot read and the revoke broadcast both bind the vouchee,
    // never the voucher. The old code passed `voucher` to the re-evaluation.
    expect(snapshot.params).not.toBeNull();
    expect(snapshot.params!).toContain(VOUCHEE);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0] as { account: string };
    expect(payload.account).toBe(VOUCHEE);
  });

  it('returns no revocations and broadcasts nothing when the vouchee stays above threshold', async () => {
    hafQueryMock.mockImplementation(
      makeHafMock({ voucheeVouches: ['carol', 'dave', 'erin'], voucheeMethod: 'wot' }),
    );

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.data.revocations).toEqual([]);
    expect(res.body.data.revocation_outcome).toBe('skipped');
    expect(res.body.data.message).toContain('No revocation needed');
    // No revoke broadcast for a vouchee still at/above threshold — and the
    // voucher's OTHER vouchees are never recounted or cascaded by this path.
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('does NOT revoke when a re-vouch keeps the account at threshold in the single read', async () => {
    // Single-snapshot race regression: the verification poll and the threshold
    // decision read the SAME snapshot. Here the retracting VOUCHER's edge is gone
    // (retraction verified) but the account is still at threshold via OTHER
    // vouchers (carol/dave/erin) — e.g. a re-vouch already reflected. One read
    // means there is no window for a separate recount to see a stale below-
    // threshold count and fire a wrong revoke.
    hafQueryMock.mockImplementation(
      makeHafMock({ voucheeVouches: ['carol', 'dave', 'erin'], voucheeMethod: 'wot' }),
    );

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.data.revocation_outcome).toBe('skipped');
    expect(res.body.data.revocations).toEqual([]);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('returns 400 when `vouchee` is missing', async () => {
    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('returns 422 when the signer retracts a vouch for themselves', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ voucheeVouches: ['carol', 'dave'], voucheeMethod: 'wot' }));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHER });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the signer is not an accredited researcher', async () => {
    hafQueryMock.mockImplementation(
      makeHafMock({ voucheeVouches: ['carol', 'dave'], voucheeMethod: 'wot', accredited: false }),
    );

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    // The revocation path is never reached for a non-accredited signer.
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('maps a revoke-broadcast timeout to revocation_outcome=timeout', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ voucheeVouches: ['carol', 'dave'], voucheeMethod: 'wot' }));
    broadcastAdminMock.mockRejectedValue(new BroadcastTimeoutError(30_000));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.data.revocation_outcome).toBe('timeout');
    expect(res.body.data.revocations).toEqual([]);
    expect(res.body.data.message).toContain('degraded state');
  });

  it('maps a revoke-broadcast failure to revocation_outcome=chain_error', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ voucheeVouches: ['carol', 'dave'], voucheeMethod: 'wot' }));
    broadcastAdminMock.mockRejectedValue(new Error('Invalid authority'));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.data.revocation_outcome).toBe('chain_error');
    expect(res.body.data.revocations).toEqual([]);
    expect(res.body.data.message).toContain('failed');
  });

  it('fails closed (unverified) when the status read throws (HAF down)', async () => {
    // A HAF failure in the single read surfaces as a null status from
    // getVouchStatus, which the route treats as an unverified retraction and
    // refuses to revoke — same fail-closed posture as a never-broadcast retract.
    // This runs the full poll cap, hence the extended per-test timeout.
    hafQueryMock.mockImplementation(makeHafMock({ statusThrows: true }));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.data.revocation_outcome).toBe('unverified');
    expect(res.body.data.revocations).toEqual([]);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  }, 15_000);

  it('does NOT revoke when the retraction is unverified (voucher edge still present)', async () => {
    // Griefing regression: the signer is an accredited voucher of the
    // at-threshold vouchee but broadcast NO on-chain retract, so the poll keeps
    // seeing the edge and never verifies. The handler must refuse to revoke.
    // This exercises the full poll cap (no first-read verification), so it runs
    // a few seconds — hence the extended per-test timeout.
    hafQueryMock.mockImplementation(
      makeHafMock({ voucheeVouches: [VOUCHER, 'carol', 'dave'], voucheeMethod: 'wot' }),
    );

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.data.revocation_outcome).toBe('unverified');
    expect(res.body.data.revocations).toEqual([]);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  }, 15_000);
});
