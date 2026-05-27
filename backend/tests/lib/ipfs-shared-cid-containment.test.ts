/**
 * Unit coverage for `cidReferencedByAppTag`'s tags-scope / namespace shape,
 * with focus on the historical-appTag widening that guards the orphan-cleanup
 * unpin decision across a beta→prod APP_TAG flip.
 *
 * Carve-out clauses (per root CLAUDE.md "Running Tests"):
 *
 *   (a) Real-path impracticality: the production query runs a tags-scoped
 *       containment over Mahdi's shared HAF `comments` corpus, whose content we
 *       do not control, so we cannot seed a row that is tagged + namespaced
 *       under one APP_TAG while the runtime config carries another. Exercising
 *       the historical-tag OR against the real corpus is therefore impractical;
 *       the failure mode under test is purely which tags/namespaces the
 *       generated SQL covers. The HAF pool is replaced by a capture stub
 *       (`pg.Pool` surface, `query` only) and `../../src/config.js` is mocked to
 *       set `appTag` + `appTagsHistorical` deterministically. The real-corpus
 *       behavioral path stays covered by `routes/ipfs.test.ts` (the GET
 *       /ipfs/:cid namespace-resolution spec) and the SRF-guard real-Postgres
 *       block in `ipfs-image-srf-guard.test.ts`.
 *
 *   (b) No auth/permission middleware is involved: `cidReferencedByAppTag` is a
 *       leaf SQL helper with no HTTP surface, so there is no `verifyHiveSignature`
 *       gate to preserve here.
 *
 *   (c) Same risk class — "the cleanup reference check covers the right
 *       tags/namespaces so a live file is not unpinned" — is exercised on the
 *       integrated path by the per-backend dispatch test
 *       (`ipfs-cleanup-backend-dispatch.test.ts`, which drives `runCleanup`
 *       through `cidReferencedInHaf` → this helper) and the real-HAF
 *       namespace-resolution spec in `routes/ipfs.test.ts`. This file pins the
 *       SQL-shape contract: the steady-state single-tag form is unchanged, and
 *       a configured historical tag is OR'd into both the tags-scope and the
 *       namespace containment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return {
    config: { ...actual.config, appTag: 'prodtag', appTagsHistorical: [] as string[] },
  };
});

const { cidReferencedByAppTag } = await import('../../src/lib/ipfs-shared.js');
const { config } = await import('../../src/config.js');

const mutableConfig = config as { appTag: string; appTagsHistorical: string[] };

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
  mutableConfig.appTagsHistorical = [];
});

describe('cidReferencedByAppTag — tags-scope + namespace SQL shape', () => {
  it('steady state (no historical tags): single tags-scope clause, single namespace pair', async () => {
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

  it('with a historical tag: ORs the old tag into both the tags-scope and the namespace match', async () => {
    mutableConfig.appTagsHistorical = ['pevotest'];
    const captured: CapturedQuery[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cidReferencedByAppTag(captureStubPool(captured) as any, FAKE_CID);

    const { text, values } = captured[0];

    // Two tags containments OR'd — each GIN-indexable, BitmapOr-able.
    expect((text.match(/c\.tags @>/g) ?? []).length).toBe(2);
    expect(text).toMatch(/c\.tags @> \$\d+::jsonb OR c\.tags @> \$\d+::jsonb/);

    // Four namespace containments: ipfs_cid + supplementary_files per tag.
    expect((text.match(/c\.json_metadata @>/g) ?? []).length).toBe(4);

    // Both the current and the historical tag's namespace JSON appear as binds.
    expect(values).toContain(JSON.stringify({ prodtag: { ipfs_cid: FAKE_CID } }));
    expect(values).toContain(JSON.stringify({ pevotest: { ipfs_cid: FAKE_CID } }));
    expect(values).toContain(JSON.stringify({ prodtag: { supplementary_files: [{ cid: FAKE_CID }] } }));
    expect(values).toContain(JSON.stringify({ pevotest: { supplementary_files: [{ cid: FAKE_CID }] } }));
    // Both tags appear in the tags-scope binds.
    expect(values).toContain(JSON.stringify(['prodtag']));
    expect(values).toContain(JSON.stringify(['pevotest']));
    // The raw cid is the last bind (the image-SRF LIKE argument).
    expect(values[values.length - 1]).toBe(FAKE_CID);
  });

  it('de-duplicates a historical tag equal to the current tag (no redundant OR clause)', async () => {
    mutableConfig.appTagsHistorical = ['prodtag'];
    const captured: CapturedQuery[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cidReferencedByAppTag(captureStubPool(captured) as any, FAKE_CID);

    const { text } = captured[0];
    // Collapses back to the single-tag shape: one tags clause, two namespace clauses.
    expect((text.match(/c\.tags @>/g) ?? []).length).toBe(1);
    expect((text.match(/c\.json_metadata @>/g) ?? []).length).toBe(2);
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
