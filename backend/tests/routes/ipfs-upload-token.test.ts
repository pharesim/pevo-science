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
 *       `getAccreditation` (real HAF read), `consumeSessionFreshAuthToken`
 *       (re-auth ceremony), `getAppPool` (tracking-row insert), and the Kubo
 *       `fetch` (real IPFS node) are stubbed so the binding logic is exercised
 *       deterministically. The upload-token store itself runs real (in-memory
 *       tier) so single-use / sha256-binding is genuinely tested.
 *   (b) The fresh-auth requirement is asserted to run on the JWT path; the
 *       discriminator is the real fixture's, not bypassed.
 *   (c) Real-path companion: the real verifyHiveSignature upload path is pinned
 *       in tests/routes/ipfs-upload-real-path-verifyhivesignature.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const { freshAuth } = vi.hoisted(() => ({ freshAuth: { valid: true } }));
vi.mock('../../src/lib/fresh-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/lib/fresh-auth.js')>();
  return {
    ...actual,
    consumeSessionFreshAuthToken: vi.fn(async () =>
      freshAuth.valid ? { valid: true, mechanism: 'password' } : { valid: false, reason: 'missing' },
    ),
  };
});

const { accred } = vi.hoisted(() => ({ accred: { value: true } }));
vi.mock('../../src/routes/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/routes/profile.js')>();
  return {
    ...actual,
    getAccreditation: vi.fn(async () => (accred.value ? { account: 'testuser', researcher_name: 'Test' } : null)),
  };
});

const { getAppPoolMock } = vi.hoisted(() => ({
  getAppPoolMock: vi.fn(() => ({ query: async () => ({ rows: [], rowCount: 1 }) })),
}));
vi.mock('../../src/app-db.js', () => ({ getAppPool: getAppPoolMock }));

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const uploadTokenStore = await import('../../src/lib/ipfs-upload-token.js');

const app = createApp();
const USER = 'testuser';

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
  freshAuth.valid = true;
  accred.value = true;
  uploadTokenStore._resetUploadTokenStoreForTests();
  user = `upltest${uid++}`;
});

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

  it('requires a fresh-auth proof on the JWT path', async () => {
    freshAuth.valid = false;
    const res = await preflight(
      { file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length },
      { Authorization: 'Bearer header.eyJzdWIiOiJ0ZXN0dXNlciJ9.sig' },
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
  });

  it('mints a token on the JWT path when the fresh-auth proof is valid', async () => {
    freshAuth.valid = true;
    const res = await preflight(
      { file_sha256: PDF_SHA, mimetype: 'application/pdf', size: PDF.length, fresh_auth_proof: 'good' },
      { Authorization: 'Bearer header.eyJzdWIiOiJ0ZXN0dXNlciJ9.sig' },
    );
    expect(res.status).toBe(200);
    expect(typeof res.body.data.upload_token).toBe('string');
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
