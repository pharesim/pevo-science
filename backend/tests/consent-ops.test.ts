/**
 * Round 1 of `backend-coauthor-trust-model` Phase 2 — vouched-set
 * computation helpers.
 *
 * Coverage:
 *   1. `computeVouchedAuthors` — pure function, exhaustive unit coverage of
 *      ARCH.md "Vouched vs claimed authorship" rules + "Author Accept" /
 *      "Author Resign" validity.
 *   2. `fetchConsentOpsForPaper` — SQL-shape verification via mocked
 *      `getPool()`.
 *
 * **Carve-out (per CLAUDE.md "Running Tests" +
 * `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`):**
 * the `fetchConsentOpsForPaper` tests mock `getPool()` (a shared pool
 * helper, in carve-out scope) so SQL-string regex assertions can pin
 * the production query shape per-mutation. Real-HAF execution cannot
 * distinguish single-namespace WHERE-clause mutations (e.g., dropping
 * `cj.custom_id = $1`) from a working query while only one `appTag`
 * namespace exists on chain. `verifyHiveSignature` and other
 * auth/permission middleware are NOT mocked.
 *
 * Risk classes covered by THIS file:
 *   - SQL-string shape: `cj.custom_id = $1`, `cj.block_num >= $2`,
 *     the action whitelist, root_author / root_permlink binding, the
 *     `cj.id::text` projection, the `ORDER BY cj.id DESC` clause, and
 *     the `LIMIT 1000` cap (see `describe('fetchConsentOpsForPaper —
 *     SQL contract')`).
 *   - Validity rules in `computeVouchedAuthors` (temporal-ordering,
 *     signer-binding, same-block tie-break, resign supersession,
 *     bridge-paper claimed-set membership).
 *
 * Real-path companion: `backend/tests/consent-ops-real-haf.test.ts`
 * exercises `fetchConsentOpsForPaper` against the real HAF pool and
 * covers the **row-shape regression** risk class (mutations that
 * change projected columns, action whitelist values, or paper-identity
 * filters such that the typed `ConsentOp` shape no longer matches what
 * the SQL returns). Together the two files cover the integrated path
 * per the carve-out convention's risk-class-equivalence rule.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(),
  getPoolMock: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getPool: getPoolMock,
  isHafAvailable: () => getPoolMock() !== null,
}));

// Stub `getCachedGenesisBlock` so the SQL-shape assertions don't depend on
// the global cache being warm in this isolated unit-test context.
vi.mock('../src/hafsql.js', async () => {
  const actual = await vi.importActual<typeof import('../src/hafsql.js')>('../src/hafsql.js');
  return {
    ...actual,
    getCachedGenesisBlock: () => 100_000_000,
  };
});

import {
  type ConsentOp,
  computeVouchedAuthors,
  fetchConsentOpsForPaper,
} from '../src/consent-ops.js';
import { config } from '../src/config.js';

beforeEach(() => {
  hafQueryMock.mockReset();
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
});

// ─── Test data builders ─────────────────────────────────────────────

function op(
  partial: Partial<ConsentOp> & Pick<ConsentOp, 'signer' | 'action' | 'blockNum'>,
): ConsentOp {
  return {
    rootAuthor: 'alice',
    rootPermlink: 'paper-v1',
    opId: String(BigInt(partial.blockNum) * 256n), // synthetic; preserves block_num→opId monotonicity
    ...partial,
  };
}

const PAPER = { rootAuthor: 'alice', rootPermlink: 'paper-v1' } as const;

// ─── computeVouchedAuthors — pure function ──────────────────────────

describe('computeVouchedAuthors — root broadcaster (ARCH.md rule 1)', () => {
  it('vouches root broadcaster implicitly when claimed', () => {
    const claimed = new Set(['alice']);
    const firstClaim = new Map([['alice', 100]]);
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, []);
    expect(vouched).toEqual(new Set(['alice']));
  });

  it('case-folds the root broadcaster handle', () => {
    const claimed = new Set(['alice']);
    const firstClaim = new Map([['alice', 100]]);
    const vouched = computeVouchedAuthors('Alice', claimed, firstClaim, []);
    expect(vouched).toEqual(new Set(['alice']));
  });

  it('does NOT vouch root broadcaster if absent from claimed set (defensive)', () => {
    // Degenerate metadata: chain author isn't in pevo.authors[]. Without a
    // claim, there's nothing to vouch. The chain-walk is the source of
    // truth; consent-ops doesn't second-guess it.
    const claimed = new Set(['someone-else']);
    const firstClaim = new Map([['someone-else', 100]]);
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, []);
    expect(vouched).toEqual(new Set());
  });
});

describe('computeVouchedAuthors — author_accept happy path (ARCH.md rule 2)', () => {
  it('vouches a claimed-pending author after a valid accept', () => {
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [op({ signer: 'bob', action: 'author_accept', blockNum: 120 })];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice', 'bob']));
  });

  it('case-folds the signer handle', () => {
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [op({ signer: 'BOB', action: 'author_accept', blockNum: 120 })];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice', 'bob']));
  });
});

describe('computeVouchedAuthors — temporal-ordering (ARCH.md "Author Accept" validity)', () => {
  it('rejects accept with blockNum equal to first-claim block (strict >)', () => {
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [op({ signer: 'bob', action: 'author_accept', blockNum: 110 })];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice']));
  });

  it('rejects accept with blockNum before first-claim block (name-squatting attack)', () => {
    // Bob pre-broadcasts an accept at block 50, then alice's continuation at
    // block 110 lists bob's handle. Without the temporal-ordering rule, the
    // pre-broadcast accept would activate retroactively. ARCH.md rejects.
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [op({ signer: 'bob', action: 'author_accept', blockNum: 50 })];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice']));
  });

  it('does NOT apply temporal-ordering to resign ops (per ARCH.md "Author Resign" validity)', () => {
    // Resigns can land at any block ≥ the resigner's claim block. (The
    // op is meaningless before the claim but not invalid; the resigner
    // would need to be in claimed set already to even matter.)
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [
      op({ signer: 'bob', action: 'author_accept', blockNum: 120 }),
      op({ signer: 'bob', action: 'author_resign', blockNum: 110 }),
    ];
    // Resign at 110 is older than accept at 120 → accept is the latest → vouched.
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice', 'bob']));
  });
});

describe('computeVouchedAuthors — resign + re-accept (ARCH.md rule 2)', () => {
  it('resign demotes a previously vouched author', () => {
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [
      op({ signer: 'bob', action: 'author_accept', blockNum: 120 }),
      op({ signer: 'bob', action: 'author_resign', blockNum: 200 }),
    ];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice']));
  });

  it('re-accept after resign restores vouched status', () => {
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [
      op({ signer: 'bob', action: 'author_accept', blockNum: 120 }),
      op({ signer: 'bob', action: 'author_resign', blockNum: 200 }),
      op({ signer: 'bob', action: 'author_accept', blockNum: 300 }),
    ];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice', 'bob']));
  });
});

describe('computeVouchedAuthors — same-block tie-break (convention rule 2)', () => {
  it('breaks same-block ties by opId DESC', () => {
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    // Same block 200; resign has higher opId → resign wins.
    const ops: ConsentOp[] = [
      { signer: 'bob', action: 'author_accept', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '51200' },
      { signer: 'bob', action: 'author_resign', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '51201' },
    ];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice']));
  });

  it('breaks same-block ties correctly when accept arrives later in the block', () => {
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [
      { signer: 'bob', action: 'author_resign', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '51200' },
      { signer: 'bob', action: 'author_accept', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '51201' },
    ];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice', 'bob']));
  });

  it('preserves correct ordering across BigInt-precision opIds', () => {
    // Real HAF op ids exceed Number.MAX_SAFE_INTEGER (~9e15). Lexicographic
    // string compare on these values produces wrong ordering, e.g.,
    // '455756464590425874' < '99999999999999999' lexicographically but the
    // first is numerically larger. The implementation MUST use BigInt
    // comparison; this test pins that.
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [
      { signer: 'bob', action: 'author_accept', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '455756464590425874' },
      { signer: 'bob', action: 'author_resign', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '99999999999999999' },
    ];
    // accept opId numerically > resign opId → accept wins → vouched.
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice', 'bob']));
  });
});

describe('computeVouchedAuthors — non-claimed signers (defense in depth)', () => {
  it('ignores accept ops from accounts not in the claimed set', () => {
    // Mallory hasn't been listed in pevo.authors[], so her accept is inert.
    //
    // Round-5 hold #7: divergent-guards mutation-kill design. The function
    // has TWO guards in series at consent-ops.ts:221 and :224:
    //   (a) `if (!claimedAuthors.has(signer)) continue;` — claimed-set
    //       membership check (the line this test pins).
    //   (b) `if (firstClaimBlockByAuthor.get(signer) === undefined) continue;`
    //       — first-claim-block presence check.
    // The naive setup that omits mallory from BOTH `claimed` AND `firstClaim`
    // means a mutation that drops guard (a) leaves mallory falling through
    // to guard (b), which fires because mallory has no firstClaimBlock entry.
    // Guard (b) ABSORBS the mutation: the test passes both pre- and post-
    // mutation. To kill the (a)-mutation specifically, mallory MUST be
    // present in `firstClaim` with a valid block (so guard (b) passes), AND
    // her accept must have a blockNum greater than her firstClaim (so the
    // temporal-ordering filter at consent-ops.ts:230 also passes). Then
    // dropping (a) admits mallory into the vouched set, the assertion
    // `expect(vouched).toEqual(Set(['alice']))` fails, and the mutation
    // is killed. Do NOT "simplify" this setup by removing mallory from
    // firstClaim — that re-introduces the dual-guard absorption.
    const claimed = new Set(['alice', 'bob']);
    // Mallory has a firstClaim block (50) but is NOT in the claimed set.
    // Without divergent-guards killing line 221, this test passed even
    // when 221 was deleted, because guard 224 absorbed the failure.
    const firstClaim = new Map([['alice', 100], ['bob', 110], ['mallory', 50]]);
    // Mallory's accept (blockNum 120 > her firstClaim 50) passes the
    // temporal-ordering filter; only the claimed-set guard at line 221
    // blocks her from vouching.
    const ops: ConsentOp[] = [op({ signer: 'mallory', action: 'author_accept', blockNum: 120 })];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice']));
  });

  it('ignores accept ops from claimed signer with no first-claim-block entry', () => {
    // Defensive: the caller's chain-walk should always produce a first-claim
    // block for every claimed handle. If it doesn't, we treat the claim as
    // unvalidatable and skip vouching.
    //
    // This test specifically pins guard (b) at consent-ops.ts:224 (the
    // firstClaimBlock-undefined check); the divergent-guards design makes
    // guard (a) above pin (a) (claimed-set membership), and the two
    // mutation-kills run in sibling tests rather than as one combined
    // setup. If a future refactor merges the two guards into one (e.g.,
    // a single `(claimed.has(s) && firstClaim.has(s))` predicate), THIS
    // test still kills that single-guard mutation cleanly because bob is
    // claimed-but-missing-from-firstClaim — the merged predicate would be
    // false and skip bob, but a mutation that flips the conjunction to
    // disjunction would admit bob and break this assertion.
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100]]); // bob missing
    const ops: ConsentOp[] = [op({ signer: 'bob', action: 'author_accept', blockNum: 120 })];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice']));
  });
});

describe('computeVouchedAuthors — multiple authors', () => {
  it('vouches each claimed author independently per their own consent history', () => {
    const claimed = new Set(['alice', 'bob', 'carol', 'dave']);
    const firstClaim = new Map([
      ['alice', 100], ['bob', 110], ['carol', 120], ['dave', 130],
    ]);
    const ops: ConsentOp[] = [
      op({ signer: 'bob', action: 'author_accept', blockNum: 200 }),     // bob: vouched
      op({ signer: 'carol', action: 'author_accept', blockNum: 200 }),
      op({ signer: 'carol', action: 'author_resign', blockNum: 250 }),   // carol: resigned
      // dave: never accepts — claimed-pending, not vouched
    ];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice', 'bob']));
  });
});

describe('computeVouchedAuthors — bridge papers (ARCH.md "Bridge papers" subsection)', () => {
  it('vouches only the bridge account; non-bridge signers cannot vouch onto a bridge paper (round-4 hold #7)', () => {
    // Bridge papers list original-preprint authors as `pevo.authors[].hive: null`
    // entries; the chain-walk strips these from the claimed set, leaving the
    // bridge account as the sole claimed author. ARCH.md "Bridge papers"
    // says the vouched-set is `{config.hiveBridgeAccount}` only; consent ops
    // by other accounts on bridge papers are inert.
    //
    // The structural enforcement here is the claimed-set membership check at
    // computeVouchedAuthors: a signer who isn't in `claimedAuthors` is
    // skipped regardless of any author_accept they broadcast. Mutation-kill:
    // a regression that vouched signers whose handle was NOT in the claimed
    // set would let mallory's accept op vouch onto the bridge paper here.
    //
    // Round-5 hold #7: divergent-guards mutation-kill design. Mallory MUST
    // be present in `firstClaim` (with a valid blockNum strictly less than
    // her accept's blockNum) so that the second guard at consent-ops.ts:224
    // (`firstClaimBlock === undefined → continue`) does NOT absorb the
    // mutation. The pre-fix setup put mallory in NEITHER `claimed` nor
    // `firstClaim`; deleting the line-221 guard left mallory falling through
    // to the line-224 guard, which fired because she had no firstClaimBlock
    // entry — silently absorbing the deletion. With mallory in firstClaim,
    // line 221's deletion admits her into the vouched set and this test's
    // `vouched.has('mallory')` assertion flips to true. Do NOT "simplify"
    // by removing mallory from firstClaim — that re-introduces the dual-
    // guard absorption.
    const bridgeAccount = config.hiveBridgeAccount;
    const claimed = new Set([bridgeAccount]);
    // Mallory has a firstClaim entry (50); the line-221 guard is the only
    // structural barrier between her and the vouched-set on a bridge paper.
    const firstClaim = new Map([[bridgeAccount, 100], ['mallory', 50]]);
    const ops: ConsentOp[] = [
      // mallory tries to vouch herself onto a bridge paper. Inert: she's
      // not in claimedAuthors. Her accept blockNum (200) > her firstClaim
      // (50), so the temporal-ordering filter at line 230 ALSO passes —
      // only the claimed-set guard blocks her.
      op({ signer: 'mallory', action: 'author_accept', blockNum: 200 }),
    ];
    const vouched = computeVouchedAuthors(bridgeAccount, claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set([bridgeAccount]));
    expect(vouched.has('mallory')).toBe(false);
  });

  it('a self-vouch by the bridge account is a no-op (already implicitly vouched as root broadcaster)', () => {
    // Defense-in-depth: even if a buggy admin tooling broadcast an
    // author_accept signed by the bridge account itself, the result is
    // identical (bridge account is already vouched implicitly).
    const bridgeAccount = config.hiveBridgeAccount;
    const claimed = new Set([bridgeAccount]);
    const firstClaim = new Map([[bridgeAccount, 100]]);
    const ops: ConsentOp[] = [
      op({ signer: bridgeAccount, action: 'author_accept', blockNum: 200 }),
    ];
    const vouched = computeVouchedAuthors(bridgeAccount, claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set([bridgeAccount]));
  });
});

describe('computeVouchedAuthors — case folding on signer field', () => {
  it('handles whitespace and case in op.signer', () => {
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [op({ signer: '  Bob  ', action: 'author_accept', blockNum: 120 })];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice', 'bob']));
  });

  it('skips ops with empty or whitespace-only signer', () => {
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [op({ signer: '   ', action: 'author_accept', blockNum: 120 })];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice']));
  });
});

// ─── fetchConsentOpsForPaper — SQL shape ─────────────────────────────

describe('fetchConsentOpsForPaper — SQL contract', () => {
  // Round-5 hold #2: claimed-set is now a parameter; the SQL filters
  // by `cj.required_posting_auths ->> 0 IN (claimed_set)` to defeat the
  // de-vouch spam attack. Tests that previously ran with no claimed-set
  // pass a 2-author claimed-set so the SQL `IN (...)` clause has
  // placeholders to bind against.
  const TEST_CLAIMED = new Set(['alice', 'bob']);

  it('filters by appTag, action whitelist, root_author, root_permlink, claimed-signer set, and genesis block', async () => {
    hafQueryMock.mockResolvedValue({ rows: [] });
    await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink, TEST_CLAIMED);

    expect(hafQueryMock).toHaveBeenCalledOnce();
    const [sql, params] = hafQueryMock.mock.calls[0];

    // appTag binds via custom_id ($1).
    expect(sql).toMatch(/cj\.custom_id\s*=\s*\$1/);
    // genesis block ≥ floor ($2) — prevents full-history scan.
    expect(sql).toMatch(/cj\.block_num\s*>=\s*\$2/);
    // Action whitelist — restricts to consent ops only.
    expect(sql).toMatch(/'action'\s+IN\s*\(\s*'author_accept'\s*,\s*'author_resign'\s*\)/);
    // Paper identity binds via $3 / $4.
    expect(sql).toMatch(/'root_author'\s*=\s*\$3/);
    expect(sql).toMatch(/'root_permlink'\s*=\s*\$4/);
    // Round-5 hold #2: claimed-signer filter — push the claimed-set
    // membership check INTO the SQL so the LIMIT 1000 cap can't be
    // exhausted by attacker-signed spam ops. Each claimed account
    // becomes a separate $N placeholder starting at $5.
    expect(sql).toMatch(/cj\.required_posting_auths\s*->>\s*0\s+IN\s*\(\s*\$5\s*,\s*\$6\s*\)/);
    // Required output columns for the ConsentOp shape.
    expect(sql).toMatch(/required_posting_auths\s*->>\s*0\s+AS\s+signer/);
    expect(sql).toMatch(/cj\.id::text\s+AS\s+op_id/);
    expect(sql).toMatch(/cj\.block_num\s+AS\s+block_num/);
    // Round-4 hold #4: ORDER BY id DESC + LIMIT 1000 bound the row set
    // under consent-op spam. Pin both clauses so a regression that drops
    // either surfaces. The LIMIT value is sized for the cumulative-union
    // task's expected chain length.
    expect(sql).toMatch(/ORDER\s+BY\s+cj\.id\s+DESC/);
    expect(sql).toMatch(/LIMIT\s+1000/);

    expect(params).toEqual([
      config.appTag,
      100_000_000,
      PAPER.rootAuthor,
      PAPER.rootPermlink,
      'alice',
      'bob',
    ]);
  });

  it('returns parsed ConsentOp shape with case-folded signer and stringified opId', async () => {
    hafQueryMock.mockResolvedValue({
      rows: [{
        signer: 'BOB',
        action: 'author_accept',
        root_author: 'alice',
        root_permlink: 'paper-v1',
        block_num: 200,
        op_id: '455756464590425874',
      }],
    });
    const ops = await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink, TEST_CLAIMED);

    expect(ops).toEqual([{
      signer: 'bob',
      action: 'author_accept',
      rootAuthor: 'alice',
      rootPermlink: 'paper-v1',
      blockNum: 200,
      opId: '455756464590425874',
    }]);
  });

  it('returns [] when HAF pool is unavailable', async () => {
    getPoolMock.mockReturnValue(null);
    const ops = await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink, TEST_CLAIMED);
    expect(ops).toEqual([]);
    expect(hafQueryMock).not.toHaveBeenCalled();
  });

  it('returns [] when the HAF query throws (fail-closed; empty op set yields just root broadcaster)', async () => {
    hafQueryMock.mockRejectedValue(new Error('connection refused'));
    const ops = await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink, TEST_CLAIMED);
    expect(ops).toEqual([]);
  });

  // Round-5 hold #2: empty claimed-set short-circuits BEFORE the SQL
  // is issued. Avoids the `IN ()` invalid-SQL shape and matches the
  // semantic at `computeVouchedAuthors`: no claimed authors means no
  // possible vouchable signers.
  it('short-circuits to [] when claimedAuthors is empty (no SQL issued)', async () => {
    const ops = await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink, new Set());
    expect(ops).toEqual([]);
    expect(hafQueryMock).not.toHaveBeenCalled();
  });

  // Round-5 hold #2: mutation-kill for the SQL signer-filter. The
  // attack scenario:
  //   - claimed = {alice, bob, carol}
  //   - mallory (NOT in claimed) spams 1000 author_accept ops at high
  //     cj.id
  //   - bob's legitimate accept lives at low cj.id
  // Without the signer filter: the LIMIT 1000 ORDER BY id DESC fetches
  // mallory's spam, bob's accept is invisible, bob is de-vouched.
  // With the filter: mallory's rows never enter the result set; bob's
  // accept is visible regardless of mallory's id-position.
  it('signer filter at the SQL excludes non-claimed signers from the row set under spam (mutation kill)', async () => {
    // Simulate: HAF returns ONLY the rows that pass the SQL signer
    // filter. The mock asserts that the query ran with the claimed
    // set bound, then returns bob's legitimate accept row plus a
    // sanity check: a row with mallory as the signer is NOT in the
    // returned set even if HAF would otherwise have surfaced it.
    hafQueryMock.mockImplementation(async (_sql: string, params: unknown[]) => {
      // The claimed-set is bound at $5..$N. Confirm mallory is NOT
      // in the bound set (defense in depth — the filter pushes the
      // check into the database).
      const claimedBindings = params.slice(4) as string[];
      expect(claimedBindings).not.toContain('mallory');
      expect(claimedBindings).toEqual(expect.arrayContaining(['alice', 'bob', 'carol']));
      // Return only legitimate-signer rows (HAF would filter
      // attacker rows out via the SQL `IN` clause).
      return {
        rows: [{
          signer: 'bob',
          action: 'author_accept',
          root_author: 'alice',
          root_permlink: 'paper-v1',
          block_num: 100,
          op_id: '999',
        }],
      };
    });

    const ops = await fetchConsentOpsForPaper(
      'alice',
      'paper-v1',
      new Set(['alice', 'bob', 'carol']),
    );
    expect(ops.map((op) => op.signer)).toEqual(['bob']);
    expect(ops.map((op) => op.signer)).not.toContain('mallory');
  });
});
