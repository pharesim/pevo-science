/**
 * Upload-token binding: the /api/ipfs/upload-token pre-flight + the sha256/token
 * gate on /api/ipfs/upload. Closes the stolen-JWT-pins-arbitrary-content and
 * capture-and-replay-with-a-different-file vectors (2026-05-30 security audit).
 *
 * Test-mock carve-out (per root CLAUDE.md "Running Tests"):
 *   (a) Justification: verifyHiveSignature is mocked via MOCK_VERIFY_SIGNATURE
 *       (focus is the upload-token/sha256 plumbing, not signature crypto — the
 *       fixture keeps the 401-on-missing-header gate and the jwt/signature
 *       discriminator that THIS task's JWT-path branch depends on).
 *       `getAccreditation` (real HAF read), `getAppPool` (tracking-row insert),
 *       and the Kubo `fetch` (real IPFS node) are stubbed so the binding logic
 *       is exercised deterministically. The upload-token store AND the
 *       fresh-auth store both run REAL (in-memory + Redis tiers): the JWT path
 *       consumes a real per-action (`ipfs_upload`-targeted) proof, so single-use
 *       / sha256-binding / the kind+target binding are all genuinely exercised.
 *   (b) The fresh-auth requirement runs real on the JWT path: tests mint real
 *       proofs and assert a session proof is rejected (kind_mismatch) while an
 *       ipfs_upload proof is accepted. The jwt/signature discriminator is the
 *       real fixture's, not bypassed.
 *   (c) Real-path companion: the real verifyHiveSignature upload + upload-token
 *       paths are pinned in
 *       tests/routes/ipfs-upload-real-path-verifyhivesignature.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

// fresh-auth is NOT mocked: the JWT path now consumes a REAL per-action
// (`ipfs_upload`-targeted) proof via consumeFreshAuthToken, so the tests mint
// real proofs through the real store and exercise the genuine kind/target
// binding (a session proof must be rejected; only an ipfs_upload proof works).

const { accred } = vi.hoisted(() => ({ accred: { value: true } }));
vi.mock('../../src/routes/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/routes/profile.js')>();
  return {
    ...actual,
    getAccreditation: vi.fn(async () => (accred.value ? { account: 'testuser', researcher_name: 'Test' } : null)),
  };
});

// A stable query mock (not a fresh inline closure per getAppPool() call) so the
// happy-path test can assert the pending_ipfs_uploads INSERT args — AC4's
// `uploader_account = user` recording.
const { getAppPoolMock, appQueryMock } = vi.hoisted(() => {
  const appQueryMock = vi.fn(async (..._args: unknown[]) => ({ rows: [] as unknown[], rowCount: 1 }));
  return { getAppPoolMock: vi.fn(() => ({ query: appQueryMock })), appQueryMock };
});
vi.mock('../../src/app-db.js', () => ({ getAppPool: getAppPoolMock }));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const uploadTokenStore = await import('../../src/lib/ipfs-upload-token.js');
const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
const {
  issueFreshAuthToken,
  issueSessionFreshAuthToken,
  ipfsUploadFreshAuthTarget,
  _resetFreshAuthMemStoreForTests,
} = await import('../../src/lib/fresh-auth.js');

const app = createApp();
const USER = 'testuser';

// Redis-present gate for the dual-tier single-use tests below. Mirrors the
// poll-for-ready pattern in tests/lib/fresh-auth.test.ts: getRedis() returns the
// instance before connect() resolves, so poll status briefly before deciding to
// skip. Resolving at registration time surfaces Redis absence as a `skipped`
// count rather than a silent pass.
const redisAvailable = await (async () => {
  const r = getRedis();
  if (!r) return false;
  for (let i = 0; i < 20 && r.status !== 'ready'; i++) {
    await new Promise((res) => setTimeout(res, 50));
  }
  return Boolean(r && isRedisAvailable());
})();

const PDF = Buffer.from('%PDF-1.4 genuine content here');
const PDF_SHA = crypto.createHash('sha256').update(PDF).digest('hex');
const OTHER_PDF = Buffer.from('%PDF-1.4 a totally different file');

// Each HTTP test uses a distinct account so it gets its own ipfsUploadLimiter
// bucket (10/hour, byAccount). The token account-binding still holds because
// mint and upload within a test use the same name. getAccreditation is mocked
// to return truthy regardless of the name.
let uid = 0;
let user: string;

beforeEach(() => {
  accred.value = true;
  uploadTokenStore._resetUploadTokenStoreForTests();
  _resetFreshAuthMemStoreForTests();
  appQueryMock.mockClear();
  user = `upltest${uid++}`;
});

/** Mint a real per-action (`ipfs_upload`-targeted) fresh-auth proof for the
 *  current `user` — the kind the JWT path now requires. */
async function mintUploadProof(): Promise<string> {
  const { token } = await issueFreshAuthToken(user, 'password', ipfsUploadFreshAuthTarget(user));
  return token;
}

// ── upload-token store unit ──────────────────────────────────────
describe('ipfs-upload-token store', () => {
  it('issues a token that consumes exactly once for the right account', async () => {
    const token = await uploadTokenStore.issueUploadToken({ account: USER, file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length });
    const first = await uploadTokenStore.consumeUploadToken(token, USER);
    expect(first).not.toBeNull();
    expect(first!.file_sha256).toBe(PDF_SHA);
    // single-use: a second consume sees nothing.
    expect(await uploadTokenStore.consumeUploadToken(token, USER)).toBeNull();
  });

  it('refuses a token consumed by a different account (and burns it)', async () => {
    const token = await uploadTokenStore.issueUploadToken({ account: USER, file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length });
    expect(await uploadTokenStore.consumeUploadToken(token, 'attacker')).toBeNull();
    // burned even on mismatch — the rightful owner cannot reuse it either.
    expect(await uploadTokenStore.consumeUploadToken(token, USER)).toBeNull();
  });

  it('returns null for a missing/undefined token', async () => {
    expect(await uploadTokenStore.consumeUploadToken(undefined, USER)).toBeNull();
    expect(await uploadTokenStore.consumeUploadToken('never-issued', USER)).toBeNull();
  });
});

// ── upload-token store: dual-tier single-use under a Redis flap ──
// These pin the two single-use defenses the store mirrors from fresh-auth.ts:
// the compensating redis.del on the memStore-fallback leg, and the in-process
// lock that serializes concurrent consumes. Both close double-spend windows a
// stolen/leaked token could otherwise exploit to pin twice.
describe('ipfs-upload-token store — double-spend defenses', () => {
  it.skipIf(!redisAvailable)(
    'memStore-fallback consume issues a compensating redis.del so a Redis-recovered replay is rejected',
    async () => {
      const redis = getRedis()!;
      const token = await uploadTokenStore.issueUploadToken({
        account: USER, file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length,
      });

      // Force the first consume's GETDEL to throw (a Redis flap) so it falls
      // through to the memStore backup written at issuance. The flap may NOT
      // have deleted the canonical Redis copy — the compensating redis.del is
      // what closes the replay window.
      const getdelSpy = vi.spyOn(redis, 'getdel').mockRejectedValueOnce(new Error('simulated Redis flap on getdel'));
      let first;
      try {
        first = await uploadTokenStore.consumeUploadToken(token, USER);
      } finally {
        getdelSpy.mockRestore();
      }
      expect(first).not.toBeNull();
      expect(first!.file_sha256).toBe(PDF_SHA);

      // Redis recovered (no spy). The replay must be rejected: memStore was
      // burned on the fallback leg, and the compensating redis.del cleared the
      // canonical Redis entry so GETDEL now returns nil. A pre-fix variant (no
      // compensating del) would have left the Redis copy alive → this consume
      // would GETDEL it and return the binding a SECOND time (double-spend).
      expect(await uploadTokenStore.consumeUploadToken(token, USER)).toBeNull();
    },
  );

  it.skipIf(!redisAvailable)(
    'compensating del is best-effort: a throwing redis.del still lets the memStore-fallback consume succeed',
    async () => {
      const redis = getRedis()!;
      const token = await uploadTokenStore.issueUploadToken({
        account: USER, file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length,
      });
      const getdelSpy = vi.spyOn(redis, 'getdel').mockRejectedValueOnce(new Error('flap on getdel'));
      const delSpy = vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('flap persists on del'));
      try {
        const result = await uploadTokenStore.consumeUploadToken(token, USER);
        expect(result).not.toBeNull();
        expect(result!.file_sha256).toBe(PDF_SHA);
      } finally {
        getdelSpy.mockRestore();
        delSpy.mockRestore();
      }
    },
  );

  it('two concurrent consumes of one token yield the binding at most once (single-use under concurrency)', async () => {
    const token = await uploadTokenStore.issueUploadToken({
      account: USER, file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length,
    });
    const [a, b] = await Promise.all([
      uploadTokenStore.consumeUploadToken(token, USER),
      uploadTokenStore.consumeUploadToken(token, USER),
    ]);
    const wins = [a, b].filter((x) => x !== null);
    expect(wins).toHaveLength(1);
    expect(wins[0]!.file_sha256).toBe(PDF_SHA);
  });
});

// ── POST /api/ipfs/upload-token ──────────────────────────────────
describe('POST /api/ipfs/upload-token', () => {
  function preflight(body: object, headers: Record<string, string> = {}) {
    const r = request(app).post('/api/ipfs/upload-token').set('X-Hive-Username', user);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return r.send(body);
  }

  it('mints a token on the signature path (no fresh-auth proof needed)', async () => {
    const res = await preflight({ file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length });
    expect(res.status).toBe(200);
    expect(typeof res.body.data.upload_token).toBe('string');
    expect(res.body.data.upload_token.length).toBeGreaterThan(0);
  });

  it('requires a fresh-auth proof on the JWT path (none supplied)', async () => {
    const res = await preflight(
      { file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length },
      { Authorization: 'Bearer header.eyJzdWIiOiJ0ZXN0dXNlciJ9.sig' },
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
  });

  it('mints a token on the JWT path with a valid ipfs_upload-targeted proof', async () => {
    const proof = await mintUploadProof();
    const res = await preflight(
      { file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length, fresh_auth_proof: proof },
      { Authorization: 'Bearer header.eyJzdWIiOiJ0ZXN0dXNlciJ9.sig' },
    );
    expect(res.status).toBe(200);
    expect(typeof res.body.data.upload_token).toBe('string');
  });

  it('REJECTS a target-less session proof on the JWT path (per-action binding, option b)', async () => {
    // A session proof the victim minted for a vote/comment must NOT be
    // redirectable to /upload-token: consumeFreshAuthToken rejects a
    // session-kind entry on the consent-op consume path (kind_mismatch).
    const { token: sessionProof } = await issueSessionFreshAuthToken(user, 'password');
    const res = await preflight(
      { file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length, fresh_auth_proof: sessionProof },
      { Authorization: 'Bearer header.eyJzdWIiOiJ0ZXN0dXNlciJ9.sig' },
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
    expect(res.body.error.details.reason).toBe('kind_mismatch');
  });

  it('rejects a malformed file_sha256', async () => {
    const res = await preflight({ file_sha256: 'nothex', mimetype: 'application/pdf', size: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a disallowed mimetype (e.g. SVG)', async () => {
    const res = await preflight({ file_sha256: PDF_SHA, mimetype: 'image/svg+xml', size: 10 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });

  it('rejects a non-positive or oversize size', async () => {
    expect((await preflight({ file_sha256: PDF_SHA, mimetype: 'application/pdf', size: 0 })).status).toBe(413);
    expect((await preflight({ file_sha256: PDF_SHA, mimetype: 'application/pdf', size: config.maxUploadSize + 1 })).status).toBe(413);
  });

  it('rejects an unaccredited uploader', async () => {
    accred.value = false;
    const res = await preflight({ file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

// ── POST /api/ipfs/upload — token + sha256 gate ──────────────────
describe('POST /api/ipfs/upload — upload-token binding', () => {
  async function mintToken(sha: string, size: number): Promise<string> {
    const res = await request(app)
      .post('/api/ipfs/upload-token')
      .set('X-Hive-Username', user)
      .send({ file_sha256: sha, mimetype: 'application/pdf', size });
    return res.body.data.upload_token as string;
  }

  it('rejects an upload with no token', async () => {
    const res = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', user)
      .attach('file', PDF, { filename: 'p.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an upload whose file sha256 does not match the token (capture-replay defense)', async () => {
    const token = await mintToken(PDF_SHA, PDF.length);
    const res = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', user)
      .set('X-Upload-Token', token)
      .attach('file', OTHER_PDF, { filename: 'p.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('pins the file when the token matches the uploaded bytes (happy path)', async () => {
    config.ipfsApiUrl = config.ipfsApiUrl || 'http://kubo.test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ Hash: 'QmTestCid', Size: '29' }), { status: 200 })),
    );
    const token = await mintToken(PDF_SHA, PDF.length);
    const res = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', user)
      .set('X-Upload-Token', token)
      .attach('file', PDF, { filename: 'p.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.data.cid).toBe('QmTestCid');
    // AC4: the pin is durably tracked with uploader_account = the authenticated
    // user. Find the INSERT among the pool's calls and pin its args so a
    // mutation that drops or mis-attributes uploader_account goes red.
    const insertCall = appQueryMock.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO pending_ipfs_uploads'),
    );
    expect(insertCall).toBeDefined();
    // Params: [cid, uploader_account, size_bytes, pin_backend].
    expect(insertCall![1]).toEqual(['QmTestCid', user, 29, 'kubo']);
  });

  it('cannot reuse a token across two uploads (single-use)', async () => {
    config.ipfsApiUrl = config.ipfsApiUrl || 'http://kubo.test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ Hash: 'QmTestCid', Size: '29' }), { status: 200 })),
    );
    const token = await mintToken(PDF_SHA, PDF.length);
    const first = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', user)
      .set('X-Upload-Token', token)
      .attach('file', PDF, { filename: 'p.pdf', contentType: 'application/pdf' });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', user)
      .set('X-Upload-Token', token)
      .attach('file', PDF, { filename: 'p.pdf', contentType: 'application/pdf' });
    expect(second.status).toBe(401);
  });

  afterEach(() => vi.unstubAllGlobals());
});
