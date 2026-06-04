/**
 * Load-bearing canary (BACKEND-SELF-REVIEW-EXCLUSION round-1 hold #4):
 * a self-5/5/5/5 review MUST NOT inflate `paper_reviews.quality` in the
 * reputation cycle.
 *
 * The task acceptance criteria call this out as "the most consequential
 * canary because the path-of-impact is via the quality multiplier, not
 * the reviewer's own rep score". The `paper_scores` CTE multiplies the
 * paper's vote-derived score by `COALESCE(pr.quality, 1.0)` at
 * `reputation.ts:644`, so a self-5/5/5/5 pushes the multiplier to its
 * 1.0 ceiling — the author's reputation receives the full vote-derived
 * score amplified by the self-graded quality.
 *
 * The behavioral matrix in `hafsql.test.ts` tests the helper's predicate
 * output in isolation. The parity-invariant test in
 * `review-parity-invariant.test.ts` tests the predicate-Set equality
 * between display and reputation. Neither pins that the actual
 * `AVG((m+n+c+s)/4)/5` computation in the `paper_reviews` CTE excludes
 * self-rows. This canary fills that gap.
 *
 * **Carve-out clause-(c) justification:** Synthetic-VALUES against real
 * Postgres (no `${T.comments}` substitution per-test).
 *   (a) Real path that's impractical: seeding a real paper on Hive +
 *       waiting for HAF indexing + broadcasting a self-5/5/5/5 review +
 *       an accredited third-party 3/3/3/3 review per test is not a
 *       tractable integration-test shape; the public corpus may not
 *       contain a self-review at all.
 *   (b) `verifyHiveSignature` is NOT mocked (this is a SQL-level
 *       computation test, not a route test). Real Postgres runs the
 *       arithmetic; only the rowset is substituted.
 *   (c) Real-path companion: `review-parity-invariant.test.ts` covers
 *       the predicate-Set equality between display and reputation paths
 *       against the real HAF corpus (when a qualifying paper is
 *       available). The risk class pinned here is the
 *       AVG/5 arithmetic at the CTE level — orthogonal to the
 *       set-equality risk class.
 */
import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../../src/db.js';
import { validReviewWhere, excludeSelfReviewWhere } from '../../src/hafsql.js';

describe('paper_reviews self-exclusion canary (synthetic-VALUES)', () => {
  it.skipIf(!isHafConfigured())(
    'self-5/5/5/5 does NOT inflate AVG; third-party 3/3/3/3 yields quality = 0.6',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // Synthetic paper: alice authored, bob is a named co-author.
      // Synthetic reviews:
      //   - alice self-5/5/5/5  (paper author — must be excluded)
      //   - bob   self-5/5/5/5  (named co-author — must be excluded)
      //   - carol third-party 3/3/3/3  (must contribute to AVG)
      const paperMeta = JSON.stringify({
        pevotest: {
          type: 'paper',
          authors: [{ name: 'Alice', hive: 'alice' }, { name: 'Bob', hive: 'bob' }],
        },
      });
      const fiveRating = JSON.stringify({
        pevotest: { type: 'review', rating: { methodology: 5, novelty: 5, clarity: 5, significance: 5 } },
        app: 'pevotest/test',
      });
      const threeRating = JSON.stringify({
        pevotest: { type: 'review', rating: { methodology: 3, novelty: 3, clarity: 3, significance: 3 } },
        app: 'pevotest/test',
      });

      // Mirror the `paper_reviews` CTE shape from reputation.ts:616-629
      // — same AVG-of-ratings-/-5.0 expression, same validReviewWhere +
      // excludeSelfReviewWhere predicates, same accreditation gate
      // shape (array + anon scalar). Only `${T.comments}` is
      // substituted with a synthetic CTE. Param indexes are renumbered
      // contiguously from $1 (the production CTE's $2/$3/$18 indexing
      // belongs to its 20-param signature; this canary doesn't mirror
      // those positions).
      const sql = `
        WITH up(author, permlink, json_metadata) AS (
          VALUES ('alice'::text, 'paper-1'::text, $2::jsonb)
        ),
        c(author, permlink, parent_author, parent_permlink, json_metadata) AS (
          VALUES
            ('alice'::text, 'rev-alice-self'::text, 'alice'::text, 'paper-1'::text, $3::jsonb),
            ('bob'::text,   'rev-bob-self'::text,   'alice'::text, 'paper-1'::text, $3::jsonb),
            ('carol'::text, 'rev-carol-tp'::text,   'alice'::text, 'paper-1'::text, $4::jsonb)
        )
        SELECT up.author, up.permlink,
          AVG(
            ((c.json_metadata -> $1 -> 'rating' ->> 'methodology')::numeric +
             (c.json_metadata -> $1 -> 'rating' ->> 'novelty')::numeric +
             (c.json_metadata -> $1 -> 'rating' ->> 'clarity')::numeric +
             (c.json_metadata -> $1 -> 'rating' ->> 'significance')::numeric) / 4.0
          ) / 5.0 AS quality
        FROM up
        JOIN c
          ON c.parent_author = up.author AND c.parent_permlink = up.permlink
          AND ${validReviewWhere({ commentAlias: 'c', appTagParam: '$1' })}
          AND ${excludeSelfReviewWhere({ commentAlias: 'c', paperRowAlias: 'up', appTagParam: '$1' })}
          AND (c.author = ANY($5::text[]) OR c.author = $6)
        GROUP BY up.author, up.permlink
      `;
      const accredited = ['alice', 'bob', 'carol'];
      const anonAccount = 'eve.anon';
      const result = await pool.query(sql, [
        'pevotest',  // $1 = appTag
        paperMeta,   // $2
        fiveRating,  // $3
        threeRating, // $4
        accredited,  // $5
        anonAccount, // $6
      ]);

      expect(result.rows.length).toBe(1);
      const quality = Number(result.rows[0].quality);
      // Third-party-only AVG: (3+3+3+3)/4 = 3.0; /5.0 = 0.6 exactly.
      // Without self-exclusion the AVG would be:
      //   alice:5, bob:5, carol:3 → AVG(5,5,3)/5.0 = (13/3)/5.0 ≈ 0.867
      // This canary fails red on either revert (helper-level revert OR
      // a future maintainer composing the helper without the predicate).
      expect(quality).toBeCloseTo(0.6, 5);
      expect(quality).toBeLessThan(0.7); // explicit "not inflated" floor
    },
  );
});
