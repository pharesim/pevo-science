/**
 * IPFS gateway hardening: Content-Type allow-list, per-route isolation headers,
 * SVG-upload rejection, and the accredited-author CID-known gate.
 *
 * These close a same-origin script-execution chain: an attacker pins arbitrary
 * content (HTML/SVG/JS) to IPFS, references the CID from an appTag-tagged Hive
 * comment, and links victims to https://<host>/api/ipfs/<cid> — which used to
 * forward the upstream Content-Type verbatim, letting the browser render script
 * under the SPA's origin.
 *
 * Test-mock carve-out (per root CLAUDE.md "Running Tests"):
 *   (a) Justification: the GET-proxy specs stub global `fetch` (the upstream
 *       Kubo gateway, impractical to run per-test with attacker content) and
 *       `getAppPool` (so cidIsKnown's pending-row fast path resolves true
 *       deterministically without a seeded Postgres row). config.ipfsGatewayUrl
 *       is set so the proxy branch is reached. The upload spec mocks
 *       verifyHiveSignature via MOCK_VERIFY_SIGNATURE — its focus is the
 *       file-type gate, not signature crypto (the fixture keeps the
 *       401-on-missing-header gate and username extraction). The accreditation
 *       SQL-shape spec uses a capture stub pool (no infra).
 *   (b) The SVG-rejection spec mocks verifyHiveSignature because its focus is
 *       the file-type gate (multer's fileFilter), not signature crypto — NOT
 *       because of middleware ordering. verifyHiveSignature actually runs FIRST:
 *       the inline POST /upload handler invokes multer only after the middleware
 *       chain. The fixture preserves the 401-on-missing-header gate and username
 *       extraction, so a request carrying the mock signature header passes auth,
 *       and the SVG is then rejected at multer's fileFilter with 422. The
 *       bypassed cryptographic check does not affect that outcome.
 *   (c) Real-path companion: ipfs.test.ts exercises the real cidIsKnown HAF
 *       path and the real verifyHiveSignature upload path lives in the
 *       middleware specs.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

// Make cidIsKnown resolve true deterministically for the wiring test below:
// getRedis → null skips the Redis fast-path (which otherwise throws against a
// configured-but-unreachable Redis in test), and getAppPool returns a pending
// row so the durable-record branch reports known before HAF is consulted.
vi.mock('../../src/redis.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/redis.js')>();
  return { ...actual, getRedis: () => null, isRedisAvailable: () => false };
});
vi.mock('../../src/app-db.js', () => ({ getAppPool: () => ({ query: async () => ({ rowCount: 1 }) }) }));

const { createApp } = await import('../../src/app.js');
const { cidReferencedByAppTag } = await import('../../src/lib/ipfs-shared.js');
const { gatewaySafeContentType } = await import('../../src/routes/ipfs.js');
const { config } = await import('../../src/config.js');

const app = createApp();

// A syntactically valid CID so the route's format gate passes.
const VALID_CID = 'Qm' + 'a'.repeat(44);

describe('GET /api/ipfs/:cid — per-route isolation headers', () => {
  it('sets CSP sandbox, nosniff, and CORP on every response (even the 400 path)', async () => {
    const res = await request(app).get('/api/ipfs/not-a-valid-cid');
    expect(res.status).toBe(400);
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
  });

  // The provenance gate (backend-ipfs-cid-provenance-gate) accepts a residual:
  // an accredited author can still host content under the app origin via a
  // structured reference. The CSP sandbox is then the load-bearing barrier that
  // keeps that content in an opaque origin — so it MUST carry no allow-tokens. A
  // `sandbox allow-scripts allow-same-origin` would re-grant script execution +
  // parent-origin access, reopening the same-origin XSS chain. Pin the bare token.
  it('CSP sandbox carries NO allow-tokens (the load-bearing opaque-origin barrier)', async () => {
    const res = await request(app).get('/api/ipfs/not-a-valid-cid');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBe('sandbox');
    expect(csp).not.toMatch(/allow-/);
  });
});

describe('gatewaySafeContentType — served Content-Type allow-list', () => {
  it('forces an inert octet-stream attachment for text/html', () => {
    const served = gatewaySafeContentType('text/html; charset=utf-8', VALID_CID);
    expect(served.contentType).toBe('application/octet-stream');
    expect(served.disposition).toBe(`attachment; filename="${VALID_CID}"`);
  });

  it('forces octet-stream for image/svg+xml and application/javascript', () => {
    expect(gatewaySafeContentType('image/svg+xml', VALID_CID).contentType).toBe('application/octet-stream');
    expect(gatewaySafeContentType('application/javascript', VALID_CID).contentType).toBe('application/octet-stream');
  });

  it('passes through an allow-listed application/pdf unchanged with no attachment', () => {
    const served = gatewaySafeContentType('application/pdf', VALID_CID);
    expect(served.contentType).toBe('application/pdf');
    expect(served.disposition).toBeUndefined();
  });

  it('passes through an allow-listed type even with charset params (matches on bare MIME)', () => {
    const served = gatewaySafeContentType('text/csv; charset=utf-8', VALID_CID);
    expect(served.contentType).toBe('text/csv; charset=utf-8');
    expect(served.disposition).toBeUndefined();
  });

  it('forces octet-stream when upstream advertises no Content-Type', () => {
    expect(gatewaySafeContentType(null, VALID_CID).contentType).toBe('application/octet-stream');
  });
});

// HTTP-level proof that gatewaySafeContentType is actually WIRED into the route
// streaming branch — pinning the helper alone would let a wiring revert (raw
// upstream Content-Type passthrough, reopening the same-origin XSS) survive.
describe('GET /api/ipfs/:cid — Content-Type allow-list applied on the proxy path', () => {
  let origGateway: string | undefined;
  beforeAll(() => {
    origGateway = config.ipfsGatewayUrl;
    config.ipfsGatewayUrl = 'http://upstream.test/ipfs';
  });
  afterAll(() => {
    config.ipfsGatewayUrl = origGateway as string;
    vi.unstubAllGlobals();
  });

  function stubUpstream(contentType: string) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': contentType } })));
  }

  it('serves a text/html upstream as an inert octet-stream attachment (not raw passthrough)', async () => {
    stubUpstream('text/html');
    const res = await request(app).get(`/api/ipfs/${VALID_CID}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${VALID_CID}"`);
  });

  it('passes an allow-listed application/pdf upstream through unchanged', async () => {
    stubUpstream('application/pdf');
    const res = await request(app).get(`/api/ipfs/${VALID_CID}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBeUndefined();
  });
});

describe('POST /api/ipfs/upload — SVG rejected at the file-type gate', () => {
  it('returns 422 INVALID_FILE_TYPE for an SVG upload', async () => {
    const res = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock-sig')
      .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), {
        filename: 'evil.svg',
        contentType: 'image/svg+xml',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });
});

describe('cidReferencedByAppTag — accredited-author gate (gateway-only)', () => {
  function captureStubPool(captured: { text: string; values: unknown[] }[]) {
    return {
      query: async (text: string, values: unknown[]) => {
        captured.push({ text, values });
        return { rowCount: 0 };
      },
    };
  }

  it('default (cleanup path) emits no accreditation CTE and keeps $1..$4 params', async () => {
    const captured: { text: string; values: unknown[] }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cidReferencedByAppTag(captureStubPool(captured) as any, VALID_CID);
    const { text, values } = captured[0];
    expect(text).not.toContain('active_accreditations');
    expect(text).not.toContain('c.author IN');
    expect(values).toHaveLength(4);
  });

  it('requireAccreditedAuthor prepends the accreditation CTE and an author predicate', async () => {
    const captured: { text: string; values: unknown[] }[] = [];
    await cidReferencedByAppTag(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      captureStubPool(captured) as any,
      VALID_CID,
      { requireAccreditedAuthor: true },
    );
    const { text, values } = captured[0];
    expect(text).toContain('active_accreditations');
    expect(text).toContain('c.author IN (SELECT account FROM active_accreditations)');
    // CTE contributes 2 params ahead of the 4 containment params.
    expect(values).toHaveLength(6);
    // The containment params now bind at $3..$6.
    expect(text).toContain('c.tags @> $3::jsonb');
  });

  it('excludeImageReference drops the image-SRF branch and its cid param (gateway provenance gate)', async () => {
    const captured: { text: string; values: unknown[] }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cidReferencedByAppTag(captureStubPool(captured) as any, VALID_CID, { excludeImageReference: true });
    const { text, values } = captured[0];
    // The broadcaster-controlled image[]-substring branch is gone: no SRF guard,
    // and the cid param (its sole consumer) is dropped — 3 params, not 4.
    expect(text).not.toContain('jsonb_array_elements_text');
    expect(text).not.toContain('img LIKE');
    expect(values).toHaveLength(3);
    // The two structured-reference containments survive.
    expect((text.match(/c\.json_metadata @>/g) ?? []).length).toBe(2);
  });

  it('the gateway combination (accredited-author + structured-only) keeps the CTE and drops the image branch', async () => {
    const captured: { text: string; values: unknown[] }[] = [];
    await cidReferencedByAppTag(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      captureStubPool(captured) as any,
      VALID_CID,
      { requireAccreditedAuthor: true, excludeImageReference: true },
    );
    const { text, values } = captured[0];
    expect(text).toContain('c.author IN (SELECT account FROM active_accreditations)');
    expect(text).not.toContain('jsonb_array_elements_text');
    // 2 CTE params + 3 containment params (tags, ipfs_cid, supplementary_files);
    // no trailing cid param since the image branch is gone.
    expect(values).toHaveLength(5);
    expect(text).toContain('c.tags @> $3::jsonb');
  });

  it('resolves not-referenced (would 404 at the gateway) when no accredited-author row matches', async () => {
    // Behavioral pin: with the gate on, a CID whose only references are from
    // unaccredited authors yields zero matching rows → cidReferencedByAppTag
    // false → the gateway returns 404. A row match yields true (served).
    const zeroPool = { query: async () => ({ rowCount: 0 }) };
    const onePool = { query: async () => ({ rowCount: 1 }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await cidReferencedByAppTag(zeroPool as any, VALID_CID, { requireAccreditedAuthor: true })).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await cidReferencedByAppTag(onePool as any, VALID_CID, { requireAccreditedAuthor: true })).toBe(true);
  });
});
