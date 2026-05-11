/**
 * E2E real-path companion for `frontend/tests/unit/lib-accredited-directory.test.js`,
 * filed under root CLAUDE.md "Carve-out for deterministic edge-case coverage"
 * clause (c). The unit file mocks `fetchAccreditations` to pin directory shape,
 * concurrent-rejection coalescing, and malformed-row handling. This spec
 * exercises the same risk class through the integrated stack:
 *
 *   fetchAccreditations → loadAccreditedDirectory → applyHiveChangePrefill
 *                       → publish/edit form prefill + lock + badge
 *                       → broadcast json_metadata.authors[].orcid
 *
 * A mutation in `frontend/src/api.js#fetchAccreditations`, the
 * `/api/accreditations` route shape, or the publish/edit page's
 * `_loadAccreditedDirectory` wiring is caught here by a different mutation
 * class than the unit file already catches.
 *
 * Why two accredited fixtures: the unit tests cover lookup/prefill semantics
 * with synthetic directories; integrated behavior requires the live
 * `/api/accreditations` response. We pull two accredited researchers from HAF
 * (A as logged-in user, B as the co-author whose ORCID prefills).
 *
 * Keychain broadcast capture mirrors `publish.spec.js` and
 * `edit-paper.spec.js` — `window.__pevoBroadcastCalls` lets us assert the
 * assembled `comment` op shape without the tx ever leaving the browser.
 */

import { test, expect } from './fixtures/keychain.js';
import {
  seedAccreditedSession,
  minimalPdfBuffer,
} from './fixtures/auth.js';

// SEC-002 (matches publish.spec.js): minted JWTs end up in localStorage; do
// not retain traces/videos.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const APP_TAG = 'pevotest';

// Pick two distinct accredited researchers (A, B) from HAF with non-empty
// ORCIDs. Without an ORCID on B, scenario (1) "ORCID prefilled to B's ORCID"
// has no value to assert against. Mirrors the retry shape of
// `pickAccreditedResearcher` in fixtures/auth.js — HAF reads can flake under
// concurrent worker load.
async function pickTwoAccreditedResearchersWithOrcid(request) {
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const listResp = await request.get('/api/accreditations?limit=20');
      if (listResp.ok()) {
        const list = (await listResp.json()).data || [];
        const found = [];
        for (const r of list) {
          if (!r.username || !r.orcid) continue;
          const statusResp = await request.get(
            `/api/accreditations/${encodeURIComponent(r.username)}`,
          );
          if (!statusResp.ok()) continue;
          const status = (await statusResp.json()).data;
          if (!status?.is_accredited) continue;
          found.push({
            username: status.username,
            accreditation: status.accreditation,
            orcid: r.orcid,
          });
          if (found.length === 2) return found;
        }
      }
    } catch {
      // swallow and retry — same posture as pickAccreditedResearcherOnce
    }
    if (attempt < attempts - 1) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}

// Build a deterministic non-accredited handle. The accredited directory caps
// at 200 rows; a timestamp suffix makes collision astronomically improbable.
function makeNonAccreditedHandle() {
  return `nonaccr${Date.now().toString(36)}`;
}

// Wait for the publish/edit page's `_loadAccreditedDirectory()` to populate
// Alpine state. The directory load is fire-and-forget from init(), so the
// form renders before it resolves; assertions on prefill/lock would race
// without this gate.
async function waitForAccreditedDirectoryLoaded(page, xDataSelector) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      const data = window.Alpine?.$data(el);
      return !!data && Object.keys(data.accreditedDirectory || {}).length > 0;
    },
    xDataSelector,
  );
}

// The hive input on each co-author row is the only `<input list="...">` in
// the section, so an indexed `input[list="pevo-accredited-usernames"]`
// locator uniquely identifies row N's hive input. The adjacent ORCID input
// follows it as a sibling in the same grid (see publish.js:179-198 /
// edit.js:198-218).
function hiveInputForRow(page, rowIdx) {
  return page.locator('input[list="pevo-accredited-usernames"]').nth(rowIdx);
}

function orcidInputForRow(page, rowIdx) {
  return hiveInputForRow(page, rowIdx).locator('xpath=following-sibling::input[1]');
}

const ACCREDITED_BADGE_TEXT = 'ORCID is bound to the accredited Hive account.';

// ─────────────────────────────────────────────────────────────────────────
// PUBLISH FORM — scenarios 1, 2, 3 (UI states only, no broadcast)
// ─────────────────────────────────────────────────────────────────────────

test('publish form: accredited co-author prefills+locks ORCID; non-accredited stays editable; accredited→non-accredited transition clears ORCID', async ({
  page,
  request,
}) => {
  const pair = await pickTwoAccreditedResearchersWithOrcid(request);
  if (!pair) {
    throw new Error(
      'expected at least two accredited researchers with non-empty ORCIDs in HAF',
    );
  }
  const [A, B] = pair;
  const NON_ACCREDITED = makeNonAccreditedHandle();

  await seedAccreditedSession(page, {
    username: A.username,
    accreditation: A.accreditation,
  });

  // Clear any draft from a previous run so prefill assertions read fresh
  // state (matches publish.spec.js).
  await page.addInitScript(() => {
    window.localStorage.removeItem('pevo-draft-publish');
  });

  await page.goto('/en/publish');
  await page.waitForSelector('[x-data="publishPage"]');
  await expect(page.locator('input#paper-title')).toBeVisible();

  await waitForAccreditedDirectoryLoaded(page, '[x-data="publishPage"]');

  // ─── Scenario 1: hive=B → prefill + lock + badge ──────────────────────
  await page.locator('button:has-text("Add Co-Author")').click();
  // Fill via the actual input so updateCoAuthor's onInput path runs (which is
  // what triggers applyHiveChangePrefill). Bypassing through Alpine state
  // would silently skip that integration.
  await hiveInputForRow(page, 0).fill(B.username);

  await expect(orcidInputForRow(page, 0)).toHaveValue(B.orcid);
  await expect(orcidInputForRow(page, 0)).toBeDisabled();
  // Badge: rendered only when isCoAuthorAccredited(i). One co-author so far,
  // so the page should show exactly one accredited badge.
  await expect(page.locator(`text=${ACCREDITED_BADGE_TEXT}`)).toHaveCount(1);

  // ─── Scenario 2: hive=<non-accredited> → editable, no badge ───────────
  await page.locator('button:has-text("Add Co-Author")').click();
  await hiveInputForRow(page, 1).fill(NON_ACCREDITED);

  await expect(orcidInputForRow(page, 1)).toBeEnabled();
  await expect(orcidInputForRow(page, 1)).toHaveValue('');
  // Still exactly one badge — row 1 is non-accredited.
  await expect(page.locator(`text=${ACCREDITED_BADGE_TEXT}`)).toHaveCount(1);

  // ─── Scenario 3: row 0 hive B → non-accredited clears ORCID ────────────
  await hiveInputForRow(page, 0).fill(NON_ACCREDITED + 'two');

  await expect(orcidInputForRow(page, 0)).toBeEnabled();
  // applyHiveChangePrefill clears ORCID when the new hive is not in the
  // directory (case 3 in lib/accredited-directory.js).
  await expect(orcidInputForRow(page, 0)).toHaveValue('');
  // No badges should remain.
  await expect(page.locator(`text=${ACCREDITED_BADGE_TEXT}`)).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────────────────
// PUBLISH FORM — scenario 4 (broadcast carries B's ORCID)
// ─────────────────────────────────────────────────────────────────────────

test('publish broadcast carries accredited co-author ORCID in json_metadata.authors[]', async ({
  page,
  request,
}) => {
  const pair = await pickTwoAccreditedResearchersWithOrcid(request);
  if (!pair) {
    throw new Error(
      'expected at least two accredited researchers with non-empty ORCIDs in HAF',
    );
  }
  const [A, B] = pair;

  await seedAccreditedSession(page, {
    username: A.username,
    accreditation: A.accreditation,
  });
  await page.addInitScript(() => {
    window.localStorage.removeItem('pevo-draft-publish');
  });

  // Capture the IPFS upload response so we can assert the broadcast metadata
  // carries the same CID (mirrors publish.spec.js).
  const uploadResponsePromise = page.waitForResponse(
    (resp) => resp.url().endsWith('/api/ipfs/upload') && resp.request().method() === 'POST',
  );

  await page.goto('/en/publish');
  await page.waitForSelector('[x-data="publishPage"]');
  await expect(page.locator('input#paper-title')).toBeVisible();
  await waitForAccreditedDirectoryLoaded(page, '[x-data="publishPage"]');

  // Required form text inputs.
  await page.locator('input[x-model="title"]').fill('E2E Co-author ORCID Prefill Paper');
  await page.locator('input[x-model="authorName"]').fill(
    A.accreditation?.name || 'Primary Author',
  );
  await page.locator('input[x-model="keywordsText"]').fill('e2e, prefill');

  // Abstract/body/discipline/citations via Alpine state — same indirection
  // as publish.spec.js (Tiptap is awkward to drive by keystrokes and not
  // part of the assertion surface here).
  await page.evaluate(
    ({ abstract, body, discipline }) => {
      const el = document.querySelector('[x-data="publishPage"]');
      const data = window.Alpine.$data(el);
      data.abstract = abstract;
      data.body = body;
      data.discipline = discipline;
      data.disciplineSearch = discipline;
    },
    {
      abstract: 'Abstract for the co-author ORCID prefill E2E paper.',
      body: '## Introduction\n\nBody for the co-author ORCID prefill E2E paper.',
      discipline: 'Computer Science',
    },
  );

  // Add accredited co-author B. publish.js filters coAuthors by `ca.name`
  // before serializing (publish.js:814), so the row must have a name to
  // appear in the broadcast.
  await page.locator('button:has-text("Add Co-Author")').click();
  await page.locator('input[placeholder="Full name"]').last().fill('Co Author B');
  await hiveInputForRow(page, 0).fill(B.username);
  await expect(orcidInputForRow(page, 0)).toBeDisabled();
  await expect(orcidInputForRow(page, 0)).toHaveValue(B.orcid);

  // Real PDF round-trip to IPFS (same as publish.spec.js).
  await page.locator('input#pdf-upload').setInputFiles({
    name: 'coauthor-prefill.pdf',
    mimeType: 'application/pdf',
    buffer: minimalPdfBuffer(),
  });

  await page.locator('form button[type="submit"]').click();

  const uploadResp = await uploadResponsePromise;
  expect(uploadResp.status()).toBe(200);

  await expect
    .poll(() => page.evaluate(() => window.__pevoBroadcastCalls?.length || 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  const broadcast = await page.evaluate(() => window.__pevoBroadcastCalls[0]);
  const commentOp = broadcast.operations.find((op) => op[0] === 'comment');
  expect(commentOp, 'operations should include a comment op').toBeTruthy();
  const meta = JSON.parse(commentOp[1].json_metadata);

  // The published authors array is [primary, ...coAuthors-with-name]. Find
  // B's row and verify its ORCID matches the accreditation directory's
  // ORCID, not whatever the user might have typed (which they couldn't
  // anyway — the input was disabled).
  const authors = meta[APP_TAG].authors;
  expect(Array.isArray(authors)).toBe(true);
  const rowB = authors.find((a) => a.hive === B.username);
  expect(rowB, `authors[] should include the co-author with hive=${B.username}`)
    .toBeTruthy();
  expect(rowB.orcid).toBe(B.orcid);
});

// ─────────────────────────────────────────────────────────────────────────
// EDIT FORM — scenario 5
// ─────────────────────────────────────────────────────────────────────────

function envelope(data) {
  return { status: 'ok', data };
}

// Mirrors the paper-mock harness from edit-paper.spec.js. Kept inline rather
// than imported because that file does not export its helpers and the
// fixture is small.
async function installPaperMocks(page, { paper, reviews = [], claims = [] }) {
  const paperPath = `/api/papers/${encodeURIComponent(paper.author)}/${encodeURIComponent(paper.permlink)}`;

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

test('edit form: existing co-author with accredited hive stays disabled; new co-author row prefills, locks, and clears on transition', async ({
  page,
  request,
}) => {
  const pair = await pickTwoAccreditedResearchersWithOrcid(request);
  if (!pair) {
    throw new Error(
      'expected at least two accredited researchers with non-empty ORCIDs in HAF',
    );
  }
  const [A, B] = pair;

  // Fixture paper authored by A with B already listed as an existing
  // co-author. The "existing" row's ORCID is whatever was published; we
  // assert the input renders disabled regardless of whether B happens to be
  // accredited today (the existing-authors template at edit.js:188-196
  // hardcodes `disabled`, independent of isNewCoAuthorAccredited).
  const PERMLINK = `e2e-coauthor-prefill-${Date.now().toString(36)}`;
  const EXISTING_B_ORCID_ON_POST = '0000-9999-9999-9999';
  const paper = {
    author: A.username,
    permlink: PERMLINK,
    title: 'Existing Paper For Co-author Prefill E2E',
    body:
      '## Abstract\n\nOriginal abstract for the edit prefill E2E.\n\n---\n\n' +
      '## Introduction\n\nOriginal body.',
    authors: [
      { name: 'Primary', hive: A.username, orcid: '', affiliation: '' },
      // Note: the post records an ORCID that DIFFERS from B's current
      // accreditation ORCID. The existing-row UI must show the recorded
      // value verbatim and keep the input disabled — it must NOT
      // retroactively "fix" the on-chain row with B's current ORCID.
      { name: 'Co Author B', hive: B.username, orcid: EXISTING_B_ORCID_ON_POST, affiliation: '' },
    ],
    head_author: A.username,
    head_permlink: PERMLINK,
    canonical_author: A.username,
    canonical_permlink: PERMLINK,
    json_metadata: {
      app: `${APP_TAG}/0.1.0`,
      [APP_TAG]: {
        type: 'paper',
        version: 1,
        discipline: 'Computer Science',
        keywords: ['e2e'],
        authors: [
          { name: 'Primary', hive: A.username, orcid: '', affiliation: '' },
          { name: 'Co Author B', hive: B.username, orcid: EXISTING_B_ORCID_ON_POST, affiliation: '' },
        ],
        citations: [],
      },
    },
    versions: [{ version_number: 1, author: A.username, permlink: PERMLINK }],
    authorship_claims: [],
  };

  await installPaperMocks(page, { paper });
  await seedAccreditedSession(page, {
    username: A.username,
    accreditation: A.accreditation,
  });
  await page.addInitScript(
    ({ key }) => {
      window.localStorage.removeItem(key);
    },
    { key: `pevo-draft-edit-${paper.author}-${paper.permlink}` },
  );

  await page.goto(`/en/edit/${paper.author}/${paper.permlink}`);
  await page.waitForSelector('[x-data="editPage"]');
  await expect(page.locator('input#edit-title')).toBeVisible();

  await waitForAccreditedDirectoryLoaded(page, '[x-data="editPage"]');

  // ─── Existing co-author B's ORCID input stays disabled ────────────────
  // The existing-authors block has no `list=` attribute on its hive input
  // (see edit.js:189-195). We locate by the existing row container and
  // verify the ORCID input renders the recorded value and is disabled.
  // edit.js renders existingCoAuthors as the FIRST set of rows; in this
  // fixture there's exactly one existing co-author (slice(1) of authors).
  // Inputs in that row sit inside an `.opacity-75` grid container.
  const existingRow = page.locator('div.opacity-75').first();
  await expect(existingRow).toBeVisible();
  // The grid renders 4 disabled inputs (name, hive, orcid, affiliation).
  const existingInputs = existingRow.locator('input');
  await expect(existingInputs).toHaveCount(4);
  // ORCID is the 3rd input (index 2).
  await expect(existingInputs.nth(2)).toBeDisabled();
  await expect(existingInputs.nth(2)).toHaveValue(EXISTING_B_ORCID_ON_POST);

  // ─── New co-author row: hive=B → prefill + lock + badge ───────────────
  await page.locator('button:has-text("Add Co-Author")').click();
  // hiveInputForRow scopes by `input[list="pevo-accredited-usernames"]`,
  // which is only set on newCoAuthors rows — existing rows do not have the
  // attribute, so nth(0) correctly addresses the first newCoAuthors row.
  await hiveInputForRow(page, 0).fill(B.username);

  await expect(orcidInputForRow(page, 0)).toHaveValue(B.orcid);
  await expect(orcidInputForRow(page, 0)).toBeDisabled();
  await expect(page.locator(`text=${ACCREDITED_BADGE_TEXT}`)).toHaveCount(1);

  // ─── New co-author row: transition B → non-accredited clears ORCID ────
  const NON_ACCREDITED = makeNonAccreditedHandle();
  await hiveInputForRow(page, 0).fill(NON_ACCREDITED);

  await expect(orcidInputForRow(page, 0)).toBeEnabled();
  await expect(orcidInputForRow(page, 0)).toHaveValue('');
  await expect(page.locator(`text=${ACCREDITED_BADGE_TEXT}`)).toHaveCount(0);
});
