import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getPool, isHafConfigured } from '../../src/db.js';
import { config } from '../../src/config.js';
import { T } from '../../src/hafsql.js';
import { queryWithRetry } from '../support/haf-query.js';

// Carve-out (per root CLAUDE.md "Running Tests"): the POST /api/ipfs/upload
// specs below mock `verifyHiveSignature` via MOCK_VERIFY_SIGNATURE. Their
// focus is the upload route's downstream behavior (file-type gate, accredited
// gate, missing-file 400), not cryptographic signature verification — the
// fixture preserves the 401-on-missing-header gate and username extraction,
// bypassing only the crypto check. The GET /api/ipfs/:cid spec further down
// has no auth middleware at all and runs the real HAF path through the real
// getPool() helper; the upload route's real-path signature companion lives in
// the auth-focused middleware specs.
vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const app = createApp();

// Route-level CID validation gate — mirrors CID_RE in routes/ipfs.ts. A live
// corpus CID must match this for the download route to reach cidIsKnown.
const ROUTE_CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{55,62})$/;

describe('POST /api/ipfs/upload', () => {
  it('returns 401 without auth headers', async () => {
    const res = await request(app)
      .post('/api/ipfs/upload')
      .attach('file', Buffer.from('%PDF-1.4 test'), 'test.pdf');
    expect(res.status).toBe(401);
  });

  it('returns 400 when no file is provided', async () => {
    const res = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 403 for unaccredited uploader', async () => {
    const res = await request(app)
      .post('/api/ipfs/upload')
      .set('X-Hive-Username', 'testuser')
      .set('X-Hive-Signature', 'mock-sig')
      .attach('file', Buffer.from('%PDF-1.4 test content'), {
        filename: 'paper.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('GET /api/ipfs/:cid (cidIsKnown HAF reference check)', () => {
  // Pins the appTag-namespace fix against the real published shape: a paper's
  // CID lives at `json_metadata.<appTag>.ipfs_cid`, NOT under a literal `pevo`
  // top-level key. cidIsKnown must resolve such a CID as known (any response
  // other than 404). The download route runs cidIsKnown first; a 404 means the
  // HAF reference check failed to find the on-chain CID. Once known, the route
  // proceeds to the gateway proxy, which returns 200/502 depending on gateway
  // reachability — both prove cidIsKnown returned true.
  it.skipIf(!isHafConfigured())(
    'resolves a published metadata.<appTag>.ipfs_cid as known (not 404)',
    { timeout: 60_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no HAF pool available');
        return;
      }

      // Find any PEvO-tagged comment carrying a non-empty ipfs_cid under the
      // appTag namespace. Scoped via the same tags-GIN predicate the
      // production query uses, so we exercise the real indexed shape.
      const res = await queryWithRetry<{ cid: string }>(
        pool,
        `SELECT c.json_metadata -> $2 ->> 'ipfs_cid' AS cid
           FROM ${T.comments} c
          WHERE c.tags @> $1::jsonb
            AND c.json_metadata -> $2 ->> 'ipfs_cid' IS NOT NULL
            AND c.json_metadata -> $2 ->> 'ipfs_cid' <> ''
          LIMIT 1`,
        [JSON.stringify([config.appTag]), config.appTag],
      );

      if (res.rows.length === 0) {
        ctx.skip('HAF has no published paper with an appTag ipfs_cid — namespace fix not exercisable');
        return;
      }

      const cid = res.rows[0].cid;
      if (!ROUTE_CID_RE.test(cid)) {
        // The published CID does not match the route's format gate, so it would
        // be rejected at the 400 boundary before cidIsKnown runs. That tells us
        // nothing about the namespace fix — skip rather than assert vacuously.
        ctx.skip(`live CID ${cid} does not match route CID format — fix not exercisable through the route`);
        return;
      }

      const api = await request(app).get(`/api/ipfs/${cid}`);
      // Known CID → never 404. With a literal `pevo` key (the pre-fix bug),
      // cidIsKnown would miss this on-chain reference and the route would 404.
      expect(api.status).not.toBe(404);
    },
  );
});
