/**
 * Shared paper-route mocking helpers for E2E specs that drive
 * `/edit/:author/:permlink` or otherwise rely on a deterministic
 * `/api/papers/:author/:permlink` response shape.
 *
 * Originally duplicated verbatim across `edit-paper.spec.js` and
 * `coauthor-accredited-prefill.spec.js`. Extracted here so the non-obvious
 * Playwright route-dispatch-order rationale (see `installPaperMocks` below)
 * lives in exactly one place and the two specs cannot drift.
 */

/**
 * Wrap arbitrary data in the standard PEvO `{ status, data }` API envelope so
 * fulfilled routes match the shape `frontend/src/api.js` expects.
 */
export function envelope(data) {
  return { status: 'ok', data };
}

/**
 * Install `page.route` handlers covering the three paper-related endpoints
 * the edit page reads on load (`/api/papers/:a/:p`, `/enrichment`,
 * `/invalidate`), plus the paper-detail discussion read (`/comments`) when a
 * `comments` array is supplied.
 *
 * Why mocked paper data: the edit page reads `head_author/head_permlink`,
 * `authors[].hive`, and the existing `pevo` json_metadata block to decide
 * `isAuthorized` / `isContinuation`. Pinning those fields against a real
 * HAF-indexed paper means the spec assertions drift whenever HAF content
 * changes. Mocking the routes lets each scenario control the exact
 * authorship/review shape it asserts on.
 *
 * Playwright dispatches page.route matches in REVERSE registration order
 * (most-recently-registered first), with route.fallback() walking back
 * through earlier handlers. So we register the suffix-specific handlers
 * (enrichment, invalidate) FIRST and the bare paper route LAST. At runtime
 * the bare matcher fires first; for /enrichment and /invalidate URLs its
 * else-branch calls route.fallback(), which then resolves to the
 * earlier-registered specific handlers below. Re-ordering these without
 * adjusting the fallback dispatch causes silent test breakage where the
 * suffix routes never reach their handler.
 */
export async function installPaperMocks(page, { paper, reviews = [], claims = [], comments = null }) {
  const paperPath = `/api/papers/${encodeURIComponent(paper.author)}/${encodeURIComponent(paper.permlink)}`;

  // Optional discussion stub. Registered FIRST so the bare paper route below
  // (registered last, dispatched first) reaches it through route.fallback()
  // for `/comments` URLs; when omitted, those URLs fall through to the real
  // backend as before.
  if (comments !== null) {
    await page.route(`**${paperPath}/comments**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope(comments)),
      });
    });
  }

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

/**
 * Build a `/api/papers/:author/:permlink` response shape for the paper-detail
 * page: the fields the page reads to decide which authorship affordances to
 * render (`authors[].hive` / `.consented`, `head_*`, `authorship_claims`) plus
 * the metadata block. Shared by the specs that drive paper-detail against a
 * deterministic authorship shape.
 */
export function buildPaper({
  author,
  permlink,
  authors,
  claims = [],
  title = 'E2E Paper Detail Fixture',
  appTag = 'pevotest',
}) {
  const pevoMeta = { type: 'paper', version: 1, discipline: 'Computer Science', keywords: ['testing'], authors, citations: [] };
  return {
    author,
    permlink,
    title,
    body: '## Abstract\n\nDeterministic paper-detail fixture.',
    authors,
    accredited_authors: authors.filter((a) => a.hive).map((a) => a.hive),
    head_author: author,
    head_permlink: permlink,
    canonical_author: author,
    canonical_permlink: permlink,
    created: '2026-06-01T00:00:00.000Z',
    net_votes: 0,
    vote_strength: 'normal',
    voters: [],
    citation_count: 0,
    review_count: 0,
    json_metadata: { app: `${appTag}/0.1.0`, [appTag]: pevoMeta },
    versions: [{ version_number: 1, author, permlink, created: '2026-06-01T00:00:00.000Z' }],
    authorship_claims: claims,
  };
}

/**
 * Keep the boot-time authed GETs a connected session fires deterministic:
 * the pending-authorships store (which the Route-2 accept affordance gates
 * on), the notifications poll, and the accreditation-status poll the auth
 * store runs for the seeded username. None of these is the surface a
 * paper-detail write spec asserts on; stubbing them keeps HAF out of the
 * page load.
 */
export async function installAuthedBootMocks(
  page,
  { pendingConsents = [], pendingClaims = [], accreditationName = 'E2E Researcher' } = {},
) {
  await page.route('**/api/me/authorships/pending', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope({ pending_consents: pendingConsents, pending_claims: pendingClaims })),
    }),
  );
  await page.route('**/api/notifications**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope({ events: [], latest_block: 0, has_more: false })),
    }),
  );
  await page.route('**/api/accreditations/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope({ is_accredited: true, accreditation: { name: accreditationName } })),
    }),
  );
}
