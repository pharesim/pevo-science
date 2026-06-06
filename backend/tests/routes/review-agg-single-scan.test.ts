/**
 * Review-count + avg-rating single-scan canary for the `/api/papers` listing.
 *
 * Background. The listing computed `review_count` and `avg_rating` in two
 * independent per-row correlated subqueries that BOTH scanned the same
 * accredited-review row set under the same predicate (parent-pair match +
 * validReviewWhere type/shape gate + excludeSelfReviewWhere + accreditation/anon
 * gate). A 20-row page therefore issued two accredited-review scans per row.
 * The fix collapses them into ONE `LEFT JOIN LATERAL (...) ON true` subquery
 * (`rev_agg`) that returns both aggregates from a single scan of the gated rows,
 * halving the review-table scans per page row. The vote arm (`net_votes` /
 * `sort=votes`) is untouched by the merge, so sort=votes ordering is preserved.
 *
 * Two layers (mirroring the citation-count inverted-CTE canary):
 *
 *   1. A source-level shape pin (always runs, no infra): asserts papers.ts now
 *      sources BOTH aggregates from the single `rev_agg` LATERAL and NO LONGER
 *      carries two separate correlated review subqueries. A revert to the
 *      two-scan form fails red.
 *
 *   2. A synthetic-VALUES behavioral parity canary (real Postgres, skips when
 *      HAF is not configured): runs BOTH the old two-subquery shape and the new
 *      single-LATERAL shape over the same synthetic review corpus and asserts
 *      identical (review_count, avg_rating) per page row, plus the properties the
 *      merge must preserve (accreditation gate, anon-account inclusion,
 *      self-review exclusion, zero-review degradation to 0/0, and page-ordering
 *      stability so sort=votes ordering is not perturbed).
 *
 * **Carve-out clause-(a) justification for layer 2:** seeding accredited and
 * self/anon review replies on Hive, waiting for HAF indexing, and aligning the
 * accredited set per test is not a tractable integration-test shape; the public
 * corpus is not guaranteed to contain a paper with the precise mix of accredited
 * + self + anon + unaccredited reviews this parity check needs. The
 * synthetic-VALUES query under `getPool()` (HAF pool URL, but standalone CTEs
 * with no HAF schema dependency) exercises the exact count(*) + avg + LATERAL +
 * COALESCE shape the listing composes.
 * **Carve-out clause-(b):** this is a SQL-level computation canary, not a route
 * test. `verifyHiveSignature` and other auth middleware are not in scope and are
 * NOT mocked; real Postgres runs the arithmetic and only the rowset is synthetic.
 * **Carve-out clause-(c) real-path companion:** the listing runs the production
 * merged LATERAL against real HAF in the route-level papers tests
 * (`papers.test.ts` exercises `/api/papers` and asserts the `review_count` /
 * `avg_rating` envelope fields); the risk class pinned here (count+avg parity
 * old↔new across accreditation/self/anon/zero edge shapes the public corpus
 * cannot be guaranteed to contain, plus ordering stability) is what the
 * real-path coverage cannot exercise deterministically.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPool, isHafConfigured } from '../../src/db.js';
import { validReviewWhere, excludeSelfReviewWhere } from '../../src/hafsql.js';

const PROJECT_ROOT = resolve(__dirname, '../..');

describe('review aggregate single scan — source-level shape pin', () => {
  const source = readFileSync(resolve(PROJECT_ROOT, 'src/routes/papers.ts'), 'utf-8');

  it('both review_count and avg_rating are sourced from the single rev_agg LATERAL', () => {
    expect(
      source,
      'review_count must be sourced from the joined rev_agg LATERAL column',
    ).toContain('COALESCE(rev_agg.review_count, 0) AS review_count');
    expect(
      source,
      'avg_rating must be sourced from the joined rev_agg LATERAL column',
    ).toContain('COALESCE(rev_agg.avg_rating, 0) AS avg_rating');
    expect(
      source,
      'the merged aggregate must come from one LEFT JOIN LATERAL keyed on the page row',
    ).toContain('LEFT JOIN LATERAL (');
    expect(
      source,
      'the LATERAL subquery must compute both aggregates over one accredited-review scan',
    ).toContain('count(*)::int AS review_count');
  });

  it('the two independent correlated review subqueries are gone (regression-revert tripwire)', () => {
    // The pre-fix form ran two separate correlated subqueries: a standalone
    // `SELECT count(*)::int FROM hafsql.comments r` for the count and a
    // derived-table `... FROM hafsql.comments rv ... ) sub` for the average,
    // each re-scanning the same review row set. Their presence would mean the
    // listing still double-scans the accredited-review rows per page row.
    expect(
      source,
      'the standalone count(*) correlated review subquery (the pre-merge count arm) must not reappear',
    ).not.toContain('SELECT count(*)::int FROM hafsql.comments r');
    expect(
      source,
      'the separate avg-rating correlated subquery (rv alias) must not reappear',
    ).not.toContain('FROM hafsql.comments rv');
    expect(
      source,
      'the avg-rating derived-table wrapper alias `sub` from the two-subquery form must be gone',
    ).not.toContain(') sub');
    expect(
      source,
      'the old two-arm select interpolation (separate reviewCountSelect / avgRatingSelect) must be gone',
    ).not.toContain('${reviewCountSelect}');
  });
});

describe('review aggregate single scan — synthetic-VALUES behavioral parity', () => {
  it.skipIf(!isHafConfigured())(
    'merged LATERAL matches the old two-subquery review_count + avg_rating exactly, with accreditation/anon/self/zero edges and stable ordering',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // Synthetic review corpus (`rv`) + accredited set (`aa`) + the page of
      // target papers whose aggregates we render (`page`). Metadata is inlined as
      // jsonb literals keyed under the test appTag 'pevotest'. The anon posting
      // account is bound as $2.
      //
      // Reviews on alice/paper-A:
      //   acc1 (accredited): 5/5/5/5 → val 5.0
      //   acc2 (accredited): 1/1/1/1 → val 1.0
      //   unacc (UNACCREDITED): 5/5/5/5 → excluded by the accreditation gate
      //   anonacct (= $2, not accredited): 3/3/3/3 → val 3.0 (anon arm includes it)
      //   alice (SELF, accredited): 5/5/5/5 → excluded by excludeSelfReviewWhere
      //   acc1 (accredited, SECOND review): 5/5/5/5 → val 5.0; counted AGAIN
      //     (count(*) carries NO DISTINCT, so a reviewer reviewing twice counts
      //     twice — this row pins that no-DISTINCT semantics)
      //   acc2 (accredited, MALFORMED rating): methodology '6' (out of [1-5]) →
      //     excluded by validReviewWhere's `~ '^[1-5]$'` gate, which must run
      //     BEFORE the `::float` casts in both shapes (a '6' would cast fine but
      //     is semantically out of range; the gate also stops a non-numeric value
      //     from reaching `::float` and raising). This row pins the gate.
      //   → review_count = 4 (acc1, acc2, anon, acc1-again); unaccredited, self,
      //     and malformed excluded; avg = round((5+1+3+5)/4,1) = 3.5
      //
      // Reviews on bob/paper-B:
      //   acc1 (accredited): 4/4/4/2 → val 3.5  → count 1, avg 3.5
      //
      // carol/paper-C: no reviews → count 0, avg 0 (COALESCE degradation).
      const corpus = `
        rv(author, permlink, parent_author, parent_permlink, json_metadata) AS (
          VALUES
            ('acc1'::text, 'r1'::text, 'alice'::text, 'paper-A'::text, '{"pevotest":{"type":"review","rating":{"methodology":"5","novelty":"5","clarity":"5","significance":"5"}}}'::jsonb),
            ('acc2'::text, 'r2'::text, 'alice'::text, 'paper-A'::text, '{"pevotest":{"type":"review","rating":{"methodology":"1","novelty":"1","clarity":"1","significance":"1"}}}'::jsonb),
            ('unacc'::text, 'r3'::text, 'alice'::text, 'paper-A'::text, '{"pevotest":{"type":"review","rating":{"methodology":"5","novelty":"5","clarity":"5","significance":"5"}}}'::jsonb),
            ('anonacct'::text, 'r4'::text, 'alice'::text, 'paper-A'::text, '{"pevotest":{"type":"review","rating":{"methodology":"3","novelty":"3","clarity":"3","significance":"3"}}}'::jsonb),
            ('alice'::text, 'r5'::text, 'alice'::text, 'paper-A'::text, '{"pevotest":{"type":"review","rating":{"methodology":"5","novelty":"5","clarity":"5","significance":"5"}}}'::jsonb),
            ('acc1'::text, 'r7'::text, 'alice'::text, 'paper-A'::text, '{"pevotest":{"type":"review","rating":{"methodology":"5","novelty":"5","clarity":"5","significance":"5"}}}'::jsonb),
            ('acc2'::text, 'r8'::text, 'alice'::text, 'paper-A'::text, '{"pevotest":{"type":"review","rating":{"methodology":"6","novelty":"5","clarity":"5","significance":"5"}}}'::jsonb),
            ('acc1'::text, 'r6'::text, 'bob'::text, 'paper-B'::text, '{"pevotest":{"type":"review","rating":{"methodology":"4","novelty":"4","clarity":"4","significance":"2"}}}'::jsonb)
        ),
        aa(account) AS (
          VALUES ('acc1'::text), ('acc2'::text), ('alice'::text)
        ),
        page(author, permlink, net_votes, json_metadata) AS (
          VALUES
            ('alice'::text, 'paper-A'::text, 7::int, '{"pevotest":{"type":"paper"}}'::jsonb),
            ('bob'::text,   'paper-B'::text, 3::int, '{"pevotest":{"type":"paper"}}'::jsonb),
            ('carol'::text, 'paper-C'::text, 9::int, '{"pevotest":{"type":"paper"}}'::jsonb)
        )`;

      // The shared review-row predicate, parameterized: $1 = appTag, $2 = anon.
      // Composed from the SAME production helpers the listing's rev_agg LATERAL
      // uses — validReviewWhere (type + rating-shape regex) and
      // excludeSelfReviewWhere (self/co-author exclusion) — so a change to either
      // helper turns this canary red (it must not silently diverge from the
      // listing's predicate). The parent-pair match and accreditation/anon gate
      // stay inline here EXACTLY as papers.ts wraps them around the helpers in the
      // rev_agg LATERAL. excludeSelfReviewWhere's co-author arm is inert here (the
      // synthetic `page` rows carry no pevo.authors[], so the array guard yields
      // an empty set); the paper-author self-exclusion arm IS exercised (alice's
      // own r5 review). The helpers reference the review under `${alias}` and the
      // paper row under `page`.
      const reviewWhere = (alias: string) => `
        ${alias}.parent_author = page.author AND ${alias}.parent_permlink = page.permlink
        AND ${validReviewWhere({ commentAlias: alias, appTagParam: '$1' })}
        AND ${excludeSelfReviewWhere({ commentAlias: alias, paperRowAlias: 'page', appTagParam: '$1' })}
        AND (EXISTS (SELECT 1 FROM aa WHERE aa.account = ${alias}.author) OR ${alias}.author = $2)`;

      const ratingMean = (alias: string) => `(
        (${alias}.json_metadata -> $1 -> 'rating' ->> 'methodology')::float +
        (${alias}.json_metadata -> $1 -> 'rating' ->> 'novelty')::float +
        (${alias}.json_metadata -> $1 -> 'rating' ->> 'clarity')::float +
        (${alias}.json_metadata -> $1 -> 'rating' ->> 'significance')::float
      ) / 4.0`;

      // OLD shape: two independent correlated subqueries over the same rows.
      const oldSql = `
        WITH ${corpus}
        SELECT page.author, page.permlink,
          COALESCE((
            SELECT count(*)::int FROM rv r WHERE ${reviewWhere('r')}
          ), 0) AS review_count,
          COALESCE((
            SELECT round(avg(val)::numeric, 1)::float FROM (
              SELECT ${ratingMean('rv2')} AS val
              FROM rv rv2 WHERE ${reviewWhere('rv2')}
            ) sub
          ), 0) AS avg_rating
        FROM page
        ORDER BY page.net_votes DESC
      `;

      // NEW shape: one LEFT JOIN LATERAL returning both aggregates, verbatim
      // modulo the synthetic table substitutions.
      const newSql = `
        WITH ${corpus}
        SELECT page.author, page.permlink,
          COALESCE(rev_agg.review_count, 0) AS review_count,
          COALESCE(rev_agg.avg_rating, 0) AS avg_rating
        FROM page
        LEFT JOIN LATERAL (
          SELECT
            count(*)::int AS review_count,
            round(avg(${ratingMean('r')})::numeric, 1)::float AS avg_rating
          FROM rv r WHERE ${reviewWhere('r')}
        ) rev_agg ON true
        ORDER BY page.net_votes DESC
      `;

      type Row = { author: string; review_count: number; avg_rating: number };
      const oldRes = await pool.query<Row>(oldSql, ['pevotest', 'anonacct']);
      const newRes = await pool.query<Row>(newSql, ['pevotest', 'anonacct']);

      const key = (r: Row) => [r.author, Number(r.review_count), Number(r.avg_rating)] as const;
      const oldByAuthor = new Map(oldRes.rows.map((r) => [r.author, key(r)]));
      const newByAuthor = new Map(newRes.rows.map((r) => [r.author, key(r)]));

      // Parity: the merged LATERAL reproduces both aggregates for every row.
      expect([...newByAuthor.values()].sort()).toEqual([...oldByAuthor.values()].sort());

      // Ordering stability: the merge must NOT perturb page ordering. Both
      // queries ORDER BY net_votes DESC (the listing's sort=votes ordering key);
      // the LATERAL join is row-preserving so the order is identical. This is
      // the sort=votes acceptance criterion expressed at the SQL level.
      expect(
        newRes.rows.map((r) => r.author),
        'merged LATERAL must preserve the net_votes DESC row order (sort=votes parity)',
      ).toEqual(oldRes.rows.map((r) => r.author));
      expect(newRes.rows.map((r) => r.author)).toEqual(['carol', 'alice', 'bob']);

      // Explicit expectations the merge must preserve.
      const alice = newByAuthor.get('alice')!;
      expect(
        alice[1],
        'acc1 (twice — no DISTINCT), acc2, and anon counted; unaccredited, self, and malformed-rating excluded → 4',
      ).toBe(4);
      expect(alice[2], 'mean of vals 5.0, 1.0, 3.0, 5.0 → round(14/4,1) = 3.5').toBe(3.5);

      const bob = newByAuthor.get('bob')!;
      expect(bob[1], 'one accredited review → 1').toBe(1);
      expect(bob[2], '(4+4+4+2)/4 = 3.5 → round(3.5,1) = 3.5').toBe(3.5);

      const carol = newByAuthor.get('carol')!;
      expect(carol[1], 'no reviews → count 0').toBe(0);
      expect(carol[2], 'no reviews → avg COALESCE-degrades to 0').toBe(0);
    },
  );
});
