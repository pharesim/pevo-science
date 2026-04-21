/**
 * E2E-READ-4 — Blog index + single-post rendering.
 *
 * Data source: blog posts are Hive posts by the configured blog account
 * under the blog tag (defaults: `pevo.science` / `pevo-blog`). The
 * backend proxies Hive's `getDiscussions('blog', ...)` and exposes
 * `GET /api/blog` and `GET /api/blog/:permlink`. HAF isn't involved for
 * the blog feed; Hive API is the source of truth. We don't mock —
 * there's already a published launch post, which is enough for the
 * happy-path assertions.
 */

import { test, expect } from './fixtures/keychain.js';

test('blog index renders posts and post page renders title + body', async ({ page, request }) => {
  // Prefetch via API to know what post to drill into.
  const apiResp = await request.get('/api/blog?limit=20');
  expect(apiResp.status()).toBe(200);
  const apiBody = await apiResp.json();
  expect(apiBody.status).toBe('ok');
  expect(Array.isArray(apiBody.data)).toBe(true);
  expect(apiBody.data.length).toBeGreaterThan(0);
  const firstPost = apiBody.data[0];

  // ─── Index page ──────────────────────────────────────────────
  const listResponsePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/blog') &&
              !resp.url().match(/\/api\/blog\/[^?]+/) &&
              resp.request().method() === 'GET',
  );
  await page.goto('/en/blog');
  const listResp = await listResponsePromise;
  expect(listResp.status()).toBe(200);

  // One article per post, keyed by permlink. The first post's title
  // renders as a link to the post page.
  const postLink = page.locator(`a[href*="/blog/${firstPost.permlink}"]`).first();
  await expect(postLink).toBeVisible();
  await expect(postLink).toHaveText(firstPost.title);

  // Body preview renders on the card (truncated to 300 chars + stripped
  // of markdown). Just check the first plain-text word survives.
  const firstWord = (firstPost.body || '')
    .replace(/[#*_~`]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .split(/\s+/)[0];
  if (firstWord) {
    await expect(page.getByText(firstWord, { exact: false }).first()).toBeVisible();
  }

  // ─── Click through to post page ──────────────────────────────
  const postResponsePromise = page.waitForResponse(
    (resp) => resp.url().endsWith(`/api/blog/${encodeURIComponent(firstPost.permlink)}`),
  );
  await postLink.click();
  const postResp = await postResponsePromise;
  expect(postResp.status()).toBe(200);
  const post = (await postResp.json()).data;

  await expect(page).toHaveURL(new RegExp(`/blog/${firstPost.permlink}`));

  // Title renders as the h1.
  await expect(page.locator('h1', { hasText: post.title }).first()).toBeVisible();

  // Body renders via x-markdown. Asserting against the rendered DOM —
  // we pick a distinctive word from the markdown body and confirm it's
  // in the prose container.
  const bodyWord = (post.body || '')
    .replace(/[#*_~`]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .split(/\s+/)
    .find((w) => w.length > 4);
  if (bodyWord) {
    const prose = page.locator('article .prose');
    await expect(prose).toContainText(bodyWord);
  }
});
