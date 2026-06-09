/**
 * HAF-free SQL-shape canary for the revoke_authorship signer gate on the
 * REPUTATION CYCLE surface (`computeReputationBatch`'s inline `accepted_claims`
 * CTE in `reputation.ts`).
 *
 * The read surface (`authorshipClaimsCteBody` in `hafsql.ts`) is covered
 * behaviorally by `authorship-revoke-signer-gate.test.ts`. The cycle applies
 * the IDENTICAL predicate — `rv.approver IN (rv.paper_author, $17, $21,
 * rv.claimer)` — in the `accepted_claims` revoke `NOT EXISTS` subquery, where
 * `$17` binds `config.hiveBridgeAccount` and `$21` binds
 * `config.hiveAdminAccount`. The two surfaces are kept in sync only by mirrored
 * comments and hardcoded `$17`/`$21`, and the cycle is where the forged
 * reputation-denial actually lands (a voided claim drops the co-author credit).
 * A predicate removal in `reputation.ts` alone — or a literal edit of the
 * emitted IN-list (a dropped signer, or the `$17`/`$21` placeholder text
 * changed) — would silently re-open the stranger-signed revoke forgery on the
 * cycle while the read-surface behavioral test stays green.
 *
 * What this canary pins, and what it does NOT: it asserts the predicate's
 * presence and the literal `rv.approver IN (rv.paper_author, $17, $21,
 * rv.claimer)` text on the cycle's emitted SQL, independently of the read surface
 * and of whether HAF is configured — so a predicate removal or a literal IN-list
 * edit on the cycle is caught. It does NOT catch a param-position insertion
 * AHEAD of `$17`: a new bind added earlier in the cycle's param array shifts what
 * `$17`/`$21` resolve to (breaking the gate) while the hand-written SQL text
 * still reads `$17, $21`, so the regex below stays green. The cycle's
 * `$17`/`$21` positions have no structural test (unlike the read surface, whose
 * positions are pinned by the `authorshipClaimsCteBody` param-arithmetic
 * assertions in `hafsql.test.ts`); closing that positional gap on the cycle is
 * left to the planned merge of the two mirrored claim-resolution surfaces, which
 * removes the cycle's hardcoded `$17`/`$21` literals — a structural param-
 * position assertion belongs there once the literals are gone.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests"):** mocks `getPool()` with a
 * capturing pool that records the SQL `computeReputationBatch` emits and returns
 * empty rowsets, so the cycle's query string is asserted without HAF.
 *   (a) Real path impractical: running the full daily reputation cycle against
 *       real HAF to assert a SQL-shape invariant is heavy, HAF-config-dependent
 *       (the architect needs this to run even when HAF is unconfigured), and
 *       would not deterministically exercise the revoke arm of the predicate.
 *   (b) No auth/permission middleware in scope — this drives the batch helper
 *       directly; `verifyHiveSignature` does not run and is not the focus.
 *   (c) Real-path companion: the identical read-surface predicate is exercised
 *       against real Postgres in `authorship-revoke-signer-gate.test.ts`'s
 *       synthetic-VALUES test, and the cycle itself runs against real HAF in
 *       the reputation lifecycle/batch suites. The risk class pinned HERE is
 *       the cycle's revoke arm trusting only author-/bridge-/admin-/
 *       claimer-signed revokes — a predicate-removal / literal-IN-list-edit
 *       tripwire on the cycle SQL that the read-surface test cannot catch.
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

describe('reputation cycle accepted_claims — revoke_authorship signer gate SQL shape', () => {
  it('emits `rv.approver IN (rv.paper_author, $17, $21, rv.claimer)` at the revoke NOT EXISTS arm', async () => {
    getPoolMock.mockReturnValue(capturingPool as unknown as ReturnType<typeof getPoolMock>);

    // cycleEndBlock provided (skips the head-block lookup); prevScores provided
    // (skips the prev-score read). Both keep the run to the inline cycle query.
    await computeReputationBatch(['some-target-user'], {}, 12_345);

    const cycleSql = capturedSqls.find((s) => s.includes('accepted_claims'));
    expect(cycleSql, 'computeReputationBatch must emit the accepted_claims cycle query').toBeDefined();

    // Pinning the literal four-element IN-list (including the `$17`/`$21`
    // placeholder text) catches a predicate removal, a dropped signer, or a
    // literal edit of the IN-list. It does NOT catch a bind inserted ahead of
    // `$17` in the param array — that shifts the real binding while the SQL text
    // still reads `$17, $21` (see the header note on the deferred positional test).
    const matches =
      cycleSql!.match(/rv\.approver IN \(rv\.paper_author, \$17, \$21, rv\.claimer\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
