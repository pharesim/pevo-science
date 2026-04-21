/**
 * E2E-READ-2 — Paper detail page rendering against real HAF.
 *
 * Data source: the HAF node is shared read-only across dev and E2E, so the
 * spec reads whatever PEvO-tagged content is already indexed. Rather than
 * hard-coding one paper for every feature, the spec picks the paper list
 * and then drills into whichever paper exposes each facet:
 *
 *   - A paper with non-empty `reviews` for the reviews section.
 *   - A paper with non-zero `net_votes` for the vote section.
 *   - A paper with multi-entry `versions` for the version list.
 *
 * All three facets are wired via the enrichment endpoint (`GET
 * /api/papers/:author/:permlink/enrichment`), which the frontend calls
 * after the initial `fetchPaper`. We wait for both before asserting.
 *
 * For the comments section, HAF has no PEvO-tagged threaded comments
 * currently, so the spec asserts the empty-state rendering. That still
 * verifies the Alpine data/template wiring for the discussion section.
 */

import { test, expect } from './fixtures/keychain.js';

// Fetch the paper list once at suite start so each test can pick the paper
// that exposes the facet it needs. A single roundtrip, shared across tests.
async function fetchPapersList(request) {
  const resp = await request.get('/api/papers?limit=50');
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body.status).toBe('ok');
  expect(Array.isArray(body.data)).toBe(true);
  return body.data;
}

async function fetchEnrichment(request, author, permlink) {
  const resp = await request.get(
    `/api/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/enrichment`,
  );
  expect(resp.status()).toBe(200);
  return (await resp.json()).data;
}

async function fetchDetail(request, author, permlink) {
  const resp = await request.get(
    `/api/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}`,
  );
  expect(resp.status()).toBe(200);
  return (await resp.json()).data;
}

test('detail page renders title, metadata, reviews, and vote count', async ({ page, request }) => {
  const papers = await fetchPapersList(request);
  // Pick the first paper with both reviews and votes in HAF. `review_count`
  // and `net_votes` on the summary view are authoritative for this check.
  const target = papers.find((p) => (p.review_count ?? 0) > 0 && (p.net_votes ?? 0) !== 0);
  expect(target, 'expected at least one pevotest paper with reviews and votes in HAF').toBeTruthy();

  const enrichment = await fetchEnrichment(request, target.author, target.permlink);
  expect(enrichment.reviews.length).toBeGreaterThan(0);
  const firstReview = enrichment.reviews[0];

  const detailResponsePromise = page.waitForResponse(
    (resp) =>
      resp.url().includes(`/api/papers/${encodeURIComponent(target.author)}/${encodeURIComponent(target.permlink)}`) &&
      !resp.url().endsWith('/enrichment') &&
      !resp.url().endsWith('/comments'),
  );
  const enrichmentResponsePromise = page.waitForResponse(
    (resp) => resp.url().endsWith(`/${encodeURIComponent(target.permlink)}/enrichment`),
  );

  await page.goto(`/en/paper/${target.author}/${target.permlink}`);

  const detailResp = await detailResponsePromise;
  expect(detailResp.status()).toBe(200);
  const detailBody = (await detailResp.json()).data;

  // ─── Header: title, discipline badge, created date ───────────
  await expect(page.locator('h1.text-paper-title')).toHaveText(detailBody.title);
  await expect(page.locator('.badge-discipline').first()).toBeVisible();

  // ─── Abstract renders (always visible via x-markdown) ────────
  const abstractContainer = page.locator('.prose.max-w-reading').first();
  await expect(abstractContainer).toBeVisible();

  // ─── Enrichment must land before review/vote assertions ──────
  const enrichmentResp = await enrichmentResponsePromise;
  expect(enrichmentResp.status()).toBe(200);

  // ─── Reviews section renders with correct count + rating bars
  const reviewsHeading = page.getByRole('heading', {
    name: new RegExp(`Peer Reviews?\\s*\\(${enrichment.reviews.length}\\)`, 'i'),
  });
  await expect(reviewsHeading).toBeVisible();

  // Each review card is keyed by permlink; the first review's body must render.
  const reviewBodyPreview = firstReview.body.slice(0, 40).trim();
  if (reviewBodyPreview) {
    await expect(page.getByText(reviewBodyPreview, { exact: false }).first()).toBeVisible();
  }

  // Rating label "methodology" appears (from average ratings + per-review ratings).
  await expect(page.getByText(/methodology/i).first()).toBeVisible();

  // ─── Vote count: with 1 voter the count label is "1 vote" ────
  // Accept both "1 vote" and the Intl-pluralized "1 votes" variants.
  const voteLabel = page.getByText(new RegExp(`${Math.abs(enrichment.net_votes)}\\s+vote`, 'i')).first();
  await expect(voteLabel).toBeVisible();

  // ─── Discussion section renders (comments=empty is fine) ─────
  await expect(page.getByRole('heading', { name: /Discussion|Comments/i })).toBeVisible();
});

test('detail page renders version list when a paper has multiple versions', async ({ page, request }) => {
  const papers = await fetchPapersList(request);

  // Find a paper with >1 version by probing detail endpoints. We walk the
  // list rather than hardcoding a permlink so the spec stays green as HAF
  // contents evolve.
  let target = null;
  let targetVersions = null;
  for (const p of papers) {
    const detail = await fetchDetail(request, p.author, p.permlink);
    if ((detail.versions || []).length > 1) {
      target = p;
      targetVersions = detail.versions;
      break;
    }
  }
  expect(target, 'expected at least one multi-version pevotest paper in HAF').toBeTruthy();

  await page.goto(`/en/paper/${target.author}/${target.permlink}`);

  // Version pills render "v1", "v2", ... for each version.
  for (const v of targetVersions) {
    const pill = page.getByRole('button', { name: new RegExp(`^v${v.version_number}\\b`) });
    await expect(pill.first()).toBeVisible();
  }

  // The latest version pill carries the "Latest" badge.
  const latestNumber = targetVersions[targetVersions.length - 1].version_number;
  const latestPill = page.getByRole('button', { name: new RegExp(`^v${latestNumber}\\b`) }).first();
  await expect(latestPill).toContainText(/latest/i);
});
