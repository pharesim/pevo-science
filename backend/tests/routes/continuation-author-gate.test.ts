/**
 * Continuation-author consent-gate canary tests.
 *
 * Pins the gate added in BACKEND-CONTINUATION-POST-AUTHOR-CONSENT-GATE:
 * `resolveContinuationChain` admits a continuation post into a paper's
 * version chain only when BOTH:
 *   1. the continuation post's chain-level author is one of the head
 *      paper's authorized continuation authors (native paper:
 *      `pevo.authors[].hive` set, lowercased; bridge paper: the bridge
 *      account itself), AND
 *   2. the continuation's `pevo.type` is a valid PEvO paper class (native
 *      paper, or bridge-paper variant pinned to the bridge account).
 * Plus head-metadata override guards under the Multi-Author Trust Model
 * (no-shrink rule on `pevo.authors[]` — head must cover root's authorized
 * set, additions admitted; per-version display for `pevo.ipfs_cid` /
 * `pevo.document_hash` / `pevo.ipfs_filename` with head-preferred fallback
 * to root) that close the co-author display-spoof class.
 *
 * Threat model: any Hive account (or even a vouched co-author) can
 * broadcast a comment with `pevo.continues = {author, permlink}` pointing
 * at a real paper. Without these gates, the attacker's or co-author's
 * content surfaces as a later version of the real paper via the version
 * walker. The gates filter such spoofs out.
 *
 * **Carve-out (per CLAUDE.md "Running Tests"):** these tests mock
 * `getPool()` to capture the SQL string and to seed deterministic head/
 * candidate rows. Real HAF cannot be seeded with a spoofed continuation
 * authored by an unaccredited account on demand — the fixture would
 * require a separate test HAF DB and per-test seed. The mocked-pool
 * variant pins the SQL shape (`c.author = ANY($N::text[])` filter +
 * `validPevoPaperWhere` predicate) AND the JS-side re-checks (author-set
 * membership + `isPevoAnyPaper`).
 *
 * Per CLAUDE.md clauses (a)/(b)/(c):
 *   (a) justification documented above (deterministic spoofed-continuation
 *       seeding is impractical against the public HAF DB),
 *   (b) `verifyHiveSignature` and other middleware are NOT mocked,
 *   (c) real-HAF integration is filed as a follow-up: neither
 *       `papers.test.ts` nor `paper-detail-v3.test.ts` exercises the gate
 *       against live HAF rows today (papers.test.ts only asserts shape
 *       on whatever paper happens to be first in the listing). The
 *       bridge-paper-author-gate task established the precedent of
 *       mocked + grep canaries for impractical-to-seed scenarios; this
 *       file follows the same pattern. A real-HAF integration variant
 *       is filed as follow-up.
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
    }, 'alice');
    expect(set.has('alice')).toBe(true);
    expect(set.has('bob')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('returns empty set for missing/null/undefined input', () => {
    expect(helpers.extractAuthorizedContinuationAuthors(null, 'alice').size).toBe(0);
    expect(helpers.extractAuthorizedContinuationAuthors(undefined, 'alice').size).toBe(0);
    expect(helpers.extractAuthorizedContinuationAuthors({}, 'alice').size).toBe(0);
    expect(helpers.extractAuthorizedContinuationAuthors({ authors: 'not-array' }, 'alice').size).toBe(0);
    expect(helpers.extractAuthorizedContinuationAuthors({ authors: [] }, 'alice').size).toBe(0);
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
    }, 'alice');
    expect(set.has('alice')).toBe(true);
    expect(set.has('bob')).toBe(true);
    expect(set.has('')).toBe(false);
    expect(set.size).toBe(2);
  });

  it('lowercases hive entries (Hive enforces lowercase chain-side)', () => {
    // Without lowercasing, a metadata typo (`Alice` from a display-case
    // copy-paste) would silently lock out the legitimate `alice`
    // continuation. Hive enforces lowercase chain-side, so we normalize at
    // extract time.
    const set = helpers.extractAuthorizedContinuationAuthors({
      authors: [{ hive: 'Alice' }, { hive: 'BOB' }, { hive: '  CaRoL  ' }],
    }, 'alice');
    expect(set.has('alice')).toBe(true);
    expect(set.has('bob')).toBe(true);
    expect(set.has('carol')).toBe(true);
    expect(set.has('Alice')).toBe(false);
    expect(set.size).toBe(3);
  });

  it('bridge-paper special-case: authorized set is {bridge account}, NOT pevo.authors[].hive', () => {
    // Bridge papers' canonical update path is the bridge account itself
    // (bridge.ts /update posts a continuation under config.hiveBridgeAccount).
    // pevo.authors[] entries carry hive: null since original-preprint
    // authors don't have on-chain identity. Deferring to pevo.authors[]
    // would yield an empty set and block ALL continuations of bridge
    // papers — the design choice (Option b) is that the bridge account
    // vouches on their behalf.
    const bridgeAcc = config.hiveBridgeAccount;
    const set = helpers.extractAuthorizedContinuationAuthors({
      type: 'bridge_paper',
      authors: [{ hive: null }, { hive: null }, { name: 'preprint-only' }],
    }, bridgeAcc);
    expect(set.size).toBe(1);
    expect(set.has(bridgeAcc)).toBe(true);
  });

  it('bridge-paper special-case is author-pinned (spoofed type from non-bridge author falls through)', () => {
    // If a non-bridge author posts type='bridge_paper', the helper does
    // NOT enter the special case (it would be a self-asserted exemption).
    // It falls through to the regular pevo.authors[].hive path.
    const set = helpers.extractAuthorizedContinuationAuthors({
      type: 'bridge_paper',
      authors: [{ hive: 'alice' }],
    }, 'attacker'); // not the bridge account
    expect(set.has('alice')).toBe(true);
    expect(set.has('attacker')).toBe(false);
    expect(set.size).toBe(1);
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
    // admits bob into the chain because bob ∈ pevo.authors[].hive AND
    // bob/v2 has pevo.type='paper'.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] },
    };
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
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
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
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }] },
    };
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
          return { rows: [{ author: 'alice', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
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

  it('bridge-paper continuation: only the bridge account is authorized (Option b)', async () => {
    // The head paper is authored by config.hiveBridgeAccount with
    // pevo.authors[] listing original-preprint authors that typically
    // carry hive: null (off-chain identity). Per the bridge-paper Option b
    // design (architect-ratified 2026-05-04), the authorized continuator
    // set is `{config.hiveBridgeAccount}` itself — bridge papers' canonical
    // update path IS the bridge account (bridge.ts /update). A continuation
    // by ANY non-bridge account (including a putative original author or
    // an attacker) is excluded.
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
          // Original-preprint authors with off-chain identity (hive: null)
          authors: [{ name: 'Alice Preprint', hive: null }, { name: 'Bob Preprint', hive: null }],
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
        // Confirm the SQL gate's ANY() contains ONLY the bridge account.
        assertChainWalkAuthorFilter(sql, params, [bridgeAcc]);
        const idx = Number((sql.match(/c\.author\s*=\s*ANY\s*\(\s*\$(\d+)::text\[\]\s*\)/) ?? [])[1] ?? 0);
        const bound = params[idx - 1] as string[];
        // Attacker-exclusion: arbitrary accounts are NOT in the bound set.
        expect(bound).not.toContain('attacker');
        // Original-preprint-author accounts are NOT in the bound set
        // (their hive: null entries would have been filtered anyway).
        expect(bound).not.toContain('alice');
        expect(bound).not.toContain('bob');
        // The bridge account legitimately continues (bridge /update path):
        if (params[0] === bridgeAcc) {
          return { rows: [{
            author: bridgeAcc,
            permlink: 'bridge-paper-1-v2',
            block_num: 100,
            json_metadata: {
              app: `${config.appTag}/test`,
              [config.appTag]: { type: 'bridge_paper', authors: [{ hive: null }] },
            },
          }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/papers/${bridgeAcc}/bridge-paper-1`);
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail.head_author).toBe(bridgeAcc);
    expect(detail.head_permlink).toBe('bridge-paper-1-v2');
  });

  it('rejects a continuation type-spoof: named co-author posting pevo.type=review with continues pointer', async () => {
    // Item 1 (round-2 hold): a named co-author bob is in alice's
    // pevo.authors[]. bob posts a comment with pevo.type='review' AND
    // pevo.continues={alice, p1}. Without the validPevoPaperWhere predicate
    // on the chain-walk SQL (and the JS-side isPevoAnyPaper re-check), the
    // chain-walker would admit it and bob's review content would surface
    // as alice/p1's apparent paper body via the version walker's
    // unconditional body-overwrite at line 581-585.
    //
    // Defense in depth: even if the SQL predicate were dropped, the JS
    // re-check on the candidate's parsed metadata catches it.
    const reviewSpoofMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'review', authors: [{ hive: 'alice' }, { hive: 'bob' }] },
    };
    installResponder(async (sql, _params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (isForwardChainWalkSql(sql)) {
        // Simulate SQL predicate bypass: return a review-typed candidate
        // (bob, vouched co-author) that the JS gate must reject on type.
        return { rows: [{
          author: 'bob',
          permlink: 'review-spoof',
          block_num: 100,
          json_metadata: reviewSpoofMeta,
        }] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    // The chain did NOT extend to bob/review-spoof: head stays alice/p1.
    expect(detail.head_author).toBe('alice');
    expect(detail.head_permlink).toBe('p1');
    // versions[] does not include the review-spoof entry.
    if (Array.isArray(detail.versions)) {
      const containsReviewSpoof = detail.versions.some((v: { author?: string; permlink?: string }) => v.author === 'bob' && v.permlink === 'review-spoof');
      expect(containsReviewSpoof).toBe(false);
    }
  });

  it('chain-walk SQL pins validPevoPaperWhere predicate (pevo.type identity)', async () => {
    // Item 1 (round-2 hold): the chain-walk SQL must include the
    // validPevoPaperWhere predicate so a candidate with pevo.type != 'paper'
    // never reaches the application layer. The predicate text contains
    // the literal `'type'` -> ... -> 'paper' arm and the bridge-paper arm.
    installResponder(async (sql, _params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (isForwardChainWalkSql(sql)) {
        // The forward chain-walk SQL must contain the type='paper' arm
        // from validPevoPaperWhere — the canonical mutation canary for
        // dropping the predicate during a future SQL refactor.
        expect(sql).toMatch(/->>\s*'type'\)\s*=\s*'paper'/);
        return { rows: [] };
      }
      return { rows: [] };
    });

    await request(app).get('/api/papers/alice/p1');
    const walks = chainWalkCaptures();
    expect(walks.length).toBeGreaterThan(0);
  });

  it('rejects head metadata that drops a root author (no-shrink check)', async () => {
    // Round-3 hold item 1: a vouched co-author bob continues alice/p1, but
    // bob/v2's metadata sets pevo.authors=[{hive:'bob'}] — silently dropping
    // alice from her own paper. Under the no-shrink rule, the head's hive
    // set must COVER the root's authorized-author set; missing alice means
    // REJECT the authors[] override and emit
    // event: 'continuation_authors_shrink_violation'.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        // Insider attack: bob drops alice from her own paper.
        authors: [{ hive: 'bob' }],
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    // Head moved to bob/v2 (legitimate co-author continuation pointer).
    expect(detail.head_author).toBe('bob');
    // pevo.authors[] override REJECTED: response retains root's authors[]
    // (alice + bob), NOT head's (bob alone). Alice must remain visible.
    const responseAuthors = (detail.authors || []) as Array<{ hive?: string }>;
    const hiveSet = new Set(responseAuthors.map((a) => a.hive).filter(Boolean));
    expect(hiveSet.has('alice')).toBe(true);
    expect(hiveSet.has('bob')).toBe(true);
  });

  it('admits head metadata that adds a new author (additions are legitimate)', async () => {
    // Round-3 hold item 1: pevo.authors[] is monotonic per the version-chain
    // edit semantics convention. bob's continuation with
    // pevo.authors=[alice, bob, carol] is legitimate (carol joins during
    // revision, becomes claimed-pending until Phase 2's author_accept op
    // lands). The override is admitted and carol surfaces in the displayed
    // authors list.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        // Legitimate addition: alice + bob (root) + carol (new joiner).
        authors: [{ hive: 'alice' }, { hive: 'bob' }, { hive: 'carol' }],
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.head_author).toBe('bob');
    // pevo.authors[] override ADMITTED: head's three-author list surfaces.
    const responseAuthors = (detail.authors || []) as Array<{ hive?: string }>;
    const hiveSet = new Set(responseAuthors.map((a) => a.hive).filter(Boolean));
    expect(hiveSet.has('alice')).toBe(true);
    expect(hiveSet.has('bob')).toBe(true);
    expect(hiveSet.has('carol')).toBe(true);
  });

  it('shows head\'s ipfs_cid for the default view when continuation provides one (per-version display)', async () => {
    // Round-3 hold item 2: ipfs_cid / document_hash / ipfs_filename apply
    // per-version. The default `/api/papers/:author/:permlink` view reads
    // from the chain head, like other free-edit fields. bob's v2 carries
    // its own CID (bob's revised PDF); that's the displayed CID, not
    // root's. Per-version retention is preserved on chain (Hive
    // immutability) and accessible via ?version=N.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }], // satisfies no-shrink
        ipfs_cid: 'QmHeadCid',
        document_hash: 'sha256:head',
        ipfs_filename: 'head.pdf',
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    // Per-version display: head's pointers surface for the default view.
    expect(detail.ipfs_cid).toBe('QmHeadCid');
    expect(detail.document_hash).toBe('sha256:head');
    expect(detail.ipfs_filename).toBe('head.pdf');
  });

  it('falls back to root\'s ipfs_cid when head metadata doesn\'t carry one', async () => {
    // Round-3 hold item 2: when the head version doesn't carry an
    // ipfs_cid/document_hash/ipfs_filename, the default view falls back
    // to the root's value. This covers the legitimate case where a
    // continuation evolves only the body/abstract and inherits the
    // root's PDF unchanged.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }],
        // No ipfs_cid / document_hash / ipfs_filename — falls back to root.
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    // Fallback: root's pointers surface when head omits them.
    expect(detail.ipfs_cid).toBe('QmRootCid');
    expect(detail.document_hash).toBe('sha256:root');
    expect(detail.ipfs_filename).toBe('root.pdf');
  });

  // Round-4 hold item 1 + round-5 sentinel-aware atomic triple: pevoString
  // helper closes three runtime-shape gaps the round-3 cast-and-coalesce
  // pattern silently let through. The cast shape
  // `(headPevo.ipfs_cid as string) ?? (rootPevo.ipfs_cid as string) ?? null`
  // is a TS assertion, not a narrowing — runtime values like `''`, `0`, and
  // `{}` flowed through unchanged. Under round-5's sentinel-aware atomic
  // triple, when head expresses any of the triple keys (even with non-string
  // values), head's view wins for the entire triple — all three fields
  // collapse to null because pevoString narrows the bad values out. No
  // fallback to root: per-field Frankenstein composition is rejected
  // structurally. The three integration canaries below pin all-null
  // collapse for each non-string runtime shape on head.
  it('admits head\'s triple as all-null when head sets all three keys to empty strings (round-5 atomic-triple)', async () => {
    // Under round-5: `'ipfs_cid' in headPevo` is true (key present, even
    // with empty-string value), so head's triple wins atomically. pevoString
    // narrows '' → null for each, yielding an all-null triple. Root's
    // triple is NOT consulted — the per-field fallback that would have
    // produced root.ipfs_cid is structurally unavailable here.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }],
        ipfs_cid: '', // empty string on head
        document_hash: '',
        ipfs_filename: '',
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe(null);
    expect(detail.document_hash).toBe(null);
    expect(detail.ipfs_filename).toBe(null);
  });

  it('admits head\'s triple as all-null when head sets all three keys to numeric 0 (round-5 atomic-triple)', async () => {
    // Under round-5: `'ipfs_cid' in headPevo` is true (key present with
    // value 0), so head's triple wins atomically. pevoString narrows 0 →
    // null for each, yielding an all-null triple. Root's triple is NOT
    // consulted.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }],
        ipfs_cid: 0,
        document_hash: 0,
        ipfs_filename: 0,
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe(null);
    expect(detail.document_hash).toBe(null);
    expect(detail.ipfs_filename).toBe(null);
  });

  it('admits head\'s triple as all-null when head sets all three keys to objects/arrays (round-5 atomic-triple)', async () => {
    // Under round-5: `'ipfs_cid' in headPevo` is true (key present with
    // object/array value), so head's triple wins atomically. pevoString
    // narrows {} / [] → null for each, yielding an all-null triple. The API
    // contract promises string-or-null and atomic-triple keeps that
    // promise even under runtime-shape adversarial input.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }],
        ipfs_cid: { unexpected: 'shape' },
        document_hash: ['arr', 'shape'],
        ipfs_filename: { also: 'unexpected' },
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe(null);
    expect(detail.document_hash).toBe(null);
    expect(detail.ipfs_filename).toBe(null);
  });

  // Round-5 hold items 1+2: sentinel-aware atomic triple. The IPFS triple
  // is read entirely from head when head expresses any of the three keys
  // (even with null / non-string values), and entirely from root when head
  // expresses none of them. Per-field fallback (which produced Frankenstein
  // composition where the displayed triple never existed on chain in any
  // single version) is structurally unavailable.
  it('admits an atomic triple from head when head supplies any one of the three fields as a non-string but at least one is a valid string (round-5 atomic-triple)', async () => {
    // Head supplies `ipfs_cid: 'QmHeadCid'` (valid) plus pathological values
    // for the other two. Atomic triple: head wins for the entire triple
    // (head expressed an opinion via the valid CID); the other two collapse
    // to null because pevoString narrows 0 / '' → null. Root's PDF is NOT
    // surfaced — head's view is what the response carries.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }],
        ipfs_cid: 'QmHeadCid',
        ipfs_filename: 0,
        document_hash: '',
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe('QmHeadCid');
    expect(detail.ipfs_filename).toBe(null);
    expect(detail.document_hash).toBe(null);
  });

  it('rejects asymmetric Frankenstein composition: head supplies two of the three keys, third is missing (round-5 atomic-triple)', async () => {
    // Head supplies `ipfs_cid: 'QmHeadCid', ipfs_filename: 0` — two keys
    // present, document_hash key entirely absent. Under per-field fallback
    // (the round-4 shape this canary would FAIL against), document_hash
    // would fall through to root's `sha256:root`, producing Frankenstein
    // composition: head's CID + root's hash. Under round-5's atomic
    // triple, head's view wins for the entire triple because head
    // expressed an opinion (two keys present); document_hash collapses
    // to null because the key is absent → pevoString returns null. The
    // displayed triple is consistent with what head broadcast.
    //
    // This is the kill canary for the "Frankenstein" anti-pattern. Revert
    // the atomic-triple block to per-field fallback and this test FAILS
    // with `expect document_hash to be null but received 'sha256:root'`.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }],
        ipfs_cid: 'QmHeadCid',
        ipfs_filename: 0,
        // document_hash intentionally omitted — not present on head
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe('QmHeadCid');
    expect(detail.ipfs_filename).toBe(null);
    expect(detail.document_hash).toBe(null);
  });

  it('preserves head\'s explicit null ipfs_cid (inline-only continuation, no PDF) (round-5 sentinel-aware)', async () => {
    // Head expresses an inline-only continuation: ipfs_cid: null is the
    // explicit "no PDF on this version, body is everything" signal. The
    // sentinel-aware `'in'` check distinguishes this from "head omitted
    // the keys" — head DID touch the triple keys (assigning null), so
    // head's view wins atomically, yielding all-null. Root's CID is NOT
    // surfaced; the frontend's `is_diffable` toggle correctly reads
    // ipfs_cid: null and renders inline.
    //
    // This is the kill canary for round-3's `??` problem. Revert the
    // sentinel-aware `'in'` check to `pevoString(headPevo, 'ipfs_cid')
    // ?? pevoString(rootPevo, 'ipfs_cid')` and this test FAILS with
    // `expect ipfs_cid to be null but received 'QmRootCid'`.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }],
        ipfs_cid: null,
        ipfs_filename: null,
        document_hash: null,
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe(null);
    expect(detail.ipfs_filename).toBe(null);
    expect(detail.document_hash).toBe(null);
  });

  it('falls back to root when head omits all triple keys (no opinion expressed) (round-5 sentinel-aware)', async () => {
    // Head expresses no opinion on the triple — none of the keys are
    // present in head's pevo metadata. The `'in'` check returns false
    // for all three, so the entire triple inherits from root. This is
    // the only path that consults root's triple under the round-5
    // shape; pin it explicitly so a future refactor doesn't regress
    // back to per-field fallback.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }],
        // no ipfs_cid, no ipfs_filename, no document_hash — head expresses
        // no opinion on the triple, inherits from root.
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCid', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe('QmRootCid');
    expect(detail.ipfs_filename).toBe('root.pdf');
    expect(detail.document_hash).toBe('sha256:root');
  });

  it('?version=N retrieves per-version ipfs_cid (regression pin)', async () => {
    // Round-3 hold item 2: ipfs_cid is preserved per-version on chain.
    // The dedicated ?version=N path reads each version's metadata
    // directly via reconstructVersionsFromHaf — alice's v1 surfaces
    // its CID, bob's v2 surfaces its (different) CID.
    const v1Meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmV1Cid', document_hash: 'sha256:v1' },
    };
    const v2Meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmV2Cid', document_hash: 'sha256:v2' },
    };
    installResponder(async (sql, _params) => {
      // findCanonicalRoot probes for `'continues' IS NOT NULL`; alice/p1
      // is the root, so return empty.
      if (sql.includes("'continues'") && sql.includes('IS NOT NULL')) {
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't1', body: 'abstract1\n\n---\n\nbody1', created: '2026-01-01T00:00:00.000Z', json_metadata: v1Meta },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: v2Meta },
        ] };
      }
      return { rows: [] };
    });

    const v1 = await request(app).get('/api/papers/alice/p1?version=1');
    expect(v1.status).toBe(200);
    expect(v1.body?.data?.ipfs_cid).toBe('QmV1Cid');
    expect(v1.body?.data?.document_hash).toBe('sha256:v1');

    const v2 = await request(app).get('/api/papers/alice/p1?version=2');
    expect(v2.status).toBe(200);
    expect(v2.body?.data?.ipfs_cid).toBe('QmV2Cid');
    expect(v2.body?.data?.document_hash).toBe('sha256:v2');
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
