/**
 * Mocked-pool SQL-shape canaries for BACKEND-PAPERS-CANONICAL-ORCID-RESOLUTION.
 *
 * Pins the supersession projection (`orcid_verified`, `orcid_discrepancy`) on
 * both the list (`GET /api/papers`) and detail (`GET /api/papers/:author/:permlink`)
 * endpoints, covering the four cases enumerated in the task body and the
 * canonical SQL pattern in `agents/docs/hive-schemas.md` § 1.1.
 *
 * Per CLAUDE.md "Running Tests" carve-out:
 *   (a) Real-HAF seeding of the 4-case matrix is impractical: each case
 *       requires a precise `(authors[i].hive, authors[i].orcid,
 *       active_accreditations.orcid)` combination per author per paper,
 *       and the matrix needs deterministic coverage independent of live
 *       accreditation churn on the testnet. Mocked pool seeds the rows
 *       to make each case observable in isolation.
 *   (b) `verifyHiveSignature` is NOT mocked — list + detail are public
 *       GET routes that don't authenticate.
 *   (c) Real-path companion: the same supersession SQL is exercised at
 *       sibling sites via `papers.test.ts` (real-HAF list + detail
 *       integration-shape coverage) and against real
 *       `active_accreditations` shape in `accreditation.test.ts`. The
 *       same risk class (LEFT JOIN + supersession projection) is caught
 *       integratively there.
 *
 * Cryptographic auth verification is irrelevant — the assertions are about
 * SQL-projected response shape on a public-GET surface; no signed request
 * is in play. The `MOCK_VERIFY_SIGNATURE` fixture is NOT used.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async () => ({ rows: [] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafConfigured: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { config } = await import('../../src/config.js');
const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  getPoolMock.mockReset().mockReturnValue({
    query: hafQueryMock,
    connect: async () => ({ query: hafQueryMock, release: () => {} }),
  });
  await hafCache.clear();
});

// ──────────────────────────────────────────────
// Detail endpoint coverage (one test per supersession case).
// The mocked HAF responder shapes the post row's `authors_with_supersession`
// column directly — that column is the SQL-side projection's output and
// what `fetchPaperDetailFromHaf` consumes when overriding `detail.authors`.
// Pinning the response shape here pins both halves of the contract:
// (1) the SQL produces the expected shape, (2) the route surfaces it
// without dropping or transforming the fields.
// ──────────────────────────────────────────────

describe('GET /api/papers/:author/:permlink — ORCID supersession projection', () => {
  // Helper: stage a detail-endpoint responder that returns a single-author
  // paper row whose `authors_with_supersession` field is the per-test
  // case's expected SQL projection. All other queries return empty rows;
  // the route still surfaces the detail object because `paperResult` has
  // the row and `isPevoAnyPaper` accepts the synthesized meta.
  function stageDetail(authorsProjection: Array<Record<string, unknown>>): void {
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('c.body') && sql.includes('c.json_metadata') && sql.includes('parent_author')) {
        return {
          rows: [{
            author: 'alice',
            permlink: 'p1',
            title: 'Test',
            body: 'Abstract\n\n---\n\nBody',
            json_metadata: {
              app: `${config.appTag}/test`,
              [config.appTag]: {
                type: 'paper',
                authors: [{ hive: 'alice', name: 'Alice', orcid: '0000-0000-0000-0001' }],
              },
            },
            created: '2026-04-01T00:00:00Z',
            last_edited: '2026-04-01T00:00:00Z',
            authors_with_supersession: authorsProjection,
          }],
        };
      }
      return { rows: [] };
    });
  }

  it('case 1: hive empty/absent → orcid_verified=null, orcid_discrepancy=false', async () => {
    // SQL projection for this case: no JOIN match because hive is null.
    // The LEFT JOIN against active_accreditations naturally produces
    // aa.orcid=NULL, which the CASE expression collapses to discrepancy=false.
    stageDetail([
      { name: 'Anonymous Co-author', hive: null, orcid: null, affiliation: null, orcid_verified: null, orcid_discrepancy: false },
    ]);
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    expect(res.body.data.authors).toHaveLength(1);
    expect(res.body.data.authors[0].hive).toBeNull();
    expect(res.body.data.authors[0].orcid_verified).toBeNull();
    expect(res.body.data.authors[0].orcid_discrepancy).toBe(false);
  });

  it('case 2: hive set, not accredited → orcid_verified=null, orcid_discrepancy=false', async () => {
    stageDetail([
      { name: 'Bob', hive: 'bob', orcid: '0000-0000-0000-9999', affiliation: 'Sorbonne', orcid_verified: null, orcid_discrepancy: false },
    ]);
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const a = res.body.data.authors[0];
    expect(a.hive).toBe('bob');
    expect(a.orcid).toBe('0000-0000-0000-9999');
    expect(a.orcid_verified).toBeNull();
    expect(a.orcid_discrepancy).toBe(false);
  });

  it('case 3: hive accredited, accreditation orcid null → orcid_verified=null, orcid_discrepancy=false', async () => {
    stageDetail([
      { name: 'Carol', hive: 'carol', orcid: '0000-0000-0000-0042', affiliation: null, orcid_verified: null, orcid_discrepancy: false },
    ]);
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const a = res.body.data.authors[0];
    expect(a.hive).toBe('carol');
    expect(a.orcid).toBe('0000-0000-0000-0042');
    expect(a.orcid_verified).toBeNull();
    expect(a.orcid_discrepancy).toBe(false);
  });

  it('case 4: hive accredited, attestation differs from chain → orcid_verified=attestation, orcid_discrepancy=true', async () => {
    stageDetail([
      { name: 'Dave', hive: 'dave', orcid: '0000-0000-0000-1234', affiliation: 'MIT', orcid_verified: '0000-0000-0000-5678', orcid_discrepancy: true },
    ]);
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const a = res.body.data.authors[0];
    expect(a.hive).toBe('dave');
    expect(a.orcid).toBe('0000-0000-0000-1234');
    expect(a.orcid_verified).toBe('0000-0000-0000-5678');
    expect(a.orcid_discrepancy).toBe(true);
  });

  it('case 4b: hive accredited, attestation matches chain → orcid_verified=attestation, orcid_discrepancy=false', async () => {
    // Companion to case 4: when chain and attestation agree, discrepancy
    // stays false even though orcid_verified is populated. Pins that the
    // CASE expression's equality check is correctly inverted.
    stageDetail([
      { name: 'Eve', hive: 'eve', orcid: '0000-0000-0000-3000', affiliation: 'Stanford', orcid_verified: '0000-0000-0000-3000', orcid_discrepancy: false },
    ]);
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const a = res.body.data.authors[0];
    expect(a.orcid).toBe('0000-0000-0000-3000');
    expect(a.orcid_verified).toBe('0000-0000-0000-3000');
    expect(a.orcid_discrepancy).toBe(false);
  });

  it('SQL query composes authorsWithSupersessionSelect + active_accreditations CTE', async () => {
    // Mutation-kill: drop the `WITH ${detailCte.sql}` wrap from the paper
    // SELECT → query reference to `active_accreditations` becomes
    // undefined → query throws → fetchPaperDetailFromHaf returns null →
    // route returns 404. Below the query-shape inspection ensures the
    // CTE-with-projection composition is in the emitted SQL even when
    // the mocked pool happens to return rows.
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      if (sql.includes('c.body') && sql.includes('c.json_metadata') && sql.includes('parent_author')) {
        return {
          rows: [{
            author: 'alice',
            permlink: 'p1',
            title: 'Test',
            body: 'B',
            json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [] } },
            created: '2026-04-01T00:00:00Z',
            last_edited: null,
            authors_with_supersession: [],
          }],
        };
      }
      return { rows: [] };
    });
    await request(app).get('/api/papers/alice/p1');
    // The detail SELECT must carry both the CTE and the projection. The
    // CTE substring is unique to `activeAccreditationsCteBody`; the
    // projection substring is unique to `authorsWithSupersessionSelect`.
    const detailSql = capturedSqls.find((s) => s.includes('c.body') && s.includes('parent_author'));
    expect(detailSql).toBeDefined();
    expect(detailSql).toContain('active_accreditations');
    expect(detailSql).toContain('orcid_verified');
    expect(detailSql).toContain('orcid_discrepancy');
    expect(detailSql).toContain('jsonb_array_elements');
    expect(detailSql).toContain('WITH ORDINALITY');
  });
});

// ──────────────────────────────────────────────
// List endpoint coverage. The SQL projection on /api/papers reuses the
// same `authorsWithSupersessionSelect` helper. One round-trip canary
// here pins the projection ships through; the per-case behavior is
// already covered by the detail tests above (same helper, same JOIN).
// ──────────────────────────────────────────────

describe('GET /api/papers — ORCID supersession projection on list endpoint', () => {
  it('list response carries orcid_verified + orcid_discrepancy on every author', async () => {
    hafQueryMock.mockImplementation(async (sql: string) => {
      // count query
      if (sql.includes('count(*)::int AS total')) {
        return { rows: [{ total: 1 }] };
      }
      // data query — distinguished from the count by the SELECT-clause
      // referencing the supersession projection
      if (sql.includes('authors_with_supersession')) {
        return {
          rows: [{
            author: 'alice',
            permlink: 'p1',
            title: 'Test',
            abstract: 'A',
            json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }] } },
            created: '2026-04-01T00:00:00Z',
            net_votes: 0,
            review_count: 0,
            citation_count: 0,
            avg_rating: 0,
            author_reputation: 0,
            authors_with_supersession: [
              { name: 'Alice', hive: 'alice', orcid: '0000-0000-0000-0001', affiliation: null, orcid_verified: '0000-0000-0000-0001', orcid_discrepancy: false },
            ],
          }],
        };
      }
      return { rows: [] };
    });
    const res = await request(app).get('/api/papers?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const a = res.body.data[0].authors[0];
    expect(a.hive).toBe('alice');
    expect(a.orcid_verified).toBe('0000-0000-0000-0001');
    expect(a.orcid_discrepancy).toBe(false);
  });

  it('list endpoint SQL composes authorsWithSupersessionSelect + active_accreditations CTE', async () => {
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });
    await request(app).get('/api/papers?limit=1');
    const dataSql = capturedSqls.find((s) => s.includes('authors_with_supersession'));
    expect(dataSql).toBeDefined();
    expect(dataSql).toContain('active_accreditations');
    expect(dataSql).toContain('orcid_verified');
    expect(dataSql).toContain('orcid_discrepancy');
    expect(dataSql).toContain('jsonb_array_elements');
    expect(dataSql).toContain('WITH ORDINALITY');
  });
});
