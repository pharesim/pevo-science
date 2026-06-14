/**
 * E2E coverage for the ORCID supersession display contract on list-card
 * surfaces: paper-feed (rendering `paperCardTemplate`) and the profile-page
 * inline publications listing (which reuses the same shared `orcid.*` i18n
 * namespace + helper trio).
 *
 * Companion to `paper-detail-orcid-discrepancy.spec.js` (single-paper view).
 * The acceptance criterion that motivates this file is "one assertion per
 * surface that a discrepant author renders the indicator and an undiscrepant
 * author does not."
 *
 * Test-mocked clause: the supersession projection is backend-emitted, so the
 * three list endpoints' response shape is the consumer contract. Mocking lets
 * each surface assert the indicator branching deterministically.
 *   - (a) impractical real path: cannot reliably hold a single HAF-indexed
 *         paper with one discrepant + one matching author across the
 *         shared-corpus E2E node.
 *   - (b) auth bypass: none — list and profile-papers routes are anonymous
 *         reads; no `verifyHiveSignature` middleware fires.
 *   - (c) real-path companion: the integrated supersession path
 *         (`active_accreditations` → `authorsWithSupersessionSelect` →
 *         `applyAuthorSupersession`) is covered backend-side by the
 *         `/api/papers` canonical-ORCID-resolution integration tests; the
 *         paper-detail E2E sibling spec exercises the helper trio against a
 *         real Alpine render of a four-case lattice.
 */

import { test, expect } from './fixtures/keychain.js';

const APP_TAG = 'pevotest';

function buildPaperCardRow({ author, permlink, title, authors }) {
  const pevoMeta = {
    type: 'paper',
    version: 1,
    discipline: 'Computer Science',
    keywords: ['testing'],
    authors,
    citations: [],
  };
  return {
    author,
    permlink,
    title,
    body: 'abstract preview',
    created: '2026-05-20T00:00:00.000Z',
    discipline: 'Computer Science',
    is_accredited: true,
    source: 'native',
    authors,
    accredited_authors: authors.filter((a) => a.hive).map((a) => a.hive),
    net_votes: 0,
    review_count: 0,
    citation_count: 0,
    json_metadata: { app: `${APP_TAG}/0.1.0`, [APP_TAG]: pevoMeta },
  };
}

test('paper-feed list card renders the discrepancy indicator on discrepant authors only', async ({ page }) => {
  const papers = [
    buildPaperCardRow({
      author: 'alice',
      permlink: 'paper-discrepant',
      title: 'Paper With Discrepant Author',
      authors: [
        {
          name: 'Alice Discrepant',
          hive: 'alice',
          orcid: '0000-0001-1111-1111',
          orcid_verified: '0000-0002-2222-2222',
          orcid_discrepancy: true,
          affiliation: 'Discrepant University',
        },
      ],
    }),
    buildPaperCardRow({
      author: 'bob',
      permlink: 'paper-matching',
      title: 'Paper With Matching Author',
      authors: [
        {
          name: 'Bob Matching',
          hive: 'bob',
          orcid: '0000-0003-3333-3333',
          orcid_verified: '0000-0003-3333-3333',
          orcid_discrepancy: false,
          affiliation: 'Matching University',
        },
      ],
    }),
  ];

  await page.route('**/api/papers*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: papers,
        meta: { total: papers.length, limit: 10, page: 1 },
      }),
    });
  });
  // Empty disciplines avoids HAF dependency for the feed render.
  await page.route('**/api/disciplines*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', data: [] }),
    });
  });

  await page.goto('/en/papers');
  await expect(page.locator('article.card').first()).toBeVisible();

  const discrepantCard = page.locator('article.card').filter({ hasText: 'Paper With Discrepant Author' });
  const matchingCard = page.locator('article.card').filter({ hasText: 'Paper With Matching Author' });

  // Discrepant author: canonical = verified, indicator visible with both values.
  await expect(discrepantCard.getByTestId('orcid-link')).toHaveAttribute(
    'href',
    'https://orcid.org/0000-0002-2222-2222',
  );
  const discrepantIndicator = discrepantCard.getByTestId('orcid-discrepancy-indicator');
  await expect(discrepantIndicator).toBeVisible();
  const title = await discrepantIndicator.getAttribute('title');
  expect(title).toContain('0000-0001-1111-1111');
  expect(title).toContain('0000-0002-2222-2222');

  // Matching author: no indicator.
  await expect(matchingCard.getByTestId('orcid-link')).toHaveAttribute(
    'href',
    'https://orcid.org/0000-0003-3333-3333',
  );
  await expect(matchingCard.getByTestId('orcid-discrepancy-indicator')).toHaveCount(0);
});

test('profile inline publications list: discrepancy indicator on discrepant authors only', async ({ page }) => {
  const username = 'profile-test';

  await page.route(`**/api/profile/${username}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: {
          username,
          display_name: 'Profile Test',
          reputation_score: 0,
          reputation_breakdown: { publications: 0, reviews: 0, citations: 0, community_votes: 0 },
          paper_count: 2,
          review_count: 0,
          citation_count: 0,
          first_post_date: '2026-01-01T00:00:00Z',
          accreditation: null,
        },
      }),
    });
  });

  const profilePapers = [
    buildPaperCardRow({
      author: username,
      permlink: 'profile-paper-discrepant',
      title: 'Profile Paper With Discrepant Author',
      authors: [
        {
          name: 'Carol Discrepant',
          hive: 'carol',
          orcid: '0000-0001-1111-1111',
          orcid_verified: '0000-0002-2222-2222',
          orcid_discrepancy: true,
          affiliation: 'Disc U',
        },
      ],
    }),
    buildPaperCardRow({
      author: username,
      permlink: 'profile-paper-matching',
      title: 'Profile Paper With Matching Author',
      authors: [
        {
          name: 'Dave Matching',
          hive: 'dave',
          orcid: '0000-0004-4444-4444',
          orcid_verified: '0000-0004-4444-4444',
          orcid_discrepancy: false,
          affiliation: 'Match U',
        },
      ],
    }),
  ];

  await page.route(`**/api/profile/${username}/papers*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: profilePapers,
        meta: { total: profilePapers.length, limit: 10, page: 1 },
      }),
    });
  });

  await page.goto(`/en/profile/${username}`);
  await expect(page.locator('h1, h2').filter({ hasText: 'Profile Test' }).first()).toBeVisible();

  // Wait for publications listing to populate. The profile-page Publications
  // tab is the default; cards render from the mocked papers response. Each
  // publication is wrapped in <article class="card"> by profile.js, so we
  // anchor on that same selector (matches the paper-feed half above).
  const discrepantRow = page.locator('article.card').filter({ hasText: 'Profile Paper With Discrepant Author' });
  const matchingRow = page.locator('article.card').filter({ hasText: 'Profile Paper With Matching Author' });
  await expect(discrepantRow).toBeVisible();
  await expect(matchingRow).toBeVisible();

  await expect(discrepantRow.getByTestId('orcid-discrepancy-indicator')).toHaveCount(1);
  await expect(matchingRow.getByTestId('orcid-discrepancy-indicator')).toHaveCount(0);
});
