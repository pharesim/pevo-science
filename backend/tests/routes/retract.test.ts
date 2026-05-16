/**
 * /api/papers/:author/:permlink/retract coverage.
 *
 * Round-3 addition (BE-ORCID-BROADCAST-ABORT-TIMEOUT): per-route timeout
 * specs. The helper's timeout mechanism is unit-tested in
 * hive-broadcast-timeout.test.ts; these specs cover the route-level
 * catch-and-discriminate pattern:
 *   (a) BroadcastTimeoutError → 504 BROADCAST_TIMEOUT with the
 *       common.md {retriable:false, outcome:'uncertain', verify_before_retry:true,
 *       timeout_ms:number} envelope. No post-broadcast state writes (no
 *       retracted-papers cache invalidation) on timeout.
 *   (b) Non-timeout broadcast error → 502 BROADCAST_FAILED with
 *       {retriable:false}.
 *
 * Mocking justification (per root CLAUDE.md carve-out): the /retract
 * handler requires the paper to exist in HAF and the caller to be
 * authorized. Seeding a real paper on the pevotest chain per-test is
 * impractical, so getPool() is mocked with SQL-shape-matched canned
 * responses. verifyHiveSignature is the fixture mock (MOCK_VERIFY_SIGNATURE)
 * which maps X-Hive-Username to req.hiveUsername; this matches the rest
 * of the retract test file's usage. broadcastJsonWithTimeout is mocked so
 * the broadcast failure modes can be staged deterministically.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const { hafQueryMock, broadcastJsonMock, MockBroadcastTimeoutError } = vi.hoisted(() => ({
  hafQueryMock: vi.fn().mockResolvedValue({ rows: [] }),
  broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'mock-retract-tx' }),
  MockBroadcastTimeoutError: class BroadcastTimeoutError extends Error {
    public readonly timeoutMs: number;
    constructor(timeoutMs: number) {
      super(`Hive broadcast timed out after ${timeoutMs}ms`);
      this.name = 'BroadcastTimeoutError';
      this.timeoutMs = timeoutMs;
    }
  },
}));

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock }),
  isHafConfigured: () => true,
  closeHafPool: async () => { /* no-op */ },
}));

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: { getAccounts: vi.fn().mockResolvedValue([]) },
    broadcast: { json: broadcastJsonMock },
  },
  broadcastJsonWithTimeout: (...args: unknown[]) =>
    (broadcastJsonMock as (...a: unknown[]) => unknown)(...args),
  BroadcastTimeoutError: MockBroadcastTimeoutError,
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
}));

import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { hafCache } from '../../src/cache.js';

// Deterministic WIF keeps PrivateKey.fromString happy on the broadcast path;
// broadcast.json is mocked, so no actual signing happens.
config.pevoAdminPostingKey = PrivateKey.fromSeed('pevo-retract-test-admin').toString();

const app = createApp();

describe('POST /api/papers/:author/:permlink/retract', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app)
      .post('/api/papers/nobody/no-paper/retract')
      .send({ reason: 'Data fabrication' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent paper', async () => {
    hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post('/api/papers/nobody/nonexistent/retract')
      .set('X-Hive-Username', 'nobody')
      .send({ reason: 'Error' });
    expect(res.status).toBe(404);
  });
});

// ──────────────────────────────────────────────
// BE-ORCID-BROADCAST-ABORT-TIMEOUT — route-level BroadcastTimeoutError discrimination.
//
// Envelope per agents/docs/api-contracts/common.md (no verify_location — that
// field is orcid-specific). The /retract handler's post-broadcast side-effect
// is `hafCache.invalidate('retracted-papers')`, which must NOT fire on timeout.
// ──────────────────────────────────────────────

const TIMEOUT_DETAILS = {
  retriable: false,
  outcome: 'uncertain',
  verify_before_retry: true,
  timeout_ms: 30_000,
};

const PAPER_AUTHOR = 'alice';
const PAPER_PERMLINK = 'my-paper';

// hafQueryMock dispatcher: matches each SQL shape used by /retract's pre-
// broadcast path so the handler reaches the broadcast call site.
//   1. `fetchPaperDetailFromHaf` → comments-table SELECT returns a minimal
//      PEvO paper row (isPevoAnyPaper passes via {app:"pevotest/0.1",
//      pevotest:{type:"paper"}}).
//   2. `reconstructVersionsFromHaf` → ROW_NUMBER()/block_num SELECT: empty.
//   3. `resolveContinuationChain` → 'continues' JSON path SELECT: empty
//      (breaks the loop at hop 0).
//   4. `isRetracted` → custom_id/action='retract_paper' SELECT: empty
//      (paper has not been retracted yet).
// Anything else falls through to the default {rows: []} response, which is
// safe for the /retract pre-broadcast path (author-side reputation queries
// etc.). The default return on match fallthrough tolerates future HAF query
// drift without silently routing the handler through a 404.
function installRetractHafMock(): void {
  hafQueryMock.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('parent_author') && sql.includes('parent_permlink') && sql.includes('json_metadata')) {
      // `fetchPaperDetailFromHaf` comments query OR resolveContinuationChain
      // query — distinguish by the `-> 'continues'` JSON path the chain
      // query uses but the content query does not.
      if (sql.includes("'continues'")) {
        return { rows: [] };
      }
      return {
        rows: [{
          author: PAPER_AUTHOR,
          permlink: PAPER_PERMLINK,
          title: 'Test Paper',
          body: 'Abstract body content',
          json_metadata: {
            app: `${config.appTag}/0.1`,
            [config.appTag]: { type: 'paper', authors: [] },
          },
          created: '2026-04-22T00:00:00Z',
          last_edited: null,
        }],
      };
    }
    if (sql.includes('retract_paper') || sql.includes("action' = 'retract_paper")) {
      return { rows: [] };
    }
    return { rows: [] };
  });
}

describe('POST /api/papers/:author/:permlink/retract — BE-ORCID-BROADCAST-ABORT-TIMEOUT', () => {
  beforeEach(() => {
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockResolvedValue({ id: 'mock-retract-tx' });
    installRetractHafMock();
  });

  it('BroadcastTimeoutError → 504 BROADCAST_TIMEOUT with uncertain-outcome envelope; no cache invalidation', async () => {
    // `void hafCache.invalidate('retracted-papers')` is the only post-broadcast
    // side-effect at /retract. The timeout catch returns BEFORE the sendOk
    // success path, so invalidate must not have been called.
    const invalidateSpy = vi.spyOn(hafCache, 'invalidate');
    broadcastJsonMock.mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000));

    const res = await request(app)
      .post(`/api/papers/${PAPER_AUTHOR}/${PAPER_PERMLINK}/retract`)
      .set('X-Hive-Username', PAPER_AUTHOR)
      .send({ reason: 'Data fabrication' });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('BROADCAST_TIMEOUT');
    expect(res.body.error.details).toEqual(TIMEOUT_DETAILS);
    expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
    // Stricter than `not.toHaveBeenCalledWith('retracted-papers')`: catches
    // any future regression that adds an unrelated `hafCache.invalidate(...)`
    // call inside the timeout catch path. Matches `claims.test.ts` rigor.
    expect(invalidateSpy).not.toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });

  it('non-timeout broadcast error → 502 BROADCAST_FAILED with retriable=false', async () => {
    broadcastJsonMock.mockRejectedValueOnce(new Error('RPC node rejected: insufficient RC'));

    const res = await request(app)
      .post(`/api/papers/${PAPER_AUTHOR}/${PAPER_PERMLINK}/retract`)
      .set('X-Hive-Username', PAPER_AUTHOR)
      .send({ reason: 'Data fabrication' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BROADCAST_FAILED');
    expect(res.body.error.details).toEqual({ retriable: false });
  });
});

// ──────────────────────────────────────────────
// BACKEND-HAF-WALKER-WALL-CLOCK-BUDGET round-2 hold item 2 — sibling-route
// DoS-amplifier closure. /retract reaches the forward walker via
// `fetchPaperDetailFromHaf → resolveContinuationChain`; pre-fix this route
// was not wrapped in an AbortController, so attacker-posted long chains
// under degraded HAF could starve worker threads here too. The canary
// pins the wrapper presence + the route's 503 surface on abort.
//
// Mutation-kill: drop the AbortController wrapper (revert to bare
// `fetchPaperDetailFromHaf(author, permlink)` without signal) → wall-clock
// abort never fires → fetchPaperDetailFromHaf returns the mocked paper
// row → handler reaches the authorization check → 403 (not paper author)
// or 404, not 503. Status assertion fails red.
// ──────────────────────────────────────────────

describe('POST /api/papers/:author/:permlink/retract — wall-clock budget (round-2 item 2)', () => {
  // Fresh (account, paper) pair to avoid the `paper-retract` rate limiter
  // (max 5/hour byAccount, declared at papers.ts:353) which is exhausted
  // by prior tests in this file using PAPER_AUTHOR='alice'. Without a
  // fresh account the canary's request gets 429'd before reaching the
  // walker abort path.
  const ABORT_USER = 'abort-canary-user';
  const ABORT_PAPER = 'abort-canary-paper';

  beforeEach(() => {
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockResolvedValue({ id: 'mock-retract-tx' });
  });

  it('/retract wraps walker in AbortController + surfaces 503 on wall-clock abort', async () => {
    // Slow EVERY hafQueryMock call to ~80ms. Budget is 50ms below, so
    // the forward walker's first chain-walk query consumes the budget;
    // the next iteration's signal.aborted check emits the wall-clock
    // event and fetchPaperDetailFromHaf returns null at the end (item
    // 7's cache-bypass return), then the route handler observes
    // walkerAbort.signal.aborted → 503.
    hafQueryMock.mockReset().mockImplementation(async (sql: string) => {
      await new Promise((r) => setTimeout(r, 80));
      if (sql.includes('parent_author') && sql.includes('parent_permlink') && sql.includes('json_metadata') && !sql.includes("'continues'")) {
        return {
          rows: [{
            author: ABORT_USER,
            permlink: ABORT_PAPER,
            title: 'Test Paper',
            body: 'Abstract',
            json_metadata: {
              app: `${config.appTag}/0.1`,
              [config.appTag]: { type: 'paper', authors: [] },
            },
            created: '2026-04-22T00:00:00Z',
            last_edited: null,
          }],
        };
      }
      return { rows: [] };
    });

    const originalBudget = config.hafWalkerWallClockMs;
    (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = 50;
    try {
      const res = await request(app)
        .post(`/api/papers/${ABORT_USER}/${ABORT_PAPER}/retract`)
        .set('X-Hive-Username', ABORT_USER)
        .send({ reason: 'Degraded HAF abort canary' });

      expect(res.status).toBe(503);
      // No broadcast happens on abort — the abort path returns BEFORE
      // the authorization check + broadcast.
      expect(broadcastJsonMock).not.toHaveBeenCalled();
    } finally {
      (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = originalBudget;
    }
  });
});
