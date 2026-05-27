/**
 * Unit coverage for `cidReferencedByAppTag`'s single-tag tags-scope / namespace
 * SQL shape and its null-rowCount safety guard. The helper gates the
 * orphan-cleanup unpin decision (a wrong "not referenced" unpins a live
 * on-chain-referenced file — irreversible, Kubo pin/rm is not refcounted) and
 * the GET /ipfs/:cid gateway's CID-known check.
 *
 * Carve-out clauses (per root CLAUDE.md "Running Tests"):
 *
 *   (a) Real-path impracticality: the production query runs a tags-scoped
 *       containment over Mahdi's shared HAF `comments` corpus, whose content we
 *       do not control, so we cannot deterministically seed a tagged +
 *       namespaced row for a synthetic CID. The failure mode under test is
 *       purely which tags/namespaces the generated SQL covers, so the HAF pool
 *       is replaced by a capture stub (`pg.Pool` surface, `query` only) and
 *       `../../src/config.js` is mocked to set `appTag` deterministically. The
 *       real-corpus behavioral path stays covered by `routes/ipfs.test.ts` (the
 *       GET /ipfs/:cid namespace-resolution spec) and the SRF-guard real-Postgres
 *       block in `ipfs-image-srf-guard.test.ts`.
 *
 *   (b) No auth/permission middleware is involved: `cidReferencedByAppTag` is a
 *       leaf SQL helper with no HTTP surface, so there is no `verifyHiveSignature`
 *       gate to preserve here.
 *
 *   (c) Same risk class — "the cleanup reference check covers the right
 *       tags/namespaces, and an indeterminate result does not unpin a live file"
 *       — is exercised on the integrated path by the per-backend dispatch test
 *       (`ipfs-cleanup-backend-dispatch.test.ts`, which drives `runCleanup`
 *       through `cidReferencedInHaf` → this helper, including the null-rowCount
 *       skip) and the real-HAF namespace-resolution spec in `routes/ipfs.test.ts`.
 *       This file pins the SQL-shape contract and the helper-level null-rowCount
 *       throw.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return {
    config: { ...actual.config, appTag: 'prodtag' },
  };
});

const { cidReferencedByAppTag } = await import('../../src/lib/ipfs-shared.js');
const { config } = await import('../../src/config.js');

const mutableConfig = config as { appTag: string };

interface CapturedQuery {
  text: string;
  values: unknown[];
}

function captureStubPool(captured: CapturedQuery[]): { query: (text: string, values: unknown[]) => Promise<{ rowCount: number }> } {
  return {
    query: async (text: string, values: unknown[]) => {
      captured.push({ text, values });
      return { rowCount: 0 };
    },
  };
}

const FAKE_CID = 'QmContainmentShapeFixture000000000000000000000000';

beforeEach(() => {
  mutableConfig.appTag = 'prodtag';
});

describe('cidReferencedByAppTag — tags-scope + namespace SQL shape', () => {
  it('single tags-scope clause, single namespace pair, image-SRF guard composed', async () => {
    const captured: CapturedQuery[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cidReferencedByAppTag(captureStubPool(captured) as any, FAKE_CID);

    expect(captured).toHaveLength(1);
    const { text, values } = captured[0];

    // Exactly one tags containment, no OR across tags clauses.
    const tagsClauses = (text.match(/c\.tags @>/g) ?? []).length;
    expect(tagsClauses).toBe(1);

    // Two namespace containments (ipfs_cid + supplementary_files) for the one tag.
    const namespaceClauses = (text.match(/c\.json_metadata @>/g) ?? []).length;
    expect(namespaceClauses).toBe(2);

    // The image-SRF guard is still composed (single source, alias 'c').
    expect(text).toContain("jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.json_metadata->'image')");

    // Bind values: [ [prodtag], {prodtag:{ipfs_cid}}, {prodtag:{supplementary_files}}, cid ].
    expect(values).toEqual([
      JSON.stringify(['prodtag']),
      JSON.stringify({ prodtag: { ipfs_cid: FAKE_CID } }),
      JSON.stringify({ prodtag: { supplementary_files: [{ cid: FAKE_CID }] } }),
      FAKE_CID,
    ]);
  });

  it('returns true when the underlying query reports a matching row', async () => {
    const matchingPool = {
      query: async () => ({ rowCount: 1 }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(cidReferencedByAppTag(matchingPool as any, FAKE_CID)).resolves.toBe(true);
  });

  it('throws on a null rowCount (driver could not report) rather than coercing to not-referenced', async () => {
    // Coercing a null rowCount to false would route the cleanup path to an
    // irreversible unpin on an indeterminate result. Throwing lets runCleanup's
    // per-row catch keep the file pinned; the cleanup-side no-unpin consequence
    // is asserted in ipfs-cleanup-backend-dispatch.test.ts.
    const nullCountPool = {
      query: async () => ({ rowCount: null }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(cidReferencedByAppTag(nullCountPool as any, FAKE_CID)).rejects.toThrow(/null rowCount/);
  });
});
