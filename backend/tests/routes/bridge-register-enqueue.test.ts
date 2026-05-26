/**
 * Route tests for the /api/bridge/register enqueue behaviour and the new
 * /api/bridge/imports status endpoint.
 *
 * Justification for the mocks (per root CLAUDE.md "Running Tests" carve-out):
 *
 * (a) Real path that is impractical per-test:
 *   - The full register-then-broadcast end-to-end path requires real
 *     CrossRef / arXiv calls to resolve metadata and a real Hive broadcast
 *     under a real bridge account, neither of which is feasible to run
 *     deterministically inside a unit-test loop.
 *   - The accreditation gate requires a real on-chain `issue_accreditation`
 *     custom_json indexed by HAF; impractical per-test.
 *   - `getPool()` / `isHafConfigured()` are mocked so the route's
 *     pre-enqueue HAF duplicate-check is forced through a known branch
 *     without seeding HAF.
 *
 * (b) `verifyHiveSignature` is NOT mocked — requests are signed end-to-end
 *     against the real middleware. This file's tests assert on enqueue
 *     and status-listing behaviour; cryptographic verification is part of
 *     the focus.
 *
 * (c) Real-path companion: the queue model itself runs against real
 *     Postgres in `backend/tests/lib/bridge-queue.test.ts`. The dispatch
 *     path is covered indirectly by the real-DB queue tests (state
 *     transitions, retry/backoff, lease semantics). The route-level
 *     mocks here cover only the enqueue plumbing (cap → 429, duplicate
 *     active → 409, happy path → 202 envelope shape).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { PrivateKey } from '@hiveio/dhive';

const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-bridge-enqueue-test-seed');
const TEST_PUBLIC_KEY = TEST_PRIVATE_KEY.createPublic().toString();
const TEST_BRIDGE_KEY = PrivateKey.fromSeed('pevo-bridge-enqueue-test-bridge-key').toString();

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      hiveBridgeAccount: 'pevotest.bridge',
      pevoBridgePostingKey: TEST_BRIDGE_KEY,
    },
  };
});

const sendOperations = vi.fn().mockResolvedValue({ id: 'mock-tx-id-not-used' });
vi.mock('../../src/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn().mockImplementation((names: string[]) =>
        Promise.resolve(
          names.map((name) => ({
            name,
            posting: { key_auths: [[TEST_PUBLIC_KEY, 1]] },
          })),
        ),
      ),
    },
    broadcast: {
      sendOperations: (...args: unknown[]) => sendOperations(...args),
    },
  },
  broadcastSendOperationsWithTimeout: (...args: unknown[]) => sendOperations(...args),
  BroadcastTimeoutError: class extends Error {},
  DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
}));

const { MOCK_META } = vi.hoisted(() => ({
  MOCK_META: {
    title: 'Enqueue test paper',
    authors: [{ name: 'Alice', orcid: null, affiliation: null }],
    abstract: 'Test abstract.',
    doi: null,
    arxiv_id: '2999.00001',
    source_type: 'arxiv',
    source_url: 'https://arxiv.org/abs/2999.00001',
    pdf_url: null,
    published_date: '2026-01-01',
    source_name: 'arXiv',
    license: null,
    subjects: [],
  },
}));
vi.mock('../../src/bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/bridge.js')>('../../src/bridge.js');
  return {
    ...actual,
    resolveToCanonical: vi.fn().mockImplementation(async (identifier: string) => {
      const m = identifier.match(/^(\d{4}\.\d{5})$/);
      if (m) return { type: 'arxiv', id: m[1] };
      return actual.resolveToCanonical(identifier);
    }),
    lookupPreprint: vi.fn().mockImplementation(async (identifier: string) => {
      const m = identifier.match(/^(\d{4}\.\d{5})$/);
      if (m) return { ...MOCK_META, arxiv_id: m[1], source_url: `https://arxiv.org/abs/${m[1]}` };
      return null;
    }),
  };
});

const accreditedSet = new Set<string>();
vi.mock('../../src/accreditation.js', () => ({
  getAccreditedSet: vi.fn().mockImplementation(async (names: string[]) =>
    new Set(names.filter((n) => accreditedSet.has(n))),
  ),
  getAllAccreditedAccounts: vi.fn().mockResolvedValue(new Set<string>()),
}));

// HAF pool mock — return no rows so the pre-enqueue duplicate check finds
// nothing and the route falls through to enqueue. Tests that want the
// DUPLICATE branch override per-test.
const pgQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('../../src/db.js', () => ({
  getPool: () => ({ query: (...args: unknown[]) => pgQuery(...args) }),
  isHafConfigured: () => true,
  closeHafPool: async () => {},
}));

vi.mock('../../src/redis.js', () => ({
  getRedis: () => null,
  isRedisAvailable: () => false,
  disconnectRedis: async () => {},
}));

const { createApp } = await import('../../src/app.js');
const { getAppPool, closeAppPool } = await import('../../src/app-db.js');
const { BRIDGE_QUEUE_USER_CAP, tryEnqueueBridgeImport, markCompleted, markCompletedExisting } = await import('../../src/bridge-queue.js');
const { signRequestBound: signRequestBoundShared } = await import('../support/sign-request.js');

const app = createApp();

function signRequestBound(method: string, fullPath: string, body: Record<string, unknown>, timestamp: string): string {
  return signRequestBoundShared(TEST_PRIVATE_KEY, method, fullPath, body, timestamp);
}

async function signedPost(path: string, username: string, body: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const signature = signRequestBound('POST', path, body, timestamp);
  return request(app)
    .post(path)
    .set('X-Hive-Username', username)
    .set('X-Hive-Signature', signature)
    .set('X-Hive-Timestamp', timestamp)
    .send(body);
}

async function signedGet(path: string, username: string) {
  const timestamp = new Date().toISOString();
  // verifyHiveSignature strips the query string before binding the signed
  // message (req.originalUrl.split('?')[0]); sign against the same shape.
  const signaturePath = path.split('?')[0];
  const signature = signRequestBound('GET', signaturePath, {}, timestamp);
  return request(app)
    .get(path)
    .set('X-Hive-Username', username)
    .set('X-Hive-Signature', signature)
    .set('X-Hive-Timestamp', timestamp);
}

async function cleanupQueueRowsFor(usernamePrefix: string): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;
  await pool.query(
    `DELETE FROM bridge_import_queue WHERE username LIKE $1`,
    [`${usernamePrefix}%`],
  );
}

async function tableAvailable(): Promise<boolean> {
  const pool = getAppPool();
  if (!pool) return false;
  try {
    await pool.query(`SELECT 1 FROM bridge_import_queue LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

describe('POST /api/bridge/register: enqueue path', () => {
  const ACCREDITED_CALLER = 'enqueueacc';
  const USER_PREFIX = 'enqueueacc';
  let tableReady = false;

  beforeEach(async () => {
    tableReady = await tableAvailable();
    if (!tableReady) return;
    accreditedSet.clear();
    accreditedSet.add(ACCREDITED_CALLER);
    pgQuery.mockReset();
    pgQuery.mockResolvedValue({ rows: [] });
    sendOperations.mockClear();
    await cleanupQueueRowsFor(USER_PREFIX);
  });

  it('returns 202 with queue position, eta, and serialized entry on a fresh enqueue', async () => {
    if (!tableReady) return;
    const res = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2999.00100',
      discipline: 'Computer Science',
      keywords: ['attention'],
      language: 'en',
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.queue_position).toBe(1);
    expect(typeof res.body.data.eta_seconds).toBe('number');
    expect(res.body.data.entry.state).toBe('pending');
    expect(res.body.data.entry.permlink).toBe('bridge-arxiv-2999-00100');
    expect(res.body.data.entry.username).toBeUndefined(); // serializer omits username
    expect(res.body.data.entry.attempts).toBe(0);
    // Enriched fields: register persists the resolved title, and the pending
    // entry carries a numeric eta (position 1 → 0) with no author yet.
    expect(res.body.data.entry.title).toBe(MOCK_META.title);
    expect(res.body.data.entry.eta_seconds).toBe(0);
    expect(res.body.data.entry.author).toBeNull();
    expect(res.body.data.source.type).toBe('arxiv');
    // No broadcast on the enqueue path — the worker handles dispatch.
    expect(sendOperations).not.toHaveBeenCalled();
  });

  it('rejects the 6th submission with 429 RATE_LIMITED carrying inflight + cap details', async () => {
    if (!tableReady) return;
    // Fill the cap.
    for (let i = 0; i < BRIDGE_QUEUE_USER_CAP; i++) {
      const r = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
        identifier: `2999.0010${i}`,
        discipline: 'CS',
        keywords: [],
        language: 'en',
      });
      expect(r.status).toBe(202);
    }
    const overflow = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2999.00199',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(overflow.status).toBe(429);
    expect(overflow.body.error.code).toBe('RATE_LIMITED');
    expect(overflow.body.error.details.inflight).toBe(BRIDGE_QUEUE_USER_CAP);
    expect(overflow.body.error.details.cap).toBe(BRIDGE_QUEUE_USER_CAP);
    expect(overflow.body.error.details.retriable).toBe(true);
  });

  it('rejects a concurrent submission for the same permlink with 409 DUPLICATE active', async () => {
    if (!tableReady) return;
    // First enqueue succeeds.
    const first = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2999.00200',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(first.status).toBe(202);
    // Second submission for the same permlink (different user, same identifier).
    accreditedSet.add(`${USER_PREFIX}two`);
    const second = await signedPost('/api/bridge/register', `${USER_PREFIX}two`, {
      identifier: '2999.00200',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE');
    expect(second.body.error.details.existing_entry_id).toBeDefined();
    expect(second.body.error.details.existing_entry_state).toBe('pending');
  });

  it('still returns 409 DUPLICATE (existing on-chain) when HAF reports a match — does not enqueue', async () => {
    if (!tableReady) return;
    pgQuery.mockResolvedValueOnce({
      rows: [
        {
          author: 'pevotest.bridge',
          permlink: 'bridge-arxiv-2999-00301',
          title: 'Existing paper',
          created: new Date('2026-01-20T00:00:00Z'),
        },
      ],
    });
    const res = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2999.00301',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE');
    expect(res.body.error.details.existing_author).toBe('pevotest.bridge');
    expect(res.body.error.details.existing_permlink).toBe('bridge-arxiv-2999-00301');
    // Pre-enqueue duplicate: no queue row created.
    const pool = getAppPool();
    if (pool) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM bridge_import_queue WHERE permlink = $1`,
        ['bridge-arxiv-2999-00301'],
      );
      expect(Number(rows[0].count)).toBe(0);
    }
  });
});

describe('GET /api/bridge/imports: status listing', () => {
  const ACCREDITED_CALLER = 'enqueueimports';
  const USER_PREFIX = 'enqueueimports';
  let tableReady = false;

  beforeEach(async () => {
    tableReady = await tableAvailable();
    if (!tableReady) return;
    accreditedSet.clear();
    accreditedSet.add(ACCREDITED_CALLER);
    pgQuery.mockReset();
    pgQuery.mockResolvedValue({ rows: [] });
    await cleanupQueueRowsFor(USER_PREFIX);
  });

  it('returns the caller\'s own entries newest-first with cap echoed', async () => {
    if (!tableReady) return;
    // Enqueue two entries.
    const r1 = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2999.00401',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(r1.status).toBe(202);
    const r2 = await signedPost('/api/bridge/register', ACCREDITED_CALLER, {
      identifier: '2999.00402',
      discipline: 'CS',
      keywords: [],
      language: 'en',
    });
    expect(r2.status).toBe(202);

    const list = await signedGet('/api/bridge/imports', ACCREDITED_CALLER);
    expect(list.status).toBe(200);
    expect(list.body.status).toBe('ok');
    expect(list.body.data.cap).toBe(BRIDGE_QUEUE_USER_CAP);
    expect(Array.isArray(list.body.data.entries)).toBe(true);
    expect(list.body.data.entries.length).toBe(2);
    // Newest-first ordering.
    expect(list.body.data.entries[0].permlink).toBe('bridge-arxiv-2999-00402');
    expect(list.body.data.entries[1].permlink).toBe('bridge-arxiv-2999-00401');
    // Wire-shape spot checks — the fields the SPA renders.
    expect(list.body.data.entries[0].state).toBe('pending');
    expect(list.body.data.entries[0].attempts).toBe(0);
  });

  it('emits title, author, and eta_seconds per the enriched entry shape', async () => {
    if (!tableReady) return;

    // Seed the three states directly via the queue model rather than /register:
    // the register route's per-IP limiter is shared across this file's many
    // register calls, and the field matrix under test (completed-fresh,
    // completed-collision, pending) is the serializer's concern, exercised
    // here through the real GET /imports list query against real Postgres.
    const TITLE = 'Enriched entry shape paper';

    // Fresh broadcast → completed with a tx → author resolves to the bridge
    // account (config.hiveBridgeAccount, mocked to pevotest.bridge).
    const fresh = await tryEnqueueBridgeImport({
      username: ACCREDITED_CALLER, identifier: '2999.00501', title: TITLE,
      permlink: 'bridge-arxiv-2999-00501', discipline: 'CS', keywords: [], language: 'en',
    });
    expect(fresh.status).toBe('enqueued');
    if (fresh.status === 'enqueued') await markCompleted(fresh.row.id, { txId: 'tx-fresh-00501' });

    // Permlink collision → completed-existing → author equals the existing
    // on-chain author.
    const collide = await tryEnqueueBridgeImport({
      username: ACCREDITED_CALLER, identifier: '2999.00502', title: TITLE,
      permlink: 'bridge-arxiv-2999-00502', discipline: 'CS', keywords: [], language: 'en',
    });
    expect(collide.status).toBe('enqueued');
    if (collide.status === 'enqueued') {
      await markCompletedExisting(collide.row.id, { author: 'someone.else', permlink: 'bridge-arxiv-2999-00502' });
    }

    // Pending → non-terminal → numeric eta_seconds, null author.
    const pending = await tryEnqueueBridgeImport({
      username: ACCREDITED_CALLER, identifier: '2999.00503', title: TITLE,
      permlink: 'bridge-arxiv-2999-00503', discipline: 'CS', keywords: [], language: 'en',
    });
    expect(pending.status).toBe('enqueued');

    const list = await signedGet('/api/bridge/imports', ACCREDITED_CALLER);
    expect(list.status).toBe(200);
    const byPermlink: Record<string, Record<string, unknown>> = Object.fromEntries(
      (list.body.data.entries as Array<Record<string, unknown>>).map((e) => [e.permlink as string, e]),
    );

    const freshEntry = byPermlink['bridge-arxiv-2999-00501'];
    expect(freshEntry.state).toBe('completed');
    expect(freshEntry.title).toBe(TITLE);
    expect(freshEntry.author).toBe('pevotest.bridge'); // HIVE_BRIDGE_ACCOUNT
    expect(freshEntry.eta_seconds).toBeNull(); // terminal → no estimate

    const collideEntry = byPermlink['bridge-arxiv-2999-00502'];
    expect(collideEntry.state).toBe('completed');
    expect(collideEntry.existing_author).toBe('someone.else');
    expect(collideEntry.author).toBe('someone.else'); // equals existing_author

    const pendingEntry = byPermlink['bridge-arxiv-2999-00503'];
    expect(pendingEntry.state).toBe('pending');
    expect(pendingEntry.title).toBe(TITLE);
    expect(typeof pendingEntry.eta_seconds).toBe('number');
    expect(pendingEntry.eta_seconds as number).toBeGreaterThanOrEqual(0);
    expect(pendingEntry.author).toBeNull(); // non-terminal
  });

  it('rejects unauthenticated callers with 401', async () => {
    if (!tableReady) return;
    const res = await request(app).get('/api/bridge/imports');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an invalid state filter with 400', async () => {
    if (!tableReady) return;
    const res = await signedGet('/api/bridge/imports?state=bogus', ACCREDITED_CALLER);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a non-numeric limit with 400 (not a 500 from LIMIT NaN)', async () => {
    if (!tableReady) return;
    // Number('abc') is NaN, which slips past `?? 50` and would reach SQL
    // `LIMIT NaN`, surfacing as a 500 without the route-level guard.
    const res = await signedGet('/api/bridge/imports?limit=abc', ACCREDITED_CALLER);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('accepts a valid positive-integer limit', async () => {
    if (!tableReady) return;
    const res = await signedGet('/api/bridge/imports?limit=10', ACCREDITED_CALLER);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

afterAll(async () => {
  await cleanupQueueRowsFor('enqueueacc').catch(() => undefined);
  await cleanupQueueRowsFor('enqueueimports').catch(() => undefined);
  await closeAppPool().catch(() => undefined);
});
