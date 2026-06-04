/**
 * Real-path integration tests for `verifyHiveSignature` on
 * `POST /api/ipfs/upload` and `POST /api/ipfs/upload-token`.
 *
 * This file is the real-path companion required by the test-mock carve-out
 * (root CLAUDE.md "Running Tests") for the siblings `ipfs-pin-durability.test.ts`,
 * `ipfs.test.ts`, and `ipfs-upload-token.test.ts`, all of which apply
 * `MOCK_VERIFY_SIGNATURE` to focus on downstream behavior (DB-durability state
 * machine / compensation call shape / route plumbing / upload-token + sha256
 * binding). Cryptographic verification of `X-Hive-Signature` against the
 * recovered posting key, the timestamp freshness window, the replay-cache
 * `SETNX`, and the 401-on-missing-header gate must all run real here.
 *
 * The `/upload-token` block specifically closes the gap that `/upload` cannot
 * cover: `/upload` 400s on the no-file branch before the token gate, so it never
 * exercises the signed-descriptor path. `/upload-token` body-hashes the declared
 * `{file_sha256, mimetype, size}` descriptor into the signed envelope, so a
 * descriptor tampered after signing must fail the real signature verify — that
 * is the real-crypto proof the declared file_sha256 is bound to the auth
 * envelope, which the mocked `ipfs-upload-token.test.ts` cannot assert.
 *
 * Carve-out justification (root CLAUDE.md "Running Tests"):
 *
 *   (a) Why some downstream targets are mocked:
 *       - `hiveClient.database.getAccounts` is stubbed via `vi.mock` to
 *         publish a deterministic posting key for the test username. The live
 *         chain does not have arbitrary test accounts seeded with the keypair
 *         this file controls; mocking the chain-read lets the signature
 *         recover + posting-key compare run real against a known key set. Same
 *         approach as `tests/routes/papers-retract-real-path-verifyhivesignature.test.ts`.
 *       - No DB/HAF mocks are needed: the post-auth load-bearing assertion is
 *         the handler's "No file provided" 400, which fires before any DB,
 *         HAF, or IPFS-backend call. That 400 (not a 401) is the proof the
 *         middleware chain (verifyHiveSignature -> ipfsUploadLimiter ->
 *         multer) ran end-to-end.
 *
 *   (b) `verifyHiveSignature` is NOT mocked. The middleware runs real, which
 *       is precisely the point of this file. The signature recovery
 *       (`Signature.fromString().recover()`), the timing-safe key compare
 *       against the chain key set, the timestamp-window check, and the Redis
 *       replay-cache SETNX all execute against the production code path. The
 *       auth focus is cryptographic verification.
 *
 *   (c) Risk class — a silent regression in `verifyHiveSignature` (key-
 *       rotation handling, alternate sig encodings, header parsing, replay
 *       cache) reaching `/api/ipfs/upload` undetected because every other
 *       upload test bypasses the middleware via `MOCK_VERIFY_SIGNATURE` — is
 *       the gap this file closes.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

const TEST_USERNAME = 'ipfsuploaduser';
const OTHER_USERNAME = 'someoneelse';
const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-ipfs-upload-real-path-test-seed');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();
const OTHER_PRIVATE_KEY = PrivateKey.fromSeed('pevo-ipfs-upload-real-path-other-seed');
const OTHER_PUBLIC_KEY = OTHER_PRIVATE_KEY.createPublic().toString();

// Hoisted mock so the vi.mock factory reference is valid at module-init time.
const { getAccountsMock } = vi.hoisted(() => ({
  getAccountsMock: vi.fn(),
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

const { createApp } = await import('../../src/app.js');
const { getRedis } = await import('../../src/redis.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');
const { signRequestBound: signRequestBoundShared } = await import('../support/sign-request.js');

const app = createApp();

function signRequestBound(method: string, fullPath: string, body: unknown, timestamp: string): string {
  return signRequestBoundShared(TEST_PRIVATE_KEY, method, fullPath, body, timestamp);
}

/** Build a fake on-chain account whose posting key contains `pubkey`. Mirrors
 *  the shape `verifyHiveSignature` consumes: `account.posting.key_auths`. */
function fakeChainAccount(name: string, pubkey: string) {
  return {
    name,
    posting: {
      weight_threshold: 1,
      account_auths: [],
      key_auths: [[pubkey, 1]],
    },
  };
}

// Redis readiness gate: the real `verifyHiveSignature` SETNX path requires
// Redis to be reachable for the replay cache; an unreachable Redis would
// silently fall through to the in-memory cache and the test would still pass,
// but the assertion would not exercise the production path. Gate the suite so
// it skips cleanly when the dev Redis container is offline.
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
  'POST /api/ipfs/upload — real-path verifyHiveSignature',
  () => {
    const UPLOAD_PATH = '/api/ipfs/upload';

    beforeEach(async () => {
      getAccountsMock.mockReset();
      // Default: published posting key is the test keypair's pubkey. Tests
      // that need a mismatched chain key override per-call.
      getAccountsMock.mockResolvedValue([fakeChainAccount(TEST_USERNAME, TEST_PUBLIC_KEY)]);
      // The upload limiter (byAccount) persists state across specs; clear so a
      // 429 from earlier probes cannot mask the auth-stage assertion.
      await clearRateLimitKeys(['ipfs-upload']);
    });

    afterAll(async () => {
      await clearRateLimitKeys(['ipfs-upload']);
    });

    // ─── POSITIVE: real signature accepted, handler reached ──────────────

    it('valid signed request reaches the handler (400 no-file, not 401)', async () => {
      const body = { probe: 'real-path' };
      const timestamp = new Date().toISOString();
      const signature = signRequestBound('POST', UPLOAD_PATH, body, timestamp);

      const res = await request(app)
        .post(UPLOAD_PATH)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(body);

      // 400 "No file provided" is the load-bearing post-auth assertion: the
      // request traversed verifyHiveSignature (real cryptographic recovery +
      // key match against `posting.key_auths`), then ipfsUploadLimiter (slot
      // available), then the multer handler which found no file part. A
      // regression in the auth stage would produce 401 instead.
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toMatch(/no file/i);
      // Chain key was consulted by the real signature verifier.
      expect(getAccountsMock).toHaveBeenCalledWith([TEST_USERNAME]);
    });

    // ─── NEGATIVE: missing signature header ──────────────────────────────

    it('missing X-Hive-Signature header is rejected with 401', async () => {
      const res = await request(app)
        .post(UPLOAD_PATH)
        .set('X-Hive-Username', TEST_USERNAME)
        .send({ probe: 'no signature' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toMatch(/X-Hive-Username and X-Hive-Signature/);
      // Auth fails before the chain read; the mocked getAccounts must never
      // have been consulted.
      expect(getAccountsMock).not.toHaveBeenCalled();
    });

    // ─── NEGATIVE: malformed signature ───────────────────────────────────

    it('malformed X-Hive-Signature is rejected with 401', async () => {
      const timestamp = new Date().toISOString();

      const res = await request(app)
        .post(UPLOAD_PATH)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', 'zzznot-a-real-signature')
        .set('X-Hive-Timestamp', timestamp)
        .send({ probe: 'malformed sig' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    // ─── NEGATIVE: signature recovers a key not in the chain key set ─────

    it('signature whose recovered pubkey is not in posting.key_auths is rejected with 401', async () => {
      // The chain publishes a DIFFERENT posting key than the one our signing
      // private key derives. The signature recovers TEST_PUBLIC_KEY, but the
      // timing-safe compare against `[OTHER_PUBLIC_KEY]` fails.
      getAccountsMock.mockReset();
      getAccountsMock.mockResolvedValue([fakeChainAccount(TEST_USERNAME, OTHER_PUBLIC_KEY)]);

      const body = { probe: 'wrong chain key' };
      const timestamp = new Date().toISOString();
      const signature = signRequestBound('POST', UPLOAD_PATH, body, timestamp);

      const res = await request(app)
        .post(UPLOAD_PATH)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      // Chain was consulted; the failure is the key-compare branch.
      expect(getAccountsMock).toHaveBeenCalledWith([TEST_USERNAME]);
    });

    // ─── NEGATIVE: body-tamper — signature bound to a different body ─────

    it('signature bound to a different body is rejected with 401 (body-tamper defence)', async () => {
      const signedBody = { probe: 'original body' };
      const sentBody = { probe: 'tampered body' };
      const timestamp = new Date().toISOString();
      // Sign against `signedBody`, send `sentBody`. The canonical message
      // body-hashes the request body, so a mismatch makes the recovered
      // pubkey differ from the chain key.
      const signature = signRequestBound('POST', UPLOAD_PATH, signedBody, timestamp);

      const res = await request(app)
        .post(UPLOAD_PATH)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(sentBody);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    // ─── NEGATIVE: cross-account spoof (header username ≠ signer) ────────

    it('username header that does not match the on-chain key set is rejected with 401', async () => {
      getAccountsMock.mockReset();
      getAccountsMock.mockImplementation((names: string[]) => {
        // No account published for OTHER_USERNAME.
        if (names.includes(OTHER_USERNAME)) return Promise.resolve([]);
        return Promise.resolve([fakeChainAccount(TEST_USERNAME, TEST_PUBLIC_KEY)]);
      });

      const body = { probe: 'cross-account spoof' };
      const timestamp = new Date().toISOString();
      // Sign with the test key but claim to be a different user.
      const signature = signRequestBound('POST', UPLOAD_PATH, body, timestamp);

      const res = await request(app)
        .post(UPLOAD_PATH)
        .set('X-Hive-Username', OTHER_USERNAME)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  },
);

describe.skipIf(!redisReachable)(
  'POST /api/ipfs/upload-token — real-path verifyHiveSignature (descriptor bound to the signed envelope)',
  () => {
    const TOKEN_PATH = '/api/ipfs/upload-token';
    const SHA_A = 'a'.repeat(64);
    const SHA_B = 'b'.repeat(64);

    beforeEach(async () => {
      getAccountsMock.mockReset();
      getAccountsMock.mockResolvedValue([fakeChainAccount(TEST_USERNAME, TEST_PUBLIC_KEY)]);
      // The pre-flight has its own (byAccount) limiter bucket; clear it so a
      // 429 from an earlier run cannot mask the auth-stage assertion.
      await clearRateLimitKeys(['ipfs-upload-token']);
    });

    afterAll(async () => {
      await clearRateLimitKeys(['ipfs-upload-token']);
    });

    // ─── POSITIVE: real signature over the descriptor passes auth ────────

    it('a correctly signed descriptor passes verifyHiveSignature and reaches the handler (400, not 401)', async () => {
      // Sign and send the SAME body, but with a structurally invalid
      // file_sha256. The signature is valid over this body (matching body sent),
      // so verifyHiveSignature passes; the handler then 400s at descriptor
      // validation, which sits BEFORE the accreditation HAF read. The 400 (not a
      // 401) is the proof the signed descriptor body was accepted by the real
      // verifier — deterministic and HAF-free, unlike asserting on the
      // downstream accreditation outcome.
      const body = { file_sha256: 'not-a-valid-sha256', mimetype: 'application/pdf', size: 1234 };
      const timestamp = new Date().toISOString();
      const signature = signRequestBound('POST', TOKEN_PATH, body, timestamp);

      const res = await request(app)
        .post(TOKEN_PATH)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      // Chain key was consulted by the real signature verifier.
      expect(getAccountsMock).toHaveBeenCalledWith([TEST_USERNAME]);
    });

    // ─── NEGATIVE: descriptor tampered after signing → 401 ───────────────

    it('a descriptor tampered after signing is rejected with 401 (file_sha256 bound into the envelope)', async () => {
      const signedBody = { file_sha256: SHA_A, mimetype: 'application/pdf', size: 1234 };
      const sentBody = { file_sha256: SHA_B, mimetype: 'application/pdf', size: 1234 };
      const timestamp = new Date().toISOString();
      // Sign the SHA_A descriptor, submit the SHA_B descriptor. The canonical
      // message body-hashes the request body, so the recovered pubkey differs
      // from the chain key → 401. This is the real-crypto proof that the
      // declared file_sha256 is bound to the auth envelope.
      const signature = signRequestBound('POST', TOKEN_PATH, signedBody, timestamp);

      const res = await request(app)
        .post(TOKEN_PATH)
        .set('X-Hive-Username', TEST_USERNAME)
        .set('X-Hive-Signature', signature)
        .set('X-Hive-Timestamp', timestamp)
        .send(sentBody);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    // ─── NEGATIVE: missing signature header ──────────────────────────────

    it('missing X-Hive-Signature header is rejected with 401', async () => {
      const res = await request(app)
        .post(TOKEN_PATH)
        .set('X-Hive-Username', TEST_USERNAME)
        .send({ file_sha256: SHA_A, mimetype: 'application/pdf', size: 1234 });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(getAccountsMock).not.toHaveBeenCalled();
    });
  },
);
