/**
 * IPFS `image` SRF-argument-position array-guard defense.
 *
 * Two production sites invoke `jsonb_array_elements_text(c.json_metadata->'image')`
 * in a `CROSS JOIN LATERAL`-equivalent shape:
 *   - `backend/src/routes/ipfs.ts` `cidIsKnown` (the GET /ipfs/:cid gateway's
 *     CID-known check).
 *   - `backend/src/ipfs-cleanup.ts cidReferencedInHaf` (the cleanup job's
 *     CID-in-use check).
 *
 * Hive's `image` metadata is convention, not schema: any post can broadcast
 * a non-array `image` value (null, string, integer, object). Postgres
 * evaluates the LATERAL SRF before the surrounding WHERE — so a WHERE-side
 * `jsonb_typeof = 'array'` guard fires AFTER the SRF and is a placebo. The
 * fix is to move the type-guard INTO the SRF argument via CASE-WHEN with
 * `ELSE '[]'::jsonb` fallback.
 *
 * Failure mode without the guard:
 *   - `cidIsKnown`: GET /ipfs/:cid raises on every CID lookup while at least
 *     one post in scope has malformed `image`. Per-request fault.
 *   - `cidReferencedInHaf`: the periodic cleanup job crashes mid-sweep,
 *     leaving orphaned pending-upload rows and their pins until the
 *     malformed post is edited or removed.
 *
 * Carve-out clause-(c): synthetic-VALUES is justified because real-corpus
 * seeding of malformed-image Hive posts is impractical (the test corpus is
 * Mahdi's HAF; we do not control its content). The assertion (cascade-fail
 * defense + match-row shape) is exactly what the carve-out is for. The
 * shape mirrors the `citing_papers CROSS JOIN LATERAL cascade-fail defense`
 * test in `hafsql.test.ts` (the canonical reference pattern). Real-path
 * companion: the routes are exercised by existing IPFS upload/cleanup
 * tests against well-formed data; this file is the dedicated coverage for
 * the malformed-image cascade-fail class.
 *
 * See conventions:
 *   - pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16
 *   - pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12
 */

import { describe, it, expect } from 'vitest';
import { getPool } from '../../src/db.js';

// Mirror of the production SRF shape in both `cidIsKnown` and
// `cidReferencedInHaf`. Synthetic input substitutes a one-row `c`
// relation with controlled json_metadata so we exercise the CASE-WHEN
// array guard at the SRF argument position. The ILIKE/LIKE wrapper
// matches both call sites — both grep for the CID substring within
// the elements emitted by the SRF.
const guardedSrfShape = `
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(c.json_metadata->'image') = 'array'
           THEN c.json_metadata->'image'
           ELSE '[]'::jsonb
      END
    ) AS img
    WHERE img LIKE '%' || $1 || '%'
  ) AS matched
  FROM (SELECT $2::jsonb AS json_metadata) AS c
`;

describe('IPFS image SRF-argument array-guard (real Postgres, synthetic rows)', () => {
  it('does not throw on non-array image shapes (null, string, integer, object, missing)', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no app pool available');
      return;
    }

    // Each shape would, without the CASE-WHEN guard, raise
    // "cannot extract elements from a scalar" on the SRF. The CASE-WHEN
    // short-circuits to '[]', yielding zero LATERAL rows and a `matched`
    // of false without raising.
    const nonArrayShapes: ReadonlyArray<readonly [string, string]> = [
      ['image_jsonb_null', JSON.stringify({ image: null })],
      ['image_string', JSON.stringify({ image: 'https://example.test/a.png' })],
      ['image_integer', JSON.stringify({ image: 42 })],
      ['image_object', JSON.stringify({ image: { url: 'https://example.test/a.png' } })],
      ['image_missing', JSON.stringify({ title: 'no image field' })],
      ['top_level_null', JSON.stringify(null)],
    ];

    for (const [shapeLabel, meta] of nonArrayShapes) {
      const result = await pool.query(guardedSrfShape, ['QmFakeCid', meta]);
      expect(result.rows, `non-array shape: ${shapeLabel}`).toEqual([{ matched: false }]);
    }
  });

  it('matches a CID substring inside a well-formed image array (control case)', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no app pool available');
      return;
    }

    const cid = 'QmTargetCid123';
    const wellFormed = JSON.stringify({
      image: [
        'https://example.test/other.png',
        `https://example.test/${cid}.png`,
        'https://example.test/another.png',
      ],
    });

    const result = await pool.query(guardedSrfShape, [cid, wellFormed]);
    // The guard does NOT over-exclude: the SRF emits the URL strings,
    // the LIKE predicate matches the target CID, EXISTS evaluates true.
    expect(result.rows).toEqual([{ matched: true }]);
  });

  it('returns false for a well-formed image array with no matching CID', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no app pool available');
      return;
    }

    const wellFormed = JSON.stringify({
      image: ['https://example.test/a.png', 'https://example.test/b.png'],
    });

    const result = await pool.query(guardedSrfShape, ['QmAbsentCid', wellFormed]);
    expect(result.rows).toEqual([{ matched: false }]);
  });

  it('does not throw on top-level NULL json_metadata (SQL NULL, not JSONB null)', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no app pool available');
      return;
    }

    // SQL NULL on the column — `c.json_metadata->'image'` returns SQL NULL,
    // `jsonb_typeof(NULL)` returns NULL, the CASE evaluates ELSE and the
    // SRF gets '[]'::jsonb. The query yields one row with `matched=false`.
    const sql = `
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(c.json_metadata->'image') = 'array'
               THEN c.json_metadata->'image'
               ELSE '[]'::jsonb
          END
        ) AS img
        WHERE img LIKE '%' || $1 || '%'
      ) AS matched
      FROM (SELECT NULL::jsonb AS json_metadata) AS c
    `;
    const result = await pool.query(sql, ['QmFakeCid']);
    expect(result.rows).toEqual([{ matched: false }]);
  });
});
