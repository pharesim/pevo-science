/**
 * Canonical-root backward-walker DoS-bound + START-gate + fail-CLOSED
 * canary tests.
 *
 * `findCanonicalRoot` resolves a leaf's canonical root in four steps:
 *   1. Backward unconstrained walk of `pevo.continues` pointers to a
 *      candidate root R. No per-hop author-consent gate on this pass; the
 *      walk retains only the DoS defenses (cycle detection via a per-call
 *      `Set<string>` keyed on `${author}/${permlink}`, and the
 *      `CANONICAL_ROOT_MAX_HOPS` depth cap) plus the START gate (SQL
 *      `validPevoPaperWhere` filter + JS `isPevoAnyPaper` re-check +
 *      `cont_author`/`cont_permlink` string-narrowing).
 *   2. Forward verify by calling `resolveContinuationChain(R)` (the
 *      cumulative-aware forward walker — the SSoT for chain membership).
 *   3. Membership check (fail-CLOSED): if the leaf is not in the forward
 *      walker's admit-set, return null so the URL displays only the leaf's
 *      own content, never an attacker-pointed predecessor's. Emits
 *      `canonical_root_walker_membership_failed`.
 *   4. Cache the resolved `(leaf → root | null)` mapping.
 *
 * This file pins the behaviours that the sibling
 * `papers-canonical-root-walker.test.ts` canary does NOT cover:
 *   - The START gate's three bail reasons (`sql_filter_or_missing`,
 *     `js_is_pevo_any_paper`, `cont_columns_invalid`) and the IS NOT NULL
 *     SQL guard on the initial probe.
 *   - DoS bounds: depth cap (probe-count ceiling + `maxHops` payload field),
 *     3-node cycle detection (proves the visited-Set is a real set, not a
 *     last-node check), and the depth-cap-vs-wall-clock priority ordering.
 *   - Wall-clock budget abort during the backward walk (503 + retriable
 *     wire signal) and the abort path's fail-CLOSED return to the URL
 *     coords (never the attacker-pointed `pevo.continues` target).
 *   - The loop-continuation probe's IS NOT NULL filter.
 *   - The no-pool bail and the outer-catch structured event.
 *   - Per-request memo sharing of `fetchHeadAuthorizedAuthors` results
 *     across the request's forward-walker calls, including the negative
 *     (null) memo and the catch-block memo.
 *   - Legitimate self- and co-author continuations resolving to root via
 *     forward verify, and the bridge-paper Option-b backward case (both
 *     admitted and fail-CLOSED).
 *
 * **Carve-out (per CLAUDE.md "Running Tests"):** these tests mock
 * `getPool()` to capture the SQL string and seed deterministic head/
 * predecessor rows. Real HAF cannot be seeded with a spoofed continuation
 * authored by an unaccredited account, an attacker-posted cycle, or a slow
 * HAF tail on demand. Per CLAUDE.md clauses (a)/(b)/(c):
 *   (a) justification documented above (deterministic seeding of spoofed
 *       continuations, cycles, and degraded-HAF timing is impractical
 *       against the public HAF DB),
 *   (b) `verifyHiveSignature` and other middleware are NOT mocked —
 *       `/api/papers/:author/:permlink` is a public GET route that does not
 *       authenticate, so cryptographic verification is irrelevant to these
 *       chain-resolution assertions,
 *   (c) real-HAF integration of the cumulative forward walker is exercised
 *       in `tests/routes/papers.test.ts` and the continuation gate in
 *       `tests/routes/continuation-author-gate.test.ts`. The same risk
 *       class (chain resolution against the cumulative admit-set) is caught
 *       integratively there.
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

// Spy-cleanup safety net: restores every vi.spyOn(...) installed in an
// it() body regardless of whether assertions in that body threw. The pool
// mock (`getPoolMock`) is a vi.fn() (not a spy) — it is reset and re-wired
// by `beforeEach` above, not by `vi.restoreAllMocks()`.
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
 * Recognise the "look up THIS post's continues pointer" SQL emitted by
 * `findCanonicalRoot`'s backward walk. Two shapes exist:
 *
 *   - Initial probe: selects the START-row identity columns
 *     `c.author, c.json_metadata` plus cont_author/cont_permlink (the
 *     START row's own author + metadata feed the type-spoof gate's JS-side
 *     `isPevoAnyPaper` re-check).
 *   - Loop-continuation probe: selects ONLY cont_author/cont_permlink (we
 *     only need the predecessor's cont pointer to advance the walk).
 *
 * Both shapes carry the `'continues' IS NOT NULL` predicate.
 */
function isBackwardWalkContinuesProbe(sql: string): boolean {
  return /AS\s+cont_author/.test(sql) && /AS\s+cont_permlink/.test(sql);
}

/**
 * Discriminate the initial backward-walker probe (which selects the
 * START-row identity columns `c.author, c.json_metadata` plus
 * cont_author/cont_permlink) from the loop-continuation probe (which
 * selects ONLY cont_author/cont_permlink).
 *
 * Detection key: the `c.author, c.json_metadata,` SELECT-clause prefix is
 * unique to the initial probe (it needs the START row's own author and
 * metadata for the type-spoof gate's JS-side `isPevoAnyPaper` re-check;
 * the loop probe only needs the predecessor's cont pointer).
 *
 * **BRITTLENESS WARNING** — the regex matches a column-list prefix
 * (`SELECT c.author, c.json_metadata,` with a trailing comma). Any future
 * SQL refactor that reorders the initial probe's SELECT columns, inserts a
 * 3rd column between `c.author` and `c.json_metadata`, drops the trailing
 * comma, or normalizes whitespace differently will silently break the
 * discriminator → mock returns the wrong fixture → canaries depending on
 * its dispatch pass for the wrong reason (false GREEN). If this canary or
 * the layer-pinning canaries that depend on its dispatch start failing red
 * after such a refactor, the security property is NOT regressed — the
 * discriminator needs updating, not the production gate. Update both this
 * function AND `isHeadAuthorsLookup` (next) in the same change so they stay
 * mutually exclusive.
 */
function isInitialBackwardProbe(sql: string): boolean {
  return /SELECT\s+c\.author,\s+c\.json_metadata,/.test(sql);
}

/** Recognise the head authorized-authors lookup
 *  (`fetchHeadAuthorizedAuthors`'s SQL — fired by the forward verify step,
 *  NOT the backward walk). */
function isHeadAuthorsLookup(sql: string): boolean {
  return /SELECT\s+c\.author,\s+c\.json_metadata/.test(sql)
    && /parent_permlink\s*=\s*\$3/.test(sql)
    && !/AS\s+cont_author/.test(sql);
}

/** Forward-walker continuation probe (the cumulative-admit-set chain-walk
 *  SQL in `resolveContinuationChain`).
 *
 *  **BRITTLENESS WARNING** — the regex keys on `c.author = ANY($4::text[])`,
 *  pinning BOTH the column (`c.author`) AND the bind position (`$4`). It is
 *  unique to the forward-walk probe today only by coincidence of bind
 *  numbering: the `/enrichment` review-set query binds its `c.author = ANY(...)`
 *  predicate to `$5` and its `v.voter = ANY(...)` vote sub-query to `$4`, so
 *  neither collides with this `c.author = ANY($4)` shape. A future SQL refactor
 *  that renumbers binds — shifting the forward-walk probe's cumulative-author
 *  array off `$4`, or moving the enrichment review-author predicate onto `$4` —
 *  would silently break this discriminator (a miss → the mock returns the wrong
 *  fixture; or a false match → an enrichment query misrouted into the
 *  forward-walk branch). If canaries depending on this dispatch start failing
 *  after a bind-renumbering refactor, the discriminator needs updating, not the
 *  production walker. The durable narrowing, should a collision ever
 *  materialize, is to also require the probe's `JOIN comment_ops` /
 *  `co.block_num` selection, which the enrichment query does not have. Keep
 *  this mutually exclusive with `isInitialBackwardProbe` / `isHeadAuthorsLookup`
 *  if their regexes change. */
function isForwardWalkContinuationProbe(sql: string): boolean {
  return /c\.author\s*=\s*ANY\(\$4::text\[\]\)/.test(sql);
}

/** Per-test mock-config primitive for type-spoof START tests.
 *
 *   - `'with_filter'`: faithful-mock mode. The responder SQL-inspects the
 *     production initial probe and mirrors what real HAF would return: zero
 *     rows when the `validPevoPaperWhere` filter is present (HEAD), or the
 *     spoof row when the filter has been reverted (mutation). This is what
 *     makes the SQL-filter canary fail red on a SQL-filter mutation.
 *
 *   - `'without_filter'`: force-feed mode. The responder ALWAYS returns the
 *     spoof row, regardless of production SQL state. This isolates the
 *     JS-side `isPevoAnyPaper` check as the gate under test.
 *
 * The two layers are kept SEPARATE in two distinct tests so a mutation to
 * either layer (drop SQL filter; or drop JS re-check) fails red on exactly
 * one canary while the other stays green.
 */
type StartProbeMode = 'with_filter' | 'without_filter';

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

describe('GET /api/papers/:author/:permlink — canonical-root backward-walker DoS bounds + fail-CLOSED', () => {
  it('DoS amplifier: 11-hop chain stops at depth cap with structured warn', async () => {
    // Build a self-continuation chain v0 ← v1 ← v2 ← ... ← v11. The
    // backward walk is unconstrained, so only the depth cap stops it.
    // Without the cap an attacker could induce arbitrarily many SQL
    // queries per request.
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
        if (isInitialBackwardProbe(sql)) {
          return {
            rows: [{
              author: 'alice',
              json_metadata: pevoPaperRow('alice', p, ['alice']).json_metadata,
              cont_author: 'alice',
              cont_permlink: `v${i - 1}`,
            }],
          };
        }
        return { rows: [{ cont_author: 'alice', cont_permlink: `v${i - 1}` }] };
      }
      // Forward verify: not load-bearing here (the depth cap fires during
      // the backward walk before a clean root is reached). Return empty so
      // the membership check fail-CLOSES; the assertions below are about
      // the depth event and probe count, not the resolution.
      if (isHeadAuthorsLookup(sql)) {
        return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
      }
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
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

  it('depth-cap warn carries maxHops field and omits hopIndex', async () => {
    // The depth_exceeded warn carries `maxHops` (documents the cap). It
    // deliberately omits `hopIndex` because on this event the two fields
    // would be the same constant by construction — the event name itself
    // signals "we hit the cap", and `maxHops` documents the value.
    //
    // Mutation-kill: drop the `maxHops` field; this canary fails red.
    const N = 11;
    const aliceMeta = pevoPaperJsonMeta(['alice']);

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1] as string;
        if (a !== 'alice') return { rows: [] };
        const m = /^v(\d+)$/.exec(p);
        if (!m) return { rows: [] };
        const i = Number(m[1]);
        if (i === 0) {
          return { rows: [{ cont_author: null, cont_permlink: null }] };
        }
        if (isInitialBackwardProbe(sql)) {
          return {
            rows: [{
              author: 'alice',
              json_metadata: pevoPaperRow('alice', p, ['alice']).json_metadata,
              cont_author: 'alice',
              cont_permlink: `v${i - 1}`,
            }],
          };
        }
        return { rows: [{ cont_author: 'alice', cont_permlink: `v${i - 1}` }] };
      }
      if (isHeadAuthorsLookup(sql)) {
        return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
      }
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', params[1] as string, ['alice'])] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const res = await request(app).get(`/api/papers/alice/v${N}`);
    expect(res.status).toBe(200);

    const depthEvents = warnSpy.mock.calls
      .map((c) => c[0] as { event?: string; maxHops?: number; hopIndex?: number } | undefined)
      .filter((e) => e?.event === 'canonical_root_walker_depth_exceeded');
    expect(depthEvents.length).toBeGreaterThan(0);
    // maxHops = CANONICAL_ROOT_MAX_HOPS (10).
    expect(depthEvents[0]?.maxHops).toBe(10);
    // hopIndex is intentionally absent on depth_exceeded.
    expect(depthEvents[0]?.hopIndex).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('detects 3-node cycle (alice/v1 → bob/v1 → carol/v1 → alice/v1) on backward walk', async () => {
    // 3-node cycle verifies the visited Set is real (not a "back-edge to
    // immediate predecessor" check that would pass on a 2-cycle but miss
    // an N-cycle). The sibling canary file already pins the 2-node case;
    // this canary pins that the Set is a true set.
    //
    // Mutation-kill: replace `visited.has(visitedKey)` with a "last node"
    // check (only remembers the immediately previous node) → 3-cycle walks
    // to depth cap → cycle_detected event count drops to 0.
    const mutualMeta = pevoPaperJsonMeta(['alice', 'bob', 'carol']);

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (isInitialBackwardProbe(sql)) {
          if (a === 'alice' && p === 'v1') {
            return {
              rows: [{
                author: 'alice',
                json_metadata: pevoPaperRow('alice', 'v1', ['alice', 'bob', 'carol']).json_metadata,
                cont_author: 'bob',
                cont_permlink: 'v1',
              }],
            };
          }
          return { rows: [] };
        }
        // Loop probes: bob → carol, carol → alice, alice → bob (closes the cycle).
        if (a === 'bob' && p === 'v1') {
          return { rows: [{ cont_author: 'carol', cont_permlink: 'v1' }] };
        }
        if (a === 'carol' && p === 'v1') {
          return { rows: [{ cont_author: 'alice', cont_permlink: 'v1' }] };
        }
        if (a === 'alice' && p === 'v1') {
          return { rows: [{ cont_author: 'bob', cont_permlink: 'v1' }] };
        }
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        if (a === 'alice' || a === 'bob' || a === 'carol') {
          return { rows: [{ author: a, json_metadata: mutualMeta }] };
        }
        return { rows: [] };
      }
      // Forward verify after the cycle break: not load-bearing for the
      // cycle-event assertions.
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        const a = params[0] as string;
        const p = params[1] as string;
        return { rows: [pevoPaperRow(a, p, ['alice', 'bob', 'carol'])] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await request(app).get('/api/papers/alice/v1');
    expect(res.status).toBe(200);

    const events = warnSpy.mock.calls
      .map((c) => c[0] as { event?: string; hopIndex?: number } | undefined)
      .filter(Boolean);

    const cycleEvents = events.filter((e) => e?.event === 'canonical_root_walker_cycle_detected');
    expect(cycleEvents.length).toBeGreaterThan(0);
    const depthEvents = events.filter((e) => e?.event === 'canonical_root_walker_depth_exceeded');
    expect(depthEvents.length).toBe(0);

    const probeCount = captured.filter((c) => isBackwardWalkContinuesProbe(c.sql)).length;
    expect(probeCount).toBeLessThan(10);

    warnSpy.mockRestore();
  });

  it('wall-clock budget: aborts mid-walk on slow HAF, emits canonical_root_walker_wall_clock_exceeded', async () => {
    // Each pool.query takes ~80ms (longer than the per-test budget of
    // 50ms). The walker fires the initial probe before the budget
    // controller aborts; the iteration-boundary `if (signal?.aborted)`
    // check then emits the wall-clock warn and returns null.
    //
    // Mutation-kill: remove the iteration-boundary `signal?.aborted` check
    // in `findCanonicalRoot` → walker runs to depth cap regardless of
    // budget → wall-clock event never fires → canary fails red.
    const N = 6; // depth deeper than where we expect abort to fire
    const aliceMeta = pevoPaperJsonMeta(['alice']);

    installResponder(async (sql, params) => {
      // Slow every backward-walker query to 80ms. The budget (set below)
      // is 50ms, so even the initial probe consumes the budget by the time
      // it returns; the next iteration's `signal?.aborted` check fires
      // before the loop body issues further SQL.
      await new Promise((r) => setTimeout(r, 80));
      if (isBackwardWalkContinuesProbe(sql)) {
        const p = params[1] as string;
        const m = /^v(\d+)$/.exec(p);
        if (!m) return { rows: [] };
        const i = Number(m[1]);
        if (i === 0) {
          return { rows: [{ cont_author: null, cont_permlink: null }] };
        }
        if (isInitialBackwardProbe(sql)) {
          return {
            rows: [{
              author: 'alice',
              json_metadata: pevoPaperRow('alice', p, ['alice']).json_metadata,
              cont_author: 'alice',
              cont_permlink: `v${i - 1}`,
            }],
          };
        }
        return { rows: [{ cont_author: 'alice', cont_permlink: `v${i - 1}` }] };
      }
      if (isHeadAuthorsLookup(sql)) {
        return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', params[1] as string, ['alice'])] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Per-test override of the wall-clock budget. config is a normal JS
    // object literal (not Object.freeze'd); mutate its property here and
    // restore in the finally. afterEach's vi.restoreAllMocks doesn't
    // restore object properties, so do this defensively.
    const originalBudget = config.hafWalkerWallClockMs;
    (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = 50;
    try {
      const res = await request(app).get(`/api/papers/alice/v${N}`);
      // Walker-aborted requests surface as 503 SERVICE_UNAVAILABLE so
      // HTTP-status-only monitors catch degraded HAF independently of the
      // warn log.
      expect(res.status).toBe(503);
      // details.retriable: true is the wire signal the SPA's HAF-503 retry
      // loop keys on. A regression dropping the retriable flag would emit a
      // non-retriable 503 and the SPA would surface a non-actionable error.
      expect(res.body.error.details?.retriable).toBe(true);

      const wallClockEvents = warnSpy.mock.calls
        .map((c) => c[0] as { event?: string; hopIndex?: number; elapsedMs?: number } | undefined)
        .filter((e) => e?.event === 'canonical_root_walker_wall_clock_exceeded');
      expect(wallClockEvents.length).toBeGreaterThan(0);
      // The warn payload carries the iteration index where the abort
      // tripped and how long the walker had been running. Both fields are
      // operator-actionable signals; their presence is the mutation-kill
      // discriminator for "walker silently exited without emitting an
      // event tag".
      expect(wallClockEvents[0]?.hopIndex).toBeGreaterThanOrEqual(0);
      expect(wallClockEvents[0]?.elapsedMs).toBeGreaterThan(0);

      // The walker did NOT exit via the depth cap. With slow HAF the budget
      // must fire first, otherwise the wall-clock signal is redundant. This
      // pairs with the depth-cap-fires-first canary below.
      const depthEvents = warnSpy.mock.calls
        .map((c) => c[0] as { event?: string } | undefined)
        .filter((e) => e?.event === 'canonical_root_walker_depth_exceeded');
      expect(depthEvents.length).toBe(0);
    } finally {
      (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = originalBudget;
    }
  });

  it('wall-clock abort fail-CLOSES to URL coords, not attacker-controlled pevo.continues target (P1 security)', async () => {
    // PHISHING SCENARIO: attacker posts /api/papers/attacker/spoof-paper
    // carrying `pevo.continues = {alice, real-paper}` pointing at alice's
    // real content. Under degraded HAF where the initial probe takes long
    // enough to trip the wall-clock budget BEFORE the forward verify runs,
    // the walker's abort path returns null.
    //
    // - Correct (post-rewrite): the abort path returns null. The route
    //   handler treats a null canonical root identically to "not a
    //   continuation" — it keeps the URL coords (attacker/spoof-paper) and
    //   the subsequent paper-detail fetch stays on the attacker's own
    //   coords (safe — surfaces the attacker's own content or 404). The
    //   attacker-pointed predecessor (alice/real-paper) is NEVER surfaced.
    //
    // - Defect class this guards: an abort path that returned the
    //   deepest-walked node (sourced from the attacker's spoof target)
    //   would set author=alice/permlink=real-paper and surface alice's
    //   content under the attacker's URL. Phishing.
    //
    // Mutation-kill: change the wall-clock abort return from `null` to the
    // current backward-walk node (`{ author: currentAuthor, permlink:
    // currentPermlink }`, sourced from the attacker's spoof target) → the
    // captured paper-detail SQL params switch from ['attacker',
    // 'spoof-paper', …] to ['alice', 'real-paper', …] → canary fails RED
    // on the predecessor-coord assertions below.
    //
    // Observable layer: the walker's return is private (findCanonicalRoot
    // is not exported), but the route handler rewrites (author, permlink)
    // from the canonical root and passes the result to
    // fetchPaperDetailFromHaf, which issues a `SELECT c.author, c.permlink,
    // c.title, …` query. The captured params on that query are the walker's
    // return value lifted to the SQL layer.
    const aliceMeta = pevoPaperJsonMeta(['alice']);

    installResponder(async (sql, params) => {
      // Slow every backward-walker query to 80ms (budget is 50ms below).
      await new Promise((r) => setTimeout(r, 80));
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0] as string;
        const p = params[1] as string;
        if (isInitialBackwardProbe(sql) && a === 'attacker' && p === 'spoof-paper') {
          // Attacker's post: type=paper (passes SQL gate) with cont
          // pointing at alice's real paper (the spoof).
          return {
            rows: [{
              author: 'attacker',
              json_metadata: pevoPaperRow('attacker', 'spoof-paper', ['attacker']).json_metadata,
              cont_author: 'alice',
              cont_permlink: 'real-paper',
            }],
          };
        }
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        if (params[0] === 'alice') return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
        if (params[0] === 'attacker') return { rows: [{ author: 'attacker', json_metadata: pevoPaperJsonMeta(['attacker']) }] };
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        const a = params[0] as string;
        const p = params[1] as string;
        return { rows: [pevoPaperRow(a, p, [a])] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const originalBudget = config.hafWalkerWallClockMs;
    (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = 50;
    try {
      await request(app).get('/api/papers/attacker/spoof-paper');

      // The wall-clock event fired (the abort path was exercised).
      const wallClockEvents = warnSpy.mock.calls
        .map((c) => c[0] as { event?: string } | undefined)
        .filter((e) => e?.event === 'canonical_root_walker_wall_clock_exceeded');
      expect(wallClockEvents.length).toBeGreaterThan(0);

      // CRITICAL — security assertion. After the walker's abort returns
      // null, the route handler keeps the URL coords. Filter the captured
      // SQL probes for the paper-detail SELECT and assert NONE of them was
      // issued with alice's coords: a regression returning the spoof target
      // would land as ['alice', 'real-paper', …].
      const detailQueries = captured.filter((c) =>
        /SELECT\s+c\.author,\s+c\.permlink,\s+c\.title/.test(c.sql)
      );
      for (const q of detailQueries) {
        expect(q.params[0]).not.toBe('alice');
        expect(q.params[1]).not.toBe('real-paper');
      }
    } finally {
      (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = originalBudget;
      warnSpy.mockRestore();
    }
  });

  it('loop-continuation probe carries IS NOT NULL filter (mirrors initial probe)', async () => {
    // Both the initial probe and the loop-continuation probe carry
    // `c.json_metadata -> $3 -> 'continues' IS NOT NULL`, so the SQL gate
    // and the JS-side `!cont_author` post-check stay aligned on the same
    // semantic property ("does this post have a continues pointer?").
    //
    // Loop semantics: the walker tracks (currentAuthor, currentPermlink)
    // OUTSIDE the SQL result (advanced at the END of each iteration from
    // parentRow.cont_author/cont_permlink), so the 0-row case (root has no
    // continues → SQL filter rejects) correctly returns the predecessor
    // accumulated so far.
    //
    // Mutation-kill: remove the `AND c.json_metadata -> $3 -> 'continues'
    // IS NOT NULL` clause from the loop probe → some captured loop-continues
    // probes do NOT carry the predicate → assertion fails red.
    const N = 3; // 3-hop chain → at least 2 loop-continues probes fire
    const aliceMeta = pevoPaperJsonMeta(['alice']);

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const p = params[1] as string;
        const m = /^v(\d+)$/.exec(p);
        if (!m) return { rows: [] };
        const i = Number(m[1]);
        if (i === 0) {
          // Root: with IS NOT NULL the SQL would return 0 rows.
          return { rows: [] };
        }
        if (isInitialBackwardProbe(sql)) {
          return {
            rows: [{
              author: 'alice',
              json_metadata: pevoPaperRow('alice', p, ['alice']).json_metadata,
              cont_author: 'alice',
              cont_permlink: `v${i - 1}`,
            }],
          };
        }
        return { rows: [{ cont_author: 'alice', cont_permlink: `v${i - 1}` }] };
      }
      if (isHeadAuthorsLookup(sql)) {
        return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
      }
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', params[1] as string, ['alice'])] };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/papers/alice/v${N}`);
    expect(res.status).toBe(200);

    // Identify the loop-continuation probes: continues-probe shape but NOT
    // the initial-probe shape. Each must carry the IS NOT NULL predicate.
    const loopProbes = captured.filter(
      (c) => isBackwardWalkContinuesProbe(c.sql) && !isInitialBackwardProbe(c.sql),
    );
    expect(loopProbes.length).toBeGreaterThan(0);
    for (const probe of loopProbes) {
      expect(probe.sql).toMatch(/'continues'\s*IS\s+NOT\s+NULL/i);
    }
  });

  it('depth cap fires before wall-clock when budget is generous (orthogonal signal pinning)', async () => {
    // Asserts the orthogonal failure mode: under FAST HAF + LONG budget +
    // DEEP chain, the depth cap is what stops the walker, NOT the wall-clock
    // budget. The two signals must be cleanly separable; observability
    // dashboards filter on `event` to distinguish "attacker-induced
    // amplification" (depth-exceeded) from "degraded-HAF tail"
    // (wall-clock-exceeded).
    //
    // Mutation-kill: invert the priority order (check depth cap before
    // wall-clock budget at the loop top) → with a fast responder the
    // depth-cap canary still passes here, but the slow-responder canary
    // above stops emitting the wall-clock event because the depth cap exits
    // first. The two canaries together pin the priority.
    const N = 11; // > CANONICAL_ROOT_MAX_HOPS (10)
    const aliceMeta = pevoPaperJsonMeta(['alice']);

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const p = params[1] as string;
        const m = /^v(\d+)$/.exec(p);
        if (!m) return { rows: [] };
        const i = Number(m[1]);
        if (i === 0) {
          return { rows: [{ cont_author: null, cont_permlink: null }] };
        }
        if (isInitialBackwardProbe(sql)) {
          return {
            rows: [{
              author: 'alice',
              json_metadata: pevoPaperRow('alice', p, ['alice']).json_metadata,
              cont_author: 'alice',
              cont_permlink: `v${i - 1}`,
            }],
          };
        }
        return { rows: [{ cont_author: 'alice', cont_permlink: `v${i - 1}` }] };
      }
      if (isHeadAuthorsLookup(sql)) {
        return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
      }
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', params[1] as string, ['alice'])] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Generous budget (30s) ensures fast queries can't trip the wall-clock
    // signal even with 10 hops × 2 SQL each.
    const originalBudget = config.hafWalkerWallClockMs;
    (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = 30000;
    try {
      const res = await request(app).get(`/api/papers/alice/v${N}`);
      expect(res.status).toBe(200);

      const depthEvents = warnSpy.mock.calls
        .map((c) => c[0] as { event?: string } | undefined)
        .filter((e) => e?.event === 'canonical_root_walker_depth_exceeded');
      expect(depthEvents.length).toBeGreaterThan(0);

      const wallClockEvents = warnSpy.mock.calls
        .map((c) => c[0] as { event?: string } | undefined)
        .filter((e) => e?.event === 'canonical_root_walker_wall_clock_exceeded');
      expect(wallClockEvents.length).toBe(0);
    } finally {
      (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = originalBudget;
    }
  });

  it('legitimate self-continuation: alice/v2 → alice/v1 walks to root via forward verify', async () => {
    // alice/v1 (root) ← alice/v2. Asking for alice/v2 must canonicalize to
    // alice/v1: the backward walk reaches alice/v1, the forward verify
    // admits the alice/v1 → alice/v2 chain (alice is in alice's authors),
    // and the membership check confirms alice/v2 is in the chain.
    const aliceMeta = pevoPaperJsonMeta(['alice']);
    const v1Row = pevoPaperRow('alice', 'v1', ['alice']);
    const v2Meta = pevoPaperRow('alice', 'v2', ['alice'], { continues: { author: 'alice', permlink: 'v1' } }).json_metadata;

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v2') {
          return {
            rows: [{
              author: 'alice',
              json_metadata: v2Meta,
              cont_author: 'alice',
              cont_permlink: 'v1',
            }],
          };
        }
        // alice/v1 is the root — no continues.
        if (a === 'alice' && p === 'v1') return { rows: [] };
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
      // Forward verify from alice/v1 admits alice/v2.
      if (isForwardWalkContinuationProbe(sql)) {
        if (params[0] === 'alice' && params[1] === 'v1') {
          return { rows: [{ author: 'alice', permlink: 'v2', block_num: 200, json_metadata: v2Meta }] };
        }
        return { rows: [] };
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

  it('legitimate co-author continuation: bob/v2 → alice/v1 admitted via forward verify', async () => {
    // alice/v1 has pevo.authors=[alice, bob]. bob posts v2 with
    // pevo.continues={alice, v1}. Asking for bob/v2 must canonicalize to
    // alice/v1: the backward walk reaches alice/v1, the forward verify
    // admits bob/v2 (bob is in alice's cumulative authors), and the
    // membership check confirms bob/v2 is in the chain. Enters at the leaf
    // (bob/v2) rather than the root, exercising the backward-then-forward
    // path the sibling forward-walker tests do not.
    const aliceMeta = pevoPaperJsonMeta(['alice', 'bob']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice', 'bob']);
    const bobV2Meta = pevoPaperRow('bob', 'v2', ['bob'], { continues: { author: 'alice', permlink: 'v1' } }).json_metadata;

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'v2') {
          return {
            rows: [{
              author: 'bob',
              json_metadata: bobV2Meta,
              cont_author: 'alice',
              cont_permlink: 'v1',
            }],
          };
        }
        if (a === 'alice' && p === 'v1') return { rows: [] };
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
      if (isForwardWalkContinuationProbe(sql)) {
        if (params[0] === 'alice' && params[1] === 'v1') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 200, json_metadata: bobV2Meta }] };
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

  it('per-request memo: head-authors lookup for the canonical root fires once across forward-verify + detail walks', async () => {
    // Prove the per-request memo: a single request that triggers BOTH the
    // backward walker's forward verify (`findCanonicalRoot` → step 2
    // `resolveContinuationChain`) AND the detail-surface forward walk
    // (`fetchPaperDetailFromHaf`) must not re-fetch the canonical root's
    // metadata.
    //
    // Setup: bob/v2 → alice/v1. bob's URL canonicalises to alice/v1, then
    // the route handler forward-walks from alice/v1.
    const aliceMeta = pevoPaperJsonMeta(['alice', 'bob']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice', 'bob']);
    const bobV2Meta = pevoPaperRow('bob', 'v2', ['bob'], { continues: { author: 'alice', permlink: 'v1' } }).json_metadata;

    let aliceHeadLookupCount = 0;

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'v2') {
          return { rows: [{ author: 'bob', json_metadata: bobV2Meta, cont_author: 'alice', cont_permlink: 'v1' }] };
        }
        if (a === 'alice' && p === 'v1') return { rows: [] };
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
      if (isForwardWalkContinuationProbe(sql)) {
        if (params[0] === 'alice' && params[1] === 'v1') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 200, json_metadata: bobV2Meta }] };
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

    // The forward verify fetches alice/v1's authors once; the detail-surface
    // forward walk hits the memo and does NOT re-fetch. The exact count is 1
    // — any value >1 means the memo failed.
    expect(aliceHeadLookupCount).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────────
  // START-gate layer-pinning canaries
  // ────────────────────────────────────────────────────────────────────

  /**
   * Shared spoof-START responder. SQL-inspects the initial probe to decide
   * whether to return zero rows (SQL filter would have rejected the spoof)
   * or the spoof row (SQL filter absent → JS check must be the gate). This
   * makes the mock FAITHFUL: when production reverts the SQL filter, the
   * mock observes the absence and returns the spoof row, exercising the JS
   * path; when production has the SQL filter, the mock returns zero rows
   * and the SQL path fires.
   */
  function installTypeSpoofStartResponder(mode: StartProbeMode) {
    const aliceMeta = pevoPaperJsonMeta(['alice', 'bob']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice', 'bob']);
    const bobSpoofMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'review',
        continues: { author: 'alice', permlink: 'v1' },
      },
    };
    const spoofRow = {
      author: 'bob',
      json_metadata: bobSpoofMeta,
      cont_author: 'alice',
      cont_permlink: 'v1',
    };

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'spoof-review') {
          if (mode === 'with_filter') {
            // Faithful-mock semantics: respond as real HAF would.
            // - Production SQL has the validPevoPaperWhere filter →
            //   pevo.type='review' rejected at SQL layer → 0 rows.
            // - Production SQL has had the filter reverted → row passes the
            //   SQL layer → mock returns the spoof row.
            // Detection key: the `'type'` literal appears in
            // `validPevoPaperWhere` (`(c.json_metadata -> $3 ->> 'type') =
            // 'paper'`) but does NOT appear elsewhere in the initial probe
            // (the SELECT/WHERE references `'continues'`, never `'type'`).
            // So `'type'` in the SQL string is a tight, drift-resistant
            // marker for filter presence on this specific probe.
            //
            // BRITTLENESS WARNING: this discriminator assumes
            // `validPevoPaperWhere` emits the literal `'type'` inline in the
            // rendered SQL. A future SQL-builder sweep that parametrizes
            // literals (`$N` placeholders for `'type'`, `'paper'`, etc.)
            // would break the regex match → mock returns the spoof row in
            // `with_filter` mode → SQL canary fails RED on a refactor that
            // did NOT regress security. This is a FALSE ALARM: the
            // discriminator needs updating, the gate is intact. Do not "fix"
            // by relaxing the regex — that opens room for a real
            // `validPevoPaperWhere` drop to slip through later.
            if (/'type'/.test(sql)) {
              return { rows: [] };
            }
            return { rows: [spoofRow] };
          }
          // 'without_filter': force-feed the spoof row regardless of
          // production SQL state. This isolates the JS-side `isPevoAnyPaper`
          // check as the gate under test.
          return { rows: [spoofRow] };
        }
        if (a === 'alice' && p === 'v1') return { rows: [] };
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
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
      // Paper detail fetch. With the gate present (either layer), the walker
      // rejects the START, no canonicalisation; bob/spoof-review's own
      // detail SQL (which itself runs validPevoPaperWhere) returns no row →
      // 404. alice/v1's row is wired up so a mutation that surfaces the gate
      // failure (walker proceeds → canonicalises to alice/v1) results in 200
      // with alice's content under bob's URL, exactly the failure mode the
      // gate prevents.
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v1') return { rows: [aliceRow] };
        return { rows: [] };
      }
      return { rows: [] };
    });
  }

  it('rejects type-spoof START via SQL filter (sql_filter_or_missing)', async () => {
    // Layer-pinning canary 1 of 2. Pins the SQL-side validPevoPaperWhere
    // filter on `findCanonicalRoot`'s initial probe. The faithful-mock
    // SQL-inspects the production probe: when the filter predicate is
    // present (HEAD), the mock returns zero rows; when reverted, it returns
    // the spoof row.
    //
    // On HEAD: SQL filter present → mock returns 0 rows → walker bails at
    // `result.rows.length === 0` and emits `reason: 'sql_filter_or_missing'`.
    //
    // Mutation-kill: revert the SQL filter (drop the `validPevoPaperWhere(...)`
    // predicate from the initial probe's WHERE clause) → the mock observes
    // filter-absent and returns the spoof row → walker reaches the JS-side
    // `!isPevoAnyPaper(...)` check, bails there with
    // `reason: 'js_is_pevo_any_paper'` → assertion
    // `reason === 'sql_filter_or_missing'` fails RED.
    //
    // Spy level: this reason emits at debug because sql_filter_or_missing
    // fires on every benign 404 lookup of a non-PEvO post (warn would drown
    // signal in noise). See
    // `agents/docs/solutions/conventions/pino-spy-level-filter-ordering-trap-2026-05-07.md`.
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    installTypeSpoofStartResponder('with_filter');

    const res = await request(app).get('/api/papers/bob/spoof-review');
    // URL must NOT canonicalise to alice/v1. 404 because bob/spoof-review
    // has no PEvO-paper detail row (and the walker rejected the START).
    expect(res.status).toBe(404);

    // Pin the kill reason: SQL filter (or missing row) is the gate that fired.
    const events = debugSpy.mock.calls
      .map((c) => c[0] as { event?: string; reason?: string } | undefined)
      .filter((e) => e?.event === 'canonical_root_walker_start_invalid');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.reason).toBe('sql_filter_or_missing');

    debugSpy.mockRestore();
  });

  it('rejects type-spoof START via JS isPevoAnyPaper (js_is_pevo_any_paper)', async () => {
    // Layer-pinning canary 2 of 2. Pins the JS-side defense-in-depth
    // re-check. The mock force-feeds the spoof row regardless of production
    // SQL state (mode `'without_filter'`), so the JS `isPevoAnyPaper` check
    // is the ONLY observed gate. The walker bails at the
    // `!isPevoAnyPaper(startMeta, startRow.author)` branch.
    //
    // On HEAD: mock returns spoof row → walker reaches the JS check → emits
    // `reason: 'js_is_pevo_any_paper'`.
    //
    // Mutation-kill: drop the JS re-check (`if (typeof startRow.author !==
    // 'string' || !isPevoAnyPaper(...))`) → walker proceeds past the spoof
    // row → no `js_is_pevo_any_paper` event → assertion FAILS RED.
    //
    // Orthogonal-mutation green: revert ONLY the SQL filter (NOT the JS
    // check) → mock still force-feeds spoof row → JS check still fires →
    // event still emits → JS canary stays GREEN.
    //
    // Spy level: warn (js_is_pevo_any_paper is a rare attack-signal path
    // that warrants operator alerting, distinct from the noisy
    // sql_filter_or_missing 404 path which stays at debug).
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    installTypeSpoofStartResponder('without_filter');

    const res = await request(app).get('/api/papers/bob/spoof-review');
    expect(res.status).toBe(404);

    // Pin the kill reason: JS isPevoAnyPaper was the gate that fired.
    const events = warnSpy.mock.calls
      .map((c) => c[0] as { event?: string; reason?: string } | undefined)
      .filter((e) => e?.event === 'canonical_root_walker_start_invalid');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.reason).toBe('js_is_pevo_any_paper');

    warnSpy.mockRestore();
  });

  it('rejects START with invalid cont_author/cont_permlink columns (cont_columns_invalid)', async () => {
    // Pins the cont_author / cont_permlink runtime narrowing branch in
    // findCanonicalRoot. The branch fires when HAF returns a row that
    // satisfies the SQL gate AND the JS isPevoAnyPaper re-check, but the
    // cont_author / cont_permlink columns are non-string (e.g. null).
    //
    // Setup: force-feed a row that LOOKS like a valid PEvO paper (alice /
    // valid pevoPaperJsonMeta) so the SQL filter and the JS isPevoAnyPaper
    // re-check both pass. cont_author / cont_permlink are null. The
    // narrowing branch must reject and emit `reason: 'cont_columns_invalid'`.
    //
    // The IS NOT NULL SQL guard normally prevents real HAF from returning
    // such a row, but the branch is real defense-in-depth. Mutation-kill:
    // remove the typeof guard → walker would proceed past the row → event
    // would not fire → assertion FAILS RED.
    //
    // Spy level: warn (cont_columns_invalid is a rare HAF data-integrity
    // surprise that warrants alerting).
    const aliceMeta = pevoPaperJsonMeta(['alice']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice']);

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v1') {
          // Force-feed a row past the SQL guard with non-string cont_*
          // columns so the JS-side narrowing branch fires.
          return {
            rows: [{
              author: 'alice',
              json_metadata: aliceRow.json_metadata,
              cont_author: null,
              cont_permlink: null,
            }],
          };
        }
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
      if (isForwardWalkContinuationProbe(sql)) {
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

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await request(app).get('/api/papers/alice/v1');
    // alice/v1 still resolves (the walker bails returning null, route falls
    // through to direct paper-detail fetch which succeeds).
    expect(res.status).toBe(200);

    const events = warnSpy.mock.calls
      .map((c) => c[0] as { event?: string; reason?: string } | undefined)
      .filter((e) => e?.event === 'canonical_root_walker_start_invalid');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.reason).toBe('cont_columns_invalid');

    warnSpy.mockRestore();
  });

  it('pins SQL IS NOT NULL guard on initial probe (no cont_columns_invalid on benign non-continuation lookup)', async () => {
    // Pins the `c.json_metadata -> $3 -> 'continues' IS NOT NULL` SQL
    // predicate on `findCanonicalRoot`'s initial probe. Without this guard,
    // every benign paper-detail lookup of a non-continuation paper would
    // pass the SQL `validPevoPaperWhere` filter (it IS a valid PEvO paper),
    // pass the JS `isPevoAnyPaper` re-check, and bail at the cont_author /
    // cont_permlink runtime narrowing branch — emitting
    // `canonical_root_walker_start_invalid` warn events with reason
    // `cont_columns_invalid` on every page load. The IS NOT NULL guard keeps
    // the walker scoped to actual continuation rows.
    //
    // Faithful-mock semantics — SQL-inspects the production initial probe
    // for the `IS NOT NULL` predicate:
    //   - HEAD (guard present): return 0 rows (mimicking real HAF excluding
    //     alice/v1, which has no continues field). Walker bails
    //     sql_filter_or_missing at debug → warn spy sees no
    //     cont_columns_invalid → assertion `events.toHaveLength(0)` holds.
    //     Route falls through to direct paper-detail fetch (200).
    //   - Mutation (drop the IS NOT NULL predicate): mock observes guard
    //     absent → returns alice/v1 row with cont_author=null,
    //     cont_permlink=null (the SQL projection ->>'author' against missing
    //     JSON keys yields NULL in real HAF). Walker passes SQL filter,
    //     passes JS isPevoAnyPaper, bails cont_columns_invalid at warn →
    //     warn spy captures the event → assertion FAILS RED.
    //
    // Note on status assertion: both HEAD and the mutation surface 200
    // (alice/v1 is served by direct paper-detail fall-through after the
    // walker returns null in both states). The discriminating signal is the
    // warn-event presence below, not the response code.
    //
    // BRITTLENESS CAVEAT: a future SQL-builder sweep that parametrizes the
    // `'continues'` literal (`$N` placeholder) would break the regex match →
    // mock would observe guard-absent on HEAD → returns the null-cont row →
    // canary FAILS RED on a refactor that did NOT regress security. False
    // alarm: the discriminator needs updating, the gate is intact. Do not
    // "fix" by relaxing the regex.
    const aliceMeta = pevoPaperJsonMeta(['alice']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice']);

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v1') {
          // Faithful-mock dispatch on the IS NOT NULL guard.
          if (/'continues'\s*IS\s+NOT\s+NULL/i.test(sql)) {
            // Guard present → real HAF would not return alice/v1 (no
            // continues field). Mock returns 0 rows.
            return { rows: [] };
          }
          // Guard absent (mutation) → real HAF returns the row with
          // null-projected cont_* columns. Mock returns same shape.
          return {
            rows: [{
              author: 'alice',
              json_metadata: aliceRow.json_metadata,
              cont_author: null,
              cont_permlink: null,
            }],
          };
        }
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
      if (isForwardWalkContinuationProbe(sql)) {
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

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await request(app).get('/api/papers/alice/v1');
    expect(res.status).toBe(200);

    const events = warnSpy.mock.calls
      .map((c) => c[0] as { event?: string; reason?: string } | undefined)
      .filter((e) =>
        e?.event === 'canonical_root_walker_start_invalid' &&
        e?.reason === 'cont_columns_invalid',
      );
    expect(events).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it('emits canonical_root_walker_no_pool when HAF pool is unavailable', async () => {
    // Pins the no-pool bail in findCanonicalRoot. beforeEach always wires a
    // valid pool; this canary explicitly nulls it for one request.
    //
    // HAF unavailability falls through to other paths (the route's other
    // walkers and the direct paper-detail fetch), so the response is not a
    // 5xx — it's an ordinary 404 from the rest of the lookup pipeline
    // failing to find anything without HAF.
    //
    // Mutation-kill: removing the LOG line itself fails this canary RED.
    //
    // Spy level: warn (no_pool is a rare infra-failure path worth alerting).
    getPoolMock.mockReturnValue(null);

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await request(app).get('/api/papers/alice/v1');
    // HAF down → other lookups fail → 404 (not 5xx). The contract is
    // "non-5xx"; we assert below 500 to be permissive about which
    // alternative path the route falls through to.
    expect(res.status).toBeLessThan(500);

    const events = warnSpy.mock.calls
      .map((c) => c[0] as { event?: string } | undefined)
      .filter((e) => e?.event === 'canonical_root_walker_no_pool');
    expect(events.length).toBeGreaterThan(0);

    warnSpy.mockRestore();
    // The pool mock is reset by `beforeEach` before the next test runs, so
    // restoring it here is not required for isolation. We re-wire it anyway
    // in case future additions to this it() body assert against a live pool
    // after the no-pool branch.
    getPoolMock.mockReturnValue({
      query: hafQueryMock,
      connect: async () => ({ query: hafQueryMock, release: () => {} }),
    });
  });

  it('outer walker catch emits structured event (canonical_root_walker_error) with start context', async () => {
    // The outer walker catch must emit `event: 'canonical_root_walker_error'`
    // with (startAuthor, startPermlink) so operators can distinguish
    // walker-errored from walker-completed. Without the event tag, the warn
    // is generic and ungrep-able.
    //
    // Mutation-kill: drop the event tag from the outer catch; this canary
    // fails red.
    installResponder(async (sql) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        // Throw to trigger the outer catch.
        throw new Error('simulated walker outer-catch');
      }
      return { rows: [] };
    });

    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/papers/alice/v1');
    expect(res.status).toBeGreaterThanOrEqual(200);

    const errorEvents = errSpy.mock.calls
      .map((c) => c[0] as { event?: string; startAuthor?: string; startPermlink?: string } | undefined)
      .filter((e) => e?.event === 'canonical_root_walker_error');
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0]?.startAuthor).toBe('alice');
    expect(errorEvents[0]?.startPermlink).toBe('v1');

    errSpy.mockRestore();
  });

  // ────────────────────────────────────────────────────────────────────
  // Bridge-paper Option-b backward cases
  // ────────────────────────────────────────────────────────────────────

  it('bridge-paper Option-b backward case: bridge_account/v2 → bridge_account/v1 admitted', async () => {
    // When bridge_account posts v2 of a bridge paper continuing
    // bridge_account/v1, the walker resolves to bridge_account/v1: the
    // backward walk reaches v1, and the forward verify admits the hop
    // because bridge_account is in the bridge-paper Option-b authorized set
    // ({bridgeAccount}).
    const bridgeAcc = config.hiveBridgeAccount;
    const bridgePaperV1Meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'bridge_paper',
        authors: [{ hive: null, name: 'preprint-author' }],
      },
    };
    const bridgeV1Row = {
      author: bridgeAcc,
      permlink: 'bridge-v1',
      title: 't',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: bridgePaperV1Meta,
      created: '2026-01-01T00:00:00.000Z',
      last_edited: '2026-01-01T00:00:00.000Z',
    };
    const bridgeV2Meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'bridge_paper',
        authors: [{ hive: null, name: 'preprint-author' }],
        continues: { author: bridgeAcc, permlink: 'bridge-v1' },
      },
    };

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === bridgeAcc && p === 'bridge-v2') {
          return {
            rows: [{ author: bridgeAcc, json_metadata: bridgeV2Meta, cont_author: bridgeAcc, cont_permlink: 'bridge-v1' }],
          };
        }
        if (a === bridgeAcc && p === 'bridge-v1') {
          return { rows: [] };
        }
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === bridgeAcc && p === 'bridge-v1') {
          return { rows: [{ author: bridgeAcc, json_metadata: bridgePaperV1Meta }] };
        }
        return { rows: [] };
      }
      // Forward verify from bridge/v1 admits bridge/v2 (bridge account is in
      // the Option-b set).
      if (isForwardWalkContinuationProbe(sql)) {
        if (params[0] === bridgeAcc && params[1] === 'bridge-v1') {
          return { rows: [{ author: bridgeAcc, permlink: 'bridge-v2', block_num: 200, json_metadata: bridgeV2Meta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        const a = params[0];
        const p = params[1];
        if (a === bridgeAcc && p === 'bridge-v1') return { rows: [bridgeV1Row] };
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/papers/${bridgeAcc}/bridge-v2`);
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    // Canonicalized to bridge_account/bridge-v1.
    expect(detail.author).toBe(bridgeAcc);
    expect(detail.permlink).toBe('bridge-v1');
  });

  it('bridge-paper Option-b backward case: attacker/v2 → bridge_account/v1 fail-CLOSED', async () => {
    // Bridge-paper authorized set is {bridgeAccount}, NOT pevo.authors[].hive.
    // So an outsider posting `attacker/v2` with continues={bridgeAcc, v1}
    // and pevo.type='paper' must NOT canonicalise to the bridge paper: the
    // backward walk reaches bridge/v1, but the forward verify from bridge/v1
    // only admits the bridge account, so attacker/v2 is not in the chain.
    // The membership check fail-CLOSES to attacker/v2 and emits
    // `canonical_root_walker_membership_failed`.
    const bridgeAcc = config.hiveBridgeAccount;
    const bridgePaperV1Meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'bridge_paper',
        authors: [{ hive: null, name: 'preprint-author' }],
      },
    };
    const attackerV2Meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'attacker' }],
        continues: { author: bridgeAcc, permlink: 'bridge-v1' },
      },
    };

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'attacker' && p === 'v2') {
          return {
            rows: [{ author: 'attacker', json_metadata: attackerV2Meta, cont_author: bridgeAcc, cont_permlink: 'bridge-v1' }],
          };
        }
        if (a === bridgeAcc && p === 'bridge-v1') {
          return { rows: [] };
        }
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === bridgeAcc && p === 'bridge-v1') {
          return { rows: [{ author: bridgeAcc, json_metadata: bridgePaperV1Meta }] };
        }
        return { rows: [] };
      }
      // Forward verify from bridge/v1: only the bridge account is admitted,
      // so attacker/v2 is excluded from the returned chain.
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        const a = params[0];
        if (a === 'attacker') {
          return {
            rows: [{
              author: 'attacker',
              permlink: 'v2',
              title: 't',
              body: 'attacker body',
              json_metadata: attackerV2Meta,
              created: '2026-01-01T00:00:00.000Z',
              last_edited: '2026-01-01T00:00:00.000Z',
            }],
          };
        }
        return { rows: [] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const res = await request(app).get('/api/papers/attacker/v2');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    // The walker fail-CLOSED: attacker is not in the bridge paper's Option-b
    // authorized set ({bridgeAccount}). URL stays at attacker/v2.
    expect(detail.author).toBe('attacker');
    expect(detail.permlink).toBe('v2');
    expect(detail.author).not.toBe(bridgeAcc);

    const events = warnSpy.mock.calls
      .map((c) => (c[0] as { event?: string } | undefined)?.event)
      .filter(Boolean);
    expect(events).toContain('canonical_root_walker_membership_failed');

    warnSpy.mockRestore();
  });

  // ────────────────────────────────────────────────────────────────────
  // Per-request memo canaries (fetchHeadAuthorizedAuthors result sharing)
  // ────────────────────────────────────────────────────────────────────

  it('memo threading: ?version=N path shares memo across forward verify + reconstructVersionsFromHaf', async () => {
    // The `?version=N` cache-miss branch calls `reconstructVersionsFromHaf`,
    // which itself forward-walks via `resolveContinuationChain` →
    // `fetchHeadAuthorizedAuthors`. Without memo threading, the canonical
    // walker's forward verify of alice/v1's head authors and the reconstruct
    // path's lookup of alice/v1 fire SEPARATELY — two queries instead of
    // one. With memo threading, the second hits the memo and does NOT
    // re-issue SQL.
    //
    // Mutation-kill: revert the memo-threading change (drop the memo
    // parameter from `reconstructVersionsFromHaf`'s call to
    // `resolveContinuationChain`) and the count rises to 2+.
    const aliceMeta = pevoPaperJsonMeta(['alice', 'bob']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice', 'bob']);
    const bobMeta = pevoPaperRow('bob', 'v2', ['bob'], { continues: { author: 'alice', permlink: 'v1' } }).json_metadata;

    let aliceHeadLookupCount = 0;

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'v2') {
          return { rows: [{ author: 'bob', json_metadata: bobMeta, cont_author: 'alice', cont_permlink: 'v1' }] };
        }
        if (a === 'alice' && p === 'v1') return { rows: [] };
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
      // Forward verify and reconstruct-path forward walk: no further
      // continuation past v1 in this fixture.
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
      // Paper detail fetch.
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v1') return { rows: [aliceRow] };
        return { rows: [] };
      }
      // The reconstruct-versions SQL: ROW_NUMBER + body-replay path.
      if (sql.includes('ROW_NUMBER()') && sql.includes('OVER (ORDER BY co.block_num)')) {
        return {
          rows: [
            {
              version_number: 1,
              block_num: 100,
              author: 'alice',
              permlink: 'v1',
              title: 't',
              body: 'abstract\n\n---\n\nbody',
              created: '2026-01-01T00:00:00.000Z',
              json_metadata: aliceRow.json_metadata,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/bob/v2?version=1');
    expect(res.status).toBe(200);
    // Memo threading: the forward verify fetches alice/v1 ONCE. The
    // reconstruct path inside the cache-miss branch shares the memo and does
    // NOT re-fetch.
    expect(aliceHeadLookupCount).toBe(1);
  });

  it('catch-block memo: HAF error during head-authors lookup memoizes null and is NOT re-fetched in same request', async () => {
    // When `fetchHeadAuthorizedAuthors` catches an exception, it must
    // memoize null before returning, so a single request's repeated lookups
    // of the same key do not re-fire the failing query under degraded HAF.
    //
    // Setup: URL = alice/v1 (no continues). Route flow:
    //   1. findCanonicalRoot(alice, v1) — alice/v1 has no continues, returns
    //      null. No head-authors lookup from the backward walk.
    //   2. fetchPaperDetailFromHaf(alice, v1, memo) → calls
    //      resolveContinuationChain(alice, v1, memo) →
    //      fetchHeadAuthorizedAuthors(alice, v1, memo). FIRST CALL. Mock
    //      throws → catch memoizes null → returns null.
    //   3. fetchPaperDetailFromHaf's SQL also returns no row (so returns
    //      null overall).
    //   4. Route falls through to reconstructVersionsFromHaf(alice, v1,
    //      undefined, memo) → calls resolveContinuationChain(alice, v1,
    //      memo) → fetchHeadAuthorizedAuthors(alice, v1, memo). SECOND CALL.
    //      With catch-memo: hits memoized null, no SQL. Without catch-memo:
    //      re-issues SQL, throws again.
    //
    // Mutation-kill: remove `memo?.set(key, null)` from the catch block;
    // count rises 1 → 2.
    let aliceHeadLookupCount = 0;

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v1') {
          aliceHeadLookupCount += 1;
          // Always throw — without catch-memo, every call re-fires. With
          // catch-memo, only the first call sees the throw; the second hits
          // the memoized null.
          throw new Error('simulated HAF degraded');
        }
        return { rows: [] };
      }
      // fetchPaperDetailFromHaf SQL: no row for alice/v1 (so returns null
      // and route falls through to reconstructVersionsFromHaf).
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [] };
      }
      // Forward chain-walk SQL: nothing to admit.
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
      // Reconstruct-versions SQL: empty.
      if (sql.includes('ROW_NUMBER()') && sql.includes('OVER (ORDER BY co.block_num)')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/papers/alice/v1');
    expect(res.status).toBeGreaterThanOrEqual(200);

    // First call threw → catch memoizes null. The reconstructVersionsFromHaf
    // fallback's resolveContinuationChain hits the memo and does NOT re-fire
    // SQL. Count stays at 1. Mutation-kill: drop memo?.set in the catch
    // block; count rises to 2 (re-throw on second call).
    expect(aliceHeadLookupCount).toBe(1);

    errSpy.mockRestore();
  });

  it('negative-cache memo: no-rows early-return memoizes null and is NOT re-fetched in same request', async () => {
    // `fetchHeadAuthorizedAuthors` memoizes null at its no-rows early-return
    // (a missing head row), not only on success or in the catch block. Pin
    // that contract with the same dual-consumer dedup shape the catch-block
    // memo canary uses, so the count is a real 1-vs-2 mutation-kill rather
    // than a single unconditional lookup.
    //
    // Setup: URL = alice/v1 (no continues). Route flow:
    //   1. findCanonicalRoot(alice, v1) — alice/v1 has no continues, returns
    //      null. No head-authors lookup from the backward walk.
    //   2. fetchPaperDetailFromHaf(alice, v1, memo) →
    //      resolveContinuationChain(alice, v1, memo) →
    //      fetchHeadAuthorizedAuthors(alice, v1, memo). FIRST CALL. Mock
    //      returns no rows → no-rows early-return memoizes null → returns
    //      null.
    //   3. fetchPaperDetailFromHaf's own SQL also returns no row, so it
    //      returns null and the route falls through to
    //      reconstructVersionsFromHaf.
    //   4. reconstructVersionsFromHaf(alice, v1, undefined, memo) →
    //      resolveContinuationChain(alice, v1, memo) →
    //      fetchHeadAuthorizedAuthors(alice, v1, memo). SECOND CALL. With the
    //      no-rows memoize-null: hits the memo, no SQL. Without it: re-issues
    //      the no-rows query.
    //
    // Mutation-kill: remove `memo?.set(key, null)` from the no-rows
    // early-return; count rises 1 → 2.
    let aliceHeadLookupCount = 0;

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v1') {
          aliceHeadLookupCount += 1;
          // No rows → fetchHeadAuthorizedAuthors hits the no-rows
          // early-return and memoizes null.
          return { rows: [] };
        }
        return { rows: [] };
      }
      // fetchPaperDetailFromHaf SQL: no row for alice/v1 (so it returns null
      // and the route falls through to reconstructVersionsFromHaf).
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [] };
      }
      // Forward chain-walk SQL: nothing to admit.
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
      // Reconstruct-versions SQL: empty.
      if (sql.includes('ROW_NUMBER()') && sql.includes('OVER (ORDER BY co.block_num)')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/v1');
    expect(res.status).toBeGreaterThanOrEqual(200);

    // First lookup returned no rows → memoized null. The
    // reconstructVersionsFromHaf fallback's resolveContinuationChain hits the
    // memo and does NOT re-fire SQL. Count stays at 1. Mutation-kill: drop
    // memo?.set in the no-rows early-return; count rises to 2.
    expect(aliceHeadLookupCount).toBe(1);
  });

  it('memo threading: /enrichment shares memo across resolveVersionsFromHaf forward-walk', async () => {
    // `resolveVersionsFromHaf` (the `/enrichment` call site of
    // `reconstructVersionsFromHaf`) participates in the per-request memo via
    // a threaded `memo?` parameter, so the head-authors lookup for the chain
    // root fires once across the /enrichment request.
    //
    // Setup: hit /enrichment for alice/v1. The route flow constructs a
    // headAuthorsMemo at the top of `fetchEnrichmentFromHaf`, threads it into
    // resolveVersionsFromHaf → reconstructVersionsFromHaf →
    // resolveContinuationChain → fetchHeadAuthorizedAuthors. Count = 1.
    //
    // /enrichment has only one consumer of fetchHeadAuthorizedAuthors today,
    // so a strict count 1→2 mutation-kill is not observable in /enrichment
    // alone (the dual-consumer dedup mutation-kill is covered by the
    // `?version=N` and catch-block memo canaries above). This canary pins
    // (a) the integration path stays wired (fetchEnrichmentFromHaf →
    // resolveVersionsFromHaf → reconstructVersionsFromHaf → memo all the way
    // down), and (b) any future second consumer added to
    // fetchEnrichmentFromHaf that looks up the root's authors will share the
    // memo and not double-fetch.
    const aliceMeta = pevoPaperJsonMeta(['alice']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice']);

    let aliceHeadLookupCount = 0;

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
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
      // Forward chain-walk SQL: alice/v1 has no continuation in this fixture.
      if (isForwardWalkContinuationProbe(sql)) {
        return { rows: [] };
      }
      // Reconstruct-versions ROW_NUMBER SQL: a single row for alice/v1.
      if (sql.includes('ROW_NUMBER()') && sql.includes('OVER (ORDER BY co.block_num)')) {
        return {
          rows: [
            {
              version_number: 1,
              block_num: 100,
              author: 'alice',
              permlink: 'v1',
              title: 't',
              body: 'abstract\n\n---\n\nbody',
              created: '2026-01-01T00:00:00.000Z',
              json_metadata: aliceRow.json_metadata,
            },
          ],
        };
      }
      // Enrichment-specific queries (votes, reviews, claims): empty.
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/v1/enrichment');
    expect(res.status).toBe(200);
    // resolveVersionsFromHaf participates in the per-request memo via the
    // threaded `memo?` parameter. The single forward-walker lookup of
    // alice/v1's authors fires once.
    expect(aliceHeadLookupCount).toBe(1);
  });
});
