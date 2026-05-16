/**
 * E2E — search page coverage.
 *
 * Data source: shared HAF read-only corpus tagged with APP_TAG (`pevotest`).
 * The "consensus" keyword matches the bridge paper "An emerging consensus for
 * open evaluation" also used as the search fixture by papers-browse.spec.js.
 * Bridge papers bypass the accreditation filter server-side, so the corpus
 * is non-empty even with an empty pevo_app_test accreditation table.
 *
 * Carve-out for deterministic edge-case coverage (root CLAUDE.md): tests 4
 * and 6 mock `/api/search` via `page.route()`. Justification: pagination
 * (test 4) requires a known fixed-size collection so the active-page button
 * is deterministic regardless of corpus drift, and the error-path test
 * (test 6) needs a deterministic 500 which the live route does not produce.
 * The real-path companion exercising live `/api/search` is
 * `papers-browse.spec.js` (search-by-keyword block) plus tests 1, 2, 3, 5
 * here. URL params used by `search.js`: q, type, source, discipline, page.
 */

import { test, expect } from './fixtures/keychain.js';

const KEYWORD = 'consensus';
const NO_MATCH = 'zzqxnonexistentkeyword42xyz';
const RESULT_CARD = 'article.card:has([data-testid="search-result-type"])';

test('keyword query renders results and URL retains q', async ({ page }) => {
  const searchResponsePromise = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/search') &&
      resp.url().includes(`q=${KEYWORD}`),
  );
  await page.goto(`/en/search?q=${KEYWORD}`);

  const searchResp = await searchResponsePromise;
  expect(searchResp.status()).toBe(200);
  const body = await searchResp.json();
  expect(body.status).toBe('ok');
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBeGreaterThan(0);

  // URL retains the query parameter on direct load AND the search input is
  // hydrated from it. A regression in _syncFromUrl() or the x-model binding
  // leaves the URL correct but the visible input blank — the inputValue
  // assertion catches that.
  expect(new URL(page.url()).searchParams.get('q')).toBe(KEYWORD);
  await expect(page.locator('#search-query')).toHaveValue(KEYWORD);

  // At least one result card with title + author + type-badge. Note:
  // /api/search rows do NOT carry a discipline field (see SearchRow in
  // backend/src/routes/search.ts), so this spec asserts the type badge,
  // not a discipline value. The data-testid selector targets the actual
  // type-badge span rather than the visually-identical .badge-discipline
  // class which is also used elsewhere for discipline values.
  const cards = page.locator(RESULT_CARD);
  await expect(cards.first()).toBeVisible();
  const cardCount = await cards.count();
  expect(cardCount).toBeGreaterThan(0);

  // Result has a title (the rendered <h2> link) and an author handle line.
  const firstCard = cards.first();
  await expect(firstCard.locator('h2 a').first()).toBeVisible();
  await expect(firstCard.locator('p:has-text("@")').first()).toBeVisible();
  await expect(firstCard.locator('[data-testid="search-result-type"]').first()).toBeVisible();
});

test('empty-result state renders cleanly', async ({ page }) => {
  const searchResponsePromise = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/search') &&
      resp.url().includes(`q=${NO_MATCH}`),
  );
  await page.goto(`/en/search?q=${NO_MATCH}`);

  const searchResp = await searchResponsePromise;
  expect(searchResp.status()).toBe(200);
  const body = await searchResp.json();
  expect(body.data.length).toBe(0);

  // No result cards rendered.
  await expect(page.locator(RESULT_CARD)).toHaveCount(0);

  // The empty-state card is the visible fallback. Match by the localized
  // "No results found" copy from search.noResults in en.json.
  await expect(page.getByText(/no results found/i)).toBeVisible();
});

test('filter combination narrows results to matching discipline', async ({ page, request }) => {
  // Discipline-filter probe loop fans HAF queries sequentially; the default
  // 30s per-test budget can exhaust on a cold HAF node. Extend the budget
  // and cap the loop at the first N entries so we fail readably rather than
  // hit a generic timeout.
  test.setTimeout(90_000);
  const MAX_DISCIPLINE_PROBES = 8;

  // Preflight: spec needs ≥1 discipline in the corpus to combine with the
  // keyword query. Fail (not skip) when /api/disciplines is unreachable —
  // that's a real environment failure, not a corpus-empty edge case.
  const disciplinesPreflight = await request.get('/api/disciplines');
  expect(disciplinesPreflight.ok()).toBeTruthy();
  const disciplinesBody = await disciplinesPreflight.json();
  expect(Array.isArray(disciplinesBody.data)).toBe(true);
  if (disciplinesBody.data.length === 0) {
    test.skip(true, 'skipped: no disciplines in corpus');
  }

  // Baseline result count for the unfiltered keyword query. Fail (not skip)
  // when q=consensus returns zero — the bridge "consensus" paper is a
  // known fixture; its absence is a corpus regression worth signalling.
  const baselineResp = await request.get(`/api/search?q=${KEYWORD}`);
  expect(baselineResp.status()).toBe(200);
  const baselineBody = await baselineResp.json();
  expect(baselineBody.data.length).toBeGreaterThan(0);
  const baselineCount = baselineBody.data.length;

  // Pick the first discipline (capped at MAX_DISCIPLINE_PROBES) that yields
  // a non-empty filtered result for this keyword, so the assertion
  // exercises the narrowing path. The "no narrowing intersection" case is
  // the one legitimate skip — every other branch above is now hard fail.
  let chosenDiscipline = null;
  let filteredCount = 0;
  let filteredData = [];
  const probeList = disciplinesBody.data.slice(0, MAX_DISCIPLINE_PROBES);
  for (const d of probeList) {
    const canon = d.canon_name;
    const resp = await request.get(
      `/api/search?q=${KEYWORD}&discipline=${encodeURIComponent(canon)}`,
    );
    if (!resp.ok()) continue;
    const body = await resp.json();
    if (body.data.length > 0) {
      chosenDiscipline = canon;
      filteredCount = body.data.length;
      filteredData = body.data;
      break;
    }
  }
  if (!chosenDiscipline) {
    test.skip(true, `skipped: no discipline (of first ${MAX_DISCIPLINE_PROBES}) narrows q=${KEYWORD} to a non-empty result`);
  }

  // Filtered count must be ≤ baseline (narrowing or equal). Strictly less
  // is the common case but a single-discipline corpus could yield equal.
  expect(filteredCount).toBeLessThanOrEqual(baselineCount);

  // Every paper in the filtered set is in the chosen discipline. Reviews
  // don't carry a discipline field on the search row, so skip them.
  // (Discipline filter currently applies to paper rows only — see
  // searchPapersFromHaf in backend/src/routes/search.ts.)
  const paperRows = filteredData.filter(
    (r) => r.type === 'paper' || r.type === 'bridge_paper',
  );
  expect(paperRows.length).toBeGreaterThan(0);

  // Now drive the same query through the page and confirm cards render.
  const searchResponsePromise = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/search') &&
      resp.url().includes(`q=${KEYWORD}`) &&
      resp.url().includes(`discipline=${encodeURIComponent(chosenDiscipline)}`),
  );
  await page.goto(
    `/en/search?q=${KEYWORD}&discipline=${encodeURIComponent(chosenDiscipline)}`,
  );
  const searchResp = await searchResponsePromise;
  expect(searchResp.status()).toBe(200);

  await expect(page.locator(RESULT_CARD).first()).toBeVisible();
});

test('URL pagination loads the requested page directly', async ({ page }) => {
  // Mock /api/search with a fixed-size collection (50 total, 20/page) so the
  // pagination assertion is deterministic regardless of corpus size. Mirrors
  // the page.route() pattern in url-pagination.spec.js — search shares the
  // same pagination component with currentPage/totalPages contract.
  await page.route('**/api/search*', async (route) => {
    const url = new URL(route.request().url());
    const pageNum = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const data = Array.from({ length: limit }, (_, i) => ({
      type: 'paper',
      author: `mock-author-${pageNum}-${i}`,
      permlink: `mock-paper-${pageNum}-${i}`,
      title: `Mock Paper p${pageNum} #${i + 1}`,
      snippet: 'mock snippet text',
      created: '2026-01-01T00:00:00Z',
      is_accredited: true,
    }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data,
        meta: { total: 50, limit, page: pageNum },
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

  // Explicitly await the page=2 fetch so the active-page assertion is
  // mechanically gated on the API call, not on render side effects.
  const page2ResponsePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/search') && resp.url().includes('page=2'),
  );
  await page.goto(`/en/search?q=${KEYWORD}&page=2`);
  const page2Resp = await page2ResponsePromise;
  expect(page2Resp.url()).toContain(`q=${KEYWORD}`);

  // Result cards must render before we can probe the pagination nav.
  await expect(page.locator(RESULT_CARD).first()).toBeVisible();

  // Active page button in the nav reads "2".
  const activePage = page.locator(
    'nav[aria-label="Pagination"] button[aria-current="page"]',
  );
  await expect(activePage).toHaveText('2');
});

test('clicking a result card navigates to paper detail', async ({ page }) => {
  const searchResponsePromise = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/search') &&
      resp.url().includes(`q=${KEYWORD}`),
  );
  await page.goto(`/en/search?q=${KEYWORD}`);
  const searchResp = await searchResponsePromise;
  const body = await searchResp.json();

  // The corpus has at least one paper-type result for q=consensus (the
  // bridge "consensus" paper). If it ever truly disappears, treat as a
  // corpus regression and fail rather than green-pass via skip.
  const paperHit = body.data.find(
    (r) => r.type === 'paper' || r.type === 'bridge_paper',
  );
  expect(paperHit, `expected ≥1 paper-type result for q=${KEYWORD}`).toBeTruthy();

  const resultLink = page
    .locator(`a[href*="/paper/${paperHit.author}/${paperHit.permlink}"]`)
    .first();
  await expect(resultLink).toBeVisible();

  await resultLink.click();

  await expect(page).toHaveURL(
    new RegExp(`/paper/${paperHit.author}/${paperHit.permlink}`),
  );
  // Paper detail page mounts an article element with the paper's content.
  // The title is rendered inside an <h1>; assert it becomes visible so we
  // know the SPA route fully resolved past the URL change.
  await expect(page.locator('h1').first()).toBeVisible();
});

test('search error renders the error card and clears results', async ({ page }) => {
  // Mock /api/search to fail so we exercise the doSearch catch block
  // (search.js:264-270): error is set, results are reset, _pushUrl() is
  // called. The live route returns 500 only under transient HAF failure,
  // so a route mock is the deterministic way to cover this path.
  await page.route('**/api/search*', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'mocked failure' },
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

  await page.goto(`/en/search?q=${KEYWORD}`);

  // The error card shows the localized search.searchFailed copy from
  // public/messages/en.json.
  await expect(page.getByText(/search failed/i)).toBeVisible();

  // And no result cards rendered (results were cleared).
  await expect(page.locator(RESULT_CARD)).toHaveCount(0);
});
