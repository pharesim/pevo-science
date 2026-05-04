/**
 * Canonical-root backward walker author-gate + depth-cap canary tests.
 *
 * Pins the gates added in BACKEND-CANONICAL-ROOT-WALKER-AUTHOR-GATE:
 *   1. Author-consent gate. At every backward hop in `findCanonicalRoot`,
 *      the post we walk FROM (the child claiming a `continues` predecessor)
 *      must be authored by an account in the predecessor's
 *      `pevo.authors[]` (or bridge-paper Option b set). If not, the walk
 *      stops at the child node — the URL displays the attacker's own
 *      content, not the predecessor's.
 *   2. Depth cap. The walker bounds at `CANONICAL_ROOT_MAX_HOPS = 10` and
 *      emits a structured warn `event: 'canonical_root_walker_depth_exceeded'`
 *      so operators can detect attacker-induced amplification.
 *   3. Per-request memoization: the per-`(author, permlink)` metadata
 *      fetched by the backward walker is reused by the forward walker
 *      (`resolveContinuationChain` via `fetchPaperDetailFromHaf`) within a
 *      single request.
 *
 * Threat model: any Hive account can post a comment with
 * `pevo.continues = {alice, paper-v1}` pointing at a real paper and
 * `pevo.type = 'paper'`. Without the gate, navigating to
 * `/api/papers/attacker/fake-paper` walks back through the attacker's
 * pointer and surfaces alice's content under the attacker's URL — a
 * phishing pretext. The gate breaks the chain at the unauthorized hop and
 * returns the attacker's own post as canonical.
 *
 * **Carve-out (per CLAUDE.md "Running Tests"):** these tests mock
 * `getPool()` to capture the SQL string and seed deterministic head/
 * predecessor rows. Real HAF cannot be seeded with a spoofed continuation
 * authored by an unaccredited account on demand. Per CLAUDE.md clauses
 * (a)/(b)/(c):
 *   (a) justification documented above (deterministic spoofed-continuation
 *       seeding is impractical against the public HAF DB),
 *   (b) `verifyHiveSignature` and other middleware are NOT mocked,
 *   (c) real-HAF integration is filed as a follow-up alongside the sibling
 *       continuation-author-gate canary file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async () => ({ rows: [] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafAvailable: () => getPoolMock() !== null,
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

function installResponder(handler: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>) {
  hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params: params ?? [] });
    return handler(sql, params ?? []);
  });
}

/**
 * Recognise the "look up THIS post's continues pointer" SQL emitted by
 * `findCanonicalRoot`. Two shapes exist:
 *
 *   - Initial: `AS cont_author` AND `IS NOT NULL` (only return rows that
 *     actually have a `continues` field).
 *   - Subsequent: `AS cont_author` without the `IS NOT NULL` predicate
 *     (we want to know whether the predecessor ALSO has a continues
 *     pointer, so a NULL is the natural "this is the root" signal).
 *
 * Both shapes are part of the backward walker.
 */
function isBackwardWalkContinuesProbe(sql: string): boolean {
  return /AS\s+cont_author/.test(sql) && /AS\s+cont_permlink/.test(sql);
}

/** Recognise the head authorized-authors lookup
 *  (`fetchHeadAuthorizedAuthors`'s SQL). */
function isHeadAuthorsLookup(sql: string): boolean {
  return /SELECT\s+c\.author,\s+c\.json_metadata/.test(sql)
    && /parent_permlink\s*=\s*\$3/.test(sql)
    && !/AS\s+cont_author/.test(sql);
}

function pevoPaperJsonMeta(namedAuthors: string[], extra: Record<string, unknown> = {}) {
  return {
    app: `${config.appTag}/test`,
    [config.appTag]: {
      type: 'paper',
      authors: namedAuthors.map((hive) => ({ hive })),
      ...extra,
    },
  };
}

function pevoPaperRow(
  author: string,
  permlink: string,
  namedAuthors: string[],
  options: { continues?: { author: string; permlink: string }; extra?: Record<string, unknown> } = {},
) {
  const pevoFields: Record<string, unknown> = {
    type: 'paper',
    authors: namedAuthors.map((hive) => ({ hive })),
    ...(options.extra ?? {}),
  };
  if (options.continues) {
    pevoFields.continues = options.continues;
  }
  return {
    author,
    permlink,
    title: 't',
    body: 'abstract\n\n---\n\nbody',
    json_metadata: {
      app: `${config.appTag}/test`,
      [config.appTag]: pevoFields,
    },
    created: '2026-01-01T00:00:00.000Z',
    last_edited: '2026-01-01T00:00:00.000Z',
  };
}

describe('GET /api/papers/:author/:permlink — backward canonical-root walker author-gate', () => {
  it('phishing pretext: attacker post pointing at alice does NOT redirect to alice\'s content', async () => {
    // attacker/fake-paper claims pevo.continues = {alice, paper-v1} and
    // pevo.type = 'paper'. Without the gate, findCanonicalRoot walks back
    // to alice/paper-v1 and the URL displays alice's paper. The author-
    // consent gate breaks the chain at the attacker→alice hop because
    // attacker is NOT in alice's pevo.authors[].
    const aliceMeta = pevoPaperJsonMeta(['alice']);
    const attackerRow = pevoPaperRow('attacker', 'fake-paper', ['attacker'], {
      continues: { author: 'alice', permlink: 'paper-v1' },
    });

    installResponder(async (sql, params) => {
      // Backward-walker continues-probe: returns this post's continues.
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'attacker' && p === 'fake-paper') {
          return { rows: [{ cont_author: 'alice', cont_permlink: 'paper-v1' }] };
        }
        if (a === 'alice' && p === 'paper-v1') {
          // alice has no continues (she's the root) — but the gate should
          // reject the hop before this query fires.
          return { rows: [{ cont_author: null, cont_permlink: null }] };
        }
        return { rows: [] };
      }
      // Head authorized-authors lookup for the predecessor (alice/paper-v1):
      // attacker is NOT in this set, so the gate rejects the hop.
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'paper-v1') {
          return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
        }
        if (a === 'attacker' && p === 'fake-paper') {
          return { rows: [{ author: 'attacker', json_metadata: attackerRow.json_metadata }] };
        }
        return { rows: [] };
      }
      // Paper detail fetch
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        const a = params[0];
        if (a === 'attacker') return { rows: [attackerRow] };
        return { rows: [] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await request(app).get('/api/papers/attacker/fake-paper');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    // The URL must resolve to the ATTACKER's own content, NOT alice's.
    expect(detail.author).toBe('attacker');
    expect(detail.permlink).toBe('fake-paper');

    // The walker emitted the unauthorized-hop event.
    const events = warnSpy.mock.calls
      .map((c) => (c[0] as { event?: string } | undefined)?.event)
      .filter(Boolean);
    expect(events).toContain('canonical_root_walker_unauthorized_hop');

    warnSpy.mockRestore();
  });

  it('DoS amplifier: 11-hop chain stops at depth cap with structured warn', async () => {
    // Build a self-continuation chain v0 ← v1 ← v2 ← ... ← v11. All hops
    // are author-authorized (alice continues alice), so only the depth cap
    // stops the walk. Without the cap an attacker could induce arbitrarily
    // many SQL queries per request.
    const N = 11;
    const aliceMeta = pevoPaperJsonMeta(['alice']);

    installResponder(async (sql, params) => {
      // Backward-walker continues-probe: every v_i except v_0 has continues
      // pointing at v_{i-1}. v_0 has no continues (root).
      if (isBackwardWalkContinuesProbe(sql)) {
        const p = params[1] as string;
        const m = /^v(\d+)$/.exec(p);
        if (!m) return { rows: [] };
        const i = Number(m[1]);
        if (i === 0) {
          return { rows: [{ cont_author: null, cont_permlink: null }] };
        }
        return { rows: [{ cont_author: 'alice', cont_permlink: `v${i - 1}` }] };
      }
      // Head authorized-authors lookup: every paper in the chain admits
      // alice as a continuator.
      if (isHeadAuthorsLookup(sql)) {
        return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
      }
      // Paper detail at the top of the chain (resolved canonical).
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', params[1] as string, ['alice'])] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await request(app).get(`/api/papers/alice/v${N}`);
    expect(res.status).toBe(200);

    // The depth-cap event was emitted.
    const depthEvents = warnSpy.mock.calls
      .map((c) => c[0] as { event?: string } | undefined)
      .filter((e) => e?.event === 'canonical_root_walker_depth_exceeded');
    expect(depthEvents.length).toBeGreaterThan(0);

    // Walker issued at most CANONICAL_ROOT_MAX_HOPS (10) backward continues
    // probes. The initial probe + at-most-10 hop probes => at most 11
    // continues-probe SQL captures.
    const probeCount = captured.filter((c) => isBackwardWalkContinuesProbe(c.sql)).length;
    expect(probeCount).toBeLessThanOrEqual(11);

    warnSpy.mockRestore();
  });

  it('legitimate self-continuation: alice/v2 → alice/v1 walks all the way to root', async () => {
    // alice/v1 (root) ← alice/v2. Asking for alice/v2 must canonicalize to
    // alice/v1 because the hop is author-authorized (alice in alice's
    // pevo.authors[]).
    const aliceMeta = pevoPaperJsonMeta(['alice']);
    const v1Row = pevoPaperRow('alice', 'v1', ['alice']);

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const p = params[1];
        if (p === 'v2') return { rows: [{ cont_author: 'alice', cont_permlink: 'v1' }] };
        if (p === 'v1') return { rows: [{ cont_author: null, cont_permlink: null }] };
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        const p = params[1];
        if (p === 'v1') return { rows: [v1Row] };
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/v2');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    // Canonicalised to v1 (the root).
    expect(detail.author).toBe('alice');
    expect(detail.permlink).toBe('v1');
  });

  it('legitimate co-author continuation: bob/v2 → alice/v1 admitted (bob is in alice\'s authors)', async () => {
    // alice/v1 has pevo.authors=[alice, bob]. bob posts v2 with
    // pevo.continues={alice, v1}. Asking for bob/v2 must canonicalize to
    // alice/v1 because bob is in alice's authorized-authors set.
    const aliceMeta = pevoPaperJsonMeta(['alice', 'bob']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice', 'bob']);

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'v2') return { rows: [{ cont_author: 'alice', cont_permlink: 'v1' }] };
        if (a === 'alice' && p === 'v1') return { rows: [{ cont_author: null, cont_permlink: null }] };
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v1') {
          return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v1') return { rows: [aliceRow] };
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/bob/v2');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail.author).toBe('alice');
    expect(detail.permlink).toBe('v1');
  });

  it('per-request memo: head-authors lookup for the canonical root fires once across backward + forward walks', async () => {
    // Prove the per-request memo: a single request that triggers BOTH the
    // backward walker (`findCanonicalRoot`) AND the forward walker
    // (`resolveContinuationChain` via `fetchPaperDetailFromHaf`) must not
    // re-fetch the canonical root's metadata.
    //
    // Setup: bob/v2 → alice/v1. bob's URL canonicalises to alice/v1, then
    // the route hander forward-walks from alice/v1.
    const aliceMeta = pevoPaperJsonMeta(['alice', 'bob']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice', 'bob']);

    let aliceHeadLookupCount = 0;

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'v2') return { rows: [{ cont_author: 'alice', cont_permlink: 'v1' }] };
        if (a === 'alice' && p === 'v1') return { rows: [{ cont_author: null, cont_permlink: null }] };
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v1') {
          aliceHeadLookupCount += 1;
          return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v1') return { rows: [aliceRow] };
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/bob/v2');
    expect(res.status).toBe(200);

    // Backward walker fetches alice/v1's authors once. Forward walker
    // (resolveContinuationChain) hits the memo and does NOT re-fetch.
    // The exact count is 1 — any value >1 means the memo failed.
    expect(aliceHeadLookupCount).toBe(1);
  });
});
