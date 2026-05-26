/**
 * E2E — async bridge import queue UX.
 *
 * Covers the UI-side wiring for the asynchronous bridge register model
 * (agents/docs/api-contracts/bridge.md):
 *   1. A 202 enqueue renders the queued state (position + ETA) inline on
 *      /bridge, instead of the prior synchronous-success redirect.
 *   2. A per-user-cap 429 (RATE_LIMITED with details.cap) renders the
 *      cap-specific remediation surface, distinct from a transient error.
 *   3. /my-imports fetches GET /api/bridge/imports and renders entries
 *      spanning pending / in-progress / completed / failed, with the failed
 *      row offering a re-submit (retry = re-POST /register).
 *
 * Why mock at the /api/bridge/* boundary (matches bridge-preview.spec.js):
 * the register/imports backend writes to / reads from the Hive chain and HAF;
 * driving the real path needs a valid Hive signature the Keychain stub cannot
 * produce (see fixtures/keychain.js) and a queue worker tick. Intercepting the
 * API keeps the canned payloads aligned with the documented contract and lets
 * the spec assert the UI reaches the expected state — the layer the fixture
 * constraint allows.
 *
 * Auth: seedAccreditedSession mints a JWT into localStorage so the page's
 * isConnected/isAccredited gates pass and the register/imports requests fire
 * with a bearer token. The backend never sees the request (mocked), so no
 * real accredited HAF account is required.
 *
 * SEC-002 (matches publish.spec.js): minted JWTs end up in localStorage; do
 * not retain traces/videos.
 */

import { test, expect } from './fixtures/keychain.js';
import { seedAccreditedSession } from './fixtures/auth.js';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const ARXIV_IDENTIFIER = '2301.12345';

const ARXIV_LOOKUP = {
  source_type: 'arxiv',
  doi: null,
  arxiv_id: ARXIV_IDENTIFIER,
  title: 'Attention Is All You Need (E2E Fixture)',
  authors: [{ name: 'Ashish Vaswani', orcid: null, affiliation: 'Google Brain' }],
  abstract: 'Canned E2E fixture abstract used to verify the queued-submission flow.',
  published_date: '2023-01-15',
  source_name: 'arXiv',
  source_url: `https://arxiv.org/abs/${ARXIV_IDENTIFIER}`,
  pdf_url: `https://arxiv.org/pdf/${ARXIV_IDENTIFIER}`,
  license: null,
  subjects: ['cs.CL'],
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

function errorEnvelope(code, message, details) {
  return { status: 'error', error: { code, message, details } };
}

async function installLookupMocks(page) {
  await page.route('**/api/bridge/lookup*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(okEnvelope(ARXIV_LOOKUP)) }),
  );
  await page.route('**/api/bridge/check*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(okEnvelope(NOT_REGISTERED_CHECK)) }),
  );
}

async function fillLookupAndRegister(page) {
  await page.goto('/en/bridge');
  await page.waitForSelector('[x-data="bridgePage"]');

  await page.locator('#bridge-id').fill(ARXIV_IDENTIFIER);
  await page.locator('button:has-text("Look Up")').click();

  // Preview card appears once lookup+check resolve.
  await expect(page.getByRole('heading', { name: 'Preprint Found' })).toBeVisible();

  // Discipline is prefilled from subjects (cs.CL) — the register button enables.
  await page.locator('button:has-text("Register on PEvO")').click();
}

test('202 enqueue renders the queued state with position and ETA', async ({ page }) => {
  await seedAccreditedSession(page, { username: 'e2ebridgeuser', accreditation: null });
  await installLookupMocks(page);

  await page.route('**/api/bridge/register', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify(
        okEnvelope({
          entry: { id: 42, state: 'pending', identifier: ARXIV_IDENTIFIER, permlink: 'bridge-arxiv-2301-12345' },
          queue_position: 3,
          eta_seconds: 600, // ~10 min
          source: { type: 'arxiv', arxiv_id: ARXIV_IDENTIFIER },
        }),
      ),
    }),
  );

  const registerRequest = page.waitForRequest(
    (req) => req.url().includes('/api/bridge/register') && req.method() === 'POST',
  );
  await fillLookupAndRegister(page);
  await registerRequest;

  // Queued banner: title + position-and-ETA copy + My imports link.
  await expect(page.getByText('Queued for publishing')).toBeVisible();
  await expect(page.getByText(/Position 3 in queue/)).toBeVisible();
  await expect(page.getByText(/~10 min/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Track this and other pending imports/ })).toBeVisible();

  // It must NOT look like the prior synchronous success / redirect to a paper.
  await expect(page).toHaveURL(/\/bridge$/);
});

test('per-user cap 429 renders the cap remediation surface, not a transient error', async ({ page }) => {
  await seedAccreditedSession(page, { username: 'e2ebridgeuser', accreditation: null });
  await installLookupMocks(page);

  await page.route('**/api/bridge/register', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify(
        errorEnvelope('RATE_LIMITED', 'You already have 5 bridge imports in flight.', {
          retriable: true,
          inflight: 5,
          cap: 5,
        }),
      ),
    }),
  );

  await fillLookupAndRegister(page);

  // Cap-specific surface: title + the in-flight-count message.
  await expect(page.getByText('Too many pending imports')).toBeVisible();
  await expect(page.getByText(/You already have 5 bridge imports in flight/)).toBeVisible();

  // The generic "Try again" affordance from the transient-error path must NOT
  // be the surface shown for a cap rejection.
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('My imports lists entries across states; completed links to the paper, failed offers re-submit', async ({ page }) => {
  await seedAccreditedSession(page, { username: 'e2ebridgeuser', accreditation: null });

  const IMPORTS = {
    cap: 5,
    entries: [
      {
        id: 1,
        operation_kind: 'register',
        identifier: '2301.00001',
        permlink: 'bridge-arxiv-2301-00001',
        title: 'A Queued Preprint',
        discipline: 'Computer Science',
        keywords: [],
        language: 'en',
        state: 'pending',
        attempts: 0,
        scheduled_at: '2026-05-26T14:05:00.000Z',
        tx_id: null,
        error_code: null,
        error_message: null,
        existing_author: null,
        existing_permlink: null,
        created_at: '2026-05-26T14:00:00.000Z',
        completed_at: null,
      },
      {
        id: 2,
        operation_kind: 'register',
        identifier: '2301.00002',
        permlink: 'bridge-arxiv-2301-00002',
        title: 'A Completed Preprint',
        discipline: 'Physics',
        keywords: [],
        language: 'en',
        state: 'completed',
        attempts: 1,
        scheduled_at: '2026-05-26T13:05:00.000Z',
        tx_id: 'abc123',
        error_code: null,
        error_message: null,
        existing_author: 'pevo.bridge',
        existing_permlink: 'bridge-arxiv-2301-00002',
        created_at: '2026-05-26T13:00:00.000Z',
        completed_at: '2026-05-26T13:05:01.000Z',
      },
      {
        id: 3,
        operation_kind: 'register',
        identifier: '10.1234/notreal',
        permlink: 'bridge-doi-10-1234-notreal',
        title: null,
        discipline: 'Biology',
        keywords: ['x'],
        language: 'en',
        state: 'failed',
        attempts: 5,
        scheduled_at: '2026-05-26T12:05:00.000Z',
        tx_id: null,
        error_code: 'BAD_REQUEST',
        error_message: 'Source metadata could not be retrieved.',
        existing_author: null,
        existing_permlink: null,
        created_at: '2026-05-26T12:00:00.000Z',
        completed_at: '2026-05-26T12:01:00.000Z',
      },
    ],
  };

  await page.route('**/api/bridge/imports*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(okEnvelope(IMPORTS)) }),
  );

  await page.goto('/en/my-imports');
  await page.waitForSelector('[x-data="myImportsPage"]');

  // State badges for all three entries.
  await expect(page.getByText('Pending', { exact: true })).toBeVisible();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await expect(page.getByText('Failed', { exact: true })).toBeVisible();

  // Failed entry surfaces the reason.
  await expect(page.getByText(/Source metadata could not be retrieved/)).toBeVisible();

  // Completed entry links to the bridge paper (existing_author/permlink).
  const viewPaper = page.getByRole('link', { name: 'View paper' });
  await expect(viewPaper).toBeVisible();
  await expect(viewPaper).toHaveAttribute('href', '/en/paper/pevo.bridge/bridge-arxiv-2301-00002');

  // Failed entry offers a retry that re-POSTs /register.
  const retryButton = page.getByRole('button', { name: 'Retry' });
  await expect(retryButton).toBeVisible();

  const retryRequest = page.waitForRequest(
    (req) => req.url().includes('/api/bridge/register') && req.method() === 'POST',
  );
  // Make the re-POST resolve as a fresh 202 enqueue, and the reload return an
  // empty list so the assertion is deterministic.
  await page.route('**/api/bridge/register', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify(okEnvelope({ entry: { id: 9, state: 'pending' }, queue_position: 1, eta_seconds: 0 })),
    }),
  );
  await retryButton.click();
  const req = await retryRequest;

  // The retry payload re-submits the failed entry's identifier.
  const body = JSON.parse(req.postData() || '{}');
  expect(body.identifier).toBe('10.1234/notreal');
  expect(body.discipline).toBe('Biology');
});
