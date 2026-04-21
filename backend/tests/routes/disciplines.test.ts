/**
 * Real-HAF tests for GET /api/disciplines and the ?discipline= filter on
 * /api/search, covering the case-insensitive canonicalization added by
 * BE-DISCIPLINE-CANONICALIZE.
 *
 * These hit the real public HAF database (see root CLAUDE.md "Running
 * Tests"). We cannot seed synthetic mixed-case rows into that database, so
 * the assertions test the invariants of the canonicalization rather than
 * a specific known-mixed-case discipline value:
 *
 *   1. Every row returned by /api/disciplines has a lowercase `canon_name`
 *      and all `canon_name` values are unique (dedup-by-LOWER contract).
 *   2. The /api/search ?discipline= filter is case-insensitive: uppercasing
 *      a discipline that returns hits must still return the same hit count
 *      and the same result set (by author+permlink).
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/disciplines (canonicalization)', () => {
  it('returns rows with { canon_name, display_name, paper_count }', { timeout: 60_000 }, async () => {
    const res = await request(app).get('/api/disciplines');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);

    for (const row of res.body.data) {
      expect(row).toHaveProperty('canon_name');
      expect(row).toHaveProperty('display_name');
      expect(row).toHaveProperty('paper_count');
      expect(typeof row.canon_name).toBe('string');
      expect(typeof row.display_name).toBe('string');
      expect(typeof row.paper_count).toBe('number');
      expect(row.paper_count).toBeGreaterThan(0);
    }
  });

  it('canon_name is always lowercase', { timeout: 60_000 }, async () => {
    const res = await request(app).get('/api/disciplines');
    expect(res.status).toBe(200);
    for (const row of res.body.data) {
      expect(row.canon_name).toBe(row.canon_name.toLowerCase());
    }
  });

  it('dedups mixed-case discipline names (no duplicate canon_name rows)', { timeout: 60_000 }, async () => {
    const res = await request(app).get('/api/disciplines');
    expect(res.status).toBe(200);
    const canonNames = res.body.data.map((r: { canon_name: string }) => r.canon_name);
    const unique = new Set(canonNames);
    expect(unique.size).toBe(canonNames.length);
  });

  it('display_name lowercases to canon_name', { timeout: 60_000 }, async () => {
    const res = await request(app).get('/api/disciplines');
    expect(res.status).toBe(200);
    for (const row of res.body.data) {
      expect(row.display_name.toLowerCase()).toBe(row.canon_name);
    }
  });
});

describe('GET /api/search (case-insensitive ?discipline= filter)', () => {
  it('matches the same papers regardless of discipline-filter casing', { timeout: 90_000 }, async () => {
    // Pick a real discipline from HAF so the test has a chance of returning
    // non-empty results. If HAF has no disciplines yet, the test still
    // exercises the query path (empty === empty).
    const discRes = await request(app).get('/api/disciplines');
    expect(discRes.status).toBe(200);
    const rows = discRes.body.data as Array<{ canon_name: string }>;
    if (rows.length === 0) {
      // Nothing seeded on HAF yet; fall back to asserting the filter at
      // least accepts mixed casing without erroring.
      const a = await request(app).get('/api/search?q=the&discipline=physics');
      const b = await request(app).get('/api/search?q=the&discipline=PHYSICS');
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.meta.total).toBe(b.body.meta.total);
      return;
    }

    const canon = rows[0].canon_name;
    const lower = canon.toLowerCase();
    const upper = canon.toUpperCase();

    const [lowerRes, upperRes] = await Promise.all([
      request(app).get(`/api/search?q=the&discipline=${encodeURIComponent(lower)}`),
      request(app).get(`/api/search?q=the&discipline=${encodeURIComponent(upper)}`),
    ]);

    expect(lowerRes.status).toBe(200);
    expect(upperRes.status).toBe(200);
    expect(upperRes.body.meta.total).toBe(lowerRes.body.meta.total);

    const key = (r: { author: string; permlink: string }) => `${r.author}/${r.permlink}`;
    const lowerKeys = new Set(lowerRes.body.data.map(key));
    const upperKeys = new Set(upperRes.body.data.map(key));
    expect(upperKeys).toEqual(lowerKeys);
  });
});
