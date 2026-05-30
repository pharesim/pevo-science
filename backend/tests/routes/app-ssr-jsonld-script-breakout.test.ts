/**
 * SSR JSON-LD `</script>` breakout regression test.
 *
 * The paper and profile SSR builders in src/app.ts embed chain- and
 * URL-derived strings into inline <script type="application/ld+json"> blocks.
 * JSON.stringify alone does not escape `<`/`>`, so a paper title or a profile
 * username path segment containing the byte sequence `</script>` would close
 * the script element in the HTML parser and inject arbitrary same-origin
 * script. The `jsonLdSafe` helper escapes `<`, `>`, `&` to their \uXXXX JSON
 * forms; these tests pin that the breakout sequence never reaches the HTML
 * parser while the JSON-LD stays valid, parseable, and semantically unchanged
 * for schema.org crawlers. Reverting the `<`-to-< replacement in
 * jsonLdSafe turns both tests RED (mutation-kill).
 *
 * Test-mock carve-out (per root CLAUDE.md "Running Tests"):
 *   (a) Justification: `hiveClient.database.call` is stubbed to seed a paper
 *       shape carrying an attacker-controlled title — the live chain has no
 *       such post, and the focus is the escape transform, not chain reads.
 *       The profile test needs no chain state at all (the username reflects
 *       straight from the URL path segment).
 *   (b) No auth middleware is mocked: the SSR catch-all is unauthenticated, so
 *       there is no signature/JWT path involved here.
 *   (c) Real-path companion: app-ssr-discipline-real-path.test.ts exercises the
 *       integrated SSR wiring against real hiveClient + HAF.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { hiveClient } from '../../src/hive.js';
import { config } from '../../src/config.js';

const app = createApp();
const PAYLOAD = '</script><script>window.__pwned=1</script>';

function fakePaperPost(author: string, permlink: string, title: string) {
  return {
    author,
    permlink,
    parent_author: '',
    parent_permlink: config.appTag,
    title,
    body: 'This is the abstract of the test paper. '.repeat(5),
    json_metadata: JSON.stringify({
      app: `${config.appTag}/0.0.1`,
      tags: [config.appTag, 'science'],
      [config.appTag]: { type: 'paper' },
    }),
    created: '2026-05-30T00:00:00',
    last_update: '2026-05-30T00:00:00',
  };
}

// Parse the first ld+json block. After escaping, the JSON-LD content holds no
// literal `<`, so `[^<]+` captures the whole block up to the real </script>.
function firstJsonLd(html: string): Record<string, unknown> | null {
  const match = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
  if (!match) return null;
  return JSON.parse(match[1]) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

describe('SSR JSON-LD script breakout — paper route', () => {
  it('escapes a </script> in the paper title so the JSON-LD block does not close early', async () => {
    const author = 'alice';
    const permlink = 'breakout-paper';
    vi.spyOn(hiveClient.database, 'call').mockImplementation(((method: string, params: unknown[]) => {
      if (method === 'get_content' && params[0] === author && params[1] === permlink) {
        return Promise.resolve(fakePaperPost(author, permlink, PAYLOAD));
      }
      return Promise.resolve(null);
    }) as never);

    const res = await request(app).get(`/en/paper/${author}/${permlink}`);
    expect(res.status).toBe(200);
    // The raw breakout sequence must NOT appear literally anywhere in the HTML.
    expect(res.text).not.toContain(PAYLOAD);
    // The escaped form is present inside the JSON-LD payload.
    expect(res.text).toContain('\\u003C/script\\u003E');
    // Round-trip: the JSON-LD parses and the headline is the original title,
    // literal </script> intact (JSON semantics preserved for crawlers).
    const jsonLd = firstJsonLd(res.text);
    expect(jsonLd).not.toBeNull();
    expect(jsonLd!['@type']).toBe('ScholarlyArticle');
    expect(jsonLd!.headline).toBe(PAYLOAD);
  });
});

describe('SSR JSON-LD script breakout — profile route', () => {
  it('escapes a </script> in the profile username path segment (reflected, no chain state)', async () => {
    const res = await request(app).get(`/en/profile/${encodeURIComponent(PAYLOAD)}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(PAYLOAD);
    expect(res.text).toContain('\\u003C/script\\u003E');
    const jsonLd = firstJsonLd(res.text);
    expect(jsonLd).not.toBeNull();
    expect(jsonLd!['@type']).toBe('Person');
    expect(jsonLd!.name).toBe(PAYLOAD);
  });
});
