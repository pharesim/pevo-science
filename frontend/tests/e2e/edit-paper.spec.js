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
import { installPaperMocks } from './fixtures/paper-mocks.js';

// SEC-002: disable trace/video/screenshot. The spec mints JWTs via
// SESSION_SECRET; retained traces would expose the bearer token.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const APP_TAG = 'pevotest';

// Shared four-paragraph academic prose used by `buildPaperFixture.body`
// (test 1's fixture body) AND by `NEW_BODY` in test 1's in-place edit
// (which appends a single sentence to the Discussion paragraph). The
// additive relationship is structural: NEW_BODY is `ORIG_BODY_PARAGRAPHS
// + " <one short sentence>"`, so anyone editing the prose only touches
// this constant and the diff-branch invariant survives. Sizing rationale:
// the ~1.2KB original keeps the diff-match-patch representation of a
// single-sentence addition far below the ~1.3KB full-body length, so
// production at edit.js:1063 selects the diff branch
// (`diffText.length < newPostBody.length`) and `body.startsWith('@@')`
// holds. Earlier ~100-char bodies fell through to the full-body fallback
// unconditionally, leaving the diff branch uncovered (round-3 hold).
const ORIG_BODY_PARAGRAPHS =
  '## Introduction\n\nThis paper investigates the foundational characteristics of end-to-end testing infrastructure in distributed scientific publishing systems. We begin by surveying the landscape of automated browser-driven test frameworks, including their respective tradeoffs around determinism, speed, and maintenance overhead.\n\n' +
  '## Methodology\n\nOur approach combines property-based testing with scenario-driven integration coverage. We selected Playwright as the driver due to its strong support for parallel execution and its first-class handling of asynchronous DOM mutations introduced by reactive frameworks such as Alpine.js.\n\n' +
  '## Results\n\nWe observed that the test suite caught seven distinct regression classes across the edit-paper flow. Three of these involved subtle interactions between the Tiptap editor mount sequence and the underlying Alpine reactive state, and would not have been caught by unit tests alone.\n\n' +
  '## Discussion\n\nThese findings reinforce the value of end-to-end coverage for flows that bridge multiple reactive frameworks. Future work should extend the methodology to the publication and review flows, which share similar architectural patterns.';

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
  // Body derives from the module-scope `ORIG_BODY_PARAGRAPHS` constant so
  // the diff-broadcast invariant is structurally enforced: test 1's
  // NEW_BODY is `ORIG_BODY_PARAGRAPHS + " <one short sentence>"`, which
  // keeps the diff-match-patch representation far shorter than the full
  // body. See ORIG_BODY_PARAGRAPHS docblock above for the sizing rationale.
  return {
    author,
    permlink,
    title: 'Original E2E Edit Paper Title',
    body:
      '## Abstract\n\nOriginal abstract text for the E2E edit spec.\n\n---\n\n' +
      ORIG_BODY_PARAGRAPHS,
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

// Set abstract+body via Alpine state (what edit.js reads on submit). We
// gate this on waitForEditorsMounted so the editor instances exist.
// Alpine state write is sufficient. Calling editor.setContent() after
// the editor's own initialMarkdown application produces a tiptap
// "Applying a mismatched transaction" RangeError (the in-progress
// initial transaction conflicts with the imperative replace), so we
// avoid the imperative path entirely. Verified the editor's onUpdate
// does not fire on constructor content-init (tiptap dispatchTransaction
// gates the callback to user transactions, not constructor init).
async function setEditorContent(page, { abstract, body }) {
  await page.evaluate(
    ({ abstract, body }) => {
      const el = document.querySelector('[x-data="editPage"]');
      const data = window.Alpine.$data(el);
      data.abstract = abstract;
      data.body = body;
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
  // Small additive edits to the prefilled abstract and body. Keeping the
  // bulk of the original content intact is what makes the diff-match-patch
  // representation smaller than the full new body, so production's
  // `diffText.length < newPostBody.length` check selects the diff branch
  // at edit.js:1063 and `commentBody.body.startsWith('@@')` holds below.
  // Wholesale replacement would blow the diff up past the full-body size
  // and silently route the broadcast through the full-body fallback.
  const PREFILLED_ABSTRACT = 'Original abstract text for the E2E edit spec.';
  const NEW_ABSTRACT = PREFILLED_ABSTRACT + ' This revision sharpens the experimental claims.';
  // NEW_BODY = ORIG_BODY_PARAGRAPHS + one short appended sentence. The
  // additive shape is load-bearing: it keeps the diff-match-patch
  // representation small relative to the full body, so production's
  // length-gate ternary selects the diff branch and the
  // `body.startsWith('@@')` assertion below holds. Wholesale replacement
  // would balloon the diff past the full-body size and silently route
  // the broadcast through the full-body fallback.
  const NEW_BODY =
    ORIG_BODY_PARAGRAPHS + ' We also note an open question around drift detection.';

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

  // Diff-broadcast branch: in-place edits broadcast a diff-match-patch
  // text (which starts with `@@` patch headers), not the full body. This
  // pins the optimization at edit.js:1033-1057; a regression that drops
  // the diff branch (always broadcasting full body) would double every
  // paper-revision chain's Hive footprint.
  expect(commentBody.body.startsWith('@@')).toBe(true);
});

test('accredited non-author (not co-author, no claim) cannot reach the edit form; gating panel renders, no broadcast', async ({
  page,
  request,
}) => {
  // Narrow gating (ui-edit-narrow-gating-drop-accredited-fallback,
  // 2026-05-11): `isAuthorized` no longer falls back to `isAccredited`.
  // An accredited user who is not the original author, not a named co-
  // author, and has no accepted authorship claim must land on the
  // gating panel, not the edit form. The backend continuation consent-
  // gate (`extractAuthorizedContinuationAuthors`) would have filtered
  // any broadcast out of the displayed chain anyway; this test asserts
  // the UI no longer exposes the dead-end affordance.
  const reviewer = await pickAccreditedResearcher(request);
  if (!reviewer) throw new Error('expected at least one accredited researcher in HAF');

  const ORIG_AUTHOR = `notauthor${Date.now().toString(36)}`;
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

  // Gating panel renders, edit form does not.
  await expect(page.locator('text=Who can edit this paper?').first()).toBeVisible();
  await expect(page.locator('input#edit-title')).toHaveCount(0);
  await expect(page.locator('form button[type="submit"]')).toHaveCount(0);

  // Three explanatory bullet points list the legitimate paths.
  await expect(page.locator('text=original author').first()).toBeVisible();
  await expect(page.locator('text=co-author').first()).toBeVisible();
  await expect(page.locator('text=authorship claim').first()).toBeVisible();

  // Back-to-paper CTA points at the canonical paper.
  const backLink = page.locator(`a[href$="/paper/${paper.author}/${paper.permlink}"]`).first();
  await expect(backLink).toBeVisible();

  // No broadcast fires — the page has no form to submit.
  const broadcastCount = await page.evaluate(
    () => window.__pevoBroadcastCalls?.length || 0,
  );
  expect(broadcastCount).toBe(0);
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

  // Post-narrow-gating shape (ui-edit-narrow-gating-drop-accredited-
  // fallback, 2026-05-11):
  //  - "Who can edit this paper?" panel with the three valid paths
  //  - back-to-paper CTA
  //  - NO edit form
  //  - NO accreditation banner (accreditation is not the gate on this
  //    page; the three valid paths are the only way in)
  await expect(page.locator('text=Who can edit this paper?').first()).toBeVisible();
  await expect(page.locator('text=You need to be accredited to edit this paper.')).toHaveCount(0);

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

test('accepted-claimer (accredited, not author, not co-author) reaches the edit form and broadcasts', async ({
  page,
  request,
}) => {
  // edit.js:isAuthorized returns true for an accredited user with an
  // accepted authorship_claim against the paper. This is the only
  // positive non-author isAuthorized path in the suite (test 2 asserts
  // the negative gating for accredited non-authors without a claim).
  // A regression dropping the `claims.some(c => c.claimer === username &&
  // c.status === 'accepted')` check from isAuthorized would not be caught
  // by any other test.
  const claimer = await pickAccreditedResearcher(request);
  if (!claimer) throw new Error('expected at least one accredited researcher in HAF');

  const ORIG_AUTHOR = `claimorig${Date.now().toString(36)}`;
  if (ORIG_AUTHOR === claimer.username) {
    throw new Error('synthetic original author collided with seeded claimer');
  }
  const PERMLINK = uniquePermlink('e2e-edit-claimer');
  const paper = buildPaperFixture({ author: ORIG_AUTHOR, permlink: PERMLINK });

  // Seed an ACCEPTED claim for the seeded researcher. installPaperMocks
  // returns this via the enrichment endpoint, which edit.js merges onto
  // this.paper.authorship_claims for isAuthorized to read.
  await installPaperMocks(page, {
    paper,
    claims: [{ claimer: claimer.username, status: 'accepted' }],
  });
  await seedAccreditedSession(page, {
    username: claimer.username,
    accreditation: claimer.accreditation,
  });
  await clearDraft(page, paper.author, paper.permlink);

  await page.goto(`/en/edit/${paper.author}/${paper.permlink}`);

  await page.waitForSelector('[x-data="editPage"]');
  // Edit form renders → isAuthorized resolved true via the claim path
  // (not via co-authorship — paper.authors does not list this user — and
  // not via authorship — paper.author !== this user).
  await expect(page.locator('input#edit-title')).toBeVisible();

  // Continuation forms freeze the discipline (chain-coherence invariant).
  const disciplineInput = page.locator('input.select-control[disabled]').first();
  await expect(disciplineInput).toBeDisabled();
  await expect(disciplineInput).toHaveValue('Computer Science');

  const NEW_TITLE = 'Edit by Accepted Claimer';
  const NEW_ABSTRACT = 'Abstract updated by an accepted-claim user (not the original author).';
  const NEW_BODY = '## Introduction\n\nBody update from accepted claimer.';

  await page.locator('input#edit-title').fill(NEW_TITLE);
  await waitForEditorsMounted(page);
  await setEditorContent(page, { abstract: NEW_ABSTRACT, body: NEW_BODY });

  // Per-entry name requirement: the claimer is becoming a listed author via
  // their accepted claim, so the form requires their name before submit.
  // _prefillForm does not seat authorName here (the claimer is not yet in the
  // prior authors[], so the broadcaster is an addition, _primaryIndex -1).
  await page.locator('input#edit-author-name').fill('Accepted Claimer');

  await page.locator('form button[type="submit"]').click();

  await expect
    .poll(() => page.evaluate(() => window.__pevoBroadcastCalls?.length || 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  const broadcast = await page.evaluate(() => window.__pevoBroadcastCalls[0]);
  expect(broadcast.kind).toBe('broadcast');
  expect(broadcast.username).toBe(claimer.username);

  const commentOp = broadcast.operations.find((op) => op[0] === 'comment');
  expect(commentOp, 'operations should include a comment op').toBeTruthy();
  const [, commentBody] = commentOp;
  // Claimer is not the canonical author on a single-version paper, so
  // edit.js:isContinuation takes the !hasChain → username !== paper.author
  // branch and returns true. The broadcast targets a NEW permlink under
  // the claimer's account (continuation), parent_permlink is APP_TAG.
  expect(commentBody.author).toBe(claimer.username);
  expect(commentBody.parent_permlink).toBe(APP_TAG);
  expect(commentBody.permlink).not.toBe(paper.permlink);

  // Continuation-broadcast payload-shape pins (mirror of test 1's
  // in-place invariants, adapted for the continuation branch):
  //  - parent_author empty (top-level Hive post invariant).
  //  - version > 1 (continuation has version > 1 of the chain).
  //  - continues pointer present and resolves to the previous version.
  // All PEvO posts are broadcast with comment_options.percent_hbd: 0 (100% Hive Power
  // payout). Rewards are allowed; the UI doesn't surface them as a value proposition.
  // A regression dropping this op would let the default 50/50 HBD/HP split apply
  // to continuations. See edit.js:998-1006 (canonical shape) and publish.js:887-895
  // (publish-side parity).
  expect(commentBody.parent_author).toBe('');
  const meta = JSON.parse(commentBody.json_metadata);
  expect(meta[APP_TAG].version).toBeGreaterThan(1);
  expect(meta[APP_TAG].continues).toBeTruthy();
  expect(meta[APP_TAG].continues.author).toBe(paper.author);
  expect(meta[APP_TAG].continues.permlink).toBe(paper.permlink);
  const optionsOp = broadcast.operations.find((op) => op[0] === 'comment_options');
  expect(optionsOp).toBeTruthy();
  expect(optionsOp[1].percent_hbd).toBe(0);
});

test('no-changes guard blocks the broadcast and surfaces an error step', async ({
  page,
  request,
}) => {
  // edit.js:handleSubmit (the in-place edit branch) sets step='error' with
  // errorMessage='edit.noChanges' and returns without broadcasting when
  // title + body + abstract + metadata + addressed-reviews are all
  // unchanged from prefill. A regression that broadened or removed this
  // guard (allowing a no-op broadcast) would not be caught by the other
  // tests, all of which deliberately mutate fields before submit.
  const researcher = await pickAccreditedResearcher(request);
  if (!researcher) throw new Error('expected at least one accredited researcher in HAF');

  const PERMLINK = uniquePermlink('e2e-edit-nochange');
  const paper = buildPaperFixture({ author: researcher.username, permlink: PERMLINK });

  await installPaperMocks(page, { paper });
  await seedAccreditedSession(page, {
    username: researcher.username,
    accreditation: researcher.accreditation,
  });
  await clearDraft(page, paper.author, paper.permlink);

  await page.goto(`/en/edit/${paper.author}/${paper.permlink}`);

  await page.waitForSelector('[x-data="editPage"]');
  await expect(page.locator('input#edit-title')).toBeVisible();

  // Wait for editors to finish mounting, then re-stamp Alpine state from
  // the SAME _originalBody the submit handler will diff against. This
  // pins data.abstract/data.body exactly (via setEditorContent's
  // emitUpdate:false path) so any markdown round-trip jitter from the
  // Tiptap initial render cannot perturb the no-changes equality check.
  await waitForEditorsMounted(page);
  const { abstract: prefilledAbstract, body: prefilledBody } = await page.evaluate(() => {
    const el = document.querySelector('[x-data="editPage"]');
    const data = window.Alpine.$data(el);
    // Snapshot the prefill values that _originalBody was computed from in
    // _prefillForm — what the submit handler will compare new state to.
    return { abstract: data.abstract, body: data.body };
  });
  await setEditorContent(page, { abstract: prefilledAbstract, body: prefilledBody });

  // Submit without modifying ANYTHING.
  await page.locator('form button[type="submit"]').click();

  // The step state machine should land on 'error' and the broadcast stub
  // should never have been called. Poll the step value to allow the
  // submit handler to walk through 'diffing' → 'error' synchronously.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.querySelector('[x-data="editPage"]');
          return window.Alpine?.$data(el)?.step;
        }),
      { timeout: 5_000 },
    )
    .toBe('error');

  const errorMessage = await page.evaluate(() => {
    const el = document.querySelector('[x-data="editPage"]');
    return window.Alpine?.$data(el)?.errorMessage;
  });
  // edit.js:1045 sets errorMessage = this.$t('edit.noChanges'), so the
  // resolved translation lands in the data property (not the key). Test
  // navigates to /en/, so we pin against the en.json string for the key
  // — substring match keeps the assertion robust to en.json copy edits
  // that don't change the user-visible meaning.
  expect(errorMessage).toContain('No changes');

  // No broadcast may have fired.
  const broadcastCount = await page.evaluate(
    () => window.__pevoBroadcastCalls?.length || 0,
  );
  expect(broadcastCount).toBe(0);
});

test('non-head edit target (own post no longer chain head) broadcasts full body, not a diff', async ({
  page,
  request,
}) => {
  // edit.js:1051-1055 — when the current user's own post in the chain
  // (userPostInChain) is NOT the chain head, edit.js broadcasts the FULL
  // new body rather than a diff-match-patch text. The previous tests
  // always set head_author/head_permlink equal to paper.author/permlink,
  // so targetIsHead === true and only the diff branch was exercised.
  // This test pins the full-body branch by building a fixture where
  // (a) the seeded researcher authored a continuation that USED to be
  // the chain head, and (b) a later continuation by a different author
  // is now the head.
  const researcher = await pickAccreditedResearcher(request);
  if (!researcher) throw new Error('expected at least one accredited researcher in HAF');

  // The researcher's own (non-head) post — this is what they will edit.
  const OWN_PERMLINK = uniquePermlink('e2e-edit-nonhead-own');
  // A later continuation, by a different synthetic author, that is now
  // the chain head.
  const HEAD_AUTHOR = `headauth${Date.now().toString(36)}`;
  const HEAD_PERMLINK = uniquePermlink('e2e-edit-nonhead-head');
  if (HEAD_AUTHOR === researcher.username) {
    throw new Error('synthetic head author collided with seeded researcher');
  }

  // buildPaperFixture builds a single-version paper. Re-shape it for a
  // 2-version chain where paper.author is still the researcher (the
  // edit route targets researcher.username), but head_author/head_permlink
  // point at the later continuation, and versions[] lists both posts so
  // userPostInChain finds the researcher's entry.
  const base = buildPaperFixture({ author: researcher.username, permlink: OWN_PERMLINK });
  const paper = {
    ...base,
    head_author: HEAD_AUTHOR,
    head_permlink: HEAD_PERMLINK,
    versions: [
      { version_number: 1, author: researcher.username, permlink: OWN_PERMLINK },
      { version_number: 2, author: HEAD_AUTHOR, permlink: HEAD_PERMLINK },
    ],
  };

  await installPaperMocks(page, { paper });
  await seedAccreditedSession(page, {
    username: researcher.username,
    accreditation: researcher.accreditation,
  });
  await clearDraft(page, paper.author, paper.permlink);

  await page.goto(`/en/edit/${paper.author}/${paper.permlink}`);

  await page.waitForSelector('[x-data="editPage"]');
  await expect(page.locator('input#edit-title')).toBeVisible();

  const NEW_TITLE = 'Non-Head Target Edit';
  const NEW_ABSTRACT = 'Updated abstract while a later continuation holds the chain head.';
  const NEW_BODY = '## Introduction\n\nUpdated body for the non-head-target full-body branch.';

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
  const commentOp = broadcast.operations.find((op) => op[0] === 'comment');
  expect(commentOp).toBeTruthy();
  const [, commentBody] = commentOp;

  // Target is the researcher's own post (non-head), NOT the chain head.
  expect(commentBody.author).toBe(researcher.username);
  expect(commentBody.permlink).toBe(OWN_PERMLINK);
  expect(commentBody.author).not.toBe(HEAD_AUTHOR);
  expect(commentBody.permlink).not.toBe(HEAD_PERMLINK);

  // Full-body branch: the broadcast body is the composed post (abstract +
  // separator + body), not a diff-match-patch text. diff-match-patch
  // patches start with `@@` headers; a full body starts with the
  // `## Abstract\n\n` prefix from composePostBody.
  expect(commentBody.body.startsWith('## Abstract\n\n')).toBe(true);
  expect(commentBody.body).toContain(NEW_ABSTRACT);
  expect(commentBody.body).toContain(NEW_BODY);
  expect(commentBody.body.startsWith('@@')).toBe(false);

  // In-place edit (not continuation): same permlink as the user's own post
  // in the chain. The json_metadata MUST NOT carry a `continues` pointer.
  const meta = JSON.parse(commentBody.json_metadata);
  expect(meta[APP_TAG].continues).toBeUndefined();
});
