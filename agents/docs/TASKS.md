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

### IPFS-DURABLE-TRACKING — Move pending-pin tracking from Redis to Postgres (Backend Agent)

**Goal:** Prevent permanent orphan pins on Kubo when Redis loses the `ipfs:pending:{cid}` tracking key. Current setup ([backend/src/routes/ipfs.ts](backend/src/routes/ipfs.ts), [backend/src/ipfs-cleanup.ts](backend/src/ipfs-cleanup.ts)) relies on Redis keys with a 24h TTL as the sole record of in-flight uploads. Redis is a cache — flushes, evictions, unclean shutdowns, or any backend outage longer than 24h drop the tracking key, and the cleanup job then has no way to discover the orphan on Kubo. The pin sits there forever.

**Context:**
- Upload flow: user POSTs to `/api/ipfs/upload` → backend pins to Kubo → writes `ipfs:pending:{cid}` to Redis with `EX 86400`.
- Cleanup job every 30 min: scans Redis for `ipfs:pending:*`, checks HAF for references, unpins if older than `MAX_AGE_MS` (24h) and not referenced.
- Redis also serves the download proxy's "is this CID known?" check. That role stays — Redis is fine as a cache; it's not fine as the only record.
- Scope: this fixes the prod/dev orphan risk against the `pevo_app` database. The E2E test teardown (IPFS-CLEANUP task above) is separate — tests use `pevo_app_test`, which this table will also exist in but test pins are cleaned up immediately by the teardown.

**Schema:** new table in `pevo_app`:

```sql
CREATE TABLE pending_ipfs_uploads (
  cid TEXT PRIMARY KEY,
  uploader_account TEXT NOT NULL,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON pending_ipfs_uploads (created_at);
```

Add as a new migration file (next number after `002_nullable_email.sql`).

**Actions:**
- Add the migration.
- In `/api/ipfs/upload`, after a successful Kubo pin, INSERT into `pending_ipfs_uploads` (ON CONFLICT DO NOTHING for idempotency). Keep the Redis write as a cache for the download proxy's known-CID check.
- In `ipfs-cleanup.ts`, change the scan: `SELECT cid, created_at FROM pending_ipfs_uploads WHERE created_at < NOW() - INTERVAL '24 hours'`. For each row, check HAF references (existing logic). If referenced → `DELETE FROM pending_ipfs_uploads WHERE cid = $1` and drop the Redis key. If not referenced → unpin from Kubo, then delete the DB row and Redis key.
- Download proxy's known-CID check: keep Redis-first, but on miss fall back to `SELECT 1 FROM pending_ipfs_uploads WHERE cid = $1` before returning 404. This makes the cache optional for correctness.
- Update [agents/docs/hive-schemas.md](agents/docs/hive-schemas.md) if it documents this flow, and the relevant `agents/docs/api-contracts/*.md` if the IPFS endpoint contract changes.

**Non-goals:**
- Do not remove Redis. It stays as a cache.
- Do not change `MAX_AGE_MS` or the 30-min scan cadence.
- No Kubo-pin-list reconciler. That's a separate follow-up safety net; out of scope here.

**Deliverable:** PR with migration, route change, cleanup job change, and any schema/contract doc updates. Move to Review when done.

---

### IPFS-CLEANUP — Unpin test-created CIDs in E2E teardown (UI Agent)

**Goal:** Make the E2E suite leave no IPFS pins behind, so test pins don't sit on the Kubo node for up to 24h waiting for the background cleanup job ([backend/src/ipfs-cleanup.ts](backend/src/ipfs-cleanup.ts), every 30 min, unpins HAF-unreferenced orphans older than 24h).

**Context:**
- E2E-WRITE-1 uploads files large enough to trigger IPFS pinning. Because the test intercepts the final Hive broadcast, the CID never lands in HAF, so the upload is always an orphan from HAF's point of view.
- Redis is shared with the dev stack (per the swap-in-place E2E topology). A blanket flush of `ipfs:pending:*` would unpin dev uploads too. Cleanup must be per-CID, scoped to CIDs the test run explicitly created.
- No backend endpoint is needed — teardown is Node and can talk to Kubo + Redis directly using the same env the backend uses (`IPFS_API_URL`, `REDIS_URL`).

**Actions:**
- In the E2E helpers, capture every CID returned from `/api/ipfs/upload` during a test run (e.g., via a Playwright response interceptor, or by wrapping the upload helper). Persist CIDs to a file that global-teardown can read (an in-memory `Set` won't survive across worker processes).
- In [frontend/tests/e2e/global-teardown.js](frontend/tests/e2e/global-teardown.js), for each captured CID:
  - Call Kubo directly at `${IPFS_API_URL}/api/v0/pin/rm?arg={cid}` using the same method/path as `ipfs-cleanup.ts`.
  - Delete the `ipfs:pending:{cid}` Redis key.
  - Log successes and failures. Do not fail the suite if an individual unpin errors — the 30-min cleanup job is still a safety net.
- Optionally also call the same cleanup in an `afterEach` within specs that upload, so an aborted run leaves less debris.

**Non-goals:**
- No test-only backend endpoint.
- No change to `MAX_AGE_MS`.
- No Redis flush.
- No cleanup for Pinata fallback — dev/CI runs against self-hosted Kubo.

**Deliverable:** PR wiring the teardown. Move to Review when done.

---

### E2E test suite expansion (UI Agent)

**Shared constraints for all E2E-* tasks below:**
- No writes to the Hive chain. Keychain is stubbed via `frontend/tests/e2e/fixtures/keychain.js`. For flows that would broadcast, intercept the outgoing `broadcast`/signed-request call and assert the payload shape — do not let it hit a real node.
- Real backend, real HAF, real Postgres (via `pevo_app_test`, truncated in global-setup). IPFS pinning through the backend proxy is OK.
- One spec file per task. Keep to the happy path; edge cases belong in unit tests.
- Follow the pattern in `frontend/tests/e2e/email-signup.spec.js` (Alpine `x-model` selectors, `waitForRequest`/`waitForResponse` for assertions).

---

### E2E-READ-1 — Paper list, filters, search (UI Agent)

**Goal:** Verify the paper browsing surface renders real HAF data correctly.

**Actions:**
- Seed at least one PEvO-tagged paper via fixture (direct DB insert into the test HAF schema, or reuse an existing seed helper if present).
- Drive `/papers` and `/search`: assert list renders, a discipline/tag filter narrows results, and search by title returns the seeded paper.
- Assert the paper card links to the correct detail URL.

**Deliverable:** `frontend/tests/e2e/papers-browse.spec.js`. Move to Review when done.

---

### E2E-READ-2 — Paper detail rendering (UI Agent)

**Goal:** Verify paper detail page renders reviews, comments, votes, and version history from HAF.

**Actions:**
- Seed a paper with at least one review, one comment, and one vote.
- Navigate to the detail page; assert body, metadata, reviews section, threaded comments, vote counts, and version list all render.

**Deliverable:** `frontend/tests/e2e/paper-detail.spec.js`. Move to Review when done.

---

### E2E-READ-3 — Profile and researcher directory (UI Agent)

**Goal:** Verify profile pages and the researcher directory render correctly against HAF + accreditation data.

**Actions:**
- Seed an accredited researcher with a published paper.
- Visit `/researchers`, assert the researcher appears. Click through to their profile, assert name, institution, publications, and reputation score render.

**Deliverable:** `frontend/tests/e2e/researchers.spec.js`. Move to Review when done.

---

### E2E-READ-4 — Blog pages (UI Agent)

**Goal:** Verify blog index and post pages render content from the `pevo.science` account via HiveComb.

**Actions:**
- Visit `/blog`, assert posts list renders. Click through to a post, assert title and body render.
- If live HAF calls are undesirable, mock only the HiveComb fetch at the network layer; keep the rest real.

**Deliverable:** `frontend/tests/e2e/blog.spec.js`. Move to Review when done.

---

### E2E-WRITE-1 — Publish flow up to broadcast (UI Agent)

**Goal:** Verify the publish flow assembles a valid Hive `comment` broadcast with correct `json_metadata`, without hitting the chain.

**Actions:**
- Log in as an accredited test user (fixture).
- Drive `/publish`: fill title, abstract, body, tags, citations. Upload a file large enough to trigger IPFS (real upload via backend pinning proxy).
- Intercept the Keychain broadcast call; assert the CID is in `json_metadata`, `app` equals `APP_TAG`, tags include `APP_TAG` and `science`, and the parent permlink is `APP_TAG`.

**Deliverable:** `frontend/tests/e2e/publish.spec.js`. Move to Review when done.

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
