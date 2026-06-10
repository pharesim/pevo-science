/**
 * Route tests for `GET /api/me/authorships/pending` with REAL
 * `verifyHiveSignature` against signed requests.
 *
 * Carve-out justification (root CLAUDE.md "Running Tests"):
 *
 *   (a) Why some downstream targets are mocked:
 *       - `hiveClient.database.getAccounts` is stubbed via `vi.mock` to
 *         publish a deterministic posting key for the test username, so the
 *         real signature recovery + timing-safe key compare run against a
 *         known key set (same approach as
 *         `papers-retract-real-path-verifyhivesignature.test.ts`).
 *       - `getPool()` is mocked with a SQL-dispatching responder: seeding
 *         multi-user claim/consent scenarios through live HAF per test is
 *         impractical (real broadcasts + indexing lag). The dispatcher only
 *         shapes ROWS; the statements' SQL semantics are pinned against a
 *         real planner by the FROM-redirect companion
 *         `tests/me-pending-authorships-real-postgres.test.ts`.
 *
 *   (b) `verifyHiveSignature` is NOT mocked. This surface IS auth-focused
 *       (the user proving they are the claimer the response is scoped to),
 *       so cryptographic verification, the 401-on-missing-header gate, and
 *       the replay cache all run real.
 *
 *   (c) Real-path companions: the SQL risk class is covered by
 *       `me-pending-authorships-real-postgres.test.ts`; the middleware risk
 *       class additionally by
 *       `papers-retract-real-path-verifyhivesignature.test.ts` and
 *       `middleware/verifyHiveSignature-authmethod.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

const TEST_USERNAME = 'pendinguser';
const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-me-pending-real-path-test-seed');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();
const WRONG_PRIVATE_KEY = PrivateKey.fromSeed('pevo-me-pending-wrong-key-seed');

const { getAccountsMock, hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as unknown[] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hive.js')>('../../src/hive.js');
  return {
    ...actual,
    hiveClient: {
      database: { getAccounts: getAccountsMock },
      broadcast: actual.hiveClient.broadcast,
    },
  };
});

// Keep HafQueryError / isRetriableHafError real (the 503 translation under
// test depends on them); only the pool accessor is mocked.
vi.mock('../../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
  return {
    ...actual,
    getPool: getPoolMock,
    isHafConfigured: () => getPoolMock() !== null,
    closeHafPool: async () => { /* no-op */ },
  };
});

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { getRedis } = await import('../../src/redis.js');
const { signRequestBound } = await import('../support/sign-request.js');

const app = createApp();
const PATH = '/api/me/authorships/pending';

function fakeChainAccount(pubkey: string) {
  return {
    name: TEST_USERNAME,
    posting: {
      weight_threshold: 1,
      account_auths: [],
      key_auths: [[pubkey, 1]],
    },
  };
}

/** Signed GET against PATH. Body-less GETs sign the empty-object body the
 *  canonical-message SSoT coalesces to. */
async function signedGet(privateKey = TEST_PRIVATE_KEY) {
  const timestamp = new Date().toISOString();
  const signature = signRequestBound(privateKey, 'GET', PATH, undefined, timestamp);
  return request(app)
    .get(PATH)
    .set('X-Hive-Username', TEST_USERNAME)
    .set('X-Hive-Signature', signature)
    .set('X-Hive-Timestamp', timestamp);
}

const CLAIM_ROWS = [
  { paper_author: 'root1', paper_permlink: 'q1', author_index: 7, claimed_at: 't-300' },
];
const CONSENT_ROWS = [
  { paper_author: 'root1', paper_permlink: 'q1' },
  { paper_author: 'root3', paper_permlink: 'q3' },
];

/** Dispatch the two statements the route runs by their distinguishing CTE
 *  selects. Anything else (none expected) gets empty rows. */
function stagePendingRows(claims: unknown[], consents: unknown[]) {
  hafQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM authorship_claims')) return { rows: claims };
    if (sql.includes('FROM consent_signer_eligibility')) return { rows: consents };
    return { rows: [] };
  });
}

// Redis readiness gate, mirroring the retract real-path suite: the real
// replay-cache SETNX path requires Redis; skip cleanly when offline.
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

describe.skipIf(!redisReachable)('GET /api/me/authorships/pending — real-path verifyHiveSignature', () => {
  beforeEach(async () => {
    getAccountsMock.mockReset();
    getAccountsMock.mockResolvedValue([fakeChainAccount(TEST_PUBLIC_KEY)]);
    hafQueryMock.mockReset();
    hafQueryMock.mockResolvedValue({ rows: [] });
    getPoolMock.mockReset();
    getPoolMock.mockReturnValue({ query: hafQueryMock });
    await hafCache.clear();
  });

  it('valid signed request returns both pending lists', async () => {
    stagePendingRows(CLAIM_ROWS, CONSENT_ROWS);
    const res = await signedGet();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      pending_claims: CLAIM_ROWS,
      pending_consents: CONSENT_ROWS,
    });
    // The real verifier consulted the chain key set.
    expect(getAccountsMock).toHaveBeenCalledWith([TEST_USERNAME]);
  });

  it('missing auth headers are rejected 401 before any HAF query', async () => {
    const res = await request(app).get(PATH);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(getAccountsMock).not.toHaveBeenCalled();
    expect(hafQueryMock).not.toHaveBeenCalled();
  });

  it('a signature from a key the chain does not publish is rejected 401', async () => {
    const res = await signedGet(WRONG_PRIVATE_KEY);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(hafQueryMock).not.toHaveBeenCalled();
  });

  it('HAF pool unavailable fails closed with retriable 503, never an empty 200', async () => {
    getPoolMock.mockReturnValue(null);
    const res = await signedGet();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details).toEqual({ retriable: true });
  });

  it('a transient query failure surfaces the retriable 503 envelope', async () => {
    hafQueryMock.mockRejectedValue(new Error('connection reset'));
    const res = await signedGet();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details).toEqual({ retriable: true });
  });

  it('the pool-null sentinel is not cached: recovery serves data without waiting out a TTL', async () => {
    getPoolMock.mockReturnValue(null);
    expect((await signedGet()).status).toBe(503);
    // HAF returns; the prior failure must not have poisoned the cache.
    getPoolMock.mockReturnValue({ query: hafQueryMock });
    stagePendingRows(CLAIM_ROWS, CONSENT_ROWS);
    const res = await signedGet();
    expect(res.status).toBe(200);
    expect(res.body.data.pending_claims).toEqual(CLAIM_ROWS);
  });
});
