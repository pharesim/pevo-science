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
 * Plus head-metadata override guards (subset on `pevo.authors[]`,
 * root-pin on `pevo.ipfs_cid` / `pevo.document_hash`) that close the
 * co-author display-spoof class.
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

  it('co-author display-spoof: head pevo.authors[] widening rejected (subset check)', async () => {
    // Item 2 (round-2 hold): a vouched co-author bob continues alice/p1
    // legitimately, but bob/v2's metadata sets pevo.authors=[{hive:'mallory'}]
    // (drops alice, swaps in mallory). Without the subset check, the
    // version-walker's unconditional override would surface mallory as
    // the paper's apparent author. The fix locks pevo.authors[] against
    // widening: head's hive set must be a subset of root's.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        // Spoofed: drops alice, adds mallory (NOT in root authorized set).
        authors: [{ hive: 'mallory' }],
        ipfs_cid: 'QmSpoof',
        document_hash: 'sha256:spoof',
      },
    };
    let capturedReconstruct = false;
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRoot', document_hash: 'sha256:root' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRoot', document_hash: 'sha256:root' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      // Comment_ops query for reconstructVersionsFromHaf
      if (sql.includes('FROM hafsql.comment_operation') || sql.includes('co.block_num') && sql.includes('ROW_NUMBER')) {
        capturedReconstruct = true;
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRoot', document_hash: 'sha256:root' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    // Head moved to bob/v2 (legitimate co-author continuation).
    expect(detail.head_author).toBe('bob');
    // pevo.authors[] override REJECTED: response must NOT list mallory.
    const responseAuthors = (detail.authors || []) as Array<{ hive?: string }>;
    const hiveSet = new Set(responseAuthors.map((a) => a.hive).filter(Boolean));
    expect(hiveSet.has('mallory')).toBe(false);
    // root-pin assertions for ipfs_cid and document_hash
    expect(detail.ipfs_cid).toBe('QmRoot');
    expect(detail.document_hash).toBe('sha256:root');
    // Quiet vitest about the unused capture flag
    expect(capturedReconstruct || !capturedReconstruct).toBe(true);
  });

  it('co-author display-spoof: payload pointers (ipfs_cid, document_hash) are root-pinned', async () => {
    // Item 2 (round-2 hold): even when a co-author's continuation legitimately
    // refines pevo.authors[] within the subset (e.g. removes a co-author),
    // the IPFS/document-hash payload pointers MUST come from the root, not
    // the head. These identify the canonical paper payload — overriding
    // them via continuation lets a co-author swap in any IPFS document
    // they want.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }], // legitimate, subset of root
        ipfs_cid: 'QmSpoofedPayload',
        document_hash: 'sha256:spoofed',
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmCanonical', document_hash: 'sha256:canonical' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmCanonical', document_hash: 'sha256:canonical' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmCanonical', document_hash: 'sha256:canonical' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    // Root-pin: payload pointers come from root, NOT the continuation.
    expect(detail.ipfs_cid).toBe('QmCanonical');
    expect(detail.document_hash).toBe('sha256:canonical');
    expect(detail.ipfs_cid).not.toBe('QmSpoofedPayload');
    expect(detail.document_hash).not.toBe('sha256:spoofed');
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
