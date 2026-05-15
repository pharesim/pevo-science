import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

/**
 * BE-ACCREDITATIONS-LIKEGUARD route-level guard suite.
 *
 * Ports the BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP defenses (commit `869fea4`)
 * to the optional `?field=` and `?institution=` filters on GET
 * /api/accreditations. The endpoint is unauthenticated read and previously
 * shipped the same ILIKE-on-user-input anti-pattern as `/api/search ?q=`:
 *   - no length cap → unbounded ILIKE work per request
 *   - no LIKE-metacharacter escape → `_%_%_…` injects N live wildcards
 *   - `as string` cast → repeated `?field=a&field=b` (string[]) silently
 *     coerced to a comma-joined string passing through to the binder
 *
 * All assertions in this file are pre-HAF: the route-level validation runs
 * before isHafConfigured() / fetchAccreditationsFromHaf, so 400 responses are
 * deterministic regardless of HAF availability. The "long but valid"
 * happy-path spec exercises the post-validation branch and only asserts
 * `200` status — it does not depend on HAF returning rows.
 *
 * Mirrors the spec layout of `?q= input validation` in `search.test.ts`
 * (216-275): too-long → 400; valid prefix → 200; repeated param → 200 with
 * silent-unfilter (option-A on `?q=` is 400-required because q is required;
 * for optional accreditation filters the analogue is silent-unfilter, NOT
 * a 400). Literal metacharacters → 200 (escape neutralizes them).
 */
describe('GET /api/accreditations — ?field= / ?institution= LIKE-guard', () => {
  describe('length cap (200 chars)', () => {
    it('rejects >200 char ?field= with 400 BAD_REQUEST and "Filter \\"field\\" too long"', async () => {
      const oversized = 'a'.repeat(4_000);
      const res = await request(app).get('/api/accreditations').query({ field: oversized });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('Filter "field" too long');
    });

    it('rejects 201-char ?field= with 400 BAD_REQUEST (boundary case)', async () => {
      const res = await request(app).get('/api/accreditations').query({ field: 'a'.repeat(201) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('Filter "field" too long');
    });

    it('accepts long-but-valid 200-char ?field= (boundary case)', async () => {
      const res = await request(app).get('/api/accreditations').query({ field: 'a'.repeat(200) });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('rejects >200 char ?institution= with 400 BAD_REQUEST and "Filter \\"institution\\" too long"', async () => {
      const oversized = 'a'.repeat(4_000);
      const res = await request(app).get('/api/accreditations').query({ institution: oversized });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('Filter "institution" too long');
    });

    it('accepts long-but-valid 199-char ?institution=', async () => {
      const res = await request(app).get('/api/accreditations').query({ institution: 'a'.repeat(199) });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('LIKE-metacharacter escape', () => {
    it('?field=_%_% returns 200 — escape neutralizes the injected wildcards', async () => {
      // The crafted DoS shape: `_%_%_%_…` — pre-fix would inject N live
      // wildcards into ILIKE. Post-fix, validateOptionalLikeFilter escapes
      // each `%` → `\%` and each `_` → `\_` so Postgres treats them as
      // literals under ESCAPE '\\'. On the public HAF corpus there are no
      // field values literally containing the escaped sequence, so the
      // result is empty — but the request completes successfully with no
      // backtracking explosion.
      const res = await request(app).get('/api/accreditations').query({ field: '_%_%' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('?institution=_%_% returns 200 — escape neutralizes the injected wildcards', async () => {
      const res = await request(app).get('/api/accreditations').query({ institution: '_%_%' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('?field= containing a literal backslash returns 200 — backslash is escaped to \\\\', async () => {
      const res = await request(app).get('/api/accreditations').query({ field: 'a\\b' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('repeated-param silent-unfilter (`?field=a&field=b`)', () => {
    it('?field=a&field=b is silently unfiltered (Express yields string[] → undefined)', async () => {
      // Pre-fix, the `as string | undefined` cast coerced the string[] to
      // `"a,b"` and passed it through to the ILIKE binder unchanged. Post-fix,
      // validateOptionalLikeFilter treats non-string raw values as absent
      // (returns value: undefined), so the filter is silently dropped and the
      // route returns the unfiltered list. Mirrors the round-4 `?discipline=`
      // contract; differs from `?q=` (which is required and 400s on the same
      // shape with "Search query \"q\" is required").
      const res = await request(app).get('/api/accreditations?field=a&field=b');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('?institution=a&institution=b is silently unfiltered', async () => {
      const res = await request(app).get('/api/accreditations?institution=a&institution=b');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('absent / empty filters', () => {
    it('no ?field= / ?institution= params returns 200 with the unfiltered list', async () => {
      const res = await request(app).get('/api/accreditations');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('empty ?field= is silently unfiltered (treated as absent)', async () => {
      const res = await request(app).get('/api/accreditations?field=');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('whitespace-only ?field= is silently unfiltered (treated as absent)', async () => {
      const res = await request(app).get('/api/accreditations').query({ field: '   ' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });
});
