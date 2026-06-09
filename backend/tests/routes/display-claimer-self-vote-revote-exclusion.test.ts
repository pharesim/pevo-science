/**
 * Behavioral net_votes canary: a credited claimer's self-vote is excluded from
 * the displayed net_votes across BOTH vote-resolution surfaces (the listing
 * `batchResolveVotes` and the paper-detail `fetchEnrichmentFromHaf`) and across
 * BOTH vote channels (a native Hive vote AND a revote custom_json).
 *
 * Why this exists. PEvO resolves votes through two paths and each merges two
 * channels: native vote ops (gated in SQL by `excludeClaimedSelfWhere`) and
 * revote custom_json ops (resolved in JS, with NO SQL gate). A credited claimer
 * (ORCID / name-only slot, absent from `authors[].hive`) who self-votes via a
 * revote would slip past the SQL gate and inflate net_votes unless the JS merge
 * loops also skip accepted claimers. This canary drives a claimer who votes via
 * BOTH channels and asserts the resolved net_votes counts only the third party.
 *
 * **Carve-out (CLAUDE.md "Running Tests"):**
 *   (a) Real-corpus seeding is impractical: it requires an accepted ORCID/name-only
 *       authorship claim plus a self native-vote AND a self revote on one paper,
 *       indexed on HAF, with a controlled accredited set — not reproducible on
 *       demand against the public corpus. The listing arm calls the real exported
 *       `batchResolveVotes` against a controlled (native + revote + claims) rowset;
 *       the detail arm drives the real `/enrichment` route with the shared pool
 *       helper mocked to dispatch synthetic rows by SQL shape.
 *   (b) `verifyHiveSignature` is NOT mocked — `/enrichment` is a public GET and the
 *       listing arm is a pure function call; neither is auth-focused.
 *   (c) Real-path companion: the SQL `excludeClaimedSelfWhere` gate and the
 *       `batchResolveVotes` claimedSet skip run against real HAF in the papers /
 *       reviews / reputation-lifecycle suites; the cross-channel revote skip the
 *       public corpus cannot deterministically provide is what this pins.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
const { batchResolveVotes } = await import('../../src/routes/papers.js');
const app = createApp();

const PAPER_AUTHOR = 'alice';
const PAPER_PERMLINK = 'paper-A';
const CLAIMER = 'claimer-orcid';
const THIRDPARTY = 'thirdparty';

beforeEach(async () => {
  await hafCache.clear();
  getPoolMock.mockReset().mockReturnValue({
    query: hafQueryMock,
    connect: async () => ({ query: hafQueryMock, release: () => {} }),
  });
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
});

describe('listing net_votes (batchResolveVotes) — credited-claimer self-vote excluded across both channels', () => {
  it('drops a credited claimer who self-votes via BOTH a native vote and a revote', async () => {
    // claimer-orcid is an ACCEPTED claimer of alice/paper-A and self-votes on it
    // via a native vote (block 100) AND a later revote (block 200). thirdparty is
    // an honest upvoter. The claimedSet skip must drop claimer-orcid regardless of
    // which channel its signal comes from, so net_votes counts only thirdparty.
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('FROM authorship_claims') && sql.includes("status = 'accepted'")) {
          return { rows: [{ claimer: CLAIMER, paper_author: PAPER_AUTHOR, paper_permlink: PAPER_PERMLINK }] };
        }
        if (sql.includes("'revote'")) {
          return { rows: [
            { author: PAPER_AUTHOR, permlink: PAPER_PERMLINK, voter: CLAIMER, weight: 10000, block_num: 200 },
          ] };
        }
        // native votes (the SQL gate is not actually run under the mock, so we
        // include the claimer here too — the JS claimedSet skip must still drop it)
        return { rows: [
          { author: PAPER_AUTHOR, permlink: PAPER_PERMLINK, voter: CLAIMER, weight: 10000, block_num: 100 },
          { author: PAPER_AUTHOR, permlink: PAPER_PERMLINK, voter: THIRDPARTY, weight: 10000, block_num: 100 },
        ] };
      },
    };

    const resolved = await batchResolveVotes(
      pool,
      [{ author: PAPER_AUTHOR, permlink: PAPER_PERMLINK }],
      [CLAIMER, THIRDPARTY],
    );

    // Only the third party counts; without the claimedSet skip the claimer's
    // native+revote signals would push net_votes to 2.
    expect(resolved.get(`${PAPER_AUTHOR}/${PAPER_PERMLINK}`)?.net_votes).toBe(1);
  });
});

describe('GET /api/papers/:author/:permlink/enrichment — credited-claimer self-revote excluded from net_votes', () => {
  it('a credited claimer self-voting via a revote does not inflate paper-detail net_votes', async () => {
    hafQueryMock.mockImplementation(async (sql: string) => {
      // getAllAccreditedAccounts: claimer + thirdparty are accredited.
      if (sql.includes('SELECT account FROM active_accreditations')) {
        return { rows: [{ account: CLAIMER }, { account: THIRDPARTY }] };
      }
      // authorship_claims for this paper: claimer is accepted.
      if (sql.includes('FROM authorship_claims') && sql.includes("status != 'revoked'")) {
        return { rows: [{
          claimer: CLAIMER, paper_author: PAPER_AUTHOR, paper_permlink: PAPER_PERMLINK,
          author_index: 0, status: 'accepted', claimed_at: '2026-01-01T00:00:00Z',
        }] };
      }
      // Native votes: the claimer's native vote is SQL-excluded, so only the
      // honest third party surfaces here.
      if (sql.includes('SELECT DISTINCT ON (v.voter) v.voter, v.weight, v.timestamp')) {
        return { rows: [{ voter: THIRDPARTY, weight: 10000, timestamp: '2026-01-01T00:00:00Z', block_num: 100 }] };
      }
      // Revote custom_json for this paper: the claimer self-revotes (no SQL gate).
      if (sql.includes('revote_ts')) {
        return { rows: [{ voter: CLAIMER, weight: 10000, version: '1', revote_ts: '2026-01-02T00:00:00Z', block_num: 200 }] };
      }
      // reviews list, version walker, everything else → empty.
      return { rows: [] };
    });

    const res = await request(app).get(`/api/papers/${PAPER_AUTHOR}/${PAPER_PERMLINK}/enrichment`);
    expect(res.status).toBe(200);
    // Only the third-party native vote counts; the credited claimer's revote is
    // dropped by the acceptedClaimers skip in the revote-only merge loop. Without
    // the fix the revote-only loop would add the claimer → net_votes === 2.
    expect(res.body.data.net_votes).toBe(1);
    const voters = (res.body.data.voters as Array<{ voter: string }>).map((v) => v.voter);
    expect(voters).toContain(THIRDPARTY);
    expect(voters).not.toContain(CLAIMER);
  });
});
