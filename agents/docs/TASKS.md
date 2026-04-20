# PEvO Task Board

Pending tasks assigned by the Architect. Each agent **must check this file before starting work** and pick up any task assigned to them.

When a task is complete, the implementing agent moves it to a **Review** section (not Done). The **Architect** reviews the implementation against the spec and physically moves it to `agents/docs/tasks-archive.md`. Do NOT use strikethrough to mark tasks done here. Completed tasks must be removed from this file entirely.

Review history: `agents/docs/tasks-archive.md`

---

## On Hold

### BLOG-1 — Write launch blog post series (Architect + User)

**Goal:** Publish blog posts for the beta launch via the `pevo.science` Hive account with `pevo-blog` parent permlink. Published via HiveComb; PEvO blog section picks them up automatically.

**Track A — Why (the problems, the vision)**
1. The Long Road to Open Science
2. Open Access Isn't Enough — Where You Store It Matters
3. Rethinking Scientific Reputation
4. Open Evaluation Under Pressure
5. ~~Why PEvO, Why Now~~ — **published 2026-04-15** — `@pevo.science/publish-and-evaluate-openly-pevo-science-open-beta-officially-launched` (draft: `agents/docs/blog/why-pevo-why-now.md`)

**Track B — How (deep dives into PEvO mechanics)**
6. How Publishing Works on PEvO
7. The Reputation Algorithm Explained
8. Anonymous Review Without Losing Accountability
9. Accreditation — Verifying Scientists Without a Gatekeeper
10. Light Accounts — Zero-Friction Onboarding
11. The Preprint Bridge — Bringing arXiv/bioRxiv Into the Conversation
12. Community Pinning — How Anyone Can Help Host Science
13. Why Hive? The Infrastructure Behind PEvO

**Suggested sequence for remaining posts:**
1. "How Publishing Works on PEvO" (next)
2. "The Long Road to Open Science" (week 1)

---

## Pending

---

### UI-REFAC-1 — Establish shared-fragment convention + extract paper-card article (UI Agent)

**Goal:** Pick a convention for sharing HTML fragments between pages, and apply it to the `<article class="card">` paper-card markup that's currently duplicated across 5 list pages.

**Convention (applies to all future components):**
- Shared HTML fragments are exported as template-literal string constants from `frontend/src/components/<name>.js`: `export const fooTemplate = \`...\``.
- Pages import and interpolate: `import { fooTemplate } from '../components/foo.js'; const template = \`...\${fooTemplate}...\`;`.
- If the fragment has its own state, the same file also registers `Alpine.data('foo', () => ({...}))` and exports `initFoo()` for `main.js`. Purely presentational fragments (data comes from parent x-for / scope) skip the factory.
- Add a short header comment at the top of `components/paper-card.js` documenting the convention so future components follow it. No new doc files.

**Actions:**
- Add `paperCardTemplate` export to [components/paper-card.js](frontend/src/components/paper-card.js) (the file already exists with `truncateText`, `formatDate` helpers — same home).
- The fragment is the full `<article class="card hover:shadow-sm transition-shadow">...</article>` block: discipline/source badge + date, title, authors (with accreditation badge), abstract preview, keywords, metrics row (votes, reviews, citations, PDF indicator).
- Replace the inline copies in [home.js](frontend/src/pages/home.js), [papers.js](frontend/src/pages/papers.js), [paper-detail.js](frontend/src/pages/paper-detail.js), [profile.js](frontend/src/pages/profile.js), [search.js](frontend/src/pages/search.js) with `${paperCardTemplate}`.
- Verify each call site before replacing: if a page renders a meaningfully different card (e.g. omits a field, adds a badge), do not force-fit it. Leave that site alone and note it in the Review entry.

**Deliverable:** `paperCardTemplate` exported from `components/paper-card.js`; inline duplicates replaced in the pages above. Move to Review when done.

---

### UI-REFAC-2 — Extract paper-feed component (UI Agent)

**Depends on:** UI-REFAC-1 (uses `paperCardTemplate`)

**Goal:** Remove the ~170-line duplication between [home.js](frontend/src/pages/home.js) and [papers.js](frontend/src/pages/papers.js). The authenticated-user paper feed on home.js and the entire papers.js body are character-for-character identical except for three filter `<label for="...">` id attributes.

**Actions:**
- Create `frontend/src/components/paper-feed.js`:
  - Export `paperFeedTemplate` — the filters row + loading skeleton + error + empty state + card list (via `${paperCardTemplate}`) + pagination block.
  - Register `Alpine.data('paperFeed', () => ({...}))` owning all state (`papers`, `disciplines`, `discipline`, `sortBy`, `sourceFilter`, `currentPage`, `totalPages`, `loading`, `error`) and methods (`init`, `loadPapers`, `loadDisciplines`, `onDisciplineChange`, `onSortChange`, `onSourceChange`, `goToPage`, `paginationPages` getter, `navigate`). Exposes `truncateText`, `formatDate` on the scope so the card template can use them.
  - Export `initPaperFeed()`; wire it into `main.js`.
- Update [home.js](frontend/src/pages/home.js): keep the unauthenticated landing block and the authenticated hero. The authenticated paper-feed section becomes `<div x-data="paperFeed">${paperFeedTemplate}</div>`. Remove the `homePage` Alpine.data feed state that now lives in `paperFeed`.
- Update [papers.js](frontend/src/pages/papers.js): becomes a thin wrapper — page title + `<div x-data="paperFeed">${paperFeedTemplate}</div>`. `initPapersPage()` can stay empty or be deleted if nothing else imports it.
- Pick one stable id prefix inside the shared template (e.g. `paper-feed-discipline`). Both pages rendering the fragment means only one instance exists per route, so id collisions aren't a concern.

**Deliverable:** `components/paper-feed.js` consumed by home.js and papers.js. Move to Review when done.

---

### UI-REFAC-3 — Wire the pagination Alpine factory (UI Agent)

**Depends on:** UI-REFAC-2 (convention established)

**Goal:** The `Alpine.data('pagination', ...)` factory in [components/pagination.js](frontend/src/components/pagination.js) is defined but not imported anywhere — every list page hand-rolls the same `paginationPages` getter and nav markup. Replace with the shared factory + template.

**Actions:**
- Add `paginationTemplate` export to [components/pagination.js](frontend/src/components/pagination.js) — the `<nav class="flex items-center justify-center gap-1 mt-8">...</nav>` block.
- Register `initPagination` from `main.js` (currently unwired).
- Replace the inline pagination blocks in [search.js](frontend/src/pages/search.js) and [researchers.js](frontend/src/pages/researchers.js) with `<div x-data="pagination(totalPages, currentPage, (p) => loadX(p))">${paginationTemplate}</div>`.
- Inside `paper-feed.js` (from UI-REFAC-2), use the same factory + template instead of the inline pagination. Remove the duplicated `paginationPages` getter from the `paperFeed` Alpine.data.

**Deliverable:** All list pages use the shared `pagination` factory + template; no page defines its own `paginationPages` getter. Move to Review when done.

---

### E2E test suite expansion (UI Agent)

**Shared constraints for all E2E-* tasks below:**
- No writes to the Hive chain. Keychain is stubbed via `frontend/tests/e2e/fixtures/keychain.js`. For flows that would broadcast, intercept the outgoing `broadcast`/signed-request call and assert the payload shape — do not let it hit a real node.
- Real backend, real HAF, real Postgres (via `pevo_app_test`, truncated in global-setup). IPFS pinning through the backend proxy is OK.
- One spec file per task. Keep to the happy path; edge cases belong in unit tests.
- Follow the pattern in `frontend/tests/e2e/email-signup.spec.js` (Alpine `x-model` selectors, `waitForRequest`/`waitForResponse` for assertions).

---

### E2E-WRITE-2 — Review submission up to broadcast (UI Agent)

**Goal:** Verify a review submission produces the correct signed comment payload with structured ratings.

**Actions:**
- Log in as accredited reviewer. Navigate to an existing paper's review page.
- Fill structured ratings + free-text review.
- Intercept the broadcast; assert `json_metadata` carries the rating structure and parent author/permlink point to the paper being reviewed.

**Deliverable:** `frontend/tests/e2e/review-submit.spec.js`. Move to Review when done.

---

### E2E-WRITE-3 — Vote and comment up to broadcast (UI Agent)

**Goal:** Verify vote and threaded comment flows produce the correct signed operations.

**Actions:**
- On a seeded paper detail page, click upvote; intercept and assert the vote op (voter, author, permlink, weight).
- Post a top-level comment and a reply; intercept and assert parent author/permlink chain correctly.

**Deliverable:** `frontend/tests/e2e/vote-comment.spec.js`. Move to Review when done.

---

### E2E-AUTH-1 — Email+password login (UI Agent)

**Goal:** Verify the email+password login flow sets a valid session and redirects.

**Actions:**
- Seed a light-account user. Drive `/login`, submit credentials, assert redirect to the intended page and that a subsequent authenticated API call succeeds.
- Cover one negative case: wrong password shows the error toast (not a browser alert).

**Deliverable:** `frontend/tests/e2e/login-email.spec.js`. Move to Review when done.

---

### E2E-AUTH-2 — Keychain challenge login (UI Agent)

**Goal:** Verify the Keychain login flow (signing a challenge is not a chain write, so it's E2E-appropriate).

**Actions:**
- Configure the Keychain stub to return a valid signature for the challenge.
- Drive `/login`, pick Keychain path, assert backend returns a session and the UI lands authenticated.

**Deliverable:** `frontend/tests/e2e/login-keychain.spec.js`. Move to Review when done.

---

### E2E-AUTH-3 — Password recovery (UI Agent)

**Goal:** Verify the password recovery email flow end to end.

**Actions:**
- Seed a user. Drive `/recover` to request a reset, read the reset token from the test mail sink (or DB).
- Follow the reset link, submit a new password, log in with it.

**Deliverable:** `frontend/tests/e2e/password-recovery.spec.js`. Move to Review when done.

---

### E2E-ACCR-1 — Accreditation request + ORCID callback (UI Agent)

**Goal:** Verify a user can submit an accreditation request and complete the ORCID callback, producing a pending attestation.

**Actions:**
- Log in as an unaccredited user. Drive `/accreditation`: submit institutional email + ORCID.
- Simulate the ORCID redirect back to `/accreditation/verify` with a stubbed ORCID token response at the network layer.
- Assert the backend records a pending attestation and the UI reflects pending status.

**Deliverable:** `frontend/tests/e2e/accreditation.spec.js`. Move to Review when done.

---

### E2E-SETTINGS-1 — Settings changes without broadcast (UI Agent)

**Goal:** Verify non-chain settings flows (display prefs, email change request, email verification).

**Actions:**
- Log in as a light-account user. Toggle a display preference, assert it persists after reload.
- Request an email change; read the verification token from the mail sink; follow the verification link; assert the new email is active.

**Deliverable:** `frontend/tests/e2e/settings.spec.js`. Move to Review when done.

---

### E2E-CRYPTO-1 — Seed phrase generation and re-derivation (UI Agent)

**Goal:** Verify client-side BIP39 generation and key derivation are deterministic and correct.

**Actions:**
- Drive the signup seed-phrase step; capture the generated mnemonic via a test hook or by reading the on-screen words.
- On the recovery page, enter the same mnemonic; assert the derived public keys match what the signup flow posted to the backend.

**Deliverable:** `frontend/tests/e2e/seed-phrase.spec.js`. Move to Review when done.

---

### E2E-CRYPTO-2 — Light-to-self-custody UI up to key rotation (UI Agent)

**Goal:** Verify the upgrade flow collects the seed phrase, derives new keys, and reaches the confirm-rotation step — without broadcasting.

**Actions:**
- Log in as a light-account user. Drive the upgrade wizard: enter mnemonic, review derived keys, reach the final confirmation screen.
- Intercept the final broadcast (owner/active key rotation) and assert the payload shape. Do not let it hit the chain.

**Deliverable:** `frontend/tests/e2e/custody-upgrade.spec.js`. Move to Review when done.

---

### E2E-BRIDGE-1 — Preprint bridge preview (UI Agent)

**Goal:** Verify the arXiv/bioRxiv bridge fetches and previews metadata correctly.

**Actions:**
- Drive `/bridge`, paste a known arXiv and a known bioRxiv URL.
- Mock the external fetch at the network layer with canned responses; assert title, authors, abstract render in the preview.
- Stop before the publish step (that's covered by E2E-WRITE-1's pattern if needed).

**Deliverable:** `frontend/tests/e2e/bridge-preview.spec.js`. Move to Review when done.

---

## Review

_No tasks in review._

---
