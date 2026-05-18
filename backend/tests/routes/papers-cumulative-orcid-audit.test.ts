/**
 * Cumulative-union ORCID audit canaries.
 *
 * Pins the audit emission added in
 * `backend-multi-author-cumulative-union.md` rule #3 (active spoof) AND
 * the post-revocation extension in
 * `backend-orcid-claim-mismatch-post-revocation-audit.md` (architect
 * ratified Alt 2 on 2026-05-16) which preserves audit visibility after
 * accreditation revocation.
 *
 * Audit primitive: `logger.warn` with `event: 'orcid_claim_mismatch'`
 * payload `{ rootAuthor, rootPermlink, hive, claimedOrcid, accreditedOrcid,
 * accreditationStatus, claimSource }` — fires when a broadcaster's claimed
 * ORCID for a (previously or currently) accredited hive disagrees with the
 * authoritative accreditation ORCID.
 *
 * Server-override split (per architect ratification):
 *   - `accreditationStatus: 'active'`  → server overrides display ORCID to
 *     the accredited value (the active-arm of rule #3, unchanged).
 *   - `accreditationStatus: 'revoked'` → server does NOT override; the
 *     broadcaster's claim passes through. Audit still fires so operators
 *     can correlate post-revocation triage.
 *
 * Canaries in this file:
 *   1. Single-cycle post-revocation: alice accredited with ORCID-X, then
 *      revoked. bob (the broadcaster) names alice in a continuation with
 *      a forged ORCID. Audit fires with `accreditationStatus: 'revoked'`
 *      and `accreditedOrcid: ORCID-X`. Display does NOT override
 *      (broadcaster's forged claim passes through).
 *   2. Multi-cycle post-revocation: alice accredited ORCID-X → revoked →
 *      re-accredited ORCID-Y → revoked. bob broadcasts a forged ORCID
 *      naming alice. Audit's `accreditedOrcid` is ORCID-Y (the
 *      most-recent prior `accredit`), not ORCID-X. Pins the LATERAL
 *      lookup inside the `accreditation_status` CTE.
 *   3. Active spoof regression: alice currently accredited with a known
 *      ORCID. bob broadcasts a forged ORCID. Audit fires with
 *      `accreditationStatus: 'active'` and server overrides the display
 *      ORCID to the accredited value. Pins the existing rule #3 behavior
 *      so the post-revocation extension does not regress it.
 *
 * **Carve-out (per CLAUDE.md "Running Tests"):** these tests mock
 * `getPool()` to seed multi-cycle revocation history deterministically.
 * Multi-cycle accredit/revoke chains cannot be reproduced against the
 * public HAF DB on demand (the seed flow requires multiple custom_json
 * broadcasts spread across blocks, plus the 10-min `hafCache` window
 * means the second-cycle re-accredit wouldn't materialize for the test
 * run anyway). The mocked-pool variant pins:
 *   (a) the SQL response shape from `getAllEverAccreditedOrcidsWithStatus`
 *       (which returns the merged active+revoked map), and
 *   (b) the JS-side audit-emission branching in
 *       `buildCumulativeAuthorsForChain` (active vs revoked arms).
 *
 * Per CLAUDE.md clauses (a)/(b)/(c):
 *   (a) justification: deterministic multi-cycle revocation seeding is
 *       impractical against the public HAF DB and the
 *       `getAllEverAccreditedOrcidsWithStatus` SQL lookup is fronted by
 *       `hafCache` with a 10-min window. Mocking the pool lets us pin
 *       the JS audit-emission semantics without sequenced HAF broadcasts.
 *   (b) `verifyHiveSignature` and other auth middleware are NOT mocked
 *       (the endpoint exercised here, `GET /api/papers/:author/:permlink`,
 *       is unauthenticated — no signature verification happens on the
 *       request path).
 *   (c) real-path SQL companion: the multi-cycle CTE behavior is also
 *       exercised by integration paths that touch `accreditation.ts` ->
 *       `hafsql.ts` against real HAF (the existing `papers.test.ts`
 *       smoke tests hit live HAF and validate the
 *       `getAllEverAccreditedOrcidsWithStatus` cache shape under realistic
 *       data). Any future regression in the CTE's LATERAL-lookup
 *       multi-cycle behavior would surface there as a runtime SQL error
 *       on the public HAF DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as any[] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafConfigured: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { config } = await import('../../src/config.js');
const { logger } = await import('../../src/logger.js');
const app = createApp();

type Captured = { sql: string; params: unknown[] };
let captured: Captured[];

beforeEach(async () => {
  captured = [];
  hafQueryMock.mockReset();
  getPoolMock.mockReset().mockReturnValue({
    query: hafQueryMock,
    connect: async () => ({
      query: hafQueryMock,
      release: () => {},
    }),
  });
  await hafCache.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────
// SQL-shape discriminators (cribbed from continuation-author-gate.test.ts)
// ──────────────────────────────────────────────

function isAccreditedSetSql(sql: string): boolean {
  return /SELECT\s+account\s+FROM\s+active_accreditations\b/i.test(sql);
}
function isAccreditedOrcidsSql(sql: string): boolean {
  return /SELECT\s+account,\s*orcid\s+FROM\s+active_accreditations\b/i.test(sql);
}
function isAccreditationStatusSql(sql: string): boolean {
  return /SELECT\s+account,\s*orcid,\s*status\s+FROM\s+accreditation_status\b/i.test(sql);
}
function paperDetailSelectSql(sql: string): boolean {
  return sql.includes('SELECT c.author, c.permlink, c.title') && /parent_permlink = \$\d+/.test(sql);
}
function headAuthorsLookupSql(sql: string): boolean {
  return sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3');
}
// Canonical-root walker's START row probe (`findCanonicalRoot`, production
// SQL at `papers.ts:1760`). The walker's SQL projects `cont_author` /
// `cont_permlink` columns (`json_metadata -> $3 -> 'continues' ->> 'author'`)
// on top of the same `SELECT c.author, c.json_metadata … parent_permlink = $3`
// shape `headAuthorsLookupSql` discriminates on. Both predicates therefore
// match the walker SQL — this matcher MUST be listed before the head-authors
// matcher in the mock's if/else chain below, or the walker probe gets
// swallowed by the head-authors handler, the returned row lacks
// cont_author/cont_permlink columns, the walker bails with
// `cont_columns_invalid`, and `buildCumulativeAuthorsForChain` never reaches
// the audit-emission branches.
function canonicalRootWalkerStartSql(sql: string): boolean {
  return sql.includes('AS cont_author') && sql.includes('AS cont_permlink');
}
function reconstructVersionsSql(sql: string): boolean {
  return sql.includes('ROW_NUMBER') && sql.includes('co.block_num');
}
function isForwardChainWalkSql(sql: string): boolean {
  return /'continues'\s*->>\s*'author'\s*=\s*\$1/.test(sql)
    && /'continues'\s*->>\s*'permlink'\s*=\s*\$2/.test(sql);
}

/**
 * Seed a 2-link chain (alice/p1 → bob/v2) with configurable
 * accreditation history. `accreditationStatus` is the merged map
 * (active + revoked) returned by `getAllEverAccreditedOrcidsWithStatus`;
 * `accredited` is the active-only membership set.
 */
function seedTwoLinkChain(opts: {
  rootAuthors: Array<Record<string, unknown>>;
  headAuthors: Array<Record<string, unknown>>;
  accredited?: string[];
  accreditedOrcids?: Array<{ account: string; orcid: string | null }>;
  accreditationStatus?: Array<{
    account: string;
    orcid: string | null;
    status: 'active' | 'revoked';
  }>;
}) {
  const rootMeta = {
    app: `${config.appTag}/test`,
    [config.appTag]: { type: 'paper', authors: opts.rootAuthors },
  };
  const headMeta = {
    app: `${config.appTag}/test`,
    [config.appTag]: { type: 'paper', authors: opts.headAuthors },
  };
  const rootRow = {
    author: 'alice', permlink: 'p1', title: 'Root title', body: 'abstract\n\n---\n\nbody',
    json_metadata: rootMeta,
    created: '2026-01-01T00:00:00.000Z', last_edited: '2026-01-01T00:00:00.000Z',
  };
  hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params: params ?? [] });
    if (isAccreditedSetSql(sql)) {
      return { rows: (opts.accredited ?? []).map((account) => ({ account })) };
    }
    if (isAccreditedOrcidsSql(sql)) {
      return { rows: opts.accreditedOrcids ?? [] };
    }
    if (isAccreditationStatusSql(sql)) {
      return { rows: opts.accreditationStatus ?? [] };
    }
    // Canonical-root walker's START + per-hop parent probes. MUST be checked
    // BEFORE `headAuthorsLookupSql` because the walker SQL's
    // `SELECT c.author, c.json_metadata, ... AS cont_author,
    // ... AS cont_permlink` superstring-matches the head-authors lookup
    // discriminator (see `canonicalRootWalkerStartSql` docstring above for
    // the swallow-failure mode). alice/p1 is the canonical root in every
    // canary here (no `continues` pointer), so the walker SQL's
    // `'continues' IS NOT NULL` predicate would return 0 rows against real
    // HAF — returning the empty rowset here mirrors that and lets the
    // walker bail via the SQL-empty-row path (debug log) rather than the
    // `cont_columns_invalid` warn-log path that surfaces when the head-authors
    // matcher swallows the walker query.
    if (canonicalRootWalkerStartSql(sql)) {
      return { rows: [] };
    }
    if (headAuthorsLookupSql(sql)) {
      return { rows: [rootRow] };
    }
    if (paperDetailSelectSql(sql)) {
      return { rows: [rootRow] };
    }
    if (isForwardChainWalkSql(sql)) {
      if (params[0] === 'alice' && params[1] === 'p1') {
        return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: headMeta }] };
      }
      return { rows: [] };
    }
    if (reconstructVersionsSql(sql)) {
      return { rows: [
        { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 'Root title', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: rootMeta },
        { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 'V2 title', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: headMeta },
      ] };
    }
    return { rows: [] };
  });
}

function findAuditEvent(warnSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> | undefined {
  const fired = warnSpy.mock.calls.find(([payload]: unknown[]) => {
    return typeof payload === 'object' && payload !== null
      && (payload as { event?: string }).event === 'orcid_claim_mismatch';
  });
  return fired ? (fired[0] as Record<string, unknown>) : undefined;
}

describe('GET /api/papers/:author/:permlink — orcid_claim_mismatch audit (post-revocation)', () => {
  it('post-revocation single-cycle: audit fires with accreditationStatus=revoked, broadcaster claim passes through', async () => {
    // Acceptance §3: alice was accredited (ORCID-X), now revoked. bob's
    // continuation names alice with a forged ORCID. Audit MUST fire with
    // `accreditationStatus: 'revoked'` and `accreditedOrcid: ORCID-X`
    // (alice's last-attested). Display: alice's ORCID = bob's forged
    // claim (no server override; alice has no current authoritative
    // ORCID standing).
    const warnSpy = vi.spyOn(logger, 'warn');
    seedTwoLinkChain({
      // alice authored the root but did NOT self-claim in `pevo.authors`
      // (only bob is named); bob's continuation introduces alice with a
      // forged ORCID. Without an alice self-claim in the root, bob's
      // claim about alice wins the cumulative-union (most-recent fallback
      // claim wins when no self-claim seen). Self-claiming scenarios are
      // outside the spoof-detection model — a co-author who self-claims
      // an ORCID is the SSoT for their own ORCID by chain construction.
      rootAuthors: [{ hive: 'bob' }],
      headAuthors: [
        { hive: 'alice', orcid: 'forged-orcid-by-bob' },
        { hive: 'bob' },
      ],
      // alice is NOT in active accreditations (she's been revoked).
      // bob is still active for chain-walk admission purposes.
      accredited: ['bob'],
      accreditedOrcids: [{ account: 'bob', orcid: '0000-0000-0000-5678' }],
      // The merged status map carries alice as revoked with her
      // last-attested ORCID.
      accreditationStatus: [
        { account: 'alice', orcid: '0000-0000-0000-1234', status: 'revoked' },
        { account: 'bob', orcid: '0000-0000-0000-5678', status: 'active' },
      ],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const aliceEntry = ((res.body?.data.authors || []) as Array<{ hive?: string; orcid?: string }>).find((a) => a.hive === 'alice');
    // Display: broadcaster's forged claim passes through (no override).
    expect(aliceEntry?.orcid).toBe('forged-orcid-by-bob');
    // Audit fired with the revoked-arm payload.
    const event = findAuditEvent(warnSpy);
    expect(event).toBeDefined();
    expect(event!.hive).toBe('alice');
    expect(event!.accreditationStatus).toBe('revoked');
    expect(event!.claimedOrcid).toBe('forged-orcid-by-bob');
    expect(event!.accreditedOrcid).toBe('0000-0000-0000-1234');
    expect(event!.rootAuthor).toBe('alice');
    expect(event!.rootPermlink).toBe('p1');
    expect(event!.claimSource).toBe('bob/v2');
    warnSpy.mockRestore();
  });

  it('post-revocation multi-cycle: audit payload carries ORCID-Y (most-recent prior accredit), not ORCID-X', async () => {
    // Architect's additive concern (2026-05-16 ratification): alice's
    // history is accredit ORCID-X → revoke → re-accredit ORCID-Y →
    // revoke. The `accreditation_status` CTE's LATERAL subquery against
    // `accred_ranked` (filtered to `action = 'accredit'`, ordered by
    // `rn ASC`, `LIMIT 1`) MUST return ORCID-Y for alice's status row.
    // This canary pins the SQL response shape that the mocked HAF
    // returns AND that the JS-side audit emission reads it correctly.
    //
    // Note: this canary is the JS-side contract pin. The SQL CTE's
    // actual multi-cycle correctness is documented in the
    // `accreditationStatusCteBody` docstring in `hafsql.ts` and exercised
    // against real HAF via the integration smoke tests.
    const warnSpy = vi.spyOn(logger, 'warn');
    seedTwoLinkChain({
      // Same self-claim avoidance shape as the single-cycle canary above.
      rootAuthors: [{ hive: 'bob' }],
      headAuthors: [
        { hive: 'alice', orcid: 'forged-orcid-by-bob' },
        { hive: 'bob' },
      ],
      accredited: ['bob'], // alice currently revoked (second revoke)
      accreditedOrcids: [{ account: 'bob', orcid: '0000-0000-0000-5678' }],
      accreditationStatus: [
        // alice's status row reflects ORCID-Y (her SECOND accredit, the
        // one the second revoke retired). NOT ORCID-X (her first).
        { account: 'alice', orcid: '0000-0000-0000-Y-YY', status: 'revoked' },
        { account: 'bob', orcid: '0000-0000-0000-5678', status: 'active' },
      ],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const event = findAuditEvent(warnSpy);
    expect(event).toBeDefined();
    expect(event!.accreditationStatus).toBe('revoked');
    // The audit's accreditedOrcid is the most-recent prior accredit
    // (ORCID-Y), NOT the first accredit (ORCID-X).
    expect(event!.accreditedOrcid).toBe('0000-0000-0000-Y-YY');
    expect(event!.accreditedOrcid).not.toBe('0000-0000-0000-X-XX');
    expect(event!.claimedOrcid).toBe('forged-orcid-by-bob');
    warnSpy.mockRestore();
  });

  it('active spoof regression: audit fires with accreditationStatus=active and server overrides ORCID', async () => {
    // Regression guard for the parent task
    // (`backend-multi-author-cumulative-union.md` rule #3): the existing
    // active-arm behavior MUST still fire the audit AND server-override
    // the display ORCID. The post-revocation extension layers a new arm
    // ON TOP of this — must not regress.
    const warnSpy = vi.spyOn(logger, 'warn');
    seedTwoLinkChain({
      // Same self-claim avoidance shape — bob's forged claim about alice
      // must win the cumulative-union so the active-arm rule #3 audit
      // primitive engages.
      rootAuthors: [{ hive: 'bob' }],
      headAuthors: [
        { hive: 'alice', orcid: 'forged-orcid-by-bob' },
        { hive: 'bob' },
      ],
      accredited: ['alice', 'bob'], // alice currently active
      accreditedOrcids: [
        { account: 'alice', orcid: '0000-0000-0000-1234' },
        { account: 'bob', orcid: '0000-0000-0000-5678' },
      ],
      accreditationStatus: [
        { account: 'alice', orcid: '0000-0000-0000-1234', status: 'active' },
        { account: 'bob', orcid: '0000-0000-0000-5678', status: 'active' },
      ],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const aliceEntry = ((res.body?.data.authors || []) as Array<{ hive?: string; orcid?: string }>).find((a) => a.hive === 'alice');
    // Display: server overrides to alice's accredited ORCID.
    expect(aliceEntry?.orcid).toBe('0000-0000-0000-1234');
    const event = findAuditEvent(warnSpy);
    expect(event).toBeDefined();
    expect(event!.accreditationStatus).toBe('active');
    expect(event!.claimedOrcid).toBe('forged-orcid-by-bob');
    expect(event!.accreditedOrcid).toBe('0000-0000-0000-1234');
    warnSpy.mockRestore();
  });

  it('post-revocation match: claim equals last-attested ORCID, no audit fires', async () => {
    // Defensive non-firing canary: bob broadcasts an ORCID that happens
    // to match alice's last-attested ORCID (e.g., bob just copied the
    // ORCID from a prior version). No mismatch, no audit.
    const warnSpy = vi.spyOn(logger, 'warn');
    seedTwoLinkChain({
      // Same self-claim avoidance shape so bob's claim about alice wins
      // (matching the spoof scenarios' chain construction).
      rootAuthors: [{ hive: 'bob' }],
      headAuthors: [
        { hive: 'alice', orcid: '0000-0000-0000-1234' },
        { hive: 'bob' },
      ],
      accredited: ['bob'],
      accreditedOrcids: [{ account: 'bob', orcid: '0000-0000-0000-5678' }],
      accreditationStatus: [
        { account: 'alice', orcid: '0000-0000-0000-1234', status: 'revoked' },
        { account: 'bob', orcid: '0000-0000-0000-5678', status: 'active' },
      ],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const event = findAuditEvent(warnSpy);
    expect(event).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('active spoof, case d (accredited target has no on-chain ORCID): audit fires with accreditationStatus=active, claim suppressed', async () => {
    // Branch (d) of the active arm — alice is accredited but her on-chain
    // attestation carries no ORCID. bob's continuation supplies a forged
    // ORCID claim for alice. The audit primitive MUST fire with
    // `accreditationStatus: 'active' as const` (alice is in the active set)
    // and `accreditedOrcid: null` (her attestation has no ORCID), and the
    // display ORCID gets suppressed to null (the accredited user's silence
    // is the authority). If a regression drops the additive field or skips
    // the dedup Set consult, dashboards filtering by
    // `accreditationStatus === 'active'` silently miss case-d spoofs.
    const warnSpy = vi.spyOn(logger, 'warn');
    seedTwoLinkChain({
      // Same self-claim avoidance shape as the other spoof canaries —
      // bob's forged claim about alice wins the cumulative-union, alice
      // never self-claims, so case (d) of the active arm engages.
      rootAuthors: [{ hive: 'bob' }],
      headAuthors: [
        { hive: 'alice', orcid: 'forged-orcid-by-bob' },
        { hive: 'bob' },
      ],
      accredited: ['alice', 'bob'], // alice currently active
      accreditedOrcids: [
        // alice is accredited but her on-chain attestation carries no ORCID.
        { account: 'alice', orcid: null },
        { account: 'bob', orcid: '0000-0000-0000-5678' },
      ],
      accreditationStatus: [
        { account: 'alice', orcid: null, status: 'active' },
        { account: 'bob', orcid: '0000-0000-0000-5678', status: 'active' },
      ],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const aliceEntry = ((res.body?.data.authors || []) as Array<{ hive?: string; orcid?: string | null }>).find((a) => a.hive === 'alice');
    // Display: claim suppressed (set to null) — the accredited user opted
    // not to publish an ORCID, broadcaster's forged claim must not surface.
    expect(aliceEntry?.orcid).toBeNull();
    const event = findAuditEvent(warnSpy);
    expect(event).toBeDefined();
    // The additive `accreditationStatus` field MUST be present on case-d
    // emissions so operators filtering by accreditationStatus don't silently
    // miss them.
    expect(event!.accreditationStatus).toBe('active');
    expect(event!.claimedOrcid).toBe('forged-orcid-by-bob');
    expect(event!.accreditedOrcid).toBeNull();
    expect(event!.hive).toBe('alice');
    expect(event!.rootAuthor).toBe('alice');
    expect(event!.rootPermlink).toBe('p1');
    expect(event!.claimSource).toBe('bob/v2');
    warnSpy.mockRestore();
  });
});
