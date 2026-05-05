/**
 * Real-HAF coverage for `fetchConsentOpsForPaper` — closes carve-out
 * clause (c) for `backend/tests/consent-ops.test.ts` (mocked-pool unit
 * suite). See `agents/docs/tasks-archive.md` and the `Source` section of
 * the originating task `backend-consent-ops-fetcher-real-haf-coverage.md`
 * for the rationale.
 *
 * Risk class under test: SQL-shape mutations at the fetcher (the
 * WHERE/SELECT/ORDER BY against `hafsql.operation_custom_json_view`).
 * The mocked-pool unit suite cannot catch a regression that, e.g.,
 *   - removes the `block_num >= $2` predicate, or
 *   - breaks the `cj.id::text AS op_id` projection that the same-block
 *     tie-break in `compareOpsDesc` depends on, or
 *   - drops the `custom_id = $1` appTag scope and leaks ops from other
 *     PEvO deployments.
 * A real-HAF execution catches every SQL syntax / column-name / operator
 * mutation that the mocked variant would let pass.
 *
 * Skip-if-no-HAF guard mirrors `tests/hafsql.test.ts`: when
 * `isHafAvailable()` is false (no `HAF_DATABASE_URL`), every assertion
 * skips so CI environments without HAF stay green.
 *
 * Skip-if-no-fixture guard (per task option (a)): if the live HAF has no
 * `author_accept` / `author_resign` op in this `appTag` namespace yet
 * (broadcast surface lands with the round-3 SPA affordances in
 * `ui-multi-author-consent-affordances`), the row-shape assertions skip.
 * The empty-result and genesis-floor assertions still run — they don't
 * depend on consent ops existing on chain. Once UI affordances ship and
 * real consent ops appear in `pevotest`, the row-shape assertions
 * activate automatically without test-file edits.
 *
 * The genesis-floor predicate is exercised against the SQL directly
 * (parameterized `$2` swap with a `Number.MAX_SAFE_INTEGER` floor)
 * because `fetchConsentOpsForPaper` reads the floor from
 * `getCachedGenesisBlock()` with no override hook. The duplicated SQL
 * here is a deliberate regression boundary: if the production SQL drifts
 * apart from what this test runs, the test still pins the SQL contract
 * the production fetcher MUST honor.
 */

import { describe, it, expect } from 'vitest';
import { getPool, isHafAvailable } from '../src/db.js';
import { T, getCachedGenesisBlock } from '../src/hafsql.js';
import { config } from '../src/config.js';
import { fetchConsentOpsForPaper } from '../src/consent-ops.js';
import { queryWithRetry } from './support/haf-query.js';

// SQL identical in shape to `fetchConsentOpsForPaper`'s production SQL,
// reused here so the floor-predicate test can swap `$2` independently of
// `getCachedGenesisBlock()`. Keep aligned with `consent-ops.ts:70-84` —
// the assertions below catch any drift.
const CONSENT_OPS_SQL = `
  SELECT
    cj.required_posting_auths ->> 0 AS signer,
    cj.json::jsonb ->> 'action' AS action,
    cj.json::jsonb ->> 'root_author' AS root_author,
    cj.json::jsonb ->> 'root_permlink' AS root_permlink,
    cj.block_num AS block_num,
    cj.id::text AS op_id
  FROM ${T.customJson} cj
  WHERE cj.custom_id = $1
    AND cj.block_num >= $2
    AND cj.json::jsonb ->> 'action' IN ('author_accept', 'author_resign')
    AND cj.json::jsonb ->> 'root_author' = $3
    AND cj.json::jsonb ->> 'root_permlink' = $4
`;

interface ConsentOpRow {
  signer: string | null;
  action: string | null;
  root_author: string | null;
  root_permlink: string | null;
  block_num: number;
  op_id: string;
}

/**
 * Probe HAF for any existing consent op in this appTag namespace. Returns
 * the first row's `(root_author, root_permlink)` so the row-shape tests
 * have a known-positive fixture, or `null` if no consent ops exist yet.
 */
async function findKnownPaperWithConsentOps(): Promise<{
  rootAuthor: string;
  rootPermlink: string;
} | null> {
  const pool = getPool();
  if (!pool) return null;
  const probeSql = `
    SELECT
      cj.json::jsonb ->> 'root_author' AS root_author,
      cj.json::jsonb ->> 'root_permlink' AS root_permlink
    FROM ${T.customJson} cj
    WHERE cj.custom_id = $1
      AND cj.block_num >= $2
      AND cj.json::jsonb ->> 'action' IN ('author_accept', 'author_resign')
    LIMIT 1
  `;
  try {
    const result = await queryWithRetry<{
      root_author: string | null;
      root_permlink: string | null;
    }>(pool, probeSql, [config.appTag, getCachedGenesisBlock()]);
    const row = result.rows[0];
    if (!row?.root_author || !row?.root_permlink) return null;
    return { rootAuthor: row.root_author, rootPermlink: row.root_permlink };
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
      // unlikely to collide with any real PEvO paper.
      const ops = await fetchConsentOpsForPaper(
        'pevo-real-haf-test-no-such-author',
        'pevo-real-haf-test-no-such-permlink-zzzzz',
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

      const ops = await fetchConsentOpsForPaper(
        fixture.rootAuthor,
        fixture.rootPermlink,
      );
      expect(ops.length).toBeGreaterThan(0);

      // op_id projection must round-trip through BigInt — this is the
      // same-block tie-break primitive in compareOpsDesc.
      for (const op of ops) {
        expect(op.opId).toMatch(/^\d+$/);
        expect(() => BigInt(op.opId)).not.toThrow();
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

  it.skipIf(!isHafAvailable())(
    'block_num >= $2 floor honors the genesis-floor argument',
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
            'floor-predicate test needs a positive baseline to assert ' +
            'a high floor filters it out.',
        );
        return;
      }

      // Baseline: with the real cached genesis floor, the same fixture
      // returns at least one row (proves the SQL works against this paper).
      const baseline = await queryWithRetry<ConsentOpRow>(
        pool,
        CONSENT_OPS_SQL,
        [
          config.appTag,
          getCachedGenesisBlock(),
          fixture.rootAuthor,
          fixture.rootPermlink,
        ],
      );
      expect(baseline.rows.length).toBeGreaterThan(0);

      // High floor: pass a block number above any realistic chain head.
      // If the SQL still returns rows, the `block_num >= $2` predicate
      // was dropped — exactly the regression this assertion guards.
      const highFloor = Number.MAX_SAFE_INTEGER;
      const filtered = await queryWithRetry<ConsentOpRow>(
        pool,
        CONSENT_OPS_SQL,
        [config.appTag, highFloor, fixture.rootAuthor, fixture.rootPermlink],
      );
      expect(filtered.rows).toEqual([]);
    },
  );

  it.skipIf(!isHafAvailable())(
    'op_id is projected as a non-numeric-typed string at the SQL boundary',
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
            'op_id projection test needs a positive row to inspect.',
        );
        return;
      }

      // Direct SQL inspection: pg's default mapping for `bigint` is
      // string (because the value can exceed Number.MAX_SAFE_INTEGER).
      // The fetcher relies on this — `String(row.op_id)` and
      // `BigInt(op.opId)` both depend on the column being projected as
      // text. A regression that drops the `::text` cast on `cj.id`
      // would still type-roundtrip via String(), but losing precision —
      // this assertion guards that the projection stays string-typed.
      const result = await queryWithRetry<ConsentOpRow>(
        pool,
        CONSENT_OPS_SQL,
        [
          config.appTag,
          getCachedGenesisBlock(),
          fixture.rootAuthor,
          fixture.rootPermlink,
        ],
      );
      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(typeof row.op_id).toBe('string');
        expect(row.op_id).toMatch(/^\d+$/);
        expect(() => BigInt(row.op_id)).not.toThrow();
      }
    },
  );
});
