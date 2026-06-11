/**
 * HAF-free SQL-shape canary for the approve_authorship signer gate as it now
 * appears on the REPUTATION CYCLE surface. The cycle (`computeReputationBatch`
 * in `reputation.ts`) COMPOSES the shared `authorshipClaimsCteBody` builder
 * instead of an inline `accepted_claims` copy, so the approve gate lives in the
 * builder and is emitted into the cycle SQL in TWO places: the "accepted" EXISTS
 * arm AND the revoke-override `MAX(approve_block)` subquery — both as
 * `ap.approver IN (ap.paper_author, $22)`, where the builder's allocation at
 * startIdx 21 binds `config.hiveBridgeAccount` at $22.
 *
 * This canary pins, on the cycle's emitted SQL and independently of whether HAF
 * is configured: (1) the cycle composes the builder (authorship_claims + thin
 * accepted_claims projection — re-inlining the resolution fails red), and (2) the
 * approve signer gate survives the merge at BOTH arms with the builder's
 * bridge param. The builder's param arithmetic (the startIdx-relative offset
 * that binds bridge) is pinned structurally by `hafsql.test.ts`'s
 * `authorshipClaimsCteBody` param-arithmetic suite; the read-surface approve behavior is pinned
 * against real Postgres by `authorship-approve-signer-gate.test.ts`.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests"):** mocks `getPool()` with a
 * capturing pool that records the SQL `computeReputationBatch` emits and returns
 * empty rowsets, so the cycle's query string is asserted without HAF.
 *   (a) Real path impractical: running the full daily reputation cycle against
 *       real HAF to assert a SQL-shape invariant is heavy and HAF-config-
 *       dependent (the architect needs this to run even when HAF is unconfigured).
 *   (b) No auth/permission middleware in scope — this drives the batch helper
 *       directly; `verifyHiveSignature` does not run and is not the focus.
 *   (c) Real-path companion: the builder's approve arm runs against real Postgres
 *       in `authorship-approve-signer-gate.test.ts`'s synthetic-VALUES tests, and
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

describe('reputation cycle — composes the shared claims builder (approve signer gate survives)', () => {
  it('emits authorship_claims + thin accepted_claims, with the approve gate at $22 in BOTH arms', async () => {
    getPoolMock.mockReturnValue(capturingPool as unknown as ReturnType<typeof getPoolMock>);

    // cycleEndBlock provided (skips the head-block lookup); prevScores provided
    // (skips the prev-score read). Both keep the run to the cycle query.
    await computeReputationBatch(['some-target-user'], {}, 12_345);

    const cycleSql = capturedSqls.find((s) => s.includes('accepted_claims'));
    expect(cycleSql, 'computeReputationBatch must emit the accepted_claims cycle query').toBeDefined();

    // Merge landed: the cycle composes authorshipClaimsCteBody, not an inline copy.
    expect(cycleSql).toContain('authorship_claims AS MATERIALIZED (');
    expect(cycleSql).toMatch(
      /accepted_claims AS \(\s*SELECT DISTINCT claimer, paper_author, paper_permlink\s+FROM authorship_claims\s+WHERE status = 'accepted'/,
    );

    // The approve signer gate appears once in the revoke-override MAX(approve_block)
    // subquery and once in the accepted-status EXISTS arm — both emitted by the
    // builder with bridge bound at $22 (authorshipClaimsCteBody(21) → bridgeIdx 22).
    // Requiring TWO occurrences catches a removal from either arm.
    const matches = cycleSql!.match(/ap\.approver IN \(ap\.paper_author, \$22\)/g) ?? [];
    expect(matches).toHaveLength(2);
  });
});
