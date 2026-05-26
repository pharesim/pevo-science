/**
 * IPFS `image` SRF-argument-position array-guard defense.
 *
 * One production site invokes `jsonb_array_elements_text(c.json_metadata->'image')`
 * in a `CROSS JOIN LATERAL`-equivalent shape: the shared
 * `cidReferencedByAppTag` containment query in `backend/src/lib/ipfs-shared.ts`,
 * which both reference checks consume — the GET /ipfs/:cid gateway's CID-known
 * check (`cidIsKnown`, `routes/ipfs.ts`) and the cleanup job's CID-in-use check
 * (`cidReferencedInHaf`, `ipfs-cleanup.ts`).
 *
 * Hive's `image` metadata is convention, not schema: any post can broadcast
 * a non-array `image` value (null, string, integer, object). Postgres
 * evaluates the LATERAL SRF before the surrounding WHERE — so a WHERE-side
 * `jsonb_typeof = 'array'` guard fires AFTER the SRF and is a placebo. The
 * fix is to move the type-guard INTO the SRF argument via CASE-WHEN with
 * `ELSE '[]'::jsonb` fallback.
 *
 * Failure mode without the guard (both reach the shared query):
 *   - via `cidIsKnown`: GET /ipfs/:cid raises on every CID lookup while at
 *     least one post in scope has malformed `image`. Per-request fault.
 *   - via `cidReferencedInHaf`: the periodic cleanup job crashes mid-sweep,
 *     leaving orphaned pending-upload rows and their pins until the
 *     malformed post is edited or removed.
 *
 * Carve-out clause-(a): synthetic-VALUES is justified because real-corpus
 * seeding of malformed-image Hive posts is impractical (the test corpus is
 * Mahdi's HAF; we do not control its content). The assertion (cascade-fail
 * defense + match-row shape) is exactly what the carve-out is for. The
 * shape mirrors the `citing_papers CROSS JOIN LATERAL cascade-fail defense`
 * test in `hafsql.test.ts` (the canonical reference pattern).
 *
 * Carve-out clause-(c) real-path companion: the routes are exercised by
 * existing IPFS upload/cleanup tests against well-formed data. The
 * behavioral block below composes the production `imageSrfGuardExpr`
 * (lib/ipfs-shared.ts), so the fragment it runs cannot drift from the live
 * guard; the second describe block then pins that the builder still carries
 * the guard and substitutes its alias argument AND that the shared
 * `cidReferencedByAppTag` containment query interpolates that builder, so a
 * revert that gutted the builder, dropped its alias argument, or inlined an
 * unguarded SRF argument at the one production SRF site fails red. Together
 * they cover the malformed-image cascade-fail class at the behavioral,
 * builder, and call-site layers.
 *
 * See conventions:
 *   - pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16
 *   - pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPool } from '../../src/db.js';
import { imageSrfGuardExpr } from '../../src/lib/ipfs-shared.js';

// Composes the production guard fragment (imageSrfGuardExpr from
// lib/ipfs-shared.ts — the same builder both `cidIsKnown` and
// `cidReferencedInHaf` interpolate) over a synthetic one-row `c` relation
// with controlled json_metadata, so this test cannot drift from the live
// guard. The builder is passed the alias the synthetic FROM below uses (`c`).
const guardedSrfShape = `
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${imageSrfGuardExpr('c')}) AS img
    WHERE img LIKE '%' || $1 || '%'
  ) AS matched
  FROM (SELECT $2::jsonb AS json_metadata) AS c
`;

describe('IPFS image SRF-argument array-guard (real Postgres, synthetic rows)', () => {
  it('does not throw on non-array image shapes (null, string, integer, object, missing)', { timeout: 30_000 }, async (ctx) => {
    const pool = getPool();
    if (!pool) {
      ctx.skip('no HAF pool available');
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
      ctx.skip('no HAF pool available');
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
      ctx.skip('no HAF pool available');
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
      ctx.skip('no HAF pool available');
      return;
    }

    // SQL NULL on the column — `c.json_metadata->'image'` returns SQL NULL,
    // `jsonb_typeof(NULL)` returns NULL, the CASE evaluates ELSE and the
    // SRF gets '[]'::jsonb. The query yields one row with `matched=false`.
    // Composes the same shared imageSrfGuardExpr over a top-level-NULL row.
    const sql = `
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${imageSrfGuardExpr('c')}) AS img
        WHERE img LIKE '%' || $1 || '%'
      ) AS matched
      FROM (SELECT NULL::jsonb AS json_metadata) AS c
    `;
    const result = await pool.query(sql, ['QmFakeCid']);
    expect(result.rows).toEqual([{ matched: false }]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Shared-builder + call-site presence canary.
//
// The behavioral block above composes the imported imageSrfGuardExpr, so it
// can no longer drift from production by construction. This block adds two
// layers: (1) the shared builder still carries the CASE-WHEN jsonb_typeof
// array guard and substitutes its alias argument, and (2) the one production
// SRF site — the shared cidReferencedByAppTag containment query, consumed by
// both reference checks — interpolates that shared builder (invoked with a
// relation-alias literal) into its jsonb_array_elements_text() SRF, so a revert
// that gutted the builder, dropped its alias argument, or inlined an unguarded
// SRF argument fails red. Modeled on
// `excludeSelfReviewWhere-callsite-canaries.test.ts`.
// ──────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(__dirname, '..', '..');

interface GuardSite {
  /** Project-relative path of the file carrying the SRF call. */
  file: string;
  /** Function whose query composes the SRF, for the failure message. */
  fn: string;
}

const GUARD_SITES: GuardSite[] = [
  { file: 'src/lib/ipfs-shared.ts', fn: 'cidReferencedByAppTag' },
];

describe('IPFS image SRF guard — shared builder + call-site presence canary', () => {
  it('imageSrfGuardExpr(alias) carries the CASE-WHEN jsonb_typeof array guard and substitutes the alias', () => {
    const normalized = imageSrfGuardExpr('c').replace(/\s+/g, ' ').trim();
    expect(normalized).toContain("CASE WHEN jsonb_typeof(c.json_metadata->'image') = 'array'");
    expect(normalized).toContain("THEN c.json_metadata->'image'");
    expect(normalized).toContain("ELSE '[]'::jsonb");
    expect(normalized).toMatch(/END$/);

    // Alias substitution: a different alias appears verbatim and the default
    // `c` does not leak — this is the contract the builder form enforces over
    // the former `c`-hardwired constant.
    const aliased = imageSrfGuardExpr('p').replace(/\s+/g, ' ').trim();
    expect(aliased).toContain("jsonb_typeof(p.json_metadata->'image')");
    expect(aliased).not.toContain('c.json_metadata');

    // Non-identifier aliases are rejected (the value is interpolated, not bound).
    expect(() => imageSrfGuardExpr("c; DROP TABLE comments;--")).toThrow();
  });

  for (const { file, fn } of GUARD_SITES) {
    it(`${file} composes the shared imageSrfGuardExpr at every jsonb_array_elements_text() SRF call (${fn})`, () => {
      const source = readFileSync(resolve(PROJECT_ROOT, file), 'utf-8');
      const normalized = source.replace(/\s+/g, ' ');

      // Requiring a non-`)` first character after the `(` counts only calls
      // that pass an actual SRF argument, excluding prose mentions in the
      // comment/docblocks — both the no-paren form ("jsonb_array_elements_text
      // would raise") and the empty-paren form ("at a jsonb_array_elements_text()
      // SRF argument position", which the shared builder's own docblock uses).
      const totalCalls = (normalized.match(/jsonb_array_elements_text\([^)]/g) ?? []).length;
      // Calls whose argument is the shared builder invoked with a bare-identifier
      // alias literal — asserts alias substitution, not bare constant interpolation.
      const viaSharedFn = (normalized.match(/jsonb_array_elements_text\(\$\{imageSrfGuardExpr\('[A-Za-z_][A-Za-z0-9_]*'\)\}\)/g) ?? []).length;

      expect(
        totalCalls,
        `expected at least one jsonb_array_elements_text() SRF call in ${file} (${fn})`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        viaSharedFn,
        `every jsonb_array_elements_text() SRF argument in ${file} (${fn}) must interpolate the shared ` +
        `imageSrfGuardExpr(<alias>) builder (lib/ipfs-shared.ts) — an inlined or unguarded argument, or one ` +
        `that drops the relation-alias argument, bypasses the single source of the LATERAL-before-WHERE type ` +
        `guard (see pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16). Found ${viaSharedFn} via-builder of ${totalCalls} total.`,
      ).toBe(totalCalls);
    });
  }
});
