/**
 * Replay-guard and timestamp-window hardening pins for verifyHiveSignature.
 *
 * (1) The replay guard must not fail open when Redis is `ready` but a SETNX
 *     call throws (the ioredis "ready-but-throwing" flap). The in-memory store
 *     is the unconditional backstop: a signature recorded on a successful
 *     verification is detected as a replay even when a later Redis call errors.
 * (2) Timestamp validation is past-biased — a small forward skew is tolerated,
 *     but future-dating beyond the skew is rejected so a signature's usable
 *     window cannot be doubled past the documented 60 seconds.
 *
 * Test-mock carve-out (per root CLAUDE.md "Running Tests"):
 *   (a) Justification: `getRedis`/`isRedisAvailable` are stubbed to simulate
 *       the ready-but-throwing flap, which cannot be induced deterministically
 *       against a live Redis. `hiveClient.database.getAccounts` is stubbed to
 *       publish the test posting key (same pattern as
 *       verifyHiveSignature-authmethod.test.ts).
 *   (b) verifyHiveSignature is NOT mocked: cryptographic signature recovery and
 *       posting-key match run real, and the focus here IS the middleware's own
 *       replay/timestamp behavior.
 *   (c) Real-path companion: the signature-success path is also exercised with
 *       real verification in verifyHiveSignature-authmethod.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response } from 'express';
import { PrivateKey } from '@hiveio/dhive';
import { verifyHiveSignature } from '../../src/middleware/verifyHiveSignature.js';
import { signRequestBound } from '../support/sign-request.js';

const TEST_USERNAME = 'replayuser';
const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-replay-timestamp-test-seed-deterministic');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();

const { redisSetMock } = vi.hoisted(() => ({ redisSetMock: vi.fn() }));

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

// Redis reports `ready` (isRedisAvailable === true) so the SETNX path is taken;
// the per-test `redisSetMock` behavior decides whether that call succeeds or
// throws, exercising the ready-but-throwing flap.
vi.mock('../../src/redis.js', () => ({
  isRedisAvailable: () => true,
  getRedis: () => ({ set: redisSetMock }),
}));

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/probe', verifyHiveSignature, (_req: Request, res: Response) => res.status(200).json({ ok: true }));
  return app;
}

function sign(method: string, path: string, body: unknown, timestamp: string): string {
  return signRequestBound(TEST_PRIVATE_KEY, method, path, body, timestamp);
}

function probe(app: express.Express, signature: string, timestamp: string, body: unknown) {
  return request(app)
    .post('/probe')
    .set('X-Hive-Username', TEST_USERNAME)
    .set('X-Hive-Signature', signature)
    .set('X-Hive-Timestamp', timestamp)
    .send(body as object);
}

describe('verifyHiveSignature — replay-guard in-memory backstop', () => {
  beforeEach(() => {
    redisSetMock.mockReset();
  });

  it('rejects a replay via the in-memory store when SETNX throws on the second request', async () => {
    // First request: SETNX succeeds (returns a non-null reply => new key, not a
    // replay). Second request re-presents the SAME signature while SETNX throws
    // (Redis flap). The middleware must still reject as a replay because the
    // in-memory store was populated on the first successful verification.
    redisSetMock.mockResolvedValueOnce('OK').mockRejectedValue(new Error('READONLY during failover'));

    const app = makeApp();
    const timestamp = new Date().toISOString();
    const body = { probe: 'replay' };
    const signature = sign('POST', '/probe', body, timestamp);

    const first = await probe(app, signature, timestamp, body);
    expect(first.status).toBe(200);

    const second = await probe(app, signature, timestamp, body);
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('verifyHiveSignature — timestamp window (past-biased)', () => {
  beforeEach(() => {
    redisSetMock.mockReset();
    // Never a replay in these cases — each request uses a distinct timestamp.
    redisSetMock.mockResolvedValue('OK');
  });

  async function probeWithOffset(offsetMs: number) {
    const app = makeApp();
    const timestamp = new Date(Date.now() + offsetMs).toISOString();
    const body = { probe: 'ts', n: offsetMs };
    const signature = sign('POST', '/probe', body, timestamp);
    return probe(app, signature, timestamp, body);
  }

  it('accepts a timestamp 30s in the past', async () => {
    expect((await probeWithOffset(-30_000)).status).toBe(200);
  });

  it('rejects a timestamp 90s in the past (expired)', async () => {
    const res = await probeWithOffset(-90_000);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('tolerates a small forward skew (3s in the future)', async () => {
    expect((await probeWithOffset(3_000)).status).toBe(200);
  });

  it('rejects future-dating beyond the forward skew (30s in the future)', async () => {
    const res = await probeWithOffset(30_000);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
