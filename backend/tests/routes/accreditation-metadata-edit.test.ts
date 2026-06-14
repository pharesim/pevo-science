/**
 * Coverage for PATCH /api/accreditation/metadata (self-service accreditation
 * metadata edit).
 *
 * The REAL `verifyHiveSignature` middleware AND the REAL fresh-auth gate run
 * end-to-end here — the AC requires this endpoint's auth focus to NOT mock the
 * signature / fresh-auth path (a replayable bearer JWT must never be sufficient
 * for this admin-key-signed broadcast, per ARCHITECTURE.md § 6.4 / § 6.5
 * invariant #1).
 *
 * Carve-out justification (root CLAUDE.md "Running Tests"):
 *   (a) Mocked downstream targets (NOT the auth middleware):
 *       - `hiveClient.database.getAccounts` publishes a deterministic posting key
 *         so the signature recover + posting-key compare run real against a known
 *         keypair (the live chain does not seed test accounts with this keypair).
 *       - `broadcastAdminCustomJson` is stubbed so the post-auth positive reaches
 *         a deterministic 200 without broadcasting; it is downstream of both gates.
 *       - `getAccreditedSet` / `getLatestAccreditOp` (membership/op reads, NOT
 *         auth) are stubbed so the eligibility guard + merge run deterministically
 *         without seeding a live-HAF accredited graph for a synthetic username.
 *       - `getAppPool` is null so the JWT session lookup and the accounts-row
 *         metadata sync are skipped (no app DB row to seed per-test).
 *   (b) `verifyHiveSignature` and the inline fresh-auth consume are NOT mocked.
 *   (c) Risk class: a JWT-only-takeover reaching this admin-key-signed broadcast,
 *       or a signature-verification regression, undetected.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';
import jwt from 'jsonwebtoken';

const { getAccountsMock, broadcastAdminMock, getAccreditedSetMock, getLatestAccreditOpMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
  broadcastAdminMock: vi.fn(async (_payload: Record<string, unknown>) => ({ id: 'txedit' })),
  getAccreditedSetMock: vi.fn(),
  getLatestAccreditOpMock: vi.fn(),
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

vi.mock('../../src/app-db.js', () => ({
  getAppPool: () => null,
}));

vi.mock('../../src/accreditation.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/accreditation.js')>('../../src/accreditation.js');
  return {
    ...actual,
    getAccreditedSet: getAccreditedSetMock,
    getLatestAccreditOp: getLatestAccreditOpMock,
  };
});

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { getRedis } = await import('../../src/redis.js');
const { signRequestBound: signRequestBoundShared } = await import('../support/sign-request.js');

const app = createApp();

const USER = 'edituser';
const USER_KEY = PrivateKey.fromSeed('pevo-accred-metadata-edit-seed');
const USER_PUBKEY = USER_KEY.createPublic().toString();

function signRequestBound(method: string, fullPath: string, body: unknown, timestamp: string): string {
  return signRequestBoundShared(USER_KEY, method, fullPath, body, timestamp);
}

function fakeChainAccount(pubkey: string) {
  return { name: USER, posting: { weight_threshold: 1, account_auths: [], key_auths: [[pubkey, 1]] } };
}

const PRIOR = {
  name: 'Old Name',
  institution: 'Old University',
  field: 'Physics',
  method: 'orcid',
  orcid: '0000-0001-2345-6789',
  evidence_hash: 'evh-prior-123',
};

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

describe.skipIf(!redisReachable)('PATCH /api/accreditation/metadata — real verifyHiveSignature + fresh-auth', () => {
  beforeEach(() => {
    getAccountsMock.mockReset().mockResolvedValue([fakeChainAccount(USER_PUBKEY)]);
    broadcastAdminMock.mockReset().mockResolvedValue({ id: 'txedit' });
    getAccreditedSetMock.mockReset().mockResolvedValue(new Set([USER]));
    getLatestAccreditOpMock.mockReset().mockResolvedValue({ ...PRIOR });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('signature path: merges the edited field and PRESERVES method/orcid/evidence_hash; issued_by is the admin account', async () => {
    const path = '/api/accreditation/metadata';
    const body = { institution: 'New University' };
    const timestamp = new Date().toISOString();
    const signature = signRequestBound('PATCH', path, body, timestamp);

    const res = await request(app)
      .patch(path)
      .set('X-Hive-Username', USER)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    const payload = broadcastAdminMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      action: 'accredit',
      account: USER,
      name: 'Old Name', // unchanged
      institution: 'New University', // edited
      field: 'Physics', // unchanged
      method: 'orcid', // preserved
      orcid: '0000-0001-2345-6789', // preserved (ORCID binding intact)
      evidence_hash: 'evh-prior-123', // carried forward, not refabricated
      issued_by: config.hiveAdminAccount, // self-service marker
    });
  });

  it('a valid JWT with no fresh_auth_proof is rejected and does not broadcast', async () => {
    const token = jwt.sign({ sub: USER, custody: 'light', iat: Math.floor(Date.now() / 1000) }, config.sessionSecret);
    const res = await request(app)
      .patch('/api/accreditation/metadata')
      .set('Authorization', `Bearer ${token}`)
      .send({ institution: 'New University' });

    expect([401, 403]).toContain(res.status);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('rejects a request with no auth headers (401) before any broadcast', async () => {
    const res = await request(app).patch('/api/accreditation/metadata').send({ institution: 'New University' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('rejects a non-accredited (or sanctioned) caller with 403 and does not broadcast', async () => {
    // getAccreditedSet is sanction-aware, so an empty set models both
    // "never accredited" and "sanctioned / below-threshold".
    getAccreditedSetMock.mockResolvedValue(new Set<string>());
    const path = '/api/accreditation/metadata';
    const body = { institution: 'New University' };
    const timestamp = new Date().toISOString();
    const signature = signRequestBound('PATCH', path, body, timestamp);

    const res = await request(app)
      .patch(path)
      .set('X-Hive-Username', USER)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(403);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('rejects an all-empty body (400) before reaching the broadcast', async () => {
    const path = '/api/accreditation/metadata';
    const body = {};
    const timestamp = new Date().toISOString();
    const signature = signRequestBound('PATCH', path, body, timestamp);

    const res = await request(app)
      .patch(path)
      .set('X-Hive-Username', USER)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(400);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });
});
