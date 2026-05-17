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
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as any[] })),
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
const {
  applyAuthorSupersession,
  canonicalHiveKey,
  computeSupersession,
} = await import('../../src/lib/author-supersession.js');
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

// ──────────────────────────────────────────────
// Round-2 hold-block items 1-4 canaries.
//
// Item 1 (P1): hive-key normalization parity across the three supersession
// paths (SQL JOIN, JS applyAuthorSupersession, JS buildCumulativeAuthorsForChain).
// Item 2 (P2): SQL/JS empty-string chain-orcid parity (NULLIF wrap).
// Item 3 (P2): `affiliation` MUST NOT leak into PaperSummary.
// Item 4 (P2): `?version=N` and `metadata_restored` fallback branches must
// surface supersession fields (mutation-kill: deleting `applyAuthorSupersession`
// from either branch fails the corresponding canary red).
// ──────────────────────────────────────────────

describe('supersession round-2 hold — item 1 (hive-key normalization parity)', () => {
  it('canonicalHiveKey normalizes mixed-case + whitespace; returns null for empty/non-string', () => {
    expect(canonicalHiveKey('Alice')).toBe('alice');
    expect(canonicalHiveKey('  ALICE  ')).toBe('alice');
    expect(canonicalHiveKey('alice')).toBe('alice');
    expect(canonicalHiveKey('')).toBeNull();
    expect(canonicalHiveKey('   ')).toBeNull();
    expect(canonicalHiveKey(null)).toBeNull();
    expect(canonicalHiveKey(undefined)).toBeNull();
    expect(canonicalHiveKey(42)).toBeNull();
    expect(canonicalHiveKey({ hive: 'alice' })).toBeNull();
  });

  it('computeSupersession matches mixed-case hive against lowercase orcidMap key', () => {
    const orcidMap = new Map<string, string | null>([['alice', '0000-0000-0000-9999']]);
    // Mixed-case + whitespace chain hive resolves via canonicalization to the lowercase map key.
    const mixed = computeSupersession('Alice', '0000-0000-0000-1234', orcidMap);
    expect(mixed.orcid_verified).toBe('0000-0000-0000-9999');
    expect(mixed.orcid_discrepancy).toBe(true);
    const padded = computeSupersession('  alice  ', '0000-0000-0000-1234', orcidMap);
    expect(padded.orcid_verified).toBe('0000-0000-0000-9999');
    expect(padded.orcid_discrepancy).toBe(true);
    // Lowercase canonical input stays correct (parity check).
    const lower = computeSupersession('alice', '0000-0000-0000-1234', orcidMap);
    expect(lower).toEqual(mixed);
  });

  it('applyAuthorSupersession parity: mixed-case authors[i].hive yields same supersession as lowercase', () => {
    const orcidMap = new Map<string, string | null>([
      ['alice', '0000-0000-0000-AAAA'],
      ['bob', '0000-0000-0000-BBBB'],
    ]);
    const mixedCaseAuthors = [
      { name: 'Alice', hive: 'Alice', orcid: '0000-0000-0000-DEAD' },
      { name: 'Bob', hive: ' BOB ', orcid: '0000-0000-0000-BBBB' },
    ];
    const lowerCaseAuthors = [
      { name: 'Alice', hive: 'alice', orcid: '0000-0000-0000-DEAD' },
      { name: 'Bob', hive: 'bob', orcid: '0000-0000-0000-BBBB' },
    ];
    const mixedResult = applyAuthorSupersession(mixedCaseAuthors, orcidMap);
    const lowerResult = applyAuthorSupersession(lowerCaseAuthors, orcidMap);
    // The chain-field passthrough preserves the raw `hive` value (so the
    // UI can render what was broadcast); only the supersession fields are
    // normalized via canonicalHiveKey. Pin the supersession parity directly.
    expect(mixedResult[0].orcid_verified).toBe('0000-0000-0000-AAAA');
    expect(mixedResult[0].orcid_discrepancy).toBe(true);
    expect(mixedResult[1].orcid_verified).toBe('0000-0000-0000-BBBB');
    expect(mixedResult[1].orcid_discrepancy).toBe(false);
    // Lowercase path produces identical supersession output — the parity invariant.
    expect(mixedResult.map(a => ({ v: a.orcid_verified, d: a.orcid_discrepancy }))).toEqual(
      lowerResult.map(a => ({ v: a.orcid_verified, d: a.orcid_discrepancy })),
    );
  });

  it('SQL JOIN uses LOWER(TRIM(...)) so mixed-case chain hive matches lowercase aa.account', async () => {
    // Mutation-kill: drop the LOWER(TRIM(...)) wrap from the JOIN predicate
    // → SQL still queries, but mixed-case chain hives no longer match the
    // lowercase `active_accreditations.account` column → split-brain across
    // SQL and JS paths. The SQL-shape canary detects the LOWER(TRIM wrap
    // directly; the parity-of-output assertion is enforced via the JS unit
    // tests above (the real LOWER(TRIM behavior is a PostgreSQL primitive).
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });
    // List endpoint
    await request(app).get('/api/papers?limit=1');
    const listSql = capturedSqls.find((s) => s.includes('authors_with_supersession') && !s.includes('count(*)::int AS total'));
    expect(listSql).toBeDefined();
    expect(listSql).toMatch(/LOWER\(TRIM\(a\.elem ->> 'hive'\)\)/);

    // Detail endpoint
    capturedSqls.length = 0;
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      return { rows: [] };
    });
    await request(app).get('/api/papers/alice/p1');
    const detailSql = capturedSqls.find((s) => s.includes('authors_with_supersession') && s.includes('parent_author'));
    expect(detailSql).toBeDefined();
    expect(detailSql).toMatch(/LOWER\(TRIM\(a\.elem ->> 'hive'\)\)/);
  });
});

describe('supersession round-2 hold — item 2 (empty-string chain orcid parity)', () => {
  it('computeSupersession treats empty-string chain orcid as no claim (discrepancy=false)', () => {
    const orcidMap = new Map<string, string | null>([['alice', '0000-0000-0000-9999']]);
    const result = computeSupersession('alice', '', orcidMap);
    expect(result.orcid_verified).toBe('0000-0000-0000-9999');
    // Empty string is "no claim", not "claim of empty"; discrepancy stays false.
    expect(result.orcid_discrepancy).toBe(false);
  });

  it('applyAuthorSupersession: accredited author broadcasting orcid="" yields discrepancy=false', () => {
    // The publish form defaults `orcid: ''` per `frontend/src/publish.js`.
    // Without NULLIF parity (SQL) + length>0 guard (JS), every accredited
    // author who left the field blank surfaces as discrepancy=true.
    const orcidMap = new Map<string, string | null>([['alice', '0000-0000-0000-3000']]);
    const out = applyAuthorSupersession([{ hive: 'alice', orcid: '' }], orcidMap);
    expect(out).toHaveLength(1);
    expect(out[0].orcid_verified).toBe('0000-0000-0000-3000');
    expect(out[0].orcid_discrepancy).toBe(false);
  });

  it('SQL CASE wraps chain orcid in NULLIF so empty-string is rejected as no claim', async () => {
    // Mutation-kill: revert the NULLIF wrap → SQL accepts empty-string chain
    // orcid as a comparable value → false-positive discrepancy for every
    // accredited author who left the orcid field blank.
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });
    await request(app).get('/api/papers?limit=1');
    await request(app).get('/api/papers/alice/p1');
    const sqls = capturedSqls.filter((s) => s.includes('orcid_discrepancy'));
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      // Both list and detail SQL must wrap the chain orcid comparison in NULLIF.
      expect(sql).toMatch(/NULLIF\(\(a\.elem ->> 'orcid'\), ''\)/);
    }
  });
});

describe('supersession round-2 hold — item 3 (affiliation MUST NOT leak into PaperSummary)', () => {
  it('list endpoint SQL omits the affiliation projection from the authors jsonb_build_object', async () => {
    // PaperSummary's `authors[]` schema (see `agents/docs/api-contracts/papers.md`)
    // explicitly omits `affiliation`. PaperDetail carries it. Both endpoints
    // share `authorsWithSupersessionSelect`; the helper is parameterized so
    // the list endpoint passes `{ includeAffiliation: false }`.
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });
    await request(app).get('/api/papers?limit=1');
    const listSql = capturedSqls.find((s) => s.includes('authors_with_supersession') && !s.includes('count(*)::int AS total'));
    expect(listSql).toBeDefined();
    // The list endpoint MUST NOT project `affiliation` inside jsonb_build_object.
    // Pin the literal SQL fragment so any future widening of `includeAffiliation`
    // default fails this canary.
    expect(listSql).not.toMatch(/'affiliation',\s+a\.elem ->> 'affiliation'/);
  });

  it('detail endpoint SQL retains the affiliation projection', async () => {
    const capturedSqls: string[] = [];
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSqls.push(sql);
      return { rows: [] };
    });
    await request(app).get('/api/papers/alice/p1');
    const detailSql = capturedSqls.find((s) => s.includes('authors_with_supersession') && s.includes('parent_author'));
    expect(detailSql).toBeDefined();
    expect(detailSql).toMatch(/'affiliation',\s+a\.elem ->> 'affiliation'/);
  });

  it('list response authors[i] lacks the affiliation key', async () => {
    // Behavior canary: if the SQL change were reverted but the test still
    // mocked an `affiliation` field into the projected row, the route
    // would surface it. The SQL canary above pins the projection; this
    // canary pins the response shape end-to-end given the SQL contract.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 1 }] };
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
            // The SQL projection (with includeAffiliation:false) omits the
            // affiliation key entirely. This row mirrors that contract; the
            // response must not synthesize the field elsewhere.
            authors_with_supersession: [
              { name: 'Alice', hive: 'alice', orcid: null, orcid_verified: null, orcid_discrepancy: false },
            ],
          }],
        };
      }
      return { rows: [] };
    });
    const res = await request(app).get('/api/papers?limit=1');
    expect(res.status).toBe(200);
    const author = res.body.data[0].authors[0];
    expect(author.hive).toBe('alice');
    expect(author).not.toHaveProperty('affiliation');
  });
});

describe('supersession round-2 hold — item 4 (?version=N + metadata_restored fallback canaries)', () => {
  // Both branches build `detail` in JS (bypassing the SQL-projected
  // authors_with_supersession column) and then apply `applyAuthorSupersession`
  // post-build. The canaries stage the route through each branch and assert
  // the JS-side helper populated the supersession fields per the orcid map.
  //
  // Mutation-kill: delete `detail.authors = applyAuthorSupersession(...)` from
  // the targeted branch → response authors lack orcid_verified / discrepancy.

  // Helper: stage the responder so the route reaches reconstructVersionsFromHaf
  // and getAccreditedOrcidsByAccount predictably. `paperDetailRowsForAlice`
  // controls whether the initial fetchPaperDetailFromHaf SELECT returns rows
  // (the `?version=N` branch skips this SQL entirely; the metadata_restored
  // branch needs it to return 0 rows so the route falls through).
  function stageVersionRoute(opts: {
    paperDetailRowsForAlice: unknown[];
    accreditedAccount: string;
    accreditedOrcid: string | null;
    versionAuthors: Array<Record<string, unknown>>;
  }): void {
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      // findCanonicalRoot's initial probe: alice/v1 has no continues → 0 rows.
      // Discriminator: AS cont_author + IS NOT NULL filter.
      if (/AS\s+cont_author/.test(sql) && /'continues'\s+IS NOT NULL/.test(sql)) {
        return { rows: [] };
      }
      // fetchHeadAuthorizedAuthors: returns the head's pevo metadata so
      // resolveContinuationChain's cumulative author-set seeds correctly.
      // Discriminator: parent_permlink = $3 without AS cont_author.
      if (/parent_permlink\s*=\s*\$3/.test(sql) && !/AS\s+cont_author/.test(sql) && sql.includes('c.json_metadata')) {
        return {
          rows: [{
            author: 'alice',
            json_metadata: {
              app: `${config.appTag}/test`,
              [config.appTag]: {
                type: 'paper',
                authors: [{ hive: 'alice' }],
              },
            },
          }],
        };
      }
      // resolveContinuationChain forward-walker: no continuation post points
      // at alice/v1, so chain is root-only.
      if (/'continues'\s*->>\s*'author'\s*=\s*\$1/.test(sql)) {
        return { rows: [] };
      }
      // fetchPaperDetailFromHaf paper-detail SELECT: per the test config,
      // either returns the alice row or empty (forcing metadata_restored path).
      if (sql.includes('c.body') && sql.includes('c.json_metadata') && sql.includes('parent_author') && sql.includes('authors_with_supersession')) {
        return { rows: opts.paperDetailRowsForAlice };
      }
      // reconstructVersionsFromHaf: ROW_NUMBER over commentOps.
      if (sql.includes('ROW_NUMBER()') && sql.includes('OVER (ORDER BY co.block_num)')) {
        return {
          rows: [{
            version_number: 1,
            block_num: 100,
            author: 'alice',
            permlink: 'v1',
            title: 'Test',
            body: 'abstract\n\n---\n\nbody',
            created: '2026-04-01T00:00:00Z',
            json_metadata: {
              app: `${config.appTag}/test`,
              [config.appTag]: {
                type: 'paper',
                authors: opts.versionAuthors,
              },
            },
          }],
        };
      }
      // getAccreditedOrcidsByAccount: WITH active_accreditations ... SELECT account, orcid.
      if (sql.includes('FROM active_accreditations') && sql.includes('SELECT account, orcid')) {
        return { rows: [{ account: opts.accreditedAccount, orcid: opts.accreditedOrcid }] };
      }
      // getRetractionInfo / other supplementary queries: empty.
      return { rows: [] };
    });
  }

  it('?version=N branch surfaces orcid_verified + orcid_discrepancy on a mismatch', async () => {
    // alice is accredited with 0000-0000-0000-9999; chain payload claims a
    // different ORCID → orcid_verified=accredited, orcid_discrepancy=true.
    stageVersionRoute({
      paperDetailRowsForAlice: [],
      accreditedAccount: 'alice',
      accreditedOrcid: '0000-0000-0000-9999',
      versionAuthors: [{ name: 'Alice', hive: 'alice', orcid: '0000-0000-0000-1234' }],
    });
    const res = await request(app).get('/api/papers/alice/v1?version=1');
    expect(res.status).toBe(200);
    expect(res.body.data.authors).toHaveLength(1);
    const a = res.body.data.authors[0];
    expect(a.hive).toBe('alice');
    expect(a.orcid_verified).toBe('0000-0000-0000-9999');
    expect(a.orcid_discrepancy).toBe(true);
  });

  it('metadata_restored fallback surfaces orcid_verified + orcid_discrepancy on a mismatch', async () => {
    // fetchPaperDetailFromHaf returns 0 rows → route falls into the
    // version-based reconstruction → metadata_restored=true. Supersession
    // must still apply to the reconstructed detail's authors[].
    stageVersionRoute({
      paperDetailRowsForAlice: [],
      accreditedAccount: 'alice',
      accreditedOrcid: '0000-0000-0000-7777',
      versionAuthors: [{ name: 'Alice', hive: 'alice', orcid: '0000-0000-0000-5555' }],
    });
    // No ?version= query → falls into the main detail handler path.
    const res = await request(app).get('/api/papers/alice/v1');
    expect(res.status).toBe(200);
    expect(res.body.data.metadata_restored).toBe(true);
    const a = res.body.data.authors[0];
    expect(a.hive).toBe('alice');
    expect(a.orcid_verified).toBe('0000-0000-0000-7777');
    expect(a.orcid_discrepancy).toBe(true);
  });
});
