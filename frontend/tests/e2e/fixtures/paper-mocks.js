/**
 * Shared paper-route mocking helpers for E2E specs that drive
 * `/edit/:author/:permlink` or otherwise rely on a deterministic
 * `/api/papers/:author/:permlink` response shape.
 *
 * Originally duplicated verbatim across `edit-paper.spec.js` and
 * `coauthor-accredited-prefill.spec.js`. Extracted here so the non-obvious
 * Playwright route-dispatch-order rationale (see `installPaperMocks` below)
 * lives in exactly one place and the two specs cannot drift.
 */

/**
 * Wrap arbitrary data in the standard PEvO `{ status, data }` API envelope so
 * fulfilled routes match the shape `frontend/src/api.js` expects.
 */
export function envelope(data) {
  return { status: 'ok', data };
}

/**
 * Install `page.route` handlers covering the three paper-related endpoints
 * the edit page reads on load (`/api/papers/:a/:p`, `/enrichment`,
 * `/invalidate`).
 *
 * Why mocked paper data: the edit page reads `head_author/head_permlink`,
 * `authors[].hive`, and the existing `pevo` json_metadata block to decide
 * `isAuthorized` / `isContinuation`. Pinning those fields against a real
 * HAF-indexed paper means the spec assertions drift whenever HAF content
 * changes. Mocking the routes lets each scenario control the exact
 * authorship/review shape it asserts on.
 *
 * Playwright dispatches page.route matches in REVERSE registration order
 * (most-recently-registered first), with route.fallback() walking back
 * through earlier handlers. So we register the suffix-specific handlers
 * (enrichment, invalidate) FIRST and the bare paper route LAST. At runtime
 * the bare matcher fires first; for /enrichment and /invalidate URLs its
 * else-branch calls route.fallback(), which then resolves to the
 * earlier-registered specific handlers below. Re-ordering these without
 * adjusting the fallback dispatch causes silent test breakage where the
 * suffix routes never reach their handler.
 */
export async function installPaperMocks(page, { paper, reviews = [], claims = [] }) {
  const paperPath = `/api/papers/${encodeURIComponent(paper.author)}/${encodeURIComponent(paper.permlink)}`;

  await page.route(`**${paperPath}/enrichment`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope({ reviews, authorship_claims: claims })),
    });
  });

  await page.route(`**${paperPath}/invalidate`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope({ ok: true })),
    });
  });

  await page.route(`**${paperPath}**`, async (route) => {
    const url = route.request().url();
    // This bare-paper route is registered LAST and therefore fires FIRST by
    // Playwright's dispatch order. For suffix URLs (/enrichment,
    // /invalidate, /comments) we call route.fallback() to hand off to the
    // earlier-registered specific handlers above; the bare matcher itself
    // services the exact `/papers/:a/:p` request and the `?version=` query
    // variants.
    if (url.includes('/enrichment') || url.includes('/invalidate') || url.includes('/comments')) {
      return route.fallback();
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope(paper)),
    });
  });
}
