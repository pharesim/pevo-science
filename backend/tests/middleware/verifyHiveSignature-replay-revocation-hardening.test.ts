/**
 * Hardening pins for three pre-existing verifyHiveSignature edge cases:
 *
 * (1) Concurrent-replay TOCTOU on the Redis-fallback branch. When Redis is
 *     unavailable or SETNX throws, the in-memory replay claim must happen
 *     synchronously (check-then-add) before any await, so two concurrent
 *     identical signatures cannot both pass the start-of-request check before
 *     either records. Exactly one of the pair is admitted.
 * (2) Same-second JWT revocation. A token issued in the same integer second as
 *     a password reset must be revoked UNLESS it is the token reissued by that
 *     reset — identified by a `reissuedAt` claim equal to the stored
 *     sessions_invalidated_at epoch-ms, not by its (identical) iat second.
 * (3) iat-absent JWT fail-closed. A bearer token without a numeric `iat` is
 *     rejected rather than skipping the session-invalidation lookup, so
 *     revocation completeness never rides on the unenforced "every mint sets
 *     iat" invariant.
 *
 * Test-mock carve-out (per root CLAUDE.md "Running Tests"):
 *   (a) Justification: `getRedis`/`isRedisAvailable` are stubbed to simulate the
 *       Redis SETNX-throw flap, which cannot be induced deterministically
 *       against a live Redis. `getAppPool` is stubbed so the session-invalidation
 *       lookup returns a chosen sessions_invalidated_at (the same-second boundary
 *       is impractical to provoke against a live row), and the iat-absent path is
 *       exercised without a live Postgres row. `hiveClient.database.getAccounts`
 *       is stubbed to publish the test posting key (same pattern as
 *       verifyHiveSignature-authmethod / verifyHiveSignature-replay-timestamp).
 *   (b) verifyHiveSignature is NOT mocked: cryptographic signature recovery and
 *       posting-key match run real for the concurrent-replay path, and the focus
 *       here IS the middleware's own replay/revocation behavior.
 *   (c) Real-path companions: the signature success path runs with real
 *       verification in verifyHiveSignature-authmethod.test.ts; the live
 *       SESSION_INVALIDATED 401 against real Postgres is covered by the settings
 *       password-reset suites; the recover reissue (which sets reissuedAt against
 *       real Postgres) is covered by recover.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { PrivateKey } from '@hiveio/dhive';
import { config } from '../../src/config.js';
import { signRequestBound } from '../support/sign-request.js';

const TEST_USERNAME = 'hardeninguser';
const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-replay-revocation-hardening-test-seed');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();

const { redisSetMock } = vi.hoisted(() => ({ redisSetMock: vi.fn() }));
const { queryMock, getAppPoolMock } = vi.hoisted(() => {
  const queryMock = vi.fn();
  const getAppPoolMock = vi.fn((): { query: typeof queryMock } | null => ({ query: queryMock }));
  return { queryMock, getAppPoolMock };
});

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn().mockImplementation((names: string[]) =>
        names.includes(TEST_USERNAME)
          ? Promise.resolve([{ name: TEST_USERNAME, posting: { key_auths: [[TEST_PUBLIC_KEY, 1]] } }])
          : Promise.resolve([]),
      ),
    },
  },
}));

// Redis reports `ready` so the SETNX path is taken; the per-test redisSetMock
// behavior decides whether that call succeeds or throws.
vi.mock('../../src/redis.js', () => ({
  isRedisAvailable: () => true,
  getRedis: () => ({ set: redisSetMock }),
}));

vi.mock('../../src/app-db.js', () => ({
  getAppPool: getAppPoolMock,
}));

const { verifyHiveSignature } = await import('../../src/middleware/verifyHiveSignature.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/probe', verifyHiveSignature, (req: Request, res: Response) =>
    res.status(200).json({ ok: true, hiveUsername: req.hiveUsername }),
  );
  return app;
}

function sign(method: string, path: string, body: unknown, timestamp: string): string {
  return signRequestBound(TEST_PRIVATE_KEY, method, path, body, timestamp);
}

function signedProbe(app: express.Express, signature: string, timestamp: string, body: unknown) {
  return request(app)
    .post('/probe')
    .set('X-Hive-Username', TEST_USERNAME)
    .set('X-Hive-Signature', signature)
    .set('X-Hive-Timestamp', timestamp)
    .send(body as object);
}

function bearerProbe(token: string) {
  return request(makeApp()).post('/probe').set('Authorization', `Bearer ${token}`).send({});
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('verifyHiveSignature — concurrent-replay TOCTOU (item 1)', () => {
  beforeEach(() => {
    redisSetMock.mockReset();
  });

  it('admits exactly one of two concurrent identical signatures when SETNX throws', async () => {
    // Park BOTH requests at `await redis.set` before failing either, so both have
    // passed the start-of-request replay check (the exact TOCTOU window) before
    // the fallback claim runs. Under the synchronous check-then-add, whichever
    // request reaches the fallback second sees the first's add and is rejected.
    const rejecters: Array<(e: Error) => void> = [];
    redisSetMock.mockImplementation(() => new Promise<never>((_resolve, reject) => { rejecters.push(reject); }));

    const app = makeApp();
    const timestamp = new Date().toISOString();
    const body = { probe: 'concurrent-toctou' };
    const signature = sign('POST', '/probe', body, timestamp);

    // Attaching `.then` dispatches each supertest request now (the Test is
    // otherwise lazy and would not send until awaited), so both reach
    // `await redis.set` and register their rejecter before we fail them.
    const p1 = signedProbe(app, signature, timestamp, body).then((r) => r);
    const p2 = signedProbe(app, signature, timestamp, body).then((r) => r);

    await waitFor(() => rejecters.length === 2);
    rejecters.forEach((reject) => reject(new Error('SETNX unavailable during flap')));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.status, r2.status].sort()).toEqual([200, 401]);
    const replay = [r1, r2].find((r) => r.status === 401)!;
    expect(replay.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('verifyHiveSignature — same-second JWT revocation (item 2)', () => {
  // .500 places the invalidation mid-second; the tokens below all carry the same
  // integer-second iat, so only the reissuedAt identity match distinguishes them.
  const INVALIDATED_AT_MS = 1_700_000_000_500;
  const INVALIDATED_SEC = Math.floor(INVALIDATED_AT_MS / 1000);
  const FAR_FUTURE_EXP = 9_999_999_999;

  beforeEach(() => {
    queryMock.mockReset();
    getAppPoolMock.mockReset();
    getAppPoolMock.mockReturnValue({ query: queryMock });
    queryMock.mockResolvedValue({ rows: [{ sessions_invalidated_at: new Date(INVALIDATED_AT_MS) }] });
  });

  it('revokes a pre-reset token minted in the same integer second (no reissuedAt)', async () => {
    const token = jwt.sign(
      { sub: TEST_USERNAME, custody: 'light', iat: INVALIDATED_SEC, exp: FAR_FUTURE_EXP },
      config.sessionSecret,
    );
    const res = await bearerProbe(token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_INVALIDATED');
  });

  it('spares the freshly reissued token whose reissuedAt matches the stored invalidation ms', async () => {
    const token = jwt.sign(
      { sub: TEST_USERNAME, custody: 'light', iat: INVALIDATED_SEC, reissuedAt: INVALIDATED_AT_MS, exp: FAR_FUTURE_EXP },
      config.sessionSecret,
    );
    const res = await bearerProbe(token);
    expect(res.status).toBe(200);
    expect(res.body.hiveUsername).toBe(TEST_USERNAME);
  });

  it('still revokes a stale reissued token whose reissuedAt is from an earlier reset', async () => {
    // A token reissued by a PRIOR reset (reissuedAt = an older ms) must not survive
    // a later invalidation — its reissuedAt no longer matches the current stored ms.
    const token = jwt.sign(
      { sub: TEST_USERNAME, custody: 'light', iat: INVALIDATED_SEC, reissuedAt: INVALIDATED_AT_MS - 5_000, exp: FAR_FUTURE_EXP },
      config.sessionSecret,
    );
    const res = await bearerProbe(token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_INVALIDATED');
  });

  it('revokes a token whose reissuedAt shares the second but not the exact millisecond', async () => {
    // Same integer second AND greater than the stored ms: a seconds-grain
    // weakening of the exemption (floor(reissuedAt/1000) === invalidatedAtSec)
    // or a >= substitution would wrongly spare this token. The exemption must
    // match the stored epoch-ms exactly — one millisecond off is not the
    // reissue identity, so revocation wins.
    const token = jwt.sign(
      { sub: TEST_USERNAME, custody: 'light', iat: INVALIDATED_SEC, reissuedAt: INVALIDATED_AT_MS + 1, exp: FAR_FUTURE_EXP },
      config.sessionSecret,
    );
    const res = await bearerProbe(token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_INVALIDATED');
  });
});

describe('verifyHiveSignature — iat-absent JWT fail-closed (item 3)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    getAppPoolMock.mockReset();
    getAppPoolMock.mockReturnValue({ query: queryMock });
  });

  it('rejects a bearer JWT minted without an iat claim', async () => {
    // noTimestamp omits iat; the middleware must fail closed (401) rather than
    // skip the session-invalidation lookup. The pool is never consulted.
    const token = jwt.sign({ sub: TEST_USERNAME, custody: 'light' }, config.sessionSecret, { noTimestamp: true });
    const res = await bearerProbe(token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(queryMock).not.toHaveBeenCalled();
  });
});
