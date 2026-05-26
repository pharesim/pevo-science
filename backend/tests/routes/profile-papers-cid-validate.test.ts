/**
 * Output-side ipfs_cid validation canary for /api/profile/:username/papers.
 *
 * Pins the round-2 hold item 1 fix for BACKEND-PAPER-DETAIL-CID-VALIDATE-ON-EMIT:
 * `toPaperSummary()` in `backend/src/helpers.ts` now wraps the
 * `pevoString(pevo, 'ipfs_cid')` read in `validatedCid(...)` so the
 * profile-papers endpoint enforces the same emit-time CID-shape gate the
 * three `routes/papers.ts` sites already enforced. Mutation kill: reverting
 * the `validatedCid()` wrap at `helpers.ts:toPaperSummary` lets a
 * whitespace-padded / control-char / non-string CID surface unchanged in
 * the profile-papers JSON response, failing this assertion red.
 *
 * **Carve-out (per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c)):**
 *   (a) Real-corpus seeding is impractical: the defended failure mode is a
 *       paper with a malformed-shape `pevo.ipfs_cid` on chain (whitespace,
 *       control chars, zero-width chars, non-string). The public HAF
 *       database cannot be deterministically seeded with such a paper
 *       authored by an arbitrary username at test time. The mocked-pool
 *       responder lets us seed the pathological CID shape per-test.
 *       This file also spies on `logger.warn` to assert the structured
 *       `paper_detail_ipfs_cid_rejected` event fires (the operator-detection
 *       leg of the two-phase shape: clear-to-null + emit-warn). Spy on
 *       `logger` is the canonical mock-target under the carve-out.
 *   (b) `verifyHiveSignature` is NOT mocked — the route is a public GET
 *       (no auth middleware to short-circuit). The MOCK_VERIFY_SIGNATURE
 *       fixture is not loaded.
 *   (c) Real-path companion: the round-1 implementation's three
 *       `routes/papers.ts` emit sites (papers-list, head/root atomic-triple,
 *       single-paper buildPaperDetail) carry parallel canaries in
 *       `tests/routes/continuation-author-gate.test.ts` under the
 *       `GET /api/papers/:author/:permlink — output-side ipfs_cid validation`
 *       describe block. That file exercises the same risk class
 *       (clear-to-null + structured-warn integrity) at a sibling route. The
 *       same pure-predicate (isValidIpfsCid + validatedCid) is exercised
 *       against real string inputs in `tests/lib/ipfs-validation.test.ts`,
 *       and integrated downstream consumers (`paper-card.js`, paper-detail
 *       gateway URLs) defend on the null-truthy boundary. A real-HAF
 *       integration variant for profile-papers specifically remains a
 *       follow-up — same status as the round-1 papers.ts emit-site
 *       canaries which also live in mocked-pool form only.
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

beforeEach(async () => {
  hafQueryMock.mockReset();
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

// File-level spy cleanup. `vi.spyOn` on an already-spied method returns the
// EXISTING spy and the second test sees the first test's mock.calls history;
// `restoreAllMocks` prevents that cross-test contamination. Mirrors the
// equivalent guard in `continuation-author-gate.test.ts`.
afterEach(() => {
  vi.restoreAllMocks();
});

/** Builds a HAF user-papers row carrying an attacker-supplied
 *  `pevo.ipfs_cid` shape. The body / title / created shape mirrors
 *  what `fetchUserPapersFromHaf` selects (json_metadata, body, etc.). */
function userPapersRow(author: string, permlink: string, ipfsCid: unknown) {
  return {
    author,
    permlink,
    title: 't',
    body: 'abstract\n\n---\n\nbody',
    json_metadata: {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ name: 'Paper Author', hive: author }],
        ipfs_cid: ipfsCid,
      },
    },
    created: '2026-01-01T00:00:00.000Z',
    total_rshares: 0,
  };
}

/** Installs an SQL-pattern responder for the count + data queries the
 *  /:username/papers route emits. The shape mirrors
 *  `fetchUserPapersFromHaf`: a count query (returns `[{ total: N }]`) and
 *  a data query (returns the user_papers rows). All other queries (the
 *  CTE-driven accreditation / reputation enrichments) return empty rows;
 *  the enrichments fall through to default zeros which is fine for this
 *  test (we're only asserting on `ipfs_cid` shape). */
function installResponderForRow(row: ReturnType<typeof userPapersRow>) {
  hafQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('count(*)') && sql.includes('user_papers')) {
      return { rows: [{ total: 1 }] };
    }
    if (sql.includes('FROM user_papers')) {
      return { rows: [row] };
    }
    return { rows: [] };
  });
}

describe('GET /api/profile/:username/papers — output-side ipfs_cid validation (helpers.ts:toPaperSummary)', () => {
  it('clears whitespace-padded ipfs_cid to null in response AND emits paper_detail_ipfs_cid_rejected warn', async () => {
    // Primary motivating threat from the round-2 hold: a vouched co-author
    // (or any pre-hardening on-chain post) broadcasting a paper with
    // whitespace-padded `pevo.ipfs_cid`. Before round-2 hold item 1,
    // `toPaperSummary` returned the padded value untouched and the response
    // would faithfully echo it (frontend `paper-card.js:80` is a truthy
    // check so the value flows into any future URL-construction consumer).
    const paddedCid = '  QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG  ';
    installResponderForRow(userPapersRow('alice', 'p1', paddedCid));

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);

    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);

    // Integrity goal: response carries null, NOT the padded value.
    expect(res.body.data[0].ipfs_cid).toBe(null);

    // Operator-detection leg: structured warn anchor fired with the
    // dashboard-keyable event + correlation context.
    const rejectCalls = warnSpy.mock.calls.filter((c) => {
      const arg = c[0] as Record<string, unknown> | undefined;
      return arg?.event === 'paper_detail_ipfs_cid_rejected';
    });
    expect(rejectCalls.length).toBeGreaterThan(0);
    const arg = rejectCalls[0][0] as Record<string, unknown>;
    expect(arg.author).toBe('alice');
    expect(arg.permlink).toBe('p1');
    expect(typeof arg.raw_cid_prefix).toBe('string');
    // Truncation guard: 32-char ceiling prevents log injection from
    // attacker-controlled multi-line payloads.
    expect((arg.raw_cid_prefix as string).length).toBeLessThanOrEqual(32);

    warnSpy.mockRestore();
  });

  it('passes a valid CIDv0 through unchanged (no warn)', async () => {
    // Negative control: the validator is shape-conservative — well-formed
    // CIDs surface unchanged. Pins that the wrap is not over-broad.
    const validCid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    installResponderForRow(userPapersRow('alice', 'p1', validCid));

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);

    const res = await request(app).get('/api/profile/alice/papers');
    expect(res.status).toBe(200);
    expect(res.body.data[0].ipfs_cid).toBe(validCid);

    const rejectCalls = warnSpy.mock.calls.filter((c) => {
      const arg = c[0] as Record<string, unknown> | undefined;
      return arg?.event === 'paper_detail_ipfs_cid_rejected';
    });
    expect(rejectCalls.length).toBe(0);

    warnSpy.mockRestore();
  });
});
