/**
 * Consented-set computation helpers (`consent-ops.ts`).
 *
 * Coverage:
 *   1. `computeConsentedAuthors` — pure function, exhaustive unit coverage of
 *      ARCH.md "Consented vs claimed authorship" rules + "Author Accept" /
 *      "Author Resign" validity, including the attested-ORCID anchor arm.
 *   2. `fetchConsentOpsForPaper` — SQL-shape verification via mocked
 *      `getPool()`, plus the fail-closed `haf_unavailable` discriminant.
 *   3. `getConsentedAuthors` — eligible-signer derivation (hive anchors plus
 *      attested-ORCID matches) and `haf_unavailable` propagation.
 *
 * The hive-anchored cases are the characterization of the pre-ORCID-anchor
 * behavior (each maps 1:1 onto a former claimed-set + first-claim-block-map
 * case), so the ORCID anchor extension is provably additive.
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
 *   - SQL-string shape: `cj.custom_id = $1`, the action whitelist,
 *     root_author / root_permlink binding, the `cj.id::text`
 *     projection, the `ORDER BY cj.id DESC` clause, and the `LIMIT
 *     1000` cap (see `describe('fetchConsentOpsForPaper — SQL
 *     contract')`). The genesis-block floor was BitmapAnd-toxic and
 *     inert, so it was dropped from the query.
 *   - Validity rules in `computeConsentedAuthors` (temporal-ordering,
 *     signer-binding, same-block tie-break, resign supersession,
 *     bridge-paper anchored-slot membership, attested-vs-claimed ORCID).
 *   - Fail-closed discriminant: pool-absent and query-throw both yield
 *     `{ status: 'haf_unavailable' }`, distinguishable from a legitimate
 *     empty op history.
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
  isHafConfigured: () => getPoolMock() !== null,
}));

import {
  type ClaimedSlot,
  type ConsentOp,
  computeConsentedAuthors,
  fetchConsentOpsForPaper,
  getConsentedAuthors,
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

/** Hive-anchored slot (the characterization shape: one slot per claimed handle). */
function hiveSlot(hive: string, firstAppearanceBlock: number): ClaimedSlot {
  return { hive, orcid: null, firstAppearanceBlock };
}

/** Orcid-anchored slot (no hive — the "original author knows only the ORCID" shape). */
function orcidSlot(orcid: string, firstAppearanceBlock: number): ClaimedSlot {
  return { hive: null, orcid, firstAppearanceBlock };
}

/** No attested ORCIDs for anyone — the hive-anchor-only characterization map. */
const NO_ATTESTATIONS: ReadonlyMap<string, string | null> = new Map();

const PAPER = { rootAuthor: 'alice', rootPermlink: 'paper-v1' } as const;

// ─── computeConsentedAuthors — pure function ──────────────────────────

describe('computeConsentedAuthors — root broadcaster (ARCH.md rule 1)', () => {
  it('consents root broadcaster implicitly when a slot anchors them', () => {
    const slots = [hiveSlot('alice', 100)];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, []);
    expect(consented).toEqual(new Set(['alice']));
  });

  it('case-folds the root broadcaster handle', () => {
    const slots = [hiveSlot('alice', 100)];
    const consented = computeConsentedAuthors('Alice', slots, NO_ATTESTATIONS, []);
    expect(consented).toEqual(new Set(['alice']));
  });

  it('does NOT consent root broadcaster if no slot anchors them (defensive)', () => {
    // Degenerate metadata: chain author isn't in pevo.authors[]. Without a
    // claim, there's nothing to consent. The chain-walk is the source of
    // truth; consent-ops doesn't second-guess it.
    const slots = [hiveSlot('someone-else', 100)];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, []);
    expect(consented).toEqual(new Set());
  });
});

describe('computeConsentedAuthors — author_accept happy path (ARCH.md rule 2)', () => {
  it('consents a claimed-pending author after a valid accept', () => {
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [op({ signer: 'bob', action: 'author_accept', blockNum: 120 })];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice', 'bob']));
  });

  it('case-folds the signer handle', () => {
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [op({ signer: 'BOB', action: 'author_accept', blockNum: 120 })];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice', 'bob']));
  });

  it('a continuation-added anchored slot is resolvable (first appearance mid-chain)', () => {
    // eve's slot first appears in a continuation post (block 200), not the
    // root. Her accept after that block consents her like any anchored slot.
    const slots = [hiveSlot('alice', 100), hiveSlot('eve', 200)];
    const ops: ConsentOp[] = [op({ signer: 'eve', action: 'author_accept', blockNum: 210 })];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice', 'eve']));
  });
});

describe('computeConsentedAuthors — attested-ORCID anchor (ARCH.md rule 2, orcid arm)', () => {
  const CAROL_ORCID = '0000-0002-1111-2222';

  it('consents an orcid-anchored signer whose ATTESTED orcid matches the slot', () => {
    const slots = [hiveSlot('alice', 100), orcidSlot(CAROL_ORCID, 100)];
    const attested = new Map([['carol', CAROL_ORCID]]);
    const ops: ConsentOp[] = [op({ signer: 'carol', action: 'author_accept', blockNum: 150 })];
    const consented = computeConsentedAuthors('alice', slots, attested, ops);
    expect(consented).toEqual(new Set(['alice', 'carol']));
  });

  it('suppresses a signer with NO attestation entry against an orcid-anchored slot', () => {
    // carol's account has never been attested. The slot's orcid is a
    // broadcaster claim; without the on-chain attestation there is no proof
    // carol owns it, so her accept is inert.
    const slots = [hiveSlot('alice', 100), orcidSlot(CAROL_ORCID, 100)];
    const ops: ConsentOp[] = [op({ signer: 'carol', action: 'author_accept', blockNum: 150 })];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice']));
  });

  it('suppresses a signer whose attestation carries a NULL orcid (accredited, no ORCID on file)', () => {
    // An attested-then-revoked ORCID resolves the same way: the caller
    // supplies the latest-action-wins attestation state, so a revoked
    // attestation surfaces here as a null (or absent) entry.
    const slots = [hiveSlot('alice', 100), orcidSlot(CAROL_ORCID, 100)];
    const attested = new Map<string, string | null>([['carol', null]]);
    const ops: ConsentOp[] = [op({ signer: 'carol', action: 'author_accept', blockNum: 150 })];
    const consented = computeConsentedAuthors('alice', slots, attested, ops);
    expect(consented).toEqual(new Set(['alice']));
  });

  it('suppresses a signer whose attested orcid differs from the slot orcid', () => {
    const slots = [hiveSlot('alice', 100), orcidSlot(CAROL_ORCID, 100)];
    const attested = new Map([['carol', '0000-0009-9999-9999']]);
    const ops: ConsentOp[] = [op({ signer: 'carol', action: 'author_accept', blockNum: 150 })];
    const consented = computeConsentedAuthors('alice', slots, attested, ops);
    expect(consented).toEqual(new Set(['alice']));
  });

  it('applies the temporal lower bound to orcid-anchored accepts too', () => {
    const slots = [hiveSlot('alice', 100), orcidSlot(CAROL_ORCID, 200)];
    const attested = new Map([['carol', CAROL_ORCID]]);
    const ops: ConsentOp[] = [op({ signer: 'carol', action: 'author_accept', blockNum: 150 })];
    const consented = computeConsentedAuthors('alice', slots, attested, ops);
    expect(consented).toEqual(new Set(['alice']));
  });

  it('a signer anchored by BOTH a hive and an orcid slot is eligible from the earliest', () => {
    // bob's hive slot first appears at block 300; an orcid slot matching his
    // attested ORCID appeared earlier at block 100. The Rule-6 lower bound is
    // the MIN across anchoring slots, so an accept at 150 is valid.
    const BOB_ORCID = '0000-0001-2345-6789';
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 300), orcidSlot(BOB_ORCID, 100)];
    const attested = new Map([['bob', BOB_ORCID]]);
    const ops: ConsentOp[] = [op({ signer: 'bob', action: 'author_accept', blockNum: 150 })];
    const consented = computeConsentedAuthors('alice', slots, attested, ops);
    expect(consented).toEqual(new Set(['alice', 'bob']));
  });
});

describe('computeConsentedAuthors — temporal-ordering (ARCH.md "Author Accept" validity)', () => {
  it('rejects accept with blockNum equal to first-appearance block (strict >)', () => {
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [op({ signer: 'bob', action: 'author_accept', blockNum: 110 })];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice']));
  });

  it('rejects accept with blockNum before first-appearance block (name-squatting attack)', () => {
    // Bob pre-broadcasts an accept at block 50, then alice's continuation at
    // block 110 lists bob's handle. Without the temporal-ordering rule, the
    // pre-broadcast accept would activate retroactively. ARCH.md rejects.
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [op({ signer: 'bob', action: 'author_accept', blockNum: 50 })];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice']));
  });

  it('does NOT apply temporal-ordering to resign ops (per ARCH.md "Author Resign" validity)', () => {
    // Resigns can land at any block ≥ the resigner's claim block. (The
    // op is meaningless before the claim but not invalid; the resigner
    // would need an anchoring slot already to even matter.)
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [
      op({ signer: 'bob', action: 'author_accept', blockNum: 120 }),
      op({ signer: 'bob', action: 'author_resign', blockNum: 110 }),
    ];
    // Resign at 110 is older than accept at 120 → accept is the latest → consented.
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice', 'bob']));
  });
});

describe('computeConsentedAuthors — resign + re-accept (ARCH.md rule 2)', () => {
  it('resign demotes a previously consented author', () => {
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [
      op({ signer: 'bob', action: 'author_accept', blockNum: 120 }),
      op({ signer: 'bob', action: 'author_resign', blockNum: 200 }),
    ];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice']));
  });

  it('re-accept after resign restores consented status', () => {
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [
      op({ signer: 'bob', action: 'author_accept', blockNum: 120 }),
      op({ signer: 'bob', action: 'author_resign', blockNum: 200 }),
      op({ signer: 'bob', action: 'author_accept', blockNum: 300 }),
    ];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice', 'bob']));
  });
});

describe('computeConsentedAuthors — same-block tie-break (convention rule 2)', () => {
  it('breaks same-block ties by opId DESC', () => {
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    // Same block 200; resign has higher opId → resign wins.
    const ops: ConsentOp[] = [
      { signer: 'bob', action: 'author_accept', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '51200' },
      { signer: 'bob', action: 'author_resign', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '51201' },
    ];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice']));
  });

  it('breaks same-block ties correctly when accept arrives later in the block', () => {
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [
      { signer: 'bob', action: 'author_resign', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '51200' },
      { signer: 'bob', action: 'author_accept', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '51201' },
    ];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice', 'bob']));
  });

  it('preserves correct ordering across BigInt-precision opIds', () => {
    // Real HAF op ids exceed Number.MAX_SAFE_INTEGER (~9e15). Lexicographic
    // string compare on these values produces wrong ordering, e.g.,
    // '455756464590425874' < '99999999999999999' lexicographically but the
    // first is numerically larger. The implementation MUST use BigInt
    // comparison; this test pins that.
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [
      { signer: 'bob', action: 'author_accept', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '455756464590425874' },
      { signer: 'bob', action: 'author_resign', rootAuthor: 'alice', rootPermlink: 'paper-v1', blockNum: 200, opId: '99999999999999999' },
    ];
    // accept opId numerically > resign opId → accept wins → consented.
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice', 'bob']));
  });
});

describe('computeConsentedAuthors — unanchored signers (defense in depth)', () => {
  it('ignores accept ops from accounts no slot anchors (temporally valid accept)', () => {
    // Mallory hasn't been listed in pevo.authors[] by hive, and no orcid
    // slot matches an attested ORCID of hers, so her accept is inert. The
    // op's blockNum is deliberately AFTER every slot's first appearance so
    // the temporal-ordering filter cannot absorb a mutation that drops the
    // anchoring check — only `slotsAnchoring` returning empty blocks her.
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [op({ signer: 'mallory', action: 'author_accept', blockNum: 120 })];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice']));
  });

  it('a broadcaster-claimed orcid on a slot does NOT anchor its claimer without attestation', () => {
    // mallory broadcasts an accept claiming the orcid slot; her account has
    // no attestation entry. The broadcaster-controlled slot orcid alone must
    // never anchor — only the authority-attested ORCID proves ownership.
    const slots = [hiveSlot('alice', 100), orcidSlot('0000-0002-1111-2222', 100)];
    const ops: ConsentOp[] = [op({ signer: 'mallory', action: 'author_accept', blockNum: 200 })];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice']));
  });
});

describe('computeConsentedAuthors — multiple authors', () => {
  it('consents each claimed author independently per their own consent history', () => {
    const slots = [
      hiveSlot('alice', 100), hiveSlot('bob', 110), hiveSlot('carol', 120), hiveSlot('dave', 130),
    ];
    const ops: ConsentOp[] = [
      op({ signer: 'bob', action: 'author_accept', blockNum: 200 }),     // bob: consented
      op({ signer: 'carol', action: 'author_accept', blockNum: 200 }),
      op({ signer: 'carol', action: 'author_resign', blockNum: 250 }),   // carol: resigned
      // dave: never accepts — claimed-pending, not consented
    ];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice', 'bob']));
  });
});

describe('computeConsentedAuthors — bridge papers (ARCH.md "Bridge papers" subsection)', () => {
  it('consents only the bridge account; non-bridge signers cannot consent onto a bridge paper', () => {
    // Bridge papers list original-preprint authors as `pevo.authors[].hive: null`
    // entries; the chain-walk strips these from the claimed slot set, leaving
    // the bridge account as the sole anchored author. ARCH.md "Bridge papers"
    // says the consented-set is `{config.hiveBridgeAccount}` only; consent ops
    // by other accounts on bridge papers are inert.
    //
    // Mutation-kill design: mallory's accept blockNum (200) is AFTER every
    // slot's first appearance, so the temporal-ordering filter passes and
    // ONLY the anchoring check (`slotsAnchoring` returning empty) blocks
    // her. A regression that consents unanchored signers admits mallory
    // here and flips the assertion.
    const bridgeAccount = config.hiveBridgeAccount;
    const slots = [hiveSlot(bridgeAccount, 100)];
    const ops: ConsentOp[] = [
      op({ signer: 'mallory', action: 'author_accept', blockNum: 200 }),
    ];
    const consented = computeConsentedAuthors(bridgeAccount, slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set([bridgeAccount]));
    expect(consented.has('mallory')).toBe(false);
  });

  it('a self-accept by the bridge account is a no-op (already implicitly consented as root broadcaster)', () => {
    // Defense-in-depth: even if a buggy admin tooling broadcast an
    // author_accept signed by the bridge account itself, the result is
    // identical (bridge account is already consented implicitly).
    const bridgeAccount = config.hiveBridgeAccount;
    const slots = [hiveSlot(bridgeAccount, 100)];
    const ops: ConsentOp[] = [
      op({ signer: bridgeAccount, action: 'author_accept', blockNum: 200 }),
    ];
    const consented = computeConsentedAuthors(bridgeAccount, slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set([bridgeAccount]));
  });
});

describe('computeConsentedAuthors — case folding on signer field', () => {
  it('handles whitespace and case in op.signer', () => {
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [op({ signer: '  Bob  ', action: 'author_accept', blockNum: 120 })];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice', 'bob']));
  });

  it('skips ops with empty or whitespace-only signer', () => {
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const ops: ConsentOp[] = [op({ signer: '   ', action: 'author_accept', blockNum: 120 })];
    const consented = computeConsentedAuthors('alice', slots, NO_ATTESTATIONS, ops);
    expect(consented).toEqual(new Set(['alice']));
  });
});

// ─── fetchConsentOpsForPaper — SQL shape ─────────────────────────────

describe('fetchConsentOpsForPaper — SQL contract', () => {
  // The eligible-signer set is a parameter; the SQL filters by
  // `cj.required_posting_auths ->> 0 IN (eligible set)` to defeat the
  // de-consent spam attack (attacker ops exhausting the LIMIT cap).
  const TEST_ELIGIBLE = new Set(['alice', 'bob']);

  it('filters by appTag, action whitelist, root_author, root_permlink, and eligible-signer set', async () => {
    hafQueryMock.mockResolvedValue({ rows: [] });
    await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink, TEST_ELIGIBLE);

    expect(hafQueryMock).toHaveBeenCalledOnce();
    const [sql, params] = hafQueryMock.mock.calls[0];

    // appTag binds via custom_id ($1).
    expect(sql).toMatch(/cj\.custom_id\s*=\s*\$1/);
    // No block_num >= floor: the genesis floor was BitmapAnd-toxic and inert
    // (pre-genesis PEvO custom_jsons cannot exist), so it was dropped.
    expect(sql).not.toMatch(/block_num\s*>=/);
    // Action whitelist — restricts to consent ops only.
    expect(sql).toMatch(/'action'\s+IN\s*\(\s*'author_accept'\s*,\s*'author_resign'\s*\)/);
    // Paper identity binds via $2 / $3.
    expect(sql).toMatch(/'root_author'\s*=\s*\$2/);
    expect(sql).toMatch(/'root_permlink'\s*=\s*\$3/);
    // Eligible-signer filter — push the membership check INTO the SQL so
    // the LIMIT 1000 cap can't be exhausted by attacker-signed spam ops.
    // Each eligible account becomes a separate $N placeholder starting at $4.
    expect(sql).toMatch(/cj\.required_posting_auths\s*->>\s*0\s+IN\s*\(\s*\$4\s*,\s*\$5\s*\)/);
    // Required output columns for the ConsentOp shape.
    expect(sql).toMatch(/required_posting_auths\s*->>\s*0\s+AS\s+signer/);
    expect(sql).toMatch(/cj\.id::text\s+AS\s+op_id/);
    expect(sql).toMatch(/cj\.block_num\s+AS\s+block_num/);
    // ORDER BY id DESC + LIMIT 1000 bound the row set under consent-op
    // spam. Pin both clauses so a regression that drops either surfaces.
    // The LIMIT value is sized for the cumulative-union chain length.
    expect(sql).toMatch(/ORDER\s+BY\s+cj\.id\s+DESC/);
    expect(sql).toMatch(/LIMIT\s+1000/);

    expect(params).toEqual([
      config.appTag,
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
    const result = await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink, TEST_ELIGIBLE);

    expect(result).toEqual({
      status: 'ok',
      ops: [{
        signer: 'bob',
        action: 'author_accept',
        rootAuthor: 'alice',
        rootPermlink: 'paper-v1',
        blockNum: 200,
        opId: '455756464590425874',
      }],
    });
  });

  it('returns haf_unavailable when the HAF pool is absent (fail-closed, NOT an empty op set)', async () => {
    getPoolMock.mockReturnValue(null);
    const result = await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink, TEST_ELIGIBLE);
    expect(result).toEqual({ status: 'haf_unavailable' });
    expect(hafQueryMock).not.toHaveBeenCalled();
  });

  it('returns haf_unavailable when the HAF query throws (fail-closed, NOT an empty op set)', async () => {
    // An availability fault must be distinguishable from "no consent ops":
    // collapsing it to ops: [] would silently demote every non-root
    // co-author for the duration of a HAF flap.
    hafQueryMock.mockRejectedValue(new Error('connection refused'));
    const result = await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink, TEST_ELIGIBLE);
    expect(result).toEqual({ status: 'haf_unavailable' });
  });

  // An empty eligible set short-circuits BEFORE the SQL is issued. Avoids
  // the `IN ()` invalid-SQL shape and matches the semantic at
  // `computeConsentedAuthors`: no eligible signers means no resolvable
  // consent ops. This is a real "no ops" answer (status ok), not a fault.
  it('short-circuits to ok/empty when the eligible set is empty (no SQL issued)', async () => {
    const result = await fetchConsentOpsForPaper(PAPER.rootAuthor, PAPER.rootPermlink, new Set());
    expect(result).toEqual({ status: 'ok', ops: [] });
    expect(hafQueryMock).not.toHaveBeenCalled();
  });

  // Mutation-kill for the SQL signer-filter. The attack scenario:
  //   - eligible = {alice, bob, carol}
  //   - mallory (NOT eligible) spams 1000 author_accept ops at high cj.id
  //   - bob's legitimate accept lives at low cj.id
  // Without the signer filter: the LIMIT 1000 ORDER BY id DESC fetches
  // mallory's spam, bob's accept is invisible, bob is de-consented.
  // With the filter: mallory's rows never enter the result set; bob's
  // accept is visible regardless of mallory's id-position.
  it('signer filter at the SQL excludes non-eligible signers from the row set under spam (mutation kill)', async () => {
    // Simulate: HAF returns ONLY the rows that pass the SQL signer
    // filter. The mock asserts that the query ran with the eligible
    // set bound, then returns bob's legitimate accept row.
    hafQueryMock.mockImplementation(async (_sql: string, params: unknown[]) => {
      // The eligible set is bound at $4..$N. Confirm mallory is NOT
      // in the bound set (defense in depth — the filter pushes the
      // check into the database).
      const signerBindings = params.slice(3) as string[];
      expect(signerBindings).not.toContain('mallory');
      expect(signerBindings).toEqual(expect.arrayContaining(['alice', 'bob', 'carol']));
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

    const result = await fetchConsentOpsForPaper(
      'alice',
      'paper-v1',
      new Set(['alice', 'bob', 'carol']),
    );
    expect(result.status).toBe('ok');
    const signers = result.status === 'ok' ? result.ops.map((o) => o.signer) : [];
    expect(signers).toEqual(['bob']);
    expect(signers).not.toContain('mallory');
  });
});

// ─── getConsentedAuthors — orchestration ─────────────────────────────

describe('getConsentedAuthors — eligible-signer derivation + fail-closed propagation', () => {
  const CAROL_ORCID = '0000-0002-1111-2222';

  it('derives eligible signers from hive anchors plus attested-ORCID matches', async () => {
    hafQueryMock.mockResolvedValue({ rows: [] });
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110), orcidSlot(CAROL_ORCID, 100)];
    const attested = new Map<string, string | null>([
      ['carol', CAROL_ORCID],          // matches the orcid slot → eligible
      ['dave', '0000-0009-0000-0001'], // attested but matches no slot → not eligible
      ['erin', null],                  // accredited, no ORCID on file → not eligible
    ]);
    await getConsentedAuthors(PAPER.rootAuthor, PAPER.rootPermlink, slots, attested);

    expect(hafQueryMock).toHaveBeenCalledOnce();
    const [, params] = hafQueryMock.mock.calls[0];
    const bound = (params as unknown[]).slice(3) as string[];
    expect(new Set(bound)).toEqual(new Set(['alice', 'bob', 'carol']));
  });

  it('returns the computed consented set on ok', async () => {
    hafQueryMock.mockResolvedValue({
      rows: [{
        signer: 'carol',
        action: 'author_accept',
        root_author: 'alice',
        root_permlink: 'paper-v1',
        block_num: 150,
        op_id: '1000',
      }],
    });
    const slots = [hiveSlot('alice', 100), orcidSlot(CAROL_ORCID, 100)];
    const attested = new Map([['carol', CAROL_ORCID]]);
    const result = await getConsentedAuthors(PAPER.rootAuthor, PAPER.rootPermlink, slots, attested);
    expect(result).toEqual({ status: 'ok', consented: new Set(['alice', 'carol']) });
  });

  it('propagates haf_unavailable instead of degrading to a root-only set', async () => {
    getPoolMock.mockReturnValue(null);
    const slots = [hiveSlot('alice', 100), hiveSlot('bob', 110)];
    const result = await getConsentedAuthors(PAPER.rootAuthor, PAPER.rootPermlink, slots, NO_ATTESTATIONS);
    expect(result).toEqual({ status: 'haf_unavailable' });
  });
});
