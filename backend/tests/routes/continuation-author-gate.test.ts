/**
 * Continuation-author consent-gate canary tests.
 *
 * Pins the gate added in BACKEND-CONTINUATION-POST-AUTHOR-CONSENT-GATE
 * and extended in BACKEND-MULTI-AUTHOR-CUMULATIVE-UNION:
 * `resolveContinuationChain` admits a continuation post `C` at hop N into
 * a paper's version chain only when BOTH:
 *   1. `C.author` is in the **cumulative union** of `pevo.authors[].hive`
 *      across chain posts `0..N-1` (the union starts at the root's
 *      contribution and grows as each admitted candidate's
 *      `pevo.authors[]` contributes new hives — encoding the equal-rights
 *      authorship policy). Bridge papers stay locked to
 *      `{config.hiveBridgeAccount}` by construction (the bridge carve-out
 *      in `extractAuthorizedContinuationAuthors`).
 *   2. `C` is itself a valid PEvO paper class (native paper, or
 *      bridge-paper variant pinned to the bridge account).
 *
 * Plus the cumulative-union display construction:
 *   - `detail.authors[]` is the cumulative union with sub-fields resolved
 *     (most-recent self-claim wins; else most-recent fallback claim).
 *   - ORCID is server-overridden for accredited hives whose claim
 *     differs from the on-chain accredited ORCID; mismatch emits an
 *     `orcid_claim_mismatch` audit warn.
 *   - Per-version display for `pevo.ipfs_cid` / `pevo.document_hash` /
 *     `pevo.ipfs_filename` (round-5 atomic-triple sentinel-aware
 *     fallback to root, unchanged).
 *   - Drops are forbidden by construction — the union only grows; no
 *     chain post can remove a hive that another chain post added. This
 *     supersedes the round-3 no-shrink check
 *     (`continuation_authors_shrink_violation` event removed).
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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const helpers = await import('../../src/helpers.js');
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

// File-level spy-cleanup guard. Without this, vi.spyOn called twice on
// the same logger method across different `it()` bodies returns the
// EXISTING spy (vitest contract: "If the method is already a spy, vi.spyOn
// returns the existing spy") and the second test sees the first test's
// mock.calls history. Mirrors the equivalent guard in
// `canonical-root-walker.test.ts`.
afterEach(() => {
  vi.restoreAllMocks();
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
    // Bridge papers are immutable post-publish; the bridge account vouches
    // for original-preprint authors who lack on-chain identity, gating
    // continuations (reviews/discussions only) on the bridge account.
    // pevo.authors[] entries carry hive: null since original-preprint
    // authors don't have on-chain identity. Deferring to pevo.authors[]
    // would yield an empty set and block ALL continuations of bridge
    // papers — the design choice (Option b carve-out) is that the bridge
    // account vouches on their behalf, now strictly defense-in-depth under
    // the immutability policy.
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
    // set is `{config.hiveBridgeAccount}` itself — bridge papers are
    // immutable post-publish, so the bridge account vouches for original-
    // preprint authors who lack on-chain identity, gating continuations
    // (reviews/discussions only) on the bridge account. The Option-b carve-
    // out is now strictly defense-in-depth under the immutability policy.
    // A continuation by ANY non-bridge account (including a putative
    // original author or an attacker) is excluded.
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
        // The bridge account legitimately continues (Option-b carve-out
        // under the bridge-paper immutability policy):
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

  // ────────────────────────────────────────────────────────────────
  // Cumulative-union display canaries
  // (`backend-multi-author-cumulative-union.md` acceptance #9)
  // ────────────────────────────────────────────────────────────────

  /** SQL pattern matchers for accreditation lookups. */
  function isAccreditedSetSql(sql: string): boolean {
    return /SELECT\s+account\s+FROM\s+active_accreditations\b/i.test(sql);
  }
  function isAccreditedOrcidsSql(sql: string): boolean {
    return /SELECT\s+account,\s*orcid\s+FROM\s+active_accreditations\b/i.test(sql);
  }
  /** Mock paper-detail SELECT row for a multi-link chain seed.
   *  BACKEND-PAPERS-CANONICAL-ORCID-RESOLUTION wrapped the paper SELECT
   *  with `activeAccreditationsCteBody(4)` so `parent_permlink` shifted
   *  from `$3` to `$4`. The discriminator accepts both forms so this
   *  test file stays robust across future param re-layouts. */
  function paperDetailSelectSql(sql: string): boolean {
    return sql.includes('SELECT c.author, c.permlink, c.title') && /parent_permlink = \$\d+/.test(sql);
  }
  /** Mock the head-authors lookup probe. */
  function headAuthorsLookupSql(sql: string): boolean {
    return sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3');
  }
  /** Mock the multi-version reconstruction SELECT. */
  function reconstructVersionsSql(sql: string): boolean {
    return sql.includes('ROW_NUMBER') && sql.includes('co.block_num');
  }

  /**
   * Seed a 2-link chain: alice/p1 (root with `rootAuthors`) → bob/v2
   * (continuation by bob with `headAuthors`). Both posts get installed
   * into the head-authors-lookup, paper-detail-select, version
   * reconstruction, and forward-walker responders. Accreditation
   * lookups default to empty (no accredited accounts) unless overridden
   * via `accredited` / `accreditedOrcids` params.
   */
  function seedTwoLinkChain(opts: {
    rootAuthors: Array<Record<string, unknown>>;
    headAuthors: Array<Record<string, unknown>>;
    rootPevoExtra?: Record<string, unknown>;
    headPevoExtra?: Record<string, unknown>;
    accredited?: string[];
    accreditedOrcids?: Array<{ account: string; orcid: string | null }>;
    extraResponder?: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] } | null>;
  }) {
    const rootMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: opts.rootAuthors, ...(opts.rootPevoExtra ?? {}) },
    };
    const headMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: opts.headAuthors, ...(opts.headPevoExtra ?? {}) },
    };
    const rootRow = {
      author: 'alice', permlink: 'p1', title: 'Root title', body: 'abstract\n\n---\n\nbody',
      json_metadata: rootMeta,
      created: '2026-01-01T00:00:00.000Z', last_edited: '2026-01-01T00:00:00.000Z',
    };
    installResponder(async (sql, params) => {
      const extra = opts.extraResponder ? await opts.extraResponder(sql, params) : null;
      if (extra) return extra;
      if (isAccreditedSetSql(sql)) {
        return { rows: (opts.accredited ?? []).map((account) => ({ account })) };
      }
      if (isAccreditedOrcidsSql(sql)) {
        return { rows: opts.accreditedOrcids ?? [] };
      }
      if (headAuthorsLookupSql(sql)) {
        return { rows: [rootRow] };
      }
      if (paperDetailSelectSql(sql)) {
        return { rows: [rootRow] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice' && params[1] === 'p1') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: headMeta }] };
        }
        return { rows: [] };
      }
      if (reconstructVersionsSql(sql)) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 'Root title', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: rootMeta },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 'V2 title', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: headMeta },
        ] };
      }
      return { rows: [] };
    });
  }

  it('cumulative union admits all hives across the chain (root + head)', async () => {
    // Acceptance #1: chain `[root, bob/v2]`. Root has [alice, bob]; bob/v2
    // adds carol. Display authors[] = [alice, bob, carol] in
    // first-occurrence order.
    seedTwoLinkChain({
      rootAuthors: [{ hive: 'alice' }, { hive: 'bob' }],
      headAuthors: [{ hive: 'alice' }, { hive: 'bob' }, { hive: 'carol' }],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail.head_author).toBe('bob');
    const hives = ((detail.authors || []) as Array<{ hive?: string }>).map((a) => a.hive);
    expect(hives).toEqual(['alice', 'bob', 'carol']);
  });

  it('drops are silently ignored under cumulative-union (forbidden by construction)', async () => {
    // Acceptance #2: bob/v2 drops alice from his pevo.authors[]
    // (insider-abuse vector). Cumulative union retains alice from root
    // post; display authors[] still includes alice. No
    // `continuation_authors_shrink_violation` event fires (event removed
    // — drops are mathematically impossible under cumulative-union).
    const warnSpy = vi.spyOn(logger, 'warn');
    seedTwoLinkChain({
      rootAuthors: [{ hive: 'alice' }, { hive: 'bob' }],
      headAuthors: [{ hive: 'bob' }], // insider drops alice
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail.head_author).toBe('bob');
    const hives = ((detail.authors || []) as Array<{ hive?: string }>).map((a) => a.hive);
    expect(hives).toContain('alice');
    expect(hives).toContain('bob');
    // No shrink-violation event fired (event class removed).
    const fired = warnSpy.mock.calls.find(([payload]) => {
      return typeof payload === 'object' && payload !== null
        && (payload as { event?: string }).event === 'continuation_authors_shrink_violation';
    });
    expect(fired).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('self-claim wins for sub-fields (most-recent self-claim by the hive about itself)', async () => {
    // Acceptance #3: root has alice with name "Alice Smith" + bob with
    // name "Robert Bob". bob/v2 has alice with no name + bob with name
    // "Bob Smith" (his self-claim). Display: alice's name = "Alice
    // Smith" (her self-claim from root); bob's name = "Bob Smith" (his
    // most-recent self-claim).
    seedTwoLinkChain({
      rootAuthors: [
        { hive: 'alice', name: 'Alice Smith' },
        { hive: 'bob', name: 'Robert Bob' },
      ],
      headAuthors: [
        { hive: 'alice' },
        { hive: 'bob', name: 'Bob Smith' },
      ],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    const authors = ((res.body?.data.authors || []) as Array<{ hive?: string; name?: string }>);
    const aliceEntry = authors.find((a) => a.hive === 'alice');
    const bobEntry = authors.find((a) => a.hive === 'bob');
    expect(aliceEntry?.name).toBe('Alice Smith');
    expect(bobEntry?.name).toBe('Bob Smith');
  });

  it('fallback to most-recent claim when no self-claim exists for a hive', async () => {
    // Acceptance #4: bob's continuation adds carol with a fallback
    // name. carol hasn't broadcast her own continuation. Display:
    // carol's name = bob's claim about her (most-recent fallback).
    seedTwoLinkChain({
      rootAuthors: [{ hive: 'alice' }, { hive: 'bob' }],
      headAuthors: [
        { hive: 'alice' },
        { hive: 'bob' },
        { hive: 'carol', name: 'Initial Guess' },
      ],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    const authors = ((res.body?.data.authors || []) as Array<{ hive?: string; name?: string }>);
    const carolEntry = authors.find((a) => a.hive === 'carol');
    expect(carolEntry?.name).toBe('Initial Guess');
  });

  it('self-claim updates fallback once the hive broadcasts a self-claim', async () => {
    // Acceptance #5: 3-link chain. bob's continuation adds carol with
    // name "Initial Guess"; carol's own continuation claims name "Carol
    // Real". Display: carol's name = "Carol Real" (self-claim wins over
    // the prior fallback).
    const carolMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [
          { hive: 'alice' },
          { hive: 'bob' },
          { hive: 'carol', name: 'Carol Real' },
        ],
      },
    };
    seedTwoLinkChain({
      rootAuthors: [{ hive: 'alice' }, { hive: 'bob' }],
      headAuthors: [
        { hive: 'alice' },
        { hive: 'bob' },
        { hive: 'carol', name: 'Initial Guess' },
      ],
      extraResponder: async (sql, params) => {
        if (isForwardChainWalkSql(sql)) {
          // Hop 1: alice/p1 → bob/v2 (default seed handles).
          // Hop 2: bob/v2 → carol/v3 (additional admission).
          if (params[0] === 'bob' && params[1] === 'v2') {
            return { rows: [{ author: 'carol', permlink: 'v3', block_num: 200, json_metadata: carolMeta }] };
          }
        }
        if (reconstructVersionsSql(sql)) {
          return { rows: [
            { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 'Root title', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] } } },
            { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 'V2 title', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }, { hive: 'carol', name: 'Initial Guess' }] } } },
            { version_number: 3, block_num: 200, author: 'carol', permlink: 'v3', title: 'V3 title', body: 'abstract3\n\n---\n\nbody3', created: '2026-01-03T00:00:00.000Z', json_metadata: carolMeta },
          ] };
        }
        return null;
      },
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail.head_author).toBe('carol');
    expect(detail.head_permlink).toBe('v3');
    const carolEntry = ((detail.authors || []) as Array<{ hive?: string; name?: string }>).find((a) => a.hive === 'carol');
    expect(carolEntry?.name).toBe('Carol Real');
  });

  it('ORCID server override fires for accredited-vs-claimed mismatch (audit event + display override)', async () => {
    // Acceptance #6: alice's most-recent winning entry (whole-entry rule
    // #2) carries an ORCID that disagrees with her on-chain accreditation
    // — here, the spoof source is alice's own self-claim post (the rule
    // governs the resolved entry regardless of whether the wrong ORCID
    // came from a self-claim or a fallback claim; mismatch fires the
    // same way). Display: alice's ORCID = the accredited value (server
    // override). Audit event `orcid_claim_mismatch` fires with the diff
    // and a `claimSource` pointing at the post that contributed the
    // wrong claim.
    const warnSpy = vi.spyOn(logger, 'warn');
    seedTwoLinkChain({
      // Alice's self-claim from her own root post carries a wrong ORCID;
      // bob's continuation does not re-claim alice's ORCID. Under the
      // whole-entry self-claim rule, alice's winning entry is from the
      // root (her self-claim), and claimedOrcid is the wrong one.
      rootAuthors: [{ hive: 'alice', orcid: 'wrong-orcid' }, { hive: 'bob' }],
      headAuthors: [
        { hive: 'alice' },
        { hive: 'bob' },
      ],
      accredited: ['alice', 'bob'],
      accreditedOrcids: [
        { account: 'alice', orcid: '0000-0000-0000-1234' },
        { account: 'bob', orcid: '0000-0000-0000-5678' },
      ],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const aliceEntry = ((res.body?.data.authors || []) as Array<{ hive?: string; orcid?: string }>).find((a) => a.hive === 'alice');
    expect(aliceEntry?.orcid).toBe('0000-0000-0000-1234');
    const fired = warnSpy.mock.calls.find(([payload]) => {
      return typeof payload === 'object' && payload !== null
        && (payload as { event?: string }).event === 'orcid_claim_mismatch';
    });
    expect(fired).toBeDefined();
    const event = fired![0] as Record<string, unknown>;
    expect(event.hive).toBe('alice');
    expect(event.claimedOrcid).toBe('wrong-orcid');
    expect(event.accreditedOrcid).toBe('0000-0000-0000-1234');
    expect(event.rootAuthor).toBe('alice');
    expect(event.rootPermlink).toBe('p1');
    // claimSource is the chain post that contributed the winning entry
    // (here: alice's own root post — her self-claim wins under rule #2).
    expect(event.claimSource).toBe('alice/p1');
    warnSpy.mockRestore();
  });

  it('ORCID passes through unchanged when claim matches accreditation (no mismatch event)', async () => {
    // Acceptance #7: alice's claimed ORCID matches her accredited
    // ORCID. No audit event; display passes the matching value through.
    const warnSpy = vi.spyOn(logger, 'warn');
    seedTwoLinkChain({
      rootAuthors: [{ hive: 'alice', orcid: '0000-0000-0000-1234' }, { hive: 'bob' }],
      headAuthors: [
        { hive: 'alice', orcid: '0000-0000-0000-1234' },
        { hive: 'bob' },
      ],
      accredited: ['alice'],
      accreditedOrcids: [{ account: 'alice', orcid: '0000-0000-0000-1234' }],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    const aliceEntry = ((res.body?.data.authors || []) as Array<{ hive?: string; orcid?: string }>).find((a) => a.hive === 'alice');
    expect(aliceEntry?.orcid).toBe('0000-0000-0000-1234');
    const fired = warnSpy.mock.calls.find(([payload]) => {
      return typeof payload === 'object' && payload !== null
        && (payload as { event?: string }).event === 'orcid_claim_mismatch';
    });
    expect(fired).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('non-accredited ORCID claim passes through (no override, no audit)', async () => {
    // Acceptance #8: carol is NOT accredited. bob's continuation lists
    // carol with arbitrary ORCID. Display: carol's ORCID = bob's claim
    // unchanged. No audit event.
    const warnSpy = vi.spyOn(logger, 'warn');
    seedTwoLinkChain({
      rootAuthors: [{ hive: 'alice' }, { hive: 'bob' }],
      headAuthors: [
        { hive: 'alice' },
        { hive: 'bob' },
        { hive: 'carol', orcid: 'whatever-non-accredited' },
      ],
      accredited: ['alice', 'bob'], // carol not accredited
      accreditedOrcids: [
        { account: 'alice', orcid: '0000-0000-0000-1234' },
        { account: 'bob', orcid: '0000-0000-0000-5678' },
      ],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    const carolEntry = ((res.body?.data.authors || []) as Array<{ hive?: string; orcid?: string }>).find((a) => a.hive === 'carol');
    expect(carolEntry?.orcid).toBe('whatever-non-accredited');
    const fired = warnSpy.mock.calls.find(([payload]) => {
      return typeof payload === 'object' && payload !== null
        && (payload as { event?: string }).event === 'orcid_claim_mismatch';
    });
    expect(fired).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('per-hop cumulative admit-set admits an author added mid-chain', async () => {
    // Acceptance #9: root has [alice, bob]; bob/v2 adds carol;
    // carol/v3 attempts to broadcast. v3 admitted because carol is in
    // the cumulative set after hop 1. Without cumulative, v3 would be
    // rejected (carol not in root's authors[]).
    const carolMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }, { hive: 'carol' }] },
    };
    seedTwoLinkChain({
      rootAuthors: [{ hive: 'alice' }, { hive: 'bob' }],
      headAuthors: [{ hive: 'alice' }, { hive: 'bob' }, { hive: 'carol' }],
      extraResponder: async (sql, params) => {
        if (isForwardChainWalkSql(sql)) {
          if (params[0] === 'bob' && params[1] === 'v2') {
            // Verify the cumulative array passed to ANY() includes carol
            // (added by bob/v2's contribution to the cumulative).
            assertChainWalkAuthorFilter(sql, params, ['alice', 'bob', 'carol']);
            return { rows: [{ author: 'carol', permlink: 'v3', block_num: 200, json_metadata: carolMeta }] };
          }
        }
        if (reconstructVersionsSql(sql)) {
          return { rows: [
            { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 'Root title', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] } } },
            { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 'V2 title', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }, { hive: 'carol' }] } } },
            { version_number: 3, block_num: 200, author: 'carol', permlink: 'v3', title: 'V3 title', body: 'abstract3\n\n---\n\nbody3', created: '2026-01-03T00:00:00.000Z', json_metadata: carolMeta },
          ] };
        }
        return null;
      },
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail.head_author).toBe('carol');
    expect(detail.head_permlink).toBe('v3');
  });

  it('per-hop cumulative admit-set rejects outsiders (mallory not anywhere in the chain)', async () => {
    // Acceptance #10: mallory is not in root's authors[] and was never
    // added by any chain post. Forward walker hop 0 rejects mallory's
    // continuation candidate via the cumulative SQL filter (mallory NOT
    // in cumulativeArr).
    seedTwoLinkChain({
      rootAuthors: [{ hive: 'alice' }, { hive: 'bob' }],
      headAuthors: [{ hive: 'alice' }, { hive: 'bob' }], // no mallory anywhere
      extraResponder: async (sql, params) => {
        if (isForwardChainWalkSql(sql) && params[0] === 'alice' && params[1] === 'p1') {
          // Sanity-check: mallory is NOT in the bound cumulative array.
          const m = sql.match(/c\.author\s*=\s*ANY\s*\(\s*\$(\d+)::text\[\]\s*\)/);
          if (m) {
            const idx = Number(m[1]);
            const bound = params[idx - 1] as string[];
            expect(bound).not.toContain('mallory');
          }
          return { rows: [] }; // SQL gate excludes mallory
        }
        return null;
      },
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const hives = ((res.body?.data.authors || []) as Array<{ hive?: string }>).map((a) => a.hive);
    expect(hives).not.toContain('mallory');
  });

  it('accredited_authors rebuilt from cumulative union (closes round-3 finding #1 leak)', async () => {
    // Acceptance #12: bob (vouched) drops alice from his head metadata,
    // but the cumulative union still carries alice. accredited_authors
    // must include alice (assuming accredited) — reading from
    // detail.authors (the union), NOT detail.json_metadata's head pevo
    // (which would have only bob). Closes round-3 finding #1.
    seedTwoLinkChain({
      rootAuthors: [{ hive: 'alice' }, { hive: 'bob' }],
      headAuthors: [{ hive: 'bob' }], // head drops alice
      accredited: ['alice', 'bob'],
      accreditedOrcids: [],
    });
    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail.accredited_authors).toContain('alice');
    expect(detail.accredited_authors).toContain('bob');
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
        ipfs_cid: 'QmHeadCidAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        document_hash: 'sha256:head',
        ipfs_filename: 'head.pdf',
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
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
    expect(detail.ipfs_cid).toBe('QmHeadCidAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
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
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
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
    expect(detail.ipfs_cid).toBe('QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
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
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
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
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
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
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
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
    // Head supplies `ipfs_cid: 'QmHeadCidAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'` (valid) plus pathological values
    // for the other two. Atomic triple: head wins for the entire triple
    // (head expressed an opinion via the valid CID); the other two collapse
    // to null because pevoString narrows 0 / '' → null. Root's PDF is NOT
    // surfaced — head's view is what the response carries.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }],
        ipfs_cid: 'QmHeadCidAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        ipfs_filename: 0,
        document_hash: '',
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe('QmHeadCidAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(detail.ipfs_filename).toBe(null);
    expect(detail.document_hash).toBe(null);
  });

  it('rejects asymmetric Frankenstein composition: head supplies two of the three keys, third is missing (round-5 atomic-triple)', async () => {
    // Head supplies `ipfs_cid: 'QmHeadCidAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ipfs_filename: 0` — two keys
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
        ipfs_cid: 'QmHeadCidAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        ipfs_filename: 0,
        // document_hash intentionally omitted — not present on head
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe('QmHeadCidAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
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
    // `expect ipfs_cid to be null but received 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'`.
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
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
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
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
          { version_number: 2, block_num: 100, author: 'bob', permlink: 'v2', title: 't2', body: 'abstract2\n\n---\n\nbody2', created: '2026-01-02T00:00:00.000Z', json_metadata: continuationMeta },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe('QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    expect(detail.ipfs_filename).toBe('root.pdf');
    expect(detail.document_hash).toBe('sha256:root');
  });

  // Round-6 hold item 3: OR-arm-deletion mutation kill canaries. The
  // sentinel predicate at papers.ts is `'ipfs_cid' in headPevo ||
  // 'ipfs_filename' in headPevo || 'document_hash' in headPevo`. Every
  // prior "head wins" canary in this suite sets `ipfs_cid` as a present
  // key, so a mutation that deletes either of the latter two OR arms
  // (or collapses the predicate to just `'ipfs_cid' in headPevo`)
  // leaves all of them green. These two canaries (head expressing ONLY
  // `document_hash`, then head expressing ONLY `ipfs_filename`) close
  // that gap: each head shape activates exactly one of the two
  // non-`ipfs_cid` OR arms, so deleting that arm flips the head-wins
  // path into the root-fallback branch and the canary fails.
  it('admits head\'s triple as document_hash-only when head expresses ONLY document_hash (round-6 OR-arm-kill)', async () => {
    // Head's pevo metadata expresses ONLY `document_hash` (no
    // `ipfs_cid`, no `ipfs_filename`). Root has the full triple.
    // Under round-5's atomic block: `'document_hash' in headPevo` is
    // true → head wins → ipfs_cid and ipfs_filename collapse to null
    // (absent on head; pevoString returns null), document_hash
    // surfaces head's value.
    //
    // Mutation kill: revert `'document_hash' in headPevo` from the
    // OR predicate (or collapse the predicate to
    // `'ipfs_cid' in headPevo`) and the predicate becomes false →
    // root branch fires → document_hash surfaces as 'sha256:root'
    // instead of 'sha256:head-only'. Test FAILS with
    // `expect document_hash to be 'sha256:head-only' but received
    // 'sha256:root'`.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }],
        document_hash: 'sha256:head-only',
        // no ipfs_cid, no ipfs_filename — head expresses only document_hash
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
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
    expect(detail.document_hash).toBe('sha256:head-only');
  });

  it('admits head\'s triple as ipfs_filename-only when head expresses ONLY ipfs_filename (round-6 OR-arm-kill)', async () => {
    // Head's pevo metadata expresses ONLY `ipfs_filename` (no
    // `ipfs_cid`, no `document_hash`). Root has the full triple.
    // Under round-5's atomic block: `'ipfs_filename' in headPevo` is
    // true → head wins → ipfs_cid and document_hash collapse to null,
    // ipfs_filename surfaces head's value.
    //
    // Mutation kill: revert `'ipfs_filename' in headPevo` from the
    // OR predicate (or collapse the predicate to
    // `'ipfs_cid' in headPevo`) and the predicate becomes false →
    // root branch fires → ipfs_filename surfaces as 'root.pdf'
    // instead of 'head-only.pdf'. Test FAILS with
    // `expect ipfs_filename to be 'head-only.pdf' but received
    // 'root.pdf'`.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: {
        type: 'paper',
        authors: [{ hive: 'alice' }, { hive: 'bob' }],
        ipfs_filename: 'head-only.pdf',
        // no ipfs_cid, no document_hash — head expresses only ipfs_filename
      },
    };
    installResponder(async (sql, params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'], { ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' })] };
      }
      if (isForwardChainWalkSql(sql)) {
        if (params[0] === 'alice') {
          return { rows: [{ author: 'bob', permlink: 'v2', block_num: 100, json_metadata: continuationMeta }] };
        }
        return { rows: [] };
      }
      if (sql.includes('ROW_NUMBER') && sql.includes('co.block_num')) {
        return { rows: [
          { version_number: 1, block_num: 1, author: 'alice', permlink: 'p1', title: 't', body: 'abstract\n\n---\n\nbody', created: '2026-01-01T00:00:00.000Z', json_metadata: { app: `${config.appTag}/test`, [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmRootCidBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', document_hash: 'sha256:root', ipfs_filename: 'root.pdf' } } },
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
    expect(detail.ipfs_filename).toBe('head-only.pdf');
    expect(detail.document_hash).toBe(null);
  });

  it('?version=N retrieves per-version ipfs_cid (regression pin)', async () => {
    // Round-3 hold item 2: ipfs_cid is preserved per-version on chain.
    // The dedicated ?version=N path reads each version's metadata
    // directly via reconstructVersionsFromHaf — alice's v1 surfaces
    // its CID, bob's v2 surfaces its (different) CID.
    const v1Meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmV1CidCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', document_hash: 'sha256:v1' },
    };
    const v2Meta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }], ipfs_cid: 'QmV2CidDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', document_hash: 'sha256:v2' },
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
    expect(v1.body?.data?.ipfs_cid).toBe('QmV1CidCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');
    expect(v1.body?.data?.document_hash).toBe('sha256:v1');

    const v2 = await request(app).get('/api/papers/alice/p1?version=2');
    expect(v2.status).toBe(200);
    expect(v2.body?.data?.ipfs_cid).toBe('QmV2CidDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD');
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

  it('detects 2-node cycle (alice/v1 → bob/v1 → alice/v1) on forward walk and stops with cycle event', async () => {
    // Attacker-posted cycle: alice and bob are mutually in each other's
    // pevo.authors[] (cumulative-union admits both directions), so the
    // SQL author-set gate and the JS-side gate both admit the cycle. The
    // forward walker has no depth-cap warn event (per the wall-clock test
    // pair below: it exits silently at MAX_HOPS=50), so without cycle
    // detection an attacker-posted cycle burns 50 chain-walk SQL queries
    // per request silently.
    //
    // Mutation kill: remove the `visited` Set check inside the loop. The
    // walker advances 50 times alternating alice ↔ bob → no cycle event
    // emits → walks.length jumps from ~2 to ~50, failing both the
    // `expect(cycleEvents.length).toBeGreaterThan(0)` AND the
    // `expect(walks.length).toBeLessThan(...)` assertions red.
    const mutualPevoMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] },
    };

    installResponder(async (sql, params) => {
      // Suppress backward walker (initial probe carries IS NOT NULL → 0 rows).
      if (/'continues'\s*IS\s+NOT\s+NULL/i.test(sql)) {
        return { rows: [] };
      }
      // Head authorized-authors lookup (used by both gate-seed and the
      // per-link JS defense-in-depth re-checks).
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        const a = params[0];
        if (a === 'alice' || a === 'bob') {
          return { rows: [pevoPaperRow(a, params[1] as string, ['alice', 'bob'])] };
        }
        return { rows: [] };
      }
      // Paper-detail SELECT.
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'v1', ['alice', 'bob'])] };
      }
      // Forward chain-walk: return the candidate that continues (params[0], params[1]).
      if (isForwardChainWalkSql(sql)) {
        const currentA = params[0] as string;
        const currentP = params[1] as string;
        if (currentA === 'alice' && currentP === 'v1') {
          return { rows: [{ author: 'bob', permlink: 'v1', block_num: 100, json_metadata: mutualPevoMeta }] };
        }
        if (currentA === 'bob' && currentP === 'v1') {
          return { rows: [{ author: 'alice', permlink: 'v1', block_num: 200, json_metadata: mutualPevoMeta }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await request(app).get('/api/papers/alice/v1');
    expect(res.status).toBe(200);

    const cycleEvents = warnSpy.mock.calls
      .map((c) => c[0] as { event?: string; hopIndex?: number; cycleAuthor?: string; cyclePermlink?: string } | undefined)
      .filter((e) => e?.event === 'continuation_chain_cycle_detected');
    expect(cycleEvents.length).toBeGreaterThan(0);

    // Chain-walk SQL count well below MAX_HOPS=50. Without cycle detection
    // this walk would alternate alice ↔ bob for the full 50 hops.
    const walks = chainWalkCaptures();
    expect(walks.length).toBeLessThan(10);

    warnSpy.mockRestore();
  });

  it('detects 3-node cycle (alice/v1 → bob/v1 → carol/v1 → alice/v1) on forward walk', async () => {
    // 3-node cycle verifies the visited Set is real (not a "back-edge to
    // immediate predecessor" check, which would mis-pass a 2-cycle while
    // letting an N-cycle slip through). Cumulative-union of authors across
    // the chain (alice + bob + carol) admits all three directions.
    //
    // Mutation kill: replace `visited.has(visitedKey)` with a check against
    // only the immediately previous chain link → 3-cycle walks to MAX_HOPS
    // silently → cycleEvents.length drops to 0.
    const tripleAuthors = [{ hive: 'alice' }, { hive: 'bob' }, { hive: 'carol' }];
    const triplePevoMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: tripleAuthors },
    };

    installResponder(async (sql, params) => {
      if (/'continues'\s*IS\s+NOT\s+NULL/i.test(sql)) {
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        const a = params[0];
        if (a === 'alice' || a === 'bob' || a === 'carol') {
          return { rows: [pevoPaperRow(a, params[1] as string, ['alice', 'bob', 'carol'])] };
        }
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'v1', ['alice', 'bob', 'carol'])] };
      }
      if (isForwardChainWalkSql(sql)) {
        const currentA = params[0] as string;
        const currentP = params[1] as string;
        // alice → bob → carol → alice (cycle).
        if (currentA === 'alice' && currentP === 'v1') {
          return { rows: [{ author: 'bob', permlink: 'v1', block_num: 100, json_metadata: triplePevoMeta }] };
        }
        if (currentA === 'bob' && currentP === 'v1') {
          return { rows: [{ author: 'carol', permlink: 'v1', block_num: 200, json_metadata: triplePevoMeta }] };
        }
        if (currentA === 'carol' && currentP === 'v1') {
          return { rows: [{ author: 'alice', permlink: 'v1', block_num: 300, json_metadata: triplePevoMeta }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await request(app).get('/api/papers/alice/v1');
    expect(res.status).toBe(200);

    const cycleEvents = warnSpy.mock.calls
      .map((c) => c[0] as { event?: string } | undefined)
      .filter((e) => e?.event === 'continuation_chain_cycle_detected');
    expect(cycleEvents.length).toBeGreaterThan(0);

    const walks = chainWalkCaptures();
    expect(walks.length).toBeLessThan(10);

    warnSpy.mockRestore();
  });

  it('wall-clock budget: aborts forward walker mid-walk, emits continuation_chain_wall_clock_exceeded', async () => {
    // BACKEND-HAF-WALKER-WALL-CLOCK-BUDGET acceptance #4 canary for the
    // FORWARD walker. The backward walker is suppressed (its initial
    // probe returns 0 rows so findCanonicalRoot bails at
    // sql_filter_or_missing at debug, NOT capturing budget time). Only
    // the forward walker's chain-walk SQL queries are delayed (~80ms).
    // Budget 50ms → after ~one chain-walk SQL, the abort fires; the
    // iteration-boundary `if (signal?.aborted)` check emits the
    // wall-clock warn and returns the chain-so-far.
    //
    // This shape pins the FORWARD walker's iteration-boundary check
    // specifically; the elapsedMs assertion fails red on the pre-loop
    // check alone, so a mutation that deletes the iteration check
    // (leaving only the pre-loop check) flips elapsedMs from ~80 to ~0.
    //
    // Mutation-kill: remove the iteration-boundary `signal?.aborted`
    // check in `resolveContinuationChain` → walker runs to depth cap
    // regardless of budget → wall-clock event count drops (only the
    // pre-loop emission, which won't fire because signal isn't aborted
    // pre-loop in this responder shape) → canary fails red.
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] },
    };
    installResponder(async (sql, params) => {
      // Backward walker initial probe (the IS NOT NULL discriminator)
      // returns 0 rows so findCanonicalRoot bails at sql_filter_or_missing
      // (debug, not captured by the warn spy). Fast — no delay so the
      // budget doesn't trip during the backward walker.
      if (/'continues'\s*IS\s+NOT\s+NULL/i.test(sql)) {
        return { rows: [] };
      }
      // Head authorized-authors lookup and paper-detail SELECT are fast
      // too — only the forward walker's chain-walk SQL bears the delay.
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (isForwardChainWalkSql(sql)) {
        // Slow only the forward walker. Each chain-walk query takes
        // ~80ms; with a 50ms budget, the abort fires DURING the first
        // chain-walk query's await. At iter 1's top, signal.aborted is
        // true → emit + return chain so far.
        await new Promise((r) => setTimeout(r, 80));
        const currentAuthor = params[0];
        const currentPermlink = params[1];
        const nextAuthor = currentAuthor === 'alice' ? 'bob' : 'alice';
        return {
          rows: [{
            author: nextAuthor,
            permlink: `${currentPermlink}-cont`,
            block_num: 100 + captured.length,
            json_metadata: continuationMeta,
          }],
        };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const originalBudget = config.hafWalkerWallClockMs;
    (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = 50;
    try {
      const res = await request(app).get('/api/papers/alice/p1');
      // Round-2 item 4 (P2 reliability): walker-aborted requests surface
      // as 503 so HTTP-status monitors catch degraded HAF. Pre-round-2
      // returned 200 with possibly-stale or partial-chain data.
      expect(res.status).toBe(503);

      const wallClockEvents = warnSpy.mock.calls
        .map((c) => c[0] as { event?: string; hopIndex?: number; elapsedMs?: number } | undefined)
        .filter((e) => e?.event === 'continuation_chain_wall_clock_exceeded');
      expect(wallClockEvents.length).toBeGreaterThan(0);
      // The iteration-boundary check fires AFTER at least one chain-walk
      // query completed (~80ms elapsed). elapsedMs > 0 distinguishes
      // this from the pre-loop check (which would emit at ~0ms).
      expect(wallClockEvents[0]?.hopIndex).toBeGreaterThanOrEqual(0);
      expect(wallClockEvents[0]?.elapsedMs).toBeGreaterThan(0);

      // The chain-walk SQL count is bounded by the budget — well below
      // MAX_HOPS=50. Pin a generous upper bound robust to timing jitter
      // while still rejecting the unbounded-walker mutation.
      const walks = chainWalkCaptures();
      expect(walks.length).toBeLessThan(20);
    } finally {
      (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = originalBudget;
    }
  });

  it('forward walker does NOT emit wall-clock event on fast HAF (orthogonal signal pinning)', async () => {
    // BACKEND-HAF-WALKER-WALL-CLOCK-BUDGET acceptance #4 paired canary.
    //
    // The forward walker has no separate depth-cap event (it exits
    // silently at MAX_HOPS), so this canary's role is the negative
    // assertion: under fast HAF + generous budget, the wall-clock
    // signal does NOT false-fire on a benign no-continuations chain.
    // The signal is reserved for genuinely degraded HAF, not legitimate
    // traffic patterns.
    //
    // Mutation-kill: invert the signal check (treat `signal?.aborted`
    // as always-true) → wall-clock event fires on every request → this
    // canary's `events.length === 0` assertion fails red.
    installResponder(async (sql, _params) => {
      // Suppress backward walker (same pattern as the slow-HAF canary
      // above) so logger.warn isn't called for cont_columns_invalid.
      if (/'continues'\s*IS\s+NOT\s+NULL/i.test(sql)) {
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (isForwardChainWalkSql(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const originalBudget = config.hafWalkerWallClockMs;
    (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = 30000;
    try {
      const res = await request(app).get('/api/papers/alice/p1');
      expect(res.status).toBe(200);

      const wallClockEvents = warnSpy.mock.calls
        .map((c) => c[0] as { event?: string } | undefined)
        .filter((e) => e?.event === 'continuation_chain_wall_clock_exceeded');
      expect(wallClockEvents.length).toBe(0);
    } finally {
      (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = originalBudget;
    }
  });

  // Sibling-route DoS-amplifier closure: BACKEND-HAF-WALKER-WALL-CLOCK-BUDGET
  // round-2 hold item 2. Pre-fix only `GET /:author/:permlink` carried the
  // AbortController wrapper; `/cite`, `/retract`, `/enrichment` reached the
  // same forward walker via `fetchPaperDetailFromHaf` / `fetchEnrichmentFromHaf`
  // without a per-request budget, so the same attacker-posted long chains
  // under degraded HAF could starve worker threads on those three URLs.
  // These canaries pin the wrapper presence + the route's abort-detection
  // 503 surface. /retract is covered in retract.test.ts where auth is
  // mocked.

  // Slow-forward-walker responder reused by the 3 sibling-route canaries.
  // Lifted here as a helper because all three want the same shape:
  // backward walker suppressed (0 rows on initial probe), head/paper-detail
  // SELECTs fast (so the budget is only consumed by the forward-walker
  // chain-walk SQL), forward chain-walk SQL slowed to ~80ms (budget 50ms).
  function installSlowForwardResponder() {
    const continuationMeta = {
      app: `${config.appTag}/test`,
      [config.appTag]: { type: 'paper', authors: [{ hive: 'alice' }, { hive: 'bob' }] },
    };
    installResponder(async (sql, params) => {
      if (/'continues'\s*IS\s+NOT\s+NULL/i.test(sql)) {
        return { rows: [] };
      }
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [pevoPaperRow('alice', 'p1', ['alice', 'bob'])] };
      }
      if (isForwardChainWalkSql(sql)) {
        await new Promise((r) => setTimeout(r, 80));
        const currentAuthor = params[0];
        const currentPermlink = params[1];
        const nextAuthor = currentAuthor === 'alice' ? 'bob' : 'alice';
        return {
          rows: [{
            author: nextAuthor,
            permlink: `${currentPermlink}-cont`,
            block_num: 100 + captured.length,
            json_metadata: continuationMeta,
          }],
        };
      }
      return { rows: [] };
    });
  }

  it('/cite wraps walker in AbortController + surfaces 503 on wall-clock abort', async () => {
    // Mutation-kill: drop the AbortController wrapper from the /cite handler
    // (revert to bare `fetchPaperDetailFromHaf(author, permlink)` without
    // signal) → forward walker runs to depth cap regardless of budget →
    // wall-clock event never fires AND status stays 200/404, not 503 →
    // both assertions below fail red.
    installSlowForwardResponder();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const originalBudget = config.hafWalkerWallClockMs;
    (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = 50;
    try {
      const res = await request(app).get('/api/papers/alice/p1/cite?format=bibtex');
      expect(res.status).toBe(503);

      const wallClockEvents = warnSpy.mock.calls
        .map((c) => c[0] as { event?: string } | undefined)
        .filter((e) => e?.event === 'continuation_chain_wall_clock_exceeded');
      expect(wallClockEvents.length).toBeGreaterThan(0);
    } finally {
      (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = originalBudget;
    }
  });

  it('/enrichment wraps walker in AbortController + surfaces 503 on wall-clock abort', async () => {
    // Mutation-kill: drop the AbortController wrapper from the /enrichment
    // handler (revert resolveVersionsFromHaf back to its no-signal form
    // OR drop the wrapper but keep the signal param) → wall-clock event
    // count drops to 0 AND status becomes 200/404 → assertions fail red.
    installSlowForwardResponder();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const originalBudget = config.hafWalkerWallClockMs;
    (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = 50;
    try {
      const res = await request(app).get('/api/papers/alice/p1/enrichment');
      expect(res.status).toBe(503);

      const wallClockEvents = warnSpy.mock.calls
        .map((c) => c[0] as { event?: string } | undefined)
        .filter((e) => e?.event === 'continuation_chain_wall_clock_exceeded');
      expect(wallClockEvents.length).toBeGreaterThan(0);
    } finally {
      (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = originalBudget;
    }
  });
});

// ──────────────────────────────────────────────
// Output-side ipfs_cid emit-time validation
// ──────────────────────────────────────────────

/**
 * Pins the validation added in BACKEND-PAPER-DETAIL-CID-VALIDATE-ON-EMIT:
 * paper-detail responses MUST clear `ipfs_cid` to `null` (and emit a
 * structured `paper_detail_ipfs_cid_rejected` operator warn) when the
 * chain-supplied value fails the syntactic CID-shape predicate. This is
 * the integration canary at the buildPaperDetail emit site (no continuation
 * chain). Mutation kill: deleting the `validatedCid()` wrapper at
 * `routes/papers.ts:1067` lets a whitespace-padded CID surface unchanged
 * in the API response, failing this assertion red.
 *
 * The pure-predicate canary lives in `tests/lib/ipfs-validation.test.ts`;
 * this file only pins the wired-up emit path.
 */
describe('GET /api/papers/:author/:permlink — output-side ipfs_cid validation', () => {
  function paperRowWithCid(author: string, permlink: string, ipfsCid: string | null) {
    return {
      author,
      permlink,
      title: 't',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: {
        app: `${config.appTag}/test`,
        [config.appTag]: {
          type: 'paper',
          authors: [{ hive: author }],
          ipfs_cid: ipfsCid,
        },
      },
      created: '2026-01-01T00:00:00.000Z',
      last_edited: '2026-01-01T00:00:00.000Z',
    };
  }

  it('clears whitespace-padded ipfs_cid to null in response AND emits paper_detail_ipfs_cid_rejected warn', async () => {
    const paddedCid = '  QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG  ';
    const row = paperRowWithCid('alice', 'p1', paddedCid);
    installResponder(async (sql, _params) => {
      // Head paper authorized-authors lookup (continuation gate prefetch):
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [row] };
      }
      // Paper-detail SELECT (the actual fetch):
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [row] };
      }
      // No continuation chain.
      if (isForwardChainWalkSql(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);

    // Response carries null, NOT the padded value (the integrity goal).
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe(null);

    // Warn anchor fired with the structured event key + correlation context.
    const rejectCalls = warnSpy.mock.calls.filter((c) => {
      const arg = c[0] as Record<string, unknown> | undefined;
      return arg?.event === 'paper_detail_ipfs_cid_rejected';
    });
    expect(rejectCalls.length).toBeGreaterThan(0);
    const arg = rejectCalls[0][0] as Record<string, unknown>;
    expect(arg.author).toBe('alice');
    expect(arg.permlink).toBe('p1');
    expect(typeof arg.raw_cid_prefix).toBe('string');
    // Truncation guard against log injection: prefix len <= 32
    expect((arg.raw_cid_prefix as string).length).toBeLessThanOrEqual(32);

    warnSpy.mockRestore();
  });

  it('passes a valid CIDv0 through unchanged (no warn)', async () => {
    const validCid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const row = paperRowWithCid('alice', 'p1', validCid);
    installResponder(async (sql, _params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [row] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [row] };
      }
      if (isForwardChainWalkSql(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);

    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.ipfs_cid).toBe(validCid);

    // No paper_detail_ipfs_cid_rejected warns for a valid CID.
    const rejectCalls = warnSpy.mock.calls.filter((c) => {
      const arg = c[0] as Record<string, unknown> | undefined;
      return arg?.event === 'paper_detail_ipfs_cid_rejected';
    });
    expect(rejectCalls.length).toBe(0);

    warnSpy.mockRestore();
  });
});

describe('GET /api/papers/:author/:permlink — pevoString family adoption: route-level mutation-kill', () => {
  // Round-2 hold items 2 + 3a for backend-pevo-string-helper-adoption-sweep.
  //
  // Item 2 (pevoStringArray route-level mutation-kill): the keywords field is
  // read at four call sites via `pevoStringArray`. Existing route tests only
  // assert `toHaveProperty('keywords')` — they would pass whether the field
  // is `['neuroscience']` (filtered) or `[42, '', 'neuroscience']` (the
  // unfiltered cast pattern). This describe pins the filtering effect end-to-end
  // so reverting the migration at any of the 4 sites fails red.
  //
  // Item 3a (language fallback): both `fetchPaperDetailFromHaf` (head-meta
  // override) and `buildPaperDetail` use `pevoString(pevo, 'language') ?? 'en'`.
  // Single-version papers (no continuation) route through `buildPaperDetail` —
  // covered here. The integration with the head-meta override path is covered
  // by the existing per-version display canaries in the multi-version describe
  // block above (continuation-chain seed); a regression in either site that
  // collapsed `?? 'en'` to bare `pevoString(...)` would surface as `null`
  // here for the buildPaperDetail site.
  function paperRowWithFields(
    author: string,
    permlink: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      author,
      permlink,
      title: 't',
      body: 'abstract\n\n---\n\nbody',
      json_metadata: {
        app: `${config.appTag}/test`,
        [config.appTag]: {
          type: 'paper',
          authors: [{ hive: author }],
          ...extra,
        },
      },
      created: '2026-01-01T00:00:00.000Z',
      last_edited: '2026-01-01T00:00:00.000Z',
    };
  }

  it('keywords with mixed-type entries: response carries only the string entries (pevoStringArray filtering pinned end-to-end)', async () => {
    // Seed: a paper whose `pevo.keywords` contains `[42, '', 'neuroscience']`
    // — exactly the cast-pattern leak shape the migration closes. The
    // unfiltered cast `(pevo.keywords as string[]) || []` would surface
    // `[42, '', 'neuroscience']` in the response (numeric/empty leak through);
    // `pevoStringArray` narrows entries to non-empty strings only. Asserting
    // `['neuroscience']` pins the migration at the buildPaperDetail call site
    // (`papers.ts:1749`), which is the active code path for single-version
    // papers (no continuation chain). A revert at this site would surface
    // the numeric `42` and empty string and fail red.
    const row = paperRowWithFields('alice', 'p1', { keywords: [42, '', 'neuroscience'] });
    installResponder(async (sql, _params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [row] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [row] };
      }
      if (isForwardChainWalkSql(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.keywords).toEqual(['neuroscience']);
  });

  it('language absent: response defaults to "en" (pevoString(...) ?? "en" fallback pinned end-to-end)', async () => {
    // Seed: a paper whose `pevo.language` is absent. Pre-migration the read
    // was `headPevo.language || 'en'`; post-migration it is
    // `pevoString(pevo, 'language') ?? 'en'`. Both yield `'en'` here. A
    // regression that dropped the `?? 'en'` fallback would surface `null`
    // and fail red. Pins the buildPaperDetail call site (`papers.ts:1757`).
    const row = paperRowWithFields('alice', 'p1', {}); // language absent
    installResponder(async (sql, _params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [row] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [row] };
      }
      if (isForwardChainWalkSql(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.language).toBe('en');
  });

  it('language set to empty string: response defaults to "en" (pevoString collapse + ?? "en" combine to fallback)', async () => {
    // Edge case the cast pattern leaked: `language: ''` previously would
    // pass through `?? 'en'` (empty string is truthy for `??`) yielding
    // `''`. The `pevoString` migration narrows `''` to `null` first, so
    // the `?? 'en'` fallback fires and the response carries `'en'`. This
    // pins the behavioral upgrade the migration delivered.
    const row = paperRowWithFields('alice', 'p1', { language: '' });
    installResponder(async (sql, _params) => {
      if (sql.includes('SELECT c.author, c.json_metadata') && sql.includes('parent_permlink = $3')) {
        return { rows: [row] };
      }
      if (sql.includes('SELECT c.author, c.permlink, c.title')) {
        return { rows: [row] };
      }
      if (isForwardChainWalkSql(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app).get('/api/papers/alice/p1');
    expect(res.status).toBe(200);
    const detail = res.body?.data;
    expect(detail).toBeDefined();
    expect(detail.language).toBe('en');
  });
});
