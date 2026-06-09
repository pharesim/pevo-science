/**
 * Regression coverage for the `POST /api/wot/retract` re-evaluation account.
 *
 * The bug this file pins: the retract handler used to call
 * `cascadeRevocation(voucher)`, re-evaluating the VOUCHER's still-active
 * vouchees (none of which lost a vouch) and never re-evaluating the VOUCHEE
 * whose vouch was actually withdrawn. The fix routes `/retract` through
 * `revokeVoucheeIfBelowThreshold(vouchee)` behind a signer-accreditation gate, a
 * self-target guard, and an on-chain retraction-verification poll
 * (`pollForRetraction`) so an unverified or fabricated retraction cannot drop a
 * victim below threshold.
 *
 * Both layers exercise the REAL `revokeVoucheeIfBelowThreshold`,
 * `getVouchStatus`, `getAccreditedSet`, and `pollForRetraction` (no `wot.js`
 * mock — a single file cannot both mock and not mock the same module, and the
 * real functions are the point of the test):
 *   1. Lib layer — calls `revokeVoucheeIfBelowThreshold` directly against a
 *      mocked HAF pool, asserting the single discovery query re-evaluates the
 *      VOUCHEE (the account bound to `aa_target.account`), the below-threshold
 *      case broadcasts exactly one revoke targeting the vouchee, the
 *      at-threshold case broadcasts nothing, `invalidateOnRevocation` fires
 *      before the broadcast on the timeout-ambiguous path, a discovery-query
 *      throw surfaces as `query_error` (not `skipped`), and the recount no
 *      longer excludes any voucher in SQL.
 *   2. Route layer — `POST /api/wot/retract` via supertest with the REAL
 *      `verifyHiveSignature` middleware (JWT Bearer short-circuit), driving the
 *      real handler -> real accreditation gate -> real `pollForRetraction` ->
 *      real `revokeVoucheeIfBelowThreshold` through the same mocked HAF pool.
 *      Asserts the handler re-evaluates the VOUCHEE, enforces the 422/403 gates,
 *      refuses to revoke on an unverified retraction, and translates each
 *      revocation outcome into the response shape.
 *
 * Wrong-account pin: the discovery query binds the vouchee as the
 * `aa_target.account = $N` re-evaluation target. The precise signal is that the
 * TARGET account — the placeholder in `aa_target.account = $N` — resolves to the
 * vouchee. The old `cascadeRevocation(voucher)` bug would have re-evaluated the
 * voucher as the target. The recount no longer carries a per-voucher exclusion:
 * the route's `pollForRetraction` verifies the retracting voucher's edge is
 * genuinely gone from `active_vouches` before the recount runs, so an
 * unconditional `av_all.voucher != $voucher` exclusion (which let a fabricated
 * retraction drop a victim) is removed.
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

const { revokeVoucheeIfBelowThreshold } = await import('../../src/wot.js');
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
 * Drive the HAF queries the real retract flow issues against the mocked pool:
 * `getAccreditedSet`'s signer-gate lookup, `pollForRetraction`'s
 * `getVouchStatus` reads, and `revokeVoucheeIfBelowThreshold`'s discovery query.
 * Each query carries a unique marker (`WITH ranked AS`, `SELECT av.voucher`,
 * `FROM active_accreditations aa_target`) so the three branches never overlap.
 *
 * - `belowThreshold` controls whether the discovery query returns the vouchee
 *   row (revoke warranted) or no row.
 * - `accredited` (default true) controls whether the signer passes the
 *   `getAccreditedSet` gate.
 * - `voucheeVouches` (default `[]`) is the vouchee's current voucher list seen
 *   by `pollForRetraction`. Empty (the retracting voucher absent) means the poll
 *   verifies the retraction on its first read; including VOUCHER means the edge
 *   persists and the poll never verifies (unverified retraction).
 * - `discoveryThrows` makes the discovery query reject (drives `query_error`).
 * - `discovery` captures the sql + params of the discovery query so a test can
 *   resolve the `aa_target.account = $N` target and assert it is the VOUCHEE.
 */
function makeHafMock(opts: {
  belowThreshold: boolean;
  accredited?: boolean;
  voucheeVouches?: string[];
  discoveryThrows?: boolean;
  discovery?: { sql: string | null; params: unknown[] | null };
}) {
  const accredited = opts.accredited ?? true;
  const voucheeVouches = opts.voucheeVouches ?? [];
  return async (sql: string, params: unknown[]) => {
    // getAccreditedSet's batch lookup (the /retract signer-accreditation gate).
    if (sql.includes('WITH ranked AS')) {
      return accredited ? { rows: [{ account: VOUCHER }] } : { rows: [] };
    }
    // The discovery query is the only one selecting from
    // `active_accreditations aa_target` — unique to this path.
    if (sql.includes('FROM active_accreditations aa_target')) {
      if (opts.discovery) {
        opts.discovery.sql = sql;
        opts.discovery.params = params;
      }
      if (opts.discoveryThrows) throw new Error('HAF discovery query failed');
      return opts.belowThreshold ? { rows: [{ account: VOUCHEE }] } : { rows: [] };
    }
    // pollForRetraction / GET getVouchStatus — the vouchee's current vouchers.
    if (sql.includes('SELECT av.voucher')) {
      return {
        rows: voucheeVouches.map((v) => ({
          voucher: v,
          relationship: 'colleague',
          event_timestamp: '2026-01-01T00:00:00Z',
        })),
      };
    }
    // Threshold loader / fallback.
    return { rows: [] };
  };
}

/** Resolve the account bound to the discovery query's `aa_target.account = $N`. */
function targetAccount(discovery: { sql: string | null; params: unknown[] | null }): unknown {
  expect(discovery.sql, 'discovery query was never issued').not.toBeNull();
  const m = discovery.sql!.match(/aa_target\.account = \$(\d+)/);
  expect(m, 'aa_target.account placeholder not found in discovery SQL').not.toBeNull();
  return discovery.params![Number(m![1]) - 1];
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
// Layer 1 — lib-level revokeVoucheeIfBelowThreshold against a mocked pool.
// ──────────────────────────────────────────────────────────────────────────

describe('revokeVoucheeIfBelowThreshold — retract-time vouchee re-evaluation', () => {
  it('revokes the VOUCHEE when its remaining vouches fall below threshold', async () => {
    const discovery = { sql: null as string | null, params: null as unknown[] | null };
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: true, discovery }));
    broadcastAdminMock.mockResolvedValue({ id: 'tx-revoke-bob' });

    const result = await revokeVoucheeIfBelowThreshold(VOUCHEE);

    expect(result).toEqual({ outcome: 'revoked', txId: 'tx-revoke-bob' });

    // Exactly one revoke broadcast, and it targets the vouchee.
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0] as { action: string; account: string };
    expect(payload.action).toBe('revoke');
    expect(payload.account).toBe(VOUCHEE);

    // The re-evaluation target (the `aa_target.account = $N` account) is the
    // VOUCHEE, never the voucher. This is the core wrong-account regression:
    // the old code re-evaluated the voucher's still-active vouchees instead.
    expect(targetAccount(discovery)).toBe(VOUCHEE);
  });

  it('skips (no broadcast) when the vouchee stays at/above threshold', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: false }));

    const result = await revokeVoucheeIfBelowThreshold(VOUCHEE);

    expect(result).toEqual({ outcome: 'skipped' });
    expect(broadcastAdminMock).not.toHaveBeenCalled();
    expect(invalidateOnRevocationMock).not.toHaveBeenCalled();
  });

  it('issues a SINGLE discovery query, not the multi-step cascade loop', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: false }));

    await revokeVoucheeIfBelowThreshold(VOUCHEE);

    // One discovery query; the threshold loader is served from getWotThreshold's
    // getOrSet cache. Critically, the cascade's `SELECT av_target.vouchee` find
    // query must NEVER fire from this path.
    const discoveryCalls = hafQueryMock.mock.calls.filter((c) =>
      String(c[0]).includes('FROM active_accreditations aa_target'));
    const cascadeFindCalls = hafQueryMock.mock.calls.filter((c) =>
      String(c[0]).includes('SELECT av_target.vouchee'));
    expect(discoveryCalls).toHaveLength(1);
    expect(cascadeFindCalls).toHaveLength(0);
  });

  it('fires invalidateOnRevocation BEFORE broadcast on the timeout-ambiguous path', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: true }));

    const order: Array<'invalidate' | 'broadcast'> = [];
    invalidateOnRevocationMock.mockImplementation(async () => {
      order.push('invalidate');
    });
    broadcastAdminMock.mockImplementation(async () => {
      order.push('broadcast');
      throw new BroadcastTimeoutError(30_000);
    });

    const result = await revokeVoucheeIfBelowThreshold(VOUCHEE);

    expect(result).toMatchObject({ outcome: 'timeout' });
    expect(invalidateOnRevocationMock).toHaveBeenCalledWith(VOUCHEE);
    // Critical wiring: a stale positive score cannot leak past an ambiguous
    // timeout, so the DEL must precede the broadcast.
    expect(order).toEqual(['invalidate', 'broadcast']);
  });

  it('returns chain_error (no throw) when the revoke broadcast fails', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: true }));
    broadcastAdminMock.mockRejectedValue(new Error('Invalid authority'));

    const result = await revokeVoucheeIfBelowThreshold(VOUCHEE);

    expect(result).toMatchObject({ outcome: 'chain_error' });
  });

  it('returns query_error (not skipped) when the discovery query throws', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: true, discoveryThrows: true }));

    const result = await revokeVoucheeIfBelowThreshold(VOUCHEE);

    // A HAF failure must be distinguishable from "no revocation needed" so a
    // needed revocation is never silently dropped under the 'skipped' label.
    expect(result).toEqual({ outcome: 'query_error' });
    expect(broadcastAdminMock).not.toHaveBeenCalled();
    expect(invalidateOnRevocationMock).not.toHaveBeenCalled();
  });

  it('recounts without excluding any voucher in SQL or params', async () => {
    const discovery = { sql: null as string | null, params: null as unknown[] | null };
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: false, discovery }));

    await revokeVoucheeIfBelowThreshold(VOUCHEE);

    // The fabricated-retraction griefing fix removes the unconditional
    // `av_all.voucher != $voucher` exclusion: the route's pollForRetraction
    // verifies the edge is genuinely gone before the recount runs, so the
    // recount counts the vouchee's CURRENT accredited vouchers honestly. A
    // regression re-introducing the exclusion (dropping a still-present voucher)
    // fails here.
    expect(discovery.sql).not.toBeNull();
    expect(discovery.sql!).not.toContain('av_all.voucher !=');
    expect(discovery.params).not.toBeNull();
    expect(discovery.params!).toContain(VOUCHEE);
    expect(discovery.params!).not.toContain(VOUCHER);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Layer 2 — route-level POST /api/wot/retract (real handler + real lib fn).
// ──────────────────────────────────────────────────────────────────────────

describe('POST /api/wot/retract — re-evaluates the vouchee, not the voucher', () => {
  it('re-evaluates the VOUCHEE (discovery target is the vouchee) and revokes it', async () => {
    const discovery = { sql: null as string | null, params: null as unknown[] | null };
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: true, discovery }));
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
    // target, NOT the voucher. The old code passed `voucher` to the
    // re-evaluation, so the discovery target would have been the voucher.
    expect(targetAccount(discovery)).toBe(VOUCHEE);

    // The single revoke broadcast targets the vouchee, never the voucher.
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0] as { account: string };
    expect(payload.account).toBe(VOUCHEE);
  });

  it('returns no revocations and broadcasts nothing when the vouchee stays above threshold', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: false }));

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
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: true }));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHER });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the signer is not an accredited researcher', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: true, accredited: false }));

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
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: true }));
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
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: true }));
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

  it('maps a discovery-query failure to revocation_outcome=query_error', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ belowThreshold: true, discoveryThrows: true }));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.data.revocation_outcome).toBe('query_error');
    expect(res.body.data.revocations).toEqual([]);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('does NOT revoke when the retraction is unverified (voucher edge still present)', async () => {
    // Griefing regression: the signer is an accredited voucher of the
    // at-threshold vouchee but broadcast NO on-chain retract, so the poll keeps
    // seeing the edge and never verifies. The handler must refuse to revoke.
    // The old unconditional `av_all.voucher != $voucher` exclusion would have
    // dropped the victim below threshold and fired an admin revoke here.
    // This exercises the full poll cap (no first-read verification), so it runs
    // a few seconds — hence the extended per-test timeout.
    hafQueryMock.mockImplementation(
      makeHafMock({ belowThreshold: true, voucheeVouches: [VOUCHER, 'carol', 'dave'] }),
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
