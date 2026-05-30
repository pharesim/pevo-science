/**
 * Co-author voter exclusion canary for the `citing_paper_quality` CTE's
 * `weighted_upvotes` term in the reputation cycle.
 *
 * Background. `weighted_upvotes` feeds `LEAST(weighted_upvotes, 1.0)` into the
 * cited author's `citation_value`. Before this defense the FILTER excluded only
 * the citing author by byte-equality (`clv.voter != cp.citing_author`); it did
 * NOT exclude co-authors listed in the citing paper's `pevo.authors[].hive`. A
 * citing-paper author who lists a confederate in `authors[]` and has the
 * confederate upvote the citing paper would inflate that term, boosting the
 * cited author's reputation for free. The sibling `paper_resolved_votes` CTE
 * already excludes co-authors with a canonicalizing `NOT EXISTS`; this brings
 * `citing_paper_quality` to the same defense.
 *
 * The byte-equality `clv.voter != cp.citing_author` is RETAINED alongside the
 * new `NOT EXISTS`, exactly as `paper_resolved_votes` retains
 * `plv.voter != up.author` alongside its `NOT EXISTS`. The two conjuncts cover
 * different cases: the canonicalizing `NOT EXISTS` catches co-authors (and the
 * author when present in `authors[]`, including case-variant entries), while
 * the byte-equality still excludes the author's OWN upvote in the cases the
 * `NOT EXISTS` cannot see — a citing paper that omits its author from
 * `authors[]`, or broadcasts a malformed/non-array `authors` that the inner
 * CASE-WHEN guard collapses to `'[]'`. Dropping the byte-equality would
 * re-admit the author's self-vote in those cases (verified against real
 * Postgres in the synthetic-VALUES behavioral canary below).
 *
 * This file has two layers, mirroring the defense-in-depth approach used by
 * `excludeSelfReviewWhere-callsite-canaries.test.ts` and the load-bearing
 * `reputation-paper-reviews-self-exclusion-canary.test.ts`:
 *
 *   1. A source-level shape pin (always runs, no infrastructure): asserts the
 *      co-author canonicalization (jsonb_typeof object guard + LOWER(TRIM(...))
 *      + the `^[a-z0-9.-]+$` charset regex + `= clv.voter`) is present in the
 *      citing path of `reputation.ts`, and that those canonicalization tokens
 *      match the `paper_resolved_votes` shape exactly. A regression that drops
 *      the canonicalization, or diverges it from the sibling, fails red.
 *
 *   2. A synthetic-VALUES behavioral canary (real Postgres, skips when HAF is
 *      not configured) that proves a confederate listed in
 *      `citing.pevo.authors[].hive` does not contribute to `weighted_upvotes`,
 *      and that the citing author's own upvote is still excluded even when the
 *      author is absent from `authors[]`.
 *
 * **Carve-out clause-(a) justification for layer 2:** Seeding a real citing
 * paper on Hive, waiting for HAF indexing, broadcasting a confederate upvote,
 * and aligning the cycle block window per test is not a tractable
 * integration-test shape; the public corpus may not contain a confederate
 * co-author self-upvote at all. The synthetic-VALUES query under `getPool()`
 * (HAF pool URL, but a standalone query against synthetic CTEs with no HAF
 * schema dependency) exercises the exact aggregate-FILTER + canonicalizing
 * NOT EXISTS shape the cycle composes, which is the defense under test.
 *
 * **Carve-out clause-(b):** This is a SQL-level computation canary, not a route
 * test. `verifyHiveSignature` and other auth/permission middleware are not in
 * scope here and are NOT mocked; real Postgres runs the arithmetic and only the
 * rowset is substituted.
 *
 * **Carve-out clause-(c) real-path companion:** the reputation cycle runs the
 * full `citing_paper_quality` CTE against real HAF in the lifecycle/batch
 * reputation tests; those exercise the post-fix shape end-to-end on real chain
 * rows. The risk class pinned here (a co-author upvote inflating the citation
 * term, which the real corpus cannot be guaranteed to contain) is the same
 * class the real-path coverage cannot exercise without seeding a confederate
 * upvote on a chain paper.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPool, isHafConfigured } from '../../src/db.js';

const PROJECT_ROOT = resolve(__dirname, '../..');

/**
 * Canonicalization tokens shared by `paper_resolved_votes` and
 * `citing_paper_quality`. These are the broadcaster-controlled-author
 * normalization steps the task requires to match between the two CTEs:
 * the SRF array guard, the empty-array fallback, the inner object guard, the
 * charset regex, and the LOWER(TRIM(...)) wrapping. The voter alias differs
 * between the two CTEs (`plv.voter` vs `clv.voter`), so the byte-equality
 * tail is asserted separately per CTE.
 */
const CANONICALIZATION_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['SRF array guard', `jsonb_typeof(`],
  ['empty-array fallback', `ELSE '[]'::jsonb`],
  ['inner object guard', `jsonb_typeof(a) = 'object'`],
  ['charset regex', `LOWER(TRIM(a ->> 'hive')) ~ '^[a-z0-9.-]+$'`],
];

describe('citing_paper_quality co-author voter exclusion — source-level shape pin', () => {
  const source = readFileSync(resolve(PROJECT_ROOT, 'src/reputation.ts'), 'utf-8');

  /**
   * Extract the `citing_paper_quality` CTE body so the assertions below are
   * scoped to the citing path and cannot be satisfied by the sibling
   * `paper_resolved_votes` block (which contains the same tokens). Anchor on
   * the stable CTE label and the next CTE label that follows it.
   */
  function citingPaperQualityBlock(src: string): string {
    const start = src.indexOf('citing_paper_quality AS (');
    expect(start, 'citing_paper_quality CTE not found in reputation.ts').toBeGreaterThanOrEqual(0);
    const after = src.indexOf('citation_scores AS (', start);
    expect(after, 'citation_scores CTE (block terminator) not found after citing_paper_quality').toBeGreaterThan(start);
    return src.slice(start, after);
  }

  it('weighted_upvotes FILTER carries the canonicalizing co-author NOT EXISTS', () => {
    const block = citingPaperQualityBlock(source);
    // The exclusion lives inside the weighted_upvotes aggregate FILTER.
    expect(block, 'citing_paper_quality must compute weighted_upvotes').toContain('AS weighted_upvotes');
    expect(
      block,
      'weighted_upvotes FILTER must carry a co-author NOT EXISTS over the citing paper authors[]',
    ).toContain('NOT EXISTS (');
    // The NOT EXISTS iterates the citing paper metadata authors[] (cp.citing_meta).
    expect(
      block,
      'co-author NOT EXISTS must read the citing paper authors[] from cp.citing_meta',
    ).toContain(`cp.citing_meta -> $3 -> 'authors'`);
  });

  for (const [label, token] of CANONICALIZATION_TOKENS) {
    it(`citing path includes the ${label} canonicalization token`, () => {
      const block = citingPaperQualityBlock(source);
      expect(block, `citing_paper_quality co-author exclusion missing ${label}: ${token}`).toContain(token);
    });
  }

  it('co-author NOT EXISTS canonicalizes against the citing-vote voter (clv.voter)', () => {
    const block = citingPaperQualityBlock(source);
    expect(
      block,
      'co-author exclusion must byte-equal the canonicalized author against the chain-validated voter clv.voter',
    ).toContain(`LOWER(TRIM(a ->> 'hive')) = clv.voter`);
  });

  it('retains the byte-equality author exclusion alongside the NOT EXISTS', () => {
    const block = citingPaperQualityBlock(source);
    // The byte-equality is NOT subsumed by the NOT EXISTS: it covers the
    // author's own upvote when the citing paper omits its author from
    // authors[] or broadcasts a malformed authors field.
    expect(
      block,
      'weighted_upvotes FILTER must retain clv.voter != cp.citing_author',
    ).toContain('clv.voter != cp.citing_author');
  });

  it('canonicalization shape matches paper_resolved_votes exactly', () => {
    // paper_resolved_votes is the reference implementation. Assert the shared
    // canonicalization tokens appear in BOTH CTEs, so a divergence in either
    // direction (citing path drifts, or sibling drifts) fails red.
    const citing = citingPaperQualityBlock(source);
    const prvStart = source.indexOf('paper_resolved_votes AS (');
    expect(prvStart, 'paper_resolved_votes CTE not found in reputation.ts').toBeGreaterThanOrEqual(0);
    const prvEnd = source.indexOf('paper_reviews AS (', prvStart);
    expect(prvEnd, 'paper_reviews CTE (block terminator) not found after paper_resolved_votes').toBeGreaterThan(prvStart);
    const prv = source.slice(prvStart, prvEnd);

    for (const [label, token] of CANONICALIZATION_TOKENS) {
      expect(prv, `paper_resolved_votes reference missing ${label}: ${token}`).toContain(token);
      expect(citing, `citing_paper_quality drifted from paper_resolved_votes on ${label}: ${token}`).toContain(token);
    }
    // The SRF array-guard + empty-array fallback pair, taken together, is the
    // exact cascade-fail-defense form. Pin the full guard expression (modulo
    // the metadata-source alias) appears in both.
    const guardBody = `'authors') = 'array'`;
    expect(prv, 'paper_resolved_votes missing the authors array guard').toContain(guardBody);
    expect(citing, 'citing_paper_quality missing the authors array guard').toContain(guardBody);
  });
});

describe('citing_paper_quality co-author voter exclusion — synthetic-VALUES behavioral canary', () => {
  it.skipIf(!isHafConfigured())(
    'co-author upvote does not inflate weighted_upvotes; author self-upvote stays excluded even when absent from authors[]',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // Faithfully mirror the citing_paper_quality aggregate: a citing_papers
      // source row carrying cp.citing_meta, LEFT JOIN citing_latest_votes,
      // LEFT JOIN voter_weights, GROUP BY exactly as in the production CTE, with
      // the co-author NOT EXISTS in the aggregate FILTER referencing the
      // ungrouped cp.citing_meta. Only the HAF table substitutions are replaced
      // by synthetic CTEs; the FILTER expression is verbatim.
      //
      // Scenarios:
      //   - p1: citing_author 'bob', authors[] = [bob, Confederate].
      //         Voters: bob (self, byte-equality), confederate (co-author,
      //         canonicalized from mixed-case "Confederate"), honest (counts).
      //         Expected weighted_upvotes = 1.0 (only honest).
      //   - p3: citing_author 'eve', authors[] = [someoneelse] (eve OMITTED).
      //         Voters: eve (self — caught ONLY by the retained byte-equality,
      //         since the NOT EXISTS cannot see eve in authors[]), honest.
      //         Expected weighted_upvotes = 1.0 (only honest). This row proves
      //         the byte-equality is load-bearing and not subsumed.
      const sql = `
        WITH cp(cited_author, citing_author, citing_permlink, citing_created, citing_meta) AS (
          VALUES
            ('alice'::text, 'bob'::text, 'p1'::text, now()::timestamp, $2::jsonb),
            ('alice'::text, 'eve'::text, 'p3'::text, now()::timestamp, $3::jsonb)
        ),
        clv(author, permlink, voter, weight) AS (
          VALUES
            ('bob'::text, 'p1'::text, 'bob'::text, 10000),
            ('bob'::text, 'p1'::text, 'confederate'::text, 10000),
            ('bob'::text, 'p1'::text, 'honest'::text, 10000),
            ('eve'::text, 'p3'::text, 'eve'::text, 10000),
            ('eve'::text, 'p3'::text, 'honest'::text, 10000)
        ),
        vw(voter, vw) AS (
          VALUES ('bob'::text, 1.0::numeric), ('confederate'::text, 1.0::numeric),
                 ('honest'::text, 1.0::numeric), ('eve'::text, 1.0::numeric)
        )
        SELECT
          cp.citing_author,
          COALESCE(SUM(vw.vw * ABS(clv.weight) / 10000.0)
            FILTER (WHERE clv.weight > 0 AND clv.voter != cp.citing_author AND clv.weight != 0
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(cp.citing_meta -> $1 -> 'authors') = 'array'
                    THEN cp.citing_meta -> $1 -> 'authors'
                    ELSE '[]'::jsonb
                  END
                ) a
                WHERE jsonb_typeof(a) = 'object'
                  AND LOWER(TRIM(a ->> 'hive')) ~ '^[a-z0-9.-]+$'
                  AND LOWER(TRIM(a ->> 'hive')) = clv.voter
              )
            ), 0
          ) AS weighted_upvotes
        FROM cp
        LEFT JOIN clv ON clv.author = cp.citing_author AND clv.permlink = cp.citing_permlink
        LEFT JOIN vw ON vw.voter = clv.voter
        GROUP BY cp.cited_author, cp.citing_author, cp.citing_permlink, cp.citing_created
        ORDER BY cp.citing_author
      `;

      const p1Meta = JSON.stringify({
        pevotest: { type: 'paper', authors: [{ name: 'Bob', hive: 'bob' }, { name: 'Conf', hive: 'Confederate' }] },
      });
      const p3Meta = JSON.stringify({
        pevotest: { type: 'paper', authors: [{ name: 'Someone Else', hive: 'someoneelse' }] },
      });

      const result = await pool.query<{ citing_author: string; weighted_upvotes: string }>(sql, [
        'pevotest', // $1 = appTag
        p1Meta, // $2
        p3Meta, // $3
      ]);

      const byAuthor = new Map(result.rows.map((r) => [r.citing_author, Number(r.weighted_upvotes)]));

      // p1: only `honest` survives. Without the co-author NOT EXISTS, the
      // mixed-case "Confederate" upvote would add a second 1.0 → 2.0.
      expect(byAuthor.get('bob'), 'confederate co-author upvote must not inflate weighted_upvotes').toBeCloseTo(1.0, 5);
      // p3: only `honest` survives. Without the retained byte-equality, eve's
      // self-upvote would re-enter (eve is not in authors[]) → 2.0.
      expect(byAuthor.get('eve'), 'citing author self-upvote must stay excluded even when absent from authors[]').toBeCloseTo(1.0, 5);
    },
  );
});
