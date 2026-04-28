/**
 * Mocked-pool coverage for BE-DISCIPLINE-CANONICALIZE hold items that cannot
 * be exercised against real HAF:
 *
 *   - Hold #4 (round 1): the core dedup behavior (Physics + physics → 1 row,
 *     paper_count summed) has no deterministic real-HAF test because the
 *     public HAF database cannot be seeded with mixed-case fixtures.
 *   - Hold #3 (round 1) / Hold #3 (round 2): the pool-unavailable branch of
 *     `fetchDisciplinesFromHaf` returns `null` so `hafCache.getOrSet` skips
 *     caching; the router coerces → `[]` at the envelope layer. Testing
 *     this requires `getPool()` to return null, which real HAF never does.
 *     Hold #3 round 2 also demands a regression test proving pool-unavailable
 *     does NOT cache (a cached `[]` would pin an empty dropdown for 60s).
 *   - Hold #1(a) (round 1): `/api/papers` ?discipline= filter builds
 *     `LOWER(...) = $N` with a lowercased bound parameter. The real-HAF
 *     parity spec in papers.test.ts vacuously passes on empty corpus, so we
 *     pin the SQL shape deterministically here.
 *   - Hold #1(b) (round 1): `/api/stats` active_disciplines uses
 *     `count(DISTINCT LOWER(...))` so the KPI matches /api/disciplines dedup.
 *     The suggested real-HAF parity (active_disciplines === data.length) is
 *     not an invariant — stats filters by active_accreditations while
 *     /api/disciplines does not.
 *   - Hold #1(c) (round 1) / Hold #1 (round 2): `/api/search` lowercases
 *     `?discipline=` at route entry so case-variant requests serve from a
 *     single cache entry, not two. The round-1 assertion predicated on SQL
 *     containing `ts_rank | plainto_tsquery` matched zero calls (the search
 *     path is ILIKE-based) and silently passed on a regression; round-2 hold
 *     #1 tightens the filter to a stable papers-search data-query fragment
 *     (`AS type,`) and uses `toBe(1)` so a cache-key drift surfaces.
 *
 * Per root CLAUDE.md mocked-pool carve-out: `verifyHiveSignature` and other
 * middleware are NOT mocked; only `getPool()`. The real-HAF counterparts
 * (disciplines.test.ts, papers.test.ts) still exist for every branch where a
 * real-HAF path exists.
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
const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  // Default: pool available. Individual tests can override per-call via
  // `.mockReturnValueOnce(null)` to exercise the pool-unavailable branch.
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

describe('GET /api/disciplines — mocked pool', () => {
  it('dedup contract: SQL uses LOWER() + GROUP BY LOWER() and response is deduped', async () => {
    // Hold #4 (round 1): architect-described input was two raw-SQL rows
    //   [{name:'Physics',paper_count:1},{name:'physics',paper_count:2}]
    // representing pre-dedup rows the OLD SQL would have emitted. Post-fix,
    // the SQL LOWER() + GROUP BY LOWER() produces exactly one row
    //   {canon_name:'physics', display_name:'Physics', paper_count:3}.
    // We capture the SQL string in the mock and assert the LOWER() + GROUP
    // BY LOWER() shape AFTER the request (not inside the mock body — see
    // round-2 hold #7d; a throw inside the mock fires at uncertain times).
    let capturedSql: string | undefined;
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSql = sql;
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
    // After the bridge-paper helper migration, the disciplines query aliases
    // hafsql.comments as `c`; LOWER() now wraps `c.json_metadata`. The dedup
    // shape (LOWER + GROUP BY LOWER) is the invariant; the alias is incidental.
    expect(capturedSql).toMatch(/LOWER\(c?\.?json_metadata/);
    expect(capturedSql).toMatch(/GROUP BY LOWER\(c?\.?json_metadata/);
  });

  it('Hold #3 (round 2): returns [] when getPool() is unavailable without caching the empty sentinel', async () => {
    // Round-2 hold #3: if `fetchDisciplinesFromHaf` returned `[]` on
    // pool-unavailable, `hafCache.getOrSet` would write it as a stable 60s
    // entry and `clearVolatile()` wouldn't evict it — a transient HAF outage
    // would degrade the disciplines dropdown for a full minute post-recovery.
    // Fix: `fetchDisciplinesFromHaf` returns null → cache skip (see
    // cache.ts:73 null-guard) → router coerces null → [] at the envelope.
    //
    // First request: pool null → response is `data: []` and cache stays
    // empty. Second request: pool restored → HAF is re-queried.
    getPoolMock.mockReturnValueOnce(null);
    const res1 = await request(app).get('/api/disciplines');
    expect(res1.status).toBe(200);
    expect(Array.isArray(res1.body.data)).toBe(true);
    expect(res1.body.data).toHaveLength(0);
    // Mock's call count must not have advanced — pool was null, no query ran.
    expect(hafQueryMock).toHaveBeenCalledTimes(0);

    // Second request: default pool (non-null) restored by beforeEach setup.
    // If the null-path had poisoned the cache with [], this request would
    // still hit the cache and hafQueryMock would stay at 0. Post-fix it
    // re-queries HAF.
    hafQueryMock.mockResolvedValueOnce({
      rows: [{ canon_name: 'biology', display_name: 'Biology', paper_count: 7 }],
    });
    const res2 = await request(app).get('/api/disciplines');
    expect(res2.status).toBe(200);
    expect(res2.body.data).toHaveLength(1);
    expect(res2.body.data[0]).toMatchObject({
      canon_name: 'biology',
      display_name: 'Biology',
      paper_count: 7,
    });
    expect(hafQueryMock).toHaveBeenCalledTimes(1);
  });

  it('BE-DISPLAY-NAME-TITLECASE: display_name is INITCAP(LOWER()) — mixed-case rows collapse to canonical titlecase', async () => {
    // BE-DISPLAY-NAME-TITLECASE: `display_name` is produced via
    // INITCAP(LOWER(...)) so the three casing variants "Computer Science",
    // "computer science", "COMPUTER SCIENCE" collapse under the GROUP BY
    // LOWER() into one row with `canon_name: "computer science"` and
    // `display_name: "Computer Science"`. Real-HAF cannot be seeded with
    // mixed-case fixtures (per the existing dedup test carve-out above), so
    // this test captures the outgoing SQL + simulates the Postgres result
    // the INITCAP(LOWER(...)) expression would produce on that fixture.
    let capturedSql: string | undefined;
    hafQueryMock.mockImplementation(async (sql: string) => {
      capturedSql = sql;
      // Simulate Postgres GROUP BY LOWER() + INITCAP(LOWER()) reducing the
      // three input rows (Computer Science, computer science, COMPUTER
      // SCIENCE with counts 1+2+1=4) to a single canonical row.
      return {
        rows: [
          { canon_name: 'computer science', display_name: 'Computer Science', paper_count: 4 },
        ],
      };
    });
    const res = await request(app).get('/api/disciplines');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      canon_name: 'computer science',
      display_name: 'Computer Science',
      paper_count: 4,
    });
    // Pin the SQL shape: display_name is INITCAP(LOWER(...)), not MAX(...).
    // A revert to MAX() would cause `display_name === canon_name` for pure-
    // ASCII disciplines on the Postgres C-locale (uppercase codepoints sort
    // before lowercase), silently regressing the consumer-facing label.
    expect(capturedSql).toBeDefined();
    // Alias-tolerant: post bridge-paper helper migration, the column is
    // qualified as `c.json_metadata`. The shape invariant is INITCAP(LOWER(...))
    // not MAX(...); the alias is incidental.
    expect(capturedSql!).toMatch(/INITCAP\(LOWER\(c?\.?json_metadata/);
    expect(capturedSql!).not.toMatch(/MAX\(c?\.?json_metadata/);
  });

  it('Hold #7a: catch branch (pool exists, query throws) returns 200 + data: []', async () => {
    // `fetchDisciplinesFromHaf` catches pool.query errors, logs, and returns
    // null. The router coerces null → []. Verify the error path does NOT
    // cache the empty sentinel (parity with the pool-unavailable branch —
    // both go through the same null-return → cache-skip path).
    hafQueryMock.mockRejectedValueOnce(new Error('HAF down'));
    const res1 = await request(app).get('/api/disciplines');
    expect(res1.status).toBe(200);
    expect(Array.isArray(res1.body.data)).toBe(true);
    expect(res1.body.data).toHaveLength(0);
    expect(hafQueryMock).toHaveBeenCalledTimes(1);

    // Re-query on next request — not a cached empty response.
    hafQueryMock.mockResolvedValueOnce({
      rows: [{ canon_name: 'chemistry', display_name: 'Chemistry', paper_count: 2 }],
    });
    const res2 = await request(app).get('/api/disciplines');
    expect(res2.status).toBe(200);
    expect(res2.body.data).toHaveLength(1);
    expect(res2.body.data[0]).toMatchObject({
      canon_name: 'chemistry',
      display_name: 'Chemistry',
      paper_count: 2,
    });
    expect(hafQueryMock).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/stats — active_disciplines SQL uses LOWER() to match /api/disciplines dedup', () => {
  it(
    'Hold #1(b): count(DISTINCT LOWER(...)) — parity with /api/disciplines canon_name dedup',
    async () => {
      // Round-2 hold #4: exercise via the HTTP route (not `startStatsCache`
      // which registers an unref'd setInterval that can fire after beforeEach
      // resets the mock-call counters). Call `fetchStatsFromHaf` directly,
      // prime the cache with its return value, then hit `/api/stats` so the
      // HTTP handler path is what covers the SQL-shape invariant.
      let capturedSql: string | undefined;
      hafQueryMock.mockImplementation(async (sql: string) => {
        // stats is the only SQL containing the `active_disciplines` alias;
        // capture the first match and assert AFTER the request (out-of-mock).
        if (sql.includes('active_disciplines') && capturedSql === undefined) {
          capturedSql = sql;
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
      const { fetchStatsFromHaf } = await import('../../src/routes/stats.js');
      const stats = await fetchStatsFromHaf();
      await hafCache.set('stats', stats, 60_000, true);
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(capturedSql).toBeDefined();
      expect(capturedSql!).toMatch(/count\(DISTINCT LOWER\(json_metadata/);
    },
  );
});

describe('GET /api/papers — discipline-filter SQL uses LOWER() on both sides', () => {
  it(
    'Hold #1(a, SQL-shape): ?discipline= builds `LOWER(...) = $N` with lowercased param',
    async () => {
      // papers.ts ran against real HAF in papers.test.ts; this test nails
      // the SQL shape so a regression reverting only one side of the
      // LOWER() application (column OR bound parameter) surfaces even
      // when the real-HAF corpus happens to be lowercase-only. Capture
      // the SQL + params inside the mock and assert AFTER the request
      // (round-2 hold #7d — throw-inside-mock fires at uncertain times).
      let capturedSql: string | undefined;
      let capturedParams: unknown[] | undefined;
      hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes("->> 'discipline'") && sql.includes('LOWER(c.json_metadata') && capturedSql === undefined) {
          capturedSql = sql;
          capturedParams = params;
        }
        return { rows: [], rowCount: 0 };
      });
      const res = await request(app).get('/api/papers?discipline=PHYSICS');
      expect(res.status).toBe(200);
      expect(capturedSql).toBeDefined();
      expect(capturedSql!).toContain('LOWER(c.json_metadata');
      expect(capturedSql!).toContain("->> 'discipline'");
      // Bound parameter must be the lowercased user input — uppercase input
      // `PHYSICS` must bind as `physics` so LOWER(column) = $N matches.
      expect(capturedParams).toBeDefined();
      expect(capturedParams!).toContain('physics');
    },
  );
});

describe('GET /api/papers — discipline-filter cache-key canonicalization', () => {
  it(
    'Hold #1 (round 3): case-variant ?discipline= values serve from a single cache entry (papers-data query invoked once)',
    async () => {
      // Round-3 hold #1 (papers.ts sibling of search.ts round-2 hold #6):
      // `/api/papers` was lowercasing at the SQL-binder site only; the route
      // handler's cache key embedded the raw (non-lowercased) `discipline`
      // value. `?discipline=Physics` and `?discipline=physics` produced
      // distinct Redis cache entries despite the SQL-side LOWER() match,
      // defeating the dedup at the memoization layer on the PRIMARY paper
      // feed. Fix mirrors search.ts:287 — lowercase once at route entry.
      //
      // Filter to the papers-data query (absent from papers-count, reviews,
      // and the batch reputation/vote-ops lookups). The `LEFT(c.body, 300)
      // AS abstract` fragment is unique to the papers SELECT data path.
      // Tighten to `toBe(1)` so a regression to per-casing cache keys (which
      // would emit 2 data queries across the two case-variant requests)
      // surfaces.
      hafQueryMock.mockResolvedValue({ rows: [] });

      const res1 = await request(app).get('/api/papers?discipline=Physics');
      const res2 = await request(app).get('/api/papers?discipline=physics');
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const papersDataCalls = hafQueryMock.mock.calls.filter((call) => {
        const sql = String(call[0] || '');
        return sql.includes('LEFT(c.body, 300) AS abstract');
      });
      expect(papersDataCalls).toHaveLength(1);
    },
  );
});

describe('GET /api/papers — repeated-param `?discipline=a&discipline=b` trap', () => {
  it(
    'Hold #3 (round 4): repeated discipline params narrow to `undefined`/`""` without `"[object Object]"` leakage',
    async () => {
      // Round-3 hold #2 added a typeof-narrowed parse (`typeof raw ===
      // 'string' ? raw.toLowerCase() : ''/undefined`) at each site to defend
      // against Express yielding `string[]` for repeated query params
      // (`?discipline=a&discipline=b`). A regression reverting to
      // `(req.query.discipline as string | undefined)?.toLowerCase()` would
      // call `.toLowerCase()` on the array and silently coerce to
      // `"[object Object]"` (actually `undefined`, but older patterns with
      // `.map(...).join()` or default fallbacks can land there). Round-4
      // hold #3 pins the bound-param and cache-key behavior so a revert
      // cannot pass this suite.
      //
      // Expected post-fix: the inner SQL gate sees `discipline === undefined`
      // and emits NO `LOWER(c.json_metadata) = $N` clause at all (so no
      // filter param gets bound for discipline). The cache-key fragment is
      // the empty string (`d=`). Two repeated-param requests therefore share
      // one cache entry → papers-data query runs exactly once.
      let capturedPapersSql: string | undefined;
      let capturedPapersParams: unknown[] | undefined;
      hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes('LEFT(c.body, 300) AS abstract') && capturedPapersSql === undefined) {
          capturedPapersSql = sql;
          capturedPapersParams = params;
        }
        return { rows: [] };
      });

      const res1 = await request(app).get('/api/papers?discipline=a&discipline=b');
      const res2 = await request(app).get('/api/papers?discipline=a&discipline=b');
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Bound SQL params must not contain the string[].toLowerCase() coercion.
      expect(capturedPapersParams).toBeDefined();
      for (const p of capturedPapersParams!) {
        expect(p).not.toBe('[object Object]');
      }
      // With typeof-narrowing, no discipline filter fires → SQL must NOT
      // contain the LOWER(...) = $N discipline clause for this request path.
      expect(capturedPapersSql).toBeDefined();
      expect(capturedPapersSql!).not.toMatch(/LOWER\(c\.json_metadata[^)]*\)\s*->>\s*'discipline'\)\s*=/);

      // Cache-key fragment for a repeated param must canonicalize to `d=`
      // (empty) so the two requests dedup into a single entry → papers-data
      // query runs exactly once across the two requests.
      const papersDataCalls = hafQueryMock.mock.calls.filter((call) => {
        const sql = String(call[0] || '');
        return sql.includes('LEFT(c.body, 300) AS abstract');
      });
      expect(papersDataCalls).toHaveLength(1);
    },
  );
});

describe('GET /api/search — repeated-param `?discipline=a&discipline=b` trap', () => {
  it(
    'Hold #3 (round 4): repeated discipline params narrow to `undefined` without `"[object Object]"` leakage',
    async () => {
      // search.ts:293 uses the same typeof-narrowed pattern. Mirrors the
      // /api/papers assertion above for the search-cache-key path. Since the
      // search cache-key hashes `d=${discipline || ''}` into the SHA-256
      // prefix (see search.ts:306), a `[object Object]` coercion would
      // produce a different (but still consistent) hash across both
      // requests — so the one-call assertion alone wouldn't catch a revert.
      // We additionally check the bound SQL parameter list.
      let capturedPapersSearchSql: string | undefined;
      let capturedPapersSearchParams: unknown[] | undefined;
      hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes("->> 'type') AS type,") && capturedPapersSearchSql === undefined) {
          capturedPapersSearchSql = sql;
          capturedPapersSearchParams = params;
        }
        return {
          rows: [
            { type: 'paper', author: 'alice', permlink: 'test', title: 'x', snippet: 'x', created: '2026-01-01' },
          ],
        };
      });

      const res1 = await request(app).get('/api/search?q=science&discipline=a&discipline=b');
      const res2 = await request(app).get('/api/search?q=science&discipline=a&discipline=b');
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      expect(capturedPapersSearchParams).toBeDefined();
      for (const p of capturedPapersSearchParams!) {
        expect(p).not.toBe('[object Object]');
      }
      // With typeof-narrowing, no discipline filter fires.
      expect(capturedPapersSearchSql).toBeDefined();
      expect(capturedPapersSearchSql!).not.toMatch(/LOWER\(c\.json_metadata[^)]*\)\s*->>\s*'discipline'\)\s*=/);

      const papersDataCalls = hafQueryMock.mock.calls.filter((call) => {
        const sql = String(call[0] || '');
        return sql.includes("->> 'type') AS type,");
      });
      expect(papersDataCalls).toHaveLength(1);
    },
  );
});

describe('GET /api/search — discipline-filter cache-key canonicalization', () => {
  it(
    'Hold #1 (round 2): case-variant ?discipline= values serve from a single cache entry (papers-search data query invoked once)',
    async () => {
      // Round-2 hold #1 rewrites the round-1 vacuous assertion. The old
      // filter matched on `ts_rank | plainto_tsquery | websearch_to_tsquery`
      // — tokens that DO NOT appear anywhere in `searchPapersFromHaf` (it's
      // ILIKE-based). Every SQL call mismatched → array was empty →
      // `toBeLessThanOrEqual(1)` trivially passed even on a revert of the
      // `search.ts` lowercasing. Fix: filter on a stable papers-search
      // data-query fragment (`AS type,` — the first selected column in the
      // papers data query, absent from papers count, reviews count/data,
      // and the accredited-set batch lookup); tighten to `toBe(1)`.
      hafQueryMock.mockResolvedValue({
        rows: [
          { type: 'paper', author: 'alice', permlink: 'test', title: 'x', snippet: 'x', created: '2026-01-01' },
        ],
      });

      const res1 = await request(app).get('/api/search?q=science&discipline=Physics');
      const res2 = await request(app).get('/api/search?q=science&discipline=physics');
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Filter to the papers-search DATA query (the one that materializes
      // rows, via `(c.json_metadata -> $N ->> 'type') AS type, c.author,
      // c.permlink, c.title, ... AS snippet, c.created`). One such call per
      // cache-missing papers-search invocation. Before the fix, each casing
      // populated a separate cache key → 2 calls. Post-fix: 1.
      const papersDataCalls = hafQueryMock.mock.calls.filter((call) => {
        const sql = String(call[0] || '');
        return sql.includes("->> 'type') AS type,");
      });
      expect(papersDataCalls).toHaveLength(1);
    },
  );
});
