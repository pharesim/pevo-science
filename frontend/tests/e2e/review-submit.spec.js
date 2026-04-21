/**
 * E2E-WRITE-2 — Review submission up to broadcast.
 *
 * Drives /review/:author/:permlink for a real HAF-indexed paper authored by
 * someone other than the seeded reviewer, then intercepts the Keychain
 * requestBroadcast call before the review comment would reach a Hive node.
 *
 * The Keychain broadcast stub (see fixtures/keychain.js) captures every call
 * into `window.__pevoBroadcastCalls` so we assert on the op shape (comment +
 * comment_options, correct parent author/permlink chain, structured rating
 * in json_metadata) without the tx ever leaving the browser.
 */

import { test, expect } from './fixtures/keychain.js';
import { pickAccreditedResearcher, seedAccreditedSession } from './fixtures/auth.js';

// This spec mints a live backend-valid bearer JWT via seedAccreditedSession.
// Disable trace/video/screenshot to keep that token out of trace.zip artifacts
// (the global default `trace: 'retain-on-failure'` would otherwise persist it).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const APP_TAG = 'pevotest';

test('review submission assembles a valid Hive comment broadcast with rating metadata', async ({
  page,
  request,
}) => {
  const reviewer = await pickAccreditedResearcher(request);
  if (!reviewer) throw new Error('expected at least one accredited researcher in HAF');

  // Find a PEvO paper the reviewer is not an author/co-author of. Walking
  // the list keeps the spec green as HAF content evolves; the page's
  // isOwnPaper check (author === username OR authors[].hive === username)
  // would otherwise hide the review form.
  const papersResp = await request.get('/api/papers?limit=50');
  expect(papersResp.status()).toBe(200);
  const papers = (await papersResp.json()).data || [];
  const target = papers.find((p) => {
    if (p.author === reviewer.username) return false;
    const coauthors = p.authors || [];
    return !coauthors.some((a) => a.hive === reviewer.username);
  });
  if (!target) {
    throw new Error(
      `expected at least one pevotest paper not authored by ${reviewer.username}`,
    );
  }

  await seedAccreditedSession(page, {
    username: reviewer.username,
    accreditation: reviewer.accreditation,
  });

  const paperResponsePromise = page.waitForResponse(
    (resp) =>
      resp.url().includes(
        `/api/papers/${encodeURIComponent(target.author)}/${encodeURIComponent(target.permlink)}`,
      ) &&
      !resp.url().endsWith('/enrichment') &&
      !resp.url().endsWith('/comments'),
  );

  await page.goto(`/en/review/${target.author}/${target.permlink}`);

  await page.waitForSelector('[x-data="reviewPage"]');
  await paperResponsePromise;

  // ─── Ratings + body via Alpine data ──────────────────────────
  // Star buttons are fine to click individually; driving Alpine state keeps
  // the spec insulated from icon/aria changes and is what matters for the
  // broadcast payload assertions below.
  const REVIEW_BODY = 'Automated E2E review body covering the submission flow.';
  const RATINGS = { methodology: 4, novelty: 5, clarity: 3, significance: 4 };

  await page.evaluate(
    ({ ratings, body }) => {
      const el = document.querySelector('[x-data="reviewPage"]');
      const data = window.Alpine.$data(el);
      data.ratings = ratings;
      data.reviewBody = body;
    },
    { ratings: RATINGS, body: REVIEW_BODY },
  );

  await expect(page.locator('form button[type="submit"]')).toBeEnabled();

  await page.locator('form button[type="submit"]').click();

  // ─── Assert the intercepted broadcast ────────────────────────
  await expect
    .poll(() => page.evaluate(() => window.__pevoBroadcastCalls?.length || 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  const broadcast = await page.evaluate(() => window.__pevoBroadcastCalls[0]);

  expect(broadcast.kind).toBe('broadcast');
  expect(broadcast.username).toBe(reviewer.username);
  expect(broadcast.keyType).toBe('posting');
  expect(Array.isArray(broadcast.operations)).toBe(true);

  const commentOp = broadcast.operations.find((op) => op[0] === 'comment');
  expect(commentOp, 'operations should include a comment op').toBeTruthy();
  const [, commentBody] = commentOp;

  // Parent chain points at the paper being reviewed — that's what makes the
  // Hive comment a reply to it.
  expect(commentBody.parent_author).toBe(target.author);
  expect(commentBody.parent_permlink).toBe(target.permlink);
  expect(commentBody.author).toBe(reviewer.username);
  expect(typeof commentBody.permlink).toBe('string');
  expect(commentBody.permlink.startsWith('re-')).toBe(true);
  expect(commentBody.body).toBe(REVIEW_BODY);

  const meta = JSON.parse(commentBody.json_metadata);
  expect(meta.app.startsWith(`${APP_TAG}/`)).toBe(true);
  expect(Array.isArray(meta.tags)).toBe(true);
  expect(meta.tags).toContain(APP_TAG);
  expect(meta.tags).toContain('review');
  expect(meta[APP_TAG]).toBeTruthy();
  expect(meta[APP_TAG].type).toBe('review');
  expect(meta[APP_TAG].rating).toEqual(RATINGS);
  expect(meta[APP_TAG].is_anonymous).toBe(false);

  const optionsOp = broadcast.operations.find((op) => op[0] === 'comment_options');
  expect(optionsOp, 'operations should include a comment_options op').toBeTruthy();
  const [, optionsBody] = optionsOp;
  expect(optionsBody.author).toBe(reviewer.username);
  expect(optionsBody.permlink).toBe(commentBody.permlink);
});
