/**
 * Real-path companion for the roster-gated admin authority endpoints.
 *
 * This is the carve-out clause-(c) real-path companion for the sibling
 * `admin-endpoints.test.ts`, which uses `MOCK_VERIFY_SIGNATURE` (and a stubbed
 * `consumeFreshAuthToken` for the JWT-pass case) to focus on tier/lockout/
 * attribution logic. Here the REAL `verifyHiveSignature` middleware AND the REAL
 * `requireFreshAdminAuth` fresh-auth gate run end-to-end on `POST
 * /api/admin/roster/grant`, exercising the two risk classes the mocked sibling
 * bypasses:
 *   1. cryptographic signature recovery + chain-key compare (signature path), and
 *   2. the §6.4 / §6.5-invariant-#1 JWT-no-proof rejection (a replayable bearer
 *      JWT is never sufficient for an admin authority action).
 *
 * Carve-out justification (root CLAUDE.md "Running Tests"):
 *
 *   (a) Mocked downstream targets (NOT the auth middleware):
 *       - `hiveClient.database.getAccounts` is stubbed to publish a deterministic
 *         posting key for the root admin account so the signature recover +
 *         posting-key compare run real against a known keypair (the live chain
 *         does not seed arbitrary test accounts with the keypair this file
 *         controls). Same approach as the papers-retract real-path companion.
 *       - `broadcastAdminCustomJson` (a third-party-backed Hive broadcast surface)
 *         is stubbed so the post-auth signature-path positive reaches a
 *         deterministic 200 WITHOUT broadcasting to the live chain. The broadcast
 *         is downstream of both gates; stubbing it does not weaken the auth focus.
 *       - `getAppPool` is stubbed to null so the JWT session-invalidation lookup
 *         is skipped (no app DB row to seed per-test); tier=root resolves from
 *         config without a HAF read, so no roster pool is needed.
 *
 *   (b) `verifyHiveSignature` and `requireFreshAdminAuth` are NOT mocked. The
 *       signature recovery, timestamp-window check, replay-cache SETNX, and the
 *       fresh-auth consume all execute against the production code path. The auth
 *       focus IS cryptographic verification plus the fresh-proof gate.
 *
 *   (c) Risk class — a silent regression in signature verification or the
 *       JWT-only-takeover gate reaching an admin authority route undetected
 *       because the mocked sibling bypasses both — is the gap this file closes.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';
import jwt from 'jsonwebtoken';

// Hoisted mocks so vi.mock factory references resolve at module-init time.
const { getAccountsMock, broadcastAdminMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
  broadcastAdminMock: vi.fn(async (_payload: Record<string, unknown>) => ({ id: 'txadmin' })),
}));

vi.mock('../../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hive.js')>('../../src/hive.js');
  return {
    ...actual,
    hiveClient: {
      database: { getAccounts: getAccountsMock },
      broadcast: actual.hiveClient.broadcast,
    },
    broadcastAdminCustomJson: broadcastAdminMock,
  };
});

// App pool null → the JWT session-invalidation lookup is skipped; tier=root
// resolves from config without a HAF read so no roster pool is needed.
vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => null,
}));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { getRedis } = await import('../../src/redis.js');
const { signRequestBound: signRequestBoundShared } = await import('../support/sign-request.js');

const app = createApp();

// Sign as the bootstrap root account: its tier resolves from config (no HAF
// roster read), so the signature-path positive can pass the tier gate and reach
// the fresh-auth gate + handler purely on real crypto + config.
const ROOT = config.rootAdminAccount;
const ROOT_PRIVATE_KEY = PrivateKey.fromSeed('pevo-admin-fresh-auth-real-path-seed');
const ROOT_PUBLIC_KEY = ROOT_PRIVATE_KEY.createPublic().toString();

function signRequestBound(method: string, fullPath: string, body: unknown, timestamp: string): string {
  return signRequestBoundShared(ROOT_PRIVATE_KEY, method, fullPath, body, timestamp);
}

/** Chain account whose posting key set contains `pubkey`. */
function fakeChainAccount(pubkey: string) {
  return {
    name: ROOT,
    posting: { weight_threshold: 1, account_auths: [], key_auths: [[pubkey, 1]] },
  };
}

// Redis readiness gate: the real verifyHiveSignature SETNX replay cache wants a
// reachable Redis; skip cleanly when the dev container is offline (mirrors the
// papers-retract real-path companion).
let redisReachable = false;
{
  const redis = getRedis();
  if (redis) {
    for (let i = 0; i < 20 && redis.status !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    redisReachable = redis.status === 'ready';
  }
}

describe.skipIf(!redisReachable)(
  'POST /api/admin/roster/grant — real-path verifyHiveSignature + requireFreshAdminAuth',
  () => {
    beforeEach(() => {
      getAccountsMock.mockReset();
      getAccountsMock.mockResolvedValue([fakeChainAccount(ROOT_PUBLIC_KEY)]);
      broadcastAdminMock.mockReset();
      broadcastAdminMock.mockResolvedValue({ id: 'txadmin' });
    });

    afterAll(() => {
      vi.restoreAllMocks();
    });

    // ─── POSITIVE: genuine Hive-signed request clears both gates ──────────
    it('a genuine Hive-signed (self-custody) request passes auth + fresh-auth and reaches the handler', async () => {
      const path = '/api/admin/roster/grant';
      const body = { account: 'newsuperadmin', level: 'super_admin' };
      const timestamp = new Date().toISOString();
      const signature = signRequestBound('POST', path, body, timestamp);

      const res = await request(app)
        .post(path)
        .set('X-Hive-Username', ROOT)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(body);

      // 200 is the load-bearing post-auth assertion: the request traversed the
      // real verifyHiveSignature (cryptographic recovery + key match against
      // posting.key_auths), requireAdminLevel (root tier from config),
      // validate, and requireFreshAdminAuth (signature path = the request
      // signature IS the fresh proof) before the stubbed broadcast returned.
      // A regression in signature verification would 401; a regression in the
      // fresh-auth gate's signature-path bypass would 401/403 FRESH_AUTH_REQUIRED.
      expect(res.status).toBe(200);
      expect(getAccountsMock).toHaveBeenCalledWith([ROOT]);
      expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
      const payload = broadcastAdminMock.mock.calls[0][0];
      expect(payload).toMatchObject({ action: 'admin_grant', issued_by: ROOT });
    });

    // ─── NEGATIVE: missing signature header ──────────────────────────────
    it('a request with no signature headers is rejected 401 before any chain read', async () => {
      const res = await request(app)
        .post('/api/admin/roster/grant')
        .send({ account: 'newsuperadmin', level: 'super_admin' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(getAccountsMock).not.toHaveBeenCalled();
      expect(broadcastAdminMock).not.toHaveBeenCalled();
    });

    // ─── NEGATIVE: JWT-only (no fresh_auth_proof) is rejected at the gate ──
    it('a valid JWT with no fresh_auth_proof is rejected FRESH_AUTH_REQUIRED and does not broadcast', async () => {
      // Real JWT signed with the production session secret; sub = root so the
      // tier gate passes (root from config) and the request reaches the real
      // requireFreshAdminAuth, which must reject the JWT-only path.
      const token = jwt.sign(
        { sub: ROOT, custody: 'light', iat: Math.floor(Date.now() / 1000) },
        config.sessionSecret,
      );
      const res = await request(app)
        .post('/api/admin/roster/grant')
        .set('Authorization', `Bearer ${token}`)
        .send({ account: 'newsuperadmin', level: 'super_admin' });

      // missing/expired/malformed proof → 401; a presented-but-bound-wrong proof
      // → 403. A bare JWT with no proof surfaces as 401 FRESH_AUTH_REQUIRED.
      expect([401, 403]).toContain(res.status);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(broadcastAdminMock).not.toHaveBeenCalled();
    });
  },
);
