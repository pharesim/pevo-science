/**
 * E2E-WRITE-3 — Vote and threaded comment up to broadcast.
 *
 * Drives the paper-detail page as an accredited, self-custody researcher and
 * intercepts the Keychain calls the UI would make before they reach a Hive
 * node. Vote ops route through `requestVote` (captured as kind='vote');
 * comment ops route through `requestBroadcast` (captured as kind='broadcast').
 * See frontend/src/signer.js for the routing rule.
 *
 * Covers both parent-chain shapes the product surfaces:
 *   - Top-level discussion comment: parent is the paper itself.
 *   - Reply inside a review's thread: parent is the review comment.
 *
 * As with the other WRITE specs, the Keychain stub cannot produce a valid
 * Hive signature, so we bypass the signed-request path via a SESSION_SECRET
 * JWT (see fixtures/auth.js) and pick an already-accredited researcher from
 * the shared HAF node.
 */

import { test, expect } from './fixtures/keychain.js';
import { pickAccreditedResearcher, seedAccreditedSession } from './fixtures/auth.js';

const APP_TAG = 'pevotest';

async function fetchPapersList(request) {
  const resp = await request.get('/api/papers?limit=50');
  expect(resp.status()).toBe(200);
  return (await resp.json()).data || [];
}

async function fetchEnrichment(request, author, permlink) {
  const resp = await request.get(
    `/api/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/enrichment`,
  );
  expect(resp.status()).toBe(200);
  return (await resp.json()).data;
}

function isAuthorOrCoauthor(paper, username) {
  if (paper.author === username) return true;
  return (paper.authors || []).some((a) => a.hive === username);
}

test('upvote on a paper produces a valid Hive vote op', async ({ page, request }) => {
  const voter = await pickAccreditedResearcher(request);
  expect(voter, 'expected at least one accredited researcher in HAF').toBeTruthy();

  // Walk the list for a paper this user did not author and has not already
  // voted at the target weight on. The stub doesn't care about uniqueness,
  // but the Alpine handler short-circuits when `currentWeight === weight`.
  const papers = await fetchPapersList(request);
  let target = null;
  let voteWeight = 10000;
  for (const p of papers) {
    if (isAuthorOrCoauthor(p, voter.username)) continue;
    const enr = await fetchEnrichment(request, p.author, p.permlink);
    const existing = (enr.voters || []).find((v) => v.voter === voter.username);
    // `handleVote` short-circuits when the new weight equals the current
    // weight, so if the voter already sits at 10000 on this paper we pick
    // a different level. Anything other than 10000 leaves the default.
    voteWeight = existing?.weight === 10000 ? 6000 : 10000;
    target = p;
    break;
  }
  expect(
    target,
    `expected at least one pevotest paper ${voter.username} did not author`,
  ).toBeTruthy();

  await seedAccreditedSession(page, {
    username: voter.username,
    accreditation: voter.accreditation,
  });

  const enrichmentResponsePromise = page.waitForResponse((resp) =>
    resp.url().endsWith(`/${encodeURIComponent(target.permlink)}/enrichment`),
  );

  await page.goto(`/en/paper/${target.author}/${target.permlink}`);
  await page.waitForSelector('[x-data="paperDetailPage"]');
  await enrichmentResponsePromise;
  // The `voteButtons` block is gated on `enrichmentLoaded` — wait for it
  // before driving Alpine state, otherwise the component isn't mounted yet.
  await page.waitForSelector('[x-data*="voteButtons"]');

  // Drive handleVote directly on the paper's voteButtons scope. Clicking
  // through the selector dropdown would work too, but the Alpine call keeps
  // the assertion about the broadcast payload decoupled from icon/label copy.
  await page.evaluate((weight) => {
    const el = document.querySelector('[x-data*="voteButtons"]');
    window.Alpine.$data(el).handleVote(weight);
  }, voteWeight);

  await expect
    .poll(() => page.evaluate(() => window.__pevoBroadcastCalls?.length || 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  const call = await page.evaluate(() => window.__pevoBroadcastCalls[0]);
  expect(call.kind).toBe('vote');
  expect(call.voter).toBe(voter.username);
  expect(call.author).toBe(target.author);
  expect(call.permlink).toBe(target.permlink);
  expect(call.weight).toBe(voteWeight);
});

test('top-level comment and review reply assemble correct Hive comment ops', async ({
  page,
  request,
}) => {
  const commenter = await pickAccreditedResearcher(request);
  expect(commenter, 'expected at least one accredited researcher in HAF').toBeTruthy();

  // For the reply flow we need a paper with at least one review — the review
  // card is where the nested `commentComposer` mounts. Also make sure the
  // commenter did not author the paper (otherwise the page still renders but
  // the flow would conflate self-comments with review replies).
  const papers = await fetchPapersList(request);
  let target = null;
  let firstReview = null;
  for (const p of papers) {
    if (isAuthorOrCoauthor(p, commenter.username)) continue;
    if ((p.review_count ?? 0) === 0) continue;
    const enr = await fetchEnrichment(request, p.author, p.permlink);
    if (!enr.reviews?.length) continue;
    target = p;
    firstReview = enr.reviews[0];
    break;
  }
  expect(
    target,
    `expected a pevotest paper with reviews not authored by ${commenter.username}`,
  ).toBeTruthy();

  await seedAccreditedSession(page, {
    username: commenter.username,
    accreditation: commenter.accreditation,
  });

  // Register waitForResponse BEFORE page.goto — the enrichment request
  // fires early in page load and can beat the listener installation if
  // registered after. The upvote test above uses the same pre-register
  // pattern; this block was inadvertently inverted.
  const enrichmentResponsePromise = page.waitForResponse((resp) =>
    resp.url().endsWith(`/${encodeURIComponent(target.permlink)}/enrichment`),
  );

  await page.goto(`/en/paper/${target.author}/${target.permlink}`);
  await page.waitForSelector('[x-data="paperDetailPage"]');
  await enrichmentResponsePromise;

  // ─── Top-level discussion comment ─────────────────────────────
  // The top-level composer renders inside the Discussion section once the
  // user is authenticated. It's the only commentComposer on the page until
  // a review reply is toggled open.
  const topLevelBody = 'Automated E2E top-level discussion comment.';
  await page.waitForSelector('[x-data*="commentComposer"]');
  await page.evaluate((body) => {
    const el = document.querySelector('[x-data*="commentComposer"]');
    window.Alpine.$data(el).body = body;
  }, topLevelBody);

  await page.evaluate(() => {
    const el = document.querySelector('[x-data*="commentComposer"]');
    return window.Alpine.$data(el).handleSubmit();
  });

  await expect
    .poll(() => page.evaluate(() => window.__pevoBroadcastCalls?.length || 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  const topLevelCall = await page.evaluate(() => window.__pevoBroadcastCalls[0]);
  expect(topLevelCall.kind).toBe('broadcast');
  expect(topLevelCall.username).toBe(commenter.username);
  expect(topLevelCall.keyType).toBe('posting');

  const topCommentOp = topLevelCall.operations.find((op) => op[0] === 'comment');
  expect(topCommentOp, 'top-level broadcast should include a comment op').toBeTruthy();
  const [, topCommentBody] = topCommentOp;
  expect(topCommentBody.parent_author).toBe(target.author);
  expect(topCommentBody.parent_permlink).toBe(target.permlink);
  expect(topCommentBody.author).toBe(commenter.username);
  expect(typeof topCommentBody.permlink).toBe('string');
  expect(topCommentBody.permlink.startsWith('re-')).toBe(true);
  expect(topCommentBody.body).toBe(topLevelBody);

  const topMeta = JSON.parse(topCommentBody.json_metadata);
  expect(topMeta.app.startsWith(`${APP_TAG}/`)).toBe(true);
  expect(topMeta.tags).toContain(APP_TAG);
  expect(topMeta[APP_TAG]?.type).toBe('comment');

  const topOptionsOp = topLevelCall.operations.find((op) => op[0] === 'comment_options');
  expect(topOptionsOp, 'top-level broadcast should include comment_options').toBeTruthy();
  expect(topOptionsOp[1].author).toBe(commenter.username);
  expect(topOptionsOp[1].permlink).toBe(topCommentBody.permlink);

  // ─── Reply into a review's thread ─────────────────────────────
  // Each review card wraps its threadedComments block in an
  // `{ showComments: false }` toggle — flipping the first one mounts the
  // nested commentComposer for the first review.
  await page.evaluate(() => {
    const toggles = document.querySelectorAll('[x-data="{ showComments: false }"]');
    window.Alpine.$data(toggles[0]).showComments = true;
  });

  // After the toggle, a new threadedComments + commentComposer pair mounts
  // inside the review card. Rather than relying on DOM order (the review
  // section renders *before* the paper-level discussion section, so the
  // review reply composer is earlier in the NodeList than the top-level
  // one), scope the composer lookup to the review's parent permlink — the
  // value is bound into the Alpine scope at mount time.
  await page.waitForFunction(
    (targetPermlink) => {
      const composers = document.querySelectorAll('[x-data*="commentComposer"]');
      for (const el of composers) {
        if (window.Alpine.$data(el).parentPermlink === targetPermlink) return true;
      }
      return false;
    },
    firstReview.permlink,
  );

  const replyBody = 'Automated E2E reply to review.';
  await page.evaluate(
    ({ targetPermlink, body }) => {
      const composers = document.querySelectorAll('[x-data*="commentComposer"]');
      for (const el of composers) {
        const data = window.Alpine.$data(el);
        if (data.parentPermlink === targetPermlink) {
          data.body = body;
          return;
        }
      }
    },
    { targetPermlink: firstReview.permlink, body: replyBody },
  );

  await page.evaluate((targetPermlink) => {
    const composers = document.querySelectorAll('[x-data*="commentComposer"]');
    for (const el of composers) {
      const data = window.Alpine.$data(el);
      if (data.parentPermlink === targetPermlink) return data.handleSubmit();
    }
  }, firstReview.permlink);

  await expect
    .poll(() => page.evaluate(() => window.__pevoBroadcastCalls?.length || 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(1);

  const replyCall = await page.evaluate(() => window.__pevoBroadcastCalls[1]);
  expect(replyCall.kind).toBe('broadcast');
  expect(replyCall.username).toBe(commenter.username);

  const replyCommentOp = replyCall.operations.find((op) => op[0] === 'comment');
  expect(replyCommentOp, 'reply broadcast should include a comment op').toBeTruthy();
  const [, replyCommentBody] = replyCommentOp;
  // Parent chain points at the review, not the paper — that's what makes
  // this a threaded reply rather than a second top-level comment.
  expect(replyCommentBody.parent_author).toBe(firstReview.author);
  expect(replyCommentBody.parent_permlink).toBe(firstReview.permlink);
  expect(replyCommentBody.author).toBe(commenter.username);
  expect(replyCommentBody.body).toBe(replyBody);
});
