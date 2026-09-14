/**
 * E2E for the authorship consent/credit affordances on paper-detail — the
 * Keychain (self-custody) signing path. Covers Route-2 accept + resign and
 * Route-3 claim + approve: each affordance must build the correct op and hand it
 * to Keychain.
 *
 * Mocking justification (project-CLAUDE.md "Carve-out for deterministic edge-case
 * coverage"):
 *   - (a) impractical real path: reproducing the precise chain state each
 *         affordance gates on (an unaccepted anchored slot for the signer; a
 *         name-only slot matching the signer; a pending claim against the post
 *         author) on real HAF per-case is infeasible. The paper-detail / pending
 *         response shapes are the consumer contract; route-mocking lets each case
 *         render deterministically.
 *   - (b) auth bypass: NONE. The Keychain stub produces an unverifiable
 *         STUB_SIG_ signature, so these specs stop at "the UI built the op and
 *         called Keychain" — they never assert a 2xx from a verifyHiveSignature-
 *         guarded endpoint. The op SHAPE (action, target fields) is the assertion.
 *   - (c) real-path companion: the broadcast-attach + fresh-auth orchestration is
 *         unit-tested (lib-authorship-consent / lib-fresh-auth-consent-op-cache),
 *         and consent-op-fresh-auth.spec.js drives the light-account custody
 *         path for real: an author_accept whose target-bound proof is minted at
 *         the real POST /custody/fresh-auth and consumed at the real
 *         POST /custody/broadcast, with the spent-proof replay and the
 *         session-kind kind_mismatch refusal as controls.
 */
import { test, expect } from './fixtures/keychain.js';
import { installPaperMocks, installAuthedBootMocks, buildPaper } from './fixtures/paper-mocks.js';
import { seedAccreditedSession } from './fixtures/auth.js';

const APP_TAG = 'pevotest';

// Keep the boot-time authed GETs quiet, and seed the pending-authorships store.
function mockBoot(page, opts = {}) {
  return installAuthedBootMocks(page, { ...opts, accreditationName: 'Alice Researcher' });
}

async function lastBroadcastPayload(page) {
  const calls = await page.evaluate(() => window.__pevoBroadcastCalls || []);
  const broadcast = calls.find((c) => c.kind === 'broadcast');
  expect(broadcast, 'a Keychain requestBroadcast was captured').toBeTruthy();
  const op = broadcast.operations[0];
  expect(op[0]).toBe('custom_json');
  return JSON.parse(op[1].json);
}

test('Route-2 accept: the accept affordance broadcasts author_accept bound to the paper', async ({ page }) => {
  const permlink = `e2e-accept-${Date.now().toString(36)}`;
  const paper = buildPaper({
    author: 'rootauthor',
    permlink,
    authors: [
      { name: 'Root Author', hive: 'rootauthor', consented: true },
      { name: 'Alice Researcher', hive: 'alice', consented: false },
    ],
  });
  await mockBoot(page, { pendingConsents: [{ paper_author: 'rootauthor', paper_permlink: permlink }] });
  await installPaperMocks(page, { paper });
  await seedAccreditedSession(page, { username: 'alice', accreditation: { name: 'Alice Researcher' }, custody: 'self' });
  await page.goto(`/en/paper/rootauthor/${permlink}`);

  await page.locator('[data-testid="accept-authorship"]').click();
  const payload = await lastBroadcastPayload(page);
  expect(payload.action).toBe('author_accept');
  expect(payload.root_author).toBe('rootauthor');
  expect(payload.root_permlink).toBe(permlink);
});

test('Route-2 resign: the "..." menu + confirm broadcasts author_resign', async ({ page }) => {
  const permlink = `e2e-resign-${Date.now().toString(36)}`;
  const paper = buildPaper({
    author: 'rootauthor',
    permlink,
    authors: [
      { name: 'Root Author', hive: 'rootauthor', consented: true },
      { name: 'Alice Researcher', hive: 'alice', consented: true },
    ],
  });
  await mockBoot(page);
  await installPaperMocks(page, { paper });
  await seedAccreditedSession(page, { username: 'alice', accreditation: { name: 'Alice Researcher' }, custody: 'self' });
  await page.goto(`/en/paper/rootauthor/${permlink}`);

  await page.getByLabel('More actions').click();
  await page.locator('[data-testid="resign-authorship"]').click();
  await page.locator('[data-testid="confirm-resign"]').click();

  const payload = await lastBroadcastPayload(page);
  expect(payload.action).toBe('author_resign');
  expect(payload.root_author).toBe('rootauthor');
  expect(payload.root_permlink).toBe(permlink);
});

test('Route-3 claim: claiming a name-only slot broadcasts claim_authorship', async ({ page }) => {
  const permlink = `e2e-claim-${Date.now().toString(36)}`;
  const paper = buildPaper({
    author: 'rootauthor',
    permlink,
    authors: [
      { name: 'Root Author', hive: 'rootauthor', consented: true },
      { name: 'Alice Researcher' }, // name-only slot (no hive/orcid), index 1
    ],
  });
  await mockBoot(page);
  await installPaperMocks(page, { paper });
  // Claim preflight returns the unsigned op for the SPA to broadcast.
  await page.route(`**/api/papers/rootauthor/${permlink}/claims`, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const payload = { action: 'claim_authorship', paper_author: 'rootauthor', paper_permlink: permlink, author_index: 1, timestamp: '2026-06-14T00:00:00Z' };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', data: { operation: ['custom_json', { id: APP_TAG, json: JSON.stringify(payload), required_auths: [], required_posting_auths: ['alice'] }] } }) });
  });
  await seedAccreditedSession(page, { username: 'alice', accreditation: { name: 'Alice Researcher' }, custody: 'self' });
  await page.goto(`/en/paper/rootauthor/${permlink}`);

  await page.getByRole('button', { name: 'Claim', exact: true }).first().click();
  const payload = await lastBroadcastPayload(page);
  expect(payload.action).toBe('claim_authorship');
  expect(payload.author_index).toBe(1);
});

test('Route-3 approve: the post author approving a pending claim broadcasts approve_authorship', async ({ page }) => {
  const permlink = `e2e-approve-${Date.now().toString(36)}`;
  const paper = buildPaper({
    author: 'rootauthor',
    permlink,
    authors: [
      { name: 'Root Author', hive: 'rootauthor', consented: true },
      { name: 'Claimed Name' }, // name-only slot index 1
    ],
    claims: [{ author_index: 1, claimer: 'claimant', status: 'pending' }],
  });
  await mockBoot(page);
  await installPaperMocks(page, { paper, claims: [{ author_index: 1, claimer: 'claimant', status: 'pending' }] });
  await page.route(`**/api/papers/rootauthor/${permlink}/claims/claimant/approve`, (route) => {
    const payload = { action: 'approve_authorship', claimer: 'claimant', paper_author: 'rootauthor', paper_permlink: permlink, author_index: 1, timestamp: '2026-06-14T00:00:00Z' };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', data: { operation: ['custom_json', { id: APP_TAG, json: JSON.stringify(payload), required_auths: [], required_posting_auths: ['rootauthor'] }] } }) });
  });
  // Post author signs in as the root author.
  await seedAccreditedSession(page, { username: 'rootauthor', accreditation: { name: 'Root Author' }, custody: 'self' });
  await page.goto(`/en/paper/rootauthor/${permlink}`);

  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  const payload = await lastBroadcastPayload(page);
  expect(payload.action).toBe('approve_authorship');
  expect(payload.claimer).toBe('claimant');
  expect(payload.author_index).toBe(1);
});
