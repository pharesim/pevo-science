import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';

const app = createApp();

describe('GET /api/search', () => {
  it('returns 400 when q param is missing', async () => {
    const res = await request(app).get('/api/search');
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when q is empty', async () => {
    const res = await request(app).get('/api/search?q=');
    expect(res.status).toBe(400);
  });

  it('returns search results with correct envelope', async () => {
    const res = await request(app).get('/api/search?q=science');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty('total');
    expect(res.body.meta).toHaveProperty('page');
    expect(res.body.meta).toHaveProperty('limit');
  });

  it('returns results with expected fields when data exists', async () => {
    const res = await request(app).get('/api/search?q=science');
    expect(res.status).toBe(200);
    if (res.body.data.length > 0) {
      const item = res.body.data[0];
      expect(item).toHaveProperty('type');
      expect(item).toHaveProperty('author');
      expect(item).toHaveProperty('permlink');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('snippet');
      expect(item).toHaveProperty('created');
      expect(item).toHaveProperty('is_accredited');
    }
  });

  it('respects pagination params', async () => {
    const res = await request(app).get('/api/search?q=science&page=1&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(2);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
  });

  it('supports type filter', async () => {
    const res = await request(app).get('/api/search?q=science&type=paper');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  // BE-SEARCH-REVIEWS-CONTRACT-RECONCILE: `?type=review` is a live, frontend-
  // consumed branch (the /search page's <select> ships `value="review"` and
  // the result renderer dispatches on `result.type === 'review'`). The
  // contract previously claimed reviews were unsearchable; this test pins
  // the branch as supported so a future delete that takes the contract
  // literally trips a failing spec.
  it('?type=review returns 200 with review-shaped results', async () => {
    // `q=evaluation` is chosen because the live HAF corpus contains an
    // accredited review (`@pevo.science/re-pevotestbridge-…`) whose body
    // discusses "open evaluation" / "scientific evaluation" — it matches
    // ILIKE `%evaluation%` and survives the accreditation + non-self-review
    // gates. Earlier `q=science` returned zero rows because the term appears
    // only in `scientific`, which doesn't contain literal `science` as a
    // substring.
    const res = await request(app).get('/api/search?q=evaluation&type=review');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    // Non-vacuous guard: if the live HAF corpus stops returning review hits
    // for this query, this assertion trips before the loop, surfacing the
    // empty-corpus regression instead of letting the for…of run zero times.
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const item of res.body.data) {
      expect(item.type).toBe('review');
    }
  });

  it('?type=foo returns 400 on unknown enum value', async () => {
    const res = await request(app).get('/api/search?q=science&type=foo');
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toMatch(/Must be one of/);
  });

  // Pins the case-sensitive enum contract. A future defensive `.toLowerCase()`
  // before the `includes` check would silently widen the accepted surface from
  // {all, paper, review} to {ALL, PAPER, Paper, …}; this spec fails first.
  it('?type=PAPER (mixed-case) returns 400 — enum is case-sensitive', async () => {
    const res = await request(app).get('/api/search?q=science&type=PAPER');
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toMatch(/Must be one of/);
  });

  // Repeated `?type=` params (`?type=paper&type=review`) yield `string[]` in
  // Express's parsed query. An `as string` cast on the array would coerce to
  // `"paper,review"` and silently fall through the enum check; the
  // typeof-narrow rejects it with 400.
  it('?type=paper&type=review (repeated) returns 400 instead of silently coercing', async () => {
    const res = await request(app).get('/api/search?q=science&type=paper&type=review');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  // BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME: per-entry `discipline` response
  // field on `paper` / `bridge_paper` result types must be canon_name
  // (lowercased) if/when the search response shape adds one. The current
  // SearchRow shape does not include `discipline`, so this spec asserts the
  // contract is upheld for every entry that DOES surface one (future-proof),
  // plus that `paper`/`bridge_paper` entries ship without a divergent-casing
  // field today. Both guards route through the same helper contract as
  // /api/papers so a future author adding `discipline` to SearchRow gets a
  // failing spec before it can regress.
  it('per-entry `discipline` field (if present) is canon_name on paper/bridge_paper entries', { timeout: 60_000 }, async () => {
    const res = await request(app).get('/api/search?q=science&type=paper');
    expect(res.status).toBe(200);
    for (const item of res.body.data) {
      if (item.type !== 'paper' && item.type !== 'bridge_paper') continue;
      if ('discipline' in item && item.discipline !== null && item.discipline !== undefined) {
        expect(typeof item.discipline).toBe('string');
        expect(item.discipline).toBe(item.discipline.toLowerCase());
      }
    }
  });

  it('returns 400 when q is only whitespace', async () => {
    const res = await request(app).get('/api/search?q=%20%20');
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('BAD_REQUEST');
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
      const res = await request(app).get('/api/search').query({ q: 'science', discipline: oversized });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('Discipline filter invalid');
    });

    it('rejects malformed charset (e.g. $$$) with 400 BAD_REQUEST', async () => {
      const res = await request(app).get('/api/search').query({ q: 'science', discipline: '$$$' });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('Discipline filter invalid');
    });

    it('accepts long-but-valid discipline (99 chars, letters+spaces)', async () => {
      // "quantum computing" padded to 99 chars with spaces
      const padded = 'quantum computing' + ' '.repeat(99 - 'quantum computing'.length);
      expect(padded.length).toBe(99);
      const res = await request(app).get('/api/search').query({ q: 'science', discipline: padded });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      // Data may be empty (no matching papers in corpus); assert envelope only.
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP: guard ?q= length and escape LIKE
  // metacharacters before the bound parameter reaches Postgres ILIKE. Closes
  // the per-request CPU-DoS vector that was materially more exploitable than
  // ?discipline= because q runs against c.title OR c.body across every
  // PEvO-app comment row.
  describe('?q= input validation', () => {
    it('rejects >200 char q with 400 BAD_REQUEST and "Search query too long"', async () => {
      // 4 KB of ASCII letters — well above the 200-char guard, below Node's
      // default URL/header limit. The route-level cap fires before the
      // bound parameter reaches the ILIKE binder.
      const oversized = 'a'.repeat(4_000);
      const res = await request(app).get('/api/search').query({ q: oversized });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('Search query too long');
    });

    it('accepts long-but-valid q (199 chars) — exercises ILIKE path without 400', async () => {
      // 199 chars: under the 200-char cap, exercises the LIKE-escape path
      // end-to-end against real HAF.
      const padded = 'science ' + 'a'.repeat(199 - 'science '.length);
      expect(padded.length).toBe(199);
      const res = await request(app).get('/api/search').query({ q: padded });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('still 400s on whitespace-only q with the existing required-message', async () => {
      // Helper folds empty/whitespace into the absent (null) path so the
      // existing "Search query \"q\" is required" 400 is preserved.
      const res = await request(app).get('/api/search?q=%20%20');
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('Search query "q" is required');
    });

    it('repeated ?q=a&q=b yields the existing required-message (silent-unfilter contract)', async () => {
      // Express yields string[]; helper returns null (silent-unfilter,
      // mirrors ?discipline= round-4 contract). Since q is required, the
      // route returns 400 with the required message rather than 'too long'.
      const res = await request(app).get('/api/search?q=a&q=b');
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('Search query "q" is required');
    });

    it('q containing LIKE metacharacters (%, _, \\) returns 200 — escape neutralizes the wildcards', async () => {
      // The crafted DoS shape: `%_%_%_%_%_…` — pre-fix would inject N live
      // wildcards into ILIKE. Post-fix, the helper escapes each `%` to `\%`
      // and each `_` to `\_` so Postgres treats them as literals under
      // ESCAPE '\\'. Real-HAF runs the ILIKE; on the public corpus there
      // are no titles literally containing the escaped sequence, so the
      // result is empty — but the request completes successfully (no
      // backtracking explosion).
      const res = await request(app).get('/api/search').query({ q: '%_%_%_%_%_test_%' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // backend-papers-filter-accreditation lane 3 canaries: SQL accreditation
  // gate is unconditional across all `?type=` modes. Every returned paper
  // entry must be accredited-authored or `config.hiveBridgeAccount`-authored
  // (bridge_paper exemption); every returned review entry must be
  // accredited-authored. A regression that re-introduces the `accreditedOnly`
  // parameter or the `if (accreditedOnly)` toggle on either WHERE clause
  // surfaces here.
  describe('SQL accreditation gate (lane 3)', () => {
    it('?type=paper excludes unaccredited authors (every entry is accredited or bridge-account)', { timeout: 60_000 }, async () => {
      const res = await request(app).get('/api/search?q=science&type=paper&limit=50');
      expect(res.status).toBe(200);
      for (const item of res.body.data) {
        const isAccredited = item.is_accredited === true;
        const isBridgeAuthor = item.author === config.hiveBridgeAccount;
        expect(
          isAccredited || isBridgeAuthor,
          `search paper entry ${item.author}/${item.permlink} leaked the gate: is_accredited=${item.is_accredited}, author=${item.author}`,
        ).toBe(true);
      }
    });

    it('?type=review excludes unaccredited authors (every entry is accredited)', { timeout: 60_000 }, async () => {
      const res = await request(app).get('/api/search?q=science&type=review&limit=50');
      expect(res.status).toBe(200);
      for (const item of res.body.data) {
        expect(
          item.is_accredited,
          `search review entry ${item.author}/${item.permlink} leaked the gate: is_accredited=${item.is_accredited}`,
        ).toBe(true);
      }
    });

    it('?type=paper&accredited_only=false is silently ignored (returns identical set to no param)', { timeout: 60_000 }, async () => {
      const [withoutParam, withFalseParam] = await Promise.all([
        request(app).get('/api/search?q=science&type=paper&limit=50&sort=date'),
        request(app).get('/api/search?q=science&type=paper&limit=50&sort=date&accredited_only=false'),
      ]);
      expect(withoutParam.status).toBe(200);
      expect(withFalseParam.status).toBe(200);
      expect(withFalseParam.body.meta.total).toBe(withoutParam.body.meta.total);
      const key = (e: { author: string; permlink: string }) => `${e.author}/${e.permlink}`;
      expect(new Set(withFalseParam.body.data.map(key))).toEqual(new Set(withoutParam.body.data.map(key)));
    });

    it('?type=review&accredited_only=false is silently ignored (returns identical set to no param)', { timeout: 60_000 }, async () => {
      const [withoutParam, withFalseParam] = await Promise.all([
        request(app).get('/api/search?q=science&type=review&limit=50&sort=date'),
        request(app).get('/api/search?q=science&type=review&limit=50&sort=date&accredited_only=false'),
      ]);
      expect(withoutParam.status).toBe(200);
      expect(withFalseParam.status).toBe(200);
      expect(withFalseParam.body.meta.total).toBe(withoutParam.body.meta.total);
      const key = (e: { author: string; permlink: string }) => `${e.author}/${e.permlink}`;
      expect(new Set(withFalseParam.body.data.map(key))).toEqual(new Set(withoutParam.body.data.map(key)));
    });
  });

});
