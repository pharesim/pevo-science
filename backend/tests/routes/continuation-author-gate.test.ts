/**
 * Continuation-author consent-gate canary tests.
 *
 * Pins the gate added in BACKEND-CONTINUATION-POST-AUTHOR-CONSENT-GATE:
 * `resolveContinuationChain` admits a continuation post into a paper's
 * version chain only when the continuation post's chain-level author is
 * one of the head paper's named authors (`pevo.authors[].hive` set).
 *
 * Threat model: any Hive account can broadcast a comment with
 * `pevo.continues = {author: <real-paper-author>, permlink: <real-paper>}`
 * and `pevo.type = 'paper'`. Without this gate, the attacker's content
 * surfaces as a later version of the real paper via the version walker.
 * The gate filters such spoofs out.
 *
 * **Carve-out (per CLAUDE.md "Running Tests"):** these tests mock
 * `getPool()` to capture the SQL string and to seed deterministic head/
 * candidate rows. Real HAF cannot be seeded with a spoofed continuation
 * authored by an unaccredited account on demand — the fixture would
 * require a separate test HAF DB and per-test seed. The mocked-pool
 * variant pins the SQL shape (`c.author = ANY($N::text[])` filter) AND
 * the JS-side authorized-author check; the real-HAF integration paths
 * (papers.test.ts, paper-detail-v3.test.ts) cover the query-execution
 * path against the live test corpus.
 *
 * Per CLAUDE.md clauses (a)/(b)/(c):
 *   (a) justification documented above (deterministic spoofed-continuation
 *       seeding is impractical against the public HAF DB),
 *   (b) `verifyHiveSignature` and other middleware are NOT mocked,
 *   (c) real-HAF integration variants exist for the chain-resolution path;
 *       this file pins the per-call-site SQL contract + JS gate.
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
const helpers = await import('../../src/helpers.js');
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

/**
 * Scaffold a HAF query handler that replies based on SQL pattern matching.
 * Each test installs its own per-pattern responder.
 */
function installResponder(handler: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>) {
  hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params: params ?? [] });
    return handler(sql, params ?? []);
  });
}

// ──────────────────────────────────────────────
// Pure-helper unit tests (no app, no DB)
// ──────────────────────────────────────────────

describe('extractAuthorizedContinuationAuthors', () => {
  it('extracts hive accounts from pevo.authors[]', () => {
    const set = helpers.extractAuthorizedContinuationAuthors({
      authors: [{ hive: 'alice' }, { hive: 'bob' }],
    });
    expect(set.has('alice')).toBe(true);
    expect(set.has('bob')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('returns empty set for missing/null/undefined input', () => {
    expect(helpers.extractAuthorizedContinuationAuthors(null).size).toBe(0);
    expect(helpers.extractAuthorizedContinuationAuthors(undefined).size).toBe(0);
    expect(helpers.extractAuthorizedContinuationAuthors({}).size).toBe(0);
    expect(helpers.extractAuthorizedContinuationAuthors({ authors: 'not-array' }).size).toBe(0);
    expect(helpers.extractAuthorizedContinuationAuthors({ authors: [] }).size).toBe(0);
  });

  it('skips entries missing hive field, trims, ignores empty strings', () => {
    const set = helpers.extractAuthorizedContinuationAuthors({
      authors: [
        { hive: '  alice  ' },
        { hive: '' },
        { hive: '   ' },
        { name: 'no-hive' },
        { hive: 42 }, // non-string
        null,
        'not-object',
        { hive: 'bob' },
      ],
    });
    expect(set.has('alice')).toBe(true);
    expect(set.has('bob')).toBe(true);
    expect(set.has('')).toBe(false);
    expect(set.size).toBe(2);
  });
});

describe('isAuthorizedContinuationAuthor', () => {
  const authorized = new Set(['alice', 'bob']);

  it('admits a named author', () => {
    expect(helpers.isAuthorizedContinuationAuthor('alice', authorized)).toBe(true);
    expect(helpers.isAuthorizedContinuationAuthor('bob', authorized)).toBe(true);
  });

  it('rejects a non-author (the spoof scenario)', () => {
    expect(helpers.isAuthorizedContinuationAuthor('attacker', authorized)).toBe(false);
  });

  it('rejects empty/non-string candidate', () => {
    expect(helpers.isAuthorizedContinuationAuthor('', authorized)).toBe(false);
    // @ts-expect-error explicitly testing non-string runtime input
    expect(helpers.isAuthorizedContinuationAuthor(null, authorized)).toBe(false);
    // @ts-expect-error explicitly testing non-string runtime input
    expect(helpers.isAuthorizedContinuationAuthor(42, authorized)).toBe(false);
  });

  it('returns false when the authorized set is empty (no chain to admit into)', () => {
    expect(helpers.isAuthorizedContinuationAuthor('alice', new Set())).toBe(false);
  });
});

// ──────────────────────────────────────────────
// SQL-shape canaries: c.author = ANY($N::text[]) filter
// ──────────────────────────────────────────────

/**
 * Asserts that the captured chain-walk SQL contains the author-set filter
 * (`c.author = ANY($N::text[])`) and that the bound parameter is a string
 * array containing exactly the expected named-author set.
 *
 * This is the mutation canary: a future refactor that drops the
 * `ANY($N::text[])` predicate from the chain-walk SQL would fail this
 * assertion red. The defense-in-depth JS gate would still catch the
 * spoof, but the SQL-side gate is the primary efficiency + correctness
 * boundary.
 */
function assertChainWalkAuthorFilter(sql: string, params: unknown[], expectedAuthors: string[]) {
  // Match `c.author = ANY($<digits>::text[])` somewhere in the SQL.
  const re = /c\.author\s*=\s*ANY\s*\(\s*\$(\d+)::text\[\]\s*\)/g;
  const matches = Array.from(sql.matchAll(re));
  expect(
    matches.length,
    `expected at least one c.author = ANY($N::text[]) author-set filter in chain-walk SQL:\n${sql}`,
  ).toBeGreaterThan(0);
  // Every captured slot must bind to a string[] containing the expected
  // named-author set. Subset-equality check (set semantics).
  for (const m of matches) {
    const idx = Number(m[1]);
    const bound = params[idx - 1];
    expect(
      Array.isArray(bound),
      `chain-walk author-set filter at $${idx} must bind to a string[]; got ${JSON.stringify(bound)}`,
    ).toBe(true);
    const boundSet = new Set(bound as string[]);
    for (const a of expectedAuthors) {
      expect(
        boundSet.has(a),
        `expected named author "${a}" in chain-walk filter param $${idx} (${JSON.stringify(bound)})`,
      ).toBe(true);
    }
  }
}

/** Returns true iff the SQL is the FORWARD chain-walk query in
 *  `resolveContinuationChain` (matches the continues-pointer equality
 *  predicate `= $1`/`= $2`). This excludes `findCanonicalRoot`'s reverse
 *  walk (which uses `AS cont_author` / `IS NOT NULL` instead) and the
 *  head-paper lookup. */
function isForwardChainWalkSql(sql: string): boolean {
  return /'continues'\s*->>\s*'author'\s*=\s*\$1/.test(sql)
    && /'continues'\s*->>\s*'permlink'\s*=\s*\$2/.test(sql);
}

/** Captured forward chain-walk SQL only. */
function chainWalkCaptures(): Captured[] {
  return captured.filter((c) => isForwardChainWalkSql(c.sql));
}

describe('GET /api/papers/:author/:permlink — continuation chain-walk SQL gate', () => {
  function pevoPaperRow(author: string, permlink: string, namedAuthors: string[], extra: Record<string, unknown> = {}) {
    return {
      author,
      permlink,
      title: 't',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: {
        app: `${config.appTag}/test`,
        [config.appTag]: {
          type: 'paper',
          authors: namedAuthors.map((hive) => ({ hive })),
          ...extra,
        },
      },
      created: '2026-01-01T00:00:00.000Z',
      last_edited: '2026-01-01T00:00:00.000Z',
    };
  }

  it('chain-walk SQL pins author = ANY($N::text[]) bound to head pevo.authors[].hive set', async () => {
    // Seed: paper alice/p1 with named authors alice + bob. No continuation
    // candidates returned (empty rows on the chain-walk query). We're only
    // pinning the SQL shape here.
    installResponder(async (sql, _params) => {
      // Bridge-paper canary helper queries — return empty
      if (sql.includes("'bridge_paper'") && !sql.includes("'continues'")) {
        // The paper-detail SELECT
        if (sql.includes('SELECT c.author, c.permlink, c.title')) {
          return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
        }
        return { rows: [] };
      }
      // Head authorized-authors lookup (added by this task) — return paper.
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      // Chain-walk query — return no continuations.
      if (isForwardChainWalkSql(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await request(app).get('/api/papers/alice/p1');

    const walks = chainWalkCaptures();
    expect(walks.length).toBeGreaterThan(0);
    for (const cap of walks) {
      assertChainWalkAuthorFilter(cap.sql, cap.params, ['alice', 'bob']);
    }
  });

  it('rejects a spoofed continuation: SQL ANY() filter excludes attacker, JS gate is defense in depth', async () => {
    // Even if a test DB row leaks past the SQL filter (or a future SQL
    // refactor drops it), the JS-side `isAuthorizedContinuationAuthor`
    // re-check rejects the candidate. We simulate this by having the
    // chain-walk responder return an attacker row REGARDLESS of the
    // ANY() param (the leak we're defending against).
    installResponder(async (sql, _params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (isForwardChainWalkSql(sql)) {
        // Simulate SQL-filter bypass: return attacker row even though
        // ANY() should exclude it. JS gate must still reject.
        return { rows: [{ author: 'attacker', permlink: 'spoof', block_num: 999 }] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);

    // The version chain in the response must NOT include attacker/spoof.
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    // head_author/head_permlink should remain alice/p1 because the JS
    // gate rejects the attacker candidate before the chain extends.
    expect(detail.head_author).toBe('alice');
    expect(detail.head_permlink).toBe('p1');
  });

  it('chain head with no named authors degenerates to root-only (no continuations admitted)', async () => {
    // Head paper has empty pevo.authors[]: the gate returns root-only.
    // No chain-walk SQL should fire (we short-circuit before the loop).
    installResponder(async (sql, _params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', [])] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', [])] };
      }
      if (isForwardChainWalkSql(sql)) {
        // Should not be reached.
        return { rows: [{ author: 'attacker', permlink: 'spoof', block_num: 1 }] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    // No chain-walk SQL fired — the gate short-circuited.
    const walks = chainWalkCaptures();
    expect(walks.length).toBe(0);
  });

  it('admits a legitimate continuation by a named co-author (bob continues alice/p1)', async () => {
    // Two-author paper alice + bob. bob/v2 continues alice/p1. Gate
    // admits bob into the chain because bob ∈ pevo.authors[].hive.
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (isForwardChainWalkSql(sql)) {
        // First hop: alice/p1 → bob/v2. Second hop: bob/v2 → none.
        const currentAuthor = params[0];
        if (currentAuthor === 'alice') {
          // Verify the SQL gate's ANY() filter contains both authors.
          assertChainWalkAuthorFilter(sql, params, ['alice', 'bob']);
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100 }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    // Chain extended: head moved to bob/v2.
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.head_author).toBe('bob');
    expect(detail.head_permlink).toBe('v2');
  });

  it('admits a self-continuation (alice continues her own paper)', async () => {
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice'])] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice'])] };
      }
      if (isForwardChainWalkSql(sql)) {
        const currentAuthor = params[0];
        if (currentAuthor === 'alice' && params[1] === 'p1') {
          assertChainWalkAuthorFilter(sql, params, ['alice']);
          return { rows: [{ author: 'alice', permlink: 'v2', block_num: 100 }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail.head_author).toBe('alice');
    expect(detail.head_permlink).toBe('v2');
  });

  it('bridge-paper continuation: only original preprint authors admitted (NOT the bridge account)', async () => {
    // The head paper is authored by config.hiveBridgeAccount but
    // pevo.authors[] lists 'alice' + 'bob' (the original preprint
    // authors). A continuation by 'bob' is admitted; a continuation
    // by 'attacker' is not; a continuation by the bridge account
    // itself is not (bridge account is not in pevo.authors[]).
    const bridgeAcc = config.hiveBridgeAccount as string;
    const bridgeRow = {
      author: bridgeAcc,
      permlink: 'bridge-paper-1',
      title: 't',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: {
        app: `${config.appTag}/test`,
        [config.appTag]: {
          type: 'bridge_paper',
          authors: [{ hive: 'alice' }, { hive: 'bob' }],
          source: { type: 'arxiv', doi: '10.0/test' },
        },
      },
      created: '2026-01-01T00:00:00.000Z',
      last_edited: '2026-01-01T00:00:00.000Z',
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [bridgeRow] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [bridgeRow] };
      }
      if (isForwardChainWalkSql(sql)) {
        // Confirm the SQL gate's ANY() contains alice+bob, NOT the bridge account.
        assertChainWalkAuthorFilter(sql, params, ['alice', 'bob']);
        const idx = Number((sql.match(/c\.author\s*=\s*ANY\s*\(\s*\$(\d+)::text\[\]\s*\)/) ?? [])[1] ?? 0);
        const bound = params[idx - 1] as string[];
        expect(bound).not.toContain(bridgeAcc); // bridge account excluded
        // bob legitimately continues:
        if (params[0] === bridgeAcc) {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100 }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/papers/${bridgeAcc}/bridge-paper-1`);
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail.head_author).toBe('bob');
  });

  it('non-PEvO head row: chain-walk does not fire (no authorized-author set to admit against)', async () => {
    // Head row exists but is not a PEvO paper (no pevo.* metadata). The
    // gate's fetchHeadAuthorizedAuthors returns null and the chain-walk
    // is skipped entirely. The downstream paper-detail handler will return
    // 404 (not a PEvO paper) — but the gate's contract is "no chain-walk".
    installResponder(async (sql, _params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [{ author: 'alice', json_metadata: { app: 'other-app/x' } }] };
      }
      if (isForwardChainWalkSql(sql)) {
        return { rows: [{ author: 'attacker', permlink: 'spoof', block_num: 1 }] };
      }
      return { rows: [] };
    });

    await request(app).get('/api/papers/alice/p1');
    const walks = chainWalkCaptures();
    expect(walks.length).toBe(0);
  });
});
