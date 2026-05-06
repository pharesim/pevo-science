/**
 * Real-HAF coverage for `fetchConsentOpsForPaper` — closes carve-out
 * clause (c) for `backend/tests/consent-ops.test.ts` (mocked-pool unit
 * suite). See the originating task
 * `backend-consent-ops-fetcher-real-haf-coverage.md` for rationale, and
 * `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`
 * for the convention this file's header template follows.
 *
 * Risk class covered by THIS file: row-shape regressions at the production
 * fetcher. A mutation in `consent-ops.ts:103-126` that renames a SELECT
 * projection (`signer` / `action` / `root_author` / `root_permlink` /
 * `block_num` / `op_id`), changes the `IN ('author_accept', 'author_resign')`
 * action whitelist values, or breaks the `root_author = $3` /
 * `root_permlink = $4` filter so a known-positive paper no longer
 * round-trips will fail the row-shape assertions in the second `it`
 * block. The block exercises `fetchConsentOpsForPaper` directly — a
 * regression that breaks the typed `ConsentOp` shape surfaces here.
 *
 * Risk classes covered ELSEWHERE (deliberate division of labor):
 *   - SQL-string mutations (dropping `cj.custom_id = $1`,
 *     `cj.block_num >= $2`, the `cj.id::text` projection, the
 *     `ORDER BY cj.id DESC` clause, or the `LIMIT 1000` cap) are pinned
 *     by SQL-string regex assertions in the mocked sibling
 *     `backend/tests/consent-ops.test.ts` →
 *     `describe('fetchConsentOpsForPaper — SQL contract')`. A real-HAF
 *     test cannot distinguish these mutations from a working query
 *     while only one `appTag` namespace exists on chain and the result
 *     set fits below the LIMIT.
 *   - Validity-rule mutations (temporal-ordering, signer-binding,
 *     same-block tie-break, resign supersession, bridge-paper
 *     claimed-set membership) are covered by the mocked sibling's
 *     `computeVouchedAuthors` describe blocks against synthesized op
 *     shapes.
 *
 * Skip-if-no-HAF guard mirrors `tests/hafsql.test.ts`: when
 * `isHafAvailable()` is false (no `HAF_DATABASE_URL`), every assertion
 * skips so CI environments without HAF stay green.
 *
 * Skip-if-no-fixture guard (per the originating task option (a)): if
 * the live HAF has no `author_accept` / `author_resign` op in this
 * `appTag` namespace yet (broadcast surface lands with the round-3 SPA
 * affordances in `ui-multi-author-consent-affordances`), the row-shape
 * assertion skips. The empty-result assertion still runs — it does not
 * depend on consent ops existing on chain. Once UI affordances ship and
 * real consent ops appear in `pevotest`, the row-shape assertion
 * activates automatically without test-file edits.
 */

import { describe, it, expect } from 'vitest';
import { getPool, isHafAvailable } from '../src/db.js';
import { T, getCachedGenesisBlock } from '../src/hafsql.js';
import { config } from '../src/config.js';
import { fetchConsentOpsForPaper } from '../src/consent-ops.js';
import { queryWithRetry } from './support/haf-query.js';

/**
 * Probe HAF for any existing consent op in this appTag namespace. Returns
 * the first row's `(root_author, root_permlink, signer)` so the row-shape
 * tests have a known-positive fixture (including a claimed-set member to
 * pass through round-5 hold #2's signer-filter), or `null` if no consent
 * ops exist yet.
 */
async function findKnownPaperWithConsentOps(): Promise<{
  rootAuthor: string;
  rootPermlink: string;
  signer: string;
} | null> {
  const pool = getPool();
  if (!pool) return null;
  // ORDER BY pins the earliest consent op so the probe stays
  // deterministic across runs as more ops accumulate on chain.
  const probeSql = `
    SELECT
      cj.json::jsonb ->> 'root_author' AS root_author,
      cj.json::jsonb ->> 'root_permlink' AS root_permlink,
      cj.required_posting_auths ->> 0 AS signer
    FROM ${T.customJson} cj
    WHERE cj.custom_id = $1
      AND cj.block_num >= $2
      AND cj.json::jsonb ->> 'action' IN ('author_accept', 'author_resign')
    ORDER BY cj.block_num ASC, cj.id ASC
    LIMIT 1
  `;
  try {
    const result = await queryWithRetry<{
      root_author: string | null;
      root_permlink: string | null;
      signer: string | null;
    }>(pool, probeSql, [config.appTag, getCachedGenesisBlock()]);
    const row = result.rows[0];
    if (!row?.root_author || !row?.root_permlink || !row?.signer) return null;
    return {
      rootAuthor: row.root_author,
      rootPermlink: row.root_permlink,
      signer: row.signer,
    };
  } catch {
    return null;
  }
}

describe('fetchConsentOpsForPaper — real HAF SQL shape', () => {
  it.skipIf(!isHafAvailable())(
    'returns [] for a paper with no consent ops',
    { timeout: 60_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      // Deterministic non-existent (author, permlink) — astronomically
      // unlikely to collide with any real PEvO paper. Round-5 hold #2:
      // the claimed-set is a single non-existent handle so the SQL
      // signer-filter has placeholders to bind against; combined with
      // the non-existent paper identity, the result is unconditionally
      // empty regardless of HAF state.
      const ops = await fetchConsentOpsForPaper(
        'pevo-real-haf-test-no-such-author',
        'pevo-real-haf-test-no-such-permlink-zzzzz',
        new Set(['pevo-real-haf-test-no-such-signer']),
      );
      expect(ops).toEqual([]);
    },
  );

  it.skipIf(!isHafAvailable())(
    'returns rows with BigInt-parseable op_id for a paper with consent ops',
    { timeout: 60_000 },
    async (ctx) => {
      const pool = getPool();
      if (!pool) {
        ctx.skip('no pool available');
        return;
      }

      const fixture = await findKnownPaperWithConsentOps();
      if (!fixture) {
        ctx.skip(
          'HAF has no author_accept / author_resign ops yet — ' +
            'broadcast surface lands with ui-multi-author-consent-affordances. ' +
            'This assertion auto-activates once consent ops appear on chain.',
        );
        return;
      }

      // Round-5 hold #2: pass the discovered signer as the claimed-set
      // so the SQL signer-filter admits at least the probe's row. A
      // production caller derives `claimedAuthors` from the chain-walk;
      // here we use the signer directly because the test asserts
      // round-trip parsing of any consent op, not vouched-set semantics.
      const ops = await fetchConsentOpsForPaper(
        fixture.rootAuthor,
        fixture.rootPermlink,
        new Set([fixture.signer]),
      );
      expect(ops.length).toBeGreaterThan(0);

      // op_id projection must round-trip through BigInt — this is the
      // same-block tie-break primitive in compareOpsDesc. The
      // `>= 0n` form asserts parsability AND non-negative shape with
      // a single diff-ready failure message.
      for (const op of ops) {
        expect(op.opId).toMatch(/^\d+$/);
        expect(BigInt(op.opId)).toBeGreaterThanOrEqual(0n);
        // Sanity: blockNum is a positive integer (block_num column).
        expect(Number.isInteger(op.blockNum)).toBe(true);
        expect(op.blockNum).toBeGreaterThan(0);
        // Action narrowing — proves the `IN ('author_accept', 'author_resign')`
        // predicate is honored.
        expect(['author_accept', 'author_resign']).toContain(op.action);
        // root_author / root_permlink projections match the requested paper.
        expect(op.rootAuthor).toBe(fixture.rootAuthor);
        expect(op.rootPermlink).toBe(fixture.rootPermlink);
        // Signer is non-empty (required_posting_auths[0] projection).
        expect(op.signer.length).toBeGreaterThan(0);
      }
    },
  );
});
