/**
 * Regression guard for the UI-REFAC-3 P1 visual-order bug in the shared
 * pagination template. The bug was that `:key="i"` (index as key) allowed
 * Alpine to patch DOM nodes in place when the `pages` array reshaped, which
 * could leave ellipses rendered before all page-number buttons instead of
 * between them.
 *
 * The fix pinned `:key="page + '-' + i"` so entries are unique across
 * reshapes. This spec asserts the rendered nav under a known paginated
 * state (>7 pages, current page in the middle) has:
 *   - Previous button as the first nav child,
 *   - Next button as the last,
 *   - at least one ellipsis span BETWEEN page-number buttons.
 *
 * Mocks `/api/papers` at the network layer so the test is deterministic
 * regardless of how many papers the shared HAF node has indexed.
 */

import { test, expect } from './fixtures/keychain.js';

test('pagination nav: Prev first, Next last, ellipsis sits between page-number buttons', async ({ page }) => {
  // Force a paginated state with 10 pages, current page 5 (middle range
  // so both left and right ellipses render).
  await page.route('**/api/papers*', async (route) => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      author: `e2e-author-${i}`,
      permlink: `mock-paper-${i}`,
      title: `Mock Paper ${i + 1}`,
      body: 'abstract',
      created: '2026-01-01T00:00:00Z',
      discipline: 'physics',
      is_accredited: true,
      source: 'native',
    }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data,
        meta: { total: 100, limit: 10, page: 5 },
      }),
    });
  });

  // Disciplines endpoint — return empty to avoid HAF dependency.
  await page.route('**/api/disciplines*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', data: [] }),
    });
  });

  // Deep-link to page 5 so both a left and right ellipsis render. (At
  // currentPage=1 the template omits 3/4/5/6/7/8/9 entirely, so we can't
  // click our way there.)
  await page.goto('/en/papers?page=5');

  // Wait for a paper card from the mocked response to appear so we know
  // Alpine has rendered the feed (pagination is inside the same template).
  await expect(page.locator('article.card').first()).toBeVisible();

  const nav = page.locator('nav[aria-label="Pagination"]');
  await expect(nav).toBeVisible();

  // Collect the nav's direct children in order, ignoring Alpine's x-for/x-if
  // `<template>` markers that stay in the DOM but carry no visible content.
  // The x-for template wraps each rendered entry in `<div class="contents"
  // role="none">`; `display:contents` flattens the div visually but the DOM
  // node is still a direct child of the nav.
  const children = await nav.evaluate((el) => {
    return Array.from(el.children)
      .filter((child) => child.tagName !== 'TEMPLATE')
      .map((child) => {
        if (child.tagName === 'BUTTON') {
          const text = (child.textContent || '').trim();
          return { type: 'button', text };
        }
        if (child.tagName === 'DIV') {
          const span = child.querySelector('span');
          const btn = child.querySelector('button');
          if (span && (span.textContent || '').trim() === '...') return { type: 'ellipsis' };
          if (btn) return { type: 'page', text: (btn.textContent || '').trim() };
        }
        return { type: 'other', tag: child.tagName };
      });
  });

  // First child is the Previous button, last is the Next button.
  expect(children.length).toBeGreaterThan(0);
  expect(children[0].type).toBe('button');
  expect(children[children.length - 1].type).toBe('button');

  // Between them: pages, ellipses, pages — no ellipsis may appear before
  // all page buttons. Strip the outer prev/next buttons.
  const middle = children.slice(1, -1);
  const firstPageIdx = middle.findIndex((c) => c.type === 'page');
  const lastPageIdx = middle.map((c) => c.type).lastIndexOf('page');
  const ellipsisIndices = middle
    .map((c, i) => (c.type === 'ellipsis' ? i : -1))
    .filter((i) => i >= 0);

  expect(firstPageIdx).toBe(0);
  expect(ellipsisIndices.length).toBeGreaterThan(0);
  for (const i of ellipsisIndices) {
    expect(i).toBeGreaterThan(firstPageIdx);
    expect(i).toBeLessThan(lastPageIdx);
  }
});
