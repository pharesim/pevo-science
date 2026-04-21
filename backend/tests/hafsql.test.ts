import { describe, it, expect } from 'vitest';
import { getPool, isHafAvailable } from '../src/db.js';
import {
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  buildWith,
} from '../src/hafsql.js';

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
      const unscopedRows = (await pool.query(
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
      const scopedRows = (await pool.query(
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
      const unscopedRows = (await pool.query(
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
      const scopedRows = (await pool.query(
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
