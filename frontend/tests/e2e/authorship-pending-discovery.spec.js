/**
 * E2E for the pending-authorships discovery surface. The header user-menu
 * dropdown surfaces the signed-in user's outstanding authorship actions from GET
 * /api/me/authorships/pending, and the endpoint is FAIL-CLOSED: a 503 must show a
 * retry affordance, never a silent empty list.
 *
 * Mocking justification (project-CLAUDE.md "Carve-out for deterministic edge-case
 * coverage"): the discovery surface's content is the pending endpoint's response,
 * and the 503 fail-closed branch cannot be induced on demand against real HAF.
 * We route-mock GET /api/me/authorships/pending (and the other boot-time authed
 * GETs the global header fires) to assert the dropdown's success render, count
 * badge, and the 503 retry affordance. No auth middleware is bypassed — the
 * session JWT is a real backend-valid token from mintSessionJwt, and the store's
 * load path / Alpine wiring run for real. The real authed GET path is exercised
 * by the broader login specs against the live backend.
 */
import { test, expect } from '@playwright/test';
import { seedAccreditedSession } from './fixtures/auth.js';

const USERNAME = 'e2econsentuser';

// Mock the boot-time authed GETs the global header depends on so the dropdown
// renders deterministically regardless of backend state.
async function mockBootEndpoints(page, { pending }) {
  await page.route('**/api/me/authorships/pending', async (route) => {
    if (pending.status === 503) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'error',
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Pending authorships temporarily unavailable. Please retry shortly.', details: { retriable: true } },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', data: pending.data }),
    });
  });
  // Keep notifications + accreditation polling quiet so the dropdown is clean.
  await page.route('**/api/notifications**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', data: { events: [], latest_block: 0, has_more: false } }) }),
  );
  await page.route('**/api/accreditations/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', data: { is_accredited: true, accreditation: { name: 'Consent Tester' } } }) }),
  );
}

test('renders pending consent + claim items with a count badge', async ({ page }) => {
  await mockBootEndpoints(page, {
    pending: {
      status: 200,
      data: {
        pending_consents: [{ paper_author: 'alice', paper_permlink: 'quantum-ecc' }],
        pending_claims: [{ paper_author: 'bob', paper_permlink: 'crispr-survey', author_index: 2, claimed_at: '2026-06-10T00:00:00Z' }],
      },
    },
  });
  await seedAccreditedSession(page, { username: USERNAME, accreditation: { name: 'Consent Tester' }, custody: 'light' });
  await page.goto('/en/about');

  // Open the user menu (the bell trigger).
  await page.getByRole('button', { name: /notifications/i }).first().click();

  const section = page.locator('[data-testid="pending-authorships"]');
  await expect(section).toBeVisible();
  await expect(section).toContainText('alice');   // accept item (pending_consent)
  await expect(section).toContainText('bob');     // claim item (pending_claim)

  // The bell count badge folds in the pending count (2 actions here).
  await expect(page.locator('span[aria-live="polite"]').first()).toContainText('2');
});

test('503 from the pending endpoint shows a retry affordance, not a silent empty', async ({ page }) => {
  await mockBootEndpoints(page, { pending: { status: 503 } });
  await seedAccreditedSession(page, { username: USERNAME, accreditation: { name: 'Consent Tester' }, custody: 'light' });
  await page.goto('/en/about');

  await page.getByRole('button', { name: /notifications/i }).first().click();

  const retry = page.locator('[data-testid="pending-authorships-retry"]');
  await expect(retry).toBeVisible();

  // Clicking retry re-fetches; swap the mock to a success response first.
  await page.route('**/api/me/authorships/pending', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', data: { pending_consents: [{ paper_author: 'alice', paper_permlink: 'quantum-ecc' }], pending_claims: [] } }) }),
  );
  await retry.click();
  await expect(page.locator('[data-testid="pending-authorships"]')).toContainText('alice');
});
