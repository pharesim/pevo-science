/**
 * SSR JSON-LD discipline canonicalization regression test
 * (BE-APP-SSR-DISCIPLINE-CANON, surfaced by BE-PROFILE-PAPER-DISCIPLINE-CANON
 * maintainability review, 2026-04-28).
 *
 * Justification for the mocked `hiveClient.database.call`:
 * the SSR meta-injection branch at `src/app.ts:injectPaperMeta` reads the
 * paper post via `get_content` and shapes the JSON-LD `about` field from
 * `json_metadata.<appTag>.discipline`. The canon-lowering transform under
 * test fires deterministically only when the on-chain value is mixed-case
 * or whitespace-padded. The current corpus is all-lowercase per the
 * ARCHITECT-DISCIPLINE-FILTER-PUBLISH-CHARSET-ALIGNMENT audit, so a
 * real-HAF assertion would be vacuous on the metric we care about.
 * Mocking `hiveClient.database.call` lets us seed a paper-shape with
 * mixed-case + whitespace-padded discipline and pin the SSR-vs-API parity
 * the helper claims. Per root CLAUDE.md carve-out: no `verifyHiveSignature`
 * or auth middleware is mocked here — the SSR catch-all is unauthenticated.
 *
 * SSR-vs-API parity rationale: `/api/papers/:author/:permlink` already
 * routes `discipline` through `paperDisciplineField` (canon-lowered).
 * Schema.org `about` in the SSR HTML payload is what academic indexers
 * (Google Scholar, Semantic Scholar, OpenAlex) consume; emitting raw
 * on-chain casing there while the API ships canon-lowered values gives
 * external fingerprinters two different values for the same paper.
 *
 * Carve-out clause (c) companion: `app-ssr-discipline-real-path.test.ts`
 * exercises the integrated SSR wiring path against real `hiveClient` +
 * real HAF on an existing all-lowercase corpus paper. That file covers
 * the wiring-bypass mutation class (dropped helper import,
 * short-circuited `about` branch, catch-all not reaching
 * `injectPaperMeta`) which this mocked file cannot catch. The
 * helper-self-mutation class (raw `pevoMeta.discipline` bypass,
 * `paperDisciplineField` transform regressed) stays here: the
 * companion's all-lowercase corpus invariant makes raw == canon, so
 * its equality assertion is blind to that class; the mocked seeds
 * below distinguish raw-vs-canon deterministically.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { hiveClient } from '../../src/hive.js';
import { config } from '../../src/config.js';

const app = createApp();

function fakePaperPost(author: string, permlink: string, pevoFields: Record<string, unknown>) {
  return {
    author,
    permlink,
    parent_author: '',
    parent_permlink: config.appTag,
    title: 'Test paper',
    body: 'This is the abstract of the test paper. '.repeat(5),
    json_metadata: JSON.stringify({
      app: `${config.appTag}/0.0.1`,
      tags: [config.appTag, 'science'],
      [config.appTag]: { type: 'paper', ...pevoFields },
    }),
    created: '2026-04-28T00:00:00',
    last_update: '2026-04-28T00:00:00',
  };
}

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SSR JSON-LD `about` field — discipline canon parity (BE-APP-SSR-DISCIPLINE-CANON)', () => {
  it('canon-lowers a mixed-case + whitespace-padded discipline into the SSR JSON-LD', async () => {
    const author = 'alice';
    const permlink = 'mixed-case-paper';
    vi.spyOn(hiveClient.database, 'call').mockImplementation(((method: string, params: unknown[]) => {
      if (method === 'get_content' && params[0] === author && params[1] === permlink) {
        return Promise.resolve(fakePaperPost(author, permlink, { discipline: '  Computer Science  ' }));
      }
      return Promise.resolve(null);
    }) as never);

    const res = await request(app).get(`/en/paper/${author}/${permlink}`);
    expect(res.status).toBe(200);
    const jsonLd = extractJsonLd(res.text);
    expect(jsonLd).not.toBeNull();
    expect(jsonLd!['@type']).toBe('ScholarlyArticle');
    expect(jsonLd!.about).toBe('computer science');
  });

  it('omits the `about` field entirely when discipline is absent', async () => {
    const author = 'bob';
    const permlink = 'no-discipline-paper';
    vi.spyOn(hiveClient.database, 'call').mockImplementation(((method: string, params: unknown[]) => {
      if (method === 'get_content' && params[0] === author && params[1] === permlink) {
        return Promise.resolve(fakePaperPost(author, permlink, {}));
      }
      return Promise.resolve(null);
    }) as never);

    const res = await request(app).get(`/en/paper/${author}/${permlink}`);
    expect(res.status).toBe(200);
    const jsonLd = extractJsonLd(res.text);
    expect(jsonLd).not.toBeNull();
    expect(jsonLd!['@type']).toBe('ScholarlyArticle');
    expect(jsonLd).not.toHaveProperty('about');
  });

  it('omits the `about` field when discipline is whitespace-only', async () => {
    const author = 'carol';
    const permlink = 'whitespace-discipline-paper';
    vi.spyOn(hiveClient.database, 'call').mockImplementation(((method: string, params: unknown[]) => {
      if (method === 'get_content' && params[0] === author && params[1] === permlink) {
        return Promise.resolve(fakePaperPost(author, permlink, { discipline: '   ' }));
      }
      return Promise.resolve(null);
    }) as never);

    const res = await request(app).get(`/en/paper/${author}/${permlink}`);
    expect(res.status).toBe(200);
    const jsonLd = extractJsonLd(res.text);
    expect(jsonLd).not.toBeNull();
    expect(jsonLd).not.toHaveProperty('about');
  });

  it('omits the `about` field when discipline is non-string (number)', async () => {
    const author = 'dave';
    const permlink = 'numeric-discipline-paper';
    vi.spyOn(hiveClient.database, 'call').mockImplementation(((method: string, params: unknown[]) => {
      if (method === 'get_content' && params[0] === author && params[1] === permlink) {
        return Promise.resolve(fakePaperPost(author, permlink, { discipline: 42 }));
      }
      return Promise.resolve(null);
    }) as never);

    const res = await request(app).get(`/en/paper/${author}/${permlink}`);
    expect(res.status).toBe(200);
    const jsonLd = extractJsonLd(res.text);
    expect(jsonLd).not.toBeNull();
    expect(jsonLd).not.toHaveProperty('about');
  });
});
