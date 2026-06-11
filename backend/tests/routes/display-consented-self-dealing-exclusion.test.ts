/**
 * Display-side CONSENTED self-dealing exclusion canary — the Route-1/2
 * inverted sibling of the claimer canaries
 * (display-claimer-self-review-exclusion / display-claimer-self-vote-revote-
 * exclusion).
 *
 * Background. Since the metadata auto-accept arms were removed, a Route-2
 * consented co-author (ORCID- or hive-anchored `author_accept`) has NO
 * accepted-claims row: the reputation cycle excludes their self-votes and
 * self-reviews via its `NOT EXISTS consented_authors` gates, but the display
 * surfaces excluded only accepted-claims self-dealing. The display surfaces
 * now compose {@link excludeConsentedSelfWhere} (and the JS vote paths skip
 * the resolved consented set) so displayed aggregates exclude self-dealing by
 * the SAME credited set the cycle uses.
 *
 * Layers (mirroring the claimer siblings):
 *
 *   1. A source-level shape pin (always runs, no infra): every display review
 *      surface composes excludeConsentedSelfWhere, and the net_votes paths
 *      carry the consented skip, so a future surface that drops the gate
 *      fails red.
 *
 *   2. A synthetic-VALUES behavioral canary (real Postgres, skips when HAF is
 *      not configured): runs the production excludeConsentedSelfWhere
 *      predicate over a synthetic consented_authors + reviews corpus — the
 *      consented co-author's self-review is excluded, a third party and a
 *      resigned (no longer consented) author are kept.
 *
 *   3. Cross-channel vote behavior: batchResolveVotes drops a consented
 *      co-author who self-votes via BOTH the native and revote channels, and
 *      the paper-detail enrichment drops a consented self-revote in the
 *      JS-only revote channel.
 *
 * **Carve-out (root CLAUDE.md "Running Tests"):**
 *   (a) Real-corpus seeding is impractical: each case needs an on-chain
 *       multi-author paper plus a valid `author_accept` plus a self-vote /
 *       self-review by the consented account, indexed on HAF with a
 *       controlled accredited set. Layer 2 runs the real predicate over
 *       synthetic VALUES on a real planner; layer 3 calls the real exported
 *       `batchResolveVotes` against a controlled rowset and drives the real
 *       `/enrichment` route with the shared pool helper mocked to dispatch
 *       synthetic rows by SQL shape.
 *   (b) `verifyHiveSignature` is NOT mocked — `/enrichment` is a public GET
 *       and the other layers are pure SQL / function calls; none is
 *       auth-focused.
 *   (c) Real-path companions: the consented-set resolution itself
 *       (consentChainCteBody + consentedAuthorsCteBody) is pinned against a
 *       real planner by `consented-authors-cte-real-postgres.test.ts`, and
 *       the composed display statements execute on live HAF in the papers /
 *       profile / search / stats route suites.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { excludeConsentedSelfWhere } from '../../src/hafsql.js';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as any[] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
  return {
    ...actual,
    getPool: getPoolMock,
    isHafConfigured: () => getPoolMock() !== null,
    closeHafPool: async () => { /* no-op */ },
  };
});

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { batchResolveVotes } = await import('../../src/routes/papers.js');
// The behavioral-parity layer runs against REAL Postgres; reach past the
// module mock (which backs the route/function layers) for the real pool.
const actualDb = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
const app = createApp();

const surfaceFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

const PAPER_AUTHOR = 'alice';
const PAPER_PERMLINK = 'paper-A';
const CONSENTED = 'consented-eve';
const THIRDPARTY = 'thirdparty';

beforeEach(async () => {
  await hafCache.clear();
  getPoolMock.mockReset().mockReturnValue({
    query: hafQueryMock,
    connect: async () => ({ query: hafQueryMock, release: () => {} }),
  });
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
});

describe('display consented self-dealing exclusion — source-level shape pin', () => {
  it('every display review surface composes excludeConsentedSelfWhere', () => {
    // papers.ts carries THREE gate sites: the listing review-agg LATERAL, the
    // paper-detail enrichment review list, and the paper-detail vote query —
    // the same three sites as excludeClaimedSelfWhere; pin the exact count.
    const papers = surfaceFile('routes/papers.ts');
    expect(
      (papers.match(/excludeConsentedSelfWhere\(/g) ?? []).length,
      'papers.ts must gate the listing review-agg, the paper-detail review list, and the paper-detail vote query',
    ).toBe(3);
    // profile.ts: two helper CALLS (getProfileStats + fetchUserReviewsFromHaf,
    // whose const is interpolated into both the count and data queries) —
    // mirrors the claimer pin's call-count shape.
    expect(
      (surfaceFile('routes/profile.ts').match(/excludeConsentedSelfWhere\(/g) ?? []).length,
      'profile.ts must gate both getProfileStats and fetchUserReviewsFromHaf',
    ).toBeGreaterThanOrEqual(2);
    for (const rel of ['routes/search.ts', 'routes/stats.ts', 'routes/reviews.ts']) {
      expect(surfaceFile(rel), `${rel} must compose excludeConsentedSelfWhere`).toContain('excludeConsentedSelfWhere(');
    }
  });

  it('the displayed net_votes paths exclude consented self-votes', () => {
    const papers = surfaceFile('routes/papers.ts');
    // batchResolveVotes builds its skip set from the credited-set UNION
    // (accepted claims + consented authors) in one leg.
    expect(papers, 'batchResolveVotes must union consented_authors into the credited skip set').toContain(
      'FROM consented_authors',
    );
    expect(papers, 'batchResolveVotes must skip credited self-votes').toContain('creditedSet.has(');
    // The paper-detail voter query gates on v.voter via excludeConsentedSelfWhere.
    expect(papers, 'paper-detail voteResult must gate v.voter via excludeConsentedSelfWhere').toContain(
      "excludeConsentedSelfWhere({ authorExpr: 'v.voter'",
    );
    // The paper-detail revote channel is JS-resolved (no SQL gate) and must
    // skip consented accounts explicitly.
    expect(papers, 'paper-detail revote merge must skip consented self-revotes').toContain('consentedAccounts.has(');
  });
});

describe('display consented self-dealing exclusion — synthetic-VALUES behavioral parity', () => {
  it.skipIf(!actualDb.isHafConfigured())(
    'a consented co-author self-review is excluded; third-party and resigned-author reviews are kept',
    { timeout: 30_000 },
    async (ctx) => {
      const pool = actualDb.getPool();
      if (!pool) return ctx.skip(true, 'no pool available');

      // Synthetic consented_authors (the resolved set consentedAuthorsCteBody
      // produces: Route-1 root + Route-2 accepts minus demotions) + the paper
      // and its reviews. `consented-eve` is a Route-2 consented co-author
      // absent from authors[].hive resolution, so only the consented gate —
      // not excludeSelfReviewWhere or the claims gate — can drop her.
      // `resigned-rita` once accepted but resigned: she has NO
      // consented_authors row (demotions resolve inside the CTE), so her
      // review is KEPT — matching the cycle, which no longer credits or
      // excludes her.
      const sql = `
        WITH
          consented_authors(root_author, root_permlink, account) AS (VALUES
            ('alice'::text, 'paper-A'::text, 'alice'::text),
            ('alice'::text, 'paper-A'::text, 'consented-eve'::text)
          ),
          page(author, permlink) AS (VALUES ('alice'::text, 'paper-A'::text)),
          reviews(author, parent_author, parent_permlink) AS (VALUES
            ('thirdparty'::text,    'alice'::text, 'paper-A'::text),
            ('consented-eve'::text, 'alice'::text, 'paper-A'::text),
            ('resigned-rita'::text, 'alice'::text, 'paper-A'::text)
          )
        SELECT r.author
        FROM reviews r
        JOIN page p ON p.author = r.parent_author AND p.permlink = r.parent_permlink
        WHERE ${excludeConsentedSelfWhere({ authorExpr: 'r.author', paperAuthorExpr: 'p.author', paperPermlinkExpr: 'p.permlink' })}
        ORDER BY r.author
      `;
      const res = await pool.query<{ author: string }>(sql);
      const kept = res.rows.map((r) => r.author);
      expect(kept).toEqual(['resigned-rita', 'thirdparty']);
    },
  );
});

describe('listing net_votes (batchResolveVotes) — consented self-vote excluded across both channels', () => {
  it('drops a consented co-author who self-votes via BOTH a native vote and a revote', async () => {
    // consented-eve is a Route-2 consented co-author of alice/paper-A (NO
    // accepted-claims row — the arms are deleted) and self-votes via a native
    // vote (block 100) AND a later revote (block 200). The creditedSet skip
    // must drop her regardless of channel, so net_votes counts only the
    // third party.
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('FROM consented_authors')) {
          // The credited-set union leg: claims contribute nothing, the
          // consented arm yields eve.
          return { rows: [{ claimer: CONSENTED, paper_author: PAPER_AUTHOR, paper_permlink: PAPER_PERMLINK }] };
        }
        if (sql.includes("'revote'")) {
          return { rows: [
            { author: PAPER_AUTHOR, permlink: PAPER_PERMLINK, voter: CONSENTED, weight: 10000, block_num: 200 },
          ] };
        }
        return { rows: [
          { author: PAPER_AUTHOR, permlink: PAPER_PERMLINK, voter: CONSENTED, weight: 10000, block_num: 100 },
          { author: PAPER_AUTHOR, permlink: PAPER_PERMLINK, voter: THIRDPARTY, weight: 10000, block_num: 100 },
        ] };
      },
    };

    const resolved = await batchResolveVotes(
      pool,
      [{ author: PAPER_AUTHOR, permlink: PAPER_PERMLINK }],
      [CONSENTED, THIRDPARTY],
    );

    expect(resolved.get(`${PAPER_AUTHOR}/${PAPER_PERMLINK}`)?.net_votes).toBe(1);
  });
});

describe('GET /api/papers/:author/:permlink/enrichment — consented self-revote excluded from net_votes', () => {
  it('a consented co-author self-voting via a revote does not inflate paper-detail net_votes', async () => {
    hafQueryMock.mockImplementation(async (sql: string) => {
      // getAllAccreditedAccounts: consented-eve + thirdparty are accredited.
      if (sql.includes('SELECT account FROM active_accreditations')) {
        return { rows: [{ account: CONSENTED }, { account: THIRDPARTY }] };
      }
      // The per-paper consented resolution (fetchConsentedAccountsForPaper):
      // eve is consented. Keyed on the projection, not the CTE name — the
      // vote/review queries also reference consented_authors inside their
      // NOT EXISTS gates.
      if (sql.includes('SELECT account FROM consented_authors')) {
        return { rows: [{ account: CONSENTED }] };
      }
      // No authorship claims (Route-2 consent has no claims row).
      if (sql.includes('FROM authorship_claims') && sql.includes("status != 'revoked'")) {
        return { rows: [] };
      }
      // Native votes: eve's native vote is SQL-excluded by the consented
      // gate, so only the honest third party surfaces here.
      if (sql.includes('SELECT DISTINCT ON (v.voter) v.voter, v.weight, v.timestamp')) {
        return { rows: [{ voter: THIRDPARTY, weight: 10000, timestamp: '2026-01-01T00:00:00Z', block_num: 100 }] };
      }
      // Revote custom_json: eve self-revotes (no SQL gate on this channel).
      if (sql.includes('revote_ts')) {
        return { rows: [{ voter: CONSENTED, weight: 10000, version: '1', revote_ts: '2026-01-02T00:00:00Z', block_num: 200 }] };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/papers/${PAPER_AUTHOR}/${PAPER_PERMLINK}/enrichment`);
    expect(res.status).toBe(200);
    // Only the third-party native vote counts; the consented co-author's
    // revote is dropped by the consentedAccounts skip in the revote-only
    // merge loop. Without the skip the revote-only loop would add eve →
    // net_votes === 2.
    expect(res.body.data.net_votes).toBe(1);
    const voters = (res.body.data.voters as Array<{ voter: string }>).map((v) => v.voter);
    expect(voters).toContain(THIRDPARTY);
    expect(voters).not.toContain(CONSENTED);
  });
});
