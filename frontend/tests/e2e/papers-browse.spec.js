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

test('papers list renders, discipline filter narrows, search returns matches', async ({ page }) => {
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
  // Pick the first real option. `option[value!=""]` skips the "All disciplines" entry.
  const firstDiscipline = await disciplineSelect
    .locator('option:not([value=""])')
    .first()
    .getAttribute('value');
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
  for (const paper of filterBody.data) {
    expect(paper.discipline).toBe(firstDiscipline);
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
