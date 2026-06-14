/**
 * E2E-WRITE-1 — Publish flow up to broadcast.
 *
 * Drives /publish end-to-end through the real backend IPFS upload, then
 * intercepts the Keychain requestBroadcast call before the operation would
 * hit the chain. The spec asserts the assembled `comment` op carries the
 * right shape: CID in json_metadata, app/tags fields correct, parent
 * permlink equals APP_TAG.
 *
 * Why an already-accredited account: accreditation lives on HAF (custom_json
 * from the accreditation authority) and is shared read-only with dev. Rather
 * than trying to mint an accreditation in the test DB (where there is no
 * accreditation table to begin with), we pick whichever researcher HAF
 * currently shows as accredited and mint a JWT for them using SESSION_SECRET
 * — the backend's verifyHiveSignature middleware accepts a Bearer JWT as
 * equivalent to a Hive signature, so the IPFS upload succeeds.
 *
 * The Keychain broadcast stub (see fixtures/keychain.js) captures every call
 * into `window.__pevoBroadcastCalls` so we can assert on the payload without
 * the tx ever reaching a Hive node.
 */

import { test, expect } from './fixtures/keychain.js';
import {
  pickAccreditedResearcher,
  seedAccreditedSession,
  minimalPdfBuffer,
} from './fixtures/auth.js';

// SEC-002: disable trace/video/screenshot. The spec mints a real JWT from
// SESSION_SECRET and attaches it to /api/ipfs/upload; retained traces would
// expose the bearer token and the session-secret-signed payload.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const APP_TAG = 'pevotest';

test('publish flow assembles a valid Hive comment broadcast with IPFS CID', async ({
  page,
  request,
}) => {
  const researcher = await pickAccreditedResearcher(request);
  if (!researcher) throw new Error('expected at least one accredited researcher in HAF');

  await seedAccreditedSession(page, {
    username: researcher.username,
    accreditation: researcher.accreditation,
  });

  // Any stale draft from a previous run would repopulate the form with the
  // wrong values. Clear it before the page boots.
  await page.addInitScript(() => {
    window.localStorage.removeItem('pevo-draft-publish');
  });

  const uploadResponsePromise = page.waitForResponse(
    (resp) => resp.url().endsWith('/api/ipfs/upload') && resp.request().method() === 'POST',
  );

  await page.goto('/en/publish');

  // The abstract and body editors are Tiptap instances mounted under
  // $nextTick — wait for the Alpine component to be ready before we
  // manipulate its state.
  await page.waitForSelector('[x-data="publishPage"]');
  await expect(page.locator('input#paper-title')).toBeVisible();

  // ─── Fill text inputs ────────────────────────────────────────
  const TITLE = 'E2E Publish Flow Test Paper';
  const AUTHOR_NAME = researcher.accreditation?.name || 'E2E Author';
  const KEYWORDS = 'testing, e2e, automation';

  await page.locator('input[x-model="title"]').fill(TITLE);
  // authorName may already be prefilled from accreditation; overwrite to a
  // known value so assertions are deterministic.
  await page.locator('input[x-model="authorName"]').fill(AUTHOR_NAME);
  await page.locator('input[x-model="keywordsText"]').fill(KEYWORDS);

  // ─── Abstract, body, discipline, citations via Alpine data ───
  // Tiptap editors are awkward to drive by keystrokes; setting the Alpine
  // state directly is what matters for the broadcast — the editor UI is
  // read-only from the spec's perspective.
  await page.evaluate(
    ({ abstract, body, discipline, citations }) => {
      const el = document.querySelector('[x-data="publishPage"]');
      const data = window.Alpine.$data(el);
      data.abstract = abstract;
      data.body = body;
      data.discipline = discipline;
      data.disciplineSearch = discipline;
      data.citations = citations;
    },
    {
      abstract: 'Automated E2E abstract covering the publish flow.',
      body: '## Introduction\n\nThis is the body of the E2E paper.',
      discipline: 'Computer Science',
      citations: [
        { author: 'someauthor', permlink: 'some-permlink', title: 'Cited Work', reputation_relevant: true },
      ],
    },
  );

  // ─── Upload a PDF to trigger the IPFS round-trip ─────────────
  await page.locator('input#pdf-upload').setInputFiles({
    name: 'e2e-paper.pdf',
    mimeType: 'application/pdf',
    buffer: minimalPdfBuffer(),
  });

  // ─── Submit and intercept ────────────────────────────────────
  await page.locator('form button[type="submit"]').click();

  const uploadResp = await uploadResponsePromise;
  expect(uploadResp.status()).toBe(200);
  const uploadBody = await uploadResp.json();
  const cid = uploadBody?.data?.cid;
  expect(cid, 'IPFS upload should return a CID').toBeTruthy();

  // Wait for the broadcast stub to be called (happens after upload + hash).
  await expect
    .poll(() => page.evaluate(() => window.__pevoBroadcastCalls?.length || 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  const broadcast = await page.evaluate(() => window.__pevoBroadcastCalls[0]);

  expect(broadcast.kind).toBe('broadcast');
  expect(broadcast.username).toBe(researcher.username);
  expect(broadcast.keyType).toBe('posting');
  expect(Array.isArray(broadcast.operations)).toBe(true);

  const commentOp = broadcast.operations.find((op) => op[0] === 'comment');
  expect(commentOp, 'operations should include a comment op').toBeTruthy();
  const [, commentBody] = commentOp;

  expect(commentOp[0]).toBe('comment');
  expect(commentBody.parent_author).toBe('');
  expect(commentBody.parent_permlink).toBe(APP_TAG);
  expect(commentBody.author).toBe(researcher.username);
  expect(commentBody.title).toBe(TITLE);
  expect(typeof commentBody.permlink).toBe('string');
  expect(commentBody.permlink.length).toBeGreaterThan(0);

  const meta = JSON.parse(commentBody.json_metadata);
  // meta.app is `${APP_TAG}/${APP_VERSION}` — prefix check keeps the
  // assertion stable across version bumps.
  expect(meta.app.startsWith(`${APP_TAG}/`)).toBe(true);
  expect(Array.isArray(meta.tags)).toBe(true);
  expect(meta.tags).toContain(APP_TAG);
  expect(meta.tags).toContain('science');
  expect(meta.tags).toContain('Computer Science');
  expect(meta[APP_TAG]).toBeTruthy();
  expect(meta[APP_TAG].type).toBe('paper');
  expect(meta[APP_TAG].ipfs_cid).toBe(cid);
  expect(meta[APP_TAG].discipline).toBe('Computer Science');
  expect(meta[APP_TAG].keywords).toEqual(['testing', 'e2e', 'automation']);
  expect(meta[APP_TAG].citations[0]).toMatchObject({
    author: 'someauthor',
    permlink: 'some-permlink',
  });

  // The second op configures comment_options (rewards off); verify presence
  // but not details, which are not asserted here.
  const optionsOp = broadcast.operations.find((op) => op[0] === 'comment_options');
  expect(optionsOp).toBeTruthy();
});
