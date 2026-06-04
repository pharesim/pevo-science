/**
 * Citation-count inverted-CTE canary for the `/api/papers` listing.
 *
 * Background. The listing's citation count was a per-row correlated subquery:
 * for every output row it scanned the whole accredited-paper corpus and tested
 * `pevo.citations @> jsonb_build_array(jsonb_build_object('author', c.author,
 * 'permlink', c.permlink))`. The contained value was constructed per outer row,
 * defeating constant folding and any index, so a cold-cache page render ran N
 * independent full-corpus scans. The fix replaces it with a single
 * `paper_citation_counts` CTE that unnests every accredited paper's citations
 * ONCE, groups by the cited (author, permlink), and is LEFT JOINed onto the
 * page — one corpus scan per request.
 *
 * Two layers (mirroring the reputation-cycle canaries):
 *
 *   1. A source-level shape pin (always runs, no infra): asserts papers.ts
 *      carries the inverted CTE + LEFT JOIN and NO LONGER carries the per-row
 *      correlated containment. A revert to the correlated form fails red, and
 *      the load-bearing `jsonb_typeof(...) = 'array'` cascade-fail guard on the
 *      unnest is pinned (without it a non-array pevo.citations crashes the
 *      whole listing).
 *
 *   2. A synthetic-VALUES behavioral parity canary (real Postgres, skips when
 *      HAF is not configured): runs BOTH the old correlated shape and the new
 *      inverted-CTE shape over the same synthetic corpus and asserts identical
 *      counts, plus the specific properties the fix must preserve (accreditation
 *      gate, empty-citation = 0, duplicate-citation collapse, non-array guard
 *      does not raise).
 *
 * **Carve-out clause-(a) justification for layer 2:** seeding citing papers on
 * Hive, waiting for HAF indexing, and aligning the accredited set per test is
 * not a tractable integration-test shape; the public corpus may not contain a
 * duplicate-citation or non-array-citations paper at all. The synthetic-VALUES
 * query under `getPool()` (HAF pool URL, but standalone CTEs with no HAF schema
 * dependency) exercises the exact aggregate + LATERAL-unnest + LEFT-JOIN shape
 * the listing composes.
 * **Carve-out clause-(b):** this is a SQL-level computation canary, not a route
 * test. `verifyHiveSignature` and other auth middleware are not in scope and are
 * NOT mocked; real Postgres runs the arithmetic and only the rowset is synthetic.
 * **Carve-out clause-(c) real-path companion:** the listing runs the production
 * CTE against real HAF in the route-level papers tests; the risk class pinned
 * here (count parity old↔new across edge shapes the public corpus cannot be
 * guaranteed to contain) is what the real-path coverage cannot exercise.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPool, isHafConfigured } from '../../src/db.js';

const PROJECT_ROOT = resolve(__dirname, '../..');

describe('citation count inverted CTE — source-level shape pin', () => {
  const source = readFileSync(resolve(PROJECT_ROOT, 'src/routes/papers.ts'), 'utf-8');

  it('listing uses the paper_citation_counts CTE and LEFT JOIN, not a per-row correlated subquery', () => {
    expect(source, 'paper_citation_counts CTE must be defined in the listing query').toContain(
      'paper_citation_counts AS (',
    );
    expect(
      source,
      'the page must LEFT JOIN the citation-count CTE on the cited (author, permlink)',
    ).toContain('LEFT JOIN paper_citation_counts pcc ON pcc.cited_author = c.author AND pcc.cited_permlink = c.permlink');
    expect(source, 'citation_count must be sourced from the joined CTE column').toContain(
      'COALESCE(pcc.citation_count, 0) AS citation_count',
    );
  });

  it('the per-row correlated @> containment is gone (regression-revert tripwire)', () => {
    // The pre-fix form constructed the contained object from the OUTER row
    // (c.author / c.permlink). Its presence anywhere in papers.ts would mean the
    // listing still scans the corpus per row.
    expect(
      source,
      'the per-row correlated containment must not reappear in the listing path',
    ).not.toContain(`@> jsonb_build_array(jsonb_build_object('author', c.author, 'permlink', c.permlink))`);
  });

  it('the unnest carries the non-array cascade-fail guard', () => {
    // Without the array guard, a chain post with a non-array pevo.citations
    // makes jsonb_array_elements raise "cannot extract elements from a scalar"
    // and fails the entire listing.
    expect(source, 'paper_citation_counts must guard the citations unnest with a jsonb_typeof array check').toContain(
      `'citations') = 'array'`,
    );
    expect(source, 'paper_citation_counts must fall back to an empty array on a non-array citations field').toContain(
      `ELSE '[]'::jsonb`,
    );
  });
});

describe('citation count inverted CTE — synthetic-VALUES behavioral parity', () => {
  it.skipIf(!isHafConfigured())(
    'new inverted CTE matches the old correlated count exactly across accreditation, empty, duplicate, and non-array shapes',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // Synthetic citing-paper corpus (`ci`) + accredited set (`aa`) + the page
      // of target papers whose counts we render (`page`). Metadata is inlined as
      // jsonb literals keyed under the test appTag 'pevotest'.
      //   c1 (accredited): cites alice/paper-A AND bob/paper-B
      //   c2 (accredited): cites alice/paper-A
      //   c3 (UNACCREDITED): cites bob/paper-B  → must be excluded by the aa join
      //   c4 (accredited): cites dave/paper-D TWICE → must count dave once
      //   c5 (accredited): citations is a STRING (non-array) → must not crash; 0
      // Expected: alice=2, bob=1, carol=0 (uncited), dave=1, erin=0 (only the
      // non-array citer "referenced" anything near erin, and it contributes 0).
      const corpus = `
        ci(author, permlink, json_metadata) AS (
          VALUES
            ('citer1'::text, 'c1'::text, '{"pevotest":{"type":"paper","citations":[{"author":"alice","permlink":"paper-A"},{"author":"bob","permlink":"paper-B"}]}}'::jsonb),
            ('citer2'::text, 'c2'::text, '{"pevotest":{"type":"paper","citations":[{"author":"alice","permlink":"paper-A"}]}}'::jsonb),
            ('citer3'::text, 'c3'::text, '{"pevotest":{"type":"paper","citations":[{"author":"bob","permlink":"paper-B"}]}}'::jsonb),
            ('citer4'::text, 'c4'::text, '{"pevotest":{"type":"paper","citations":[{"author":"dave","permlink":"paper-D"},{"author":"dave","permlink":"paper-D"}]}}'::jsonb),
            ('citer5'::text, 'c5'::text, '{"pevotest":{"type":"paper","citations":"not-an-array"}}'::jsonb)
        ),
        aa(account) AS (
          VALUES ('citer1'::text), ('citer2'::text), ('citer4'::text), ('citer5'::text)
        ),
        page(author, permlink) AS (
          VALUES
            ('alice'::text, 'paper-A'::text),
            ('bob'::text,   'paper-B'::text),
            ('carol'::text, 'paper-C'::text),
            ('dave'::text,  'paper-D'::text),
            ('erin'::text,  'paper-E'::text)
        )`;

      // OLD shape: per-row correlated @> containment (the pre-fix listing form).
      const oldSql = `
        WITH ${corpus}
        SELECT page.author, page.permlink,
          COALESCE((
            SELECT count(*)::int FROM ci
            JOIN aa ON aa.account = ci.author
            WHERE (ci.json_metadata -> $1 ->> 'type') = 'paper'
              AND ci.json_metadata -> $1 -> 'citations' @> jsonb_build_array(jsonb_build_object('author', page.author, 'permlink', page.permlink))
          ), 0) AS citation_count
        FROM page
        ORDER BY page.author
      `;

      // NEW shape: the inverted paper_citation_counts CTE + LEFT JOIN, verbatim
      // modulo the synthetic table substitutions.
      const newSql = `
        WITH ${corpus},
        paper_citation_counts AS (
          SELECT cited_author, cited_permlink, count(*)::int AS citation_count
          FROM (
            SELECT DISTINCT
              ci.author AS citing_author,
              ci.permlink AS citing_permlink,
              cit ->> 'author' AS cited_author,
              cit ->> 'permlink' AS cited_permlink
            FROM ci
            JOIN aa ON aa.account = ci.author
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(ci.json_metadata -> $1 -> 'citations') = 'array'
                THEN ci.json_metadata -> $1 -> 'citations'
                ELSE '[]'::jsonb
              END
            ) cit
            WHERE (ci.json_metadata -> $1 ->> 'type') = 'paper'
              AND jsonb_typeof(cit) = 'object'
              AND cit ->> 'author' IS NOT NULL
              AND cit ->> 'permlink' IS NOT NULL
          ) deduped
          GROUP BY cited_author, cited_permlink
        )
        SELECT page.author, page.permlink, COALESCE(pcc.citation_count, 0) AS citation_count
        FROM page
        LEFT JOIN paper_citation_counts pcc ON pcc.cited_author = page.author AND pcc.cited_permlink = page.permlink
        ORDER BY page.author
      `;

      const oldRes = await pool.query<{ author: string; citation_count: number }>(oldSql, ['pevotest']);
      const newRes = await pool.query<{ author: string; citation_count: number }>(newSql, ['pevotest']);

      const oldCounts = new Map(oldRes.rows.map((r) => [r.author, Number(r.citation_count)]));
      const newCounts = new Map(newRes.rows.map((r) => [r.author, Number(r.citation_count)]));

      // Parity: the inverted CTE reproduces the correlated count for every row.
      expect([...newCounts.entries()].sort()).toEqual([...oldCounts.entries()].sort());

      // Explicit expectations the fix must preserve.
      expect(newCounts.get('alice'), 'two distinct accredited citers → 2').toBe(2);
      expect(newCounts.get('bob'), 'one accredited citer; the unaccredited citer is excluded → 1').toBe(1);
      expect(newCounts.get('carol'), 'uncited paper → 0 (LEFT JOIN NULL → COALESCE 0)').toBe(0);
      expect(newCounts.get('dave'), 'one citer listing the same citation twice → counted once').toBe(1);
      expect(newCounts.get('erin'), 'non-array citations citer contributes nothing and does not raise → 0').toBe(0);
    },
  );
});
