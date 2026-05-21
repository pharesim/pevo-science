/**
 * /api/papers/:author/:permlink/retract — rate-limiter slot-burn canaries.
 *
 * Pre-fix: the `retractLimiter` (max=5/hour byAccount, no `skipFailedRequests`)
 * consumed one slot on EVERY request, including the 503 retriable responses
 * the route emits when HAF throws `HafQueryError`. The SPA's
 * retry-on-`details.retriable: true` loop then burned the full hour budget
 * during a single outage event, and the legitimate user was locked out
 * until the rolling-window head aged out (up to 1 hour after HAF
 * recovered).
 *
 * Post-fix: `retractLimiter` carries `skipFailedRequests: true`. The
 * middleware refunds the slot on every >= 400 response (4xx and 5xx) by
 * registering refund listeners on `res.on('finish')` + `res.on('close')`.
 * Only successful (status < 400) responses consume slots.
 *
 * Mocking justification (per root CLAUDE.md "Running Tests" carve-out):
 * (a) Real-path: seeding 6 real papers on the pevotest chain per-test is
 * impractical, and exercising HAF outage against real testnet is non-
 * deterministic. (b) Auth focus is rate-limiter behavior, not signature
 * cryptography — the MOCK_VERIFY_SIGNATURE fixture preserves the
 * username-extraction behavior. (c) Real-path companion: corpus-level
 * real-path coverage of the `verifyHiveSignature` middleware is provided
 * by the `sign-request.ts` consumers — `auth.test.ts`, `claims.test.ts`,
 * and `bridge-haf-lag-locks.test.ts` exercise the real middleware against
 * cryptographically signed requests on sibling routes. The rate-limiter
 * middleware itself (the risk class this file pins) is real-path-covered
 * by `tests/middleware/rateLimit.test.ts`. The carve-out is for focus,
 * not for skipping auth verification entirely from the codebase.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

// vi.hoisted lifts these to the top of the module evaluation so they're
// defined BEFORE the ES module imports below (and therefore before
// vi.mock's lazy factory accesses them when app.ts imports db.js). A
// plain `class` declaration in source order is NOT enough — ES imports
// are hoisted to the top and evaluate before any code below them.
const { hafQueryMock, broadcastJsonMock, HafQueryError, isRetriableHafError } = vi.hoisted(() => {
  class HafQueryError extends Error {
    constructor(operation: string, options?: ErrorOptions) {
      super(`HAF query failed: ${operation}`, options);
      this.name = 'HafQueryError';
    }
  }
  function isRetriableHafError(err: HafQueryError): boolean {
    const code = (err.cause as { code?: unknown } | null | undefined)?.code;
    if (typeof code !== 'string') return true;
    return code.startsWith('08') || code === '57014' || code === '57P01' || code === '57P03' || code === '53300';
  }
  return {
    hafQueryMock: vi.fn().mockResolvedValue({ rows: [] }),
    broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'mock-retract-tx' }),
    HafQueryError,
    isRetriableHafError,
  };
});

vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: hafQueryMock }),
  isHafConfigured: () => true,
  closeHafPool: async () => { /* no-op */ },
  HafQueryError,
  isRetriableHafError,
}));

vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: { getAccounts: vi.fn().mockResolvedValue([]) },
    broadcast: { json: broadcastJsonMock },
  },
  broadcastJsonWithTimeout: (...args: unknown[]) =>
    (broadcastJsonMock as (...a: unknown[]) => unknown)(...args),
  BroadcastTimeoutError: class BroadcastTimeoutError extends Error {
    constructor(timeoutMs: number) {
      super(`Hive broadcast timed out after ${timeoutMs}ms`);
      this.name = 'BroadcastTimeoutError';
    }
  },
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
}));

import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';

// Deterministic WIF keeps PrivateKey.fromString happy on the broadcast path;
// broadcast.json is mocked, so no actual signing happens.
config.pevoAdminPostingKey = PrivateKey.fromSeed('pevo-retract-rate-limit-test').toString();

const app = createApp();

// Builds a HAF row matching the paper detail SELECT shape so the
// retract route's authorization check passes (username === detail.author).
function paperRowFor(author: string, permlink: string) {
  return {
    rows: [{
      author,
      permlink,
      title: 'Test Paper',
      body: 'Abstract',
      json_metadata: {
        app: `${config.appTag}/0.1`,
        [config.appTag]: { type: 'paper', authors: [] },
      },
      created: '2026-05-20T00:00:00Z',
      last_edited: null,
    }],
  };
}

describe('POST /api/papers/:author/:permlink/retract — rate-limiter slot-burn under HAF outage (skipFailedRequests)', () => {
  beforeEach(() => {
    hafQueryMock.mockReset();
    broadcastJsonMock.mockReset();
    broadcastJsonMock.mockResolvedValue({ id: 'mock-retract-tx' });
  });

  it('5 HAF-throw requests + 1 success request → 6th succeeds (slot burn = 1, not 5)', async () => {
    // Unique account name per-run to avoid cross-run Redis-key persistence
    // polluting the slot count. retractLimiter's appTag-prefixed key
    // (`${appTag}:rl:paper-retract:${username}`) starts at zero for a
    // never-seen account, so we don't need to flush Redis explicitly.
    // Account names must fit Hive's 16-char witness cap (enforced at the
    // /retract URL-shape validator); shorten the prefix from "slot-burn-user"
    // to "sbu" so the fixture stays ≤16 chars with an 8-char random suffix.
    const acct = `sbu-${Math.random().toString(36).slice(2, 10)}`;
    const paper = 'slot-burn-paper';

    // First 5 requests: HAF throws. Route catches `HafQueryError`,
    // discriminator classifies as retriable (no pg code → default true),
    // emits 503 retriable. Limiter's skipFailed refund fires on
    // res.on('finish') because status >= 400.
    hafQueryMock.mockRejectedValue(new Error('connection refused'));

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(`/api/papers/${acct}/${paper}-${i}/retract`)
        .set('X-Hive-Username', acct)
        .send({ reason: 'Outage attempt' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.details?.retriable).toBe(true);
    }

    // 6th request: HAF recovers and the route succeeds. Without skipFailed
    // the limiter would have 5/5 slots consumed and this request would
    // 429 → fails red. With skipFailed the 5 prior slots refunded; the
    // count is 0 at entry; this success consumes slot 1.
    hafQueryMock.mockReset();
    hafQueryMock.mockImplementation(async (sql: string) => {
      // Paper detail SELECT — return a row authored by `acct`.
      if (sql.includes('parent_author') && sql.includes('parent_permlink') && sql.includes('json_metadata') && !sql.includes("'continues'")) {
        return paperRowFor(acct, `${paper}-success`);
      }
      // All other queries (walker probes, accreditation lookups,
      // version reconstruction, etc.) return empty rows so the route
      // produces a clean 200.
      return { rows: [] };
    });

    const success = await request(app)
      .post(`/api/papers/${acct}/${paper}-success/retract`)
      .set('X-Hive-Username', acct)
      .send({ reason: 'Legitimate retraction after HAF recovery' });

    expect(success.status).toBe(200);
    expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
  });

  it('6 successful retracts → 6th request returns 429 (real abuse rate still bounded)', async () => {
    // Pins that skipFailedRequests only refunds FAILED responses; the 200
    // success path still consumes a slot. Without this assertion a future
    // mis-config (e.g. accidentally also refunding 200s) would silently
    // remove the rate limit.
    const acct = `sru-${Math.random().toString(36).slice(2, 10)}`;
    const paper = 'success-rate-paper';

    // Each successful retract consumes one slot (5 slots total). The
    // route's authorization check requires the paper author to match the
    // signing username, so the HAF mock must return a row per request.
    hafQueryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('parent_author') && sql.includes('parent_permlink') && sql.includes('json_metadata') && !sql.includes("'continues'")) {
        const permlinkParam = (params as string[] | undefined)?.[1] ?? `${paper}-?`;
        return paperRowFor(acct, permlinkParam);
      }
      return { rows: [] };
    });

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(`/api/papers/${acct}/${paper}-${i}/retract`)
        .set('X-Hive-Username', acct)
        .send({ reason: 'Legitimate retraction' });
      expect(res.status).toBe(200);
    }

    // 6th request: limiter is at 5/5 (max). Returns 429 RATE_LIMITED.
    const sixth = await request(app)
      .post(`/api/papers/${acct}/${paper}-extra/retract`)
      .set('X-Hive-Username', acct)
      .send({ reason: 'Sixth attempt' });

    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('RATE_LIMITED');
    expect(broadcastJsonMock).toHaveBeenCalledTimes(5);
  });
});
