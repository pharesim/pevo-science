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
 *       - `getAccreditedSet` / `getLatestAccreditOp` / `hasUnliftedSanction`
 *         (membership / op / sanction reads, NOT auth) are stubbed so the
 *         eligibility guards + merge run deterministically without seeding a
 *         live-HAF accredited graph for a synthetic username. The JWT-path proof
 *         is minted by the REAL `issueFreshAuthToken` against live Redis and
 *         consumed by the REAL `consumeFreshAuthToken` — the fresh-auth gate
 *         itself is never mocked.
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

const { getAccountsMock, broadcastAdminMock, getAccreditedSetMock, getLatestAccreditOpMock, hasUnliftedSanctionMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
  broadcastAdminMock: vi.fn(async (_payload: Record<string, unknown>) => ({ id: 'txedit' })),
  getAccreditedSetMock: vi.fn(),
  getLatestAccreditOpMock: vi.fn(),
  hasUnliftedSanctionMock: vi.fn(),
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
    hasUnliftedSanction: hasUnliftedSanctionMock,
  };
});

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { getRedis } = await import('../../src/redis.js');
const { signRequestBound: signRequestBoundShared } = await import('../support/sign-request.js');
const { issueFreshAuthToken, editAccreditationMetadataFreshAuthTarget } = await import('../../src/lib/fresh-auth.js');

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
  // ORCID-origin self-service marker (the admin account). A WoT-origin op
  // carries issued_by:'wot' instead — see the issued_by-preservation spec.
  issued_by: config.hiveAdminAccount,
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
  beforeEach(async () => {
    getAccountsMock.mockReset().mockResolvedValue([fakeChainAccount(USER_PUBKEY)]);
    broadcastAdminMock.mockReset().mockResolvedValue({ id: 'txedit' });
    getAccreditedSetMock.mockReset().mockResolvedValue(new Set([USER]));
    getLatestAccreditOpMock.mockReset().mockResolvedValue({ ...PRIOR });
    hasUnliftedSanctionMock.mockReset().mockResolvedValue(false);
    // Reset the per-account edit limiter (max 5/60s, no skipFailedRequests) so
    // each spec starts with a fresh budget — this file fires more than 5 edit
    // requests for the same account across its specs.
    const redis = getRedis();
    if (redis) await redis.del(`${config.appTag}:rl:accred-edit:${USER}`);
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

  it('rejects a not-currently-accredited caller with 403 and does not broadcast', async () => {
    // An empty getAccreditedSet models "not a current member" (never accredited or
    // below-threshold WoT). The dedicated sanctioned-account case (caught by the
    // non-cached hasUnliftedSanction check) has its own spec below.
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

  it('preserves issued_by across an edit: a WoT-origin op keeps issued_by "wot"', async () => {
    // The merge carries the prior op's ORIGIN attribution forward. Filling in a
    // WoT accreditation's placeholder institution/field must NOT rewrite its
    // issued_by:'wot' marker to the admin account (the pre-fix hardcode did) —
    // method:'wot' is already preserved, and issued_by must be too.
    getLatestAccreditOpMock.mockResolvedValue({
      name: 'WoT Scientist',
      institution: 'Web of Trust',
      field: '',
      method: 'wot',
      orcid: '',
      evidence_hash: 'evh-wot-1',
      issued_by: 'wot',
    });
    const path = '/api/accreditation/metadata';
    const body = { institution: 'Real University', field: 'Biology' };
    const timestamp = new Date().toISOString();
    const signature = signRequestBound('PATCH', path, body, timestamp);

    const res = await request(app)
      .patch(path)
      .set('X-Hive-Username', USER)
      .set('X-Hive-Signature', signature)
      .set('X-Hive-Timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(200);
    expect(broadcastAdminMock.mock.calls[0][0]).toMatchObject({
      method: 'wot', // preserved
      issued_by: 'wot', // preserved — NOT config.hiveAdminAccount
      institution: 'Real University', // placeholder filled in
      field: 'Biology',
    });
  });

  it('rejects a sanctioned caller with 403 ACCREDITATION_SANCTIONED before any proof or broadcast', async () => {
    // getAccreditedSet (cached, 10-min TTL) can still report a freshly-sanctioned
    // account as a member; the non-cached hasUnliftedSanction is what refuses it.
    // Membership is left as a member so the sanction check is the gate that fires.
    hasUnliftedSanctionMock.mockResolvedValue(true);
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
    expect(res.body.error.code).toBe('ACCREDITATION_SANCTIONED');
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('returns 403 (not 503) when HAF is reachable but the account has no accredit op', async () => {
    // getLatestAccreditOp returns null only for a genuine "no accredit op" — a
    // not-accredited 403, distinct from the HAF-outage 503 below.
    getLatestAccreditOpMock.mockResolvedValue(null);
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

  it('returns a retriable 503 (not 403) when the HAF op-read throws at the upstream gate', async () => {
    // A HAF outage at the op-read must surface as a retriable 503, NOT a 403 that
    // would falsely tell a real member they are not accredited.
    getLatestAccreditOpMock.mockRejectedValueOnce(new Error('HAF down'));
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

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details.retriable).toBe(true);
    expect(broadcastAdminMock).not.toHaveBeenCalled();
  });

  it('JWT path: a valid edit_accreditation_metadata proof is accepted and the merge broadcasts (200)', async () => {
    // Exercises the JWT branch's consumeFreshAuthToken happy path end-to-end: a
    // real proof minted for (edit_accreditation_metadata, USER) is consumed and
    // the merged op broadcasts. Guards the target-hash binding from silent
    // regression (the signature-path specs never traverse this branch).
    const { token } = await issueFreshAuthToken(USER, 'password', editAccreditationMetadataFreshAuthTarget(USER));
    const sessionJwt = jwt.sign({ sub: USER, custody: 'light', iat: Math.floor(Date.now() / 1000) }, config.sessionSecret);

    const res = await request(app)
      .patch('/api/accreditation/metadata')
      .set('Authorization', `Bearer ${sessionJwt}`)
      .send({ institution: 'New University', fresh_auth_proof: token });

    expect(res.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
    expect(broadcastAdminMock.mock.calls[0][0]).toMatchObject({
      action: 'accredit',
      account: USER,
      institution: 'New University',
      method: 'orcid', // preserved from PRIOR
    });
  });

  it('JWT path: a transient HAF op-read failure returns 503 WITHOUT burning the single-use proof', async () => {
    const { token } = await issueFreshAuthToken(USER, 'password', editAccreditationMetadataFreshAuthTarget(USER));
    const sessionJwt = jwt.sign({ sub: USER, custody: 'light', iat: Math.floor(Date.now() / 1000) }, config.sessionSecret);

    // The op-read sits AHEAD of the proof consume, so a throw here returns 503 and
    // the proof is never reached -> not consumed.
    getLatestAccreditOpMock.mockRejectedValueOnce(new Error('HAF down'));
    const res1 = await request(app)
      .patch('/api/accreditation/metadata')
      .set('Authorization', `Bearer ${sessionJwt}`)
      .send({ institution: 'New University', fresh_auth_proof: token });
    expect(res1.status).toBe(503);
    expect(broadcastAdminMock).not.toHaveBeenCalled();

    // The SAME proof now succeeds once HAF recovers (the next op-read uses the
    // beforeEach default) — proving the proof was not spent on the 503 above.
    const res2 = await request(app)
      .patch('/api/accreditation/metadata')
      .set('Authorization', `Bearer ${sessionJwt}`)
      .send({ institution: 'New University', fresh_auth_proof: token });
    expect(res2.status).toBe(200);
    expect(broadcastAdminMock).toHaveBeenCalledTimes(1);
  });
});
