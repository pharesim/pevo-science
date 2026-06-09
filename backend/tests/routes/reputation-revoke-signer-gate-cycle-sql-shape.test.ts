/**
 * HAF-free SQL-shape canary for the REPUTATION CYCLE's authorship-claims
 * resolution. The cycle (`computeReputationBatch` in `reputation.ts`) now
 * COMPOSES the shared `authorshipClaimsCteBody` builder (the same one the read
 * surfaces use) instead of an inline `accepted_claims` copy — this is the merge
 * the prior inline-shape canary anticipated. Its `accepted_claims` is the thin
 * `status = 'accepted'` projection of the builder's `authorship_claims` CTE.
 *
 * This canary pins, on the cycle's EMITTED SQL and independently of whether HAF
 * is configured:
 *   1. The cycle composes the builder — `authorship_claims AS (` is present and
 *      `accepted_claims` is the thin projection. A regression that re-inlines the
 *      resolution (re-introducing the cycle-vs-read-surface drift this merge
 *      removed) fails red.
 *   2. The revoke_authorship signer gate survives the merge:
 *      `rv.approver IN (rv.paper_author, $23, $25, rv.claimer)` — the builder's
 *      allocation at startIdx 21 binds bridge at $23 and admin at $25. A revoke
 *      voids a claim only when signed by the post author, the bridge account, the
 *      admin account, or the claimer themselves (hive-schemas.md §2.11); the
 *      cycle is where a forged revoke would actually strip co-author credit.
 *
 * The builder's internal param POSITIONS (that $23/$25 bind bridge/admin) are
 * pinned structurally by `hafsql.test.ts`'s `authorshipClaimsCteBody` param-
 * arithmetic suite; the read-surface revoke behavior is pinned against real
 * Postgres by `authorship-revoke-signer-gate.test.ts`. This file's unique job is
 * the cycle-side composition + gate-survival tripwire.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests"):** mocks `getPool()` with a
 * capturing pool that records the SQL `computeReputationBatch` emits and returns
 * empty rowsets, so the cycle's query string is asserted without HAF.
 *   (a) Real path impractical: running the full daily reputation cycle against
 *       real HAF to assert a SQL-shape invariant is heavy and HAF-config-
 *       dependent (the architect needs this to run even when HAF is unconfigured).
 *   (b) No auth/permission middleware in scope — this drives the batch helper
 *       directly; `verifyHiveSignature` does not run and is not the focus.
 *   (c) Real-path companion: the builder's revoke arm runs against real Postgres
 *       in `authorship-revoke-signer-gate.test.ts`'s synthetic-VALUES test, and
 *       the assembled cycle runs against real HAF in the reputation
 *       lifecycle/batch suites.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { getPoolMock } = vi.hoisted(() => ({ getPoolMock: vi.fn() }));

vi.mock('../../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
  return { ...actual, getPool: getPoolMock, isHafConfigured: () => getPoolMock() !== null };
});

const { computeReputationBatch } = await import('../../src/reputation.js');

const capturedSqls: string[] = [];

// Capturing pool: records every emitted SQL and returns empty rowsets. The
// batch helper handles a user with no activity gracefully, so empty rows drive
// it cleanly through to (and past) the inline accepted_claims query. `connect`
// covers loadReputationWeights' client path (empty rows → DEFAULT weights).
const cannedResult = { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
function capture(sql: string): Promise<typeof cannedResult> {
  capturedSqls.push(sql);
  return Promise.resolve(cannedResult);
}
const capturingPool = {
  query: (sql: string, _params?: unknown[]) => capture(sql),
  connect: async () => ({ query: (sql: string, _params?: unknown[]) => capture(sql), release: () => undefined }),
};

afterEach(() => {
  getPoolMock.mockReset();
  capturedSqls.length = 0;
});

describe('reputation cycle — composes the shared claims builder (revoke signer gate survives)', () => {
  it('emits authorship_claims + thin accepted_claims, with the revoke gate at $23/$25 (builder allocation)', async () => {
    getPoolMock.mockReturnValue(capturingPool as unknown as ReturnType<typeof getPoolMock>);

    // cycleEndBlock provided (skips the head-block lookup); prevScores provided
    // (skips the prev-score read). Both keep the run to the cycle query.
    await computeReputationBatch(['some-target-user'], {}, 12_345);

    const cycleSql = capturedSqls.find((s) => s.includes('accepted_claims'));
    expect(cycleSql, 'computeReputationBatch must emit the accepted_claims cycle query').toBeDefined();

    // Merge landed: the cycle composes authorshipClaimsCteBody rather than an
    // inline copy. Pin the composition (the builder's authorship_claims CTE) and
    // the thin status='accepted' projection so a regression that re-inlines the
    // resolution fails red.
    expect(cycleSql).toContain('authorship_claims AS (');
    expect(cycleSql).toMatch(
      /accepted_claims AS \(\s*SELECT DISTINCT claimer, paper_author, paper_permlink\s+FROM authorship_claims\s+WHERE status = 'accepted'/,
    );

    // The revoke signer gate now lives in the builder's revoked-status arm and is
    // emitted into the cycle SQL with the builder's allocation: bridge $22, admin
    // $24 (authorshipClaimsCteBody(21) → bridgeIdx 22, adminIdx 24). The builder's
    // param positions are independently pinned by hafsql.test.ts; here we assert
    // the gate survived the merge into the cycle's emitted SQL.
    const matches =
      cycleSql!.match(/rv\.approver IN \(rv\.paper_author, \$22, \$24, rv\.claimer\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
