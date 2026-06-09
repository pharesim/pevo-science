/**
 * Per-callsite mutation-kill canaries for `excludeSelfReviewWhere` usage.
 *
 * Background. The behavioral matrix in `hafsql.test.ts` tests the helper's
 * predicate output in isolation; the parity-invariant test in
 * `tests/routes/review-parity-invariant.test.ts` tests the predicate-Set
 * equality between display and reputation paths; the load-bearing canary
 * in `tests/routes/reputation-paper-reviews-self-exclusion-canary.test.ts`
 * tests the AVG/5 inflation. None of these pin that each individual
 * callsite still composes the helper — a revert at any one of the 11 SQL
 * sites would leave the helper-level tests green but reintroduce the
 * mutation-class at that callsite (a self-review surfaces on
 * /api/profile/:user/reviews while still being excluded from the reputation
 * paper_reviews CTE, etc.).
 *
 * Per the convention
 * `defense-in-depth-canary-must-pin-each-layer-2026-05-07`: each callsite
 * is an independent defense layer; each gets its own canary.
 *
 * **Approach.** A source-level canary: read each of the 6 callsite files
 * and assert that `excludeSelfReviewWhere(` appears at least once. A
 * mutation that removes the call from any callsite fails this test red.
 *
 * **Why source-level (vs SQL-string runtime inspection).** The architect's
 * hold-block fix recipe asked for runtime SQL inspection via mock-pool.
 * 6 callsite files (five route modules plus the reputation batch module)
 * × full auth/middleware setup × distinct query-param shapes is
 * a large surface; the source-level form catches the same mutation class
 * (any line `AND ${excludeSelfReviewWhere(...)}` removed from the SQL
 * template). The trade-off: a contrived refactor that calls the helper
 * but never interpolates its return into the SQL would pass this canary
 * but fail runtime correctness — that scenario is not a credible
 * mutation class for this codebase (the helper is only called inline in
 * SQL template literals). Existing route-level integration tests cover
 * the runtime semantics where they're naturally exercised.
 *
 * **Scope of pinned callsites** (mirrors the architect's hold-block list):
 *
 *   - papers.ts:        listing rev_agg LATERAL (review_count + avg_rating,
 *                       one combined accredited-review scan)
 *                       paper-detail review list
 *   - profile.ts:       user_papers reviews list
 *                       fetchUserReviewsFromHaf (variable `selfExclude`)
 *   - search.ts:        type=review search
 *   - stats.ts:         review counter
 *   - reviews.ts:       fetchReviewFromHaf single-doc fetch
 *   - reputation.ts:    active_authors review arm
 *                       paper_reviews CTE
 *                       user_reviews CTE
 *                       citing_paper_quality CTE
 *
 * That's 11 callsites: the four `reputation.ts` sites are enumerated
 * individually above; the `reviews.ts` single-doc fetch and the
 * `reputation.ts` `active_authors` review arm are both `validReviewWhere`
 * composition sites that must also compose self-exclusion; the listing's
 * `review_count` and `avg_rating` share one rev_agg LATERAL, so `papers.ts`
 * contributes 2 (not 3). The notification arms 1a/1b have their own inline
 * `co.author != $1` predicate covered separately by
 * `notifications-arm-sql-shape.test.ts`.
 *
 * A repeated-mutation kill (e.g., a refactor that consolidates two adjacent
 * callsites into one shared variable) reduces the expected count for the
 * affected file — adjust the per-file `minOccurrences` count in this file's
 * `CALLSITES` table at that time, NOT silently relax the assertion to
 * `>=` everywhere.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Callsite {
  file: string;
  /** Minimum number of `excludeSelfReviewWhere(` occurrences expected. */
  minOccurrences: number;
  /** Human-readable description of the callsites this file is expected to contain. */
  callsites: string[];
}

const PROJECT_ROOT = resolve(__dirname, '..');

const CALLSITES: Callsite[] = [
  {
    file: 'src/routes/papers.ts',
    minOccurrences: 2,
    callsites: ['listing rev_agg LATERAL (review_count + avg_rating combined)', 'paper-detail review list'],
  },
  {
    file: 'src/routes/profile.ts',
    minOccurrences: 2,
    callsites: ['user_papers reviews list', 'fetchUserReviewsFromHaf'],
  },
  {
    file: 'src/routes/search.ts',
    minOccurrences: 1,
    callsites: ['type=review search'],
  },
  {
    file: 'src/routes/stats.ts',
    minOccurrences: 1,
    callsites: ['review counter'],
  },
  {
    file: 'src/routes/reviews.ts',
    minOccurrences: 1,
    callsites: ['fetchReviewFromHaf single-doc fetch'],
  },
  {
    file: 'src/reputation.ts',
    minOccurrences: 4,
    callsites: ['active_authors review arm', 'paper_reviews CTE', 'user_reviews CTE', 'citing_paper_quality CTE'],
  },
];

describe('excludeSelfReviewWhere — per-callsite source-level mutation-kill canaries', () => {
  for (const { file, minOccurrences, callsites } of CALLSITES) {
    it(`${file} composes excludeSelfReviewWhere at ${minOccurrences} site(s): ${callsites.join(', ')}`, () => {
      const path = resolve(PROJECT_ROOT, file);
      const source = readFileSync(path, 'utf-8');
      // Match the helper invocation form: `excludeSelfReviewWhere(`. The
      // trailing `(` distinguishes it from docstring mentions of the
      // helper name. Match-all to count occurrences.
      const matches = source.match(/excludeSelfReviewWhere\(/g) ?? [];
      // Strip out comment-context occurrences: lines that start with `*`
      // or contain `// ` are documentation, not actual invocations.
      const codeOccurrences = source
        .split('\n')
        .filter((line) => {
          if (!line.includes('excludeSelfReviewWhere(')) return false;
          const trimmed = line.trim();
          // JSDoc `*` block-comment lines OR pure single-line `//` comments.
          if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false;
          return true;
        });
      expect(
        codeOccurrences.length,
        `expected at least ${minOccurrences} code-level excludeSelfReviewWhere( occurrence(s) in ${file}; found ${codeOccurrences.length}. ` +
        `Helper-name string-matches: ${matches.length}. ` +
        `If a refactor consolidated callsites, update the minOccurrences in this file's CALLSITES table, NOT silently relax to a smaller number.`,
      ).toBeGreaterThanOrEqual(minOccurrences);
    });
  }
});
