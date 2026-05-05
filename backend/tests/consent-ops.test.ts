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
 * **Carve-out (per CLAUDE.md "Running Tests"):** the fetcher tests mock
 * `getPool()` because no `author_accept` / `author_resign` ops exist on the
 * real chain yet (the broadcast surface lands in round 3 of this task, the
 * UI surface in `ui-multi-author-consent-affordances`). Until either lands,
 * a real-HAF test would assert against an empty op set, which can't
 * distinguish "fetcher works correctly and the chain is empty" from
 * "fetcher SQL is broken." The mocked-pool variant pins the SQL contract.
 * `verifyHiveSignature` and other middleware are NOT mocked. Real-HAF
 * coverage lands in round 2's integration tests once the consent-ops
 * fetcher is exercised through `resolveContinuationChain`.
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
    const claimed = new Set(['alice', 'bob']);
    const firstClaim = new Map([['alice', 100], ['bob', 110]]);
    const ops: ConsentOp[] = [op({ signer: 'mallory', action: 'author_accept', blockNum: 120 })];
    const vouched = computeVouchedAuthors('alice', claimed, firstClaim, ops);
    expect(vouched).toEqual(new Set(['alice']));
  });

  it('ignores accept ops from claimed signer with no first-claim-block entry', () => {
    // Defensive: the caller's chain-walk should always produce a first-claim
    // block for every claimed handle. If it doesn't, we treat the claim as
    // unvalidatable and skip vouching.
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
  it('filters by appTag, action whitelist, root_author, root_permlink, and genesis block', async () => {
    hafQueryMock.mockResolvedValue({ rows: [] });
    await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink);

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
    // Required output columns for the ConsentOp shape.
    expect(sql).toMatch(/required_posting_auths\s*->>\s*0\s+AS\s+signer/);
    expect(sql).toMatch(/cj\.id::text\s+AS\s+op_id/);
    expect(sql).toMatch(/cj\.block_num\s+AS\s+block_num/);

    expect(params).toEqual([config.appTag, 100_000_000, PAPER.rootAuthor, PAPER.rootPermlink]);
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
    const ops = await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink);

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
    const ops = await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink);
    expect(ops).toEqual([]);
    expect(hafQueryMock).not.toHaveBeenCalled();
  });

  it('returns [] when the HAF query throws (fail-closed; empty op set yields just root broadcaster)', async () => {
    hafQueryMock.mockRejectedValue(new Error('connection refused'));
    const ops = await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink);
    expect(ops).toEqual([]);
  });
});
