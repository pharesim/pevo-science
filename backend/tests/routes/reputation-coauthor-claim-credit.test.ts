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
 * The existence of a `user_papers` claim row in the vote-chain behavioral query
 * stands in for an APPROVED `accepted_claims` row; the claim self-dealing and
 * list-final gates layered on top of the original credit fix get their own
 * coverage:
 *
 *   - List-final (hive-schemas.md §2.9/2.10): the explicit-approval arm credits
 *     a claim only when `author_index` resolves to an existing `authors[]` slot.
 *     Pinned at the source level (both `reputation.ts` accepted_claims and the
 *     `hafsql.ts` authorshipClaimsCteBody read surface) and behaviorally by the
 *     "named-slot gate" canary (approval + ORCID arms; unlisted / out-of-range
 *     indexes grant zero credit).
 *   - Claimer self-dealing: a credited claimer's self-vote / self-review on the
 *     paper they are credited for is excluded (the chain-poster and `authors[].hive`
 *     exclusions miss ORCID- and name-only-slot claimers). Pinned at the source
 *     level and behaviorally by the claimer-self-vote scenario in the vote-chain
 *     canary and the "claimer self-review exclusion (quality path)" canary.
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

  // ── The cycle now COMPOSES the shared authorshipClaimsCteBody builder rather
  //    than an inline accepted_claims copy. The list-final slot gate
  //    (hive-schemas.md §2.9/2.10), the revoke/approve signer gates, and the
  //    ORCID/hive auto-accept arms all live in that builder now — pinned by the
  //    read-surface "approvals arm gates on a resolvable named slot" test below
  //    and the signer-gate suites.
  it('the cycle composes the shared authorship-claims builder (no inline resolution copy)', () => {
    expect(source).toContain('authorshipClaimsCteBody(21, { claimers: usernames })');
    expect(source).toMatch(
      /accepted_claims AS \(\s*SELECT DISTINCT claimer, paper_author, paper_permlink\s+FROM authorship_claims\s+WHERE status = 'accepted'/,
    );
    // The inline list-final slot gate that used to live in reputation.ts is gone;
    // it now lives in the builder (hafsql.ts) — verified by the parity pin below.
    expect(source).not.toContain(`-> 'authors' -> ce.author_index`);
  });

  // ── Claimer self-dealing close (accepted_claims NOT EXISTS gate): a credited
  //    claimer of a chain post must not vote/review it. The authors[].hive
  //    exclusion misses ORCID- and name-only-slot claimers, so an
  //    accepted_claims gate is required.
  it('paper_resolved_votes excludes accepted_claims claimers (self-vote close)', () => {
    // Pin the full correlated predicate, not just the `SELECT 1 FROM
    // accepted_claims ac` line (which also opens the paper_reviews self-review
    // gate) — this arm keys on plv.voter against the chain post coords.
    expect(source).toMatch(
      /SELECT 1 FROM accepted_claims ac\s+WHERE ac\.paper_author = plv\.author\s+AND ac\.paper_permlink = plv\.permlink\s+AND ac\.claimer = plv\.voter/,
    );
  });

  it('paper_reviews excludes accepted_claims claimers (self-review close)', () => {
    // Full correlated predicate keyed on the reviewer (c.author) against the
    // chain post coords (cp.author / cp.permlink).
    expect(source).toMatch(
      /SELECT 1 FROM accepted_claims ac\s+WHERE ac\.paper_author = cp\.author\s+AND ac\.paper_permlink = cp\.permlink\s+AND ac\.claimer = c\.author/,
    );
  });
});

describe('co-author claim credit — read-surface (hafsql.ts) parity pin', () => {
  const hafsqlSource = readFileSync(resolve(PROJECT_ROOT, 'src/hafsql.ts'), 'utf-8');

  it('authorshipClaimsCteBody approvals arm gates on a resolvable name-only chain slot', () => {
    // The list-final gate resolves author_index against the cumulative-chain
    // display union (claims_display_slots), and only a name-only slot (no
    // hive/orcid anchor) is claimable through Route 3. Both conjuncts live in
    // the shared builder, so the cycle and read surfaces accept identically.
    expect(
      hafsqlSource,
      'the approvals arm must resolve author_index against the chain display slots',
    ).toContain('AND ds.author_index = cb.author_index');
    expect(
      hafsqlSource,
      'the approvals arm must gate on the slot being name-only (anchored slots are Route-2-only)',
    ).toContain(`AND ds.slot_key LIKE 'name:%'`);
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
      //   accepted_claims is derived from user_papers (claim rows are author <>
      //   chain_author); it stands in for the production accepted_claims CTE so
      //   the claimer self-vote exclusion can correlate on (paper_author,
      //   paper_permlink, claimer) exactly as the cycle does.
      //   Synthetic votes (vo): an honest accredited upvote on each post, PLUS
      //   two self-votes on bob/paper-A that must both be excluded —
      //     - bob upvoting his OWN post (chain-author self-vote → `!= cp.author`)
      //     - alice (the credited CLAIMER) upvoting the post she is credited for
      //       (claimer self-vote → accepted_claims NOT EXISTS). alice is not the
      //       chain author and is absent from authors[].hive (the slot is empty),
      //       so ONLY the accepted_claims gate stops her self-dealing upvote.
      //   All three voters carry weight 1.0, so a dropped exclusion shows up as
      //   inflated credit rather than a silently-zero-weight no-op.
      const sql = `
        WITH
        accredited(account) AS (VALUES ('honest'::text), ('bob'::text), ('alice'::text)),
        user_papers(author, permlink, json_metadata, chain_author, chain_permlink) AS (
          VALUES
            ('alice'::text, 'paper-A'::text, '{"pevotest":{"type":"paper","authors":[]}}'::jsonb, 'bob'::text,   'paper-A'::text),
            ('carol'::text, 'paper-C'::text, '{"pevotest":{"type":"paper","authors":[]}}'::jsonb, 'carol'::text, 'paper-C'::text),
            ('dave'::text,  'paper-D'::text, '{"pevotest":{"type":"paper","authors":[]}}'::jsonb, 'dave'::text,  'paper-D'::text),
            ('erin'::text,  'paper-D'::text, '{"pevotest":{"type":"paper","authors":[]}}'::jsonb, 'dave'::text,  'paper-D'::text)
        ),
        accepted_claims AS (
          SELECT author AS claimer, chain_author AS paper_author, chain_permlink AS paper_permlink
          FROM user_papers WHERE author <> chain_author
        ),
        chain_papers AS (
          SELECT DISTINCT chain_author AS author, chain_permlink AS permlink, json_metadata FROM user_papers
        ),
        vo(voter, author, permlink, weight, block_num) AS (
          VALUES
            ('honest'::text, 'bob'::text,   'paper-A'::text, 10000, 100),
            ('honest'::text, 'carol'::text, 'paper-C'::text, 10000, 100),
            ('honest'::text, 'dave'::text,  'paper-D'::text, 10000, 100),
            ('bob'::text,    'bob'::text,   'paper-A'::text, 10000, 100),
            ('alice'::text,  'bob'::text,   'paper-A'::text, 10000, 100)
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
            AND NOT EXISTS (
              SELECT 1 FROM accepted_claims ac
              WHERE ac.paper_author = plv.author
                AND ac.paper_permlink = plv.permlink
                AND ac.claimer = plv.voter
            )
        ),
        voter_weights(voter, vw) AS (
          VALUES ('honest'::text, 1.0::numeric), ('bob'::text, 1.0::numeric), ('alice'::text, 1.0::numeric)
        ),
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
      // 2. The CLAIMER self-vote is excluded: alice (credited via accepted_claims)
      //    upvotes bob/paper-A with weight 1.0, but the accepted_claims NOT EXISTS
      //    drops it, so alice stays at 1.0 (honest's vote only). Mutation-kill:
      //    delete the accepted_claims NOT EXISTS in paper_resolved_votes → alice's
      //    own weight-1.0 upvote counts → alice = 2.0 → this assertion goes red.
      //    (This replaces the prior tautological `not.toBeCloseTo(2.0)`, which
      //    passed whenever the 1.0 assertion did because no self-vote was seeded.)
      expect(papers.get('alice'), 'claimer credit = honest vote only; claimer self-vote excluded').toBeCloseTo(1.0, 5);

      // 3. The chain-author self-vote (bob upvoting his own paper-A, weight 1.0)
      //    is excluded by `plv.voter != cp.author`. Independent of the claimer
      //    gate: removing `!= cp.author` would also push alice's credit to 2.0.
      expect(papers.get('alice'), 'chain-author self-vote must not inflate the claimer score').not.toBeCloseTo(2.0, 5);

      // 4. Native (non-claim) author scoring is unchanged.
      expect(papers.get('carol'), 'native author score must be unregressed').toBeCloseTo(1.0, 5);

      // 5. Shared credit with NO fan-out double-count: dave (native) and erin
      //    (claimer) both credit the same chain post; chain_papers dedup means
      //    the single honest vote aggregates once (1.0), and BOTH recipients
      //    read that same 1.0. Without the dedup the vote would fan out to 2.0 each.
      expect(papers.get('dave'), 'native author of a co-credited post → 1.0, not fanned out').toBeCloseTo(1.0, 5);
      expect(papers.get('erin'), 'claimer of a co-credited post → 1.0, not fanned out').toBeCloseTo(1.0, 5);

      // 6. The on-chain author of a claimed paper who is NOT a target user gets
      //    no credit (bob has no user_papers row); credit flows only to the
      //    target users with a native or approved-claim row.
      expect(papers.has('bob'), 'a non-target chain author must not appear as a credit recipient').toBe(false);
    },
  );
});

describe('co-author claim credit — claimer self-review exclusion (quality path)', () => {
  it.skipIf(!isHafConfigured())(
    'a claimer 5/5/5/5 self-review does not lift the paper quality multiplier they are credited for',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // alice claims bob/paper-A (a name-only slot → alice is absent from
      // authors[].hive, so excludeSelfReviewWhere does NOT catch her; only the
      // accepted_claims gate does). honest upvote → weighted_up = 1.0. The honest
      // reviewer `rev` gives 3/3/3/3 → quality 0.6. The claimer alice AND the
      // poster bob each 5/5/5/5-self-review. With both exclusions only `rev`
      // counts → quality 0.6 → alice's credit = 0.6 * min(1.0, W) = 0.6.
      //   Mutation-kill (claimer gate): drop the accepted_claims NOT EXISTS in
      //   paper_reviews → alice's 5/5/5/5 counts → quality = avg(0.6,1.0)=0.8 →
      //   alice = 0.8, assertion red.
      //   Mutation-kill (poster gate): drop `r.reviewer != cp.author` → bob's
      //   5/5/5/5 counts → quality 0.8 → red.
      const sql = `
        WITH
        accredited(account) AS (VALUES ('honest'::text), ('rev'::text), ('alice'::text), ('bob'::text)),
        user_papers(author, permlink, json_metadata, chain_author, chain_permlink) AS (
          VALUES ('alice'::text, 'paper-A'::text, '{"pevotest":{"type":"paper","authors":[]}}'::jsonb, 'bob'::text, 'paper-A'::text)
        ),
        accepted_claims AS (
          SELECT author AS claimer, chain_author AS paper_author, chain_permlink AS paper_permlink
          FROM user_papers WHERE author <> chain_author
        ),
        chain_papers AS (
          SELECT DISTINCT chain_author AS author, chain_permlink AS permlink, json_metadata FROM user_papers
        ),
        paper_vote_agg(author, permlink, weighted_up) AS (VALUES ('bob'::text, 'paper-A'::text, 1.0::numeric)),
        reviews(reviewer, paper_author, paper_permlink, rating) AS (
          VALUES
            ('rev'::text,   'bob'::text, 'paper-A'::text, '{"methodology":3,"novelty":3,"clarity":3,"significance":3}'::jsonb),
            ('alice'::text, 'bob'::text, 'paper-A'::text, '{"methodology":5,"novelty":5,"clarity":5,"significance":5}'::jsonb),
            ('bob'::text,   'bob'::text, 'paper-A'::text, '{"methodology":5,"novelty":5,"clarity":5,"significance":5}'::jsonb)
        ),
        paper_reviews AS (
          SELECT cp.author, cp.permlink,
            AVG(((r.rating->>'methodology')::numeric + (r.rating->>'novelty')::numeric
               + (r.rating->>'clarity')::numeric + (r.rating->>'significance')::numeric) / 4.0) / 5.0 AS quality
          FROM chain_papers cp
          JOIN reviews r ON r.paper_author = cp.author AND r.paper_permlink = cp.permlink
            AND r.reviewer != cp.author
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(cp.json_metadata -> $1 -> 'authors') = 'array'
                  THEN cp.json_metadata -> $1 -> 'authors' ELSE '[]'::jsonb END
              ) a
              WHERE jsonb_typeof(a) = 'object'
                AND LOWER(TRIM(a ->> 'hive')) = r.reviewer
            )
            AND NOT EXISTS (
              SELECT 1 FROM accepted_claims ac
              WHERE ac.paper_author = cp.author AND ac.paper_permlink = cp.permlink AND ac.claimer = r.reviewer
            )
            AND r.reviewer IN (SELECT account FROM accredited)
          GROUP BY cp.author, cp.permlink
        ),
        paper_scores AS (
          SELECT up.author, up.permlink,
            COALESCE(pr.quality, 1.0) * LEAST(COALESCE(pva.weighted_up, 0), 20) AS score
          FROM user_papers up
          LEFT JOIN paper_reviews pr ON pr.author = up.chain_author AND pr.permlink = up.chain_permlink
          LEFT JOIN paper_vote_agg pva ON pva.author = up.chain_author AND pva.permlink = up.chain_permlink
        )
        SELECT author, SUM(score)::float AS papers FROM paper_scores GROUP BY author
      `;

      const result = await pool.query<{ author: string; papers: number }>(sql, ['pevotest']);
      const papers = new Map(result.rows.map((r) => [r.author, Number(r.papers)]));
      expect(papers.get('alice'), 'claimer self-review must not lift the quality multiplier (only rev 0.6 counts)').toBeCloseTo(0.6, 5);
    },
  );
});

describe('co-author claim credit — accepted_claims named-slot gate (list-final)', () => {
  it.skipIf(!isHafConfigured())(
    'an approved claim is credited only when author_index resolves to an existing authors[] slot; ORCID arm is slot-gated too',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // Reconstruct the accepted_claims approval + ORCID arms (the two non-trivial
      // arms) with the list-final slot gate. The post bob/paper-A names two slots:
      //   authors[0] = a name-only slot (connected via approval)
      //   authors[1] = an ORCID slot (auto-accepted when the claimer's accredited
      //                ORCID matches). The ORCID equality here is simplified — the
      //                whitespace-canonicalization (chainOrcidAutoAcceptMatchSql)
      //                is covered by its own tests; this canary pins the arm's
      //                author_index/slot gating, not the BTRIM charset.
      // Claims:
      //   alice  → author_index 0, approved by bob  → ACCEPTED (slot 0 exists)
      //   frank  → author_index NULL, approved by bob → REJECTED (unlisted)
      //   grace  → author_index 5, approved by bob   → REJECTED (slot 5 absent)
      //   hank   → author_index 1, ORCID match        → ACCEPTED (slot 1 exists)
      //   ivan   → author_index 9, ORCID match        → REJECTED (slot 9 absent)
      // Mutation-kill: list-final is slot-gated per arm. Drop the explicit-
      // approval arm's `jsonb_typeof(... -> author_index) = 'object'` gate and
      // grace (out-of-range approval, slot 5 absent) flips to accepted. Drop the
      // ORCID arm's author_index anchoring (match the accredited orcid against
      // any slot instead of `authors -> author_index ->> 'orcid'`) and ivan
      // (out-of-range ORCID, slot 9 absent) flips to accepted. Either flip turns
      // the assertions red. frank (author_index NULL) stays rejected regardless:
      // the `author_index IS NOT NULL` guard, not the slot gate, rejects the
      // unlisted claim.
      const sql = `
        WITH
        posts(author, permlink, parent_author, json_metadata) AS (
          VALUES ('bob'::text, 'paper-A'::text, ''::text,
            '{"pevotest":{"type":"paper","authors":[{"name":"Alice X"},{"orcid":"0000-0002-1111-2222"}]}}'::jsonb)
        ),
        active_accreditations(account, orcid) AS (
          VALUES ('hank'::text, '0000-0002-1111-2222'::text), ('ivan'::text, '0000-0002-1111-2222'::text)
        ),
        claim_events(action, claimer, paper_author, paper_permlink, author_index, approver, block_num) AS (
          VALUES
            ('claim_authorship'::text,   'alice'::text, 'bob'::text, 'paper-A'::text, 0::int,    'alice'::text, 10),
            ('approve_authorship'::text, 'alice'::text, 'bob'::text, 'paper-A'::text, 0::int,    'bob'::text,   20),
            ('claim_authorship'::text,   'frank'::text, 'bob'::text, 'paper-A'::text, NULL::int, 'frank'::text, 10),
            ('approve_authorship'::text, 'frank'::text, 'bob'::text, 'paper-A'::text, NULL::int, 'bob'::text,   20),
            ('claim_authorship'::text,   'grace'::text, 'bob'::text, 'paper-A'::text, 5::int,    'grace'::text, 10),
            ('approve_authorship'::text, 'grace'::text, 'bob'::text, 'paper-A'::text, 5::int,    'bob'::text,   20),
            ('claim_authorship'::text,   'hank'::text,  'bob'::text, 'paper-A'::text, 1::int,    'hank'::text,  10),
            ('claim_authorship'::text,   'ivan'::text,  'bob'::text, 'paper-A'::text, 9::int,    'ivan'::text,  10)
        ),
        accepted_claims AS (
          SELECT DISTINCT ce.claimer, ce.paper_author, ce.paper_permlink
          FROM claim_events ce
          WHERE ce.action = 'claim_authorship'
            AND (
              -- Explicit-approval arm, list-final gated
              (
                ce.author_index IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM claim_events ap
                  WHERE ap.action = 'approve_authorship'
                    AND ap.claimer = ce.claimer AND ap.paper_author = ce.paper_author
                    AND ap.paper_permlink = ce.paper_permlink AND ap.block_num > ce.block_num
                    AND ap.approver IN (ap.paper_author, 'bridge')
                )
                AND EXISTS (
                  SELECT 1 FROM posts c
                  WHERE c.author = ce.paper_author AND c.permlink = ce.paper_permlink
                    AND c.parent_author = ''
                    AND jsonb_typeof(c.json_metadata -> $1 -> 'authors' -> ce.author_index) = 'object'
                )
              )
              -- ORCID auto-accept arm (already requires author_index IS NOT NULL;
              -- the orcid subscript only resolves on an existing slot, so it is
              -- inherently slot-gated — ivan's out-of-range index returns NULL)
              OR (ce.author_index IS NOT NULL AND EXISTS (
                SELECT 1 FROM posts c
                JOIN active_accreditations aa ON aa.account = ce.claimer
                WHERE c.author = ce.paper_author AND c.permlink = ce.paper_permlink
                  AND c.parent_author = ''
                  AND aa.orcid IS NOT NULL AND aa.orcid != ''
                  AND (c.json_metadata -> $1 -> 'authors' -> ce.author_index ->> 'orcid') = aa.orcid
              ))
            )
        )
        SELECT claimer FROM accepted_claims ORDER BY claimer
      `;

      const result = await pool.query<{ claimer: string }>(sql, ['pevotest']);
      const accepted = new Set(result.rows.map((r) => r.claimer));

      expect(accepted.has('alice'), 'approval of a claim resolving to a named slot must be credited').toBe(true);
      expect(accepted.has('hank'), 'ORCID match on an existing slot must be credited').toBe(true);
      expect(accepted.has('frank'), 'an author_index=null (unlisted) approval grants no credit').toBe(false);
      expect(accepted.has('grace'), 'an out-of-range author_index approval grants no credit').toBe(false);
      expect(accepted.has('ivan'), 'an out-of-range author_index ORCID match grants no credit').toBe(false);
    },
  );
});
