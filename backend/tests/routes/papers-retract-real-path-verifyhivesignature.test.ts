/**
 * Real-path integration tests for `verifyHiveSignature` on
 * `POST /api/papers/:author/:permlink/retract`.
 *
 * This file is the real-path companion required by the test-mock carve-out
 * (root CLAUDE.md "Running Tests") for the sibling `papers-retract-url-shape-
 * validator.test.ts`, which uses `MOCK_VERIFY_SIGNATURE` to focus on URL-
 * shape gating upstream of the limiter. Cryptographic verification of
 * `X-Hive-Signature` against the recovered posting key, the timestamp
 * freshness window, the replay-cache `SETNX`, and the 401-on-missing-header
 * gate must all run real here.
 *
 * Carve-out justification (root CLAUDE.md "Running Tests"):
 *
 *   (a) Why some downstream targets are mocked:
 *       - `hiveClient.database.getAccounts` is stubbed via `vi.mock` to
 *         publish a deterministic posting key for the test username. The
 *         live chain does not have arbitrary test accounts seeded with the
 *         keypair this file controls; mocking the chain-read lets the
 *         signature recover + posting-key compare run real against a known
 *         key set. Same approach as `tests/middleware/verifyHiveSignature-
 *         authmethod.test.ts` and `routes/bridge-register-enqueue.test.ts`.
 *       - `getPool()` is mocked to return an empty HAF result so the
 *         post-auth handler reaches the 404 "paper not found" branch
 *         deterministically. Seeding a real paper through the pevotest
 *         chain per-test is impractical.
 *
 *   (b) `verifyHiveSignature` is NOT mocked. The middleware runs real,
 *       which is precisely the point of this file. The signature recovery
 *       (`Signature.fromString().recover()`), the timing-safe key compare
 *       against the chain key set, the timestamp-window check, and the
 *       Redis replay-cache SETNX all execute against the production code
 *       path. The auth focus is cryptographic verification.
 *
 *   (c) Risk class — silent regression in `verifyHiveSignature` (key-
 *       rotation handling, alternate sig encodings, header parsing, replay
 *       cache) reaching `/retract` undetected because every other retract
 *       test bypasses the middleware via `MOCK_VERIFY_SIGNATURE` — is the
 *       gap this file closes. The mocked-sibling
 *       `papers-retract-url-shape-validator.test.ts` cites this file as its
 *       real-path companion; an equivalent real-path middleware companion
 *       exists for custody routes at `routes/custody-upgrade.test.ts` and
 *       at `middleware/verifyHiveSignature-authmethod.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

const TEST_USERNAME = 'retractuser';
const OTHER_USERNAME = 'someoneelse';
const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-retract-real-path-test-seed');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();
const OTHER_PRIVATE_KEY = PrivateKey.fromSeed('pevo-retract-real-path-other-seed');
const OTHER_PUBLIC_KEY = OTHER_PRIVATE_KEY.createPublic().toString();

// Hoisted mocks so vi.mock factory references are valid at module-init time.
const { getAccountsMock, hafQueryMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
  hafQueryMock: vi.fn().mockResolvedValue({ rows: [] }),
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

// HAF pool mock: return empty rows so `fetchPaperDetailFromHaf` reports
// paper-not-found and the handler emits 404. The 404 is the load-bearing
// post-auth signal: it proves the middleware chain (verifyHiveSignature →
// validateRetractParams → retractLimiter → handler) ran end-to-end.
vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock }),
  isHafConfigured: () => true,
  closeHafPool: async () => { /* no-op */ },
}));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { getRedis } = await import('../../src/redis.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');
const { signRequestBound: signRequestBoundShared } = await import('../support/sign-request.js');

const app = createApp();

function signRequestBound(method: string, fullPath: string, body: unknown, timestamp: string): string {
  return signRequestBoundShared(TEST_PRIVATE_KEY, method, fullPath, body, timestamp);
}

/** Build a fake on-chain account whose posting key contains `pubkey`. Mirrors
 *  the shape `verifyHiveSignature` consumes: `account.posting.key_auths`. */
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

// Redis readiness gate: the real `verifyHiveSignature` SETNX path requires
// Redis to be reachable for the replay cache; an unreachable Redis would
// silently fall through to the in-memory cache and the test would still
// pass, but the assertion would not exercise the production path. Gate
// the suite so it skips cleanly when the dev Redis container is offline.
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
  'POST /api/papers/:author/:permlink/retract — real-path verifyHiveSignature',
  () => {
    beforeEach(async () => {
      getAccountsMock.mockReset();
      // Default: published posting key is the test keypair's pubkey. Tests
      // that need a mismatched chain key override per-call.
      getAccountsMock.mockResolvedValue([fakeChainAccount(TEST_PUBLIC_KEY)]);
      hafQueryMock.mockReset();
      hafQueryMock.mockResolvedValue({ rows: [] });
      // The retract limiter persists state across specs; clear so a 429
      // from earlier probes cannot mask the auth-stage assertion under test.
      await clearRateLimitKeys(['paper-retract']);
    });

    afterAll(async () => {
      await clearRateLimitKeys(['paper-retract']);
    });

    // ─── POSITIVE: real signature accepted, handler reached ──────────────

    it('valid signed request reaches the handler (404 paper-not-found, not 401)', async () => {
      const author = TEST_USERNAME;
      const permlink = 'nonexistent-paper';
      const path = `/api/papers/${author}/${permlink}/retract`;
      const body = { reason: 'real-path probe' };
      const timestamp = new Date().toISOString();
      const signature = signRequestBound('POST', path, body, timestamp);

      const res = await request(app)
        .post(path)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(body);

      // 404 NOT_FOUND is the load-bearing post-auth assertion: the request
      // traversed verifyHiveSignature (real cryptographic recovery + key
      // match against `posting.key_auths`), then validateRetractParams
      // (URL-shape OK), then retractLimiter (slot available), then the
      // handler's `fetchPaperDetailFromHaf` lookup which returned no rows.
      // A regression in any earlier middleware stage would produce 401 /
      // 400 / 429 instead.
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      // Chain key was consulted by the real signature verifier.
      expect(getAccountsMock).toHaveBeenCalledWith([TEST_USERNAME]);
    });

    // ─── NEGATIVE: missing signature header ──────────────────────────────

    it('missing X-Hive-Signature header is rejected with 401', async () => {
      const path = `/api/papers/${TEST_USERNAME}/no-paper/retract`;
      const res = await request(app)
        .post(path)
        .set('X-Hive-Username', TEST_USERNAME)
        .send({ reason: 'no signature' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toMatch(/X-Hive-Username and X-Hive-Signature/);
      // Auth fails before the chain read; the mocked getAccounts must
      // never have been consulted.
      expect(getAccountsMock).not.toHaveBeenCalled();
      // And the handler never ran — no HAF query.
      expect(hafQueryMock).not.toHaveBeenCalled();
    });

    // ─── NEGATIVE: missing X-Hive-Timestamp header ───────────────────────

    it('missing X-Hive-Timestamp header is rejected with 401', async () => {
      const path = `/api/papers/${TEST_USERNAME}/no-paper/retract`;
      const body = { reason: 'no timestamp' };
      const timestamp = new Date().toISOString();
      const signature = signRequestBound('POST', path, body, timestamp);

      const res = await request(app)
        .post(path)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', signature)
        // X-Hive-Timestamp intentionally omitted.
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toMatch(/X-Hive-Timestamp/);
    });

    // ─── NEGATIVE: malformed signature ───────────────────────────────────

    it('malformed X-Hive-Signature is rejected with 401', async () => {
      const path = `/api/papers/${TEST_USERNAME}/no-paper/retract`;
      const body = { reason: 'malformed sig' };
      const timestamp = new Date().toISOString();

      const res = await request(app)
        .post(path)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', 'zzznot-a-real-signature')
        .set('X-Hive-Timestamp', timestamp)
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    // ─── NEGATIVE: signature recovers a key not in the chain key set ─────

    it('signature whose recovered pubkey is not in posting.key_auths is rejected with 401', async () => {
      // Override: the chain publishes a DIFFERENT posting key than the
      // one our signing private key derives. The signature recovers
      // TEST_PUBLIC_KEY (via the legitimate sign+recover round trip), but
      // the timing-safe compare against `[OTHER_PUBLIC_KEY]` fails.
      getAccountsMock.mockReset();
      getAccountsMock.mockResolvedValue([fakeChainAccount(OTHER_PUBLIC_KEY)]);

      const path = `/api/papers/${TEST_USERNAME}/no-paper/retract`;
      const body = { reason: 'wrong chain key' };
      const timestamp = new Date().toISOString();
      const signature = signRequestBound('POST', path, body, timestamp);

      const res = await request(app)
        .post(path)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      // Chain was consulted; the failure is the key-compare branch.
      expect(getAccountsMock).toHaveBeenCalledWith([TEST_USERNAME]);
    });

    // ─── NEGATIVE: body-tamper — signature bound to different body ───────

    it('signature bound to a different body is rejected with 401 (body-tamper defence)', async () => {
      const path = `/api/papers/${TEST_USERNAME}/no-paper/retract`;
      const signedBody = { reason: 'original body' };
      const sentBody = { reason: 'tampered body' };
      const timestamp = new Date().toISOString();
      // Sign against `signedBody`, send `sentBody`. The canonical message
      // body-hashes the request body, so a mismatch makes the recovered
      // pubkey differ from the chain key.
      const signature = signRequestBound('POST', path, signedBody, timestamp);

      const res = await request(app)
        .post(path)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(sentBody);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    // ─── NEGATIVE: expired timestamp ─────────────────────────────────────

    it('timestamp outside the 60s freshness window is rejected with 401', async () => {
      const path = `/api/papers/${TEST_USERNAME}/no-paper/retract`;
      const body = { reason: 'stale timestamp' };
      // 5 minutes in the past — well outside the MAX_SIGNATURE_AGE_MS=60s
      // window. The signature itself is otherwise valid for this timestamp;
      // the freshness gate fires first.
      const staleTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const signature = signRequestBound('POST', path, body, staleTimestamp);

      const res = await request(app)
        .post(path)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', staleTimestamp)
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toMatch(/timestamp/i);
    });

    // ─── NEGATIVE: cross-account spoof (header username ≠ signer) ────────

    it('username header does not match the on-chain key set is rejected with 401', async () => {
      // Mocked chain returns no account for OTHER_USERNAME (default empty
      // resolution for that name).
      getAccountsMock.mockReset();
      getAccountsMock.mockImplementation((names: string[]) => {
        if (names.includes(OTHER_USERNAME)) return Promise.resolve([]);
        return Promise.resolve([fakeChainAccount(TEST_PUBLIC_KEY)]);
      });

      const path = `/api/papers/${OTHER_USERNAME}/no-paper/retract`;
      const body = { reason: 'cross-account spoof' };
      const timestamp = new Date().toISOString();
      // Sign with the test key but claim to be a different user.
      const signature = signRequestBound('POST', path, body, timestamp);

      const res = await request(app)
        .post(path)
        .set('X-Hive-Username', OTHER_USERNAME)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  },
);
