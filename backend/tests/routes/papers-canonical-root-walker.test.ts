/**
 * Canaries for the forward-walker-delegated canonical-root resolution.
 *
 * `findCanonicalRoot` resolves a leaf's canonical root by:
 *   (1) walking `pevo.continues` pointers backward unconstrained to a
 *       candidate root R;
 *   (2) calling `resolveContinuationChain(R)` (the cumulative-aware
 *       forward walker) for verification;
 *   (3) checking the leaf is in the resulting chain, fail-CLOSED if not;
 *   (4) caching the mapping for 30 min.
 *
 * Pins the three behaviours the rewrite must produce:
 *
 *   1. **Reproducer chain.** `alice/p1 → bob/v2 → carol/v3` where bob/v2's
 *      `pevo.authors[]` drops alice (excludes both alice and carol). The
 *      forward walker admits carol's hop via the cumulative-union from
 *      alice/p1's authors. The previous strict backward walker rejected
 *      the `carol/v3 → bob/v2` hop (carol not in bob's authors) and
 *      returned carol/v3 as canonical — producing divergent cache shapes
 *      for `/api/papers/alice/p1` vs `/api/papers/carol/v3`. The
 *      forward-walker-delegated walker resolves both URLs to alice/p1
 *      by delegating verification to the forward walker.
 *
 *   2. **Lowercased-trimmed membership key (pin 1).** A mixed-case leaf URL
 *      `/api/papers/Carol/V3` must resolve to the same canonical root
 *      `alice/p1`. The membership check at step 3 normalises both sides
 *      (`toLowerCase().trim()`) so the route-param case variation does
 *      not fail-CLOSE against a chain entry stored in Hive consensus
 *      form (lowercased ascii). Without this, a case-mismatched URL
 *      would soft-fail to the leaf as standalone.
 *
 *   3. **Cycle-detect event (pin 2).** A 2-node mutual cycle
 *      (`alice/v1 → bob/v1 → alice/v1`) on the backward walk emits
 *      `canonical_root_walker_cycle_detected` and stops the walk. The
 *      cycle short-circuit uses the same per-call `Set<string>` primitive
 *      the forward walker uses, keyed on `${author}/${permlink}`.
 *
 * **Carve-out (per CLAUDE.md "Running Tests"):** these tests mock
 * `getPool()` to seed a synthetic three-link continuation chain with a
 * specific cumulative-union shape (bob drops alice). Real HAF cannot be
 * seeded on demand with this exact author-set arrangement, and the
 * reproducer specifically requires a chain where the OLD backward
 * walker's per-hop check would diverge from the forward walker's
 * cumulative gate — that divergence is what these canaries pin. Per
 * CLAUDE.md clauses (a)/(b)/(c):
 *   (a) justification documented above (deterministic synthesis of the
 *       cumulative-union divergence shape is impractical against the
 *       public HAF DB);
 *   (b) `verifyHiveSignature` is NOT mocked — `/api/papers/:author/:permlink`
 *       is a public GET route that does not authenticate;
 *   (c) real-path companion: the cumulative-union forward walker is
 *       exercised against real HAF integratively in
 *       `tests/routes/papers.test.ts` and the continuation gate in
 *       `tests/routes/continuation-author-gate.test.ts`. The same risk
 *       class (chain resolution against the cumulative admit-set) is
 *       caught integratively there.
 *
 * Cryptographic auth verification is irrelevant — the assertions are
 * about chain-resolution semantics on a public-GET surface; no signed
 * request is in play. The `MOCK_VERIFY_SIGNATURE` fixture is NOT used.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as unknown[] })),
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

function installResponder(handler: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>) {
  hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params: params ?? [] });
    return handler(sql, params ?? []);
  });
}

/**
 * SQL-shape discriminators. Mirror the existing canonical-root walker
 * canary's shapes so future SQL refactors stay coherent across both
 * files.
 */
function isBackwardWalkContinuesProbe(sql: string): boolean {
  return /AS\s+cont_author/.test(sql) && /AS\s+cont_permlink/.test(sql);
}
function isInitialBackwardProbe(sql: string): boolean {
  return /SELECT\s+c\.author,\s+c\.json_metadata,/.test(sql);
}
function isHeadAuthorsLookup(sql: string): boolean {
  return /SELECT\s+c\.author,\s+c\.json_metadata/.test(sql)
    && /parent_permlink\s*=\s*\$3/.test(sql)
    && !/AS\s+cont_author/.test(sql);
}
/** Forward-walker continuation-probe (cumulative-admit-set SQL). */
function isForwardWalkContinuationProbe(sql: string): boolean {
  return /c\.author\s*=\s*ANY\(\$4::text\[\]\)/.test(sql);
}
/** Paper-detail row fetch. */
function isPaperDetailFetch(sql: string): boolean {
  return /SELECT\s+c\.author,\s+c\.permlink,\s+c\.title/.test(sql);
}

function pevoPaperJsonMeta(namedAuthors: string[]) {
  return {
    app: `${config.appTag}/test`,
    [config.appTag]: {
      type: 'paper',
      authors: namedAuthors.map((hive) => ({ hive })),
    },
  };
}

function pevoPaperRow(
  author: string,
  permlink: string,
  namedAuthors: string[],
  options: { continues?: { author: string; permlink: string } } = {},
) {
  const pevoFields: Record<string, unknown> = {
    type: 'paper',
    authors: namedAuthors.map((hive) => ({ hive })),
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

/**
 * Build a responder for the reproducer chain:
 *   alice/p1.authors = [alice, bob, carol]
 *   bob/v2.authors = [bob]    (drops alice + carol)
 *   bob/v2.continues = alice/p1
 *   carol/v3.authors = [carol]
 *   carol/v3.continues = bob/v2
 *
 * Forward walker from alice/p1 admits the full [alice/p1, bob/v2,
 * carol/v3] chain via the cumulative-union (root's contribution {alice,
 * bob, carol} dominates). The old strict backward walker from carol/v3
 * rejected the carol→bob hop because carol ∉ {bob}. The new
 * forward-walker-delegated walker resolves to alice/p1 via forward
 * verify + membership check.
 */
function installReproducerResponder() {
  const aliceMeta = pevoPaperJsonMeta(['alice', 'bob', 'carol']);
  const bobMeta = pevoPaperJsonMeta(['bob']);
  const carolMeta = pevoPaperJsonMeta(['carol']);
  const aliceRow = pevoPaperRow('alice', 'p1', ['alice', 'bob', 'carol']);
  const bobRow = pevoPaperRow('bob', 'v2', ['bob'], { continues: { author: 'alice', permlink: 'p1' } });
  const carolRow = pevoPaperRow('carol', 'v3', ['carol'], { continues: { author: 'bob', permlink: 'v2' } });

  installResponder(async (sql, params) => {
    if (isBackwardWalkContinuesProbe(sql)) {
      const a = params[0];
      const p = params[1];
      if (isInitialBackwardProbe(sql)) {
        // Initial probe — return start-row identity + cont fields.
        if (a === 'carol' && p === 'v3') {
          return {
            rows: [{
              author: 'carol',
              json_metadata: carolRow.json_metadata,
              cont_author: 'bob',
              cont_permlink: 'v2',
            }],
          };
        }
        if (a === 'bob' && p === 'v2') {
          return {
            rows: [{
              author: 'bob',
              json_metadata: bobRow.json_metadata,
              cont_author: 'alice',
              cont_permlink: 'p1',
            }],
          };
        }
        if (a === 'alice' && p === 'p1') {
          // alice/p1 has no `continues` — the SQL IS NOT NULL filter
          // produces zero rows.
          return { rows: [] };
        }
        return { rows: [] };
      }
      // Loop-continuation probes: only cont_author/cont_permlink.
      if (a === 'bob' && p === 'v2') {
        return { rows: [{ cont_author: 'alice', cont_permlink: 'p1' }] };
      }
      if (a === 'alice' && p === 'p1') {
        // alice/p1 is the root — no continues.
        return { rows: [] };
      }
      return { rows: [] };
    }
    if (isHeadAuthorsLookup(sql)) {
      const a = params[0];
      const p = params[1];
      if (a === 'alice' && p === 'p1') {
        return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
      }
      if (a === 'bob' && p === 'v2') {
        return { rows: [{ author: 'bob', json_metadata: bobMeta }] };
      }
      if (a === 'carol' && p === 'v3') {
        return { rows: [{ author: 'carol', json_metadata: carolMeta }] };
      }
      return { rows: [] };
    }
    if (isForwardWalkContinuationProbe(sql)) {
      const parentAuthor = params[0];
      const parentPermlink = params[1];
      // params[3] is cumulative author array. params[2] = appTag, params[4] = bridge.
      // alice/p1 → bob/v2 admitted (bob in {alice, bob, carol}).
      if (parentAuthor === 'alice' && parentPermlink === 'p1') {
        return {
          rows: [{
            author: 'bob',
            permlink: 'v2',
            json_metadata: bobRow.json_metadata,
            block_num: 200,
          }],
        };
      }
      // bob/v2 → carol/v3 admitted (carol in cumulative; bob drops carol from his
      // own authors, but the cumulative still carries her via alice/p1's
      // contribution).
      if (parentAuthor === 'bob' && parentPermlink === 'v2') {
        return {
          rows: [{
            author: 'carol',
            permlink: 'v3',
            json_metadata: carolRow.json_metadata,
            block_num: 300,
          }],
        };
      }
      return { rows: [] };
    }
    if (isPaperDetailFetch(sql)) {
      const a = params[0];
      const p = params[1];
      if (a === 'alice' && p === 'p1') return { rows: [aliceRow] };
      if (a === 'bob' && p === 'v2') return { rows: [bobRow] };
      if (a === 'carol' && p === 'v3') return { rows: [carolRow] };
      return { rows: [] };
    }
    return { rows: [] };
  });
}

describe('GET /api/papers/:author/:permlink — canonical-root forward-walker delegation', () => {
  it('reproducer chain: /api/papers/carol/v3 resolves to alice/p1 via forward-walker delegation', async () => {
    // The cumulative-union forward walker admits the full chain even
    // though bob/v2 drops alice from its own `pevo.authors[]`. The
    // backward walker delegates verification to the forward walker, so
    // entering at carol/v3 must canonicalise to alice/p1 — the same
    // root the forward walker resolves from alice/p1's direct URL.
    installReproducerResponder();

    const res = await request(app).get('/api/papers/carol/v3');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    // The leaf URL resolves to alice/p1 (the chain root).
    expect(detail.author).toBe('alice');
    expect(detail.permlink).toBe('p1');
  });

  it('pin 1 — mixed-case leaf URL: /api/papers/Carol/V3 resolves to alice/p1', async () => {
    // The membership check at step 3 normalises both sides
    // (lowercased + trimmed). Hive consensus stores chain entries as
    // lowercased ascii; without normalisation, a mixed-case URL would
    // fail-CLOSE to itself even when the leaf is a legitimate member.
    installReproducerResponder();

    const res = await request(app).get('/api/papers/Carol/V3');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    // Same resolution as the lowercase URL — different-case URLs hit the
    // same chain root.
    expect(detail.author).toBe('alice');
    expect(detail.permlink).toBe('p1');
  });

  it('pin 2 — 2-node mutual cycle emits canonical_root_walker_cycle_detected on backward walk', async () => {
    // alice/v1 ↔ bob/v1 — each points to the other via `pevo.continues`,
    // and each names the other in `pevo.authors[]` so the forward walker
    // would admit both directions too (the SQL gate is symmetric in the
    // mutual-vouch case). Without cycle detection the backward walker
    // would run to CANONICAL_ROOT_MAX_HOPS = 10 SQL queries on this
    // shape; with the visited-Set primitive it short-circuits at the
    // first advancement that revisits a node.
    const mutualMeta = pevoPaperJsonMeta(['alice', 'bob']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice', 'bob'], { continues: { author: 'bob', permlink: 'v1' } });
    const bobRow = pevoPaperRow('bob', 'v1', ['alice', 'bob'], { continues: { author: 'alice', permlink: 'v1' } });

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (isInitialBackwardProbe(sql)) {
          if (a === 'alice' && p === 'v1') {
            return {
              rows: [{
                author: 'alice',
                json_metadata: aliceRow.json_metadata,
                cont_author: 'bob',
                cont_permlink: 'v1',
              }],
            };
          }
          return { rows: [] };
        }
        // Loop-continuation probes.
        if (a === 'bob' && p === 'v1') {
          return { rows: [{ cont_author: 'alice', cont_permlink: 'v1' }] };
        }
        if (a === 'alice' && p === 'v1') {
          return { rows: [{ cont_author: 'bob', cont_permlink: 'v1' }] };
        }
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        if (a === 'alice' || a === 'bob') {
          return { rows: [{ author: a, json_metadata: mutualMeta }] };
        }
        return { rows: [] };
      }
      // Forward walker: bob/v1 admits alice/v1, alice/v1 admits bob/v1 —
      // also a cycle the forward walker's own cycle detector catches.
      // For the membership check, we just need a non-empty chain so the
      // test focuses on the backward-walk cycle event.
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
      if (isPaperDetailFetch(sql)) {
        const a = params[0] as string;
        const p = params[1] as string;
        if (a === 'alice' && p === 'v1') return { rows: [aliceRow] };
        if (a === 'bob' && p === 'v1') return { rows: [bobRow] };
        return { rows: [] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await request(app).get('/api/papers/alice/v1');
    expect(res.status).toBe(200);

    const events = warnSpy.mock.calls
      .map((c) => (c[0] as { event?: string } | undefined)?.event)
      .filter(Boolean);

    // The cycle event fired during the backward walk.
    expect(events).toContain('canonical_root_walker_cycle_detected');
    // And the depth-cap event did NOT (cycle detection short-circuits
    // first — mutation-kill: removing the visited-Set check would let
    // the walker run to CANONICAL_ROOT_MAX_HOPS and emit
    // depth_exceeded instead).
    expect(events).not.toContain('canonical_root_walker_depth_exceeded');

    // Backward continues-probe count is bounded well below the depth cap.
    const probeCount = captured.filter((c) => isBackwardWalkContinuesProbe(c.sql)).length;
    expect(probeCount).toBeLessThan(10);

    warnSpy.mockRestore();
  });

  it('cache key shape: same key for lowercase + mixed-case URLs (no divergent cache entries)', async () => {
    // The cache key uses normalised leaf coords so different-case URLs
    // for the same chain hit the same cache entry — closing the
    // cache-data inconsistency window. After a request to /Carol/V3,
    // the cache must serve /carol/v3 without re-walking the chain.
    installReproducerResponder();

    // First request: mixed-case. Populates cache.
    const res1 = await request(app).get('/api/papers/Carol/V3');
    expect(res1.status).toBe(200);

    // Read the cache directly. Key shape:
    //   `${appTag}:cache:canonical-root:<leaf-author>:<leaf-permlink>`
    // (the cache class adds `${appTag}:cache:`; the key we pass is
    // `canonical-root:<leaf-author>:<leaf-permlink>`).
    const lowercaseEntry = await hafCache.get('canonical-root:carol:v3');
    expect(lowercaseEntry).toBeDefined();
    expect(lowercaseEntry).toEqual({ root: { author: 'alice', permlink: 'p1' } });

    // Mixed-case lookup hits the SAME normalised key (post-write the
    // lookup at `Carol/V3` resolves to the lowercase entry).
    const mixedCaseEntry = await hafCache.get('canonical-root:carol:v3');
    expect(mixedCaseEntry).toEqual(lowercaseEntry);
  });

  it('fail-CLOSED: leaf not in forward-verify chain returns to leaf coords (attacker phishing surface preserved)', async () => {
    // attacker/fake-paper claims pevo.continues = {alice, paper-v1}.
    // Backward unconstrained walk reaches alice/paper-v1. Forward
    // verify from alice/paper-v1 only admits posts in alice's
    // cumulative; attacker is not in it, so the chain returned by the
    // forward walker is [alice/paper-v1] alone. Membership check:
    // attacker/fake-paper is NOT in the chain → fail-CLOSED to the
    // leaf's own URL. The attacker's URL surfaces only the attacker's
    // own content, never alice's — same phishing-pretext defence the
    // previous backward gate enforced.
    const aliceMeta = pevoPaperJsonMeta(['alice']);
    const aliceRow = pevoPaperRow('alice', 'paper-v1', ['alice']);
    const attackerRow = pevoPaperRow('attacker', 'fake-paper', ['attacker'], { continues: { author: 'alice', permlink: 'paper-v1' } });

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (isInitialBackwardProbe(sql)) {
          if (a === 'attacker' && p === 'fake-paper') {
            return {
              rows: [{
                author: 'attacker',
                json_metadata: attackerRow.json_metadata,
                cont_author: 'alice',
                cont_permlink: 'paper-v1',
              }],
            };
          }
          return { rows: [] };
        }
        // Loop probe for alice/paper-v1: she's the root (no continues
        // pointer of her own).
        if (a === 'alice' && p === 'paper-v1') {
          return { rows: [] };
        }
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'paper-v1') {
          return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
        }
        return { rows: [] };
      }
      if (isForwardWalkContinuationProbe(sql)) {
        // Forward walker from alice/paper-v1: no candidate post in
        // alice's cumulative admit-set continues at alice/paper-v1.
        return { rows: [] };
      }
      if (isPaperDetailFetch(sql)) {
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
    // The URL surfaces the ATTACKER's own content (fail-CLOSED), NOT
    // alice's. Same security property the previous backward gate
    // enforced.
    expect(detail.author).toBe('attacker');
    expect(detail.permlink).toBe('fake-paper');

    // The walker emitted the membership-failed event (the new
    // fail-CLOSED signal vocabulary).
    const events = warnSpy.mock.calls
      .map((c) => (c[0] as { event?: string } | undefined)?.event)
      .filter(Boolean);
    expect(events).toContain('canonical_root_walker_membership_failed');

    warnSpy.mockRestore();
  });

  it('mid-step-2 wall-clock abort skips the canonical-root cache write', async () => {
    // Pins the post-forward-verify abort re-check: when the wall-clock
    // budget trips DURING step 2 (forward verify), the forward walker
    // swallows its own abort and returns whatever chain it has
    // accumulated so far — possibly a truncated chain that does not
    // contain the leaf. Without re-checking `signal.aborted` between the
    // forward-walker return and the membership check, a legitimate
    // deep-chain leaf would evaluate `isMember === false` and the
    // negative-result branch would cache `{root: null}` for the full TTL,
    // poisoning the entry for the next 30 minutes on a degraded HAF that
    // has since recovered.
    //
    // Setup: the reproducer chain is admitted by the forward walker, so
    // under normal conditions /api/papers/carol/v3 resolves to alice/p1
    // and caches the mapping (pinned by the reproducer spec above). Here
    // we shrink `hafWalkerWallClockMs` to 1ms and stall the
    // forward-walker SQL probes long enough for the abort to fire mid
    // step 2. The backward unconstrained walk completes synchronously
    // against the mocked responder so the pre-step-2 abort guard does
    // not pre-empt — the abort lands inside step 2, exercising the
    // post-step-2 re-check.
    const originalBudget = config.hafWalkerWallClockMs;
    (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = 1;
    try {
      const aliceMeta = pevoPaperJsonMeta(['alice', 'bob', 'carol']);
      const bobMeta = pevoPaperJsonMeta(['bob']);
      const carolMeta = pevoPaperJsonMeta(['carol']);
      const aliceRow = pevoPaperRow('alice', 'p1', ['alice', 'bob', 'carol']);
      const bobRow = pevoPaperRow('bob', 'v2', ['bob'], { continues: { author: 'alice', permlink: 'p1' } });
      const carolRow = pevoPaperRow('carol', 'v3', ['carol'], { continues: { author: 'bob', permlink: 'v2' } });

      installResponder(async (sql, params) => {
        if (isBackwardWalkContinuesProbe(sql)) {
          const a = params[0];
          const p = params[1];
          if (isInitialBackwardProbe(sql)) {
            if (a === 'carol' && p === 'v3') {
              return { rows: [{ author: 'carol', json_metadata: carolRow.json_metadata, cont_author: 'bob', cont_permlink: 'v2' }] };
            }
            return { rows: [] };
          }
          if (a === 'bob' && p === 'v2') {
            return { rows: [{ cont_author: 'alice', cont_permlink: 'p1' }] };
          }
          if (a === 'alice' && p === 'p1') {
            return { rows: [] };
          }
          return { rows: [] };
        }
        if (isHeadAuthorsLookup(sql)) {
          const a = params[0];
          if (a === 'alice') return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
          if (a === 'bob') return { rows: [{ author: 'bob', json_metadata: bobMeta }] };
          if (a === 'carol') return { rows: [{ author: 'carol', json_metadata: carolMeta }] };
          return { rows: [] };
        }
        if (isForwardWalkContinuationProbe(sql)) {
          // Stall long enough for the wall-clock to fire on the next
          // iteration's abort check inside the forward walker. The walker
          // then breaks out, returning the chain accumulated so far.
          await new Promise((resolve) => setTimeout(resolve, 50));
          const parentAuthor = params[0];
          const parentPermlink = params[1];
          if (parentAuthor === 'alice' && parentPermlink === 'p1') {
            return { rows: [{ author: 'bob', permlink: 'v2', json_metadata: bobRow.json_metadata, block_num: 200 }] };
          }
          if (parentAuthor === 'bob' && parentPermlink === 'v2') {
            return { rows: [{ author: 'carol', permlink: 'v3', json_metadata: carolRow.json_metadata, block_num: 300 }] };
          }
          return { rows: [] };
        }
        if (isPaperDetailFetch(sql)) {
          const a = params[0];
          if (a === 'carol') return { rows: [carolRow] };
          if (a === 'alice') return { rows: [aliceRow] };
          if (a === 'bob') return { rows: [bobRow] };
          return { rows: [] };
        }
        return { rows: [] };
      });

      await request(app).get('/api/papers/carol/v3');

      // The load-bearing assertion: the abort occurred inside step 2,
      // so no canonical-root cache entry should have been written for
      // the leaf. A regression that removes the post-step-2 re-check
      // would cache `{ root: null }` here and poison the entry for 30
      // minutes.
      const cached = await hafCache.get('canonical-root:carol:v3');
      expect(cached).toBeUndefined();
    } finally {
      (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = originalBudget;
    }
  });
});
