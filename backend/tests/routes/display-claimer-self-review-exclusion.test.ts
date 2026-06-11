/**
 * Display-side claimer self-review exclusion canary.
 *
 * Background. excludeSelfReviewWhere drops the chain poster + the `authors[].hive`
 * named co-authors from a review/vote set, but NOT a CREDITED authorship-claim
 * claimer matched by ORCID or connected to a name-only slot (absent from
 * `authors[].hive`). The reputation cycle closes that on the score path; the
 * DISPLAY review aggregations now close it too by composing
 * {@link excludeClaimedSelfWhere} against the `authorship_claims` CTE
 * (`authorshipClaimsCteBody`), mirroring the cycle's `accepted_claims NOT EXISTS`
 * gate.
 *
 * Two layers (mirroring the review-agg / citation-count single-scan canaries):
 *
 *   1. A source-level shape pin (always runs, no infra): asserts every display
 *      review surface composes excludeClaimedSelfWhere, so a future surface that
 *      drops the gate fails red.
 *
 *   2. A synthetic-VALUES behavioral canary (real Postgres, skips when HAF is not
 *      configured): runs the production excludeClaimedSelfWhere predicate over a
 *      synthetic authorship_claims + reviews corpus and asserts an ACCEPTED
 *      claimer's self-review is excluded while a third-party review and a
 *      PENDING (not-yet-accepted) claimer's review are kept. Uses the real helper
 *      so a change to its predicate (status filter, key match) turns this red.
 *
 * **Carve-out clause-(a) justification for layer 2:** seeding an accepted
 * ORCID/name-only authorship claim (claim + approve / author_accept ops) plus a
 * self-review on Hive, waiting for HAF indexing, and aligning the accredited set
 * is not a tractable integration shape; the public corpus is not guaranteed to
 * contain a paper with a credited ORCID/name-only claimer who also self-reviewed.
 * The synthetic-VALUES query under `getPool()` exercises the exact NOT EXISTS +
 * status='accepted' predicate the display surfaces compose.
 * **Carve-out clause-(b):** this is a SQL-level computation canary, not a route
 * test. `verifyHiveSignature` and other auth middleware are not in scope and are
 * NOT mocked; real Postgres runs the predicate and only the rowset is synthetic.
 * **Carve-out clause-(c) real-path companion:** the production gate runs against
 * real HAF in the papers / profile / search / reviews route tests; the risk class
 * pinned here (accepted-vs-pending claimer + third-party discrimination the public
 * corpus cannot be guaranteed to contain) is what those cannot exercise
 * deterministically.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPool, isHafConfigured } from '../../src/db.js';
import { excludeClaimedSelfWhere } from '../../src/hafsql.js';

const surfaceFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

describe('display claimer self-review exclusion — source-level shape pin', () => {
  it('every display review surface composes excludeClaimedSelfWhere', () => {
    // papers.ts carries THREE gate sites: the listing review-agg LATERAL, the
    // paper-detail enrichment review list, and the paper-detail vote query. Pin the
    // exact count so dropping any one (e.g. the highest-traffic listing review-agg)
    // fails red instead of silently passing a loose >= 2 floor.
    const papers = surfaceFile('routes/papers.ts');
    expect(
      (papers.match(/excludeClaimedSelfWhere\(/g) ?? []).length,
      'papers.ts must gate the listing review-agg, the paper-detail review list, and the paper-detail vote query',
    ).toBe(3);
    // profile.ts carries TWO gate sites (getProfileStats review_count + the
    // reviews-list query); assert both so a regression in one fails red rather than
    // being masked by the other's match (a single .toContain() passed either way).
    expect(
      (surfaceFile('routes/profile.ts').match(/excludeClaimedSelfWhere\(/g) ?? []).length,
      'profile.ts must gate both getProfileStats and fetchUserReviewsFromHaf',
    ).toBeGreaterThanOrEqual(2);
    for (const rel of ['routes/search.ts', 'routes/stats.ts', 'routes/reviews.ts']) {
      expect(surfaceFile(rel), `${rel} must compose excludeClaimedSelfWhere`).toContain('excludeClaimedSelfWhere(');
    }
  });

  it('the displayed net_votes paths exclude credited-claimer self-votes', () => {
    const papers = surfaceFile('routes/papers.ts');
    // batchResolveVotes (authoritative listing net_votes) skips voters who are
    // credited (accepted claimers or consented authors) for the paper they
    // voted on.
    expect(papers, 'batchResolveVotes must skip credited self-votes').toContain('creditedSet.has(');
    expect(papers, 'batchResolveVotes must fetch accepted claims to build the skip set').toContain(
      "FROM authorship_claims WHERE status = 'accepted'",
    );
    // The paper-detail voter query gates on v.voter via excludeClaimedSelfWhere.
    expect(papers, 'paper-detail voteResult must gate v.voter via excludeClaimedSelfWhere').toContain(
      "excludeClaimedSelfWhere({ authorExpr: 'v.voter'",
    );
    // The paper-detail revote channel is resolved in JS (no SQL gate), so it must
    // skip accepted claimers explicitly in the vote-merge loops.
    expect(papers, 'paper-detail revote merge must skip accepted-claimer self-revotes').toContain('acceptedClaimers.has(');
  });
});

describe('display claimer self-review exclusion — synthetic-VALUES behavioral parity', () => {
  it.skipIf(!isHafConfigured())(
    'an accepted ORCID/name-only claimer self-review is excluded; third-party and pending-claimer reviews are kept',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // Synthetic authorship_claims (the CTE authorshipClaimsCteBody produces, with
      // a resolved `status`) + the paper + its reviews. `claimer-orcid` is a
      // credited claimer (status='accepted') absent from any authors[].hive, so
      // only the accepted_claims gate — not excludeSelfReviewWhere — can drop it.
      const sql = `
        WITH
          authorship_claims(claimer, paper_author, paper_permlink, status) AS (VALUES
            ('claimer-orcid'::text,   'alice'::text, 'paper-A'::text, 'accepted'::text),
            ('claimer-pending'::text, 'alice'::text, 'paper-A'::text, 'pending'::text)
          ),
          page(author, permlink) AS (VALUES ('alice'::text, 'paper-A'::text)),
          reviews(author, parent_author, parent_permlink) AS (VALUES
            ('thirdparty'::text,      'alice'::text, 'paper-A'::text),
            ('claimer-orcid'::text,   'alice'::text, 'paper-A'::text),
            ('claimer-pending'::text, 'alice'::text, 'paper-A'::text)
          )
        SELECT r.author
        FROM reviews r
        JOIN page p ON p.author = r.parent_author AND p.permlink = r.parent_permlink
        WHERE ${excludeClaimedSelfWhere({ authorExpr: 'r.author', paperAuthorExpr: 'p.author', paperPermlinkExpr: 'p.permlink' })}
        ORDER BY r.author
      `;
      const res = await pool.query<{ author: string }>(sql);
      const kept = res.rows.map((r) => r.author);
      // claimer-orcid (accepted) dropped; thirdparty kept; claimer-pending kept
      // (the gate only drops status='accepted', not a pending/unresolved claim).
      expect(kept).toEqual(['claimer-pending', 'thirdparty']);
    },
  );
});
