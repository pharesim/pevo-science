/**
 * E2E-READ-3 — Researchers directory + individual profile rendering.
 *
 * Data source: accredited researchers come from `custom_json` operations
 * broadcast by the configured accreditation authorities. HAF is shared
 * read-only with dev, so the spec picks whichever accredited researcher
 * HAF currently indexes and then asserts that the directory lists them
 * and that their profile page renders name, institution, field, and the
 * reputation score.
 *
 * We pick a researcher who also has at least one published paper (via
 * `/api/profile/:username/papers`) so the publications tab assertion
 * stays meaningful. That coverage is what the task calls out — accredited
 * researcher + published paper + profile fields + reputation — without
 * hard-coding a specific username that could later be revoked.
 */

import { test, expect } from './fixtures/keychain.js';

async function fetchAccreditations(request) {
  const resp = await request.get('/api/accreditations?limit=50');
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body.status).toBe('ok');
  expect(Array.isArray(body.data)).toBe(true);
  return body.data;
}

async function fetchProfilePapers(request, username) {
  const resp = await request.get(`/api/profile/${encodeURIComponent(username)}/papers`);
  expect(resp.status()).toBe(200);
  return (await resp.json()).data || [];
}

test('researcher directory lists accredited users and links to profile with papers', async ({ page, request }) => {
  const researchers = await fetchAccreditations(request);
  expect(researchers.length).toBeGreaterThan(0);

  // Pick a researcher with at least one paper so the profile publications
  // tab assertion has something to check.
  let target = null;
  let targetPapers = null;
  for (const r of researchers) {
    const papers = await fetchProfilePapers(request, r.username);
    if (papers.length > 0) {
      target = r;
      targetPapers = papers;
      break;
    }
  }
  expect(target, 'expected at least one accredited researcher with a published paper').toBeTruthy();

  // ─── Directory page ──────────────────────────────────────────
  const listResponsePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/accreditations') && resp.request().method() === 'GET',
  );
  await page.goto('/en/researchers');
  const listResp = await listResponsePromise;
  expect(listResp.status()).toBe(200);

  // Researcher cards render; our target appears in the grid by name +
  // profile link. The Alpine grid renders one card per researcher.
  const targetLink = page.locator(`a[href*="/profile/${target.username}"]`).first();
  await expect(targetLink).toBeVisible();
  await expect(targetLink).toHaveText(new RegExp(`@${target.username}`));

  // The card above the link contains the researcher's display name.
  const card = page.locator('.card', { has: targetLink });
  await expect(card).toContainText(target.name);
  if (target.institution) await expect(card).toContainText(target.institution);
  if (target.field) await expect(card).toContainText(target.field, { ignoreCase: true });

  // ─── Click through to profile ────────────────────────────────
  const profileResponsePromise = page.waitForResponse(
    (resp) => resp.url().endsWith(`/api/profile/${encodeURIComponent(target.username)}`),
  );
  await targetLink.click();
  const profileResp = await profileResponsePromise;
  expect(profileResp.status()).toBe(200);
  const profile = (await profileResp.json()).data;

  await expect(page).toHaveURL(new RegExp(`/profile/${target.username}`));

  // Profile header: display name (from accreditation) + @handle.
  await expect(page.getByRole('heading', { name: profile.accreditation.name }).first()).toBeVisible();
  await expect(page.getByText(`@${target.username}`).first()).toBeVisible();

  // Institution + field render in the profile card.
  if (profile.accreditation.institution) {
    await expect(page.getByText(profile.accreditation.institution).first()).toBeVisible();
  }
  if (profile.accreditation.field) {
    await expect(page.getByText(new RegExp(profile.accreditation.field, 'i')).first()).toBeVisible();
  }

  // Reputation score renders. The score is rendered as a 4xl number
  // in the top-right of the profile header card.
  const scoreLocator = page.locator('div.text-4xl.font-bold', { hasText: String(profile.reputation.score) }).first();
  await expect(scoreLocator).toBeVisible();

  // Publications tab (default active). The first paper's title must render.
  const firstPaperTitle = targetPapers[0].title;
  await expect(page.getByRole('link', { name: firstPaperTitle }).first()).toBeVisible();
});
