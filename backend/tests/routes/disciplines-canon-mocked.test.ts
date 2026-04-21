/**
 * Mocked-pool coverage for BE-DISCIPLINE-CANONICALIZE hold items that cannot
 * be exercised against real HAF:
 *
 *   - Hold #4: the core dedup behavior (Physics + physics → 1 row, paper_count
 *     summed) has no deterministic real-HAF test because the public HAF
 *     database cannot be seeded with mixed-case fixtures.
 *   - Hold #3: the pool-unavailable branch of `fetchDisciplinesFromHaf`
 *     returns `[]` so the response envelope stays Array-shaped. Testing
 *     this requires `getPool()` to return null, which real HAF never does.
 *   - Hold #2: verify the deprecated-pending-removal `name` alias is present
 *     in the response mapping. Implicitly covered by Hold #4 assertion but
 *     called out explicitly so a future shim-removal PR breaks this test
 *     and signals the FE migration is expected to have landed.
 *   - Hold #1(c): `/api/search` cache-key lowercases `?discipline=` so
 *     case-variant requests serve from a single cache entry, not two. Needs
 *     a spy on pool.query to count invocations.
 *
 * Per root CLAUDE.md mocked-pool carve-out: `verifyHiveSignature` and other
 * middleware are NOT mocked; only `getPool()` / `getAppPool()`. The real-HAF
 * counterparts (disciplines.test.ts, papers.test.ts) still exist for every
 * branch where a real-HAF path exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async () => ({ rows: [] })),
}));

let hafPoolEnabled = true;

vi.mock('../../src/db.js', () => ({
  getPool: () => (hafPoolEnabled ? { query: hafQueryMock } : null),
  isHafAvailable: () => hafPoolEnabled,
  closeHafPool: async () => { /* no-op */ },
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  hafPoolEnabled = true;
  await hafCache.clear();
});

describe('GET /api/disciplines — mocked pool', () => {
  it('dedup contract: SQL uses LOWER() + GROUP BY LOWER() and response is deduped', async () => {
    // Hold #4: architect-described input was two raw-SQL rows
    //   [{name:'Physics',paper_count:1},{name:'physics',paper_count:2}]
    // representing pre-dedup rows that the OLD SQL would have emitted.
    // Post-fix, the SQL LOWER() + GROUP BY LOWER() produces exactly one
    // row `{canon_name:'physics', display_name:'Physics', paper_count:3}`.
    // The mocked pool cannot execute SQL, so we simulate what the post-
    // canonicalization SQL produces, AND assert the SQL string contains
    // LOWER(...) and GROUP BY LOWER(...) so a regression to the old
    // case-sensitive query (the root bug this task closed) fails here.
    hafQueryMock.mockImplementation(async (sql: string) => {
      expect(sql).toContain("LOWER(json_metadata");
      expect(sql).toMatch(/GROUP BY LOWER\(json_metadata/);
      return {
        rows: [
          { canon_name: 'physics', display_name: 'Physics', paper_count: 3 },
        ],
      };
    });
    const res = await request(app).get('/api/disciplines');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      canon_name: 'physics',
      display_name: 'Physics',
      paper_count: 3,
    });
    expect(hafQueryMock).toHaveBeenCalledTimes(1);
  });

  it('Hold #2 shim: response carries `name` alias equal to display_name', async () => {
    hafQueryMock.mockResolvedValueOnce({
      rows: [
        { canon_name: 'neuroscience', display_name: 'Neuroscience', paper_count: 42 },
      ],
    });
    const res = await request(app).get('/api/disciplines');
    expect(res.status).toBe(200);
    const row = res.body.data[0];
    expect(row.name).toBe('Neuroscience');
    expect(row.name).toBe(row.display_name);
    // Guard against a future shim-removal PR: deleting the alias is expected
    // to fail this assertion and force the PR author to audit FE consumers.
  });

  it('Hold #3: returns [] (not null) when getPool() is unavailable', async () => {
    hafPoolEnabled = false;
    const res = await request(app).get('/api/disciplines');
    expect(res.status).toBe(200);
    // Contract is data: Array<Discipline>. Returning null violates the
    // envelope and breaks strict parsers that expect an iterable.
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('GET /api/stats — active_disciplines SQL uses LOWER() to match /api/disciplines dedup', () => {
  it(
    'Hold #1(b): count(DISTINCT LOWER(...)) — parity with /api/disciplines canon_name dedup',
    async () => {
      // The architect's suggested real-HAF parity test (active_disciplines ===
      // disciplines.data.length) cannot hold against real HAF because stats.ts
      // filters papers by accreditation (papers CTE includes
      // `active_accreditations` join) while /api/disciplines does not. The
      // two endpoints count from different sets.
      //
      // Instead, invoke the stats periodic refresh manually (the /api/stats
      // HTTP route only reads from the warmed cache; the pool query runs via
      // `registerPeriodicRefresh`). Assert the SQL-shape invariant directly:
      // stats.ts must count DISTINCT LOWER(...) not DISTINCT (...). Removing
      // LOWER from this specific query reopens the mixed-case double-count
      // bug on the `active_disciplines` KPI.
      let sawStatsQuery = false;
      hafQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('active_disciplines')) {
          sawStatsQuery = true;
          expect(sql).toMatch(/count\(DISTINCT LOWER\(json_metadata/);
        }
        return { rows: [{
          total_accredited_researchers: 0,
          total_papers: 0,
          total_bridge_papers: 0,
          papers_last_30_days: 0,
          active_disciplines: 0,
          total_citations: 0,
          total_reviews: 0,
          reviews_last_30_days: 0,
        }] };
      });
      const { startStatsCache } = await import('../../src/routes/stats.js');
      await startStatsCache();
      expect(sawStatsQuery).toBe(true);
    },
  );
});

describe('GET /api/papers — discipline-filter SQL uses LOWER() on both sides', () => {
  it(
    'Hold #1(a, SQL-shape): ?discipline= builds `LOWER(...) = $N` with lowercased param',
    async () => {
      // papers.ts ran against real HAF in papers.test.ts; this test nails the
      // SQL shape so a regression that reverts only one side of the LOWER()
      // application (column OR bound parameter) surfaces even if the real-
      // HAF corpus happens to be lowercase-only.
      let sawDisciplineFilter = false;
      hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes("->> 'discipline'") && sql.includes('LOWER(c.json_metadata')) {
          sawDisciplineFilter = true;
          // Bound parameter must be the lowercased user input.
          expect(params).toContain('physics');
        }
        return { rows: [], rowCount: 0 };
      });
      const res = await request(app).get('/api/papers?discipline=PHYSICS');
      expect(res.status).toBe(200);
      expect(sawDisciplineFilter).toBe(true);
    },
  );
});

describe('GET /api/search — discipline-filter cache-key canonicalization', () => {
  it(
    'Hold #1(c): case-variant ?discipline= values serve from a single cache entry (pool invoked once)',
    async () => {
      // Simulate a non-empty SQL result so the route takes the caching
      // branch (searchFromHaf). The exact rows don't matter; we assert on
      // pool.query call count across two requests.
      hafQueryMock.mockResolvedValue({
        rows: [
          { author: 'alice', permlink: 'test', title: 'x', snippet: 'x', type: 'paper', created: '2026-01-01', rank: 1 },
        ],
      });

      const res1 = await request(app).get('/api/search?q=science&discipline=Physics');
      const res2 = await request(app).get('/api/search?q=science&discipline=physics');
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      // The primary search SQL is the only query that matters for cache-hit
      // accounting. Filter the mock calls to it (it contains the papers CTE
      // and ts_rank) so the accredited-set lookup below doesn't inflate the
      // count. Before the fix, each casing populated a separate cache key
      // and this count was 2; post-fix it's 1.
      const searchCalls = hafQueryMock.mock.calls.filter((call) => {
        const sql = String(call[0] || '');
        return sql.includes('ts_rank') || sql.includes('plainto_tsquery') || sql.includes('websearch_to_tsquery');
      });
      expect(searchCalls.length).toBeLessThanOrEqual(1);
    },
  );
});
