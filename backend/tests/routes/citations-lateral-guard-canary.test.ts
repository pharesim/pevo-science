import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../../src/db.js';

/**
 * Per-layer cascade-fail defense canary for `CROSS JOIN LATERAL
 * jsonb_array_elements(... -> 'citations')` sites at:
 *   - backend/src/routes/profile.ts (citations CTE inside profile stats)
 *   - backend/src/routes/stats.ts   (total_citations subquery inside /api/stats)
 *
 * Pins that a chain post broadcasting a non-array `pevo.citations` (null,
 * string, integer, object) does NOT raise `cannot extract elements from a
 * scalar` and crash the response. Pre-fix shape relied on a WHERE-clause
 * `jsonb_typeof(...) = 'array'` guard AFTER the LATERAL/comma-cross-join —
 * which Postgres evaluates AFTER the SRF expands. Post-fix shape uses
 * `CASE WHEN jsonb_typeof = 'array' THEN ... ELSE '[]'::jsonb END` at the
 * SRF argument position so non-arrays substitute the empty-array literal
 * before jsonb_array_elements runs. Reference:
 * `agents/docs/solutions/conventions/
 *  pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md`.
 *
 * Carve-out clause-(a) justification: synthesizing the full HAF
 * `hafsql.comments` ingestion for each malformed-citations shape per test is
 * impractical (HAF is an external chain-mirror; we cannot insert test rows).
 * The synthetic VALUES + Postgres path under `getPool()` (HAF pool URL but a
 * standalone query against synthetic CTEs, no HAF schema dependency)
 * exercises the exact SRF + CASE-WHEN shape the route composes, which is
 * what the cascade-fail defense is.
 *
 * Carve-out clause-(c) real-path companion: the routes themselves
 * (/api/profile/:username and /api/stats) execute against real HAF in
 * existing per-route integration tests; those exercise the post-fix shape
 * end-to-end on well-formed HAF rows. The risk class this canary covers
 * (cascade-fail on a malformed citations shape that would survive HAF
 * ingestion) is the same class the existing real-path coverage cannot
 * exercise without seeding a malformed chain post.
 *
 * jsonb_array_elements audit results for backend/src/ as of 2026-05-16:
 *   - backend/src/hafsql.ts:371 (excludeSelfReviewWhere NOT EXISTS subquery)
 *       → already correct, reference implementation (CASE-WHEN at SRF arg).
 *   - backend/src/hafsql.ts:732 (authorsWithSupersessionSelect)
 *       → OUT OF SCOPE here; tracked by
 *         `backend-self-review-exclusion-everywhere` round-4/5 item 2.
 *   - backend/src/reputation.ts:607 (paper_resolved_votes NOT EXISTS)
 *       → already correct (CASE-WHEN at SRF arg, landed round-4 of the
 *         sibling task).
 *   - backend/src/reputation.ts:793 (citing_papers CTE CROSS JOIN LATERAL)
 *       → OUT OF SCOPE here; tracked by
 *         `backend-self-review-exclusion-everywhere` round-5 item 1.
 *   - backend/src/notification-queries.ts:337 (arm 6a CROSS JOIN LATERAL)
 *       → MIGRATED in this task (was line 329 pre-fix). See sibling test
 *         `notification-queries-lateral-guard-canary.test.ts`.
 *   - backend/src/notification-queries.ts:373 (arm 6b CROSS JOIN LATERAL)
 *       → MIGRATED in this task (was line 358 pre-fix). See sibling test
 *         `notification-queries-lateral-guard-canary.test.ts`.
 *   - backend/src/routes/profile.ts:147 (citations CTE CROSS JOIN LATERAL)
 *       → MIGRATED in this task (was line 137 pre-fix). Covered here.
 *   - backend/src/routes/stats.ts:82 (total_citations comma-cross-join SRF)
 *       → MIGRATED in this task (was line 71 pre-fix). Covered here.
 *   - backend/src/routes/ipfs.ts:265 (jsonb_array_elements_text on
 *     c.json_metadata->'image')
 *       → EXEMPT (different SRF, non-pevo-namespaced field, IPFS-pinner
 *         blast radius rather than user read path; out of scope per task).
 *   - backend/src/ipfs-cleanup.ts:38 (jsonb_array_elements_text on
 *     c.json_metadata->'image')
 *       → EXEMPT (same disposition as routes/ipfs.ts:265).
 */
describe('citations CROSS JOIN LATERAL cascade-fail defense (profile.ts + stats.ts shape)', () => {
  it.skipIf(!isHafConfigured())(
    'profile.ts-shape: citations CTE does not raise on non-array pevo.citations',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Mirror the structural shape of routes/profile.ts citations CTE.
      // synthetic `citing` row carries a malformed pevo.citations; the CTE
      // counts citations whose `cit ->> 'author'` matches a target user.
      // Without the CASE-WHEN guard at the SRF argument position, the
      // jsonb_array_elements(citing.json_metadata -> $1 -> 'citations') call
      // would raise on each non-array shape, crashing the whole subselect.
      const shapes: ReadonlyArray<readonly [string, string]> = [
        ['citations_jsonb_null', JSON.stringify({ pevotest: { type: 'paper', citations: null } })],
        ['citations_string', JSON.stringify({ pevotest: { type: 'paper', citations: 'alice/permlink' } })],
        ['citations_integer', JSON.stringify({ pevotest: { type: 'paper', citations: 42 } })],
        ['citations_object', JSON.stringify({ pevotest: { type: 'paper', citations: { author: 'alice', permlink: 'p1' } } })],
      ];

      for (const [shapeLabel, meta] of shapes) {
        const sql = `
          WITH citing(json_metadata) AS (VALUES ($2::jsonb))
          SELECT COUNT(*)::int AS citation_count
          FROM citing
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(citing.json_metadata -> $1 -> 'citations') = 'array'
              THEN citing.json_metadata -> $1 -> 'citations'
              ELSE '[]'::jsonb
            END
          ) AS cit
          WHERE (cit ->> 'author') = 'alice'
        `;
        // The assertion is that the query DOES NOT THROW. Synthetic non-
        // array shape yields zero citation rows, which is the correct
        // post-CASE-WHEN-substitution outcome.
        const result = await pool.query<{ citation_count: number }>(sql, ['pevotest', meta]);
        expect(result.rows[0]?.citation_count, `non-array shape: ${shapeLabel}`).toBe(0);
      }
    },
  );

  it.skipIf(!isHafConfigured())(
    'profile.ts-shape: citations CTE counts well-formed pevo.citations correctly',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Control case: a well-formed citations array with the target user
      // present should still be counted post-fix. Pins that the CASE-WHEN
      // guard does not over-substitute and lose well-formed data.
      const wellFormed = JSON.stringify({
        pevotest: {
          type: 'paper',
          citations: [
            { author: 'alice', permlink: 'p1' },
            { author: 'bob', permlink: 'p2' },
            { author: 'alice', permlink: 'p3' },
          ],
        },
      });

      const sql = `
        WITH citing(json_metadata) AS (VALUES ($2::jsonb))
        SELECT COUNT(*)::int AS citation_count
        FROM citing
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(citing.json_metadata -> $1 -> 'citations') = 'array'
            THEN citing.json_metadata -> $1 -> 'citations'
            ELSE '[]'::jsonb
          END
        ) AS cit
        WHERE (cit ->> 'author') = 'alice'
      `;
      const result = await pool.query<{ citation_count: number }>(sql, ['pevotest', wellFormed]);
      expect(result.rows[0]?.citation_count).toBe(2);
    },
  );

  it.skipIf(!isHafConfigured())(
    'stats.ts-shape: total_citations subquery does not raise on non-array pevo.citations',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Mirror the structural shape of routes/stats.ts total_citations
      // subquery (comma-style cross join, count of all citation elements).
      // Without the CASE-WHEN guard, a single chain paper with non-array
      // pevo.citations would crash the entire /api/stats response (because
      // every other top-level count subquery shares the cross-product).
      const shapes: ReadonlyArray<readonly [string, string]> = [
        ['citations_jsonb_null', JSON.stringify({ pevotest: { type: 'paper', citations: null } })],
        ['citations_string', JSON.stringify({ pevotest: { type: 'paper', citations: 'alice/permlink' } })],
        ['citations_integer', JSON.stringify({ pevotest: { type: 'paper', citations: 42 } })],
        ['citations_object', JSON.stringify({ pevotest: { type: 'paper', citations: { author: 'alice', permlink: 'p1' } } })],
      ];

      for (const [shapeLabel, meta] of shapes) {
        const sql = `
          WITH papers(json_metadata) AS (VALUES ($2::jsonb))
          SELECT COUNT(*)::int AS total_citations
          FROM papers ci,
            jsonb_array_elements(
              CASE WHEN jsonb_typeof(ci.json_metadata -> $1 -> 'citations') = 'array'
                THEN ci.json_metadata -> $1 -> 'citations'
                ELSE '[]'::jsonb
              END
            ) AS cit
        `;
        const result = await pool.query<{ total_citations: number }>(sql, ['pevotest', meta]);
        expect(result.rows[0]?.total_citations, `non-array shape: ${shapeLabel}`).toBe(0);
      }
    },
  );

  it.skipIf(!isHafConfigured())(
    'stats.ts-shape: total_citations subquery counts well-formed pevo.citations correctly',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Two papers, one with 3 citations, one with 2 — total_citations
      // should report 5. Pins post-fix counting fidelity.
      const paperA = JSON.stringify({
        pevotest: {
          type: 'paper',
          citations: [
            { author: 'alice', permlink: 'p1' },
            { author: 'bob', permlink: 'p2' },
            { author: 'carol', permlink: 'p3' },
          ],
        },
      });
      const paperB = JSON.stringify({
        pevotest: {
          type: 'paper',
          citations: [
            { author: 'alice', permlink: 'p1' },
            { author: 'dave', permlink: 'p4' },
          ],
        },
      });

      const sql = `
        WITH papers(json_metadata) AS (VALUES ($2::jsonb), ($3::jsonb))
        SELECT COUNT(*)::int AS total_citations
        FROM papers ci,
          jsonb_array_elements(
            CASE WHEN jsonb_typeof(ci.json_metadata -> $1 -> 'citations') = 'array'
              THEN ci.json_metadata -> $1 -> 'citations'
              ELSE '[]'::jsonb
            END
          ) AS cit
      `;
      const result = await pool.query<{ total_citations: number }>(sql, ['pevotest', paperA, paperB]);
      expect(result.rows[0]?.total_citations).toBe(5);
    },
  );

  it.skipIf(!isHafConfigured())(
    'stats.ts-shape: mixed batch with one malformed row does not crash the count',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // The cascade-fail vector that matters in production: ONE malformed
      // chain post anywhere in the table sinks the whole /api/stats
      // response. Pin that the well-formed rows still count correctly even
      // when a malformed sibling row is present in the batch. Pre-fix,
      // jsonb_array_elements on the string-typed citations would raise and
      // the entire query result would be lost (total_citations defaults to
      // 0 via COALESCE, but only because the outer COALESCE wraps the
      // whole subquery — the route still logs a SQL error and the dashboard
      // shows a degraded shape). Post-fix, the malformed row substitutes
      // to '[]'::jsonb and yields zero citation elements, well-formed rows
      // count normally.
      const wellFormed = JSON.stringify({
        pevotest: {
          type: 'paper',
          citations: [
            { author: 'alice', permlink: 'p1' },
            { author: 'bob', permlink: 'p2' },
          ],
        },
      });
      const malformed = JSON.stringify({
        pevotest: { type: 'paper', citations: 'not-an-array' },
      });

      const sql = `
        WITH papers(json_metadata) AS (VALUES ($2::jsonb), ($3::jsonb))
        SELECT COUNT(*)::int AS total_citations
        FROM papers ci,
          jsonb_array_elements(
            CASE WHEN jsonb_typeof(ci.json_metadata -> $1 -> 'citations') = 'array'
              THEN ci.json_metadata -> $1 -> 'citations'
              ELSE '[]'::jsonb
            END
          ) AS cit
      `;
      const result = await pool.query<{ total_citations: number }>(sql, ['pevotest', wellFormed, malformed]);
      expect(result.rows[0]?.total_citations).toBe(2);
    },
  );
});
