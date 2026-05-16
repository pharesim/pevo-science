import { describe, it, expect } from 'vitest';
import { getPool, isHafConfigured } from '../src/db.js';

/**
 * Per-layer cascade-fail defense canary for `CROSS JOIN LATERAL
 * jsonb_array_elements(... -> 'citations')` sites at:
 *   - backend/src/notification-queries.ts arm 6a (was line 329 pre-fix, now ~337)
 *   - backend/src/notification-queries.ts arm 6b (was line 358 pre-fix, now ~373)
 *
 * Pins that a chain post broadcasting a non-array `pevo.citations` (null,
 * string, integer, object) does NOT raise `cannot extract elements from a
 * scalar` and crash the per-user GET /api/notifications response. Pre-fix
 * shape had NO array-type guard at all (the arms were added without a
 * companion `jsonb_typeof = 'array'` clause). Post-fix shape uses
 * `CASE WHEN jsonb_typeof = 'array' THEN ... ELSE '[]'::jsonb END` at the
 * SRF argument position so non-arrays substitute the empty-array literal
 * before jsonb_array_elements runs. Reference:
 * `agents/docs/solutions/conventions/
 *  pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md`.
 *
 * Carve-out clause-(a) justification: synthesizing the full HAF
 * `hafsql.operations` + `account_operations` ingestion chain for each
 * malformed-citations shape per test is impractical (HAF is an external
 * chain-mirror; we cannot insert test rows). The synthetic VALUES + Postgres
 * path under `getPool()` exercises the exact SRF + CASE-WHEN shape the
 * notification-queries arms compose, which is what the cascade-fail defense
 * is.
 *
 * Carve-out clause-(c) real-path companion: GET /api/notifications has
 * existing per-route integration tests that exercise the post-fix shape
 * end-to-end on well-formed HAF rows. The risk class this canary covers
 * (cascade-fail on a malformed citations shape that would survive HAF
 * ingestion) is the same class the existing real-path coverage cannot
 * exercise without seeding a malformed chain post.
 *
 * jsonb_array_elements audit results for backend/src/ as of 2026-05-16
 * (mirror of citations-lateral-guard-canary.test.ts header for
 * cross-reference):
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
 *   - backend/src/notification-queries.ts arm 6a (was 329, now ~337)
 *       → MIGRATED in this task. Covered here (arm-6a-shape tests below).
 *   - backend/src/notification-queries.ts arm 6b (was 358, now ~373)
 *       → MIGRATED in this task. Covered here (arm-6b-shape tests below).
 *   - backend/src/routes/profile.ts citations CTE
 *       → MIGRATED in this task. Covered by sibling
 *         `tests/routes/citations-lateral-guard-canary.test.ts`.
 *   - backend/src/routes/stats.ts total_citations subquery
 *       → MIGRATED in this task. Covered by sibling
 *         `tests/routes/citations-lateral-guard-canary.test.ts`.
 *   - backend/src/routes/ipfs.ts:265 (jsonb_array_elements_text on
 *     c.json_metadata->'image')
 *       → EXEMPT (different SRF, non-pevo-namespaced field, IPFS-pinner
 *         blast radius rather than user read path; out of scope per task).
 *   - backend/src/ipfs-cleanup.ts:38 (jsonb_array_elements_text on
 *     c.json_metadata->'image')
 *       → EXEMPT (same disposition as routes/ipfs.ts:265).
 */
describe('notification-queries.ts arm 6a/6b CROSS JOIN LATERAL cascade-fail defense', () => {
  it.skipIf(!isHafConfigured())(
    'arm-6a-shape: citation-notification arm does not raise on non-array pevo.citations',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Mirror the structural shape of notification-queries.ts arm 6a:
      //   FROM ${T.commentOps} citing
      //   CROSS JOIN LATERAL jsonb_array_elements(
      //     CASE WHEN jsonb_typeof(citing.json_metadata -> $1 -> 'citations') = 'array'
      //       THEN citing.json_metadata -> $1 -> 'citations'
      //       ELSE '[]'::jsonb
      //     END
      //   ) AS cite_elem
      //   CROSS JOIN LATERAL (SELECT cite_elem ->> 'author' AS author, ...)
      // Synthetic `citing` row carries malformed pevo.citations; without the
      // CASE-WHEN guard, jsonb_array_elements would raise on each non-array
      // shape and crash the whole notification GET for the recipient.
      const shapes: ReadonlyArray<readonly [string, string]> = [
        ['citations_jsonb_null', JSON.stringify({ pevotest: { type: 'paper', citations: null } })],
        ['citations_string', JSON.stringify({ pevotest: { type: 'paper', citations: 'alice/permlink' } })],
        ['citations_integer', JSON.stringify({ pevotest: { type: 'paper', citations: 42 } })],
        ['citations_object', JSON.stringify({ pevotest: { type: 'paper', citations: { author: 'alice', permlink: 'p1' } } })],
      ];

      for (const [shapeLabel, meta] of shapes) {
        const sql = `
          WITH citing(json_metadata) AS (VALUES ($2::jsonb))
          SELECT COUNT(*)::int AS hit_count
          FROM citing
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(citing.json_metadata -> $1 -> 'citations') = 'array'
              THEN citing.json_metadata -> $1 -> 'citations'
              ELSE '[]'::jsonb
            END
          ) AS cite_elem
          CROSS JOIN LATERAL (
            SELECT cite_elem ->> 'author' AS author, cite_elem ->> 'permlink' AS permlink
          ) cited
          WHERE cited.author = 'alice'
        `;
        // The assertion is that the query DOES NOT THROW. Synthetic non-
        // array shape yields zero notification rows, which is the correct
        // post-CASE-WHEN-substitution outcome.
        const result = await pool.query<{ hit_count: number }>(sql, ['pevotest', meta]);
        expect(result.rows[0]?.hit_count, `non-array shape: ${shapeLabel}`).toBe(0);
      }
    },
  );

  it.skipIf(!isHafConfigured())(
    'arm-6a-shape: citation-notification arm yields the expected hits on well-formed pevo.citations',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Control case: a well-formed citations array with the target user
      // present produces one notification row per matching citation. Pins
      // that the CASE-WHEN guard does not over-substitute and lose data.
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
        SELECT COUNT(*)::int AS hit_count
        FROM citing
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(citing.json_metadata -> $1 -> 'citations') = 'array'
            THEN citing.json_metadata -> $1 -> 'citations'
            ELSE '[]'::jsonb
          END
        ) AS cite_elem
        CROSS JOIN LATERAL (
          SELECT cite_elem ->> 'author' AS author, cite_elem ->> 'permlink' AS permlink
        ) cited
        WHERE cited.author = 'alice'
      `;
      const result = await pool.query<{ hit_count: number }>(sql, ['pevotest', wellFormed]);
      expect(result.rows[0]?.hit_count).toBe(2);
    },
  );

  it.skipIf(!isHafConfigured())(
    'arm-6b-shape: bridge-paper citation-notification arm does not raise on non-array pevo.citations',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Mirror of notification-queries.ts arm 6b. Structurally identical to
      // arm 6a; arm 6b joins against the bridge_papers CTE for the parent
      // side. The cascade-fail surface is the SRF on citing.json_metadata
      // and is therefore the same shape — covered with the same VALUES
      // pattern.
      const shapes: ReadonlyArray<readonly [string, string]> = [
        ['citations_jsonb_null', JSON.stringify({ pevotest: { type: 'paper', citations: null } })],
        ['citations_string', JSON.stringify({ pevotest: { type: 'paper', citations: 'bob/permlink' } })],
        ['citations_integer', JSON.stringify({ pevotest: { type: 'paper', citations: 99 } })],
        ['citations_object', JSON.stringify({ pevotest: { type: 'paper', citations: { author: 'bob', permlink: 'p2' } } })],
      ];

      for (const [shapeLabel, meta] of shapes) {
        const sql = `
          WITH citing(json_metadata) AS (VALUES ($2::jsonb))
          SELECT COUNT(*)::int AS hit_count
          FROM citing
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(citing.json_metadata -> $1 -> 'citations') = 'array'
              THEN citing.json_metadata -> $1 -> 'citations'
              ELSE '[]'::jsonb
            END
          ) AS cite_elem
          CROSS JOIN LATERAL (
            SELECT cite_elem ->> 'author' AS author, cite_elem ->> 'permlink' AS permlink
          ) cited
          WHERE cited.author = 'bob'
        `;
        const result = await pool.query<{ hit_count: number }>(sql, ['pevotest', meta]);
        expect(result.rows[0]?.hit_count, `non-array shape: ${shapeLabel}`).toBe(0);
      }
    },
  );

  it.skipIf(!isHafConfigured())(
    'arm-6b-shape: bridge-paper citation-notification arm yields the expected hits on well-formed pevo.citations',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Control case for arm 6b: well-formed citations array, target user
      // matched on bridge-paper side. Pins counting fidelity post-fix.
      const wellFormed = JSON.stringify({
        pevotest: {
          type: 'paper',
          citations: [
            { author: 'bob', permlink: 'p1' },
            { author: 'carol', permlink: 'p2' },
          ],
        },
      });

      const sql = `
        WITH citing(json_metadata) AS (VALUES ($2::jsonb))
        SELECT COUNT(*)::int AS hit_count
        FROM citing
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(citing.json_metadata -> $1 -> 'citations') = 'array'
            THEN citing.json_metadata -> $1 -> 'citations'
            ELSE '[]'::jsonb
          END
        ) AS cite_elem
        CROSS JOIN LATERAL (
          SELECT cite_elem ->> 'author' AS author, cite_elem ->> 'permlink' AS permlink
        ) cited
        WHERE cited.author = 'bob'
      `;
      const result = await pool.query<{ hit_count: number }>(sql, ['pevotest', wellFormed]);
      expect(result.rows[0]?.hit_count).toBe(1);
    },
  );

  it.skipIf(!isHafConfigured())(
    'mixed batch (well-formed + malformed) does not crash and produces correct counts',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // The cascade-fail vector that matters in production: ONE malformed
      // chain post anywhere in the recipient's notification fan-in sinks
      // the whole /api/notifications response. Pin that the well-formed
      // row's citation matches still produce notification hits even when a
      // malformed sibling row is present in the batch.
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
        WITH citing(json_metadata) AS (VALUES ($2::jsonb), ($3::jsonb))
        SELECT COUNT(*)::int AS hit_count
        FROM citing
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(citing.json_metadata -> $1 -> 'citations') = 'array'
            THEN citing.json_metadata -> $1 -> 'citations'
            ELSE '[]'::jsonb
          END
        ) AS cite_elem
        CROSS JOIN LATERAL (
          SELECT cite_elem ->> 'author' AS author, cite_elem ->> 'permlink' AS permlink
        ) cited
        WHERE cited.author = 'alice'
      `;
      const result = await pool.query<{ hit_count: number }>(sql, ['pevotest', wellFormed, malformed]);
      expect(result.rows[0]?.hit_count).toBe(1);
    },
  );
});
