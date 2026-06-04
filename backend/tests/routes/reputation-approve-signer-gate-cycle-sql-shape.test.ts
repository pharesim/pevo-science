/**
 * HAF-free SQL-shape canary for the approve_authorship signer gate on the
 * REPUTATION CYCLE surface (`computeReputationBatch`'s inline `accepted_claims`
 * CTE in `reputation.ts`).
 *
 * The read surface (`authorshipClaimsCteBody` in `hafsql.ts`) is covered
 * behaviorally by `authorship-approve-signer-gate.test.ts`. The cycle applies
 * the IDENTICAL predicate — `ap.approver IN (ap.paper_author, $17)` — in TWO
 * places: the "Explicitly approved" EXISTS arm AND the revoke-override
 * `MAX(approve_block)` subquery, where `$17` binds `config.hiveBridgeAccount`.
 * The two surfaces are kept in sync only by mirrored comments and a hardcoded
 * `$17`, and the cycle is where the forged co-author reputation credit actually
 * accrues. A param insertion before `$17`, or a predicate removal in
 * `reputation.ts` alone, would silently re-open the forgery on the cycle while
 * the read-surface behavioral test stays green.
 *
 * This canary pins the predicate's presence at BOTH arms and the exact `$17`
 * param on the cycle's emitted SQL, independently of the read surface and of
 * whether HAF is configured — so predicate-removal and bridge-param drift on
 * the cycle are caught.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests"):** mocks `getPool()` with a
 * capturing pool that records the SQL `computeReputationBatch` emits and returns
 * empty rowsets, so the cycle's query string is asserted without HAF.
 *   (a) Real path impractical: running the full daily reputation cycle against
 *       real HAF to assert a SQL-shape invariant is heavy, HAF-config-dependent
 *       (the architect needs this to run even when HAF is unconfigured), and
 *       would not deterministically exercise both arms of the predicate.
 *   (b) No auth/permission middleware in scope — this drives the batch helper
 *       directly; `verifyHiveSignature` does not run and is not the focus.
 *   (c) Real-path companion: the identical read-surface predicate is exercised
 *       against real Postgres in `authorship-approve-signer-gate.test.ts`'s
 *       synthetic-VALUES tests, and the cycle itself runs against real HAF in
 *       the reputation lifecycle/batch suites. The risk class pinned HERE is
 *       the cycle's approve arm trusting only author-/bridge-signed approves —
 *       a removal/param-drift tripwire the read-surface test cannot catch.
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

describe('reputation cycle accepted_claims — approve_authorship signer gate SQL shape', () => {
  it('emits `ap.approver IN (ap.paper_author, $17)` at BOTH the approved-EXISTS arm and the revoke-override MAX subquery', async () => {
    getPoolMock.mockReturnValue(capturingPool as unknown as ReturnType<typeof getPoolMock>);

    // cycleEndBlock provided (skips the head-block lookup); prevScores provided
    // (skips the prev-score read). Both keep the run to the inline cycle query.
    await computeReputationBatch(['some-target-user'], {}, 12_345);

    const cycleSql = capturedSqls.find((s) => s.includes('accepted_claims'));
    expect(cycleSql, 'computeReputationBatch must emit the accepted_claims cycle query').toBeDefined();

    // The signer gate appears once in the revoke-override MAX(approve_block)
    // subquery and once in the "Explicitly approved" EXISTS arm. Pinning the
    // exact `$17` catches a param insertion that would drift the bridge param;
    // requiring TWO occurrences catches a removal from either arm alone.
    const matches = cycleSql!.match(/ap\.approver IN \(ap\.paper_author, \$17\)/g) ?? [];
    expect(matches).toHaveLength(2);
  });
});
