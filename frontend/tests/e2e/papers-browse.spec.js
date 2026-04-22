/**
 * E2E-READ-1 — Paper list, discipline filter, and search against real HAF.
 *
 * Data source: the HAF node is shared read-only across dev and E2E runs, so
 * the spec asserts against whatever PEvO-tagged papers are indexed for
 * APP_TAG (currently `pevotest`). Bridge papers bypass the accreditation
 * filter server-side, so the list is non-empty even with an empty
 * `pevo_app_test` accreditation table.
 *
 * The spec intentionally avoids asserting exact counts or titles so it
 * stays green as new pevotest-tagged content lands on the chain. It
 * verifies: list renders, discipline filter narrows to matching items,
 * search returns a result for a known keyword, and the paper card links
 * to a detail URL.
 */

import { test, expect } from './fixtures/keychain.js';

test('papers list renders, discipline filter narrows, search returns matches', async ({ page, request }) => {
  // Preflight: the discipline-filter portion of the spec requires ≥1 paper in
  // the HAF corpus with a discipline set. If /api/disciplines returns empty
  // (beta corpus with no disciplined papers), skip readably rather than
  // hanging on the 30s default locator timeout with an opaque message.
  const disciplinesPreflight = await request.get('/api/disciplines');
  if (disciplinesPreflight.ok()) {
    const body = await disciplinesPreflight.json();
    if (!Array.isArray(body.data) || body.data.length === 0) {
      test.skip(true, 'skipped: no disciplines in corpus. Spec requires >=1 paper with a discipline set.');
    }
  }

  // ─── List renders ────────────────────────────────────────────
  const listResponsePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/papers') && resp.request().method() === 'GET',
  );
  await page.goto('/en/papers');

  const listResp = await listResponsePromise;
  expect(listResp.status()).toBe(200);
  const listBody = await listResp.json();
  expect(listBody.status).toBe('ok');
  expect(Array.isArray(listBody.data)).toBe(true);
  expect(listBody.data.length).toBeGreaterThan(0);

  // At least one rendered card. The article per paper uses Alpine x-for; we
  // key off the discipline badge class since it's on every card.
  const cards = page.locator('article.card:has(.badge-discipline)');
  await expect(cards.first()).toBeVisible();
  const initialCardCount = await cards.count();
  expect(initialCardCount).toBeGreaterThan(0);

  // ─── Discipline filter ───────────────────────────────────────
  const disciplineSelect = page.locator('select[x-model="discipline"]');
  await expect(disciplineSelect).toBeVisible();
  // Options are populated asynchronously by a separate `/api/disciplines`
  // request (not covered by the page-level `/api/papers` waitForResponse).
  // Waiting on the `<select>` element alone only proves the element exists,
  // not that Alpine's `x-for` has rendered its option children. Assert on
  // the option's `value` attribute so Playwright auto-waits for the element
  // to attach AND carry a non-empty value — `toBeVisible()` is wrong here
  // because `<option>` children inside a closed `<select>` have zero bounds.
  // `option[value!=""]` skips the "All disciplines" entry.
  const firstRealOption = disciplineSelect.locator('option:not([value=""])').first();
  await expect(firstRealOption).toHaveAttribute('value', /.+/);
  const firstDiscipline = await firstRealOption.getAttribute('value');
  expect(firstDiscipline).toBeTruthy();

  const filterResponsePromise = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/papers') &&
      resp.url().includes(`discipline=${encodeURIComponent(firstDiscipline)}`),
  );
  await disciplineSelect.selectOption(firstDiscipline);
  const filterResp = await filterResponsePromise;
  expect(filterResp.status()).toBe(200);
  const filterBody = await filterResp.json();
  expect(filterBody.data.length).toBeGreaterThan(0);
  // Every returned paper matches the selected discipline (authoritative check).
  // The filter value is `canon_name` (lowercase slug, e.g. "computer science"),
  // while papers carry the `display_name` form (e.g. "Computer Science") on
  // their `discipline` field. Compare case-insensitively so we assert the
  // semantic invariant ("this paper is in the selected discipline") without
  // coupling to the backend's display-case choice.
  for (const paper of filterBody.data) {
    expect(paper.discipline.toLowerCase()).toBe(firstDiscipline);
  }

  // ─── Search ──────────────────────────────────────────────────
  const searchResponsePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/search') && resp.url().includes('q=consensus'),
  );
  await page.goto('/en/search?q=consensus');
  const searchResp = await searchResponsePromise;
  expect(searchResp.status()).toBe(200);
  const searchBody = await searchResp.json();
  expect(searchBody.data.length).toBeGreaterThan(0);
  // Match found the "An emerging consensus for open evaluation" bridge paper
  // we know exists in HAF for pevotest.
  const paperHit = searchBody.data.find(
    (r) => (r.type === 'paper' || r.type === 'bridge_paper') &&
           (r.title || '').toLowerCase().includes('consensus'),
  );
  expect(paperHit).toBeTruthy();

  const searchResultLink = page.locator(
    `a[href*="/paper/${paperHit.author}/${paperHit.permlink}"]`,
  ).first();
  await expect(searchResultLink).toBeVisible();

  // ─── Card links to detail URL ────────────────────────────────
  await searchResultLink.click();
  await expect(page).toHaveURL(
    new RegExp(`/paper/${paperHit.author}/${paperHit.permlink}`),
  );
});
