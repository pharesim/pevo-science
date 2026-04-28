/**
 * BE-BRIDGE-PAPER-AUTHOR-GATE — canary tests for the SQL-shape invariant
 * pinning the bridge_paper accreditation carve-out to
 * `c.author = config.hiveBridgeAccount`.
 *
 * Why mocked-pool (per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage"): real HAF cannot be seeded with a spoofed `bridge_paper`-typed
 * post by an unaccredited author — that is precisely the scenario we are
 * defending against. Asserting the SQL shape (parameterized author equality
 * AND-bound to the type-equality clause) is the deterministic invariant: a
 * regression that drops the author equality re-opens the bypass even if
 * real-HAF assertions stay green on a corpus where no spoof exists.
 *
 * `verifyHiveSignature` and other middleware are NOT mocked; only `getPool()`.
 * Real-HAF parity for the non-spoofed path is covered by `papers.test.ts`,
 * `search.test.ts`, and `routes/health.test.ts` calling `/api/stats`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async () => ({ rows: [] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafAvailable: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { config } = await import('../../src/config.js');
const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

// Match the bridge_paper accreditation carve-out: it must AND-bind the
// type-equality with `c.author = $N` (the bridge account). A regression that
// drops the author equality (the original vulnerable shape:
//   `(... OR (c.json_metadata -> $T ->> 'type') = 'bridge_paper')`)
// fails this regex.
const BRIDGE_CARVE_OUT_SQL = /c\.author\s*=\s*\$\d+\s*AND\s*\(c\.json_metadata\s*->\s*\$\d+\s*->>\s*'type'\)\s*=\s*'bridge_paper'/;

// The vulnerable shape: type-equality with no AND-bound author equality on
// the immediately preceding side of the OR. Used as a negative assertion to
// catch a partial regression where someone re-introduces the bare type
// carve-out alongside the new one.
const BARE_TYPE_CARVE_OUT_SQL = /OR\s*\(c\.json_metadata\s*->\s*\$\d+\s*->>\s*'type'\)\s*=\s*'bridge_paper'\s*\)/;

describe('BE-BRIDGE-PAPER-AUTHOR-GATE — bridge_paper carve-out is pinned to config.hiveBridgeAccount', () => {
  it('GET /api/papers AND-binds bridge_paper carve-out to c.author = $bridge', async () => {
    let capturedSql: string | undefined;
    let capturedParams: unknown[] | undefined;
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      // Capture the papers DATA query (unique fragment: `LEFT(c.body, 300) AS abstract`).
      if (sql.includes('LEFT(c.body, 300) AS abstract') && capturedSql === undefined) {
        capturedSql = sql;
        capturedParams = params;
      }
      return { rows: [], rowCount: 0 };
    });
    // accredited_only defaults to true, so the carve-out fires.
    const res = await request(app).get('/api/papers');
    expect(res.status).toBe(200);
    expect(capturedSql).toBeDefined();
    expect(capturedSql!).toMatch(BRIDGE_CARVE_OUT_SQL);
    expect(capturedSql!).not.toMatch(BARE_TYPE_CARVE_OUT_SQL);
    // The bound parameter must be `config.hiveBridgeAccount`.
    expect(capturedParams).toBeDefined();
    expect(capturedParams!).toContain(config.hiveBridgeAccount);
  });

  it('GET /api/papers omits the carve-out when accredited_only=false (no bridge param leak)', async () => {
    let capturedParams: unknown[] | undefined;
    let capturedSql: string | undefined;
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('LEFT(c.body, 300) AS abstract') && capturedSql === undefined) {
        capturedSql = sql;
        capturedParams = params;
      }
      return { rows: [], rowCount: 0 };
    });
    const res = await request(app).get('/api/papers?accredited_only=false');
    expect(res.status).toBe(200);
    expect(capturedSql).toBeDefined();
    // No accreditation gate, no bridge carve-out.
    expect(capturedSql!).not.toMatch(/active_accreditations\)\s*OR\s*\(c\.author/);
    // And the bridge account param is not bound to the WHERE-clause params.
    // (Real-HAF papers.ts also threads `hiveAnonAccount` into dataParams for
    // the SELECT subqueries; that's allowed. We only assert no bridge leak
    // when accredited_only=false.)
    if (capturedParams) {
      // The bridge account may equal hiveAdminAccount (pevo.admin) by config
      // default. Assert by absence of any param matching hiveBridgeAccount
      // EXCEPT through the anonymous account threading. Keep this assertion
      // narrow: the carve-out branch must not have appended a param.
      // If hiveBridgeAccount === hiveAnonAccount in some config, this would
      // false-positive — guard with the inequality.
      if (config.hiveBridgeAccount !== config.hiveAnonAccount) {
        expect(capturedParams).not.toContain(config.hiveBridgeAccount);
      }
    }
  });

  it('GET /api/search AND-binds bridge_paper carve-out to c.author = $bridge', async () => {
    let capturedSql: string | undefined;
    let capturedParams: unknown[] | undefined;
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      // Capture the search DATA query (unique fragment: `->> 'type') AS type,`).
      if (sql.includes("->> 'type') AS type,") && capturedSql === undefined) {
        capturedSql = sql;
        capturedParams = params;
      }
      return { rows: [], rowCount: 0 };
    });
    const res = await request(app).get('/api/search?q=science');
    expect(res.status).toBe(200);
    expect(capturedSql).toBeDefined();
    expect(capturedSql!).toMatch(BRIDGE_CARVE_OUT_SQL);
    expect(capturedSql!).not.toMatch(BARE_TYPE_CARVE_OUT_SQL);
    expect(capturedParams).toBeDefined();
    expect(capturedParams!).toContain(config.hiveBridgeAccount);
  });

  it('GET /api/stats CTE AND-binds bridge_paper carve-out to c.author = $bridge', async () => {
    // The stats CTE uses the LEFT JOIN form: `aa.account IS NOT NULL OR
    // (c.author = $bridge AND (c.json_metadata -> $at ->> 'type') = 'bridge_paper')`.
    // The shape is structurally equivalent to the BRIDGE_CARVE_OUT_SQL pattern.
    let capturedSql: string | undefined;
    let capturedParams: unknown[] | undefined;
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('total_bridge_papers') && capturedSql === undefined) {
        capturedSql = sql;
        capturedParams = params;
        return {
          rows: [{
            total_accredited_researchers: 0,
            total_papers: 0,
            total_bridge_papers: 0,
            papers_last_30_days: 0,
            active_disciplines: 0,
            total_citations: 0,
            total_reviews: 0,
            reviews_last_30_days: 0,
          }],
        };
      }
      return { rows: [] };
    });
    // Hit fetchStatsFromHaf directly (the route reads from cache).
    const { fetchStatsFromHaf } = await import('../../src/routes/stats.js');
    const stats = await fetchStatsFromHaf();
    expect(stats).not.toBeNull();
    expect(capturedSql).toBeDefined();
    expect(capturedSql!).toMatch(BRIDGE_CARVE_OUT_SQL);
    expect(capturedSql!).not.toMatch(BARE_TYPE_CARVE_OUT_SQL);
    expect(capturedParams).toBeDefined();
    expect(capturedParams!).toContain(config.hiveBridgeAccount);
  });

  it('canary: simulated spoofed bridge_paper from unaccredited author is excluded by SQL semantics', async () => {
    // This test simulates the post-fix semantics: when the SQL carve-out
    // requires `c.author = $bridge`, a row authored by `mallory` (not the
    // bridge account) but typed `bridge_paper` would not satisfy the WHERE
    // clause. We can't run that against the mock query plan directly, but we
    // can prove the bound parameter is the bridge account (not, e.g., the
    // empty string or the requesting user's name) so the SQL would in fact
    // filter it.
    let capturedParams: unknown[] | undefined;
    let capturedSql: string | undefined;
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('LEFT(c.body, 300) AS abstract') && capturedSql === undefined) {
        capturedSql = sql;
        capturedParams = params;
      }
      return { rows: [], rowCount: 0 };
    });
    const res = await request(app).get('/api/papers?accredited_only=true');
    expect(res.status).toBe(200);
    expect(capturedParams).toBeDefined();
    // The single bound param matching the carve-out clause MUST be the bridge
    // account, not user-controlled input.
    expect(capturedParams!).toContain(config.hiveBridgeAccount);
    // Defensive: there is no params slot containing user-controlled input
    // that lines up with the bridge equality clause. We can't pinpoint slot
    // index without a SQL parser, but we can confirm `mallory` (a stand-in
    // for an arbitrary unaccredited author) is NOT bound — the request did
    // not pass `?author=mallory`.
    expect(capturedParams!).not.toContain('mallory');
  });
});
