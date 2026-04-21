/**
 * E2E-BRIDGE-1 — Preprint bridge preview.
 *
 * Drives /bridge for two known identifiers (an arXiv ID and a bioRxiv URL),
 * mocks the `/api/bridge/lookup` and `/api/bridge/check` endpoints with
 * canned responses, and asserts that title, authors, and abstract render in
 * the preview card.
 *
 * Why mock at the backend API boundary rather than at arxiv.org / biorxiv.org:
 * the frontend never talks to arXiv or bioRxiv directly — it calls the PEvO
 * backend, which proxies the upstream fetch and returns a normalized
 * `BridgeLookupResult`. Intercepting the `/api/bridge/*` calls keeps the
 * canned payload aligned with the contract the frontend renders against
 * (see agents/docs/api-contracts/bridge.md) and avoids coupling the spec to
 * the upstream arXiv/CrossRef response shapes, which the backend translates.
 *
 * Stops before the register/publish step — that flow writes to the Hive
 * chain via the bridge backend posting key and is deliberately out of scope
 * for this spec.
 */

import { test, expect } from './fixtures/keychain.js';

const ARXIV_IDENTIFIER = '2301.12345';
const BIORXIV_IDENTIFIER = 'https://www.biorxiv.org/content/10.1101/2024.01.15.575678v1';

const ARXIV_LOOKUP = {
  source_type: 'arxiv',
  doi: null,
  arxiv_id: ARXIV_IDENTIFIER,
  title: 'Attention Is All You Need (E2E Fixture)',
  authors: [
    { name: 'Ashish Vaswani', orcid: null, affiliation: 'Google Brain' },
    { name: 'Noam Shazeer', orcid: null, affiliation: 'Google Brain' },
    { name: 'Niki Parmar', orcid: null, affiliation: 'Google Research' },
  ],
  abstract:
    'We introduce the Transformer, a sequence transduction model based entirely on attention. This is a canned E2E fixture abstract used to verify bridge preview rendering.',
  published_date: '2023-01-15',
  source_name: 'arXiv',
  source_url: `https://arxiv.org/abs/${ARXIV_IDENTIFIER}`,
  pdf_url: `https://arxiv.org/pdf/${ARXIV_IDENTIFIER}`,
  license: null,
  subjects: ['cs.CL', 'cs.LG'],
};

const BIORXIV_LOOKUP = {
  source_type: 'crossref',
  doi: '10.1101/2024.01.15.575678',
  arxiv_id: null,
  title: 'Synaptic Plasticity in Cortical Microcircuits (E2E Fixture)',
  authors: [
    { name: 'Jane Q. Scientist', orcid: '0000-0002-1825-0097', affiliation: 'Example University' },
    { name: 'John Doe', orcid: null, affiliation: null },
  ],
  abstract:
    'Canned E2E fixture abstract for a bioRxiv preprint. bioRxiv URLs resolve to a DOI server-side, so the backend normalizes them to a crossref-typed lookup result.',
  published_date: '2024-01-16',
  source_name: 'bioRxiv',
  source_url: 'https://www.biorxiv.org/content/10.1101/2024.01.15.575678v1',
  pdf_url: 'https://www.biorxiv.org/content/10.1101/2024.01.15.575678v1.full.pdf',
  license: 'https://creativecommons.org/licenses/by/4.0/',
  subjects: ['Neuroscience'],
};

const NOT_REGISTERED_CHECK = {
  exists: false,
  author: null,
  permlink: null,
  title: null,
  created: null,
};

function okEnvelope(data) {
  return { status: 'ok', data };
}

async function installBridgeMocks(page, { lookup, check }) {
  // Match backend contract paths exactly. Query string lives after the path,
  // so `**/api/bridge/lookup*` matches both `?identifier=...` and no-query.
  await page.route('**/api/bridge/lookup*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(okEnvelope(lookup)),
    });
  });

  await page.route('**/api/bridge/check*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(okEnvelope(check)),
    });
  });
}

test('bridge preview renders title, authors, and abstract for an arXiv ID', async ({ page }) => {
  await installBridgeMocks(page, { lookup: ARXIV_LOOKUP, check: NOT_REGISTERED_CHECK });

  await page.goto('/en/bridge');
  await page.waitForSelector('[x-data="bridgePage"]');

  // Fill the identifier and wait for both lookup and check to fire before
  // asserting on the preview DOM — the handler calls them in parallel.
  const lookupRequestPromise = page.waitForRequest(
    (req) =>
      req.url().includes('/api/bridge/lookup') &&
      req.url().includes(`identifier=${encodeURIComponent(ARXIV_IDENTIFIER)}`),
  );
  const checkRequestPromise = page.waitForRequest(
    (req) =>
      req.url().includes('/api/bridge/check') &&
      req.url().includes(`identifier=${encodeURIComponent(ARXIV_IDENTIFIER)}`),
  );

  await page.locator('#bridge-id').fill(ARXIV_IDENTIFIER);
  await page.locator('button:has-text("Look Up")').click();

  await Promise.all([lookupRequestPromise, checkRequestPromise]);

  // Preview card appears once `lookup` state is populated.
  const previewHeading = page.getByRole('heading', { name: 'Preprint Found' });
  await expect(previewHeading).toBeVisible();

  // Title — rendered as the h3 directly after the previewTitle heading.
  await expect(page.locator('h3', { hasText: ARXIV_LOOKUP.title })).toBeVisible();

  // Authors — joined with ", " by the template (bridge.js L66).
  const authorsText = ARXIV_LOOKUP.authors.map((a) => a.name).join(', ');
  await expect(page.getByText(authorsText)).toBeVisible();

  // Abstract — rendered inside a line-clamp-4 block; text is there even if
  // visually clipped, so toContainText matches regardless of clamp state.
  await expect(page.locator('.line-clamp-4')).toContainText(ARXIV_LOOKUP.abstract.slice(0, 60));

  // Source label links to source_url.
  const sourceLink = page.locator(`a[href="${ARXIV_LOOKUP.source_url}"]`);
  await expect(sourceLink).toBeVisible();
  await expect(sourceLink).toHaveText(ARXIV_LOOKUP.source_name);

  // Duplicate warning must NOT be shown for a not-yet-registered preprint.
  await expect(page.getByText('This preprint is already registered on PEvO.')).toHaveCount(0);
});

test('bridge preview renders title, authors, and abstract for a bioRxiv URL', async ({ page }) => {
  await installBridgeMocks(page, { lookup: BIORXIV_LOOKUP, check: NOT_REGISTERED_CHECK });

  await page.goto('/en/bridge');
  await page.waitForSelector('[x-data="bridgePage"]');

  const lookupRequestPromise = page.waitForRequest(
    (req) =>
      req.url().includes('/api/bridge/lookup') &&
      req.url().includes(`identifier=${encodeURIComponent(BIORXIV_IDENTIFIER)}`),
  );
  const checkRequestPromise = page.waitForRequest(
    (req) =>
      req.url().includes('/api/bridge/check') &&
      req.url().includes(`identifier=${encodeURIComponent(BIORXIV_IDENTIFIER)}`),
  );

  await page.locator('#bridge-id').fill(BIORXIV_IDENTIFIER);
  await page.locator('button:has-text("Look Up")').click();

  await Promise.all([lookupRequestPromise, checkRequestPromise]);

  await expect(page.getByRole('heading', { name: 'Preprint Found' })).toBeVisible();

  await expect(page.locator('h3', { hasText: BIORXIV_LOOKUP.title })).toBeVisible();

  const authorsText = BIORXIV_LOOKUP.authors.map((a) => a.name).join(', ');
  await expect(page.getByText(authorsText)).toBeVisible();

  await expect(page.locator('.line-clamp-4')).toContainText(BIORXIV_LOOKUP.abstract.slice(0, 60));

  const sourceLink = page.locator(`a[href="${BIORXIV_LOOKUP.source_url}"]`);
  await expect(sourceLink).toBeVisible();
  await expect(sourceLink).toHaveText(BIORXIV_LOOKUP.source_name);

  // pdf_url is present on this fixture — the PDF link should render.
  const pdfLink = page.locator(`a[href="${BIORXIV_LOOKUP.pdf_url}"]`);
  await expect(pdfLink).toBeVisible();
});
