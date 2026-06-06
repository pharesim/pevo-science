import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';

const app = createApp();

// Tests in this file hit real HAF — round-trip latency on the testnet
// regularly exceeds the production-default `hafWalkerWallClockMs=3000`
// budget, which now (post-BACKEND-HAF-WALKER-WALL-CLOCK-BUDGET round-2)
// surfaces as `503 SERVICE_UNAVAILABLE` instead of silently returning
// possibly-stale data. Override the budget to a generous value so the
// integration-shape assertions (200 + structure checks) aren't masked
// by the testnet's slower-than-default HAF tail. Walker-specific
// budget canaries override the value per-test in their own files
// (`canonical-root-walker.test.ts`, `continuation-author-gate.test.ts`).
let originalBudgetMs: number;
beforeAll(() => {
  originalBudgetMs = config.hafWalkerWallClockMs;
  (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = 60_000;
});
afterAll(() => {
  (config as { hafWalkerWallClockMs: number }).hafWalkerWallClockMs = originalBudgetMs;
});

describe('GET /api/papers', () => {
  it('returns a list of papers with correct envelope', { timeout: 60_000 }, async () => {
    const res = await request(app).get('/api/papers');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty('page');
    expect(res.body.meta).toHaveProperty('total');
  });

  it('returns papers with correct structure when data exists', async () => {
    const res = await request(app).get('/api/papers');
    if (res.body.data.length > 0) {
      const paper = res.body.data[0];
      expect(paper).toHaveProperty('author');
      expect(paper).toHaveProperty('permlink');
      expect(paper).toHaveProperty('title');
      expect(paper).toHaveProperty('abstract');
      expect(paper).toHaveProperty('discipline');
      expect(paper).toHaveProperty('keywords');
      expect(paper).toHaveProperty('net_votes');
      // review_count + avg_rating are emitted by the listing's rev_agg LATERAL.
      // Pinning them here makes the review-agg-single-scan canary's clause-(c)
      // companion claim true: dropping either column from the SELECT now turns a
      // real-HAF test red, not just the synthetic-VALUES parity canary.
      expect(paper).toHaveProperty('review_count');
      expect(paper).toHaveProperty('avg_rating');
      expect(paper).toHaveProperty('is_accredited');
    }
  });

  it('filters by discipline', async () => {
    const res = await request(app).get('/api/papers?discipline=physics');
    expect(res.status).toBe(200);
    for (const paper of res.body.data) {
      // Case-insensitive match: papers tagged "Physics" or "PHYSICS" also match.
      // Assert via lowercase comparison since BE-DISCIPLINE-CANONICALIZE hold #1
      // extended LOWER() matching to the /api/papers filter.
      expect(paper.discipline.toLowerCase()).toBe('physics');
    }
  });

  // BE-DISCIPLINE-CANONICALIZE hold #1(a): mixed-case ?discipline= parity.
  // Before the LOWER() fix on papers.ts, `?discipline=physics` only matched
  // rows tagged lowercase "physics" and silently dropped "Physics"/"PHYSICS"
  // on the primary paper-listing endpoint. Parity is an invariant regardless
  // of whether mixed-case corpus currently exists on HAF — but this real-HAF
  // spec vacuously passes when the corpus has zero `physics`-tagged papers
  // (both sides return total=0 / data=[]), so we skip in that state. The
  // SQL-shape regression is pinned deterministically in
  // disciplines-canon-mocked.test.ts (hold #1a mocked-pool coverage).
  it('?discipline= filter is case-insensitive (parity across casings)', { timeout: 60_000 }, async (ctx) => {
    const [lower, upper] = await Promise.all([
      request(app).get('/api/papers?discipline=physics'),
      request(app).get('/api/papers?discipline=PHYSICS'),
    ]);
    expect(lower.status).toBe(200);
    expect(upper.status).toBe(200);
    if (lower.body.meta.total === 0) {
      // Empty corpus — parity assertion is vacuous. Skip so a future
      // regression on mixed-case inputs surfaces at the mocked-pool spec
      // instead of silently passing here.
      ctx.skip();
      return;
    }
    expect(upper.body.meta.total).toBe(lower.body.meta.total);
    const key = (p: { author: string; permlink: string }) => `${p.author}/${p.permlink}`;
    expect(new Set(upper.body.data.map(key))).toEqual(new Set(lower.body.data.map(key)));
  });

  // BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME: per-paper `discipline` response
  // field must be canon_name (lowercased). Regression: pre-fix, the API echoed
  // whatever casing was stored on-chain (e.g. "Computer Science"), forcing
  // every client to re-canonicalize before round-tripping through the
  // `?discipline=` URL filter. This spec iterates the full `/api/papers`
  // listing and asserts every entry's `discipline` equals its own lowercased
  // form. Empty corpus passes vacuously; the mocked-pool coverage in
  // disciplines-canon-mocked.test.ts pins the SQL-shape regression
  // deterministically. The `discipline !== null` guard skips papers with no
  // discipline tag (pre-taxonomy posts).
  it('per-paper `discipline` field is canon_name (lowercased)', { timeout: 60_000 }, async () => {
    const res = await request(app).get('/api/papers?limit=100');
    expect(res.status).toBe(200);
    for (const paper of res.body.data) {
      if (paper.discipline !== null) {
        expect(typeof paper.discipline).toBe('string');
        expect(paper.discipline).toBe(paper.discipline.toLowerCase());
      }
    }
  });

  it('respects pagination params', async () => {
    const res = await request(app).get('/api/papers?page=1&limit=1');
    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(1);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });

  it('supports source filter', async () => {
    for (const source of ['native', 'bridge']) {
      const res = await request(app).get(`/api/papers?source=${source}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    }
  });

  // backend-papers-filter-accreditation lane 1 canary: the SQL gate is
  // unconditional. Every returned paper must be either accredited-authored
  // (is_accredited: true) OR a bridge-paper exempt post authored by
  // config.hiveBridgeAccount (is_accredited: false). A regression that
  // silently relaxes the gate would surface here as an entry with
  // is_accredited:false AND author != hiveBridgeAccount.
  it('every returned paper is accredited-authored or bridge-account-authored (no unaccredited leaks)', { timeout: 60_000 }, async () => {
    const res = await request(app).get('/api/papers?limit=100');
    expect(res.status).toBe(200);
    for (const paper of res.body.data) {
      const isAccredited = paper.is_accredited === true;
      const isBridgeAuthor = paper.author === config.hiveBridgeAccount;
      expect(
        isAccredited || isBridgeAuthor,
        `paper ${paper.author}/${paper.permlink} leaked the gate: is_accredited=${paper.is_accredited}, author=${paper.author}`,
      ).toBe(true);
    }
  });

  // backend-papers-filter-accreditation lane 1 canary: legacy
  // `?accredited_only=false` opt-out is silently ignored (no error, no
  // behavioral change). A regression that re-introduces the opt-out branch
  // would surface here as a divergence between the param-on and param-off
  // listings.
  it('?accredited_only=false is silently ignored (returns identical set to no param)', { timeout: 60_000 }, async () => {
    const [withoutParam, withFalseParam] = await Promise.all([
      request(app).get('/api/papers?limit=50&sort=date&order=desc'),
      request(app).get('/api/papers?limit=50&sort=date&order=desc&accredited_only=false'),
    ]);
    expect(withoutParam.status).toBe(200);
    expect(withFalseParam.status).toBe(200);
    expect(withFalseParam.body.meta.total).toBe(withoutParam.body.meta.total);
    const key = (p: { author: string; permlink: string }) => `${p.author}/${p.permlink}`;
    expect(new Set(withFalseParam.body.data.map(key))).toEqual(new Set(withoutParam.body.data.map(key)));
  });

  // BE-DISCIPLINE-LENGTH-CAP: guard oversized/malformed ?discipline= inputs
  // before V8 runs toLowerCase() and Postgres runs LOWER(). Prevents
  // per-request-CPU DoS via megabyte-scale query strings.
  describe('?discipline= input validation', () => {
    it('rejects >100 char discipline with 400 BAD_REQUEST', async () => {
      // 4 KB of ASCII letters — well above the 100-char guard, below Node's
      // default ~8 KB URL/header limit (which would fire a 431 before Express
      // routing). The task's "1 MB" scenario is what the guard protects the
      // SQL/V8 layer against; the 4 KB probe proves the route-level cap fires
      // before toLowerCase() / LOWER() touch oversize input.
      const oversized = 'a'.repeat(4_000);
      const res = await request(app).get('/api/papers').query({ discipline: oversized });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('Discipline filter invalid');
    });

    it('rejects malformed charset (e.g. $$$) with 400 BAD_REQUEST', async () => {
      const res = await request(app).get('/api/papers').query({ discipline: '$$$' });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('Discipline filter invalid');
    });

    it('accepts long-but-valid discipline (99 chars, letters+spaces)', { timeout: 60_000 }, async () => {
      // "quantum computing" padded to 99 chars with spaces
      const padded = 'quantum computing' + ' '.repeat(99 - 'quantum computing'.length);
      expect(padded.length).toBe(99);
      const res = await request(app).get('/api/papers').query({ discipline: padded });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      // Data may be empty (no matching papers in corpus); assert envelope only.
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });
});

describe('GET /api/papers/:author/:permlink', () => {
  it('returns 404 for nonexistent paper', async () => {
    const res = await request(app).get('/api/papers/nobody/no-paper');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns paper detail with correct structure when found', async () => {
    // First get any paper from the listing to use as a real test target
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return; // no pevo content on chain yet

    const { author, permlink } = listRes.body.data[0];
    const res = await request(app).get(`/api/papers/${author}/${permlink}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.author).toBe(author);
    expect(res.body.data.permlink).toBe(permlink);
    expect(res.body.data).toHaveProperty('body');
    expect(res.body.data).toHaveProperty('reviews');
    expect(Array.isArray(res.body.data.reviews)).toBe(true);
    expect(res.body.data).toHaveProperty('versions');
    expect(res.body.data).toHaveProperty('is_retracted');
  });

  // BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME: paper-detail `discipline` field
  // shares the same canon_name contract as the list endpoint. Routes through
  // the single `paperDisciplineField()` helper in both the initial shape
  // (buildPaperDetail) and the continuation-chain override path.
  it('paper-detail `discipline` field is canon_name (lowercased)', { timeout: 60_000 }, async () => {
    const listRes = await request(app).get('/api/papers?limit=1');
    if (listRes.body.data.length === 0) return;

    const { author, permlink } = listRes.body.data[0];
    const res = await request(app).get(`/api/papers/${author}/${permlink}`);
    expect(res.status).toBe(200);
    const d = res.body.data.discipline;
    if (d !== null) {
      expect(typeof d).toBe('string');
      expect(d).toBe(d.toLowerCase());
    }
  });
});

// Cross-surface cumulative-union parity (detail / listing / profile).
// Pins the invariant that `authors[].hive`, `authors[].name`, and
// `accredited_authors` are the same set across the three response surfaces
// for the same paper. The cumulative-union helper
// (`resolveChainCumulativeAuthors`) is the single construction site for all
// three surfaces, so by construction the sets must match — this canary
// catches wiring regressions where one surface stops routing through the
// helper. The `name` comparison covers EVERY author entry (Hive-keyed and
// Hive-less), so a surface that drops a Hive-less co-author would diverge on
// the name set even though the Hive-set comparison (which filters to string
// hives) would not — this is the Hive-less-persistence parity assertion.
// For multi-link papers where the head broadcaster dropped a chain author
// from their own `pevo.authors[]`, parity holds because the helper
// reconstructs the union from chain history; for single-link papers, parity
// holds trivially. The test iterates real listing data, so it passes
// vacuously when the corpus is empty; the deterministic dropped-author and
// Hive-less scenarios are covered separately at the helper-unit level.
describe('Cross-surface cumulative-union parity', () => {
  it('detail, listing, and profile agree on authors and accredited_authors for the same paper', { timeout: 90_000 }, async () => {
    const listRes = await request(app).get('/api/papers?limit=5');
    expect(listRes.status).toBe(200);
    if (listRes.body.data.length === 0) return;

    for (const listingRow of listRes.body.data) {
      const { author, permlink } = listingRow;
      const detailRes = await request(app).get(`/api/papers/${author}/${permlink}`);
      if (detailRes.status !== 200) continue;

      const detailHives = (detailRes.body.data.authors as Array<{ hive?: string }>)
        .map((a) => a.hive)
        .filter((h): h is string => typeof h === 'string')
        .sort();
      const listingHives = (listingRow.authors as Array<{ hive?: string }>)
        .map((a) => a.hive)
        .filter((h): h is string => typeof h === 'string')
        .sort();
      expect(listingHives).toEqual(detailHives);

      // Full author-name parity (every entry, Hive-keyed AND Hive-less).
      // `name` is total after the author-identity-model change, so a surface
      // dropping a Hive-less co-author would shrink this list.
      const detailNames = (detailRes.body.data.authors as Array<{ name?: string }>)
        .map((a) => a.name).sort();
      const listingNames = (listingRow.authors as Array<{ name?: string }>)
        .map((a) => a.name).sort();
      expect(listingNames).toEqual(detailNames);

      const detailAccredited = ([...(detailRes.body.data.accredited_authors as string[] | undefined ?? [])]).sort();
      const listingAccredited = ([...(listingRow.accredited_authors as string[] | undefined ?? [])]).sort();
      expect(listingAccredited).toEqual(detailAccredited);

      const profileRes = await request(app).get(`/api/profile/${author}/papers?limit=50`);
      if (profileRes.status !== 200) continue;
      const profileRow = (profileRes.body.data as Array<{ author: string; permlink: string; authors?: Array<{ hive?: string; name?: string }>; accredited_authors?: string[] }>)
        .find((p) => p.author === author && p.permlink === permlink);
      if (!profileRow) continue;
      const profileHives = (profileRow.authors ?? [])
        .map((a) => a.hive)
        .filter((h): h is string => typeof h === 'string')
        .sort();
      const profileNames = (profileRow.authors ?? [])
        .map((a) => a.name).sort();
      const profileAccredited = ([...(profileRow.accredited_authors ?? [])]).sort();
      expect(profileHives).toEqual(detailHives);
      expect(profileNames).toEqual(detailNames);
      expect(profileAccredited).toEqual(detailAccredited);
    }
  });
});
