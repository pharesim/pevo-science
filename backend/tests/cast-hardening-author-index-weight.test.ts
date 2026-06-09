import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPool, isHafConfigured } from '../src/db.js';

/**
 * Coverage for the regex-guarded integer casts on broadcaster-controlled
 * custom_json fields: `author_index` (claim_authorship) and `weight` (revote).
 *
 * A bare `(cj.json::jsonb ->> 'author_index')::int` / `... ->> 'weight')::int`
 * raises `invalid_text_representation` (non-numeric) or `integer out of range`
 * (overflow) on a single forged op, aborting the WHOLE query: every read query
 * touching the targeted paper 500s, and one bad event aborts the daily
 * `computeReputationBatch` for every user. The guard wraps each cast in a
 * `CASE WHEN <regex> THEN ...::int END` so a malformed value yields NULL and
 * the offending row drops gracefully while the query completes.
 *
 * Carve-out clause-(a): the production sites read HAF's custom_json mirror,
 * which cannot be seeded with the forged-op rows these cases require. The
 * behavioral case runs the guard expressions over a synthetic `WITH (VALUES
 * ...)` set through the real `getPool()` Postgres connection, so the actual
 * regex + `::int` cast semantics are exercised (a bare cast over these rows
 * would abort). Clause-(b): no auth middleware is in this SQL path. Clause-(c):
 * `reputation-lifecycle.test.ts` runs the assembled cycle against real HAF on
 * well-formed rows; the source-shape canaries below pin every production cast
 * site to the guard so the live path cannot regress to a bare cast.
 */

const AUTHOR_INDEX_GUARD = "~ '^[0-9]{1,9}$'";
const WEIGHT_GUARD = "~ '^-?[0-9]{1,9}$'";

describe('integer cast hardening — author_index / weight guards', () => {
  it.skipIf(!isHafConfigured())(
    'guarded casts drop malformed and overflow values to NULL and preserve legit integers (no query abort)',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Each synthetic row is a custom_json payload read via ->>, then run
      // through the exact production guard expressions. A bare ::int cast over
      // rows 1 and 2 would abort the whole query with invalid_text_representation
      // / integer-out-of-range; the guard must instead yield NULL and complete.
      const sql = `
        WITH cj(json) AS (
          VALUES
            ('{"author_index":"abc","weight":"abc"}'::text),
            ('{"author_index":"99999999999","weight":"99999999999999"}'::text),
            ('{"author_index":"0","weight":"10000"}'::text),
            ('{"author_index":"3","weight":"-10000"}'::text)
        )
        SELECT
          CASE WHEN (cj.json::jsonb ->> 'author_index') ${AUTHOR_INDEX_GUARD}
               THEN (cj.json::jsonb ->> 'author_index')::int END AS ai,
          CASE WHEN (cj.json::jsonb ->> 'weight') ${WEIGHT_GUARD}
               THEN (cj.json::jsonb ->> 'weight')::int END AS w
        FROM cj
      `;

      const { rows } = await pool.query<{ ai: number | null; w: number | null }>(sql);
      expect(rows).toEqual([
        { ai: null, w: null }, // non-integer -> dropped to NULL
        { ai: null, w: null }, // 11/14-digit overflow -> the {1,9} bound drops it
        { ai: 0, w: 10000 }, // legit non-negative index + positive weight
        { ai: 3, w: -10000 }, // legit index + NEGATIVE weight (downvote) preserved
      ]);
    },
  );

  // Source-shape canaries: every production cast over a broadcaster-controlled
  // author_index/weight is wrapped in its regex guard. Counting guarded-vs-total
  // catches a regression that reverts any single site to a bare ::int cast even
  // if the behavioral row set above is changed.
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  function castCounts(src: string, field: string, guard: string) {
    const total = (src.match(new RegExp(`\\(cj\\.json::jsonb ->> '${field}'\\)::int`, 'g')) || []).length;
    const guardEsc = guard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const guarded = (
      src.match(new RegExp(`${guardEsc}[\\s\\S]{0,40}?\\(cj\\.json::jsonb ->> '${field}'\\)::int`, 'g')) || []
    ).length;
    return { total, guarded };
  }

  it('every author_index/weight cast in the broadcaster-cast sites is regex-guarded', () => {
    const files = {
      '../src/hafsql.ts': read('../src/hafsql.ts'),
      '../src/reputation.ts': read('../src/reputation.ts'),
      '../src/routes/papers.ts': read('../src/routes/papers.ts'),
    };

    let totalAuthorIndex = 0;
    let totalWeight = 0;
    for (const [rel, src] of Object.entries(files)) {
      const ai = castCounts(src, 'author_index', AUTHOR_INDEX_GUARD);
      const w = castCounts(src, 'weight', WEIGHT_GUARD);
      expect(ai.guarded, `${rel}: unguarded author_index cast`).toBe(ai.total);
      expect(w.guarded, `${rel}: unguarded weight cast`).toBe(w.total);
      totalAuthorIndex += ai.total;
      totalWeight += w.total;
    }

    // Pin the known site inventory so an accidentally-deleted guarded site is
    // also caught: 1 author_index (hafsql claim_events — the reputation cycle now
    // composes that shared builder via authorshipClaimsCteBody instead of an
    // inline claim_events copy, so its former cast is gone) and 5 weight (3
    // reputation revote arms + 2 papers revote queries).
    expect(totalAuthorIndex).toBe(1);
    expect(totalWeight).toBe(5);
  });
});
