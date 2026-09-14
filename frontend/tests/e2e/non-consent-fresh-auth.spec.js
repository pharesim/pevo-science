/**
 * Light-account fresh-auth on the NON-CONSENT surface, driven against the
 * real backend. The session-kind window is minted at the real
 * `POST /api/custody/session-auth` (password factor), cached by the SPA, and
 * carried as `fresh_auth_proof` on the real `POST /api/custody/broadcast`
 * (a vote, and a comment, from the paper-detail page) and on the real
 * `POST /api/ipfs/upload-token` pre-flight (a publish with a PDF, which then
 * completes the real `POST /api/ipfs/upload` transfer and carries the same
 * window on its broadcast). The ORCID factor's return leg is covered too:
 * the `/orcid/callback` page handling `session_auth` mode by caching the
 * issued window and bouncing back to the page that started the broadcast.
 *
 * Where the real-backend broadcast legs stop, and why that is the assertion:
 * the seeded light accounts carry no encrypted posting key, so
 * `/api/custody/broadcast` consumes the proof and then refuses at its first
 * post-gate step, the posting-key decrypt (`expectPostGateStop`,
 * fixtures/light-account.js). Nothing is signed and nothing reaches a Hive
 * node, the same line every other write spec holds. A control request
 * through the same route with a tampered proof is refused AT the gate with
 * FRESH_AUTH_REQUIRED, which is what separates "passed the gate" from
 * "refused before it". The upload leg has no such stop: the pre-flight
 * consumes the window and mints an upload token, and the transfer pins the
 * bytes for real.
 *
 * One defect this coverage surfaced, pinned here as a Playwright expected
 * failure so the suite flips the day it is fixed: the custody broadcast
 * allowlist admits `comment`, `vote`, and `custom_json`, while every post
 * the SPA builds (the comment composer, the publish page, the review page)
 * bundles a `comment_options` op alongside the `comment` for the rewards
 * policy. The handler refuses that bundle BEFORE the fresh-auth gate with a
 * 403 FORBIDDEN naming the op, so a light account's comment, review, or
 * publish never reaches the gate today. The vote is a single allowed op and
 * is what carries the session window through the gate; the comment test
 * asserts the correct post-gate stop under `test.fail`, and the publish test
 * asserts the broadcast REQUEST it builds (proof and CID) without pinning
 * the refused response.
 *
 * Carve-out clause (a): the ORCID test stubs `/api/orcid/callback` (no real
 * ORCID OAuth handshake is possible in Playwright). The vote and comment
 * tests stub the paper-detail READ routes they mount against and the
 * boot-time authed GETs (fixtures/paper-mocks.js) so HAF stays out of the
 * page load; the publish test stubs nothing. Every test seeds the JWT via
 * `mintSessionJwt`, and every fresh-auth mint and consume runs real.
 * Clause (b): no auth middleware is mocked and no cryptographic verification
 * is bypassed. `verifyHiveSignature` runs real on the Bearer path, the
 * password is argon2-verified server-side, and every proof is backend-issued.
 * Clause (c): this spec is the real-path companion the mocked fresh-auth
 * unit suites cite (`fresh-auth-401-retry.test.js`,
 * `lib-fresh-auth-session-window.test.js`, `lib-ipfs-upload.test.js`,
 * `lib-fresh-auth-outcome-dispatch.test.js`). The orcid-link and
 * orcid-no-password specs cover the `/api/orcid/start` and
 * `/api/orcid/callback` real-path edges for the sibling modes
 * (signup/login/link); the ORCID test here layers the session_auth mode
 * atop that same proven plumbing.
 */

import { test, expect } from './fixtures/keychain.js';
import {
  mintSessionJwt,
  seedAccreditedSession,
  pickAccreditedResearcher,
  minimalPdfBuffer,
} from './fixtures/auth.js';
import { openAppPool } from './fixtures/db.js';
import { installPaperMocks, installAuthedBootMocks, buildPaper } from './fixtures/paper-mocks.js';
import {
  bearer,
  seedLightAccount,
  deleteLightAccount,
  answerReauthPrompt,
  confirmBroadcastDialog,
  expectPostGateStop,
  expectGateRefusal,
} from './fixtures/light-account.js';

// Specs in this file mint live backend-valid bearer JWTs and type the seeded
// account password into the reauth modal. Traces would persist both.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const APP_TAG = 'pevotest';
const LIGHT_USERNAME = 'e2e-fresh-auth-user';
const PROOF_KEY = 'pevo_fresh_auth_session_proof';
const RETURN_PATH_KEY = 'pevo_fresh_auth_return_to';

function seedLightSession(page) {
  const { token, expiresAt } = mintSessionJwt(LIGHT_USERNAME, { custody: 'light' });
  return page.addInitScript(
    ({ session }) => {
      window.localStorage.setItem('pevo_session', JSON.stringify(session));
    },
    {
      session: {
        token,
        username: LIGHT_USERNAME,
        expiresAt,
        isAccredited: false,
        accreditation: null,
        custody: 'light',
      },
    },
  );
}

test('orcid-callback session_auth caches the issued proof in sessionStorage', async ({ page }) => {
  await seedLightSession(page);

  const issuedProof = 'stub-issued-proof-XYZ999';
  // Both window deadlines: the sliding idle deadline and the absolute cap.
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const absoluteExpiresAt = new Date(Date.now() + 120 * 60_000).toISOString();

  await page.route('**/api/orcid/callback', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: {
          mode: 'session_auth',
          fresh_auth_proof: issuedProof,
          expires_at: expiresAt,
          absolute_expires_at: absoluteExpiresAt,
          mechanism: 'orcid',
        },
      }),
    });
  });

  // Pre-seed the in-flight context the way `beginSessionAuthOrcidRedirect` would:
  // sessionStorage holds both the orcid_mode (migrated from localStorage
  // 2026-05-17 to avoid cross-tab interference) and the return path the
  // handler should bounce the user back to after success.
  await page.addInitScript(
    ({ modeKey, returnKey, returnPath }) => {
      window.sessionStorage.setItem(modeKey, 'session_auth');
      window.sessionStorage.setItem(returnKey, returnPath);
    },
    {
      modeKey: 'pevo_orcid_mode',
      returnKey: RETURN_PATH_KEY,
      returnPath: '/papers',
    },
  );

  await page.goto('/en/orcid/callback?code=stubcode&state=stubstate');

  // Handler navigates to the return path on success — wait for URL change
  // rather than DOM state, since the success branch unmounts the callback
  // page entirely.
  await expect.poll(async () => page.url(), { timeout: 5000 }).toContain('/papers');

  const cached = await page.evaluate((key) => window.sessionStorage.getItem(key), PROOF_KEY);
  expect(cached, 'session-kind proof should be cached after session_auth callback').not.toBeNull();
  const parsed = JSON.parse(cached);
  expect(parsed.token).toBe(issuedProof);
  // The whole window is cached, not just a token: dropping the absolute cap
  // would leave the client honouring a proof past the deadline no activity
  // extends, and dropping the learned idle period would break the slide.
  //
  // Both deadlines are re-anchored to the CLIENT clock at issuance, so they
  // land near the server's values rather than on them: the server's timestamps
  // are in the server's clock, and comparing those to `Date.now()` would fold
  // any offset between the two straight into the window's length. A minute of
  // tolerance covers the round-trip without admitting a skew-sized error.
  const TOLERANCE_MS = 60_000;
  const nearly = (actual, expected) =>
    Math.abs(new Date(actual).getTime() - new Date(expected).getTime()) < TOLERANCE_MS;
  expect(nearly(parsed.expiresAt, expiresAt), 'idle deadline is client-anchored near the issued one').toBe(true);
  expect(nearly(parsed.absoluteExpiresAt, absoluteExpiresAt), 'absolute cap is client-anchored near the issued one').toBe(true);
  expect(Number.isFinite(parsed.idlePeriodMs)).toBe(true);

  // Mode + return path are cleared after the handler runs (both now in
  // sessionStorage after the 2026-05-17 cross-tab-interference migration).
  const cleared = await page.evaluate(
    ({ modeKey, returnKey }) => ({
      mode: window.sessionStorage.getItem(modeKey),
      returnPath: window.sessionStorage.getItem(returnKey),
    }),
    { modeKey: 'pevo_orcid_mode', returnKey: RETURN_PATH_KEY },
  );
  expect(cleared.mode).toBeNull();
  expect(cleared.returnPath).toBeNull();
});

// A POST to `path` matcher pair for waitForRequest / waitForResponse.
const postTo = (path) => ({
  request: (req) => req.url().endsWith(path) && req.method() === 'POST',
  response: (resp) => resp.url().endsWith(path) && resp.request().method() === 'POST',
});

test.describe('light account against the real backend', () => {
  let pool;
  // Recomputed per beforeAll so a Playwright retry (which re-runs beforeAll
  // but not module scope) seeds distinct rows.
  let RUN_SUFFIX;
  // One seeded light account serves the vote and comment tests.
  let SEEDED_USERNAME;
  const SEEDED_NAME = 'E2E Fresh Auth Voter';
  // The publish test borrows a HAF-accredited username (see the test); its
  // row is removed again in afterAll so no other spec meets a light-custody
  // row for a self-custody researcher.
  let publishUsername = null;

  test.beforeAll(async ({}, testInfo) => {
    RUN_SUFFIX = `${Date.now().toString(36).slice(-6)}r${testInfo.retry}`;
    SEEDED_USERNAME = `e2e-fa-light-${RUN_SUFFIX}`;
    pool = openAppPool();
    await seedLightAccount(pool, {
      username: SEEDED_USERNAME,
      email: `e2e+fa-light-${RUN_SUFFIX}@pevo.test`,
      fullName: SEEDED_NAME,
    });
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      if (publishUsername) await deleteLightAccount(pool, publishUsername);
    } finally {
      await pool.end();
    }
  });

  // Mount paper-detail for the seeded light account against a deterministic
  // paper by someone else, with the boot-time GETs and the discussion read
  // stubbed. Returns the paper and the session token.
  async function mountPaperDetail(page, { permlink, title }) {
    const { token } = await seedAccreditedSession(page, {
      username: SEEDED_USERNAME,
      accreditation: { name: SEEDED_NAME },
      custody: 'light',
    });
    await installAuthedBootMocks(page, { accreditationName: SEEDED_NAME });
    const paper = buildPaper({
      author: 'rootauthor',
      permlink,
      authors: [{ name: 'Root Author', hive: 'rootauthor', consented: true }],
      title,
    });
    await installPaperMocks(page, { paper, comments: [] });
    await page.goto(`/en/paper/${paper.author}/${paper.permlink}`);
    return { paper, token };
  }

  // Assert a real session-auth mint response and return its issuance.
  async function issuedWindow(mintResponsePromise) {
    const mintResp = await mintResponsePromise;
    expect(mintResp.status()).toBe(200);
    const issued = (await mintResp.json()).data;
    expect(typeof issued.fresh_auth_proof).toBe('string');
    expect(issued.fresh_auth_proof.length).toBeGreaterThan(0);
    expect(issued.mechanism).toBe('password');
    expect(typeof issued.expires_at).toBe('string');
    expect(typeof issued.absolute_expires_at).toBe('string');
    return issued;
  }

  test('a vote broadcast carries the session window minted at the real session-auth route', async ({ page, request }) => {
    const { paper, token } = await mountPaperDetail(page, {
      permlink: `e2e-fa-vote-${RUN_SUFFIX}`,
      title: 'Light Account Vote Test',
    });
    // The vote block is gated on the enrichment read.
    await page.waitForSelector('[x-data*="voteButtons"]');

    const mintResponsePromise = page.waitForResponse(postTo('/api/custody/session-auth').response);
    const broadcastRequestPromise = page.waitForRequest(postTo('/api/custody/broadcast').request);
    const broadcastResponsePromise = page.waitForResponse(postTo('/api/custody/broadcast').response);

    // Drive the paper's own voteButtons scope (the review cards mount their
    // own). The handler is not awaited: for a light account it parks on the
    // confirmation dialog and then on the password prompt, both answered
    // below.
    const VOTE_WEIGHT = 10000;
    await page.evaluate((weight) => {
      window.Alpine.$data(document.querySelector('[x-data*="voteButtons"]')).handleVote(weight);
    }, VOTE_WEIGHT);
    await confirmBroadcastDialog(page);
    // The acquisition runs: the password factor (the seeded row has a
    // password, which the real GET /settings/email reports) opens the
    // reauth modal, and the entered password mints at the real route.
    await answerReauthPrompt(page);
    const issued = await issuedWindow(mintResponsePromise);

    // The broadcast carried the window the mint issued, on the vote the
    // component built.
    const broadcastReq = await broadcastRequestPromise;
    const body = broadcastReq.postDataJSON();
    expect(body.fresh_auth_proof).toBe(issued.fresh_auth_proof);
    expect(body.operations).toEqual([
      ['vote', { voter: SEEDED_USERNAME, author: paper.author, permlink: paper.permlink, weight: VOTE_WEIGHT }],
    ]);

    // ...and the backend accepted it: the request passed the fresh-auth gate
    // and stopped at the seeded account's posting-key decrypt.
    await expectPostGateStop(await broadcastResponsePromise);

    // The window the SPA cached is the one it carried.
    const cached = JSON.parse(await page.evaluate((key) => window.sessionStorage.getItem(key), PROOF_KEY));
    expect(cached.token).toBe(issued.fresh_auth_proof);

    // Controls through the same route from outside the page. A tampered
    // proof is refused AT the gate, which is what makes the post-gate stop
    // above evidence of a pass rather than of a route that never checks. And
    // the same window is accepted again: the session kind is multi-use inside
    // its deadlines, unlike the consent-op kind `consent-op-fresh-auth.spec.js`
    // spends.
    const tampered = await request.post('/api/custody/broadcast', {
      headers: bearer(token),
      data: { ...body, fresh_auth_proof: `${body.fresh_auth_proof}x` },
    });
    await expectGateRefusal(tampered, { status: 401, reasons: ['missing', 'expired', 'malformed'] });

    const replay = await request.post('/api/custody/broadcast', { headers: bearer(token), data: body });
    await expectPostGateStop(replay);
  });

  test('a comment broadcast carries the session window minted at the real session-auth route', async ({ page }) => {
    // Expected to fail until the custody broadcast allowlist admits the
    // `comment_options` op the composer bundles with every comment (see the
    // file docblock): the handler refuses the bundle before the fresh-auth
    // gate with 403 FORBIDDEN, so the post-gate stop asserted at the end is
    // not reached. Playwright reports an unexpected pass once it is, which
    // is the signal to drop this annotation. Until then the assertions ahead
    // of the stop are masked by it; the vote test covers the same
    // acquisition and carry on this surface unmasked.
    test.fail(true, 'custody broadcast allowlist refuses the comment_options op every light-account post carries');

    const { paper } = await mountPaperDetail(page, {
      permlink: `e2e-fa-comment-${RUN_SUFFIX}`,
      title: 'Light Account Comment Test',
    });
    // The top-level composer is the only one on the page until a review
    // thread is toggled open, and there are no reviews in this fixture.
    const composer = page.locator('[x-data*="commentComposer"]');
    const commentBody = 'Automated E2E light-account comment.';
    await composer.locator('textarea').fill(commentBody);

    const mintResponsePromise = page.waitForResponse(postTo('/api/custody/session-auth').response);
    const broadcastRequestPromise = page.waitForRequest(postTo('/api/custody/broadcast').request);
    const broadcastResponsePromise = page.waitForResponse(postTo('/api/custody/broadcast').response);

    await composer.getByRole('button').click();
    await confirmBroadcastDialog(page);
    await answerReauthPrompt(page);
    const issued = await issuedWindow(mintResponsePromise);

    // The broadcast carried the window the mint issued, on the comment the
    // composer built.
    const broadcastReq = await broadcastRequestPromise;
    const body = broadcastReq.postDataJSON();
    expect(body.fresh_auth_proof).toBe(issued.fresh_auth_proof);
    const commentOp = body.operations.find((op) => op[0] === 'comment');
    expect(commentOp, 'the bundle carries the comment op').toBeTruthy();
    expect(commentOp[1]).toMatchObject({
      author: SEEDED_USERNAME,
      parent_author: paper.author,
      parent_permlink: paper.permlink,
      body: commentBody,
    });
    expect(JSON.parse(commentOp[1].json_metadata).app.startsWith(`${APP_TAG}/`)).toBe(true);

    // The correct outcome for this bundle: past the gate, stopped at the
    // seeded account's posting-key decrypt.
    await expectPostGateStop(await broadcastResponsePromise);
  });

  test('a publish with a PDF carries the session window through the real upload pre-flight, the transfer, and the broadcast', async ({ page, request }) => {
    // The upload pre-flight gates on HAF accreditation after it consumes the
    // proof, so this leg needs a username HAF reports as accredited. The
    // light custody comes from the JWT claim and the seeded row, not from
    // HAF, so a HAF-accredited researcher becomes a light account for this
    // test by seeding a row under their username; afterAll removes it.
    const researcher = await pickAccreditedResearcher(request);
    test.skip(
      !researcher,
      'no accredited researcher currently indexed in HAF: the upload pre-flight gates on accreditation, so the light-account upload leg cannot be exercised',
    );
    publishUsername = researcher.username;
    await seedLightAccount(pool, {
      username: researcher.username,
      email: `e2e+fa-publish-${RUN_SUFFIX}@pevo.test`,
      fullName: researcher.accreditation?.name || 'E2E Author',
    });

    await seedAccreditedSession(page, {
      username: researcher.username,
      accreditation: researcher.accreditation,
      custody: 'light',
    });
    // A stale draft would repopulate the form with the wrong values.
    await page.addInitScript(() => {
      window.localStorage.removeItem('pevo-draft-publish');
    });

    await page.goto('/en/publish');
    await page.waitForSelector('[x-data="publishPage"]');
    await expect(page.locator('input#paper-title')).toBeVisible();

    const TITLE = 'E2E Light Account Publish Test Paper';
    await page.locator('input[x-model="title"]').fill(TITLE);
    await page.locator('input[x-model="authorName"]').fill(researcher.accreditation?.name || 'E2E Author');
    await page.locator('input[x-model="keywordsText"]').fill('testing, e2e, light-account');
    await page.evaluate(
      ({ abstract, body, discipline }) => {
        const data = window.Alpine.$data(document.querySelector('[x-data="publishPage"]'));
        data.abstract = abstract;
        data.body = body;
        data.discipline = discipline;
        data.disciplineSearch = discipline;
        data.citations = [];
      },
      {
        abstract: 'Automated E2E abstract covering the light-account publish flow.',
        body: '## Introduction\n\nThis is the body of the E2E light-account paper.',
        discipline: 'Computer Science',
      },
    );

    // Acquire-before-commit: picking the PDF opens the password prompt BEFORE
    // the file is accepted, so the window is in hand before there is anything
    // to lose. The mint is the real session-auth route.
    const mintResponsePromise = page.waitForResponse(postTo('/api/custody/session-auth').response);
    await page.locator('input#pdf-upload').setInputFiles({
      name: 'e2e-light-paper.pdf',
      mimeType: 'application/pdf',
      buffer: minimalPdfBuffer(),
    });
    await answerReauthPrompt(page);
    const issued = await issuedWindow(mintResponsePromise);
    await expect
      .poll(() => page.evaluate(() => window.Alpine.$data(document.querySelector('[x-data="publishPage"]')).pdfFileName))
      .toBe('e2e-light-paper.pdf');

    const tokenRequestPromise = page.waitForRequest(postTo('/api/ipfs/upload-token').request);
    const tokenResponsePromise = page.waitForResponse(postTo('/api/ipfs/upload-token').response);
    const uploadResponsePromise = page.waitForResponse(postTo('/api/ipfs/upload').response);
    const broadcastRequestPromise = page.waitForRequest(postTo('/api/custody/broadcast').request);

    // Scoped to the publish form: the always-mounted reauth modal has a
    // submit button of its own.
    await page.locator('[x-data="publishPage"] form button[type="submit"]').click();
    // The submit-entry gate cache-hits the window acquired at file selection
    // (no second prompt), then the light-account confirmation dialog fronts
    // the upload legs and the broadcast.
    await confirmBroadcastDialog(page);

    // Upload pre-flight: the declared file descriptor rides with the window
    // proof, and the real route consumes the window and mints an upload
    // token against it. This is the backend accepting the window; a proof
    // it refuses answers FRESH_AUTH_REQUIRED here, and an account HAF does
    // not report as accredited answers 403 after the consume.
    const tokenReq = await tokenRequestPromise;
    const tokenBody = tokenReq.postDataJSON();
    expect(tokenBody.fresh_auth_proof).toBe(issued.fresh_auth_proof);
    expect(tokenBody.file_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenBody.mimetype).toBe('application/pdf');
    expect(tokenBody.size).toBe(minimalPdfBuffer().length);
    const tokenResp = await tokenResponsePromise;
    expect(tokenResp.status(), await tokenResp.text()).toBe(200);
    expect(typeof (await tokenResp.json()).data.upload_token).toBe('string');

    // Transfer: the token-gated multipart upload pins the bytes for real.
    const uploadResp = await uploadResponsePromise;
    expect(uploadResp.status(), await uploadResp.text()).toBe(200);
    const cid = (await uploadResp.json())?.data?.cid;
    expect(cid, 'IPFS upload should return a CID').toBeTruthy();

    // Broadcast: the same window (one re-auth act covers the upload and the
    // post) rides on the paper op that carries the CID just pinned. The
    // response is not pinned here: this bundle carries the `comment_options`
    // op the allowlist refuses before the gate (see the file docblock), and
    // the comment test pins that under `test.fail`. The gate's acceptance of
    // this same window is pinned by the pre-flight's 200 above and by the
    // vote test's post-gate stop.
    const broadcastReq = await broadcastRequestPromise;
    const body = broadcastReq.postDataJSON();
    expect(body.fresh_auth_proof).toBe(issued.fresh_auth_proof);
    const commentOp = body.operations.find((op) => op[0] === 'comment');
    expect(commentOp, 'the bundle carries the paper op').toBeTruthy();
    expect(commentOp[1]).toMatchObject({ author: researcher.username, parent_author: '', parent_permlink: APP_TAG, title: TITLE });
    const meta = JSON.parse(commentOp[1].json_metadata);
    expect(meta[APP_TAG].ipfs_cid).toBe(cid);

    // The page reports the failed publish and keeps the form (no navigation,
    // no draft cleared): the end state for a refused broadcast, whether it is
    // refused before the gate as today or stopped at the posting-key decrypt
    // once the allowlist admits the bundle.
    await expect
      .poll(() => page.evaluate(() => window.Alpine.$data(document.querySelector('[x-data="publishPage"]')).step))
      .toBe('error');
    await expect(page.locator('input[x-model="title"]')).toHaveValue(TITLE);
  });
});
