import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../src/db.js';
import {
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  authorsWithSupersessionSelect,
  buildWith,
  retractedPapersCteBody,
  validPevoPaperWhere,
  validReviewWhere,
  excludeSelfReviewWhere,
  decayMultiplierSql,
  T,
} from '../src/hafsql.js';
import { config } from '../src/config.js';
import { queryWithRetry } from './support/haf-query.js';

describe('decayMultiplierSql', () => {
  // Snapshot pins the exact SQL the three *_scores CTEs (paper / review /
  // citation) share, so a one-site formatting tweak can no longer silently
  // desync paper/review/citation aging.
  it('emits the self-flooring CASE for the default cr/w aliases', () => {
    expect(decayMultiplierSql('up.created')).toBe(
      '(CASE WHEN EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) <= w.decay_grace_months THEN 1.0 ELSE GREATEST(w.decay_floor, 1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) - w.decay_grace_months) * w.decay_rate)) END)',
    );
  });

  it('threads the created column and the optional alias overrides', () => {
    expect(decayMultiplierSql('cpq.citing_created', { weightsAlias: 'ww', cycleRefAlias: 'crr' })).toBe(
      '(CASE WHEN EXTRACT(EPOCH FROM (crr.ref_ts - cpq.citing_created)) / (86400.0 * 30) <= ww.decay_grace_months THEN 1.0 ELSE GREATEST(ww.decay_floor, 1.0 - ((EXTRACT(EPOCH FROM (crr.ref_ts - cpq.citing_created)) / (86400.0 * 30) - ww.decay_grace_months) * ww.decay_rate)) END)',
    );
  });

  // The inner GREATEST is the only floor; the outer GREATEST(decay_floor, ...)
  // the call sites previously wrapped this in was redundant and is gone.
  it('contains exactly one GREATEST (no redundant outer floor)', () => {
    const sql = decayMultiplierSql('ur.created');
    expect((sql.match(/GREATEST\(/g) ?? []).length).toBe(1);
  });

  // Adoption pin: the three *_scores CTEs (paper / review / citation) must
  // consume this helper, never a re-inlined copy. A one-site revert to the
  // identical inline formula keeps the snapshots above AND every behavior test
  // green, silently reintroducing the per-site aging desync this helper exists
  // to kill. The helper body lives in hafsql.ts, so the inline decay token
  // `GREATEST(w.decay_floor` must NOT appear anywhere in reputation.ts source,
  // and the helper must be invoked exactly three times. Anchored on SQL/call
  // tokens (not line numbers), so it survives edits elsewhere in the file.
  it('is the sole decay source in reputation.ts — no re-inlined formula', () => {
    const src = readFileSync(new URL('../src/reputation.ts', import.meta.url), 'utf8');
    expect(src.match(/GREATEST\(w\.decay_floor/g) ?? []).toHaveLength(0);
    expect(src.match(/decayMultiplierSql\(/g) ?? []).toHaveLength(3);
  });
});

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
  // Base params: [appTag, appTag, hiveBridgeAccount, ...scope, hiveAdminAccount].
  // The bridge account backs the §2.10 approve signer gate; the admin account
  // (appended LAST, after any scope params, so the bridge/scope indices stay
  // fixed) backs the §2.11 revoke signer gate in the revoked arm. The inert
  // genesis-block floor was dropped, so the base carries no genesisBlock bind.
  it('unscoped: bridge + admin around an empty scope, nextIdx advances by 4', () => {
    const frag = authorshipClaimsCteBody(5);
    // $5/$6 appTag, $7 bridge, $8 admin → four $N consumed, nextIdx 9.
    expect(frag.params).toHaveLength(4);
    expect(frag.params[2]).toBe(config.hiveBridgeAccount);
    expect(frag.params[3]).toBe(config.hiveAdminAccount);
    expect(frag.nextIdx).toBe(9);
  });

  it('claimer scope inserts 1 param between bridge and admin, nextIdx advances by 5', () => {
    const frag = authorshipClaimsCteBody(5, { claimer: 'alice' });
    expect(frag.params).toHaveLength(5);
    expect(frag.params[2]).toBe(config.hiveBridgeAccount);
    expect(frag.params[3]).toBe('alice');
    expect(frag.params[4]).toBe(config.hiveAdminAccount);
    expect(frag.nextIdx).toBe(10);
  });

  it('paper scope inserts 2 params between bridge and admin, nextIdx advances by 6', () => {
    const frag = authorshipClaimsCteBody(5, { paperAuthor: 'bob', paperPermlink: 'p-1' });
    expect(frag.params).toHaveLength(6);
    expect(frag.params[2]).toBe(config.hiveBridgeAccount);
    expect(frag.params[3]).toBe('bob');
    expect(frag.params[4]).toBe('p-1');
    expect(frag.params[5]).toBe(config.hiveAdminAccount);
    expect(frag.nextIdx).toBe(11);
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
    // jsonb_typeof = 'object' replaces the prior `IS NOT NULL` line — the
    // bare null check passed JSONB null (PG semantics: 'null'::jsonb IS
    // NOT NULL returns TRUE) and lets JSONB strings/arrays/numbers
    // through. The jsonb_typeof shape narrows to objects only so the
    // intent matches the four-regex rating-dimension reads below.
    expect(sql).toContain("jsonb_typeof(c.json_metadata -> $1 -> 'rating') = 'object'");
    expect(sql).not.toContain("'rating' IS NOT NULL");
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
    expect(sql).toContain("jsonb_typeof(co.json_metadata -> $3 -> 'rating') = 'object'");
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
    // would silently break the `c.author = ANY($N::text[])` callsites in
    // the paper-detail review-listing handler in backend/src/routes/papers.ts)
    // fails red.
    const sql = validReviewWhere({ commentAlias: 'c', appTagParam: '$1' });
    expect(sql).not.toContain('active_accreditations');
    expect(sql).not.toContain('hiveAnonAccount');
  });
});

/**
 * Real-Postgres behavioral test for validReviewWhere. Uses synthetic JSONB
 * rows assembled via VALUES() — no chain seeds, no HAF reads, fully
 * deterministic against the live Postgres pool. Each axis below pins one
 * admit/exclude outcome of the rating-shape + review-type-tag gate:
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
      // Production chain rows carry JSON-integer ratings (`{methodology: 4, …}`),
      // not strings. The `->>` operator currently renders JSON integers as
      // their text form (`'4'`) so the regex passes, but a future Postgres
      // major or jsonb-codec change to integer rendering would silently
      // reject every valid review on the chain. Pin the int-form shape
      // alongside the string-form rows so the matrix catches that mutation.
      ['valid_int_rating', { app: 'pevotest/0.1', pevotest: { type: 'review', rating: { methodology: 4, novelty: 3, clarity: 5, significance: 4 } } }],
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
    expect(admitted).toEqual(['valid_foreign_app', 'valid_int_rating', 'valid_no_app_field', 'valid_pevo_app']);
  });
});

/**
 * excludeSelfReviewWhere() is the centralized self-review exclusion
 * predicate, mirroring the inline self-vote exclusion inside the
 * `paper_resolved_votes` CTE in backend/src/reputation.ts but for
 * review-class content. Every review-aggregating site (paper-detail
 * review list, listing review_count/
 * avg_rating, profile reviews, search reviews, stats reviews,
 * reputation's paper_reviews/user_reviews/citing-paper-quality CTEs)
 * MUST compose against this helper.
 *
 * The SQL-shape block pins the predicate grammar (parent-author check
 * AND co-author EXISTS subquery) so a regression dropping one of the
 * two conjuncts fails red. The real-Postgres behavioral matrix uses
 * synthetic JSONB rows — no chain seeds — to exercise the per-axis
 * admit/exclude semantics deterministically.
 */
describe('excludeSelfReviewWhere SQL shape', () => {
  it('produces paper-author check + co-author EXISTS subquery', () => {
    const sql = excludeSelfReviewWhere({ commentAlias: 'c', paperRowAlias: 'p', appTagParam: '$1' });
    expect(sql).toContain('c.author != p.author');
    expect(sql).toContain("p.json_metadata -> $1 -> 'authors'");
    expect(sql).toContain('jsonb_array_elements');
    // Canonicalized form: LOWER(TRIM(...)) plus the Hive-account charset
    // regex (mirrors normalizeHiveAccount). Pinning the canonical shape
    // catches a half-revert that drops either the LOWER/TRIM wrap, the
    // regex guard, or both.
    expect(sql).toContain("LOWER(TRIM(auth ->> 'hive')) ~ '^[a-z0-9.-]+$'");
    expect(sql).toContain("LOWER(TRIM(auth ->> 'hive')) = c.author");
    expect(sql).toContain('NOT EXISTS');
    // Pin the `jsonb_typeof(auth) = 'object'` guard inside the EXISTS
    // predicate. Without this assertion, reverting the object-type
    // tightening leaves the pure-unit shape tests green and only the
    // HAF-gated behavioral matrix catches the regression — defense-in-
    // depth-canary-must-pin-each-layer-2026-05-07.
    expect(sql).toContain("jsonb_typeof(auth) = 'object'");
  });

  it('custom aliases propagate through both conjuncts', () => {
    const sql = excludeSelfReviewWhere({ commentAlias: 'rv', paperRowAlias: 'up', appTagParam: '$3' });
    expect(sql).toContain('rv.author != up.author');
    expect(sql).toContain('up.json_metadata -> $3');
    expect(sql).toContain("LOWER(TRIM(auth ->> 'hive')) = rv.author");
    // No leftover defaults from a half-edit.
    expect(sql).not.toMatch(/\bc\.author/);
    expect(sql).not.toMatch(/\bp\.json_metadata/);
  });

  it('caller-allocated appTagParam string flows verbatim', () => {
    const sql = excludeSelfReviewWhere({ commentAlias: 'c', paperRowAlias: 'p', appTagParam: '$42' });
    expect(sql).toContain('$42');
    expect(sql).not.toContain('$1');
  });
});

/**
 * Real-Postgres behavioral test for excludeSelfReviewWhere. Uses
 * synthetic paper+review pairs via VALUES() — no chain dependency.
 * Each axis below pins one admit/exclude outcome of the parent-author
 * + co-author-EXISTS conjuncts:
 *
 *   1. Self-review by paper author → excluded
 *   2. Self-review by named co-author → excluded
 *   3. Review by non-author accredited reviewer → admitted (control)
 *   4. Review on a paper with empty authors[] still excludes the
 *      paper_author (the parent-author conjunct fires independent of
 *      the co-author EXISTS)
 *   5. Co-author with a case-different hive name → excluded: the helper
 *      canonicalizes the broadcast hive via LOWER(TRIM(...)) + the
 *      Hive-account charset regex before matching, so a {hive: 'Bob'}
 *      author entry is recognized as the lowercase 'bob' reviewer and
 *      its self-review is excluded.
 */
describe('excludeSelfReviewWhere behavioral matrix (real Postgres, synthetic rows)', () => {
  it.skipIf(!isHafConfigured())('admits non-author reviews and excludes self/co-author reviews', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no pool available');
      return;
    }

    // Synthetic universe: one paper "alice/p1" with authors. The third
    // author entry is deliberately uppercase ("Bob") to mirror the
    // broadcaster-spoofable mid-case shape that triggers this helper's
    // normalization. A separate uppercase entry ("Eve") tests that a
    // co-author entry that lands outside the Hive-account charset (mixed
    // case + would-be-conformant after normalization) is also rejected.
    const paperAuthors = JSON.stringify([
      { hive: 'alice' },
      { hive: 'Bob' },
      { hive: ' carol-padded ' },
    ]);
    const paperMeta = JSON.stringify({ pevotest: { type: 'paper', authors: JSON.parse(paperAuthors) } });

    const reviews = [
      ['self_review_by_paper_author', 'alice'],
      ['self_review_by_uppercase_named_coauthor', 'bob'],
      ['self_review_by_whitespace_padded_named_coauthor', 'carol-padded'],
      ['third_party_review', 'dave'],
      ['review_by_anon_proxy', 'pevotest.anon'],
    ];

    const valuesSql = reviews.map((_, i) => `($${i * 2 + 3}::text, $${i * 2 + 4}::text)`).join(', ');
    const params: unknown[] = ['pevotest', paperMeta];
    for (const [label, reviewer] of reviews) {
      params.push(label, reviewer);
    }

    const sql = `
      WITH paper_aliased AS (SELECT 'alice'::text AS author, $2::jsonb AS json_metadata),
           review_rows(label, author) AS (VALUES ${valuesSql})
      SELECT c.label FROM review_rows c
      CROSS JOIN paper_aliased p
      WHERE ${excludeSelfReviewWhere({ commentAlias: 'c', paperRowAlias: 'p', appTagParam: '$1' })}
      ORDER BY c.label
    `;
    const result = await pool.query(sql, params);
    const admitted = result.rows.map((r) => r.label as string).sort();

    // Expected admit set: only the non-author reviewers (dave + anon
    // proxy). Excluded:
    //   - self_review_by_paper_author (alice == p.author)
    //   - self_review_by_uppercase_named_coauthor: paper carries
    //     {hive: 'Bob'} (broadcaster-spoofed uppercase); the helper now
    //     canonicalizes the broadcast hive via LOWER(TRIM(...)) + the
    //     Hive-account charset regex, matching the JS-side
    //     normalizeHiveAccount wrapper. The reviewer 'bob' (lowercase
    //     consensus account) is therefore correctly recognized as a
    //     named co-author and excluded.
    //   - self_review_by_whitespace_padded_named_coauthor: same shape
    //     with ASCII-space padding stripped by TRIM.
    expect(admitted).toEqual(['review_by_anon_proxy', 'third_party_review']);
  });

  it.skipIf(!isHafConfigured())('paper-author check fires even when authors[] is missing or empty', { timeout: 30_000 }, async (ctx) => {
    // The two conjuncts are independent: even if pevo.authors[] is
    // missing/empty (jsonb_array_elements returns no rows, NOT EXISTS
    // returns true), the c.author != p.author check still excludes the
    // paper author. This guards against a future refactor that conflates
    // the two conjuncts.
    const pool = getPool();
    if (!pool) {
      ctx.skip('no pool available');
      return;
    }

    const paperMetaNoAuthors = JSON.stringify({ pevotest: { type: 'paper' } });
    const paperMetaEmptyAuthors = JSON.stringify({ pevotest: { type: 'paper', authors: [] } });

    for (const [shapeLabel, meta] of [['no_authors_field', paperMetaNoAuthors], ['empty_authors_array', paperMetaEmptyAuthors]] as const) {
      const sql = `
        WITH paper_aliased AS (SELECT 'alice'::text AS author, $2::jsonb AS json_metadata),
             review_rows(label, author) AS (VALUES
               ('self', 'alice'::text),
               ('third_party', 'carol'::text)
             )
        SELECT c.label FROM review_rows c
        CROSS JOIN paper_aliased p
        WHERE ${excludeSelfReviewWhere({ commentAlias: 'c', paperRowAlias: 'p', appTagParam: '$1' })}
        ORDER BY c.label
      `;
      const result = await pool.query(sql, ['pevotest', meta]);
      const admitted = result.rows.map((r) => r.label as string).sort();
      expect(admitted, `paper shape: ${shapeLabel}`).toEqual(['third_party']);
    }
  });

  // Pin the helper's behavior on malformed `pevo.authors` shapes that
  // occur on the public chain (anyone can post arbitrary JSON).
  // Two failure-mode classes are tested here:
  //   (1) non-array top-level shapes (null, string, integer, object) —
  //       jsonb_array_elements raises a runtime error on a non-array JSONB
  //       argument. The CASE WHEN jsonb_typeof = 'array' guard inside the
  //       helper short-circuits these to '[]'::jsonb so the EXISTS subquery
  //       returns 0 rows without throwing. Without the guard, the reputation
  //       cycle cascade-fails for every user.
  //   (2) array-of-non-objects elements (bare strings, integers, null,
  //       objects-without-'hive'-key) — the tightened EXISTS predicate
  //       requires jsonb_typeof(auth) = 'object' AND auth ->> 'hive' = ...
  //       This guard is a cascade-fail defense, NOT a co-author admission
  //       tightening. Under `authors: ["alice","bob"]`, bob (named as a
  //       bare string, NOT as an object with a `hive` key) IS admitted as
  //       a non-self reviewer: the object-type filter rejects the bare
  //       strings, EXISTS yields 0 rows, NOT EXISTS evaluates TRUE, and
  //       bob passes the second conjunct of `excludeSelfReviewWhere`. This
  //       is INTENTIONAL per
  //       `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28`:
  //       a PEvO co-author entry is a well-formed object with a `hive`
  //       key, not a free-text identity claim. Treating bare strings as
  //       co-author identity would let anyone broadcast a non-paper post
  //       with `authors: [target]` to lock `target` out of reviewing. The
  //       assertion below pins bob as admitted; the comment block at the
  //       array-of-non-objects loop expands the rationale.
  //
  // Both failure modes carry hidden-by-`jsonb_typeof`-or-EXISTS-fall-through
  // semantics that look correct until the chain produces the specific shape.
  it.skipIf(!isHafConfigured())('does not throw and does not over-admit on malformed pevo.authors shapes', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no pool available');
      return;
    }

    // (1) Non-array top-level authors — helper guards against
    // jsonb_array_elements raising on non-array JSONB.
    const nonArrayShapes: ReadonlyArray<readonly [string, string]> = [
      ['authors_jsonb_null', JSON.stringify({ pevotest: { type: 'paper', authors: null } })],
      ['authors_string', JSON.stringify({ pevotest: { type: 'paper', authors: 'alice' } })],
      ['authors_integer', JSON.stringify({ pevotest: { type: 'paper', authors: 42 } })],
      ['authors_object', JSON.stringify({ pevotest: { type: 'paper', authors: { hive: 'alice' } } })],
    ];

    for (const [shapeLabel, meta] of nonArrayShapes) {
      const sql = `
        WITH paper_aliased AS (SELECT 'alice'::text AS author, $2::jsonb AS json_metadata),
             review_rows(label, author) AS (VALUES
               ('self', 'alice'::text),
               ('third_party', 'carol'::text)
             )
        SELECT c.label FROM review_rows c
        CROSS JOIN paper_aliased p
        WHERE ${excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: '$1' })}
        ORDER BY c.label
      `;
      // Must NOT throw. Equivalent admit set to the empty-array case:
      // only the third_party row survives; alice is excluded by
      // c.author != p.author.
      const result = await pool.query(sql, ['pevotest', meta]);
      const admitted = result.rows.map((r) => r.label as string).sort();
      expect(admitted, `non-array shape: ${shapeLabel}`).toEqual(['third_party']);
    }

    // (2) Array of non-objects — pins the INTENTIONAL admission outcome
    // for malformed `authors[]` element shapes. The `jsonb_typeof(auth) =
    // 'object'` guard inside the EXISTS predicate is a cascade-fail
    // defense, not a co-author admission tightening. Under `authors:
    // ["alice","bob"]`, bob (named as a bare string, NOT as an object
    // with a `hive` key) IS admitted as a non-self reviewer: the EXISTS
    // subquery's object-type filter rejects the bare strings, EXISTS
    // yields 0 rows, NOT EXISTS evaluates TRUE, and bob passes the
    // second conjunct of `excludeSelfReviewWhere`. Only the first
    // conjunct (c.author != p.author) excludes alice.
    //
    // This is INTENTIONAL per
    // `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28`:
    // a PEvO co-author entry is a well-formed object with a `hive` key,
    // not a free-text identity claim. Treating bare strings as co-author
    // identity would let anyone broadcast a non-paper post with `authors:
    // [target]` to lock `target` out of reviewing the parent paper. The
    // accepted trade-off: malformed-bare-string entries don't elevate
    // someone into co-author status (and thus don't exclude them from
    // reviewing), but the helper also doesn't crash on the malformed
    // shape.
    //
    // Behavioral pin: alice excluded (c.author != p.author), bob and
    // carol both admitted.
    const arrayOfStrings = JSON.stringify({ pevotest: { type: 'paper', authors: ['alice', 'bob'] } });
    const arrayOfNulls = JSON.stringify({ pevotest: { type: 'paper', authors: [null] } });
    const arrayOfObjectsWithoutHive = JSON.stringify({ pevotest: { type: 'paper', authors: [{ name: 'alice' }] } });

    for (const [shapeLabel, meta] of [
      ['authors_array_of_strings', arrayOfStrings],
      ['authors_array_of_nulls', arrayOfNulls],
      ['authors_array_objects_without_hive', arrayOfObjectsWithoutHive],
    ] as const) {
      const sql = `
        WITH paper_aliased AS (SELECT 'alice'::text AS author, $2::jsonb AS json_metadata),
             review_rows(label, author) AS (VALUES
               ('self', 'alice'::text),
               ('bob_named_as_string', 'bob'::text),
               ('third_party', 'carol'::text)
             )
        SELECT c.label FROM review_rows c
        CROSS JOIN paper_aliased p
        WHERE ${excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: '$1' })}
        ORDER BY c.label
      `;
      const result = await pool.query(sql, ['pevotest', meta]);
      const admitted = result.rows.map((r) => r.label as string).sort();
      // alice excluded by c.author != p.author. bob and carol both
      // admitted: the malformed-element `jsonb_typeof(auth) = 'object'`
      // guard short-circuits the co-author EXISTS check on bare-string
      // entries (per the rationale block above). Bob is INTENTIONALLY
      // admitted — bare-string entries are not co-author identity claims
      // per the pevo-object-identity-is-author-vouching convention.
      // The helper must NOT raise on malformed shapes (cascade-fail
      // defense), and the first conjunct (c.author != p.author) still
      // excludes the paper author regardless of how malformed authors[]
      // is.
      expect(admitted, `array-of-non-objects shape: ${shapeLabel}`).toEqual(['bob_named_as_string', 'third_party']);
    }
  });
});

/**
 * Hive-username auto-accept arm of `authorshipClaimsCteBody` — broadcaster-
 * controlled `authors[i].hive` must be canonicalized via LOWER(TRIM(...))
 * plus the Hive-account charset regex before byte-equality against the
 * chain-validated lowercase `cb.claimer`. Without normalization, a
 * mid-case entry (`{hive: 'Alice'}`) leaves a legitimate co-author's claim
 * pending; with normalization, the claim auto-accepts as the spec intends.
 *
 * Synthetic-VALUES approach mirrors the `paper_resolved_votes` test below:
 * the production CTE chains many tables (`active_accreditations`, the
 * comments table, the claim-events custom_json projection); rebuilding the
 * full chain with seeded data per shape per test is impractical. The
 * assertion shape (admit/reject against the auto-accept arm) is exactly
 * what the test-mock carve-out clause-(c) is for. The real-path companion
 * is the sibling helper-output canary (`authorshipClaimsCteBody hive-
 * username auto-accept SQL-shape canary`) that calls the production helper
 * and asserts the post-fix predicate substrings appear in its emitted SQL;
 * deeper integrated coverage would require seeded HAF fixtures, which are
 * not yet available.
 */
/**
 * Helper-output canary for the hive-username auto-accept arm. Calls the
 * production helper and asserts that both canonicalization conjuncts —
 * `LOWER(TRIM(... ->> 'hive')) ~ '^[a-z0-9.-]+$'` (charset guard) and
 * `LOWER(TRIM(...)) = cb.claimer` (equality after normalization) — appear
 * in the emitted SQL. A targeted revert that drops either conjunct from
 * the helper turns this canary red, providing the real-path coverage
 * companion the synthetic-VALUES behavioral test below references.
 */
describe('authorshipClaimsCteBody hive-username auto-accept SQL-shape canary', () => {
  it('emits LOWER(TRIM(...)) charset-regex and equality conjuncts at the auto-accept arm', () => {
    const frag = authorshipClaimsCteBody(1);
    // Charset guard conjunct on the broadcaster-controlled hive value.
    expect(frag.sql).toMatch(
      /LOWER\(TRIM\(c\.json_metadata -> \$2 -> 'authors' -> cb\.author_index ->> 'hive'\)\) ~ '\^\[a-z0-9\.-\]\+\$'/,
    );
    // Equality conjunct after the same canonicalization, against the
    // chain-validated lowercase `cb.claimer`.
    expect(frag.sql).toMatch(
      /LOWER\(TRIM\(c\.json_metadata -> \$2 -> 'authors' -> cb\.author_index ->> 'hive'\)\) = cb\.claimer/,
    );
  });
});

describe('authorshipClaimsCteBody hive-username auto-accept normalization (real Postgres, synthetic rows)', () => {
  it('canonicalizes broadcast pevo.authors[i].hive before matching claimer', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no pool available');
      return;
    }

    // Mirror the auto-accept EXISTS arm. Two synthetic shapes:
    //   (1) broadcaster posted `{hive: 'Alice'}` (uppercase) — claimer
    //       'alice' SHOULD match post-normalization.
    //   (2) broadcaster posted `{hive: ' carol-padded '}` (ASCII-space
    //       padded) — claimer 'carol-padded' SHOULD match post-trim.
    //   (3) broadcaster posted `{hive: 'al;ice'}` (off-charset) — no
    //       claimer should match (regex guard rejects).
    const scenarios = [
      { label: 'uppercase_match', claimer: 'alice', authorsJson: JSON.stringify([{ hive: 'Alice' }]) },
      { label: 'whitespace_padded_match', claimer: 'carol-padded', authorsJson: JSON.stringify([{ hive: ' carol-padded ' }]) },
      { label: 'off_charset_reject', claimer: 'alice', authorsJson: JSON.stringify([{ hive: 'al;ice' }]) },
    ];

    for (const sc of scenarios) {
      // Mirror the auto-accept arm's predicate shape (without the full CTE
      // surrounding it). The fragment is the textual core of the post-fix
      // arm: LOWER(TRIM(... ->> 'hive')) regex + equality.
      const sql = `
        SELECT EXISTS (
          SELECT 1 FROM jsonb_array_elements($1::jsonb) elem
          WHERE LOWER(TRIM(elem ->> 'hive')) ~ '^[a-z0-9.-]+$'
            AND LOWER(TRIM(elem ->> 'hive')) = $2::text
        ) AS hit
      `;
      const result = await pool.query(sql, [sc.authorsJson, sc.claimer]);
      const hit = result.rows[0].hit as boolean;
      if (sc.label === 'off_charset_reject') {
        expect(hit, `scenario: ${sc.label}`).toBe(false);
      } else {
        expect(hit, `scenario: ${sc.label}`).toBe(true);
      }
    }
  });
});

/**
 * Pin the cascade-fail defense at the `paper_resolved_votes` CTE in
 * backend/src/reputation.ts. The CTE has its own inline
 * `jsonb_array_elements(up.json_metadata -> $3 -> 'authors')` shape — it
 * does NOT route through `excludeSelfReviewWhere`. Without a CASE-WHEN
 * `jsonb_typeof = 'array'` guard, a chain post broadcasting non-array
 * `pevo.authors` raises `cannot extract elements from a scalar` at runtime
 * and the entire daily reputation cycle cascade-fails for every user.
 *
 * This test exercises the production CTE's NOT EXISTS subquery shape
 * against synthetic VALUES() rows under real Postgres, asserting:
 *   (1) malformed top-level shapes (null/string/integer/object) do NOT raise
 *       and admit the third-party voter as expected
 *   (2) the inner `jsonb_typeof(a) = 'object'` guard is a cascade-fail
 *       defense (it prevents `jsonb_array_elements` and `->> 'hive'` from
 *       operating on scalar elements), NOT a co-author admission
 *       tightening. Bare-string elements (`authors: ["alice","bob"]`) ARE
 *       admitted as non-self voters — they are not identity claims per
 *       `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28`
 *
 * Carve-out clause-(c): synthetic-VALUES is justified because seeding the
 * full reputation cycle's `user_papers` + `paper_latest_votes` chain with
 * malformed-authors data per shape per test is impractical; the assertion
 * (cascade-fail defense + admit-set shape) is exactly what the carve-out
 * is for. No real-path companion exists for `paper_resolved_votes` — the
 * sibling `review-parity-invariant.test.ts` covers the `paper_reviews`
 * CTE (a different code path), NOT `paper_resolved_votes`. This synthetic-
 * VALUES test is the load-bearing coverage for `paper_resolved_votes`'s
 * cascade-fail defense; a future task may add an integrated real-HAF
 * companion if a corpus of malformed-authors papers becomes seedable.
 */
describe('paper_resolved_votes NOT EXISTS subquery cascade-fail defense (real Postgres, synthetic rows)', () => {
  // Note: this test uses synthetic VALUES() against the app Postgres pool —
  // it does NOT query HAF. Gating on `isHafConfigured()` would skip on
  // HAF-flake (the most common flake mode). Gate only on getPool() being
  // available; if app Postgres is up, the test runs.
  it('does not throw on malformed pevo.authors and admits the expected voters', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no pool available');
      return;
    }

    // `subqueryShape` is a LOCAL constant that mirrors the production
    // `paper_resolved_votes` NOT EXISTS subquery from `reputation.ts` as of
    // the time this test was authored. It is intentionally a structural
    // mirror, not a substring scrape of the production source: the test
    // pins the BEHAVIOR of this local string against real Postgres
    // (cascade-fail defense + admit-set shape under malformed/canonicalized
    // authors), it does NOT pin that production still composes its CTE
    // this way. A targeted revert of the LOWER(TRIM(...)) wrap in
    // production leaves this test GREEN — the test's mutation-kill reach
    // is: if `subqueryShape` here drifts from production and is re-derived
    // by a future maintainer, the test catches the drift only via that
    // re-derivation. Closing the gap to a true production-source canary
    // would require a separate grep-anchor test (see the existing
    // `excludeSelfReviewWhere-callsite-canaries.test.ts` pattern); not
    // included here by design.
    const subqueryShape = `
      NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(up.json_metadata -> $1 -> 'authors') = 'array'
            THEN up.json_metadata -> $1 -> 'authors'
            ELSE '[]'::jsonb
          END
        ) a
        WHERE jsonb_typeof(a) = 'object'
          AND LOWER(TRIM(a ->> 'hive')) ~ '^[a-z0-9.-]+$'
          AND LOWER(TRIM(a ->> 'hive')) = plv.voter
      )
    `;

    // (1) Non-array top-level authors — without the guard, jsonb_array_elements
    // would raise on each shape and crash every user's cycle compute.
    const nonArrayShapes: ReadonlyArray<readonly [string, string]> = [
      ['authors_jsonb_null', JSON.stringify({ pevotest: { type: 'paper', authors: null } })],
      ['authors_string', JSON.stringify({ pevotest: { type: 'paper', authors: 'alice' } })],
      ['authors_integer', JSON.stringify({ pevotest: { type: 'paper', authors: 42 } })],
      ['authors_object', JSON.stringify({ pevotest: { type: 'paper', authors: { hive: 'alice' } } })],
    ];

    for (const [shapeLabel, meta] of nonArrayShapes) {
      const sql = `
        WITH up AS (SELECT 'alice'::text AS author, $2::jsonb AS json_metadata),
             plv(voter) AS (VALUES
               ('alice'::text),
               ('carol'::text)
             )
        SELECT plv.voter FROM plv
        CROSS JOIN up
        WHERE plv.voter != up.author
          AND ${subqueryShape}
        ORDER BY plv.voter
      `;
      const result = await pool.query(sql, ['pevotest', meta]);
      const admitted = result.rows.map((r) => r.voter as string).sort();
      // alice excluded by plv.voter != up.author. carol admitted (the
      // guard short-circuits to '[]' and NOT EXISTS evaluates TRUE).
      expect(admitted, `non-array shape: ${shapeLabel}`).toEqual(['carol']);
    }

    // (2) Array-of-non-objects elements — pins the inner object-type guard.
    // Without it, `a ->> 'hive'` on bare-string elements returns NULL,
    // EXISTS yields 0 rows for every voter, and NOT EXISTS admits all of
    // them. The intentional outcome (per
    // pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28):
    // a bare-string `bob` entry is NOT a co-author identity claim, so bob
    // votes ARE admitted as non-self votes.
    const arrayOfStrings = JSON.stringify({ pevotest: { type: 'paper', authors: ['alice', 'bob'] } });
    const sql = `
      WITH up AS (SELECT 'alice'::text AS author, $2::jsonb AS json_metadata),
           plv(voter) AS (VALUES
             ('alice'::text),
             ('bob'::text),
             ('carol'::text)
           )
      SELECT plv.voter FROM plv
      CROSS JOIN up
      WHERE plv.voter != up.author
        AND ${subqueryShape}
      ORDER BY plv.voter
    `;
    const result = await pool.query(sql, ['pevotest', arrayOfStrings]);
    const admitted = result.rows.map((r) => r.voter as string).sort();
    // alice excluded by plv.voter != up.author. bob admitted (bare-string
    // not treated as identity claim). carol admitted.
    expect(admitted).toEqual(['bob', 'carol']);

    // (3) Well-formed authors — co-author IS excluded as a voter.
    // Control case pins that the guard doesn't over-exclude well-formed data.
    const wellFormed = JSON.stringify({
      pevotest: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] },
    });
    const sql2 = `
      WITH up AS (SELECT 'alice'::text AS author, $2::jsonb AS json_metadata),
           plv(voter) AS (VALUES
             ('alice'::text),
             ('bob'::text),
             ('carol'::text)
           )
      SELECT plv.voter FROM plv
      CROSS JOIN up
      WHERE plv.voter != up.author
        AND ${subqueryShape}
      ORDER BY plv.voter
    `;
    const result2 = await pool.query(sql2, ['pevotest', wellFormed]);
    const admitted2 = result2.rows.map((r) => r.voter as string).sort();
    // alice excluded (paper author), bob excluded (named co-author), carol admitted.
    expect(admitted2).toEqual(['carol']);

    // (4) Broadcaster-canonicalization arm: mid-case `authors[i].hive` MUST
    // still be treated as a co-author identity claim (excluded from the
    // non-self vote set). Without LOWER(TRIM(...)) on the broadcaster value,
    // an uppercase `'Bob'` byte-mismatches against the chain-validated
    // lowercase voter column `plv.voter`, NOT EXISTS evaluates TRUE for bob,
    // and bob's vote inflates the paper-author's reputation. This pins the
    // BEHAVIOR of the local `subqueryShape` constant above; per that
    // constant's header docblock, this assertion does NOT pin the
    // production CTE — a production-only revert leaves it green.
    const uppercaseCoauthor = JSON.stringify({
      pevotest: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'Bob' }] },
    });
    const sql3 = `
      WITH up AS (SELECT 'alice'::text AS author, $2::jsonb AS json_metadata),
           plv(voter) AS (VALUES
             ('alice'::text),
             ('bob'::text),
             ('carol'::text)
           )
      SELECT plv.voter FROM plv
      CROSS JOIN up
      WHERE plv.voter != up.author
        AND ${subqueryShape}
      ORDER BY plv.voter
    `;
    const result3 = await pool.query(sql3, ['pevotest', uppercaseCoauthor]);
    const admitted3 = result3.rows.map((r) => r.voter as string).sort();
    // alice excluded (paper author), bob excluded (uppercase co-author
    // canonicalized), carol admitted as the only third-party voter.
    expect(admitted3).toEqual(['carol']);
  });
});

/**
 * Pin the cascade-fail defense at the `citing_papers` CTE in
 * backend/src/reputation.ts. The CTE uses `CROSS JOIN LATERAL
 * jsonb_array_elements(citing.json_metadata -> $3 -> 'citations')` to
 * walk the citations array.
 * Postgres evaluates LATERAL BEFORE the WHERE clause, so a pre-existing
 * `WHERE jsonb_typeof(...) = 'array'` guard was a placebo — the SRF
 * expanded first on every row regardless of the WHERE filter. A chain
 * post broadcasting non-array `pevo.citations` would raise "cannot
 * extract elements from a scalar" and cascade-fail the daily reputation
 * cycle for every user. Fix: move the type-guard INTO the SRF argument
 * via CASE-WHEN with `ELSE '[]'::jsonb` fallback.
 *
 * Carve-out clause-(c): synthetic-VALUES is justified because seeding the
 * full reputation cycle's user_papers + citing-papers chain with
 * malformed-citations data per shape per test is impractical; the
 * assertion (cascade-fail defense + admit-set shape) is exactly what the
 * carve-out is for. No real-path companion exists for `citing_papers` —
 * this synthetic-VALUES test is the load-bearing coverage for the CTE's
 * cascade-fail defense.
 *
 * See conventions:
 *   - pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16
 *   - pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12
 */
describe('citing_papers CROSS JOIN LATERAL cascade-fail defense (real Postgres, synthetic rows)', () => {
  // Synthetic VALUES() against app Postgres — no HAF queries. Gate on
  // getPool() availability rather than isHafConfigured().
  it('does not throw on malformed pevo.citations and yields the expected citation rows', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no pool available');
      return;
    }

    // Mirror of the production CTE's CROSS JOIN LATERAL shape at the
    // `citing_papers` CTE in reputation.ts. Synthetic input substitutes a
    // one-row `citing` relation with controlled json_metadata so we
    // exercise the CASE-WHEN array guard at the SRF argument position.
    //
    // Drift-reach: a production-side revert of the CASE-WHEN guard at the
    // `citing_papers` CTE leaves this test green — the behavioral test
    // exercises this inlined SQL string, not the production source. The
    // structural canary that pins the production site against drift lives
    // in the `excludeSelfReviewWhere-callsite-canaries.test.ts`-style
    // coverage (the same drift-reach gap acknowledged on `subqueryShape`
    // above). The parallel `authorsWithSupersessionSelect` cascade-fail
    // test below calls the production helper directly, so its mutation
    // reach does extend to the production source.
    const lateralShape = `
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(citing.json_metadata -> $1 -> 'citations') = 'array'
             THEN citing.json_metadata -> $1 -> 'citations'
             ELSE '[]'::jsonb
        END
      ) AS cit
    `;

    // (1) Non-array top-level shapes. Without the guard, jsonb_array_elements
    // would raise on each shape and crash the cycle. The CASE-WHEN
    // short-circuits to '[]', yielding zero LATERAL rows (no citation
    // edges emitted) without raising.
    const nonArrayShapes: ReadonlyArray<readonly [string, string]> = [
      ['citations_jsonb_null', JSON.stringify({ pevotest: { type: 'paper', citations: null } })],
      ['citations_string', JSON.stringify({ pevotest: { type: 'paper', citations: 'foo' } })],
      ['citations_integer', JSON.stringify({ pevotest: { type: 'paper', citations: 42 } })],
      ['citations_object', JSON.stringify({ pevotest: { type: 'paper', citations: { author: 'alice' } } })],
    ];

    for (const [shapeLabel, meta] of nonArrayShapes) {
      const sql = `
        WITH citing AS (SELECT 'someone'::text AS author, 'p1'::text AS permlink, $2::jsonb AS json_metadata)
        SELECT (cit ->> 'author') AS cited_author
        FROM citing
        ${lateralShape}
      `;
      const result = await pool.query(sql, ['pevotest', meta]);
      // Zero rows: the CASE-WHEN substituted '[]'::jsonb, so the SRF
      // emitted nothing. The query did NOT raise.
      expect(result.rows, `non-array shape: ${shapeLabel}`).toEqual([]);
    }

    // (2) Well-formed citations array. Control case pins that the guard
    // doesn't over-exclude — the citation edges enumerate normally.
    const wellFormed = JSON.stringify({
      pevotest: {
        type: 'paper',
        citations: [
          { author: 'alice', permlink: 'paper-a' },
          { author: 'bob', permlink: 'paper-b' },
        ],
      },
    });
    const sql = `
      WITH citing AS (SELECT 'someone'::text AS author, 'p1'::text AS permlink, $2::jsonb AS json_metadata)
      SELECT (cit ->> 'author') AS cited_author
      FROM citing
      ${lateralShape}
      ORDER BY cited_author
    `;
    const result = await pool.query(sql, ['pevotest', wellFormed]);
    const cited = result.rows.map((r) => r.cited_author as string);
    expect(cited).toEqual(['alice', 'bob']);
  });
});

/**
 * Pin the cascade-fail defense at the `authorsWithSupersessionSelect`
 * helper in backend/src/hafsql.ts. The helper projects the per-author
 * supersession block on `/api/papers` (list) and `/api/papers/:author/
 * :permlink` (detail) via `jsonb_array_elements(... -> 'authors') WITH
 * ORDINALITY`. Without a CASE-WHEN `jsonb_typeof = 'array'` guard at the
 * SRF argument position, a paper whose chain `pevo.authors` is a non-array
 * JSONB (null, string, integer, object) raises "cannot extract elements
 * from a scalar" and the entire paper-listing request crashes site-wide.
 *
 * Unlike the `paper_resolved_votes` / `citing_papers` behavioral tests
 * above (which exercise an INLINED mirror of the production SQL and so
 * have no production-source mutation reach), this test calls the
 * production helper directly. A revert of the CASE-WHEN guard inside
 * `authorsWithSupersessionSelect` fails this test red — the mutation reach
 * extends to the production source.
 *
 * Carve-out clause-(c): synthetic-VALUES is justified because seeding the
 * public HAF corpus with a paper carrying malformed `pevo.authors` per
 * shape per test is impractical; the assertion (cascade-fail defense +
 * COALESCE empty-vs-populated shape) is exactly what the carve-out is for.
 * Per the convention that bare-string `authors[]` entries are NOT identity
 * claims (`pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28`),
 * a well-formed-object author with a `hive` key enriches normally while
 * malformed/scalar shapes collapse to an empty projected array.
 *
 * See conventions:
 *   - pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12
 */
describe('authorsWithSupersessionSelect SRF cascade-fail defense (real Postgres, synthetic rows)', () => {
  // Synthetic VALUES() against app Postgres — no HAF queries. Gate on
  // getPool() availability rather than isHafConfigured() so the canary
  // does not skip on the common HAF-flake mode.
  it('does not throw on malformed pevo.authors and projects the expected authors', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no pool available');
      return;
    }

    // The helper requires `active_accreditations` to be in scope. An empty
    // accreditation set suffices for the cascade-fail assertion: the
    // LEFT JOIN finds no match, so every projected author carries
    // orcid_verified=null / orcid_discrepancy=false. The load-bearing
    // assertion is that the SRF does not raise on malformed authors[].
    const projection = authorsWithSupersessionSelect('c', '$1');
    // The projection references `aa.researcher_name` (name-supersession), so
    // the inlined CTE must expose that column too — an empty set still
    // suffices for the cascade-fail assertion.
    const withEmptyAccred = `
      WITH active_accreditations(account, orcid, researcher_name) AS (
        SELECT NULL::text, NULL::text, NULL::text WHERE false
      )
    `;

    // (1) Non-array top-level shapes. Without the SRF-argument guard,
    // jsonb_array_elements would raise on each shape and crash the listing
    // request. The CASE-WHEN substitutes '[]'::jsonb, the jsonb_agg returns
    // SQL NULL, and the outer COALESCE collapses it to '[]'::jsonb.
    const nonArrayShapes: ReadonlyArray<readonly [string, string]> = [
      ['authors_jsonb_null', JSON.stringify({ pevotest: { type: 'paper', authors: null } })],
      ['authors_string', JSON.stringify({ pevotest: { type: 'paper', authors: 'alice' } })],
      ['authors_integer', JSON.stringify({ pevotest: { type: 'paper', authors: 42 } })],
      ['authors_object', JSON.stringify({ pevotest: { type: 'paper', authors: { hive: 'alice' } } })],
    ];

    for (const [shapeLabel, meta] of nonArrayShapes) {
      const sql = `
        ${withEmptyAccred}, paper(json_metadata) AS (SELECT $2::jsonb)
        SELECT (${projection}) AS authors_with_supersession
        FROM paper c
      `;
      const result = await pool.query(sql, ['pevotest', meta]);
      // Must NOT throw. Empty projected authors array for every non-array
      // top-level shape (the SRF saw '[]'::jsonb).
      expect(result.rows[0].authors_with_supersession, `non-array shape: ${shapeLabel}`).toEqual([]);
    }

    // (2) Array-of-non-objects elements — must NOT raise. The bare-string
    // 'alice' and JSON null elements resolve no name: their name-COALESCE arms
    // (researcher_name / ->>'name' / ->>'hive' / ->>'orcid') are all NULL on a
    // non-object element, so the projection's degenerate-drop WHERE removes
    // them. Only the { name: 'nohive' } object survives. The load-bearing
    // assertion is that the SRF did not raise on the malformed array.
    const arrayOfNonObjects = JSON.stringify({
      pevotest: { type: 'paper', authors: ['alice', null, { name: 'nohive' }] },
    });
    {
      const sql = `
        ${withEmptyAccred}, paper(json_metadata) AS (SELECT $2::jsonb)
        SELECT (${projection}) AS authors_with_supersession
        FROM paper c
      `;
      const result = await pool.query(sql, ['pevotest', arrayOfNonObjects]);
      const projected = result.rows[0].authors_with_supersession as Array<Record<string, unknown>>;
      // The bare-string and null elements name no one and are dropped; only
      // { name: 'nohive' } survives. It carries a null hive (no JOIN match)
      // and orcid_discrepancy=false / orcid_verified=null.
      expect(projected).toHaveLength(1);
      expect(projected[0].name).toBe('nohive');
      expect(projected[0].hive).toBeNull();
      expect(projected[0].orcid_discrepancy).toBe(false);
      expect(projected[0].orcid_verified).toBeNull();
    }

    // (3) Well-formed control — a single object author with a hive key
    // projects its name/hive/orcid normally. With no matching
    // accreditation, orcid_verified is null and orcid_discrepancy false.
    const wellFormed = JSON.stringify({
      pevotest: {
        type: 'paper',
        authors: [{ name: 'Alice A.', hive: 'alice', orcid: '0000-0001-1234-5678' }],
      },
    });
    {
      const sql = `
        ${withEmptyAccred}, paper(json_metadata) AS (SELECT $2::jsonb)
        SELECT (${projection}) AS authors_with_supersession
        FROM paper c
      `;
      const result = await pool.query(sql, ['pevotest', wellFormed]);
      const projected = result.rows[0].authors_with_supersession as Array<Record<string, unknown>>;
      expect(projected).toHaveLength(1);
      expect(projected[0].name).toBe('Alice A.');
      expect(projected[0].hive).toBe('alice');
      expect(projected[0].orcid).toBe('0000-0001-1234-5678');
      expect(projected[0].orcid_verified).toBeNull();
      expect(projected[0].orcid_discrepancy).toBe(false);
    }

    // (4) Positive degenerate-drop control — a well-named author beside a
    // degenerate { affiliation: 'x' } entry that resolves no name (every
    // name-COALESCE arm NULL). The degenerate entry is dropped from the
    // projected rows; only the named author survives. This is the SQL surface
    // of the name-soundness drop (the JS `applyAuthorSupersession` /
    // cumulative-union paths drop the same entry), so single-link SQL no
    // longer emits a `{ name: null }` author.
    const withDegenerate = JSON.stringify({
      pevotest: {
        type: 'paper',
        authors: [{ name: 'Keeper', hive: 'keeper' }, { affiliation: 'x' }],
      },
    });
    {
      const sql = `
        ${withEmptyAccred}, paper(json_metadata) AS (SELECT $2::jsonb)
        SELECT (${projection}) AS authors_with_supersession
        FROM paper c
      `;
      const result = await pool.query(sql, ['pevotest', withDegenerate]);
      const projected = result.rows[0].authors_with_supersession as Array<Record<string, unknown>>;
      expect(projected).toHaveLength(1);
      expect(projected[0].name).toBe('Keeper');
      expect(projected[0].hive).toBe('keeper');
    }
  });
});

/**
 * Pin the SQL-side name-supersession + read-time fallback projection in
 * `authorsWithSupersessionSelect`, the SQL/JS parity counterpart of the JS-side
 * `resolveAuthorName` (`backend/src/lib/author-supersession.ts`). The
 * projected `name` is
 * `COALESCE(NULLIF(aa.researcher_name,''), NULLIF(a.elem->>'name',''),
 * NULLIF(a.elem->>'hive',''), NULLIF(a.elem->>'orcid',''))`. Both surfaces
 * MUST agree: an accredited author's attested name wins silently, and a
 * Hive-/ORCID-only credit still surfaces a display name.
 *
 * Carve-out clause-(c): synthetic-VALUES is justified because seeding the
 * public HAF corpus with an accredited account whose attested name differs
 * from a paper's broadcaster claim, per case per test, is impractical; the
 * assertion (name COALESCE precedence) is exactly what the carve-out is for.
 * The real-path companion is the cross-surface parity canary in
 * `papers.test.ts`, which exercises this projection over live corpus rows.
 */
describe('authorsWithSupersessionSelect name-supersession + fallback (real Postgres, synthetic rows)', () => {
  it('supersedes accredited names and applies the read-time fallback chain', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no pool available');
      return;
    }
    const projection = authorsWithSupersessionSelect('c', '$1');
    // alice is accredited with attested name "Alice Anderson"; bob is
    // accredited with an empty attested name (must fall through, not shadow
    // the broadcaster value with '').
    const withAccred = `
      WITH active_accreditations(account, orcid, researcher_name) AS (
        VALUES ('alice'::text, NULL::text, 'Alice Anderson'::text),
               ('bob'::text,   NULL::text, ''::text)
      )
    `;
    const meta = JSON.stringify({
      pevotest: {
        type: 'paper',
        authors: [
          { name: 'Al', hive: 'alice' },              // accredited → attested name wins
          { name: 'Robert', hive: 'bob' },            // accredited, empty attested → broadcaster name
          { hive: 'carol' },                          // unaccredited, no name → hive handle
          { orcid: '0000-0003-4444-5555' },           // Hive-less, no name → orcid
          { name: 'Dave Display' },                   // Hive-less, broadcaster name
        ],
      },
    });
    const sql = `
      ${withAccred}, paper(json_metadata) AS (SELECT $2::jsonb)
      SELECT (${projection}) AS authors_with_supersession
      FROM paper c
    `;
    const result = await pool.query(sql, ['pevotest', meta]);
    const projected = result.rows[0].authors_with_supersession as Array<Record<string, unknown>>;
    expect(projected.map((a) => a.name)).toEqual([
      'Alice Anderson',       // attested supersedes 'Al'
      'Robert',               // empty attested name falls through to broadcaster
      'carol',                // hive-handle fallback
      '0000-0003-4444-5555',  // orcid fallback
      'Dave Display',         // broadcaster name
    ]);
    // Name-supersession is silent — no name_discrepancy / name_verified key
    // is added to the projection (contrast ORCID supersession).
    for (const author of projected) {
      expect(author).not.toHaveProperty('name_discrepancy');
      expect(author).not.toHaveProperty('name_verified');
    }
  });
});

/**
 * Pure param-arithmetic checks for retractedPapersCteBody — no pool needed.
 * The body binds two params (appTag, admin account) where it once bound one
 * (appTag), advancing nextIdx from p+1 to p+2. A desync between params.length
 * and nextIdx misbinds every downstream $N in buildWith-composed queries
 * (papers list, search) with no type error and no pg driver throw, which would
 * silently undo the forgery gate. Mirrors the authorshipClaimsCteBody param
 * arithmetic block above.
 */
describe('retractedPapersCteBody param arithmetic', () => {
  it('startIdx=1: 2 params [appTag, admin], nextIdx=3', () => {
    const frag = retractedPapersCteBody(1);
    expect(frag.params).toHaveLength(2);
    expect(frag.params[0]).toBe(config.appTag);
    expect(frag.params[1]).toBe(config.hiveAdminAccount);
    expect(frag.nextIdx).toBe(3);
  });

  it('startIdx=5: binds $5/$6 and advances nextIdx to 7', () => {
    const frag = retractedPapersCteBody(5);
    expect(frag.params).toHaveLength(2);
    expect(frag.nextIdx).toBe(7);
    // The emitted SQL must reference the allocated indices, not stale $1/$2.
    expect(frag.sql).toContain('cj.custom_id = $5');
    expect(frag.sql).toContain('cj.required_posting_auths ? $6');
  });
});

/**
 * SQL-shape canary for retractedPapersCteBody — pure unit, no pool. Pins the
 * load-bearing forgery gate at the unit layer so a regression is caught even
 * when the HAF pool is unavailable and the behavioral matrix below skips
 * (defense-in-depth: pin each layer, mirroring the excludeSelfReviewWhere SQL
 * shape / behavioral matrix pair).
 *
 * The gate is `required_posting_auths ? $admin`. A JSONB-operator typo
 * (`?` -> `->>`), a revert to the single-param `custom_id`-only form, or a
 * widen to the plural `?|` array form each re-opens the vector where anyone
 * can suppress a victim's paper from listings/search by broadcasting a
 * forged retract_paper custom_json. Singular `?` is correct because the admin
 * account is singular by design (see CLAUDE.md).
 */
describe('retractedPapersCteBody SQL shape', () => {
  it('emits all three conjuncts including the singular admin-auth gate', () => {
    const frag = retractedPapersCteBody(1);
    expect(frag.sql).toContain('cj.custom_id = $1');
    expect(frag.sql).toContain("cj.json::jsonb ->> 'action' = 'retract_paper'");
    expect(frag.sql).toContain('cj.required_posting_auths ? $2');
    // Singular membership operator, not the plural array form — pinning this
    // catches a `?` -> `?|` widen that would accept multi-key auth arrays.
    expect(frag.sql).not.toContain('?|');
  });
});

/**
 * Real-Postgres behavioral matrix for the retracted-paper forgery gate. Runs
 * the PRODUCTION retractedPapersCteBody SQL with its `FROM <custom_json view>`
 * source redirected to a synthetic VALUES CTE of the same column shape
 * (custom_id text, json text, required_posting_auths jsonb). Redirecting the
 * source rather than re-deriving the predicate locally means a production
 * revert of the gate predicate turns this test red — the structural-mirror
 * approach used by the paper_resolved_votes / citing_papers CTE tests stays
 * green under a production-only revert and would not satisfy that requirement.
 *
 * Synthetic VALUES (no chain seeds) is required here: the pevotest namespace
 * has zero retract_paper ops on-chain, so a live-HAF test passes trivially and
 * exercises nothing. The matrix below seeds the admin-authored and forged rows
 * deterministically. Gates on getPool() (not isHafConfigured()) so the canary
 * does not skip on the common HAF-flake mode — the query touches no HAF tables.
 *
 * The shared retractedPapersCteBody predicate is identical to the inline copies
 * in loadRetractedPapers and isRetracted (routes/papers.ts), so one CTE-level
 * behavioral pin plus the param-arithmetic block above locks the risk class
 * across all three sites.
 */
describe('retractedPapersCteBody forgery-gate behavioral matrix (real Postgres, synthetic rows)', () => {
  it('treats admin-authored retractions as valid and ignores forged ones', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no pool available');
      return;
    }

    const admin = config.hiveAdminAccount;
    // Each row's (author, permlink) is the only thing the CTE projects, so a
    // distinct permlink per row makes the admit set identifiable. The label
    // in the comment names the conjunct each row exercises.
    const rows: ReadonlyArray<{ permlink: string; customId: string; action: string; auths: string[] }> = [
      // admin-authored retraction → ADMITTED (the legitimate path)
      { permlink: 'admin-retracted', customId: config.appTag, action: 'retract_paper', auths: [admin] },
      // admin co-signed alongside another auth → ADMITTED (`?` is array
      // membership, not exact-equality; a real co-sign requires the admin key)
      { permlink: 'admin-cosigned', customId: config.appTag, action: 'retract_paper', auths: ['someone.else', admin] },
      // forged by a non-admin broadcaster → REJECTED (the gate)
      { permlink: 'forged-by-nonadmin', customId: config.appTag, action: 'retract_paper', auths: ['attacker'] },
      // forged with empty auth array → REJECTED (the gate)
      { permlink: 'forged-empty-auths', customId: config.appTag, action: 'retract_paper', auths: [] },
      // admin auth but foreign custom_id → REJECTED (custom_id conjunct)
      { permlink: 'wrong-app', customId: 'otherapp', action: 'retract_paper', auths: [admin] },
      // admin auth but non-retraction action → REJECTED (action conjunct)
      { permlink: 'wrong-action', customId: config.appTag, action: 'accredit', auths: [admin] },
    ];

    // Production fragment: $1 = appTag, $2 = admin account. Synthetic VALUES
    // params start at $3. Redirect the HAF view reference to the synthetic CTE.
    const frag = retractedPapersCteBody(1);
    const redirected = frag.sql.replace(T.customJson, 'synthetic_cj');

    const valuesSql = rows
      .map((_, i) => `($${i * 3 + 3}::text, $${i * 3 + 4}::text, $${i * 3 + 5}::jsonb)`)
      .join(', ');
    const params: unknown[] = [...frag.params];
    for (const row of rows) {
      params.push(
        row.customId,
        JSON.stringify({ action: row.action, author: 'victim', permlink: row.permlink }),
        JSON.stringify(row.auths),
      );
    }

    const sql = `
      WITH synthetic_cj(custom_id, json, required_posting_auths) AS (VALUES ${valuesSql}),
      ${redirected}
      SELECT author, permlink FROM retracted_papers ORDER BY permlink
    `;
    const result = await pool.query(sql, params);
    const admitted = result.rows.map((r) => `${r.author}/${r.permlink}` as string).sort();

    // Only the two admin-authored rows survive the gate. If the
    // required_posting_auths gate is removed/weakened, the forged rows leak
    // into the admit set and this assertion fails red.
    expect(admitted).toEqual(['victim/admin-cosigned', 'victim/admin-retracted']);
  });
});
