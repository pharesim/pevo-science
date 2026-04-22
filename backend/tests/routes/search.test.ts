import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

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
});
