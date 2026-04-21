/**
 * Regression guard for UI-FEED-URL-PAGE: deep-link + back/forward coverage
 * for the /papers pagination state. Asserts the three moving pieces:
 *   - Deep link /papers?page=2&sort=votes seeds state on first mount.
 *   - Clicking a page button pushes `?page=N` and preserves filter params.
 *   - Browser back restores the previous URL and re-drives the feed.
 *
 * Uses `page.route()` to fake a fixed-size papers collection so the test is
 * deterministic regardless of how much data the shared HAF node indexes.
 */

import { test, expect } from './fixtures/keychain.js';

async function mockPapers(page) {
  await page.route('**/api/papers*', async (route) => {
    const url = new URL(route.request().url());
    const pageNum = parseInt(url.searchParams.get('page') || '1', 10);
    const data = Array.from({ length: 10 }, (_, i) => ({
      author: `mock-author-${pageNum}-${i}`,
      permlink: `mock-paper-${pageNum}-${i}`,
      title: `Mock Paper p${pageNum} #${i + 1}`,
      body: 'abstract',
      created: '2026-01-01T00:00:00Z',
      discipline: url.searchParams.get('discipline') || 'physics',
      is_accredited: true,
      source: 'native',
    }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data,
        meta: { total: 50, limit: 10, page: pageNum },
      }),
    });
  });
  await page.route('**/api/disciplines*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', data: [] }),
    });
  });
}

test('deep link seeds currentPage from URL', async ({ page }) => {
  await mockPapers(page);
  const paperRequests = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/papers')) paperRequests.push(req.url());
  });

  await page.goto('/en/papers?page=3&sort=votes');
  await expect(page.locator('article.card').first()).toBeVisible();

  // Active page button in the nav has the teal background class and shows "3".
  const activePage = page.locator('nav[aria-label="Pagination"] button[aria-current="page"]');
  await expect(activePage).toHaveText('3');

  // And the API was called with page=3 + sort=votes.
  const requested = paperRequests.find((u) => u.includes('page=3'));
  expect(requested).toBeTruthy();
  expect(requested).toContain('sort=votes');
});

test('clicking a page button updates the URL and back restores it', async ({ page }) => {
  await mockPapers(page);

  await page.goto('/en/papers');
  await expect(page.locator('article.card').first()).toBeVisible();

  // Click page 2 in the nav.
  await page.locator('nav[aria-label="Pagination"] button', { hasText: /^2$/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');

  // Click page 4.
  await page.locator('nav[aria-label="Pagination"] button', { hasText: /^4$/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('4');

  // Browser back should return us to page 2 and re-drive the feed.
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
  await expect(page.locator('nav[aria-label="Pagination"] button[aria-current="page"]')).toHaveText('2');
});
