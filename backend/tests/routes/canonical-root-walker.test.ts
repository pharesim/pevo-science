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

/**
 * Discriminate the initial backward-walker probe (which carries the
 * `c.json_metadata -> $3 -> 'continues' IS NOT NULL` predicate AND the
 * START-row identity columns `c.author, c.json_metadata`) from the
 * subsequent loop-continuation probe (which only selects cont_author /
 * cont_permlink).
 *
 * Detection key: the `IS NOT NULL` predicate is a stable structural
 * marker tied to the domain logic of the initial probe ("only return
 * rows that actually have a continues pointer"). Earlier iterations of
 * this file used a column-list regex (`c.author,\s+c.json_metadata,\s+
 * c.json_metadata`) which was brittle to whitespace tweaks and coupled
 * the test dispatch to incidental SQL formatting. The IS NOT NULL
 * predicate is what semantically defines "initial probe", so pin to it.
 */
function isInitialBackwardProbe(sql: string): boolean {
  return /'continues'\s*IS\s+NOT\s+NULL/i.test(sql);
}

/** Recognise the head authorized-authors lookup
 *  (`fetchHeadAuthorizedAuthors`'s SQL). */
function isHeadAuthorsLookup(sql: string): boolean {
  return /SELECT\s+c\.author,\s+c\.json_metadata/.test(sql)
    && /parent_permlink\s*=\s*\$3/.test(sql)
    && !/AS\s+cont_author/.test(sql);
}

/**
 * Per-test mock-config primitive for type-spoof START tests.
 *
 * `startProbeMode` selects how the responder behaves for the spoof
 * START row:
 *
 *   - `'with_filter'`: faithful-mock mode. The responder SQL-inspects
 *     the production initial probe and mirrors what real HAF would
 *     return: zero rows when the `validPevoPaperWhere` filter is
 *     present (HEAD), or the spoof row when the filter has been
 *     reverted (mutation). This mode is what makes the SQL-filter
 *     canary fail red on a SQL-filter mutation: the mock observes
 *     filter-absent and returns the spoof row, so the walker bails at
 *     the JS-side check with `reason: 'js_is_pevo_any_paper'` instead
 *     of the asserted `reason: 'sql_filter_or_missing'`.
 *
 *   - `'without_filter'`: force-feed mode. The responder ALWAYS
 *     returns the spoof row, regardless of production SQL state. This
 *     isolates the JS-side `isPevoAnyPaper` check as the gate under
 *     test. On HEAD the JS check fires; on JS-check revert the walker
 *     proceeds past the spoof row and the canary fails red.
 *
 * The two layers are kept SEPARATE in two distinct tests so a mutation
 * to either layer (drop SQL filter; or drop JS re-check) fails red on
 * exactly one canary while the other stays green. The earlier combined-
 * layer canary inspected SQL with a regex inside the responder and
 * conflated the two layers; the per-canary `mode` flag here lets each
 * test pin a single layer cleanly.
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
          // The round-2 START gate adds c.author + c.json_metadata to the
          // initial probe so the JS-side isPevoAnyPaper re-check can run.
          return {
            rows: [{
              author: 'attacker',
              json_metadata: attackerRow.json_metadata,
              cont_author: 'alice',
              cont_permlink: 'paper-v1',
            }],
          };
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
        // Initial probe (round-2 SQL: carries `IS NOT NULL` predicate)
        // returns the start-row fields. Subsequent loop-continuation probes
        // return only cont_author / cont_permlink.
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
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v2') {
          return {
            rows: [{
              author: 'alice',
              json_metadata: pevoPaperRow('alice', 'v2', ['alice'], { continues: { author: 'alice', permlink: 'v1' } }).json_metadata,
              cont_author: 'alice',
              cont_permlink: 'v1',
            }],
          };
        }
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
        if (a === 'bob' && p === 'v2') {
          return {
            rows: [{
              author: 'bob',
              json_metadata: pevoPaperRow('bob', 'v2', ['bob'], { continues: { author: 'alice', permlink: 'v1' } }).json_metadata,
              cont_author: 'alice',
              cont_permlink: 'v1',
            }],
          };
        }
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
        if (a === 'bob' && p === 'v2') return { rows: [{ author: 'bob', json_metadata: pevoPaperRow('bob', 'v2', ['bob'], { continues: { author: 'alice', permlink: 'v1' } }).json_metadata, cont_author: 'alice', cont_permlink: 'v1' }] };
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

  // ────────────────────────────────────────────────────────────────────
  // Round-2 hold-block additions
  // ────────────────────────────────────────────────────────────────────

  /**
   * Detect whether the production initial-probe SQL carries the
   * `validPevoPaperWhere` predicate (the SQL-side type filter). Used by
   * the layer-pinning responder below to FAITHFULLY simulate what real
   * HAF would return for the spoof START: if the SQL filter is present,
   * a `pevo.type='review'` row is rejected at the SQL layer and the
   * mock returns zero rows; if the SQL filter has been reverted, the
   * row comes through and the JS-side `isPevoAnyPaper` re-check is the
   * only remaining gate.
   *
   * Detection key: the `'type'` literal appears in `validPevoPaperWhere`
   * (`(c.json_metadata -> $3 ->> 'type') = 'paper'`) but does NOT appear
   * elsewhere in the initial probe (the SELECT/WHERE that fetches the
   * cont_author/cont_permlink values references `'continues'`, not
   * `'type'`). So `'type'` in the SQL string is a tight, drift-resistant
   * marker for filter presence on this specific probe.
   */
  function probeSqlHasTypeFilter(sql: string): boolean {
    return /'type'/.test(sql);
  }

  /**
   * Shared spoof-START responder. SQL-inspects the initial probe to
   * decide whether to return zero rows (SQL filter would have rejected
   * the spoof) or the spoof row (SQL filter absent → JS check must be
   * the gate). This makes the mock FAITHFUL: when production reverts
   * the SQL filter, the mock observes the absence and returns the spoof
   * row, exercising the JS path; when production has the SQL filter,
   * the mock returns zero rows and the SQL path fires.
   *
   * The two canaries below share this responder but assert DIFFERENT
   * `reason` events:
   *
   *   - SQL canary asserts `reason: 'sql_filter_or_missing'`. On main
   *     (SQL filter present) the mock returns zero rows → walker emits
   *     that reason → assertion holds. Mutation-kill: revert SQL filter
   *     in papers.ts → mock now observes filter-absent and returns
   *     spoof row → walker emits `js_is_pevo_any_paper` instead → SQL
   *     canary FAILS RED.
   *   - JS canary asserts `reason: 'js_is_pevo_any_paper'`. On main
   *     (SQL filter present) the SQL layer is the gate, so the mock
   *     returns zero rows and the walker emits `sql_filter_or_missing`,
   *     which means the JS canary cannot pass on green main with the
   *     same responder. So the JS canary uses `mode: 'without_filter'`
   *     to FORCE the responder to return the spoof row regardless of
   *     production SQL state — letting the JS check be the observed
   *     gate. Mutation-kill: drop the `!isPevoAnyPaper(...)` check in
   *     papers.ts → walker doesn't reject the spoof START → no
   *     `js_is_pevo_any_paper` event → JS canary FAILS RED. On SQL-
   *     filter revert (orthogonal mutation): mock still forces spoof
   *     row → JS check still fires → JS canary stays GREEN.
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
            // - Production SQL has had the filter reverted → row passes
            //   the SQL layer → mock returns the spoof row.
            // This makes the SQL-canary fail red on SQL-filter revert:
            // walker emits `js_is_pevo_any_paper` instead of expected
            // `sql_filter_or_missing`.
            if (probeSqlHasTypeFilter(sql)) {
              return { rows: [] };
            }
            return { rows: [spoofRow] };
          }
          // 'without_filter': force-feed the spoof row regardless of
          // production SQL state. This isolates the JS-side
          // `isPevoAnyPaper` check as the gate under test. Mutation-
          // kill on the JS check: walker doesn't reject → no
          // `js_is_pevo_any_paper` event → JS canary fails.
          return { rows: [spoofRow] };
        }
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
      // Paper detail fetch. With the gate present (either layer), the
      // walker rejects the START, no canonicalisation; bob/spoof-review's
      // own detail SQL (which itself runs validPevoPaperWhere) returns no
      // row → 404. alice/v1's row is wired up so a mutation that surfaces
      // the gate failure (walker proceeds → canonicalises to alice/v1)
      // results in 200 with alice's content under bob's URL, exactly the
      // failure mode the gate prevents.
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
    // present (HEAD), the mock returns zero rows; when reverted, it
    // returns the spoof row.
    //
    // On HEAD: SQL filter present → mock returns 0 rows → walker bails
    // at `result.rows.length === 0` and emits
    // `reason: 'sql_filter_or_missing'`. Test passes.
    //
    // Mutation-kill: revert the SQL filter (drop the
    // `validPevoPaperWhere(...)` predicate from the initial probe's
    // WHERE clause) → the mock observes filter-absent and returns the
    // spoof row → walker reaches the JS-side `!isPevoAnyPaper(...)`
    // check, bails there with `reason: 'js_is_pevo_any_paper'` →
    // assertion `reason === 'sql_filter_or_missing'` fails RED.
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
    // re-check. The mock force-feeds the spoof row regardless of
    // production SQL state (mode `'without_filter'`), so the JS
    // `isPevoAnyPaper` check is the ONLY observed gate. The walker
    // bails at the `!isPevoAnyPaper(startMeta, startRow.author)` branch.
    //
    // On HEAD: mock returns spoof row → walker reaches the JS check →
    // emits `reason: 'js_is_pevo_any_paper'`. Test passes.
    //
    // Mutation-kill: drop the JS re-check
    // (`if (typeof startRow.author !== 'string' || !isPevoAnyPaper(...))`)
    // → walker proceeds past the spoof row → canonicalises to alice/v1
    // → no `js_is_pevo_any_paper` event → assertion FAILS RED. The
    // surfaced URL would also show alice's content (status 200,
    // detail.author === 'alice') — the exact phishing pretext the gate
    // prevents.
    //
    // Orthogonal-mutation green: revert ONLY the SQL filter (NOT the
    // JS check) → mock still force-feeds spoof row → JS check still
    // fires → event still emits → JS canary stays GREEN.
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    installTypeSpoofStartResponder('without_filter');

    const res = await request(app).get('/api/papers/bob/spoof-review');
    expect(res.status).toBe(404);

    // Pin the kill reason: JS isPevoAnyPaper was the gate that fired.
    const events = debugSpy.mock.calls
      .map((c) => c[0] as { event?: string; reason?: string } | undefined)
      .filter((e) => e?.event === 'canonical_root_walker_start_invalid');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.reason).toBe('js_is_pevo_any_paper');

    debugSpy.mockRestore();
  });

  it('rejects type-spoof at intermediate hop (chain bob/v3 → bob/v2 [type=review] → alice/v1)', async () => {
    // Round-2 hold item 2: chain bob/v3 (paper, continues bob/v2) →
    // bob/v2 (review, continues alice/v1) → alice/v1 (paper). bob is
    // vouched in alice's authors. Expected: walker stops at the bob/v2
    // hop (type-spoof) and returns bob/v3 as canonical, NOT alice/v1.
    //
    // Strategy here: the gate's hop-validation depends on
    // fetchHeadAuthorizedAuthors, which itself uses isPevoAnyPaper to
    // narrow predecessors. bob/v2 with type='review' fails isPevoAnyPaper
    // (line 865) → fetchHeadAuthorizedAuthors returns null → the walker
    // rejects the hop at the unauthorized-hop gate (line 1093).
    const aliceMeta = pevoPaperJsonMeta(['alice', 'bob']);
    const bobV2Meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'review',
        continues: { author: 'alice', permlink: 'v1' },
      },
    };
    const bobV3Row = pevoPaperRow('bob', 'v3', ['bob'], { continues: { author: 'bob', permlink: 'v2' } });

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'v3') {
          return {
            rows: [{ author: 'bob', json_metadata: bobV3Row.json_metadata, cont_author: 'bob', cont_permlink: 'v2' }],
          };
        }
        if (a === 'bob' && p === 'v2') {
          return { rows: [{ cont_author: 'alice', cont_permlink: 'v1' }] };
        }
        if (a === 'alice' && p === 'v1') {
          return { rows: [{ cont_author: null, cont_permlink: null }] };
        }
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'v2') {
          // bob/v2 is type=review; isPevoAnyPaper rejects it → returns null.
          return { rows: [{ author: 'bob', json_metadata: bobV2Meta }] };
        }
        if (a === 'alice' && p === 'v1') {
          return { rows: [{ author: 'alice', json_metadata: aliceMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'v3') return { rows: [bobV3Row] };
        return { rows: [] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const res = await request(app).get('/api/papers/bob/v3');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    // Walker stopped at the bob/v2 type-spoof hop. Returns bob/v3 as
    // canonical (the URL post stays the URL post; alice's content is NOT
    // surfaced).
    expect(detail.author).toBe('bob');
    expect(detail.permlink).toBe('v3');
    expect(detail.author).not.toBe('alice');

    // Walker emitted unauthorized-hop with hopNumber set (round-2 item 6).
    const hopEvents = warnSpy.mock.calls
      .map((c) => c[0] as { event?: string; hopNumber?: number } | undefined)
      .filter((e) => e?.event === 'canonical_root_walker_unauthorized_hop');
    expect(hopEvents.length).toBeGreaterThan(0);
    expect(hopEvents[0]?.hopNumber).toBe(1);

    warnSpy.mockRestore();
  });

  it('admits legitimate paper continuation (no type-spoof): bob (vouched) posts type=paper continuation', async () => {
    // Regression coverage for the gate's positive case: bob (vouched in
    // alice's authors) posts bob/v2 with pevo.type='paper' and
    // continues={alice, v1}. Walker walks back, returns alice/v1 as
    // canonical. This is the legitimate co-author continuation flow that
    // the type-spoof gate must not break.
    const aliceMeta = pevoPaperJsonMeta(['alice', 'bob']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice', 'bob']);
    const bobV2Meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'bob' }],
        continues: { author: 'alice', permlink: 'v1' },
      },
    };

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'v2') {
          return {
            rows: [{ author: 'bob', json_metadata: bobV2Meta, cont_author: 'alice', cont_permlink: 'v1' }],
          };
        }
        if (a === 'alice' && p === 'v1') {
          return { rows: [{ cont_author: null, cont_permlink: null }] };
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

  it('memo threading: ?version=N path shares memo across backward walker + reconstructVersionsFromHaf', async () => {
    // Round-2 hold item 3 (P2): the `?version=N` cache-miss branch (route
    // handler line 1439) calls `reconstructVersionsFromHaf`, which itself
    // forward-walks via `resolveContinuationChain` → `fetchHeadAuthorizedAuthors`.
    // Without memo threading, the canonical-walker's lookup of alice/v1's
    // head authors and the reconstruct path's lookup of alice/v1 fire
    // SEPARATELY — two queries instead of one. With memo threading, the
    // second hits the memo and does NOT re-issue SQL.
    //
    // Mutation-kill: revert the memo-threading change (drop the memo
    // parameter from `reconstructVersionsFromHaf`'s call to
    // `resolveContinuationChain`) and the count rises to 2+.
    const aliceMeta = pevoPaperJsonMeta(['alice', 'bob']);
    const aliceRow = pevoPaperRow('alice', 'v1', ['alice', 'bob']);

    let aliceHeadLookupCount = 0;

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'v2') {
          const bobMeta = pevoPaperRow('bob', 'v2', ['bob'], { continues: { author: 'alice', permlink: 'v1' } }).json_metadata;
          return { rows: [{ author: 'bob', json_metadata: bobMeta, cont_author: 'alice', cont_permlink: 'v1' }] };
        }
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
      // Paper detail fetch (this path takes the ?version=N branch which
      // doesn't hit fetchPaperDetailFromHaf — it goes through
      // reconstructVersionsFromHaf directly).
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
      // Forward chain-walk SQL (continues-pointer equality).
      if (/'continues'\s*->>\s*'author'\s*=\s*\$1/.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/bob/v2?version=1');
    expect(res.status).toBe(200);
    // Memo threading: backward walker fetches alice/v1 ONCE. The
    // reconstruct path inside the cache-miss branch shares the memo and
    // does NOT re-fetch.
    expect(aliceHeadLookupCount).toBe(1);
  });

  it('catch-block memo: HAF error during head-authors lookup memoizes null and is NOT re-fetched in same request', async () => {
    // Round-2 hold item 4 (P2): when `fetchHeadAuthorizedAuthors` catches
    // an exception, it must memoize null before returning. The
    // documented contract on lines 826-827 says "Both null and Set
    // results are cached"; the catch path was the gap.
    //
    // Setup: URL = alice/v1 (no continues). Route flow:
    //   1. findCanonicalRoot(alice, v1) — alice/v1 has no continues,
    //      returns null. No head-authors lookup.
    //   2. fetchPaperDetailFromHaf(alice, v1, memo) → calls
    //      resolveContinuationChain(alice, v1, memo) →
    //      fetchHeadAuthorizedAuthors(alice, v1, memo). FIRST CALL.
    //      Mock throws → catch memoizes null → returns null.
    //   3. fetchPaperDetailFromHaf's SQL also returns no row (so
    //      returns null overall).
    //   4. Route falls through to reconstructVersionsFromHaf(alice, v1,
    //      undefined, memo) → calls resolveContinuationChain(alice, v1,
    //      memo) → fetchHeadAuthorizedAuthors(alice, v1, memo). SECOND
    //      CALL. With catch-memo: hits memoized null, no SQL. Without
    //      catch-memo: re-issues SQL, throws again.
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
          // Always throw — without catch-memo, every call re-fires.
          // With catch-memo, only the first call sees the throw; the
          // second hits the memoized null.
          throw new Error('simulated HAF degraded');
        }
        return { rows: [] };
      }
      // fetchPaperDetailFromHaf SQL: no row for alice/v1 (so returns
      // null and route falls through to reconstructVersionsFromHaf).
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [] };
      }
      // Forward chain-walk SQL: nothing to admit.
      if (/'continues'\s*->>\s*'author'\s*=\s*\$1/.test(sql)) {
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
    // fallback's resolveContinuationChain hits the memo and does NOT
    // re-fire SQL. Count stays at 1. Mutation-kill: drop memo?.set in
    // the catch block; count rises to 2 (re-throw on second call).
    expect(aliceHeadLookupCount).toBe(1);

    errSpy.mockRestore();
  });

  it('outer walker catch emits structured event (canonical_root_walker_error) with start context', async () => {
    // Round-2 hold item 5 (P2 observability): the outer walker catch
    // must emit `event: 'canonical_root_walker_error'` with
    // (startAuthor, startPermlink) so operators can distinguish
    // walker-errored from walker-completed. Without the event tag,
    // the warn is generic and ungrep-able.
    //
    // Mutation-kill: drop the event tag from the outer catch; this
    // canary fails red.
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

  it('depth-cap warn carries maxHops field (round-3 item 2: dropped duplicate hopNumber)', async () => {
    // Round-2 hold item 6 (P3 observability) added `hopNumber: i + 1` to both
    // `unauthorized_hop` and `depth_exceeded` warns for cross-event taxonomy
    // consistency. Round-3 hold item 2 (P3 maintainability) noted that on
    // `depth_exceeded` the two fields (`hopNumber` and `maxHops`) are the
    // same constant by construction — `hopNumber` was dropped from this
    // event only. `maxHops` documents the cap; the event name itself
    // signals "we hit the cap". `hopNumber` retains its meaningful
    // varying-value role on `unauthorized_hop` (asserted in the
    // type-spoof-intermediate canary above).
    //
    // Mutation-kill: drop the `maxHops` field; this canary fails.
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
        // Initial probe shape (carries `IS NOT NULL` predicate): include
        // the start-row fields. Subsequent probe shape: just cont_author /
        // cont_permlink.
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
    const res = await request(app).get(`/api/papers/alice/v${N}`);
    expect(res.status).toBe(200);

    const depthEvents = warnSpy.mock.calls
      .map((c) => c[0] as { event?: string; maxHops?: number; hopNumber?: number } | undefined)
      .filter((e) => e?.event === 'canonical_root_walker_depth_exceeded');
    expect(depthEvents.length).toBeGreaterThan(0);
    // maxHops = CANONICAL_ROOT_MAX_HOPS (10).
    expect(depthEvents[0]?.maxHops).toBe(10);
    // Round-3 item 2: hopNumber explicitly dropped from depth_exceeded.
    expect(depthEvents[0]?.hopNumber).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('bridge-paper Option-b backward case: bridge_account/v2 → bridge_account/v1 admitted', async () => {
    // The bridge-paper branch in `extractAuthorizedContinuationAuthors`
    // is currently exercised only by forward-walker canaries. Cover the
    // backward walker too: when bridge_account posts v2 of a bridge
    // paper continuing bridge_account/v1, the walker admits the hop
    // because bridge_account is in the bridge-paper Option-b authorized
    // set ({bridgeAccount}).
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
          return { rows: [{ cont_author: null, cont_permlink: null }] };
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

  it('bridge-paper Option-b backward case: attacker/v2 → bridge_account/v1 REJECTED', async () => {
    // Bridge-paper authorized set is {bridgeAccount}, NOT pevo.authors[].hive.
    // So an outsider posting `attacker/v2` with continues={bridgeAcc, v1}
    // and pevo.type='paper' must be rejected: attacker is not in the
    // bridge paper's Option-b set.
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
          return { rows: [{ cont_author: null, cont_permlink: null }] };
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
    // The walker REJECTED the hop: attacker is not in the bridge paper's
    // Option-b authorized set ({bridgeAccount}). URL stays at attacker/v2.
    expect(detail.author).toBe('attacker');
    expect(detail.permlink).toBe('v2');
    expect(detail.author).not.toBe(bridgeAcc);

    const events = warnSpy.mock.calls
      .map((c) => (c[0] as { event?: string } | undefined)?.event)
      .filter(Boolean);
    expect(events).toContain('canonical_root_walker_unauthorized_hop');

    warnSpy.mockRestore();
  });

  it('negative-cache memo: early-return null paths (no row / non-string author / non-paper type) are memoized', async () => {
    // Round-2 hold item 4 cross-cutting: the documented contract on
    // lines 826-827 of papers.ts says "Both null and Set results are
    // cached". The implementation memoizes null at four sites:
    //   - line 852 (no rows)
    //   - line 861 (non-string author)
    //   - line 866 (non-PEvO paper)
    //   - the catch block (round-2 item 4)
    // Pin the contract at the early-return paths: a missing-row lookup
    // memoizes null; a second within-request lookup hits the memo and
    // does NOT re-fire SQL.
    //
    // Strategy: trigger a backward-walker call that fetches alice/v1's
    // head-authors twice. First fetch returns no rows → memoizes null.
    // The forward walker shares the memo via the route handler's
    // memoizes; so the second within-request lookup must hit the memo.
    let aliceHeadLookupCount = 0;
    const bobV2Meta = pevoPaperRow('bob', 'v2', ['bob'], { continues: { author: 'alice', permlink: 'v1' } }).json_metadata;

    installResponder(async (sql, params) => {
      if (isBackwardWalkContinuesProbe(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'bob' && p === 'v2') {
          return { rows: [{ author: 'bob', json_metadata: bobV2Meta, cont_author: 'alice', cont_permlink: 'v1' }] };
        }
        return { rows: [] };
      }
      if (isHeadAuthorsLookup(sql)) {
        const a = params[0];
        const p = params[1];
        if (a === 'alice' && p === 'v1') {
          aliceHeadLookupCount += 1;
          // No rows → fetchHeadAuthorizedAuthors hits the no-rows
          // early-return at line 852 and memoizes null.
          return { rows: [] };
        }
        return { rows: [] };
      }
      // No paper detail row for alice/v1 (since it doesn't exist), so
      // bob/v2 detail fetch returns nothing meaningful — the request
      // ends in 404. What matters is the lookup count.
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/bob/v2');
    expect(res.status).toBeGreaterThanOrEqual(200);

    // The walker fetched alice/v1 once (initial backward-walk
    // unauthorized-hop check). The forward walker via
    // fetchPaperDetailFromHaf shares the same memo and does NOT
    // re-fetch alice/v1's missing row.
    expect(aliceHeadLookupCount).toBe(1);
  });

  it('memo threading: /enrichment shares memo across resolveVersionsFromHaf forward-walk (round-3 item 1)', async () => {
    // Round-3 hold item 1 (P2): `resolveVersionsFromHaf` is the third
    // call site of `reconstructVersionsFromHaf`; round-2 threaded memo
    // through the `?version=N` and metadata-restored fallback call
    // sites in GET /:author/:permlink but missed this one in
    // `fetchEnrichmentFromHaf`. Round-3 closes that gap by adding a
    // `memo?: HeadAuthorsMemo` parameter to `resolveVersionsFromHaf`,
    // constructing a memo at the top of `fetchEnrichmentFromHaf`, and
    // threading it into both the inner `reconstructVersionsFromHaf`
    // and downstream `resolveContinuationChain` →
    // `fetchHeadAuthorizedAuthors` lookups.
    //
    // Setup: hit /enrichment for alice/v1 with a forward chain
    // alice/v1 → alice/v2. The route flow:
    //   1. fetchEnrichmentFromHaf(alice, v1) constructs headAuthorsMemo.
    //   2. resolveVersionsFromHaf(alice, v1, memo) →
    //      reconstructVersionsFromHaf(alice, v1, undefined, memo) →
    //      resolveContinuationChain(alice, v1, memo) →
    //      fetchHeadAuthorizedAuthors(pool, alice, v1, memo). Count = 1.
    //
    // Mutation-kill semantics: this canary asserts the head-authors
    // lookup count for alice/v1 is exactly 1 across the /enrichment
    // request. The dual-consumer dedup mutation-kill (count 1→2 on
    // memo-arg revert) is covered by the existing `?version=N` and
    // catch-block memo canaries in this file (lines 648 and 726),
    // which exercise scenarios where two consumers within one request
    // share the memo. /enrichment has only one consumer of
    // fetchHeadAuthorizedAuthors today (resolveVersionsFromHaf via
    // reconstructVersionsFromHaf via resolveContinuationChain), so
    // strict count 1→2 mutation-kill is not observable in /enrichment
    // alone. This canary instead pins (a) the integration path stays
    // wired (fetchEnrichmentFromHaf → resolveVersionsFromHaf →
    // reconstructVersionsFromHaf → memo all the way down), and (b)
    // any future second consumer added to fetchEnrichmentFromHaf that
    // looks up alice/v1's authors will share the memo and not double-
    // fetch — covered by the existing `?version=N` canary's mutation-
    // kill on the broader contract.
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
      if (/'continues'\s*->>\s*'author'\s*=\s*\$1/.test(sql)) {
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
    // resolveVersionsFromHaf participates in the per-request memo via
    // the new `memo?` parameter (round-3 item 1). The single forward-
    // walker lookup of alice/v1's authors fires once.
    expect(aliceHeadLookupCount).toBe(1);
  });
});
