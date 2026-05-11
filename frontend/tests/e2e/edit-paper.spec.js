/**
 * E2E-WRITE-3 — Paper edit flow up to broadcast.
 *
 * Drives /edit/:author/:permlink for four scenarios (in-place author edit,
 * continuation edit by another accredited user, unaccredited-non-author
 * gating, and review-addressing surfacing) and intercepts the Keychain
 * requestBroadcast call before the operation would hit the chain.
 *
 * Why mocked paper data: the edit page reads `head_author/head_permlink`,
 * `authors[].hive`, and the existing `pevo` json_metadata block to decide
 * `isAuthorized` / `isContinuation`. Pinning those fields against a real
 * HAF-indexed paper means the spec assertions drift whenever HAF content
 * changes. We `page.route` `/api/papers/:author/:permlink` (and
 * `/enrichment` and `/invalidate`) so each scenario controls the exact
 * authorship/review shape it asserts on. The Hive-signature path is
 * untouched — we still mint a JWT via `seedAccreditedSession`/
 * `seedUnaccreditedSession` so the auth store comes up correctly.
 *
 * The Keychain broadcast stub (see fixtures/keychain.js) captures every call
 * into `window.__pevoBroadcastCalls` so we can assert on the payload without
 * the tx ever reaching a Hive node.
 *
 * Cross-reference: `project_edit_flow_decisions` memory — review
 * invalidation in the current implementation surfaces as the "Address
 * reviews" checklist (acknowledgment of which reviews the new version
 * addresses), not a separate "this will invalidate existing reviews"
 * banner. Test 4 asserts that surface renders when reviews exist on the
 * paper before submit.
 */

import { test, expect } from './fixtures/keychain.js';
import {
  pickAccreditedResearcher,
  seedAccreditedSession,
  seedUnaccreditedSession,
} from './fixtures/auth.js';

// SEC-002: disable trace/video/screenshot. The spec mints JWTs via
// SESSION_SECRET; retained traces would expose the bearer token.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const APP_TAG = 'pevotest';

// ─── Test paper fixture ──────────────────────────────────────────────────
//
// Shape mirrors the `/api/papers/:author/:permlink` envelope that the edit
// page consumes via `fetchPaper`. Fields used by edit.js:
//   - author, permlink, title, body
//   - authors[].hive (co-authors)
//   - head_author/head_permlink (chain head detection)
//   - canonical_author/canonical_permlink (back-to-paper link target)
//   - json_metadata[APP_TAG]: { discipline, keywords, citations,
//     supplementary_files, authors }
//   - authorship_claims (accepted-claim path; lives on enrichment)
//   - versions (drives nextVersion getter)
function buildPaperFixture({ author, permlink, coAuthorHive = null }) {
  const authors = [
    { name: 'Original Author', hive: author, orcid: '', affiliation: 'Test U' },
  ];
  if (coAuthorHive) {
    authors.push({ name: 'Co Author', hive: coAuthorHive, orcid: '', affiliation: 'Test U' });
  }
  const pevoMeta = {
    type: 'paper',
    version: 1,
    discipline: 'Computer Science',
    keywords: ['testing', 'e2e'],
    authors,
    citations: [],
  };
  return {
    author,
    permlink,
    title: 'Original E2E Edit Paper Title',
    body:
      '## Abstract\n\nOriginal abstract text for the E2E edit spec.\n\n---\n\n' +
      '## Introduction\n\nOriginal body content.',
    authors,
    head_author: author,
    head_permlink: permlink,
    canonical_author: author,
    canonical_permlink: permlink,
    json_metadata: { app: `${APP_TAG}/0.1.0`, [APP_TAG]: pevoMeta },
    versions: [{ version_number: 1, author, permlink }],
    authorship_claims: [],
  };
}

function envelope(data) {
  return { status: 'ok', data };
}

async function installPaperMocks(page, { paper, reviews = [], claims = [] }) {
  const paperPath = `/api/papers/${encodeURIComponent(paper.author)}/${encodeURIComponent(paper.permlink)}`;

  // Playwright dispatches page.route matches in REVERSE registration order
  // (most-recently-registered first), with route.fallback() walking back
  // through earlier handlers. So we register the suffix-specific handlers
  // (enrichment, invalidate) FIRST and the bare paper route LAST. At
  // runtime the bare matcher fires first; for /enrichment and /invalidate
  // URLs its else-branch calls route.fallback(), which then resolves to the
  // earlier-registered specific handlers below.
  await page.route(`**${paperPath}/enrichment`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope({ reviews, authorship_claims: claims })),
    });
  });

  await page.route(`**${paperPath}/invalidate`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope({ ok: true })),
    });
  });

  await page.route(`**${paperPath}**`, async (route) => {
    const url = route.request().url();
    // This bare-paper route is registered LAST and therefore fires FIRST by
    // Playwright's dispatch order. For suffix URLs (/enrichment,
    // /invalidate, /comments) we call route.fallback() to hand off to the
    // earlier-registered specific handlers above; the bare matcher itself
    // services the exact `/papers/:a/:p` request and the `?version=` query
    // variants.
    if (url.includes('/enrichment') || url.includes('/invalidate') || url.includes('/comments')) {
      return route.fallback();
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope(paper)),
    });
  });
}

async function clearDraft(page, author, permlink) {
  // A stale draft from an earlier run repopulates the form before our
  // assertions can read the fresh prefill. Clear before any page script runs.
  await page.addInitScript(
    ({ key }) => {
      window.localStorage.removeItem(key);
    },
    { key: `pevo-draft-edit-${author}-${permlink}` },
  );
}

// File-scope helper: build a unique permlink per spec run. The 4 tests below
// each need a permlink that won't collide with sibling runs and is cheap to
// generate. Centralising the idiom makes the call sites read as intent
// ("a fresh permlink for the in-place edit scenario") rather than a
// `Date.now().toString(36)` ritual.
function uniquePermlink(prefix) {
  return `${prefix}-${Date.now().toString(36)}`;
}

// Wait for both Tiptap editors (abstract + body) to finish their async
// mount. edit.js:_mountEditors runs via $nextTick → dynamic
// import('../editor.js'), so `_abstractEditor` and `_bodyEditor` populate
// only after the import resolves. If a test writes to `data.abstract` or
// `data.body` before then, the about-to-mount editor's constructor will
// install initialMarkdown from the pre-prefill values and any subsequent
// editor transaction could re-emit through onChange, clobbering the test
// write. Gating evaluate-time writes on this readiness check eliminates
// the race window.
async function waitForEditorsMounted(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('[x-data="editPage"]');
    if (!el) return false;
    const data = window.Alpine?.$data(el);
    return !!(data?._abstractEditor && data?._bodyEditor);
  });
}

// Set abstract+body via BOTH the Alpine state (what edit.js reads on
// submit) AND the editor view's public setContent (which uses
// emitUpdate:false per editor.js:681, so it won't re-fire onChange and
// clobber the Alpine write). This in-band update is the canonical way to
// keep the editor view and Alpine state coherent from a spec.
async function setEditorContent(page, { abstract, body }) {
  await page.evaluate(
    ({ abstract, body }) => {
      const el = document.querySelector('[x-data="editPage"]');
      const data = window.Alpine.$data(el);
      data.abstract = abstract;
      data.body = body;
      // Sync the editor views. setContent uses emitUpdate:false (see
      // editor.js setContent), so this does not re-trigger the onChange
      // callback that would overwrite data.abstract / data.body.
      data._abstractEditor?.setContent(abstract);
      data._bodyEditor?.setContent(body);
    },
    { abstract, body },
  );
}

test('original-author edit broadcasts in-place comment with same parent_permlink and permlink', async ({
  page,
  request,
}) => {
  const researcher = await pickAccreditedResearcher(request);
  if (!researcher) throw new Error('expected at least one accredited researcher in HAF');

  const PERMLINK = uniquePermlink('e2e-edit-inplace');
  const paper = buildPaperFixture({ author: researcher.username, permlink: PERMLINK });

  await installPaperMocks(page, { paper });
  await seedAccreditedSession(page, {
    username: researcher.username,
    accreditation: researcher.accreditation,
  });
  await clearDraft(page, paper.author, paper.permlink);

  await page.goto(`/en/edit/${paper.author}/${paper.permlink}`);

  await page.waitForSelector('[x-data="editPage"]');
  // The form only mounts when isAuthorized resolves true after the paper
  // load completes.
  await expect(page.locator('input#edit-title')).toBeVisible();

  // Continuation banner must NOT show for the original author when no
  // chain exists yet.
  await expect(page.locator('text=Publishing as a revision')).toHaveCount(0);

  const NEW_TITLE = 'Updated E2E Edit Paper Title';
  const NEW_ABSTRACT = 'Updated abstract that the spec will verify in the broadcast body.';
  const NEW_BODY = '## Introduction\n\nUpdated body content from the E2E edit spec.';

  await page.locator('input#edit-title').fill(NEW_TITLE);

  // Drive abstract/body via Alpine state + editor setContent — Tiptap
  // editors are awkward to type into and the broadcast assertions only
  // care about the markdown strings, which Alpine owns. The wait+setContent
  // pair eliminates the editor-mount-race window (see helper docblock).
  await waitForEditorsMounted(page);
  await setEditorContent(page, { abstract: NEW_ABSTRACT, body: NEW_BODY });

  await page.locator('form button[type="submit"]').click();

  await expect
    .poll(() => page.evaluate(() => window.__pevoBroadcastCalls?.length || 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  const broadcast = await page.evaluate(() => window.__pevoBroadcastCalls[0]);

  expect(broadcast.kind).toBe('broadcast');
  expect(broadcast.username).toBe(researcher.username);
  expect(broadcast.keyType).toBe('posting');

  const commentOp = broadcast.operations.find((op) => op[0] === 'comment');
  expect(commentOp, 'operations should include a comment op').toBeTruthy();
  const [, commentBody] = commentOp;

  // In-place edit invariants: same parent_permlink (APP_TAG), same permlink
  // as the original post, same author.
  expect(commentBody.parent_author).toBe('');
  expect(commentBody.parent_permlink).toBe(APP_TAG);
  expect(commentBody.author).toBe(researcher.username);
  expect(commentBody.permlink).toBe(paper.permlink);
  expect(commentBody.title).toBe(NEW_TITLE);

  const meta = JSON.parse(commentBody.json_metadata);
  expect(meta.app.startsWith(`${APP_TAG}/`)).toBe(true);
  expect(Array.isArray(meta.tags)).toBe(true);
  expect(meta.tags).toContain(APP_TAG);
  expect(meta[APP_TAG]).toBeTruthy();
  expect(meta[APP_TAG].type).toBe('paper');
  expect(meta[APP_TAG].version).toBe(2);
  expect(meta[APP_TAG].discipline).toBe('Computer Science');
  // In-place edits do NOT add a `continues` link.
  expect(meta[APP_TAG].continues).toBeUndefined();
});

test('continuation edit by another accredited user broadcasts a NEW permlink with continues link, discipline disabled, banner visible', async ({
  page,
  request,
}) => {
  const reviewer = await pickAccreditedResearcher(request);
  if (!reviewer) throw new Error('expected at least one accredited researcher in HAF');

  // The fixture paper is authored by a different account so the seeded
  // user lands in the continuation path (not co-author, no claim, but
  // accredited).
  const ORIG_AUTHOR = `notauthor${Date.now().toString(36)}`;
  // Sanity: the seeded researcher must not collide with the synthetic
  // original author. If they do (vanishingly unlikely with the timestamp
  // suffix, but worth the explicit guard), the test would fall into the
  // in-place edit branch and the assertions below would mis-fire.
  if (ORIG_AUTHOR === reviewer.username) {
    throw new Error('synthetic original author collided with seeded researcher');
  }
  const PERMLINK = uniquePermlink('e2e-edit-cont');
  const paper = buildPaperFixture({ author: ORIG_AUTHOR, permlink: PERMLINK });

  await installPaperMocks(page, { paper });
  await seedAccreditedSession(page, {
    username: reviewer.username,
    accreditation: reviewer.accreditation,
  });
  await clearDraft(page, paper.author, paper.permlink);

  await page.goto(`/en/edit/${paper.author}/${paper.permlink}`);

  await page.waitForSelector('[x-data="editPage"]');
  await expect(page.locator('input#edit-title')).toBeVisible();

  // Continuation banner shows for accredited non-author.
  // The exact copy ("Publishing as a revision") comes from
  // `edit.continuationNotice` in en.json.
  await expect(page.locator('text=Publishing as a revision').first()).toBeVisible();

  // Discipline input is disabled (fixed across continuations).
  // Alpine binds :value as a property, not the HTML attribute, so locate by
  // class and verify the value via toHaveValue (reads the property).
  const disciplineInput = page.locator('input.select-control[disabled]').first();
  await expect(disciplineInput).toBeVisible();
  await expect(disciplineInput).toBeDisabled();
  await expect(disciplineInput).toHaveValue('Computer Science');

  const NEW_TITLE = 'Continuation Revision Title';
  const NEW_ABSTRACT = 'Continuation abstract authored by a different accredited user.';
  const NEW_BODY = '## Introduction\n\nContinuation body content.';

  await page.locator('input#edit-title').fill(NEW_TITLE);
  await waitForEditorsMounted(page);
  await setEditorContent(page, { abstract: NEW_ABSTRACT, body: NEW_BODY });

  await page.locator('form button[type="submit"]').click();

  await expect
    .poll(() => page.evaluate(() => window.__pevoBroadcastCalls?.length || 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  const broadcast = await page.evaluate(() => window.__pevoBroadcastCalls[0]);

  expect(broadcast.kind).toBe('broadcast');
  expect(broadcast.username).toBe(reviewer.username);
  expect(broadcast.keyType).toBe('posting');

  const commentOp = broadcast.operations.find((op) => op[0] === 'comment');
  expect(commentOp, 'operations should include a comment op').toBeTruthy();
  const [, commentBody] = commentOp;

  // Continuation invariants: NEW permlink (different from the original),
  // authored by the accredited reviewer, parent still APP_TAG (top-level),
  // and the json_metadata carries a `continues` pointer to the chain head.
  expect(commentBody.parent_author).toBe('');
  expect(commentBody.parent_permlink).toBe(APP_TAG);
  expect(commentBody.author).toBe(reviewer.username);
  expect(commentBody.permlink).not.toBe(paper.permlink);
  expect(typeof commentBody.permlink).toBe('string');
  expect(commentBody.permlink.length).toBeGreaterThan(0);

  const meta = JSON.parse(commentBody.json_metadata);
  expect(meta.app.startsWith(`${APP_TAG}/`)).toBe(true);
  expect(meta.tags).toContain(APP_TAG);
  expect(meta[APP_TAG]).toBeTruthy();
  expect(meta[APP_TAG].type).toBe('paper');
  expect(meta[APP_TAG].version).toBe(2);
  expect(meta[APP_TAG].discipline).toBe('Computer Science');
  expect(meta[APP_TAG].continues).toBeTruthy();
  expect(meta[APP_TAG].continues.author).toBe(paper.author);
  expect(meta[APP_TAG].continues.permlink).toBe(paper.permlink);

  // Continuation also broadcasts comment_options (matches publish flow).
  const optionsOp = broadcast.operations.find((op) => op[0] === 'comment_options');
  expect(optionsOp).toBeTruthy();
});

test('unaccredited non-author cannot reach the edit form; gating panel and back-to-paper CTA render instead', async ({
  page,
}) => {
  const ORIG_AUTHOR = `someauthor${Date.now().toString(36)}`;
  const PERMLINK = uniquePermlink('e2e-edit-gated');
  const paper = buildPaperFixture({ author: ORIG_AUTHOR, permlink: PERMLINK });

  await installPaperMocks(page, { paper });
  // Connected but unaccredited, and not the author/co-author/claimer.
  await seedUnaccreditedSession(page);
  await clearDraft(page, paper.author, paper.permlink);

  await page.goto(`/en/edit/${paper.author}/${paper.permlink}`);

  await page.waitForSelector('[x-data="editPage"]');

  // Post-gating shape (commit de1c205):
  //  - red accreditation banner ("You need to be accredited to edit this paper.")
  //  - "Who can edit this paper?" panel with the three valid paths
  //  - back-to-paper CTA
  //  - NO edit form
  await expect(page.locator('text=Who can edit this paper?').first()).toBeVisible();
  await expect(page.locator('text=You need to be accredited to edit this paper.').first()).toBeVisible();

  // Three explanatory bullet points. We assert by text fragments rather than
  // structural selectors so a future copy tweak surfaces as a focused diff.
  await expect(page.locator('text=original author').first()).toBeVisible();
  await expect(page.locator('text=co-author').first()).toBeVisible();
  await expect(page.locator('text=authorship claim').first()).toBeVisible();

  // Back-to-paper CTA points at the canonical paper. We assert the link
  // exists and resolves to /paper/:author/:permlink under a locale prefix.
  const backLink = page.locator(`a[href$="/paper/${paper.author}/${paper.permlink}"]`).first();
  await expect(backLink).toBeVisible();

  // Edit form must NOT render — assert by the title input id and the
  // form's submit button being absent. Submit is impossible because no
  // form is present.
  await expect(page.locator('input#edit-title')).toHaveCount(0);
  await expect(page.locator('form button[type="submit"]')).toHaveCount(0);
});

test('review-addressing surface renders before submit when paper has prior reviews', async ({
  page,
  request,
}) => {
  // The current edit flow does not show an explicit "this will invalidate
  // existing reviews" banner. Per `project_edit_flow_decisions`, review
  // version-coupling is surfaced via the "Address reviews" checklist —
  // the author selects which reviews their revision addresses, and
  // `addresses_reviews` is recorded in the broadcast json_metadata.
  // This test asserts that surface renders pre-submit when reviews exist
  // and that selections flow into the broadcast.
  const researcher = await pickAccreditedResearcher(request);
  if (!researcher) throw new Error('expected at least one accredited researcher in HAF');

  const PERMLINK = uniquePermlink('e2e-edit-reviews');
  const paper = buildPaperFixture({ author: researcher.username, permlink: PERMLINK });

  const reviews = [
    {
      author: 'reviewer-one',
      permlink: 're-paper-1',
      body: 'The methodology section needs more detail about the experimental setup and controls used.',
      is_anonymous: false,
      reviewed_version: 1,
    },
    {
      author: 'reviewer-two',
      permlink: 're-paper-2',
      body: 'Clarity could be improved in section 3, particularly around the notation introduced on page 4.',
      is_anonymous: true,
      reviewed_version: 1,
    },
  ];

  await installPaperMocks(page, { paper, reviews });
  await seedAccreditedSession(page, {
    username: researcher.username,
    accreditation: researcher.accreditation,
  });
  await clearDraft(page, paper.author, paper.permlink);

  await page.goto(`/en/edit/${paper.author}/${paper.permlink}`);

  await page.waitForSelector('[x-data="editPage"]');
  await expect(page.locator('input#edit-title')).toBeVisible();

  // The "Address reviews" panel must be visible BEFORE submit when
  // reviews exist (this is the review-version coupling surface).
  await expect(page.locator('text=Address reviews').first()).toBeVisible();
  await expect(page.locator('text=Reviewers will see their feedback was incorporated').first())
    .toBeVisible();

  // Two review checkboxes, one per review. Locate by data-testid: Alpine's
  // `:value` binding writes the .value PROPERTY only, never setAttribute,
  // so CSS attribute selectors like `[value*="reviewer-"]` return zero
  // matches at runtime. See
  // agents/docs/solutions/conventions/alpine-value-property-not-attribute-trap-2026-05-11.md
  const reviewCheckboxes = page.getByTestId('address-review-checkbox');
  await expect(reviewCheckboxes).toHaveCount(2);

  // Make a real edit so the submit handler does not bail on "no changes".
  await page.locator('input#edit-title').fill('Title Updated To Address Reviews');
  await waitForEditorsMounted(page);
  await setEditorContent(page, {
    abstract: 'Updated abstract that addresses reviewer feedback on methodology and clarity.',
    body: '## Introduction\n\nRewritten body responding to reviewers.',
  });

  // Tick the first review so addresses_reviews lands in the broadcast.
  await reviewCheckboxes.first().check();

  await page.locator('form button[type="submit"]').click();

  await expect
    .poll(() => page.evaluate(() => window.__pevoBroadcastCalls?.length || 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  const broadcast = await page.evaluate(() => window.__pevoBroadcastCalls[0]);
  const commentOp = broadcast.operations.find((op) => op[0] === 'comment');
  expect(commentOp).toBeTruthy();
  const meta = JSON.parse(commentOp[1].json_metadata);
  expect(Array.isArray(meta[APP_TAG].addresses_reviews)).toBe(true);
  expect(meta[APP_TAG].addresses_reviews.length).toBeGreaterThan(0);
  // The first review's author/permlink must appear in addresses_reviews.
  expect(
    meta[APP_TAG].addresses_reviews.some(
      (r) => r.author === 'reviewer-one' && r.permlink === 're-paper-1',
    ),
  ).toBe(true);
});
