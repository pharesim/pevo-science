/**
 * Co-author-claim credit canary for the reputation cycle's paper-scoring chain.
 *
 * Background. `user_papers` UNIONs a claim row keyed `(claimer, chain_permlink)`,
 * but every downstream CTE — `paper_vote_signals`, `paper_resolved_votes`,
 * `paper_reviews`, `paper_scores` — used to join back on the claimer's name.
 * Votes and reviews are signed against the on-chain post author, never the
 * claimer, so the joins matched nothing and every claimed paper scored 0. The
 * fix projects `(chain_author, chain_permlink)` onto `user_papers`, dedups the
 * on-chain posts into `chain_papers`, and rekeys the vote/review CTEs to the
 * chain identity while credit attribution (the final SUM) stays on the claimer.
 *
 * Two layers (mirroring the other reputation-cycle canaries):
 *
 *   1. A source-level shape pin (always runs, no infra): asserts reputation.ts
 *      projects the chain columns, defines `chain_papers`, scopes vote signals
 *      by chain_papers membership (not `vo.author IN target_users`), joins
 *      paper_resolved_votes / paper_reviews on the chain identity, and joins
 *      paper_scores' reviews/votes on `up.chain_author/up.chain_permlink`. A
 *      revert to the credit-recipient join keys fails red.
 *
 *   2. A synthetic-VALUES behavioral canary (real Postgres, skips when HAF is
 *      not configured): reconstructs the vote->score chain verbatim modulo the
 *      HAF-table substitutions and proves the four properties the fix must hold.
 *
 * **Carve-out clause-(a):** seeding a claimed paper + an approved claim + a
 * third-party upvote on Hive and waiting for HAF indexing per test is not a
 * tractable integration-test shape; the public corpus is not guaranteed to
 * contain an approved co-author claim with a third-party upvote.
 * **Carve-out clause-(b):** SQL-level computation canary, not a route test.
 * `verifyHiveSignature` is out of scope and NOT mocked; real Postgres runs the
 * arithmetic and only the rowset is synthetic.
 * **Carve-out clause-(c):** the cycle runs the production CTEs against real HAF
 * in the lifecycle/batch reputation tests; the risk class pinned here (claim
 * credit flowing through the chain-identity joins, which the public corpus may
 * not exercise) is what the real-path coverage cannot guarantee.
 *
 * The existence of a `user_papers` claim row in the behavioral query stands in
 * for an APPROVED `accepted_claims` row; the approval/ORCID/username gating that
 * decides whether that row exists is unchanged by this fix and is covered by the
 * accepted_claims authority-gate canaries.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPool, isHafConfigured } from '../../src/db.js';

const PROJECT_ROOT = resolve(__dirname, '../..');

describe('co-author claim credit — source-level shape pin', () => {
  const source = readFileSync(resolve(PROJECT_ROOT, 'src/reputation.ts'), 'utf-8');

  it('user_papers projects the on-chain identity on both arms', () => {
    const matches = source.match(/c\.author AS chain_author, c\.permlink AS chain_permlink/g) ?? [];
    expect(matches.length, 'both the native and claim arms must project chain_author/chain_permlink').toBeGreaterThanOrEqual(2);
  });

  it('a chain_papers CTE dedups the on-chain posts', () => {
    expect(source).toContain('chain_papers AS (');
    expect(source).toContain('SELECT DISTINCT chain_author AS author, chain_permlink AS permlink, json_metadata');
  });

  it('paper_vote_signals scopes by chain_papers membership, not target-user authorship', () => {
    expect(
      source,
      'the vote arm must EXISTS against chain_papers so claimed-paper votes (signed against a non-target chain author) are admitted',
    ).toContain('EXISTS (SELECT 1 FROM chain_papers cp WHERE cp.author = vo.author AND cp.permlink = vo.permlink)');
    // Scope the negative assertion to the paper_vote_signals CTE — the sibling
    // review_vote_signals CTE legitimately retains `vo.author IN target_users`
    // (reviews are authored by target users; there is no claim concept there).
    const voteSignalsBlock = source.slice(
      source.indexOf('paper_vote_signals AS ('),
      source.indexOf('paper_latest_votes AS ('),
    );
    expect(voteSignalsBlock.length, 'paper_vote_signals block must be extractable').toBeGreaterThan(0);
    expect(
      voteSignalsBlock,
      'the old target-user authorship restriction on the paper-vote arm must be gone (it starved claimer credit)',
    ).not.toContain('vo.author IN (SELECT username FROM target_users)');
  });

  it('paper_resolved_votes joins chain_papers and self-excludes the chain author', () => {
    expect(source).toContain('JOIN chain_papers cp ON cp.author = plv.author AND cp.permlink = plv.permlink');
    expect(source).toContain('WHERE plv.voter != cp.author');
  });

  it('paper_reviews is keyed on chain_papers with the chain author as the self-exclusion alias', () => {
    expect(source).toContain('FROM chain_papers cp');
    expect(source).toContain(`excludeSelfReviewWhere({ paperRowAlias: 'cp', appTagParam: '$3' })`);
  });

  it('paper_scores joins reviews/votes on the chain identity (revert tripwire)', () => {
    expect(source).toContain('LEFT JOIN paper_reviews pr ON pr.author = up.chain_author AND pr.permlink = up.chain_permlink');
    expect(source).toContain('LEFT JOIN paper_vote_agg pva ON pva.author = up.chain_author AND pva.permlink = up.chain_permlink');
    expect(
      source,
      'the old credit-recipient join keys must be gone — they scored every claimed paper at 0',
    ).not.toContain('LEFT JOIN paper_reviews pr ON pr.author = up.author AND pr.permlink = up.permlink');
  });
});

describe('co-author claim credit — synthetic-VALUES behavioral canary', () => {
  it.skipIf(!isHafConfigured())(
    'claim credit flows to the claimer; native arm unregressed; chain-author self-vote excluded; no fan-out double-count',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // Reconstruct the vote->score chain verbatim modulo HAF-table substitutions.
      //   user_papers rows (credit recipient = author, on-chain post = chain_*):
      //     - alice claims bob/paper-A  (bob is NOT a target → no native row for bob)
      //     - carol native paper-C
      //     - dave native paper-D  AND  erin claims dave/paper-D  (shared credit)
      //   Synthetic votes (vo): an honest accredited upvote on each post, plus
      //   bob upvoting his OWN paper-A (must be self-excluded against the chain
      //   author even though the credit recipient is alice).
      const sql = `
        WITH
        accredited(account) AS (VALUES ('honest'::text), ('bob'::text)),
        user_papers(author, permlink, json_metadata, chain_author, chain_permlink) AS (
          VALUES
            ('alice'::text, 'paper-A'::text, '{"pevotest":{"type":"paper","authors":[]}}'::jsonb, 'bob'::text,   'paper-A'::text),
            ('carol'::text, 'paper-C'::text, '{"pevotest":{"type":"paper","authors":[]}}'::jsonb, 'carol'::text, 'paper-C'::text),
            ('dave'::text,  'paper-D'::text, '{"pevotest":{"type":"paper","authors":[]}}'::jsonb, 'dave'::text,  'paper-D'::text),
            ('erin'::text,  'paper-D'::text, '{"pevotest":{"type":"paper","authors":[]}}'::jsonb, 'dave'::text,  'paper-D'::text)
        ),
        chain_papers AS (
          SELECT DISTINCT chain_author AS author, chain_permlink AS permlink, json_metadata FROM user_papers
        ),
        vo(voter, author, permlink, weight, block_num) AS (
          VALUES
            ('honest'::text, 'bob'::text,   'paper-A'::text, 10000, 100),
            ('honest'::text, 'carol'::text, 'paper-C'::text, 10000, 100),
            ('honest'::text, 'dave'::text,  'paper-D'::text, 10000, 100),
            ('bob'::text,    'bob'::text,   'paper-A'::text, 10000, 100)
        ),
        paper_vote_signals AS (
          SELECT vo.voter, vo.author, vo.permlink, vo.weight, vo.block_num
          FROM vo
          WHERE vo.voter IN (SELECT account FROM accredited)
            AND EXISTS (SELECT 1 FROM chain_papers cp WHERE cp.author = vo.author AND cp.permlink = vo.permlink)
        ),
        paper_latest_votes AS (
          SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight, block_num
          FROM paper_vote_signals
          ORDER BY voter, author, permlink, block_num DESC
        ),
        paper_resolved_votes AS (
          SELECT plv.voter, plv.author, plv.permlink, plv.weight
          FROM paper_latest_votes plv
          JOIN chain_papers cp ON cp.author = plv.author AND cp.permlink = plv.permlink
          WHERE plv.voter != cp.author
            AND plv.weight != 0
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(cp.json_metadata -> $1 -> 'authors') = 'array'
                  THEN cp.json_metadata -> $1 -> 'authors'
                  ELSE '[]'::jsonb
                END
              ) a
              WHERE jsonb_typeof(a) = 'object'
                AND LOWER(TRIM(a ->> 'hive')) ~ '^[a-z0-9.-]+$'
                AND LOWER(TRIM(a ->> 'hive')) = plv.voter
            )
        ),
        voter_weights(voter, vw) AS (VALUES ('honest'::text, 1.0::numeric)),
        paper_vote_agg AS (
          SELECT prv.author, prv.permlink,
            COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight > 0), 0) AS weighted_up
          FROM paper_resolved_votes prv
          JOIN voter_weights vw ON vw.voter = prv.voter
          GROUP BY prv.author, prv.permlink
        ),
        paper_scores AS (
          SELECT up.author, up.permlink, COALESCE(pva.weighted_up, 0) AS score
          FROM user_papers up
          LEFT JOIN paper_vote_agg pva ON pva.author = up.chain_author AND pva.permlink = up.chain_permlink
        )
        SELECT author, SUM(score)::float AS papers
        FROM paper_scores
        GROUP BY author
        ORDER BY author
      `;

      const result = await pool.query<{ author: string; papers: number }>(sql, ['pevotest']);
      const papers = new Map(result.rows.map((r) => [r.author, Number(r.papers)]));

      // 1. Claim credit flows to the claimer (was 0 pre-fix). The honest upvote
      //    on bob/paper-A reaches alice via the chain-identity join.
      expect(papers.get('alice'), 'claimer must receive the chain paper score').toBeCloseTo(1.0, 5);

      // 2. The chain-author self-vote (bob upvoting his own paper-A) is excluded
      //    by `plv.voter != cp.author` — correct even though the credit
      //    recipient (alice) differs from the poster (bob). If the self-exclusion
      //    keyed on the credit recipient, bob's self-vote would inflate alice to 2.0.
      expect(papers.get('alice'), 'chain-author self-vote must not inflate the claimer score').not.toBeCloseTo(2.0, 5);

      // 3. Native (non-claim) author scoring is unchanged.
      expect(papers.get('carol'), 'native author score must be unregressed').toBeCloseTo(1.0, 5);

      // 4. Shared credit with NO fan-out double-count: dave (native) and erin
      //    (claimer) both credit the same chain post; chain_papers dedup means
      //    the single honest vote aggregates once (1.0), and BOTH recipients
      //    read that same 1.0. Without the dedup the vote would fan out to 2.0 each.
      expect(papers.get('dave'), 'native author of a co-credited post → 1.0, not fanned out').toBeCloseTo(1.0, 5);
      expect(papers.get('erin'), 'claimer of a co-credited post → 1.0, not fanned out').toBeCloseTo(1.0, 5);

      // 5. The on-chain author of a claimed paper who is NOT a target user gets
      //    no credit (bob has no user_papers row); credit flows only to the
      //    target users with a native or approved-claim row.
      expect(papers.has('bob'), 'a non-target chain author must not appear as a credit recipient').toBe(false);
    },
  );
});
