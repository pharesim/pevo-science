/**
 * Coverage for `POST /api/wot/retract` under live-threshold WoT membership.
 *
 * The retract handler no longer broadcasts a revocation. WoT membership is live:
 * once the retract_vouch is reflected on-chain, a vouchee that drops below the
 * threshold loses accreditation automatically (recomputed from the live vouch
 * graph in `activeAccreditationsCteBody`) with NO `revoke` op, and recovering
 * vouches restores it. So a retraction is a non-event here — the handler runs
 * the signer-accreditation gate, the self-target guard, busts the stale
 * vouch-status cache via `pollForRetraction`, and returns a self-heal response.
 * This pins the core invariant: NO admin broadcast fires on any retract, at or
 * below threshold, verified or not.
 *
 * Carve-out justification (per root CLAUDE.md "Running Tests"):
 *   - Mocks `getPool()` / `getAppPool()` (shared pool helpers — enumerated
 *     carve-out scope) and `broadcastAdminCustomJson` (third-party Hive client —
 *     in scope) so the no-broadcast invariant can be asserted deterministically.
 *     A real-HAF variant would need a seeded voucher->vouchee graph crossing the
 *     threshold AND a way to verify a non-broadcast, which is seed-and-wait per
 *     test (HAF indexing lag). The signer-accreditation gate (`getAccreditedSet`)
 *     and the retraction poll (`pollForRetraction` -> `getVouchStatus`) run REAL
 *     against the mocked pool; only the pool and the broadcast are stubbed.
 *   - `verifyHiveSignature` is NOT mocked — auth runs real via the JWT Bearer
 *     short-circuit (same pattern as `tests/routes/wot-vouch-broadcast-outcomes.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { AccreditationMethod } from '../../src/wot.js';

const { hafQueryMock, appQueryMock, broadcastAdminMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
  appQueryMock: vi.fn().mockResolvedValue({ rows: [] }),
  broadcastAdminMock: vi.fn(),
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
    // The retract path must NEVER broadcast; the mock asserts call-count 0.
    broadcastAdminCustomJson: broadcastAdminMock,
  };
});

const { hafCache } = await import('../../src/cache.js');
const { config } = await import('../../src/config.js');
const { PrivateKey } = await import('@hiveio/dhive');
const { createApp } = await import('../../src/app.js');

const app = createApp();

const originalAdminKey = config.pevoAdminPostingKey;
const TEST_WIF = PrivateKey.fromSeed('pevo-wot-retract-route-test-seed').toString();

const VOUCHEE = 'bob';
const VOUCHER = 'alice';

function jwtFor(username: string): string {
  return jwt.sign({ sub: username, custody: 'self' }, config.sessionSecret, { expiresIn: '1h' });
}

/**
 * Drive the HAF queries the retract flow issues against the mocked pool:
 * `getAccreditedSet`'s signer-gate lookup (now composing the shared membership
 * CTE -> `SELECT account FROM active_accreditations WHERE account IN (...)`) and
 * `getVouchStatus`'s combined snapshot (vouches + own method via `json_agg` +
 * `AS self_method`).
 *
 * - `voucheeVouches` (default `[]`): the vouchee's current accredited-voucher
 *   list. Empty (VOUCHER absent) means the poll sees the retraction reflected on
 *   its first read; including VOUCHER means the edge persists (not-yet-reflected).
 * - `voucheeMethod` (default `'wot'`): the vouchee's own accreditation method.
 * - `accredited` (default true): whether the signer passes the getAccreditedSet gate.
 */
function makeHafMock(opts: {
  voucheeVouches?: string[];
  voucheeMethod?: AccreditationMethod | null;
  accredited?: boolean;
}) {
  const accredited = opts.accredited ?? true;
  const voucheeVouches = opts.voucheeVouches ?? [];
  const voucheeMethod = opts.voucheeMethod === undefined ? 'wot' : opts.voucheeMethod;
  return async (sql: string) => {
    // getVouchStatus's combined snapshot — the only query that aggregates the
    // vouchee's vouchers (`json_agg`) AND selects its own `self_method`. Checked
    // FIRST because it is the most specific shape.
    if (sql.includes('json_agg(') && sql.includes('AS self_method')) {
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
    // getAccreditedSet's batch lookup (the /retract signer-accreditation gate):
    // composes activeAccreditationsCteBody then filters by account.
    if (sql.includes('FROM active_accreditations') && sql.includes('account IN')) {
      return accredited ? { rows: [{ account: VOUCHER }] } : { rows: [] };
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
  (config as { pevoAdminPostingKey: string }).pevoAdminPostingKey = TEST_WIF;
});

afterEach(() => {
  (config as { pevoAdminPostingKey: string }).pevoAdminPostingKey = originalAdminKey;
});

describe('POST /api/wot/retract — live-threshold self-heal (no revoke broadcast)', () => {
  it('rejects a non-accredited signer with 403 and broadcasts nothing', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ accredited: false }));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(403);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('rejects a self-targeted retract with 422', async () => {
    hafQueryMock.mockImplementation(makeHafMock({}));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHER });

    expect(res.status).toBe(422);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('rejects a missing/invalid vouchee with 400', async () => {
    hafQueryMock.mockImplementation(makeHafMock({}));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({});

    expect(res.status).toBe(400);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('returns a self-heal response (no broadcast) when the vouchee is now below threshold and the retraction is reflected', async () => {
    // Retraction reflected: VOUCHER's edge absent from the vouchee's snapshot,
    // leaving it with 2 vouchers (< threshold 3). Under the OLD op-pinned model
    // this is exactly when a revoke fired; under live membership it self-heals.
    hafQueryMock.mockImplementation(makeHafMock({ voucheeVouches: ['carol', 'dave'], voucheeMethod: 'wot' }));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.data.revocation_outcome).toBe('none');
    expect(res.body.data.revocations).toEqual([]);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
    // The response carries the fresh vouch_status the poll returned.
    expect(res.body.data.vouch_status.vouch_count).toBe(2);
  });

  it('returns a self-heal response (no broadcast) when the retraction is not yet reflected on-chain', async () => {
    // VOUCHER's edge still present in the snapshot (HAF lag / never broadcast):
    // the poll never sees it disappear. Still no broadcast — there is no sticky
    // revoke to grief with, so the unverified case is harmless.
    hafQueryMock.mockImplementation(makeHafMock({ voucheeVouches: [VOUCHER, 'carol'], voucheeMethod: 'wot' }));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.data.revocation_outcome).toBe('none');
    expect(res.body.data.revocations).toEqual([]);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('broadcasts nothing even when the vouchee remains at/above threshold after the retraction', async () => {
    hafQueryMock.mockImplementation(makeHafMock({ voucheeVouches: ['carol', 'dave', 'erin'], voucheeMethod: 'wot' }));

    const res = await request(app)
      .post('/api/wot/retract')
      .set('Authorization', `Bearer ${jwtFor(VOUCHER)}`)
      .send({ vouchee: VOUCHEE });

    expect(res.status).toBe(200);
    expect(res.body.data.revocation_outcome).toBe('none');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });
});
