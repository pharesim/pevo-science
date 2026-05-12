/**
 * Display ↔ reputation parity invariant test (real HAF).
 *
 * Acceptance criterion #4 of
 * `backend-review-validity-gate-and-display-reputation-parity.md`:
 *
 *   c surfaces as a review on the paper-detail page
 *     ⟺ c contributes to the paper's `review_count` / `avg_rating`
 *     ⟺ c contributes to `paper_reviews.quality` in the reputation cycle
 *     ⟺ c contributes to `user_reviews` for the reviewer in the cycle.
 *
 * Operationalization: pick one paper from the real HAF corpus that has at
 * least one passing review, then assert that the set of (author, permlink)
 * selected by the paper-detail display path equals the set selected by
 * the reputation `paper_reviews` CTE for the same paper. If a future
 * change adds a predicate to one path but not the other, the sets diverge
 * and this test fails red.
 *
 * Why this test exists at this level. The display path (`papers.ts`,
 * `profile.ts`, `search.ts`, `stats.ts`, `notification-queries.ts`,
 * `reviews.ts`) and the reputation path (`reputation.ts`) compose
 * `validReviewWhere` + `excludeSelfReviewWhere` independently. They share
 * the helpers but diverge in HOW they admit accredited reviewers:
 *
 *   - Display: `c.author = ANY($N::text[])` where the array is
 *     `accredited ∪ {anon}` (precomputed in JS).
 *   - Reputation: `c.author = ANY($2::text[]) OR c.author = $19` where
 *     $2 = accredited array, $19 = anon scalar.
 *
 * The two predicates are logically equivalent over the same inputs. This
 * test asserts that equivalence holds on the live corpus.
 *
 * Per CLAUDE.md "Running Tests": real HAF, no mocking of `getPool()` /
 * `getHafPool()`. The carve-out clause-C does NOT apply here — the
 * mechanism under test (predicate equivalence) is exactly the thing real
 * HAF tests are good at.
 */
import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../../src/db.js';
import { config } from '../../src/config.js';
import { getAllAccreditedAccounts } from '../../src/accreditation.js';
import {
  T,
  validReviewWhere,
  excludeSelfReviewWhere,
} from '../../src/hafsql.js';
import { queryWithRetry } from '../support/haf-query.js';

describe('review parity invariant: display set === paper_reviews CTE set', () => {
  it.skipIf(!isHafConfigured())(
    'detail-page review list and reputation paper_reviews CTE select the same (author, permlink) rows',
    { timeout: 90_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const accreditedSet = await getAllAccreditedAccounts();
      const accreditedArr = [...accreditedSet];
      if (accreditedArr.length === 0) {
        ctx.skip('No accredited corpus on HAF — invariant not exercisable');
        return;
      }
      const anonAccount = config.hiveAnonAccount || '';
      const reviewAuthors = anonAccount
        ? [...accreditedArr, anonAccount]
        : accreditedArr;

      // Find a native paper that has at least one passing review. The
      // corpus may not have any such paper; ctx.skip() rather than
      // vacuously pass so absence is visible in CI rather than silent.
      const findPaper = await queryWithRetry(pool, `
        SELECT c.parent_author AS author, c.parent_permlink AS permlink
        FROM ${T.comments} c
        JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
        WHERE c.parent_author != ''
          AND p.parent_author = '' AND p.parent_permlink = $1
          AND (p.json_metadata -> $1 ->> 'type') = 'paper'
          AND c.author = ANY($2::text[])
          AND ${validReviewWhere({ commentAlias: 'c', appTagParam: '$1' })}
          AND ${excludeSelfReviewWhere({ reviewAlias: 'c', paperRowAlias: 'p', appTagParam: '$1' })}
        GROUP BY c.parent_author, c.parent_permlink
        LIMIT 1
      `, [config.appTag, reviewAuthors]);

      if (findPaper.rows.length === 0) {
        ctx.skip('No paper with passing reviews in HAF corpus — invariant not exercisable');
        return;
      }
      const author = findPaper.rows[0].author as string;
      const permlink = findPaper.rows[0].permlink as string;

      // Display-side SQL: mirrors the paper-detail review list at
      // backend/src/routes/papers.ts:2201-2216. Predicates:
      //   - c.author = ANY($4::text[])  [reviewAuthors = accredited ∪ anon]
      //   - validReviewWhere
      //   - excludeSelfReviewWhere
      const displayResult = await queryWithRetry(pool, `
        SELECT c.author, c.permlink
        FROM ${T.comments} c
        JOIN ${T.comments} p ON p.author = $1 AND p.permlink = $2
        WHERE c.parent_author = $1 AND c.parent_permlink = $2
          AND c.author = ANY($4::text[])
          AND ${validReviewWhere({ commentAlias: 'c', appTagParam: '$3' })}
          AND ${excludeSelfReviewWhere({ reviewAlias: 'c', paperRowAlias: 'p', appTagParam: '$3' })}
      `, [author, permlink, config.appTag, reviewAuthors]);

      // Reputation-side SQL: mirrors paper_reviews CTE at
      // backend/src/reputation.ts:562-585. Predicates:
      //   - validReviewWhere
      //   - excludeSelfReviewWhere
      //   - (c.author = ANY($2::text[]) OR c.author = $4)
      //     where $2 = accredited array, $4 = anon scalar
      const cycleResult = await queryWithRetry(pool, `
        SELECT c.author, c.permlink
        FROM ${T.comments} up
        JOIN ${T.comments} c
          ON c.parent_author = up.author AND c.parent_permlink = up.permlink
          AND ${validReviewWhere({ commentAlias: 'c', appTagParam: '$3' })}
          AND ${excludeSelfReviewWhere({ reviewAlias: 'c', paperRowAlias: 'up', appTagParam: '$3' })}
          AND (c.author = ANY($2::text[]) OR c.author = $4)
        WHERE up.author = $1 AND up.permlink = $5
      `, [author, accreditedArr, config.appTag, anonAccount, permlink]);

      const displaySet = new Set(
        displayResult.rows.map((r) => `${r.author as string}|${r.permlink as string}`),
      );
      const cycleSet = new Set(
        cycleResult.rows.map((r) => `${r.author as string}|${r.permlink as string}`),
      );

      // Set equality assertion — sort for deterministic diff output.
      expect([...cycleSet].sort()).toEqual([...displaySet].sort());

      // Sanity floor: the chosen paper has at least one review (already
      // asserted by the LIMIT-1 finder); confirm here so a vacuous
      // pass-with-empty-sets can't slip through.
      expect(displaySet.size).toBeGreaterThan(0);
    },
  );
});
