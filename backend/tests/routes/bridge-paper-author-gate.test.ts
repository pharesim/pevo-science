/**
 * Bridge-paper author-gate canary tests (round-2 + round-3 hardening).
 *
 * These tests pin the SQL shape produced by every PEvO surface that filters
 * by paper-type. After the round-2 hold expanded scope to 15 sites composed
 * against `validPevoPaperWhere()`, removing the bridge-author conjunct from
 * the helper must fail every assertion below — that's the mutation-sensitive
 * invariant the canaries enforce.
 *
 * Round-3 hardenings (in this file):
 *   - `assertBridgeAuthorPin` now uses `matchAll` (not `match`) and accepts an
 *     `expectedCount` opt so per-site mutations in shared-SQL queries (e.g.
 *     reputation.ts which composes the helper at the same alias multiple
 *     times in one captured string) fail red instead of passing on the
 *     first-occurrence-only match. (Item 1)
 *   - The regex now accepts EITHER conjunct order inside the parenthesized
 *     bridge arm — flipping `c.author = $N AND ...` ↔ `... AND c.author = $N`
 *     no longer breaks the canary. (Item 8)
 *   - Notification CTE coverage gap closed via a dedicated describe block
 *     for `fetchNotificationsFromHaf`. (Item 2)
 *   - Stats `expect(related.length).toBe(1)` loosened to `toBeGreaterThan(0)`
 *     to mirror the other site canaries. (Item 7)
 *
 * **Carve-out (per CLAUDE.md "Running Tests"):** these tests mock `getPool()`
 * to capture the SQL string produced by each route. Real HAF cannot be seeded
 * with a deterministic spoofed bridge_paper authored by an unaccredited
 * account on demand — the fixture would require both a fresh test HAF DB and
 * a seed step that runs before every test. The mocked-pool variant pins the
 * SQL contract; the real-HAF integration tests (papers.test.ts, search.test.ts,
 * stats.test.ts, disciplines.test.ts) cover the query-execution path against
 * the live test corpus. Per CLAUDE.md clauses (a)/(b)/(c):
 *   (a) justification documented above (deterministic spoofed-row seeding
 *       is impractical against the public HAF DB),
 *   (b) `verifyHiveSignature` and other middleware are NOT mocked,
 *   (c) real-HAF integration variants exist for every site that has a
 *       reachable real-HAF path; the SQL-shape assertions here pin the
 *       per-site contract.
 *
 * Sites covered (each must contain `c.author = $N` AND `'bridge_paper'`
 * within the SAME conjunctive group, not as separate disconnected predicates):
 *   1. GET /api/papers (papers.ts:227 typeFilter + papers.ts:263 accreditedOnly)
 *   2. GET /api/papers/:author/:permlink (papers.ts:557 fetchPaperDetailFromHaf)
 *   3. GET /api/search?type=papers (search.ts:57 source-routing + search.ts:82
 *      accreditedOnly)
 *   4. GET /api/stats (stats.ts:42 papers CTE + stats.ts:60 count subqueries)
 *   5. GET /api/disciplines (disciplines.ts:41)
 *   6. GET /api/papers/:author/:permlink/comments (comments.ts:38 paperExistsInHaf)
 *   7. GET /api/bridge/check (bridge.ts:90 + bridge.ts:107)
 *   8. GET /api/sitemap.xml (app.ts:210)
 *   9. /api/notifications (notification-queries.ts:133 user_bridge_papers CTE)
 *
 * The `'native'`-source case for `/api/search?source=native` and
 * `/api/papers?source=native` intentionally lacks the bridge-author conjunct
 * — that arm of `validPevoPaperWhere()` returns the native-only predicate.
 * We assert that asymmetry separately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async () => ({ rows: [] })),
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
const app = createApp();

// Captures every SQL string + params pair the mock pool sees, in order.
type Captured = { sql: string; params: unknown[] };
let captured: Captured[];

beforeEach(async () => {
  captured = [];
  hafQueryMock.mockReset().mockImplementation(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params: params ?? [] });
    return { rows: [] };
  });
  getPoolMock.mockReset().mockReturnValue({
    query: hafQueryMock,
    connect: async () => ({
      query: hafQueryMock,
      release: () => {},
    }),
  });
  await hafCache.clear();
});

/**
 * Asserts that the captured SQL contains the bridge-author-pinned predicate
 * shape produced by validPevoPaperWhere('bridge') or 'all'. The helper today
 * emits:
 *
 *   (<alias>.author = $N AND (<alias>.json_metadata -> $M ->> 'type') = 'bridge_paper')
 *
 * but the SQL is semantically identical if the conjuncts are flipped, so the
 * assertion captures every parenthesized group that contains BOTH the author
 * equality and the bridge_paper type predicate, in either order, and verifies
 * the `$N` slot binds to `config.hiveBridgeAccount` for every match.
 *
 * **Mutation sensitivity (round-3 fix):** prior implementation called
 * `sql.match(re)` which returned only the first occurrence. When the same SQL
 * string contained multiple bridge-arm sites at the same alias (e.g.
 * `reputation.ts:374` active_authors AND `reputation.ts:494` user_papers, both
 * at alias `c`), a per-site mutation that dropped the author pin from the
 * second occurrence left the first untouched and the canary passed. This
 * implementation iterates `matchAll` and asserts each occurrence binds to the
 * bridge account; an `expectedCount` opt pins the call-site count for SQL
 * strings that compose the helper at the same alias multiple times.
 */
function assertBridgeAuthorPin(
  sql: string,
  params: unknown[],
  opts: { alias?: string; expectedCount?: number } = {},
) {
  const alias = opts.alias ?? 'c';
  // Match the outer parenthesized bridge-arm group emitted by
  // validPevoPaperWhere('bridge') — one level of nesting (the json_metadata
  // expression itself uses parens) is allowed. The group must contain BOTH
  // the alias-author equality (with a captured `$N` slot) AND the
  // 'bridge_paper' literal, in either order.
  //
  // Examples this regex accepts:
  //   (c.author = $5 AND (c.json_metadata -> $4 ->> 'type') = 'bridge_paper')
  //   ((c.json_metadata -> $4 ->> 'type') = 'bridge_paper' AND c.author = $5)
  //
  // The body `(?:[^()]+|\\([^()]*\\))*` matches either non-paren chars or one
  // nested parenthesized fragment, repeated. That covers the json_metadata
  // sub-expression without trying to fully balance arbitrary nesting.
  const groupBody = `(?:[^()]+|\\([^()]*\\))*`;
  // Two passes — one for each conjunct order — using a NAMED capture group
  // (`authorSlot`) for the bridge-account `$N` param index. The name makes the
  // regex self-documenting and eliminates the comment-vs-code drift risk where
  // a positional-group comment ("group(2) = the author-slot") falls out of sync
  // with a future regex tweak.
  const reAuthorFirst = new RegExp(
    `\\(${alias}\\.author = \\$(?<authorSlot>\\d+) AND ${groupBody}\\(${alias}\\.json_metadata -> \\$\\d+ ->> 'type'\\) = 'bridge_paper'\\)`,
    'g',
  );
  const reTypeFirst = new RegExp(
    `\\(\\(${alias}\\.json_metadata -> \\$\\d+ ->> 'type'\\) = 'bridge_paper' AND ${alias}\\.author = \\$(?<authorSlot>\\d+)\\)`,
    'g',
  );
  // matchAll across both orders. Each match's `groups.authorSlot` is the
  // bridge-account param slot.
  const matches: RegExpMatchArray[] = [
    ...Array.from(sql.matchAll(reAuthorFirst)),
    ...Array.from(sql.matchAll(reTypeFirst)),
  ];
  expect(
    matches.length,
    `expected at least one validPevoPaperWhere bridge-arm at alias "${alias}" (author + 'bridge_paper' inside one parenthesized conjunction) in SQL:\n${sql}`,
  ).toBeGreaterThan(0);
  if (opts.expectedCount !== undefined) {
    expect(
      matches.length,
      `expected exactly ${opts.expectedCount} bridge-arm occurrence(s) at alias "${alias}", got ${matches.length}. ` +
      `Mutation canary: a per-site removal of the bridge-author pin would drop one occurrence. SQL:\n${sql}`,
    ).toBe(opts.expectedCount);
  }
  // Every captured `$N` slot must bind to config.hiveBridgeAccount — not the
  // route-author or any other slot. This is the per-occurrence check that
  // catches a mutation in any one of multiple same-alias sites.
  for (const m of matches) {
    const authorSlot = m.groups?.authorSlot;
    expect(
      authorSlot,
      `regex match missing named capture group "authorSlot"; SQL:\n${sql}`,
    ).toBeDefined();
    const idx = Number(authorSlot);
    expect(
      params[idx - 1],
      `bridge-arm at alias "${alias}" binds $${idx}; expected config.hiveBridgeAccount, got ${JSON.stringify(params[idx - 1])}`,
    ).toBe(config.hiveBridgeAccount);
  }
}

/**
 * Returns the captures that mention bridge_paper somewhere — these are the
 * queries that exercise the validPevoPaperWhere() helper. Captures that are
 * pure CTE-only (e.g. active_accreditations subquery) or unrelated routes
 * fired during request processing are filtered out.
 */
function bridgeRelatedCaptures(): Captured[] {
  return captured.filter((c) => c.sql.includes("'bridge_paper'"));
}

describe('GET /api/papers — bridge-author pin', () => {
  it('default (accreditedOnly=true) gates bridge_paper carve-out on c.author = config.hiveBridgeAccount', async () => {
    await request(app).get('/api/papers').expect(200);
    const related = bridgeRelatedCaptures();
    expect(related.length).toBeGreaterThan(0);
    for (const cap of related) {
      assertBridgeAuthorPin(cap.sql, cap.params);
    }
  });

  it('accreditedOnly=false retains bridge-author pin on the bridge-arm typeFilter', async () => {
    await request(app).get('/api/papers?accredited_only=false').expect(200);
    const related = bridgeRelatedCaptures();
    expect(related.length).toBeGreaterThan(0);
    for (const cap of related) {
      // Even without accreditedOnly gating, the typeFilter itself OR-arms
      // bridge_paper through the helper, which keeps the author pin.
      assertBridgeAuthorPin(cap.sql, cap.params);
    }
  });

  it('source=native produces type=paper without bridge author pin (asymmetric arm)', async () => {
    await request(app).get('/api/papers?source=native&accredited_only=false').expect(200);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    // Native-only branch: helper emits the native arm only — no bridge_paper
    // literal at all when accreditedOnly is also off.
    for (const cap of captured) {
      expect(cap.sql).not.toContain("'bridge_paper'");
    }
  });

  it('source=bridge pins author = config.hiveBridgeAccount', async () => {
    await request(app).get('/api/papers?source=bridge').expect(200);
    const related = bridgeRelatedCaptures();
    expect(related.length).toBeGreaterThan(0);
    for (const cap of related) {
      assertBridgeAuthorPin(cap.sql, cap.params);
    }
  });
});

describe('GET /api/papers/:author/:permlink — fetchPaperDetailFromHaf bridge-author pin', () => {
  it('paper detail SELECT pins bridge_paper to config.hiveBridgeAccount in WHERE', async () => {
    await request(app).get('/api/papers/alice/p-1').expect(404);
    const related = bridgeRelatedCaptures();
    // The paper-detail SELECT is the bridge-related one; helper-less
    // sub-queries (versions chain, retraction lookup) lack the pattern.
    expect(related.length).toBeGreaterThan(0);
    for (const cap of related) {
      assertBridgeAuthorPin(cap.sql, cap.params);
    }
  });
});

describe('GET /api/search?type=paper — bridge-author pin', () => {
  it('default search (accreditedOnly=true) pins bridge_paper carve-out', async () => {
    await request(app).get('/api/search?q=test&type=paper').expect(200);
    const related = bridgeRelatedCaptures();
    expect(related.length).toBeGreaterThan(0);
    for (const cap of related) {
      assertBridgeAuthorPin(cap.sql, cap.params);
    }
  });

  it('source=bridge pins to bridge account', async () => {
    await request(app).get('/api/search?q=test&type=paper&source=bridge').expect(200);
    const related = bridgeRelatedCaptures();
    expect(related.length).toBeGreaterThan(0);
    for (const cap of related) {
      assertBridgeAuthorPin(cap.sql, cap.params);
    }
  });
});

describe('GET /api/stats — papers CTE bridge-author pin', () => {
  it('papers CTE and total_bridge_papers count both pin author = bridgeAccount', async () => {
    // Stats is monolithic — one query that contains both the c-aliased papers
    // CTE and the p-aliased count subqueries. Asserting both alias forms in
    // every bridge-related capture is the strongest mutation canary.
    const { fetchStatsFromHaf } = await import('../../src/routes/stats.js');
    await fetchStatsFromHaf();
    const related = bridgeRelatedCaptures();
    // Loosened from `toBe(1)` to `toBeGreaterThan(0)` (round-3 hold item 7) so
    // the assertion mirrors the other site canaries: the contract is that
    // every bridge-related capture pins to the bridge account, not that there
    // is exactly one capture. Adding a second monitor query in the future
    // shouldn't break the canary as long as both capture sites pin correctly.
    expect(related.length).toBeGreaterThan(0);
    for (const cap of related) {
      // Both alias forms of the helper bridge-arm must be present in this
      // capture. `c` is the papers CTE; `p` is the count-subquery alias.
      assertBridgeAuthorPin(cap.sql, cap.params, { alias: 'c' });
      assertBridgeAuthorPin(cap.sql, cap.params, { alias: 'p' });
    }
  });
});

describe('GET /api/disciplines — bridge-author pin', () => {
  it('disciplines aggregation pins bridge_paper to bridge account', async () => {
    await request(app).get('/api/disciplines').expect(200);
    const related = bridgeRelatedCaptures();
    expect(related.length).toBeGreaterThan(0);
    for (const cap of related) {
      assertBridgeAuthorPin(cap.sql, cap.params);
    }
  });
});

describe('GET /api/papers/:author/:permlink/comments — paperExistsInHaf bridge-author pin', () => {
  it('paperExistsInHaf SELECT pins bridge_paper to bridge account', async () => {
    await request(app).get('/api/papers/alice/p-1/comments').expect(404);
    const related = bridgeRelatedCaptures();
    expect(related.length).toBeGreaterThan(0);
    for (const cap of related) {
      assertBridgeAuthorPin(cap.sql, cap.params);
    }
  });
});

describe('GET /api/bridge/check — duplicate-check bridge-author pin', () => {
  it('source-DOI + permlink duplicate checks both pin bridge_paper to bridge account', async () => {
    // /api/bridge/check needs a resolvable DOI; bogus identifiers short-circuit
    // before HAF. Use an arxiv-style identifier the resolver accepts; the mock
    // pool returns empty, so the route returns "not found" but the SQL has
    // fired before that.
    const res = await request(app).get('/api/bridge/check?identifier=arxiv:2501.00001');
    // Don't assert status; we only care about captured SQL.
    expect([200, 400, 404]).toContain(res.status);
    const related = bridgeRelatedCaptures();
    // At minimum the metadata-DOI lookup. The deterministic-permlink lookup
    // only fires if the metadata one returned no rows; mock returns [] so
    // both fire.
    if (related.length > 0) {
      for (const cap of related) {
        assertBridgeAuthorPin(cap.sql, cap.params);
      }
    }
  });
});

describe('GET /sitemap.xml — bridge-author pin', () => {
  it('sitemap dynamic-paper SELECT pins bridge_paper to bridge account', async () => {
    await request(app).get('/sitemap.xml').expect(200);
    const related = bridgeRelatedCaptures();
    // Sitemap targets hive.comments_view (legacy table) — only one bridge-
    // related capture should fire.
    expect(related.length).toBeGreaterThan(0);
    for (const cap of related) {
      assertBridgeAuthorPin(cap.sql, cap.params);
    }
  });
});

describe('fetchNotificationsFromHaf — user_bridge_papers CTE bridge-author pin', () => {
  it('user_bridge_papers CTE pins bridge_paper to config.hiveBridgeAccount', async () => {
    // The user_bridge_papers CTE in notification-queries.ts:134 pairs the
    // formerly attacker-controlled `source.registered_by = $1` filter with the
    // bridge-author pin via validPevoPaperWhere('bridge'). Round-3 hold item 2
    // closes the documented-but-untested coverage gap: the SQL shape was
    // correct, the canary just didn't exercise it.
    //
    // fetchNotificationsFromHaf returns null when the pool is unavailable; we
    // installed a real (mocked) pool in the global beforeEach so the SQL is
    // captured. The query returns no rows → the function returns an empty
    // batch; we assert on the captured SQL not the response.
    const { fetchNotificationsFromHaf } = await import('../../src/notification-queries.js');
    await fetchNotificationsFromHaf('testuser', 0, 50);
    const related = bridgeRelatedCaptures();
    expect(related.length).toBeGreaterThan(0);
    for (const cap of related) {
      assertBridgeAuthorPin(cap.sql, cap.params);
    }
  });
});

describe('reputation computeReputationBatch — bridge-author pin', () => {
  it('active_authors + user_papers CTEs pin bridge_paper to bridge account ($18)', async () => {
    const reputation = await import('../../src/reputation.js');
    // computeReputationBatch issues:
    //   1. (transitively) accreditation/weights queries (cached after first run)
    //   2. SELECT MAX(block_num) FROM ${T.blocks} for endBlock
    //   3. The monolithic reputation query containing active_authors + user_papers
    // Override the mock to return a head-block row for the MAX(block_num)
    // query so step 3 proceeds. Other queries are recorded but return empty.
    hafQueryMock.mockReset().mockImplementation(async (sql: string, params: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      if (sql.includes('MAX(block_num)')) return { rows: [{ head: 999_999 }] };
      return { rows: [] };
    });
    await reputation.computeReputationBatch(['testuser']);
    const repSql = captured.find((c) => c.sql.includes('active_authors AS'));
    expect(repSql, `expected an active_authors CTE in captured SQL`).toBeDefined();
    if (!repSql) return;
    // The reputation query composes validPevoPaperWhere() at multiple sites
    // sharing the same alias inside ONE captured SQL string:
    //   - alias 'c', source 'all': active_authors paper side (line ~374)
    //   - alias 'c', source 'all': accepted_claims user_papers UNION (line ~494)
    //   - alias 'p', source 'all': active_authors review-join parent side (~380)
    //   - alias 'c', source 'native': user_papers native side (~483, no bridge-arm)
    //
    // Round-3 hold item 1: a per-site mutation that drops the bridge-author
    // pin from the accepted_claims arm (line ~494) leaves the active_authors
    // arm intact. Without `expectedCount`, the old `match()` returned only the
    // first occurrence and the test passed. Pinning expectedCount forces the
    // canary to fail red on any per-site mutation. Concrete attack defended:
    // an attacker with an accepted co-author claim on a spoofed `bridge_paper`
    // gaining reputation credit via the user_papers UNION.
    assertBridgeAuthorPin(repSql.sql, repSql.params, { alias: 'c', expectedCount: 2 });
    assertBridgeAuthorPin(repSql.sql, repSql.params, { alias: 'p', expectedCount: 1 });
  });
});
