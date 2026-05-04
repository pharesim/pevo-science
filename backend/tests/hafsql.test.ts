import { describe, it, expect } from 'vitest';
import { getPool, isHafAvailable } from '../src/db.js';
import {
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  buildWith,
  validPevoPaperWhere,
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
  it.skipIf(!isHafAvailable())(
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

  it.skipIf(!isHafAvailable())(
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
