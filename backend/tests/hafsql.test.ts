import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../src/db.js';
import {
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  buildWith,
  validPevoPaperWhere,
  validReviewWhere,
} from '../src/hafsql.js';
import { queryWithRetry } from './support/haf-query.js';

/**
 * Scope-narrowing invariant: a scoped authorshipClaimsCteBody must return the
 * same rows as an unscoped one post-filtered in JS for the same key. If this
 * drifts (e.g. a scope filter matches fewer approve/revoke rows than the CASE
 * correlates on), status determination would silently change.
 *
 * When HAF has no claim events yet (fresh env), the tests explicitly SKIP
 * rather than trivially passing — the invariant only exists to be exercised.
 */
describe('authorshipClaimsCteBody scope', () => {
  it.skipIf(!isHafConfigured())(
    'claimer scope matches unscoped + post-filter',
    { timeout: 60_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const unscoped = buildWith(1, activeAccreditationsCteBody, authorshipClaimsCteBody);
      const unscopedRows = (await queryWithRetry(pool, 
        `${unscoped.sql} SELECT claimer, paper_author, paper_permlink, author_index, status, claimed_at FROM authorship_claims ORDER BY claimer, paper_author, paper_permlink, claimed_at`,
        unscoped.params,
      )).rows;

      const sampleClaimer = unscopedRows[0]?.claimer as string | undefined;
      if (!sampleClaimer) {
        ctx.skip('HAF has no authorship_claim events — invariant not exercisable');
        return;
      }

      const expected = unscopedRows.filter((r) => r.claimer === sampleClaimer);

      const scoped = buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { claimer: sampleClaimer }));
      const scopedRows = (await queryWithRetry(pool, 
        `${scoped.sql} SELECT claimer, paper_author, paper_permlink, author_index, status, claimed_at FROM authorship_claims ORDER BY claimer, paper_author, paper_permlink, claimed_at`,
        scoped.params,
      )).rows;

      expect(scopedRows).toEqual(expected);
    },
  );

  it.skipIf(!isHafConfigured())(
    'paper scope matches unscoped + post-filter',
    { timeout: 60_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const unscoped = buildWith(1, activeAccreditationsCteBody, authorshipClaimsCteBody);
      const unscopedRows = (await queryWithRetry(pool, 
        `${unscoped.sql} SELECT claimer, paper_author, paper_permlink, author_index, status, claimed_at FROM authorship_claims ORDER BY claimer, paper_author, paper_permlink, claimed_at`,
        unscoped.params,
      )).rows;

      const sample = unscopedRows[0];
      if (!sample) {
        ctx.skip('HAF has no authorship_claim events — invariant not exercisable');
        return;
      }

      const paperAuthor = sample.paper_author as string;
      const paperPermlink = sample.paper_permlink as string;
      const expected = unscopedRows.filter(
        (r) => r.paper_author === paperAuthor && r.paper_permlink === paperPermlink,
      );

      const scoped = buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { paperAuthor, paperPermlink }));
      const scopedRows = (await queryWithRetry(pool, 
        `${scoped.sql} SELECT claimer, paper_author, paper_permlink, author_index, status, claimed_at FROM authorship_claims ORDER BY claimer, paper_author, paper_permlink, claimed_at`,
        scoped.params,
      )).rows;

      expect(scopedRows).toEqual(expected);
    },
  );
});

/**
 * Pure param-arithmetic checks — no pool needed. Guards against drift in
 * scope-param accounting (e.g. forgetting to advance nextIdx after pushing a
 * scope param, or mis-sizing params such that a downstream $N+k binds to the
 * wrong value).
 */
describe('authorshipClaimsCteBody param arithmetic', () => {
  it('unscoped: nextIdx and params have the base 3 entries', () => {
    const frag = authorshipClaimsCteBody(5);
    // base params: [appTag, genesisBlock, appTag]; three $N consumed (5,6,7)
    expect(frag.params).toHaveLength(3);
    expect(frag.nextIdx).toBe(8);
  });

  it('claimer scope adds 1 param and advances nextIdx by 1', () => {
    const frag = authorshipClaimsCteBody(5, { claimer: 'alice' });
    expect(frag.params).toHaveLength(4);
    expect(frag.params[3]).toBe('alice');
    expect(frag.nextIdx).toBe(9);
  });

  it('paper scope adds 2 params and advances nextIdx by 2', () => {
    const frag = authorshipClaimsCteBody(5, { paperAuthor: 'bob', paperPermlink: 'p-1' });
    expect(frag.params).toHaveLength(5);
    expect(frag.params[3]).toBe('bob');
    expect(frag.params[4]).toBe('p-1');
    expect(frag.nextIdx).toBe(10);
  });
});

/**
 * validPevoPaperWhere() is the centralized predicate for "comment row is a
 * valid PEvO paper." Per the pevo-object-identity convention, every PEvO
 * surface that filters by paper-type MUST use this helper rather than
 * handcrafting the type literal — direct `'bridge_paper'` literals are
 * caught by the ESLint rule `pevo/no-bridge-paper-literal` (inline in
 * `eslint.config.mjs`), run via `npm run lint`.
 *
 * These unit tests pin the SQL-string shape produced by the helper so any
 * future edit that drops the bridge-author conjunct, drops the appTagParam
 * binding, or shifts the predicate grammar fails red.
 */
describe('validPevoPaperWhere SQL shape', () => {
  it('source=native produces type=paper match without author pin', () => {
    const sql = validPevoPaperWhere({
      commentAlias: 'c',
      appTagParam: '$1',
      bridgeAccountParam: '$2',
      source: 'native',
    });
    expect(sql).toBe("(c.json_metadata -> $1 ->> 'type') = 'paper'");
    // Native arm intentionally has no bridge-author conjunct.
    expect(sql).not.toContain('c.author = $2');
  });

  it('source=bridge pins author = bridgeAccountParam AND type = bridge_paper', () => {
    const sql = validPevoPaperWhere({
      commentAlias: 'c',
      appTagParam: '$1',
      bridgeAccountParam: '$2',
      source: 'bridge',
    });
    // Mutation-sensitive: removing the c.author = $2 conjunct fails this assertion.
    expect(sql).toContain('c.author = $2');
    expect(sql).toContain("'bridge_paper'");
    expect(sql).toContain('AND');
    // Both clauses are in a single conjunction (parenthesized so the OR-arm
    // composition in callers doesn't fall through).
    expect(sql.startsWith('(')).toBe(true);
    expect(sql.endsWith(')')).toBe(true);
  });

  it('source=all OR-composes native + pinned bridge', () => {
    const sql = validPevoPaperWhere({
      commentAlias: 'c',
      appTagParam: '$1',
      bridgeAccountParam: '$2',
    });
    // Both arms present.
    expect(sql).toContain("'paper'");
    expect(sql).toContain("'bridge_paper'");
    expect(sql).toContain('OR');
    // Critical: bridge arm pins the author. Removing this is the regression
    // we're guarding against.
    expect(sql).toContain('c.author = $2');
  });

  it('default source omitted is equivalent to source=all', () => {
    const omitted = validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$1', bridgeAccountParam: '$2' });
    const all = validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$1', bridgeAccountParam: '$2', source: 'all' });
    expect(omitted).toBe(all);
  });

  it('default commentAlias is "c" when omitted', () => {
    const sql = validPevoPaperWhere({ appTagParam: '$1', bridgeAccountParam: '$2', source: 'bridge' });
    expect(sql).toContain('c.author = $2');
    expect(sql).toContain('c.json_metadata');
  });

  it('custom commentAlias propagates through both arms', () => {
    const sql = validPevoPaperWhere({
      commentAlias: 'p',
      appTagParam: '$3',
      bridgeAccountParam: '$18',
      source: 'all',
    });
    expect(sql).toContain('p.author = $18');
    expect(sql).toContain('p.json_metadata -> $3');
    // Ensure no leftover 'c.' alias from a half-edit.
    expect(sql).not.toContain('c.author');
    expect(sql).not.toContain('c.json_metadata');
  });

  it('caller-allocated parameter strings flow verbatim', () => {
    // The helper does NOT allocate params; it interpolates the strings the
    // caller passes. This invariant is what lets routes share one paramIdx
    // across CTEs and the helper.
    const sql = validPevoPaperWhere({
      commentAlias: 'c',
      appTagParam: '$42',
      bridgeAccountParam: '$99',
      source: 'all',
    });
    expect(sql).toContain('$42');
    expect(sql).toContain('$99');
  });
});

/**
 * validReviewWhere() is the centralized predicate for "comment row is a
 * structurally valid PEvO review." Every review-aggregating site (paper
 * detail review list, listing review_count/avg_rating, profile reviews,
 * search, reputation's paper_reviews quality CTE, reputation's user_reviews
 * CTE, notifications) MUST compose against this helper. The display↔
 * reputation parity invariant requires one predicate everywhere.
 *
 * The pure-string assertions pin the SQL grammar so a future edit that
 * drops a rating dimension, reintroduces the app LIKE gate, or shifts the
 * regex shape fails red. The real-Postgres block exercises the predicate
 * against synthetic JSONB rows — no chain dependency, no HAF reads — to
 * confirm the per-axis admit/exclude semantics.
 */
describe('validReviewWhere SQL shape', () => {
  it('produces type+rating-shape predicate with no app LIKE gate', () => {
    const sql = validReviewWhere({ commentAlias: 'c', appTagParam: '$1' });
    expect(sql).toContain("(c.json_metadata -> $1 ->> 'type') = 'review'");
    expect(sql).toContain("c.json_metadata -> $1 -> 'rating' IS NOT NULL");
    // The app-LIKE gate was intentionally dropped — see helper docstring.
    expect(sql).not.toContain("'app'");
    expect(sql).not.toContain('LIKE');
  });

  it("includes all four rating dimensions with regex ~ '^[1-5]$'", () => {
    const sql = validReviewWhere({ commentAlias: 'c', appTagParam: '$1' });
    for (const dim of ['methodology', 'novelty', 'clarity', 'significance']) {
      expect(sql).toContain(`->> '${dim}'`);
    }
    expect(sql).toContain("~ '^[1-5]$'");
  });

  it('default commentAlias is "c" when omitted', () => {
    const sql = validReviewWhere({ appTagParam: '$1' });
    expect(sql).toContain('c.json_metadata');
    expect(sql).not.toContain('co.json_metadata');
  });

  it('custom commentAlias propagates through every clause (no leftover c. references)', () => {
    const sql = validReviewWhere({ commentAlias: 'co', appTagParam: '$3' });
    expect(sql).toContain("(co.json_metadata -> $3 ->> 'type') = 'review'");
    expect(sql).toContain("co.json_metadata -> $3 -> 'rating' IS NOT NULL");
    expect(sql).toContain("(co.json_metadata -> $3 -> 'rating' ->> 'methodology')  ~ '^[1-5]$'");
    // No leftover 'c.' alias from a half-edit.
    expect(sql).not.toMatch(/\bc\.json_metadata/);
  });

  it('caller-allocated appTagParam string flows verbatim', () => {
    const sql = validReviewWhere({ commentAlias: 'c', appTagParam: '$42' });
    expect(sql).toContain('$42');
    expect(sql).not.toContain('$1');
  });

  it('does NOT bake in the accreditation predicate (callers compose it)', () => {
    // Per the helper docstring: accreditation is intentionally outside the
    // helper because per-site forms differ (EXISTS / IN / JOIN / = ANY).
    // The parity invariant holds when callers add both this fragment AND
    // their accreditation predicate. Pin the helper's narrow scope here so
    // a future widening that bakes accreditation into the helper (which
    // would silently break the = ANY($N::text[]) sites at papers.ts:2199)
    // fails red.
    const sql = validReviewWhere({ commentAlias: 'c', appTagParam: '$1' });
    expect(sql).not.toContain('active_accreditations');
    expect(sql).not.toContain('hiveAnonAccount');
  });
});

/**
 * Real-Postgres behavioral test for validReviewWhere. Uses synthetic JSONB
 * rows assembled via VALUES() — no chain seeds, no HAF reads, fully
 * deterministic against the live Postgres pool. Tests the four valid/
 * invalid axes from the task acceptance criteria:
 *
 *   1. Valid review (integer ratings, no app gate) → admitted
 *   2. Valid review with foreign 'app' value → still admitted (gate dropped)
 *   3. Review-typed with missing rating → excluded
 *   4. Review-typed with partial rating (3 of 4 dimensions) → excluded
 *   5. Review-typed with non-numeric rating value → excluded
 *   6. Review-typed with out-of-range rating → excluded
 *
 * The accreditation gate is NOT exercised here — that's a callsite concern
 * pinned by the route-level tests in `tests/routes/reviews.test.ts` and
 * the existing real-HAF surfaces. This block isolates the type+rating-
 * shape gate that validReviewWhere is responsible for.
 */
describe('validReviewWhere behavioral matrix (real Postgres, synthetic JSONB)', () => {
  it.skipIf(!isHafConfigured())('admits valid and rejects malformed review-typed rows', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no pool available');
      return;
    }

    // Synthetic rows: each row is (label, json_metadata) where json_metadata
    // mimics what a chain comment row carries. The helper's appTagParam
    // binds to 'pevotest'.
    const rows = [
      ['valid_pevo_app', { app: 'pevotest/0.1', pevotest: { type: 'review', rating: { methodology: '4', novelty: '3', clarity: '5', significance: '4' } } }],
      ['valid_foreign_app', { app: 'peakd/2024', pevotest: { type: 'review', rating: { methodology: '5', novelty: '5', clarity: '5', significance: '5' } } }],
      ['valid_no_app_field', { pevotest: { type: 'review', rating: { methodology: '1', novelty: '2', clarity: '3', significance: '4' } } }],
      ['missing_rating', { app: 'pevotest/0.1', pevotest: { type: 'review' } }],
      ['partial_rating_3_of_4', { app: 'pevotest/0.1', pevotest: { type: 'review', rating: { methodology: '4', novelty: '3', clarity: '5' } } }],
      ['non_numeric_rating', { app: 'pevotest/0.1', pevotest: { type: 'review', rating: { methodology: 'five', novelty: '3', clarity: '5', significance: '4' } } }],
      ['out_of_range_high', { app: 'pevotest/0.1', pevotest: { type: 'review', rating: { methodology: '6', novelty: '3', clarity: '5', significance: '4' } } }],
      ['out_of_range_low', { app: 'pevotest/0.1', pevotest: { type: 'review', rating: { methodology: '0', novelty: '3', clarity: '5', significance: '4' } } }],
      ['decimal_rating', { app: 'pevotest/0.1', pevotest: { type: 'review', rating: { methodology: '4.5', novelty: '3', clarity: '5', significance: '4' } } }],
      ['paper_type', { app: 'pevotest/0.1', pevotest: { type: 'paper', rating: { methodology: '4', novelty: '3', clarity: '5', significance: '4' } } }],
      ['rating_is_string', { app: 'pevotest/0.1', pevotest: { type: 'review', rating: 'great' } }],
      ['rating_is_array', { app: 'pevotest/0.1', pevotest: { type: 'review', rating: [4, 3, 5, 4] } }],
    ];

    const valuesSql = rows.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3}::jsonb)`).join(', ');
    const params: unknown[] = ['pevotest'];
    for (const [label, meta] of rows) {
      params.push(label, JSON.stringify(meta));
    }

    const sql = `
      WITH synthetic(label, json_metadata) AS (VALUES ${valuesSql})
      SELECT c.label FROM synthetic c
      WHERE ${validReviewWhere({ commentAlias: 'c', appTagParam: '$1' })}
      ORDER BY c.label
    `;
    const result = await pool.query(sql, params);
    const admitted = result.rows.map((r) => r.label as string).sort();

    // Expected admit set: only the three "valid_*" rows. Every other row is
    // either wrong type, missing/partial/malformed rating, or
    // out-of-range — all of which the gate must exclude.
    expect(admitted).toEqual(['valid_foreign_app', 'valid_no_app_field', 'valid_pevo_app']);
  });
});
