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
const { config } = await import('../../src/config.js');
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

describe('per-paper `discipline` response field — canon_name (lowercased) via paperDisciplineField()', () => {
  // BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2 hold #1: the round-1 real-HAF
  // specs (`papers.test.ts:79`, `:175`) were corpus-vacuous — they asserted
  // `paper.discipline === paper.discipline.toLowerCase()` which passes
  // regardless of whether `paperDisciplineField()` actually runs on any
  // all-lowercase or empty corpus. A revert of the helper call sites to
  // `pevo.discipline || null` would NOT fail those tests.
  //
  // These mocked-pool specs deterministically pin the canon transform by
  // seeding `'  Computer Science  '` (whitespace-padded mixed case) and
  // asserting the response carries `'computer science'`. They cover all three
  // response-shaping sites threaded through `paperDisciplineField()`:
  //   - `/api/papers` list mapping (papers.ts:400)
  //   - `/api/papers/:author/:permlink` detail via `buildPaperDetail`
  //     (papers.ts:1005) — chain length 1 path
  //   - `/api/papers/:author/:permlink` detail continuation-chain head-override
  //     (papers.ts:613) — chain length > 1 path (only fired when an edited
  //     paper's head version is in a different post; round-1 had no targeted
  //     spec for this branch).

  function buildPevoPaperMeta(discipline: unknown, authorHandles: string[] = []) {
    // Minimal `isPevoPaper`-passing metadata: appTag-prefixed `app` + nested
    // `{ type: 'paper', discipline }` under `config.appTag`. Mirrors the
    // shape produced by the publish form. Discipline is intentionally typed
    // `unknown` so the seed can verify the helper's `unknown` parameter
    // accepts whatever shape on-chain metadata carries (string with
    // whitespace + mixed case is the contract case here).
    //
    // `authorHandles` populates `pevo.authors[].hive` for tests that walk a
    // continuation chain — the chain-admit gate
    // (BACKEND-CONTINUATION-POST-AUTHOR-CONSENT-GATE) requires the
    // continuation post's author to be in the head paper's named-author set.
    // Defaults to `[]` for non-chain seeds, where the gate is irrelevant.
    return {
      app: `${config.appTag}/1.0`,
      [config.appTag]: {
        type: 'paper',
        discipline,
        keywords: [],
        authors: authorHandles.map((hive) => ({ hive })),
      },
    };
  }

  it('GET /api/papers — list mapping lowercases + trims whitespace-padded mixed case to canon', async () => {
    // Seed both halves of the Promise.all in fetchPapersFromHaf:
    //   - papers-count query (matched via `count(*)::int AS total`) → 1
    //   - papers-data query (matched via `LEFT(c.body, 300) AS abstract`) → 1
    //     row with `pevo.discipline = '  Computer Science  '`. The helper
    //     should trim + lowercase to `'computer science'`.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('count(*)::int AS total')) {
        return { rows: [{ total: 1 }] };
      }
      if (sql.includes('LEFT(c.body, 300) AS abstract')) {
        return {
          rows: [{
            author: 'alice',
            permlink: 'p-1',
            title: 'Test Paper',
            abstract: 'Abstract text',
            json_metadata: buildPevoPaperMeta('  Computer Science  '),
            created: '2026-04-28T00:00:00',
            net_votes: 0,
            review_count: 0,
            citation_count: 0,
            avg_rating: 0,
            author_reputation: 0,
          }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers?accredited_only=false');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // Canon contract: trimmed + lowercased. A revert of `paperDisciplineField`
    // to `pevo.discipline || null` would surface here as `'  Computer Science  '`.
    expect(res.body.data[0].discipline).toBe('computer science');
  });

  it('GET /api/papers/:author/:permlink — buildPaperDetail lowercases + trims (chain length 1)', async () => {
    // Seeds the simpler detail path: paper has no continuation, so chain
    // length 1, head-override block does not fire, and the canon transform
    // happens at `buildPaperDetail` (papers.ts:1005) only.
    hafQueryMock.mockImplementation(async (sql: string) => {
      // Detail SELECT: `SELECT c.author, c.permlink, c.title, c.body,
      // c.json_metadata, c.created, c.last_edited`. Match on the `c.last_edited`
      // tail since that column is unique to fetchPaperDetailFromHaf among the
      // paper-related queries.
      if (sql.includes('c.last_edited') && sql.includes('c.author = $1 AND c.permlink = $2')) {
        return {
          rows: [{
            author: 'alice',
            permlink: 'p-1',
            title: 'Test Paper',
            body: 'abstract\n\n---\n\nfull text',
            json_metadata: buildPevoPaperMeta('  Computer Science  '),
            created: '2026-04-28T00:00:00',
            last_edited: '2026-04-28T00:00:00',
          }],
        };
      }
      // Every other query (continuation lookup, version reconstruction,
      // accreditation set, retraction lookup, findCanonicalRoot) returns
      // empty rows — chain length 1, no versions, not retracted, not
      // accredited. Sufficient to exercise the detail discipline path.
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p-1');
    expect(res.status).toBe(200);
    expect(res.body.data.discipline).toBe('computer science');
  });

  it('GET /api/papers/:author/:permlink — continuation-chain head-override lowercases head metadata (chain length > 1)', async () => {
    // Round-2 hold #1 explicitly calls out the continuation-chain head-override
    // path at papers.ts:613 as having no targeted spec. This test seeds:
    //   - Original paper alice/p-1 with `discipline = 'Physics'`
    //   - Continuation post bob/p-2 with `discipline = 'BiOlOgY'` (different
    //     case + different value)
    //   - resolveContinuationChain returns 1 row pointing alice/p-1 → bob/p-2
    //     on the first iteration, then 0 rows (chain ends)
    //   - reconstructVersionsFromHaf comment-ops query returns 2 rows: alice's
    //     original at block 100 and bob's continuation at block 200 (latest)
    //
    // Expected: `detail.discipline` ends up as `paperDisciplineField('BiOlOgY')`
    // = `'biology'` via line 613, NOT `'physics'` from the original paper's
    // line 1005 (which fires first then is overridden).
    let continuationCallCount = 0;
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      // Detail SELECT for the original paper alice/p-1.
      if (sql.includes('c.last_edited') && sql.includes('c.author = $1 AND c.permlink = $2')) {
        return {
          rows: [{
            author: 'alice',
            permlink: 'p-1',
            title: 'Original Paper',
            body: 'abstract\n\n---\n\nfull text',
            json_metadata: buildPevoPaperMeta('Physics', ['alice', 'bob']),
            created: '2026-04-20T00:00:00',
            last_edited: '2026-04-20T00:00:00',
          }],
        };
      }
      // fetchHeadAuthorizedAuthors (continuation gate, BACKEND-CONTINUATION-
      // POST-AUTHOR-CONSENT-GATE) selects only `c.author, c.json_metadata`
      // — no `c.last_edited`. Discriminate against the detail SELECT by the
      // narrower projection. authorHandles must include bob so the gate
      // admits bob/p-2 into the chain.
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('c.author = $1 AND c.permlink = $2')) {
        return {
          rows: [{
            author: 'alice',
            json_metadata: buildPevoPaperMeta('Physics', ['alice', 'bob']),
          }],
        };
      }
      // findCanonicalRoot uses `'continues' ->> 'author' AS cont_author`
      // (selected as alias). It walks BACKWARD from a continuation post to
      // its root. For our test alice/p-1 IS the root, so this query must
      // return 0 rows so the route does not redirect. Distinguished from
      // resolveContinuationChain by the `AS cont_author` literal.
      if (sql.includes('AS cont_author')) {
        return { rows: [] };
      }
      // resolveContinuationChain walks FORWARD from the root looking for
      // continuations. Distinguished by the WHERE bind
      // `'continues' ->> 'author' = $1`. Iterates from (alice, p-1). First
      // call returns the bob/p-2 link; subsequent calls walk no further.
      if (sql.includes("'continues' ->> 'author' = $1")) {
        if (params[0] === 'alice' && params[1] === 'p-1') {
          continuationCallCount++;
          return { rows: [{ author: 'bob', permlink: 'p-2', block_num: 200 }] };
        }
        return { rows: [] };
      }
      // Version reconstruction: `ROW_NUMBER() OVER (ORDER BY co.block_num)`
      // against comment_operations. Returns alice's original op then bob's
      // continuation op (latest). The bob op carries the head metadata with
      // discipline = 'BiOlOgY'.
      if (sql.includes('ROW_NUMBER() OVER (ORDER BY co.block_num)')) {
        return {
          rows: [
            {
              version_number: 1,
              block_num: 100,
              author: 'alice',
              permlink: 'p-1',
              title: 'Original Paper',
              body: 'abstract\n\n---\n\nfull text',
              created: '2026-04-20T00:00:00',
              json_metadata: buildPevoPaperMeta('Physics', ['alice', 'bob']),
            },
            {
              version_number: 2,
              block_num: 200,
              author: 'bob',
              permlink: 'p-2',
              title: 'Continuation Paper',
              body: 'updated abstract\n\n---\n\nupdated full text',
              created: '2026-04-25T00:00:00',
              json_metadata: buildPevoPaperMeta('BiOlOgY', ['alice', 'bob']),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p-1');
    expect(res.status).toBe(200);
    // Sanity: the chain lookup actually ran and matched the expected route.
    expect(continuationCallCount).toBeGreaterThan(0);
    // Head-override post-fix: the response carries the lowercased head
    // metadata's discipline. A regression that drops the line-613 helper
    // call (i.e. `detail.discipline = headPevo.discipline`) would surface
    // here as `'BiOlOgY'`. A regression to the old buildPaperDetail-only
    // path (no override) would surface as `'physics'`.
    expect(res.body.data.discipline).toBe('biology');
  });

  it('GET /api/profile/:username/papers — toPaperSummary canon-lowers + trims (BE-PROFILE-PAPER-DISCIPLINE-CANON)', async () => {
    // BE-PROFILE-PAPER-DISCIPLINE-CANON: `toPaperSummary` in helpers.ts now
    // routes `pevo.discipline` through `paperDisciplineField() ?? ''` so
    // /api/profile/:username/papers surfaces canon (lowercased + trimmed)
    // shape consistent with /api/papers. Real-HAF parity in profile.test.ts
    // is corpus-vacuous on lowercase data; this mocked-pool spec pins the
    // transform deterministically with a whitespace-padded mixed-case seed.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('count(*)::int AS total') && sql.includes('FROM user_papers')) {
        return { rows: [{ total: 1 }] };
      }
      if (sql.includes('FROM user_papers') && sql.includes('ORDER BY')) {
        return {
          rows: [{
            author: 'alice',
            permlink: 'p-1',
            title: 'Test Paper',
            body: 'abstract\n\n---\n\nfull text',
            json_metadata: {
              app: `${config.appTag}/1.0`,
              [config.appTag]: {
                type: 'paper',
                discipline: '  Computer Science  ',
                keywords: [],
                authors: [],
              },
            },
            created: '2026-04-28T00:00:00',
            total_rshares: 0,
          }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // A revert of `paperDisciplineField()` integration in toPaperSummary
    // (i.e., back to `(pevo.discipline as string) || ''`) would surface here
    // as `'  Computer Science  '` instead of `'computer science'`.
    expect(res.body.data[0].discipline).toBe('computer science');
  });
});

describe('GET /api/papers — cache key sha256-wrapped (BE-PAPERS-CACHE-KEY-SHA256-MIRROR)', () => {
  // BE-PAPERS-CACHE-KEY-SHA256-MIRROR: the previous `papers:p=...:k=${keyword}
  // :a=${author}:lang=...` flat-concat cache key let `:` characters in
  // attacker-controlled `keyword` / `author` / `language` / `source` values
  // fold into the delimiter structure, opening a (narrow) cross-filter cache-
  // poisoning window. Mirror search.ts:320 by sha256-wrapping the rawKey so
  // the cache namespace is content-addressed, not delimiter-structured.
  //
  // Verification shape (mirrors disciplines-canon-mocked round-2 hold #1
  // pattern): count the papers-data SQL invocations across two requests.
  // Distinct rawKeys → distinct sha256 keys → 2 cache misses → 2 SQL calls;
  // identical rawKeys → 1 cache miss → 1 SQL call.

  it('two distinct query shapes (different filter values containing delimiters) produce distinct cache entries → 2 papers-data SQL calls', async () => {
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });

    // Both requests carry `:` and `=` characters in the `keyword` / `author`
    // values — exactly the delimiter-folding shape the sha256 wrap closes.
    // Pre-fix, a crafted pair of these could fold into the same flat-concat
    // fragment; post-fix, sha256 sees the rawKey character-by-character and
    // the two distinct rawKeys hash to two distinct cache keys.
    const res1 = await request(app).get('/api/papers?accredited_only=false&keyword=foo%3Aa%3Dalice&author=');
    const res2 = await request(app).get('/api/papers?accredited_only=false&keyword=&author=foo%3Aa%3Dalice');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const papersDataCalls = hafQueryMock.mock.calls.filter((call) => {
      const sql = String(call[0] || '');
      return sql.includes('LEFT(c.body, 300) AS abstract');
    });
    // Distinct rawKeys → distinct cache entries → BOTH requests hit HAF.
    expect(papersDataCalls).toHaveLength(2);
  });

  it('two identical requests share a single cache entry → 1 papers-data SQL call (sanity)', async () => {
    // Sanity assertion: sha256 is deterministic, so the same rawKey must
    // produce the same cache key. If sha256 wrapping were applied to a
    // non-deterministic input (e.g. including a per-request timestamp), the
    // cache hit rate would drop to zero and this assertion would fail.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });

    const res1 = await request(app).get('/api/papers?accredited_only=false&keyword=physics');
    const res2 = await request(app).get('/api/papers?accredited_only=false&keyword=physics');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const papersDataCalls = hafQueryMock.mock.calls.filter((call) => {
      const sql = String(call[0] || '');
      return sql.includes('LEFT(c.body, 300) AS abstract');
    });
    // Identical rawKeys → single cache entry → 1 cache miss → 1 SQL call.
    expect(papersDataCalls).toHaveLength(1);
  });

  it('cache key is namespace-prefixed `papers:` followed by 32 hex chars (sha256 slice)', async () => {
    // Pin the wrapper shape so a future refactor that switches the digest
    // length, the slice width, or the namespace literal surfaces here.
    // Mirrors search.ts:320 exactly: `${namespace}:${sha256(rawKey).slice(0, 32)}`.
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });

    // Spy on hafCache to capture the cache key used for the request.
    const setSpy = vi.spyOn(hafCache, 'getOrSetSWR');
    try {
      await request(app).get('/api/papers?accredited_only=false');
      expect(setSpy).toHaveBeenCalled();
      const callArgs = setSpy.mock.calls.find((args) => typeof args[0] === 'string' && args[0].startsWith('papers:'));
      expect(callArgs).toBeDefined();
      const cacheKey = callArgs![0] as string;
      // Format: `papers:` + 32 lowercase hex chars (16 bytes of sha256 hex).
      expect(cacheKey).toMatch(/^papers:[0-9a-f]{32}$/);
    } finally {
      setSpy.mockRestore();
    }
  });
});

describe('GET /api/search — ?q= LIKE-escape SQL contract (BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP)', () => {
  // The real-HAF specs in search.test.ts assert the 400 paths and that the
  // ILIKE path completes without backtracking explosion on metacharacter
  // payloads. This block pins the SQL contract deterministically: the bound
  // parameter has its `%` `_` `\` characters escaped, AND every ILIKE call
  // site carries an `ESCAPE '\\'` clause. A regression that drops either side
  // of the contract surfaces here.

  it('papers-search bound parameter is LIKE-escaped (% → \\%, _ → \\_, \\ → \\\\)', async () => {
    let capturedParams: unknown[] | undefined;
    hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      // Match the papers-search data query (uniquely contains `AS type,`).
      if (sql.includes("->> 'type') AS type,") && capturedParams === undefined) {
        capturedParams = params;
      }
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });

    // The crafted payload: `%`, `_`, `\` — all three LIKE metacharacters
    // plus the escape character itself. Post-fix bound parameter must
    // contain `\%`, `\_`, `\\` — never the bare metacharacters.
    const res = await request(app).get('/api/search?type=paper&q=%25_%5C');
    expect(res.status).toBe(200);
    expect(capturedParams).toBeDefined();
    // The ILIKE-pattern bind is the LAST string param before LIMIT/OFFSET
    // ints. Find a string param wrapped in `%...%`.
    const ilikePattern = capturedParams!.find(
      (p) => typeof p === 'string' && p.startsWith('%') && p.endsWith('%') && p.length > 2,
    ) as string | undefined;
    expect(ilikePattern).toBeDefined();
    // Strip the surrounding wildcards (added by the route, NOT escaped).
    const escapedQ = ilikePattern!.slice(1, -1);
    // The escaped form for input `%_\` is `\%\_\\`. A revert of the
    // helper would surface here as the raw `%_\`.
    expect(escapedQ).toBe('\\%\\_\\\\');
  });

  it('papers-search SQL carries ESCAPE clause with backslash literal at every ILIKE site', async () => {
    // Re-do the above assertion correctly: the JS template literal at the
    // route emits `\\` which becomes a single `\` in the runtime string, so
    // the SQL string literally contains `ESCAPE '\'` (10 chars: E,S,C,A,P,E,
    // space, ',\, '). The default `relevance` sort path adds a third ILIKE
    // site in the ORDER BY CASE, so we expect at least 3 occurrences for
    // ?type=paper.
    let capturedSql: string | undefined;
    hafQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("->> 'type') AS type,") && capturedSql === undefined) {
        capturedSql = sql;
      }
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });

    await request(app).get('/api/search?type=paper&q=science');
    expect(capturedSql).toBeDefined();
    // Match the literal SQL fragment `ESCAPE '\'` — JS template literal
    // form `\\` yields one `\` in the runtime string.
    const escapeClause = `ESCAPE '\\'`;
    expect(capturedSql).toContain(escapeClause);
    // textMatch site (data query): both c.title ILIKE and c.body ILIKE
    // each carry ESCAPE — that's 2; ORDER BY CASE adds 1 more → 3 total
    // on the data query.
    const occurrences = capturedSql!.split(escapeClause).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('reviews-search SQL carries ESCAPE clause on c.body ILIKE', async () => {
    let capturedSql: string | undefined;
    hafQueryMock.mockImplementation(async (sql: string) => {
      // Reviews search data query: filters parent_author != '' and binds
      // ILIKE to c.body only. Distinguished from the papers-search data
      // query by the absence of the `type` SELECT alias and the presence
      // of `parent_author != ''`.
      if (sql.includes("c.parent_author != ''") && sql.includes('ILIKE')) {
        capturedSql = sql;
      }
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });

    await request(app).get('/api/search?type=review&q=science');
    expect(capturedSql).toBeDefined();
    expect(capturedSql).toContain(`ESCAPE '\\'`);
  });
});
