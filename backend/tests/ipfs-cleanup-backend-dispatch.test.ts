/**
 * Cleanup-job per-backend unpin dispatch: `runCleanup` must release an orphaned
 * pin from the SAME backend that created it, reading the `pin_backend`
 * discriminator persisted on the `pending_ipfs_uploads` row. A Pinata-origin
 * pin reaped by a hardcoded Kubo `pin/rm` would fire at a node that never held
 * it (a benign "not pinned"), delete the tracking row, and leave the pin live
 * on Pinata forever with no record of it.
 *
 * Justification for `vi.mock` (per root CLAUDE.md test carve-out, clauses
 * a/b/c):
 *
 *   (a) Real-path impracticality: `runCleanup` DELETEs every expired row it
 *       finds, so driving it against the shared dev app pool would destroy
 *       real in-flight tracking rows. And `cidReferencedInHaf` runs a
 *       full-corpus `comments` scan (jsonb containment OR a LIKE over image
 *       arrays) that takes minutes and trips `statement_timeout` against the
 *       real HAF node for a synthetic CID. Both shared infra helpers
 *       (`getAppPool`, `getPool`, `isHafConfigured`, `getRedis`) and the IPFS
 *       network client (`fetch`) are therefore stubbed so the test is
 *       deterministic and non-destructive — the assertion is purely which
 *       backend the unpin dispatches to.
 *
 *   (b) No auth middleware is involved: the cleanup job is an internal periodic
 *       task with no HTTP surface, so there is no `verifyHiveSignature` gate to
 *       preserve or bypass here.
 *
 *   (c) Real-path companion: the per-backend unpin dispatch this file asserts
 *       shares its risk class — correct-backend routing via `unpinFromIpfs` —
 *       with the Pinata compensation-dispatch test in
 *       `routes/ipfs-pin-durability.test.ts`, which drives the real upload
 *       route with a real config toggle, and with the `unpinFromPinata`
 *       benign-absence unit in `lib/ipfs-shared-unpin.test.ts`. This file pins
 *       the cleanup-side wiring: that `runCleanup` reads `pin_backend` and
 *       passes it to the dispatcher rather than hardcoding Kubo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Per-test-controlled app pool stub. The cleanup scan SELECT returns a single
// fixture row; the DELETE that reaps it is a no-op. Declared before the
// vi.mock so the (lazily invoked) factory closes over the live binding.
const appQueryMock = vi.fn();
let appPoolHandle: { query: typeof appQueryMock } | null = { query: appQueryMock };

vi.mock('../src/app-db.js', () => ({
  getAppPool: () => appPoolHandle,
  verifyAppDbMigrations: vi.fn(async () => {}),
  closeAppPool: vi.fn(async () => {}),
}));

// HAF: report "configured" so runCleanup does not early-return, and make the
// reference check resolve instantly to not-referenced (rowCount 0) so the row
// routes to the unpin branch. Spreads the real module so non-overridden
// exports (e.g. the table-name constants consumed transitively) stay intact.
vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  return {
    ...actual,
    isHafConfigured: () => true,
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
});

// Redis is a best-effort hot-cache delete in the cleanup loop — return null so
// the redis branch is skipped without per-test churn.
vi.mock('../src/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn(async () => {}),
}));

const { runCleanup } = await import('../src/ipfs-cleanup.js');
const { config } = await import('../src/config.js');

const FAKE_CID = 'QmCleanupDispatchFixture0000000000000000000000000';

interface FetchCall {
  url: string;
  method: string;
}

let fetchCalls: FetchCall[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  appQueryMock.mockReset();
  appPoolHandle = { query: appQueryMock };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// The cleanup scan SELECT yields one expired row with the given backend; the
// DELETE that reaps it after unpin is a no-op resolve.
function seedSingleRow(pinBackend: string): void {
  appQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT cid, uploader_account, pin_backend')) {
      return { rows: [{ cid: FAKE_CID, uploader_account: 'tester', pin_backend: pinBackend }] };
    }
    if (sql.includes('DELETE FROM pending_ipfs_uploads')) {
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

function stubUnpinFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    fetchCalls.push({ url, method });
    return new Response('OK', { status: 200 });
  }) as typeof globalThis.fetch;
}

describe('IPFS cleanup — per-backend unpin dispatch', () => {
  it('routes a pin_backend=pinata orphan to the Pinata unpin, never Kubo', async () => {
    seedSingleRow('pinata');
    stubUnpinFetch();

    await runCleanup();

    const pinataUnpins = fetchCalls.filter(
      (c) => c.url.includes(`pinata.cloud/pinning/unpin/${FAKE_CID}`) && c.method === 'DELETE',
    );
    const kuboUnpins = fetchCalls.filter((c) => c.url.includes('/api/v0/pin/rm'));

    expect(pinataUnpins).toHaveLength(1);
    expect(kuboUnpins).toHaveLength(0);
  });

  it('routes a pin_backend=kubo orphan to the Kubo pin/rm, never Pinata', async () => {
    seedSingleRow('kubo');
    stubUnpinFetch();

    await runCleanup();

    const kuboUnpins = fetchCalls.filter(
      (c) => c.url.includes('/api/v0/pin/rm') && c.url.includes(FAKE_CID) && c.method === 'POST',
    );
    const pinataUnpins = fetchCalls.filter((c) => c.url.includes('pinata.cloud/pinning/unpin/'));

    expect(kuboUnpins).toHaveLength(1);
    expect(pinataUnpins).toHaveLength(0);
    // Sanity: the Kubo unpin targets the configured node, not a relative URL.
    expect(kuboUnpins[0].url.startsWith(config.ipfsApiUrl)).toBe(true);
  });
});
