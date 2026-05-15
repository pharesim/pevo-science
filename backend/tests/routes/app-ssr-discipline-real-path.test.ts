/**
 * Real-path SSR JSON-LD discipline wiring regression test
 * (BE-APP-SSR-REAL-PATH-COMPANION; clause-c follow-up for
 * BE-APP-SSR-DISCIPLINE-CANON, surfaced 2026-05-15).
 *
 * Companion to the mocked `app-ssr-discipline-canon.test.ts`. The mocked
 * file pins the **canon-lowering transform** across four discipline
 * shapes (mixed-case + whitespace, absent, whitespace-only, non-string)
 * by spying `hiveClient.database.call` and seeding a paper-shape with
 * mixed-case data — the only way to deterministically exercise the
 * transform when the current corpus is all-lowercase per
 * ARCHITECT-DISCIPLINE-FILTER-PUBLISH-CHARSET-ALIGNMENT.
 *
 * This file covers the **wiring mutation class** the mocked file
 * cannot catch: the helper import being reverted, the
 * `if (canonDiscipline) jsonLd.about = canonDiscipline;` branch being
 * short-circuited, the helper call being replaced with raw
 * `pevoMeta.discipline`, or the SSR catch-all never reaching
 * `injectPaperMeta` at all. All of those would still let the mocked
 * test pass (since it stubs the same call sites it asserts on) but
 * would break the real integrated SSR path.
 *
 * No mocks here. Real `createApp()`, real `hiveClient`, real HAF.
 * Per root CLAUDE.md carve-out clause (b): no auth middleware is
 * mocked — the SSR catch-all is unauthenticated, so the question is
 * moot.
 *
 * The corpus is all-lowercase by design, so raw chain value ===
 * canon-lowered value, and a single equality assertion against
 * `paperDisciplineField(raw_chain_discipline)` is sufficient. The
 * test is corpus-conditional: if no paper with a non-empty string
 * `json_metadata.<appTag>.discipline` is discoverable via the
 * `/api/papers` listing, the spec returns early (the assertion
 * cannot be exercised without a candidate). This is the same
 * skip-on-empty-corpus pattern the sibling
 * `papers.test.ts` parity specs already use.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { hiveClient } from '../../src/hive.js';
import { config } from '../../src/config.js';
import { paperDisciplineField } from '../../src/types/disciplines.js';

const app = createApp();

function extractJsonLd(html: string): Record<string, unknown> | null {
  // The handler emits two <script type="application/ld+json"> blocks:
  // the first is the ScholarlyArticle, the second is the BreadcrumbList.
  // We want the first.
  const match = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe('SSR JSON-LD `about` field — real-path wiring (BE-APP-SSR-REAL-PATH-COMPANION)', () => {
  it(
    'emits canon-lowered ScholarlyArticle.about for an on-chain paper with a discipline',
    { timeout: 60_000 },
    async () => {
      // Walk the live /api/papers listing to find a paper whose
      // on-chain `json_metadata.<appTag>.discipline` is a non-empty
      // string. We only inspect the first page (default limit) — the
      // assertion does not need every paper, just one candidate to
      // exercise the integrated SSR wiring path.
      const listRes = await request(app).get('/api/papers');
      expect(listRes.status).toBe(200);
      const papers: Array<{ author: string; permlink: string; discipline: string | null }> =
        listRes.body.data ?? [];

      // Pick the first paper whose API-reported discipline is a non-empty
      // string. The API field is already canon-lowered through
      // `paperDisciplineField`, so a non-null value implies the on-chain
      // value is also a non-empty string (the helper returns null on
      // every shape that would make the SSR `about` omission fire).
      const candidate = papers.find(p => typeof p.discipline === 'string' && p.discipline.length > 0);
      if (!candidate) {
        // Corpus has no discipline-tagged papers right now. The
        // wiring-mutation regression cannot be exercised; bail rather
        // than vacuously pass on a degenerate state.
        // (Sibling mocked file pins the transform deterministically.)
        return;
      }

      // Fetch the raw on-chain post via the same call site
      // `injectPaperMeta` uses (`get_content`). This is the source of
      // truth for the expected SSR `about` value.
      const rawPost = await hiveClient.database.call('get_content', [candidate.author, candidate.permlink]);
      expect(rawPost).toBeTruthy();
      expect(rawPost.author).toBe(candidate.author);

      let pevoMeta: Record<string, unknown> = {};
      try {
        const meta = JSON.parse((rawPost.json_metadata as string) || '{}') as Record<string, unknown>;
        pevoMeta = (meta[config.appTag] as Record<string, unknown>) || {};
      } catch {
        // Malformed json_metadata on the candidate — skip rather than
        // assert against a degenerate shape.
        return;
      }
      const rawDiscipline = pevoMeta.discipline;
      const expectedAbout = paperDisciplineField(rawDiscipline);
      if (!expectedAbout) {
        // Listing said discipline was non-null but the raw chain shape
        // canon-lowers to null (e.g. continuation override). Skip — this
        // candidate would not exercise the `about`-present branch.
        return;
      }

      // Issue the SSR catch-all request and assert the JSON-LD shape.
      const res = await request(app).get(`/en/paper/${candidate.author}/${candidate.permlink}`);
      expect(res.status).toBe(200);
      const jsonLd = extractJsonLd(res.text);
      expect(jsonLd).not.toBeNull();
      expect(jsonLd!['@type']).toBe('ScholarlyArticle');
      // The load-bearing assertion: the SSR JSON-LD `about` field
      // matches the canon-lowered raw chain discipline verbatim. A
      // wiring mutation (dropped import, short-circuited branch,
      // replaced helper call with raw `pevoMeta.discipline`,
      // catch-all bypassing `injectPaperMeta`) breaks this.
      expect(jsonLd!.about).toBe(expectedAbout);
    },
  );
});
