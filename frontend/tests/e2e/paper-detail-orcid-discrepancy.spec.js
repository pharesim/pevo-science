/**
 * E2E coverage for the ORCID supersession display contract on paper-detail.
 *
 * Test-mocked clause: the supersession projection (`orcid_verified`,
 * `orcid_discrepancy`) is backend-emitted from `active_accreditations` joined
 * against the chain `authors[].hive`. Reproducing all four cases (match,
 * differ, verified-only, chain-only) through real HAF + accreditation state
 * would require seeding production-grade test data per case. The detail
 * route's response shape is the consumer contract; mocking it lets each
 * case be asserted deterministically. Per root CLAUDE.md "Carve-out for
 * deterministic edge-case coverage":
 *   - (a) impractical real path: producing simultaneous match/differ/null
 *         cases on a single HAF-indexed paper.
 *   - (b) auth bypass: none — paper-detail is anonymous read; no
 *         `verifyHiveSignature` middleware fires on `GET /api/papers/:a/:p`.
 *   - (c) real-path companion: the integrated supersession path
 *         (`active_accreditations` → `authorsWithSupersessionSelect` →
 *         `applyAuthorSupersession`) is covered backend-side by
 *         `backend-papers-canonical-orcid-resolution` integration tests
 *         and the cumulative-union backend spec.
 */

import { test, expect } from './fixtures/keychain.js';
import { installPaperMocks } from './fixtures/paper-mocks.js';

const APP_TAG = 'pevotest';

function buildPaperWithAuthors(authors) {
  const author = authors[0].hive || 'alice';
  const permlink = `e2e-orcid-discrepancy-${Date.now().toString(36)}`;
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
    title: 'ORCID Discrepancy Display Test',
    body: '## Abstract\n\nTest paper exercising the ORCID supersession display contract.',
    authors,
    accredited_authors: authors.filter((a) => a.hive).map((a) => a.hive),
    head_author: author,
    head_permlink: permlink,
    canonical_author: author,
    canonical_permlink: permlink,
    created: '2026-05-20T00:00:00.000Z',
    net_votes: 0,
    vote_strength: 'normal',
    voters: [],
    citation_count: 0,
    review_count: 0,
    json_metadata: { app: `${APP_TAG}/0.1.0`, [APP_TAG]: pevoMeta },
    versions: [{ version_number: 1, author, permlink, created: '2026-05-20T00:00:00.000Z' }],
    authorship_claims: [],
  };
}

test('paper-detail: canonical ORCID renders verified value; discrepancy indicator surfaces both values', async ({
  page,
}) => {
  const authors = [
    {
      name: 'Alice Match',
      hive: 'alice',
      orcid: '0000-0001-1111-1111',
      orcid_verified: '0000-0001-1111-1111',
      orcid_discrepancy: false,
      affiliation: 'Match University',
    },
    {
      name: 'Bob Discrepant',
      hive: 'bob',
      orcid: '0000-0002-2222-2222',
      orcid_verified: '0000-0003-3333-3333',
      orcid_discrepancy: true,
      affiliation: 'Discrepant Institute',
    },
    {
      name: 'Carol ChainOnly',
      hive: 'carol',
      orcid: '0000-0004-4444-4444',
      orcid_verified: null,
      orcid_discrepancy: false,
      affiliation: 'Chain-Only College',
    },
    {
      name: 'Dave NoOrcid',
      hive: 'dave',
      orcid: null,
      orcid_verified: null,
      orcid_discrepancy: false,
      affiliation: 'No ORCID U',
    },
  ];

  const paper = buildPaperWithAuthors(authors);
  await installPaperMocks(page, { paper });

  await page.goto(`/en/paper/${paper.author}/${paper.permlink}`);
  await page.waitForSelector('[x-data="paperDetailPage"]');
  await expect(page.locator('h1, h2').filter({ hasText: paper.title })).toBeVisible();

  const authorRows = page.locator('[x-data="paperDetailPage"] .flex.flex-wrap.items-center.gap-x-3.gap-y-2 > span');
  await expect(authorRows).toHaveCount(4);

  const aliceRow = authorRows.filter({ hasText: 'Alice Match' });
  const bobRow = authorRows.filter({ hasText: 'Bob Discrepant' });
  const carolRow = authorRows.filter({ hasText: 'Carol ChainOnly' });
  const daveRow = authorRows.filter({ hasText: 'Dave NoOrcid' });

  // Alice: verified == chain, displays chain (= verified) value, no indicator.
  await expect(aliceRow.getByTestId('orcid-link')).toHaveAttribute(
    'href',
    'https://orcid.org/0000-0001-1111-1111',
  );
  await expect(aliceRow.locator('.font-mono')).toHaveText('0000-0001-1111-1111');
  await expect(aliceRow.getByTestId('orcid-discrepancy-indicator')).toHaveCount(0);

  // Bob: verified differs from chain, canonical display = verified, indicator visible
  // with both values exposed via title + aria-label.
  await expect(bobRow.getByTestId('orcid-link')).toHaveAttribute(
    'href',
    'https://orcid.org/0000-0003-3333-3333',
  );
  await expect(bobRow.locator('.font-mono')).toHaveText('0000-0003-3333-3333');
  const bobIndicator = bobRow.getByTestId('orcid-discrepancy-indicator');
  await expect(bobIndicator).toBeVisible();
  const bobTitle = await bobIndicator.getAttribute('title');
  expect(bobTitle).toContain('0000-0002-2222-2222');
  expect(bobTitle).toContain('0000-0003-3333-3333');
  const bobAria = await bobIndicator.getAttribute('aria-label');
  expect(bobAria).toContain('0000-0002-2222-2222');
  expect(bobAria).toContain('0000-0003-3333-3333');

  // Indicator is keyboard-reachable: it renders as a <button>, which is
  // focusable by default. Verify by focusing via Tab from the link.
  await bobRow.getByTestId('orcid-link').focus();
  await page.keyboard.press('Tab');
  await expect(bobIndicator).toBeFocused();

  // Carol: only chain ORCID present, no indicator, falls back to chain value.
  await expect(carolRow.getByTestId('orcid-link')).toHaveAttribute(
    'href',
    'https://orcid.org/0000-0004-4444-4444',
  );
  await expect(carolRow.locator('.font-mono')).toHaveText('0000-0004-4444-4444');
  await expect(carolRow.getByTestId('orcid-discrepancy-indicator')).toHaveCount(0);

  // Dave: no ORCID at all, no link rendered.
  await expect(daveRow.getByTestId('orcid-link')).toHaveCount(0);
  await expect(daveRow.getByTestId('orcid-discrepancy-indicator')).toHaveCount(0);
});
