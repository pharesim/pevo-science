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
 *   (b) The SVG rejection fires at multer's fileFilter before any auth/accred
 *       work; the crypto check being bypassed does not affect what it asserts.
 *   (c) Real-path companion: ipfs.test.ts exercises the real cidIsKnown HAF
 *       path and the real verifyHiveSignature upload path lives in the
 *       middleware specs.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const { createApp } = await import('../../src/app.js');
const { cidReferencedByAppTag } = await import('../../src/lib/ipfs-shared.js');
const { gatewaySafeContentType } = await import('../../src/routes/ipfs.js');

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
});
