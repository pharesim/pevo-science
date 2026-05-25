/**
 * Mocking justification (per root CLAUDE.md carve-out):
 *
 *   (a) verifyHiveSignature is the project-wide MOCK_VERIFY_SIGNATURE fixture
 *       because these tests focus on route plumbing, the self-block
 *       semantics, and the encrypted-mapping persistence round-trip, NOT
 *       cryptographic signature verification of the incoming request. The
 *       real middleware's auth gate is exercised by sibling routes whose
 *       test files import the real middleware (`tests/routes/claims.test.ts`,
 *       `tests/orcid-callback.test.ts`).
 *   (b) `getAccreditation` is mocked so the route reaches the broadcaster-
 *       hive self-block check without requiring a seeded accreditation
 *       custom_json in HAF.
 *   (c) `hiveClient.call('condenser_api', 'get_content', ...)` is mocked
 *       so the test can supply a paper with broadcaster-controlled
 *       `pevo.authors[]` shapes deterministically. Seeding such a paper on
 *       the live pevotest chain is impractical and slow.
 *   (d) `broadcastSendOperationsWithTimeout` and `broadcastJsonWithTimeout`
 *       are stubbed so the happy-path test does NOT need a funded proxy
 *       account (`HIVE_ANON_ACCOUNT`) with a valid posting key on the
 *       pevotest chain. Real broadcasts here would require persistent
 *       on-chain side effects per test run; the route's downstream
 *       encrypt/persist/decrypt path is what this happy-path coverage is
 *       pinning, and that path runs end-to-end against the real
 *       `encryptMapping` / `storeAnonMapping` / `getAnonMapping` /
 *       `decryptMapping` chain with a real Redis-backed mapping store.
 *   (e) `config.pevoAnonPostingKey` and `config.anonReviewEncryptionKey`
 *       are overridden to deterministic test values so the route's
 *       500-misconfig guards do not trip and the AES-256-GCM seal runs
 *       end-to-end. The defaults in the project `.env` are empty (proxy
 *       account is not provisioned for tests).
 *
 *   Real-path companion (clause-c): the validation/auth/rate-limit gates
 *   above are exercised against the real `verifyHiveSignature` middleware
 *   in `tests/middleware/verifyHiveSignature-authmethod.test.ts` and
 *   sibling route files that hit this same auth chain. The mapping-seal
 *   AES-GCM primitive itself is exercised end-to-end here against the real
 *   `node:crypto` implementation: only the two broadcast helpers and the
 *   accreditation lookup are stubbed, the encrypt/persist/fetch/decrypt
 *   chain runs unmocked. Risk class "ciphertext format regression" (e.g.,
 *   accidental cleartext, IV reuse, key-version mismatch) is therefore
 *   asserted against real bytes flowing through real Redis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';

// Test-deterministic encryption key + proxy posting key. The encryption
// key must be 64 hex chars (32 bytes) for AES-256-GCM. The proxy posting
// key is never actually used to sign anything — the two broadcast helpers
// are mocked below — but the route's PrivateKey.fromString() guard runs
// before reaching the mocked broadcast, so it must be a syntactically
// valid WIF. We use a deterministic seed-derived key.
const TEST_ANON_ENCRYPTION_KEY = crypto
  .createHash('sha256')
  .update('pevo-anon-review-test-encryption-key-seed')
  .digest('hex');

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>(
    '../../src/config.js',
  );
  const { PrivateKey } = await import('@hiveio/dhive');
  const testPostingKey = PrivateKey.fromSeed('pevo-anon-review-test-proxy-posting-seed').toString();
  return {
    ...actual,
    config: {
      ...actual.config,
      pevoAnonPostingKey: testPostingKey,
      anonReviewEncryptionKey: TEST_ANON_ENCRYPTION_KEY,
      anonReviewKeyVersion: 1,
    },
  };
});

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

// `getAccreditation` lives in profile.ts; mock it before importing the app.
const getAccreditationMock = vi.fn();
vi.mock('../../src/routes/profile.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/routes/profile.js')>(
    '../../src/routes/profile.js',
  );
  return {
    ...actual,
    getAccreditation: (...args: unknown[]) => getAccreditationMock(...args),
  };
});

// Mock hiveClient.call so the `condenser_api / get_content` lookup returns
// our staged paper. Other hive.js exports pass through, EXCEPT the two
// broadcast helpers, which we stub so the happy-path test does not need a
// real funded proxy account.
const hiveCallMock = vi.fn();
const broadcastSendOpsMock = vi.fn().mockResolvedValue({ id: 'mock-anon-comment-tx' });
const broadcastJsonMock = vi.fn().mockResolvedValue({ id: 'mock-anon-attest-tx' });
vi.mock('../../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hive.js')>('../../src/hive.js');
  return {
    ...actual,
    hiveClient: {
      ...actual.hiveClient,
      call: (...args: unknown[]) => hiveCallMock(...args),
    },
    broadcastSendOperationsWithTimeout: (...args: unknown[]) => broadcastSendOpsMock(...args),
    broadcastJsonWithTimeout: (...args: unknown[]) => broadcastJsonMock(...args),
  };
});

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
const { decryptMapping, getAnonMapping, __test_seams } = await import(
  '../../src/routes/anonymousReview.js'
);
const app = createApp();

describe('POST /api/reviews/anonymous', () => {
  it('returns 401 without auth headers', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Great paper',
        rating: { methodology: 4, novelty: 5, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 when fields are missing', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({ paper_author: 'alice' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid rating values', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Review text',
        rating: { methodology: 6, novelty: 0, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('rating');
  });

  it('returns 400 for non-integer rating', async () => {
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Review text',
        rating: { methodology: 3.5, novelty: 4, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(400);
  });

  it('returns 403 for unaccredited reviewer', async () => {
    getAccreditationMock.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'reviewer1')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Good research',
        rating: { methodology: 4, novelty: 5, clarity: 3, significance: 4 },
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /api/reviews/anonymous — co-author self-block normalization', () => {
  beforeEach(() => {
    getAccreditationMock.mockReset();
    hiveCallMock.mockReset();
  });

  // Abuse vector: a vouched co-author whose `pevo.authors[].hive` was
  // broadcast mid-case (`{hive: 'Bob'}`) attempts to anonymous-review their
  // own paper under their real (consensus-lowercase) account 'bob'. Without
  // the normalize-on-broadcaster-side wrapper, `a.hive === username` is a
  // byte-equality between the uppercase chain value and the lowercase
  // username; the check fails and the self-block is bypassed. With the
  // wrapper the comparison canonicalizes the broadcaster value first.
  it('rejects an uppercase-hive co-author attempting to anonymous-review their own paper', async () => {
    getAccreditationMock.mockResolvedValueOnce({
      name: 'Bob',
      institution: 'Test U',
      field: 'Test',
      method: 'orcid',
      orcid: null,
      timestamp: '2026-01-01T00:00:00Z',
      tx_id: 'tx-mock',
    });
    hiveCallMock.mockResolvedValueOnce({
      json_metadata: JSON.stringify({
        pevotest: {
          type: 'paper',
          authors: [{ hive: 'alice' }, { hive: 'Bob' }],
        },
      }),
    });

    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'bob')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Review my own paper',
        rating: { methodology: 5, novelty: 5, clarity: 5, significance: 5 },
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('Authors cannot review their own papers');
  });

  // Control: the same flow with a true third-party reviewer is NOT blocked by
  // the self-block predicate. Pins that the broadcaster-side normalization did
  // not over-exclude legitimate non-author reviewers. The file-level
  // config mock pins `pevoAnonPostingKey` + `anonReviewEncryptionKey`, so this
  // request now flows through the full success path (the broadcast helpers are
  // stubbed) rather than tripping the 500-misconfig guard. The load-bearing
  // invariant is `not.toBe(403)`: carol is neither the paper author nor a
  // self-blocked co-author, so the 403 self-block must not fire regardless of
  // the downstream status. Asserting `not.toBe(403)` (rather than a specific
  // success code) keeps the spec focused on the admission invariant and robust
  // to changes in the post-admission path.
  it('admits a true third-party accredited reviewer past the self-block gate', async () => {
    getAccreditationMock.mockResolvedValueOnce({
      name: 'Carol',
      institution: 'Test U',
      field: 'Test',
      method: 'orcid',
      orcid: null,
      timestamp: '2026-01-01T00:00:00Z',
      tx_id: 'tx-mock',
    });
    hiveCallMock.mockResolvedValueOnce({
      json_metadata: JSON.stringify({
        pevotest: {
          type: 'paper',
          authors: [{ hive: 'alice' }, { hive: 'Bob' }],
        },
      }),
    });

    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'carol')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Third-party review',
        rating: { methodology: 4, novelty: 4, clarity: 4, significance: 4 },
      });

    // Unconditional negative assertion: the 403 self-block must NOT fire
    // for a non-author reviewer regardless of the downstream status. A
    // regression where normalization mis-canonicalizes carol's identity
    // and triggers the self-block would surface as a 403 here and fail
    // this expectation red.
    expect(res.status).not.toBe(403);
  });

  // Whitespace-padded broadcaster value: a `{hive: '  bob  '}` entry must
  // still self-block bob. The SQL behavioral matrix in hafsql.test.ts
  // already covers the TRIM half of LOWER(TRIM(...)) at the predicate
  // level; this assertion extends route-layer coverage so a regression
  // that breaks .trim() in normalizeHiveAccount while keeping
  // .toLowerCase() is caught at the route boundary too.
  it('rejects a whitespace-padded-hive co-author attempting to anonymous-review their own paper', async () => {
    getAccreditationMock.mockResolvedValueOnce({
      name: 'Bob',
      institution: 'Test U',
      field: 'Test',
      method: 'orcid',
      orcid: null,
      timestamp: '2026-01-01T00:00:00Z',
      tx_id: 'tx-mock',
    });
    hiveCallMock.mockResolvedValueOnce({
      json_metadata: JSON.stringify({
        pevotest: {
          type: 'paper',
          authors: [{ hive: 'alice' }, { hive: '  bob  ' }],
        },
      }),
    });

    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', 'bob')
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: 'alice',
        paper_permlink: 'quantum-paper',
        body: 'Review my own paper',
        rating: { methodology: 5, novelty: 5, clarity: 5, significance: 5 },
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('Authors cannot review their own papers');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Happy-path / round-trip coverage for the encrypted reviewer-identity
// mapping. The rejection paths above guard the front-of-route gates;
// these specs assert that a valid submission flows all the way through
// the AES-256-GCM seal, the Redis (or in-memory fallback) persistence,
// and the unseal that abuse-investigation tooling would later perform.
//
// The two Hive broadcast helpers are stubbed (see file header carve-out
// (d)), but the encrypt → persist → fetch → decrypt chain runs against
// the real `node:crypto`, the real `getRedis()` client, and the real
// route-module-internal `encryptMapping` / `storeAnonMapping` /
// `getAnonMapping` / `decryptMapping` functions.
// ──────────────────────────────────────────────────────────────────────
describe('POST /api/reviews/anonymous — happy-path mapping round-trip', () => {
  beforeEach(async () => {
    getAccreditationMock.mockReset();
    hiveCallMock.mockReset();
    broadcastSendOpsMock.mockReset();
    broadcastSendOpsMock.mockResolvedValue({ id: 'mock-anon-comment-tx' });
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockResolvedValue({ id: 'mock-anon-attest-tx' });
    // Drain the per-account rate-limit bucket so a previous spec's POST
    // does not push us over the 5/hour cap.
    const { clearRateLimitKeys } = await import('../support/redis-helpers.js');
    await clearRateLimitKeys(['anon-review']);
  });

  it('seals + persists the reviewer mapping and the round-trip unseal recovers the reviewer username', async () => {
    const reviewer = 'carol';
    const paperAuthor = 'alice';
    const paperPermlink = 'quantum-paper-roundtrip';

    getAccreditationMock.mockResolvedValueOnce({
      name: 'Carol',
      institution: 'Test U',
      field: 'Test',
      method: 'orcid',
      orcid: null,
      timestamp: '2026-01-01T00:00:00Z',
      tx_id: 'tx-mock',
    });
    hiveCallMock.mockResolvedValueOnce({
      json_metadata: JSON.stringify({
        pevotest: {
          type: 'paper',
          authors: [{ hive: paperAuthor }, { hive: 'bob' }],
        },
      }),
    });

    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', reviewer)
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: paperAuthor,
        paper_permlink: paperPermlink,
        body: 'A substantive third-party anonymous review of the paper.',
        rating: { methodology: 4, novelty: 5, clarity: 3, significance: 4 },
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const payload = res.body.data;
    expect(payload.author).toBe(config.hiveAnonAccount);
    expect(typeof payload.permlink).toBe('string');
    expect(payload.permlink).toContain(paperAuthor);
    expect(payload.permlink).toContain(paperPermlink);
    expect(payload.tx_id).toBe('mock-anon-comment-tx');

    // The comment broadcast must have fired with the proxy account as
    // `author`, the requested paper as `parent_author`/`parent_permlink`,
    // and `is_anonymous: true` in the json_metadata.
    expect(broadcastSendOpsMock).toHaveBeenCalledTimes(1);
    const opsArg = broadcastSendOpsMock.mock.calls[0][0] as Array<[string, Record<string, unknown>]>;
    const commentOp = opsArg.find((op) => op[0] === 'comment')!;
    expect(commentOp[1].author).toBe(config.hiveAnonAccount);
    expect(commentOp[1].parent_author).toBe(paperAuthor);
    expect(commentOp[1].parent_permlink).toBe(paperPermlink);
    const meta = JSON.parse(commentOp[1].json_metadata as string);
    expect(meta[config.appTag].is_anonymous).toBe(true);

    // The attestation custom_json must have fired with the proxy account
    // as the required_posting_auth and an `anon_review` action payload.
    expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
    const attestArg = broadcastJsonMock.mock.calls[0][0] as {
      id: string;
      json: string;
      required_posting_auths: string[];
    };
    expect(attestArg.id).toBe(config.appTag);
    expect(attestArg.required_posting_auths).toEqual([config.hiveAnonAccount]);
    const attestation = JSON.parse(attestArg.json);
    expect(attestation.action).toBe('anon_review');
    expect(attestation.review_permlink).toBe(payload.permlink);

    // The reviewer-identity mapping must be retrievable via the route's
    // own `getAnonMapping` lookup, and the AES-GCM unseal must return
    // the original reviewer username byte-for-byte.
    const stored = await getAnonMapping(payload.permlink);
    expect(stored).not.toBeNull();
    expect(typeof stored!.encrypted).toBe('string');
    expect(typeof stored!.iv).toBe('string');
    expect(typeof stored!.authTag).toBe('string');
    expect(stored!.keyVersion).toBe(config.anonReviewKeyVersion);

    const unsealed = decryptMapping(stored!.encrypted, stored!.iv, stored!.authTag, stored!.keyVersion);
    expect(unsealed).toBe(reviewer);
  });

  it('stores the mapping as ciphertext, not as the reviewer username in any encoding', async () => {
    const reviewer = 'davidlongername';
    const paperAuthor = 'alice';
    const paperPermlink = 'quantum-paper-ciphertext';

    getAccreditationMock.mockResolvedValueOnce({
      name: 'David',
      institution: 'Test U',
      field: 'Test',
      method: 'orcid',
      orcid: null,
      timestamp: '2026-01-01T00:00:00Z',
      tx_id: 'tx-mock',
    });
    hiveCallMock.mockResolvedValueOnce({
      json_metadata: JSON.stringify({
        pevotest: {
          type: 'paper',
          authors: [{ hive: paperAuthor }],
        },
      }),
    });

    const res = await request(app)
      .post('/api/reviews/anonymous')
      .set('X-Hive-Username', reviewer)
      .set('X-Hive-Signature', 'mock-sig')
      .send({
        paper_author: paperAuthor,
        paper_permlink: paperPermlink,
        body: 'Another substantive third-party anonymous review.',
        rating: { methodology: 3, novelty: 3, clarity: 3, significance: 3 },
      });

    expect(res.status).toBe(200);
    const permlink = res.body.data.permlink;

    // Read the raw Redis value and assert no encoding of the reviewer
    // username appears in the stored bytes. Defence against a regression
    // that accidentally stored cleartext (or hex/base64-encoded
    // cleartext) under the mapping key.
    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      const raw = await redis.get(`${config.appTag}:anon_mapping:${permlink}`);
      expect(raw).not.toBeNull();
      // The wrapping JSON envelope itself carries `paperAuthor` /
      // `paperPermlink` plaintext (those are not secret), but the
      // `encrypted` field MUST NOT contain the reviewer username under
      // hex, utf8, or base64 decoding.
      const parsed = JSON.parse(raw!) as { encrypted: string };
      const cipherBuf = Buffer.from(parsed.encrypted, 'hex');
      expect(parsed.encrypted).not.toContain(Buffer.from(reviewer, 'utf8').toString('hex'));
      expect(cipherBuf.toString('utf8')).not.toContain(reviewer);
      expect(cipherBuf.toString('latin1')).not.toContain(reviewer);
      expect(cipherBuf.toString('base64')).not.toContain(reviewer);
    } else {
      // Redis is not available in this test environment; the in-memory
      // fallback also stores the same hex-encoded ciphertext. Fetch via
      // the public accessor and run the same byte-level assertions.
      const stored = await getAnonMapping(permlink);
      expect(stored).not.toBeNull();
      const cipherBuf = Buffer.from(stored!.encrypted, 'hex');
      expect(stored!.encrypted).not.toContain(Buffer.from(reviewer, 'utf8').toString('hex'));
      expect(cipherBuf.toString('utf8')).not.toContain(reviewer);
      expect(cipherBuf.toString('latin1')).not.toContain(reviewer);
      expect(cipherBuf.toString('base64')).not.toContain(reviewer);
    }

    // Sanity: the unseal still works (we did not break the format while
    // asserting against it).
    const stored = await getAnonMapping(permlink);
    const unsealed = decryptMapping(stored!.encrypted, stored!.iv, stored!.authTag, stored!.keyVersion);
    expect(unsealed).toBe(reviewer);
  });

  it('uses a fresh random IV per seal so identical plaintext yields distinct ciphertext', () => {
    // AES-GCM is catastrophically broken under nonce (IV) reuse: encrypting
    // the same plaintext under the same key with the same IV always produces
    // identical ciphertext, enabling trivial known-plaintext correlation and
    // forgery. `encryptMapping` MUST draw a fresh `crypto.randomBytes(12)` IV
    // every call. Sealing identical plaintext twice and asserting the IVs
    // differ mutation-kills replacing `crypto.randomBytes(12)` with a constant
    // (e.g. `Buffer.alloc(12)`): that mutation makes both IVs equal and flips
    // this assertion RED. The byte-inequality spec above misses this — under a
    // constant nonce the ciphertext still does not contain the cleartext.
    const env1 = __test_seams.encryptMapping('carol');
    const env2 = __test_seams.encryptMapping('carol');
    expect(env1.iv).not.toEqual(env2.iv);
  });

  it('returns null from the mapping store after the configured TTL elapses', async () => {
    // The production route hardcodes a 180-day TTL on the encrypted
    // mapping. The test seam exposes the internal `storeAnonMapping` so
    // a sub-second expiry can be pinned here without changing production
    // behaviour or waiting 180 days. The fetch path under test is the
    // same `getAnonMapping` the route returns — including the in-memory
    // fallback's `new Date() > expiresAt` predicate and Redis's native
    // EXPIRE eviction.
    const reviewer = 'eveephemeral';
    const permlink = `re-test-ttl-${Date.now()}`;
    const sealed = __test_seams.encryptMapping(reviewer);
    // Redis EXPIRE has 1s minimum granularity (`Math.max(1, ceil(deltaMs/1000))`
    // floors any sub-second expiry to 1s in `storeAnonMapping`). Any
    // `expiresAt < now + 1000ms` collapses to a 1s Redis TTL; pinning the
    // in-memory `expiresAt` at the same 1s mark lets both eviction paths
    // fire inside the same sleep window.
    const expiresAt = new Date(Date.now() + 1000);

    await __test_seams.storeAnonMapping(
      permlink,
      'alice',
      'quantum-paper-ttl',
      sealed.encrypted,
      sealed.iv,
      sealed.authTag,
      sealed.keyVersion,
      expiresAt,
    );

    // Immediately readable.
    const before = await getAnonMapping(permlink);
    expect(before).not.toBeNull();
    const beforePlain = decryptMapping(before!.encrypted, before!.iv, before!.authTag, before!.keyVersion);
    expect(beforePlain).toBe(reviewer);

    // After the TTL window, Redis EXPIRE has evicted the key AND the
    // in-memory fallback's expiry predicate has fired. Either source
    // returns null. Sleep generously past the 1s Redis floor to absorb
    // wall-clock jitter on the eviction loop.
    await new Promise((r) => setTimeout(r, 2500));
    const after = await getAnonMapping(permlink);
    expect(after).toBeNull();
  });
});
