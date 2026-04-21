# PEvO Task Board

Pending tasks assigned by the Architect. Each agent **must check this file before starting work** and pick up any task assigned to them.

When a task is complete, the implementing agent moves it to a **Review** section (not Done). The **Architect** reviews the implementation against the spec and physically moves it to `agents/docs/tasks-archive.md`. Do NOT use strikethrough to mark tasks done here. Completed tasks must be removed from this file entirely.

Review history: `agents/docs/tasks-archive.md`

---

## Notes for next session

- endpoint allows repeated sending of accreditation custom_json, shouldn't fire if data is identical to last, and rate limit harder
- check bridge rate limit - must be very conservative to prevent spam
- check anonymous review rate limit, that must be extremely conservative
- how to handle mass import of all papers of one orcid id (authenticated)
- gemini reply regarding orcid public works and attribution

---


## On Hold

### BLOG-1 — Write launch blog post series (Architect + User)

**Goal:** Publish blog posts for the beta launch via the `pevo.science` Hive account with `pevo-blog` parent permlink. Published via HiveComb; PEvO blog section picks them up automatically.

**Track A — Why (the problems, the vision)**
1. The Long Road to Open Science
2. Open Access Isn't Enough — Where You Store It Matters
3. Rethinking Scientific Reputation
4. Open Evaluation Under Pressure
5. Why PEvO, Why Now — **published 2026-04-15** — `@pevo.science/publish-and-evaluate-openly-pevo-science-open-beta-officially-launched` (draft: `agents/docs/blog/why-pevo-why-now.md`)

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

### SEC-AUTH-BYPASS — Add accreditation-authority filter to getExistingAccreditation (Backend Agent, URGENT P0)

**Surfaced by:** SEC-002 pair review (2026-04-21). Concrete exploit + 3 reviewers boosted confidence.

**Goal:** Close an actively-exploitable accreditation bypass. `backend/src/routes/orcid.ts:512-542` `getExistingAccreditation` lacks the `required_posting_auths ?| $authorities` filter that `findAccreditedAccountWithOrcid` already applies.

**Exploit:**
1. Attacker controls Hive account X (no prior accreditation).
2. X broadcasts `custom_json` with `id=pevotest, action='accredit', account='X'`, signed by X's own posting key (required_posting_auths: ['X']).
3. X authenticates to PEvO, calls `/api/orcid/start?mode=link`, completes ORCID OAuth for their own ORCID.
4. `handleLink` calls `getExistingAccreditation(X)` → finds the self-broadcast op (no filter) → returns non-null → 422 guard passes.
5. Admin posting key signs a REAL on-chain `accredit` for X. X is now admin-accredited with no real verification.

**Fix:** Add `AND cj.required_posting_auths ?| $4::text[]` to the query; pass `config.accreditationAuthorities` as $4. Mirror `findAccreditedAccountWithOrcid`'s param structure exactly. Alternative: replace `getExistingAccreditation` in `handleLink` with a call to the authoritative `getAccreditedSet` helper (used in `handleAccredit` line 316).

**Tests (`backend/tests/routes/orcid.test.ts`):**
- Self-broadcast fake accredit for X + link flow → 422 "Account is not accredited", no admin broadcast, no Hive op.
- Authority-signed accredit for X + link flow → 200, admin broadcast fires.

**Non-goals:** `profile.ts:getAccreditationFromHaf` same issue (read-only, separate P2). Rate-limit X-Forwarded-For spoofing (separate P1).

**Deliverable:** Self-broadcast fake accredits cannot unlock /link. Curl reproducer in Review.

---

### FE-E2E-SPEC-TRACE-OFF — Expand trace opt-out to JWT-bearing specs + add JWT pattern (UI Agent, URGENT P0)

**Surfaced by:** FE-E2E-TRACE-SECRET-REDACTION + FE-E2E-AUTH-FIXTURE-HARDEN reviews. 4 reviewers boosted.

**Goal:** Close a P0 trace-leak. 6 specs mint live backend-valid bearer JWTs via `mintSessionJwt` / `seedAccreditedSession` / `seedUnaccreditedSession` and lack `test.use({trace:'off'})`. Global default `trace: 'retain-on-failure'` + `addInitScript` localStorage seeding → JWT in trace.zip on any failure. Teardown scan's `SESSION_SECRET[=:]` + raw-value patterns do NOT match the three-segment base64url JWT shape. Attacker reads trace from public CI artifact → replays `Authorization: Bearer` for 1h.

**Add `test.use({ trace: 'off', video: 'off', screenshot: 'off' })` at top of:**
- `frontend/tests/e2e/vote-comment.spec.js`
- `frontend/tests/e2e/review-submit.spec.js`
- `frontend/tests/e2e/settings.spec.js`
- `frontend/tests/e2e/login-keychain.spec.js`
- `frontend/tests/e2e/accreditation.spec.js`
- `frontend/tests/e2e/orcid-link.spec.js`
- `frontend/tests/e2e/login-email.spec.js` (plaintext password in form + response body)
- `frontend/tests/e2e/password-recovery.spec.js` (ditto)
- `frontend/tests/e2e/email-signup.spec.js` (ditto — scan catches `E2eTestPass1` but other passwords aren't patterned)

**In `frontend/tests/e2e/global-teardown.js` scanTracesForSecrets combined regex — add:**
- Three-segment JWT: `[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}`
- JSON-form SESSION_SECRET: widen to also match `"SESSION_SECRET"`
- Compressed WIF: `[KL][1-9A-HJ-NP-Za-km-z]{51}`
- BIP39 mnemonic: `([a-z]{3,8} ){11}[a-z]{3,8}`

**Deliverable:** No JWT / WIF / session-secret / password material in any retained trace. All 9 specs opted out. Scan regex widened. Playwright green.

---

### FE-TRACE-SCAN-HARDEN — Fix scanTracesForSecrets correctness + add unit tests (UI Agent, P1)

**Surfaced by:** FE-E2E-TRACE-SECRET-REDACTION review. 5+ reviewers cross-flagged.

**Fixes in `frontend/tests/e2e/global-teardown.js`:**
1. **`return` → `continue` on `unzipped.error`.** Distinguish `err.code === 'ENOENT'` (binary missing, OK to return — all files would fail) from `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` / other (must `continue` so later traces still scan). Log differently per code.
2. **Scan runs BEFORE IPFS cleanup** — throw-on-leak orphans CIDs. Capture scan error, run cleanup, then re-throw. Or move scan to end.
3. **Partial-prefix leak in error message.** Replace `patternMatch[0].slice(0, 8)` with a category label (`'WIF private key'`, `'SESSION_SECRET literal'`, `'JWT'`, etc.) — no secret bytes in CI logs.
4. **SESSION_SECRET < 16 silent disable.** Log explicit `console.warn` when value-scan is skipped.

**Add `frontend/tests/unit/global-teardown.test.js`:** handcraft minimal zip via Node `zlib` — test WIF/SESSION_SECRET/JWT/known-password detection, clean-trace no-throw, ENOBUFS first-file continues second-file scan, IPFS cleanup runs even on scan throw.

**Non-goals:** Replacing `unzip` shell-out with pure-JS lib (yauzl/fflate). Noted, deferred.

**Deliverable:** Scan deterministic + test-covered. Move to Review.

---

### FE-E2E-FIXTURE-CORRECTNESS — Fix fixture infrastructure correctness bugs (UI Agent, P1)

**Surfaced by:** FE-E2E-AUTH-FIXTURE-HARDEN review. Multiple cross-reviewer P1s in shipped fixture code.

**Fixes:**
1. **`global-setup.js:54` localhost guard bypass.** `startsWith('http://localhost')` accepts `http://localhost.attacker.com`. Replace with `new URL(baseURL).hostname === 'localhost' || '127.0.0.1' || '[::1]'`.
2. **`db.js:47` `_test` suffix bypass via path segment.** `postgresql://.../pevo_app/test` parses as dbName `pevo_app/test` → `endsWith('_test')` true → libpq connects to `pevo_app`. After leading-slash strip, also reject any `/` in dbName (`/^[^/]+_test$/`).
3. **`global-setup.js:27-39` loadEnvFile divergence from auth.js parseEnvFile.** Delete the inline loader. Import `parseEnvFile` from `./fixtures/auth.js`. Silent SESSION_SECRET corruption path (`=abc # comment` pollution) disappears.
4. **`auth.js:65` cachedSecret process-env pollution.** Rename fixture env var to `E2E_SESSION_SECRET`. Priority: `process.env.E2E_SESSION_SECRET` > `frontend/.env.test` SESSION_SECRET. Backend's own SESSION_SECRET (Docker env) can no longer leak into fixture JWT minting. Update `.env.test.example` + README.
5. **`mintSessionJwt` no unit test.** Add to `frontend/tests/unit/e2e-fixtures.test.js`: known secret → deterministic token → split on `.`, base64url-decode header/payload, assert fields + HMAC signature verifies.
6. **`auth.js:pickAccreditedResearcherOnce` doesn't catch throws.** Wrap `request.get` in try/catch inside the single-attempt helper; on throw return null. ECONNREFUSED currently escapes the retry loop.
7. **`global-setup.js:115` silent redis error swallow.** Replace `redis.on('error', () => {})` with `redis.on('error', (err) => console.warn('[e2e global-setup] redis error:', err.message))`.
8. **Spec-level secondary bugs (same task — trivial batch):**
   - `vote-comment.spec.js:75` — waitForResponse registered after page.goto (same inverted pattern the comment test fixed). Move before.
   - `login-keychain.spec.js:185` — `JSON.parse(postData())` crashes on null body. `expect(raw).not.toBeNull()` first.
   - vote-comment / review-submit / publish specs — `expect(voter).toBeTruthy()` doesn't stop execution. Replace with `if (!voter) throw new Error(...)`.

**Deliverable:** Fixture guards match their stated contracts. Unit + Playwright green. Move to Review.

---

### FE-E2E-RETRY-SUFFIX — Make RUN_SUFFIX per-attempt (UI Agent, P1)

**Surfaced by:** FE-E2E-AUTH-FIXTURE-HARDEN review. 3 reviewers flagged.

**Goal:** Close retry-semantics bug. 5 specs set `const RUN_SUFFIX = Date.now().toString(36).slice(-6)` at module scope. Playwright `retries: 1` re-runs in the same worker without re-evaluating the module → same suffix → DUPLICATE signup → 409 masks the original HAF-timeout root cause.

**Fix pattern:** Move suffix computation inside test body or `beforeEach`:
```js
test('...', async ({ page }, testInfo) => {
  const RUN_SUFFIX = `${Date.now().toString(36).slice(-6)}r${testInfo.retry}`;
  // ...
});
```

**Affected specs:** `email-signup.spec.js`, `seed-phrase.spec.js`, `login-email.spec.js`, `settings.spec.js`, `password-recovery.spec.js`.

**Deliverable:** Retry failures surface original root cause, not 409. Move to Review.

---

### FE-ORCID-CALLBACK-FIXES — Fix 2 ORCID-flow UX bugs (UI Agent, P1)

**Surfaced by:** SEC-002 pair review.

**Fixes:**

1. **`orcid-callback.js:148` `_saveSession` 6-arg misuse** — **`this.expiresAt` never set, ORCID-login users lose session on reload** (`_restoreSession` rejects entries with null expiresAt). Fix: before the `_saveSession()` call, set `auth.expiresAt = data.expires_at;` (token/username/isConnected/custody already set above). Remove the 6 positional args from the call. Audit/fix same pattern at `login.js:152`.

2. **`orcid-callback.js:73` `pevo_orcid_mode` removed before await.** On 503 + user refresh, mode reads as `''` → unauthenticated request → 401 on link/accredit. Fix: move `removeItem` into the success handler, AFTER `completeOrcid` resolves.

**Tests:** assert session has non-null expiresAt after ORCID login; simulate 503 + refresh + assert second attempt still carries Bearer.

**Deliverable:** ORCID sessions persist across reload. 503-retry doesn't drop mode. Move to Review.

---

### FE-AUTH-POST-AWAIT-GUARD — Close post-await disconnect race in auth.js (UI Agent, P1)

**Surfaced by:** FE-AUTH-ACCRED-POLL-GUARD review. Task description overclaimed "reentry guard alone closes the race"; 2 reviewers independently confirmed an orthogonal race remains.

**Fix in `frontend/src/auth.js` `_checkAccreditation`:** Add post-await re-check before the write block.

```js
async _checkAccreditation() {
  if (!this.username || !this.isConnected) return;
  try {
    const accRes = await fetchAccreditationStatus(this.username);
    if (!this.username || !this.isConnected) return;  // disconnect() may have run mid-fetch
    if (accRes?.data) {
      this.isAccredited = accRes.data.is_accredited;
      this.accreditation = accRes.data.accreditation;
      this._saveSession();
    }
  } catch (err) {
    console.warn('[auth] accreditation check failed:', err);
  }
}
```

**Test:** hold fetch promise open via deferred → `store.disconnect()` → resolve fetch with `is_accredited:true` payload → assert `store.isAccredited === false` and no `pevo_session` in localStorage.

**Deliverable:** Post-await race closed. Move to Review.

---

### FE-AUTH-TEST-HARDEN — Test-quality follow-ups from FE-AUTH-ACCRED-POLL-GUARD (UI Agent, P3)

**Changes in `frontend/tests/unit/auth.test.js`:**
1. Rejected-fetch test: assert `isAccredited` + `accreditation` NOT mutated.
2. Happy-path test: assert `localStorage.setItem('pevo_session', ...)` called (the `_saveSession` side effect).
3. Add `accRes.data === null` branch test — pre-set isAccredited=true, mock `{data:null}`, assert isAccredited remains true.
4. Remove redundant `mockFetchAccreditationStatus.mockClear()` calls — `beforeEach` already resets.

**In `frontend/src/auth.js`:** strip the Playwright reference from the `_checkAccreditation` comment (rot-prone); remove the "Log but do not reject" WHAT-comment at line 168.

**Deliverable:** Stronger mutation-killing assertions + cleaner comments. Move to Review.

---

### BE-ACCRED-TX-ID-PARITY — Add tx_id to GET /api/accreditations/:username (Backend Agent, P2)

**Goal:** Shape parity with `/api/profile/:username` (which includes `accreditation.tx_id`, the HAF event_id).

**Fix in `backend/src/routes/accreditations.ts` `fetchAccreditationStatusFromHaf`:**
- Add `cj.id AS event_id` to SELECT clause.
- Project `tx_id: result.rows[0].event_id?.toString() || null` in the returned accreditation object.

**Update `agents/docs/api-contracts/accreditation.md`:** document tx_id in the /:username section example.

**Tests:** skipIf-real-HAF test asserting both profile and accreditation-status endpoints return the same tx_id for a sample accredited account.

**Deliverable:** Shape parity. Move to Review.

---

### BE-ACCRED-REVOKE-TEST — Revoke-branch test for fetchAccreditationStatusFromHaf (Backend Agent, P2)

**Goal:** Close a mutation-kill gap. `fetchAccreditationStatusFromHaf` has 3 branches; new tests only cover accredit. A mutation returning `is_accredited:true` from the revoke branch wouldn't be caught.

**Fix:** Add one skipIf-real-HAF test finding an account whose latest op is `revoke`; assert `is_accredited: false, accreditation: null`.

**Deliverable:** Full branch coverage. Move to Review.

---

### SEC-002-HARDENING — Post-review hardening of /api/orcid (Backend Agent, P2)

**Goal:** Batch non-critical findings from SEC-002 pair review.

**Fixes in `backend/src/routes/orcid.ts`:**
1. **State-consume outside try/catch (lines 179-184)** — wrap `redis.del` / `orcidStates.delete` in the outer try so Redis flap doesn't orphan state. Or use `redis.getdel`.
2. **`handleLogin` NO_ACCOUNT envelope violation (lines 282-288)** — move `orcid_id` from top-level response into `error.details` or the data envelope. Frontend `ApiRequestError` silently drops top-level extras. Update orcid.md.
3. **Document state-not-consumed-on-403 behavioral contract** in orcid.md — clients building retry-after-auth-failure logic depend on this guarantee.
4. **Fix `orcid-link.spec.js:107-115` `test.fixme`.** SEC-002-BE is merged. Either implement the two-browser-contexts 403 test or convert to `test.skip` with a concrete blocker.
5. **HAF-lag TOCTOU mitigation** — after successful accredit/link broadcast, write `${config.appTag}:orcid_binding:${orcid_id}` with TTL=120s + value=username. In `findAccreditedAccountWithOrcid` check this Redis key BEFORE the HAF query. Closes the 3-30s indexing-lag duplicate-bind window.
6. **Production multi-process startup check** — if `NODE_ENV=production` and Redis unavailable at startup, log loud warning: `orcidStates` in-memory fallback is single-process only.

**Non-goals:** `getExistingAccreditation` filter (SEC-AUTH-BYPASS). X-Forwarded-For spoofing (separate). SQL-substring mock discriminators in orcid.test.ts (separate refactor).

**Deliverable:** 6 hardening items landed. Full vitest pass. Move to Review.

---

### FE-SEC-004-POLISH — Secondary hardening for SEC-004-UI (UI Agent, P2)

**Goal:** Batch P2/P3 items from SEC-004-UI review. Not merge-blockers for the SEC-004 atomic pair — ship after.

**Changes:**
1. **`orcid-callback.js:130` orphaned `pevo_signup_orcid_name`** — either remove the `setItem` (if auto-fill abandoned) or add `removeItem` in `signup.js init()` (and optionally read into `fullName`).
2. **`settings.js` handleSetPassword mutation order** — patch `emailStatus` FIRST, flip `passwordSetDone=true` LAST. If the spread throws, form isn't stuck in success state while emailStatus is un-patched.
3. **Collapse overlapping success signals.** Drop `passwordSetDone` — the outer `x-if` on `emailStatus.has_password === false` (post-SEC-004-UI field-name fix) already hides the section on success.
4. **`orcid-no-password.spec.js:217-227` — Alpine internals.** Replace `root._x_dataStack[0]` with `Alpine.evaluate(root, 'newPassword = "..."')`.
5. **`orcid-no-password.spec.js:209` — brittle selector.** Add `data-testid="recover-method-orcid"` to the tab button; use that selector.
6. **`pages-settings.test.js` double-guard gap** — test `handleSetPassword` with `passwordSubmitting=true` pre-set; assert no API call.
7. **Strip task-ID refs** (`SEC-004` / `SEC-004-BE` / `SEC-004-UI`) from code comments across signup.js, recover.js, settings.js, api.js. Keep WHY prose.
8. **Placeholder-translation markers for 15 non-English locales** — prefix untranslated strings with `[TODO]` OR add `_todo_keys` array listing untranslated keys. Pick one; document convention in ui/CLAUDE.md.

**Non-goals:** Splitting settings.js (separate refactor). DRY password validation (FE-PASSWORD-POLICY-DRY).

**Deliverable:** Move to Review.

---

### FE-PASSWORD-POLICY-DRY — Extract shared password-validation helper (UI Agent, P3)

**Goal:** Eliminate 4-way duplication. Rule `length >= 10 && /[a-z]/ && /[A-Z]/ && /[0-9]/` lives in signup.js, recover.js, settings.js, reset-password.js.

**Fix:** Create `frontend/src/password-policy.js` exporting `MIN_PASSWORD_LENGTH=10` + `isPasswordValid(pw)`. Import in all 4 pages. Delete local copies. Add `frontend/tests/unit/password-policy.test.js` — coverage for each criterion.

**Deliverable:** Single-source-of-truth policy. Move to Review.

---

### SEC-003-BE — Fix bridge-claim approve/revoke authorization (Backend Agent)

**Handoff (2026-04-21, prior Backend agent):** Implementation exists on git branch `worktree-agent-a61f4163` (worktree at `.claude/worktrees/agent-a61f4163/`) but is uncommitted. It covers the full spec: caller-identity gate on approve (admin OR approved co-author, self-approval blocked), `isBridgeAdmin` removed from revoke OR-gate, bridge-key broadcast on revoke tightened to `paperAuthor === hiveBridgeAccount && isAdmin`, new `isApprovedCoAuthor` helper inline in `claims.ts` (fails closed on HAF error), 10 test scenarios in a new `backend/tests/routes/claims.test.ts` using real `verifyHiveSignature`. Individually: 10/10 pass. Full vitest suite was NOT run. One spec-vs-schema mismatch the prior agent flagged: the HAF `authorship_claims` CTE uses status value `'accepted'`, not `'approved'` as the spec text below says. The code matches the schema (correct), the spec prose is stale. Verify the branch diff, finish `/ce-work` (run `/ce-code-review` + `/ce-simplify` if not already done), then move to Review. If the branch is gone, the spec below is self-sufficient. Re-execute from scratch.

**Goal:** Close the twin P0 findings from the 2026-04-21 audit: any authenticated user can currently (a) approve an authorship claim on any bridge paper, inflating arbitrary reputation, or (b) revoke any approved claim on any bridge paper, stripping researchers of authorship credit. The server signs both with the platform bridge key. Two distinct exploits, one file, one atomic fix.

**Root cause — approve (`backend/src/routes/claims.ts:123-159`):** after `verifyHiveSignature` admits any authenticated user, the bridge-broadcast branch gates on `paperAuthor === config.hiveBridgeAccount` (a property of the paper), not on the caller. No authorization check exists between the middleware and the server-signed broadcast.

**Root cause — revoke (`backend/src/routes/claims.ts:184-224`):** `isBridgeAdmin = paperAuthor === config.hiveBridgeAccount` is a paper property, not a caller check. It's included in the OR-gate at line 197, so every authenticated user satisfies the authorization test on any bridge paper. Line 211 then broadcasts with the bridge key.

**Decided fix — positive caller-identity authorization before any bridge-key broadcast:**

*Approve (bridge papers):* only `config.hiveAdminAccount` OR an already-approved co-author of the same paper may trigger the server-signed broadcast. Rationale: native papers already gate on `username === paperAuthor`; bridge papers have no human post-author, so platform admin bootstraps the first approved claim and approved co-authors can vouch for each other thereafter. Self-approval by the claimer is disallowed — that would collapse the whole approval gate.

*Revoke:* drop `isBridgeAdmin` from the top-level AND-gate entirely. The correct authorization set is `isPostAuthor || isClaimer || isAdmin`. For bridge papers, `isPostAuthor` is never true for a human caller (the paperAuthor is `hiveBridgeAccount`), so in practice only the claimer-of-record or platform admin can revoke. The server-signed bridge-key broadcast path at line 211 then tightens to `paperAuthor === config.hiveBridgeAccount && isAdmin` — only platform admin uses the bridge key, never a claimer (claimer revoking their own claim signs with their own posting key via the existing native return-operation path).

**Actions:**

1. In `backend/src/routes/claims.ts`:
   - **Approve** (`POST /:claimer/approve`, around line 140): before the bridge-broadcast branch, compute `const isApprovalAuthority = username === config.hiveAdminAccount || await isApprovedCoAuthor(paperAuthor, paperPermlink, username)`. If `paperAuthor === config.hiveBridgeAccount` and `!isApprovalAuthority`, return 403. Do NOT broadcast. The existing `fetchClaimsFromHaf` can be reused or trimmed into a cheaper `isApprovedCoAuthor(author, permlink, username)` helper that returns true iff a row exists with `claimer = username AND status = 'approved'`.
   - **Revoke** (`POST /:claimer/revoke`, around line 184): remove `isBridgeAdmin` from the top-level OR-gate at line 197. Replace the bridge-broadcast branch condition at line 211 from `if (isBridgeAdmin && config.pevoBridgePostingKey)` to `if (paperAuthor === config.hiveBridgeAccount && isAdmin && config.pevoBridgePostingKey)`. The claimer-revokes-own-claim-on-a-bridge-paper case then correctly falls through to the existing client-signed operation return (claimer signs with their own key) rather than burning the bridge key on a user-driven action.
2. Invalidate the `claims:${paperAuthor}:${paperPermlink}` cache after successful bridge-broadcast in both handlers (already done post-fix today; preserve).
3. Add backend tests in `backend/tests/routes/claims.test.ts` (create if absent, mirror `auth.test.ts` style — **real `verifyHiveSignature`, not the `mock-auth` fixture**):
   - **Approve, bridge paper, unrelated authed user** → 403, no broadcast, no Hive op.
   - **Approve, bridge paper, admin** → 200 + broadcast with bridge key.
   - **Approve, bridge paper, approved co-author of same paper** → 200 + broadcast (requires a fixture claim in `approved` state for a different `claimer` on the same paper).
   - **Approve, bridge paper, claimer trying to self-approve** → 403, no broadcast.
   - **Approve, native paper, caller ≠ paperAuthor** → 403 (regression guard on existing behavior).
   - **Approve, native paper, caller = paperAuthor** → 200 + returns operation for client to broadcast (no server signature).
   - **Revoke, bridge paper, unrelated authed user** → 403 (the exact current bug).
   - **Revoke, bridge paper, claimer revoking own claim** → 200 + returns operation for client to broadcast (NOT a bridge-key broadcast).
   - **Revoke, bridge paper, admin** → 200 + bridge-key broadcast.
   - **Revoke, native paper, caller = paperAuthor** → 200 + returns operation (regression).
4. If a cheap `isApprovedCoAuthor` helper is cleaner as an export from `backend/src/hafsql.ts`, go that route; otherwise inline-query in `claims.ts`. Judgment call, keep it small.

**Files:**
- Modify: `backend/src/routes/claims.ts`
- Modify / add: `backend/tests/routes/claims.test.ts`
- Maybe add one helper in `backend/src/hafsql.ts` (only if cleaner)

**Non-goals (do NOT fold in):**
- Any rate-limit tightening on approve/revoke (top-of-TASKS.md backlog item; the `byAccount` 10/60s limiter stays as-is for this task).
- The adjacent P2 API-contract finding that the claim/approve/revoke responses are silent on `tx_id` vs operation discriminator — separate, docs-owned.
- Pagination/caching changes on `GET /api/papers/:a/:p/claims`.
- `verifyHiveSignature`-mocking regression in other route tests (the test-P0 is tracked separately; this task just refuses to add to the debt by using the real middleware for its own new tests).

**Deliverable:** A hostile authenticated user (not admin, not the paperAuthor of a native paper, not an approved co-author on a bridge paper, not the claimer on a revoke) gets 403 on both endpoints; bridge key is never used outside the two legitimate paths. Ten test scenarios cover the grid. `npx vitest run` passes under the in-Docker env per root `CLAUDE.md`. Move to Review when done — include `curl` lines showing the 403 on the two previously-exploitable paths (bridge approve by random user; bridge revoke by random user).

---

### FE-KEYCHAIN-API-MISUSE — Fix `requestAddAccountAuthority` → `requestImportKey` in custody upgrade (UI Agent)

**Goal:** Close a P1 pre-existing defect surfaced by FE-BIP39-BUNDLE architect review. `frontend/src/pages/settings.js:515-516` calls `window.hive_keychain.requestAddAccountAuthority(this.username, newKeys.posting, 'posting', callback)`. **This is the wrong API.** Per Hive Keychain docs, `requestAddAccountAuthority` expects the second argument to be an **account name** to be added as an authority on the first account. `newKeys.posting` is a 64-char raw hex string (the HMAC-SHA512 output from `deriveHiveKeys`) — not an account name, not a WIF. The extension either rejects this (silent failure, post-broadcast step never lands in Keychain) or — worse — stores/logs the raw hex seed thinking it's an account identifier, surfacing the private-key seed in extension logs / telemetry.

The intended semantic is "import this account's new private key into Keychain so the user can sign with it on self-custody" — that's `requestImportKey(username, wifKey, callback)` where `wifKey` is the WIF-formatted private posting key derived from `newKeys.posting`.

**Masked in tests:** the E2E stub in `custody-upgrade.spec.js:53-64` ignores the second argument entirely (`_authorizedKey`) and returns success unconditionally. The test is blind to this bug.

**Actions:**
1. In `frontend/src/pages/settings.js` `executeUpgrade()` around line 515-516, replace the `requestAddAccountAuthority` call with `requestImportKey`:
   ```js
   const wifPosting = dhive.PrivateKey.fromSeed(newKeys.posting).toString();
   window.hive_keychain.requestImportKey(this.username, wifPosting, callback);
   ```
   Confirm the exact dhive import path in this file (it already imports dhive for `Client`/`PrivateKey`).
2. Audit whether the upgrade flow ALSO needs the active or owner key imported into Keychain. `requestImportKey` is typically called per key-role. Decide with the user whether self-custody upgrade imports posting only (light-account users mostly comment/vote) or all four. This is a product decision, not a code decision — flag for user if uncertain.
3. Tighten the E2E stub in `custody-upgrade.spec.js:53-64`: replace `requestAddAccountAuthority` stub with `requestImportKey`, and add an assertion that the second argument matches the WIF regex (`/^5[HJK][1-9A-HJ-NP-Za-km-z]{49}$/`). Reject raw hex strings. Add a companion assertion capturing the exact call arguments for later verification.
4. Add a regression test that asserts settings.js does NOT call `requestAddAccountAuthority` anywhere (grep-level unit test, or a real-Keychain assertion that the stub's legacy method remained uncalled).
5. Cross-check: does any OTHER caller in the codebase use `requestAddAccountAuthority` with a non-account second argument? Grep across `frontend/src/**/*.js`. If others exist, carve separate sub-tasks or fold.

**Non-goals:**
- Changing the broader self-custody upgrade UX (step order, prompts).
- Keychain-absent fallback behavior (separate concern).
- Adding active/owner key imports without product decision.

**Deliverable:** Hive Keychain receives a properly-formed WIF private key, not a raw hex seed, during the self-custody upgrade. E2E stub enforces the correct argument shape. `npx playwright test` passes. Move to Review when done — include the browser DevTools console log (or the E2E assertion output) showing the WIF-formatted key being passed.

---

### FE-UPGRADE-CREDENTIAL-WIPE — Wipe mnemonic and password state on successful custody upgrade (UI Agent)

**Goal:** Close a P1 XSS-amplification surfaced by FE-BIP39-BUNDLE architect review. `frontend/src/pages/settings.js` `executeUpgrade()` sets `this.upgradePhase = 'done'` at ~line 549 without clearing `this.oldSeedPhrase`, `this.newSeedPhrase`, or `this.upgradePassword`. The existing `resetUpgrade()` method zeros these fields, but it's only reached on the error path. On the happy path, the sensitive fields sit in Alpine's reactive data indefinitely; an XSS on `/settings` can `window.Alpine.$data(el).oldSeedPhrase` to read the plaintext 12-word seed.

**Actions:**
1. In `settings.js` `executeUpgrade()`, immediately before `this.upgradePhase = 'done'`, zero all sensitive fields:
   ```js
   this.oldSeedPhrase = '';
   this.newSeedPhrase = '';
   this.newSeedWords = [];
   this.confirmInputs = {};
   this.upgradePassword = '';
   ```
   Or call `this.resetUpgrade()` — audit whether that method preserves the `done` phase transition; if it resets `upgradePhase` too, either split it into `_clearSensitiveState()` + the phase-preserving reset, or inline the zeroing.
2. Same audit for OTHER sensitive-state holders on this page: `initialPassword`, any email-change intermediates, ORCID-linking tokens. Zero on success, not just error.
3. Unit test: after a successful `executeUpgrade()` (stub the broadcast path to succeed), assert `this.oldSeedPhrase === ''` and `this.newSeedPhrase === ''` on the component.
4. E2E test: extend `custody-upgrade.spec.js` with a `page.evaluate(() => window.Alpine.$data(...).newSeedPhrase)` AFTER the broadcast assertions pass, asserting it returns empty. This regression guard also surfaces the wipe to the `trace: 'retain-on-failure'` concern tracked separately — stale plaintext in Alpine state would otherwise leak on any unrelated post-upgrade assertion failure.

**Non-goals:**
- Broader Alpine-state hygiene audit across other pages (separate pass).
- Encrypting sensitive state at rest in Alpine (out of scope; wipe-on-success is the simpler closure).
- Changing the `done` phase UI.

**Deliverable:** After a successful custody upgrade, `window.Alpine.$data(settingsEl).oldSeedPhrase` returns empty string. Unit + E2E cover it. `npx vitest run` + `npx playwright test` pass. Move to Review when done.

---

### FE-UPGRADE-KEY-WRAPPER-ADOPT — Route `settings.js` through `hive-keys.js` BIP39 wrappers + test-quality cleanup (UI Agent)

**Goal:** Close architectural inconsistency + accumulated test-quality items surfaced during FE-BIP39-BUNDLE review. The immediate BIP39 swap was done via raw `@scure/bip39` imports in `settings.js` to keep the worktree-parallel implementation simple. `frontend/src/hive-keys.js:27-36` already exports `generateMnemonic()` (threads wordlist + 128-bit entropy) and `validateMnemonic(mnemonic)` (threads wordlist). Other consumers (`signup-verify.js`, `recover.js`) use those wrappers; `settings.js` is the only caller that handles `wordlist` by hand across 3 call sites. A future change to the BIP39 entropy default (128 → 256 bits) would affect `settings.js` differently from the rest — silent divergence.

**Actions:**

1. **Route `settings.js` through `hive-keys.js` wrappers.** Replace:
   ```js
   import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
   import { wordlist } from '@scure/bip39/wordlists/english.js';
   ```
   with:
   ```js
   import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from '../hive-keys.js';
   ```
   (confirm `hive-keys.js` re-exports the three — add re-exports for any missing ones rather than duplicating wrappers). Update the 3 call sites in `startUpgrade` / `executeUpgrade` so they no longer pass `wordlist` manually.

2. **Delete the dead i18n key `common.bip39NotLoaded`** from all 16 locale files under `frontend/public/messages/`. The key is no longer referenced (removed with `_getBip39()`); leaving it makes translators localize a string that never renders.

3. **Tighten the `custody-upgrade.spec.js` signature regex.** Line 245: change `/^[0-9a-fA-F]+$/` to `/^[0-9a-fA-F]{130}$/` (Hive signatures are 65 bytes = 130 hex chars).

4. **Cross-check broadcast pubkeys against independently-derived values.** In the spec, import `deriveHiveKeys` (or `deriveHivePublicKeys`) from `../../src/hive-keys.js` in the Node context, re-derive from `testMnemonic` + `LIGHT_USERNAME`, and assert strict equality against `opBody.owner.key_auths[0][0]`, active, posting, `memo_key`. Mirrors the pattern in `seed-phrase.spec.js:201-208`.

5. **Make old-seed different from new-seed.** The spec currently fills `oldSeedPhrase` with `testMnemonic` (the new seed). Generate an independent second mnemonic in the spec (call `generateMnemonic(wordlist)` in `page.evaluate`, or pre-seed via `page.addInitScript` with a deterministic old seed), then fill that as the old seed. This exercises the actual rotation path (old ≠ new keys) and the broadcast becomes a real rotation rather than a no-op.

6. **Gate the `newSeedPhrase` read on phase transition.** `custody-upgrade.spec.js:176-180`: replace `await expect(page.locator('[x-data="settingsPage"]')).toBeVisible()` (resolves instantly) with `await page.getByRole('button', { name: "I've written it down" }).waitFor()`. That button only renders when `upgradePhase === 'new-seed'`, so waiting for it guarantees Alpine has flushed the post-click microtask queue.

7. **Exact-pin the crypto deps.** In `frontend/package.json`, change `"@scure/bip39": "^2.0.1"` → `"@scure/bip39": "2.0.1"` and `"@hiveio/dhive": "^1.3.6"` → `"@hiveio/dhive": "1.3.6"`. Run `npm install` to refresh the lockfile. (Lockfile already pins, but a lockfile regeneration or fresh `npm install` without `ci` would pull unintended releases.)

**Non-goals:**
- Refactoring the broader `initSettingsPage()` 270-line Alpine component (separate fracture point).
- Addressing the pre-existing `_saveSession(token, ..., 6args)` API misuse in `login.js:152` and `orcid-callback.js:148` (widespread; separate cleanup).
- Active/owner/memo key imports to Keychain (product decision in FE-KEYCHAIN-API-MISUSE).

**Deliverable:** `settings.js` imports only from `hive-keys.js` for BIP39 ops. Dead i18n key gone. E2E spec asserts full-length signature regex, cross-checks pubkeys against deterministic derivation, uses distinct old/new seeds, and gates the mnemonic read on phase progression. `npx vitest run` + `npx playwright test` + `npm run build` pass. Move to Review when done.

---

### FE-TOTALPAGES-INFINITY-GUARD — Fix `Math.ceil(total/limit) || 1 → Infinity` (UI Agent)

**Goal:** Close a P1 correctness bug surfaced in UI-URL-PAGE-HARDEN review. `this.totalPages = res.meta ? (Math.ceil(res.meta.total / res.meta.limit) || 1) : 1` appears in all four feed-style pages. When `res.meta.limit === 0` (misconfigured API response), `Math.ceil(n/0) === Infinity`, and `Infinity` is truthy, so `|| 1` does not trigger. `totalPages = Infinity`, pagination tries to render infinitely many page buttons, `goToPage`'s `page > totalPages` guard never fires.

**Actions:**
1. In `frontend/src/components/paper-feed.js`, `frontend/src/pages/researchers.js`, `frontend/src/pages/search.js`, and `frontend/src/pages/home.js` (line ~303), replace the four `Math.ceil(total/limit) || 1` expressions with:
   ```js
   const pages = Math.ceil(res.meta.total / res.meta.limit);
   this.totalPages = Number.isFinite(pages) && pages > 0 ? pages : 1;
   ```
   Or a small shared helper in `frontend/src/lib/pagination.js` (judgment call — four 2-line sites, shared helper may be warranted now).
2. Add unit tests in each of `components-paper-feed.test.js` / `pages-researchers.test.js` / `pages-search.test.js` / `pages-home.test.js` — `limit=0` input → `totalPages === 1`.

**Deliverable:** 4 call sites + 4 tests. `npx vitest run` passes. Move to Review when done.

---

### FE-URL-SYNC-UTIL-EXTRACT — Shared locale-strip helper + fix paper-feed inner guard + add researchers `_syncFromUrl` guard (UI Agent)

**Goal:** Close P2 asymmetries from UI-URL-PAGE-HARDEN review — the prior task explicitly excluded "URL-sync lifecycle abstraction" but a small pure-function helper is in scope.

**Actions:**
1. Create `frontend/src/lib/url-sync.js` exporting a single pure function: `localeStrippedPath(pathname)` that removes the locale prefix (e.g. `/en/papers` → `/papers`). Mirror the regex semantic already present in all three consumers.
2. Rename `feedOwnsUrl()` → `pageOwnsUrl()` in `paper-feed.js` (align with researchers/search) OR keep `feedOwnsUrl` as a thin alias — pick one, don't keep both names. Implement via the new `localeStrippedPath` helper.
3. Same for `researchers.js` and `search.js` — replace the triplicated locale-strip logic with calls to the helper.
4. **Add missing inner `feedOwnsUrl()` guard inside `paper-feed.js` popstate handler** to match the double-guard pattern in researchers.js and search.js. This closes the asymmetry flagged by julik JFR-H-05.
5. **Add `pageOwnsUrl()` guard to `researchers._syncFromUrl()`** (paper-feed has `feedOwnsUrl()` guard there; researchers does not) — correctness C-2.
6. Unit tests for the new helper covering: `/papers`, `/en/papers`, `/fr/papers/`, `/research-something` (shouldn't match `/researchers`).

**Deliverable:** One helper, 3 consumers, 2 missing-guard fixes. `npx vitest run` passes. Move to Review when done.

---

### FE-URL-PAGE-TEST-GAPS — Fill popstate + rejection test coverage on paper-feed/search (UI Agent)

**Goal:** Close P2 testing gaps from UI-URL-PAGE-HARDEN review. `researchers.spec` has popstate coverage (registration-skip, handler-inert, destroy); `paper-feed` and `search` have zero popstate tests. `loadDisciplines`-rejection path is untested. Empty-result → `totalPages=1` tested only for researchers/search; not paper-feed.

**Actions:**
1. `frontend/tests/unit/components-paper-feed.test.js`:
   - Popstate registration skipped when mounted off `/papers` (and verify inner-handler guard after **FE-URL-SYNC-UTIL-EXTRACT** lands).
   - Popstate handler inert when pathname drifts mid-mount.
   - `destroy()` removes the listener.
   - `loadDisciplines` rejected → `init()` still completes, no unhandled rejection.
   - Empty-result → `totalPages = 1`.
2. `frontend/tests/unit/pages-search.test.js`:
   - Same four popstate tests.
   - `loadDisciplines` rejected → `init()` completes.
3. All three page test files:
   - `_pushUrl` with `currentPage=1` and no filters → URL has no query string.
   - `currentPage === 1` assertion alongside URL pushState in catch-block tests (causal chain explicit).

**Deliverable:** Popstate coverage parity across the three feed files. `npx vitest run` passes. Move to Review when done.

---

### FE-LOADDISCIPLINES-OBSERVABILITY — Surface `loadDisciplines` failures to agents + humans (UI Agent)

**Goal:** Close P2 observability gap from UI-URL-PAGE-HARDEN review (maintainability M-4 + agent-native AN-01). Current `.catch(() => {})` swallows loadDisciplines errors silently — no console log, no data-attribute, no UI indicator. Persistent backend regression on the disciplines endpoint is invisible. Playwright agents cannot distinguish "disciplines loaded" from "silently failed".

**Actions:**
1. In all three sites (paper-feed.js, search.js init — researchers doesn't have a disciplines dropdown?), replace `.catch(() => {})` with `.catch((err) => { console.warn('[loadDisciplines]', err); this.disciplinesLoadFailed = true; })`.
2. Bind a `data-disciplines-status` attribute on the discipline `<select>` element that reflects `disciplinesLoadFailed ? 'failed' : 'ok'`. Agents can assert against it; humans ignore it.
3. Optional: show a small inline hint "Couldn't load disciplines" next to the select when `disciplinesLoadFailed` is true. UX judgment — may be heavier than warranted for a non-fatal degradation.
4. Unit test: `loadDisciplines` rejected → `disciplinesLoadFailed` flips true, `console.warn` called once.

**Non-goals:**
- Retrying the disciplines fetch (separate concern).
- Auto-refresh on backend health-recovery (overengineering).

**Deliverable:** A Playwright agent can `expect(page.locator('[data-disciplines-status="failed"]')).toBeVisible()` when the endpoint is down. Humans see a console warning. Move to Review when done.

---

### FE-DISCIPLINE-CASE-NORMALIZE — Case-normalize `discipline` URL param + option values (UI Agent)

**Goal:** Close P2 agent-native gap from UI-URL-PAGE-HARDEN review (AN-02). `/papers?discipline=physics` (lowercase) fetches correctly because the API param passes through, but the dropdown shows "All Disciplines" because option values are `"Physics"` (capitalized from API). An agent constructing a URL representing a valid view finds the UI can't visually confirm the state.

**Actions:**
1. Decide canonical form: lowercase OR capitalized. Lowercase is simpler URL-wise; capitalized matches human typography. Pick lowercase.
2. Normalize at all reads and writes:
   - `_syncFromUrl()`: lowercase the incoming `?discipline=` param when assigning to `this.discipline`.
   - `_pushUrl()`: lowercase before writing to URL (redundant if source is already lowercased, cheap belt-and-suspenders).
   - `loadDisciplines()`: lowercase each API-returned discipline name when populating the dropdown options.
   - Option display value: capitalize for display (`titleCase` utility), store lowercase.
3. Apply in `paper-feed.js` and `search.js` (researchers page doesn't have disciplines — verify).
4. Unit test: seed with `?discipline=PHYSICS` → `this.discipline === 'physics'` → URL rewrite (or post-sync) → `?discipline=physics`.
5. E2E or unit: dropdown option with lowercase `physics` is visibly selected on load when URL has `?discipline=physics`.

**Non-goals:**
- Changing the backend's capitalization of discipline names (purely frontend normalization).
- Retroactively migrating URLs in the wild (URLs with `?discipline=Physics` continue to resolve correctly).

**Deliverable:** `/papers?discipline=physics` loads with the dropdown visibly reflecting "Physics" selected. Agent reads `data-discipline="physics"` (or the equivalent) and can assert coherence. Move to Review when done.

---

### FE-SEARCH-QUERY-URL-HYGIENE — Trim query + decide filter-change-auto-push policy (UI Agent)

**Goal:** Close two P3 cleanup items from UI-URL-PAGE-HARDEN review.

**Actions:**
1. In `search.js` `doSearch` catch block: trim `this.query` before `_pushUrl()` so URLs don't carry leading/trailing `+` (space-encoded). `expect(window.location.search)` should round-trip cleanly.
2. Decide policy: should search filter changes (type/source/discipline) auto-push URL like paper-feed, or wait for explicit submit like today? Two options:
   - (a) Auto-push on change (paper-feed pattern) — more agent-friendly, changes UX.
   - (b) Keep submit-gated, add a comment explaining the intentional asymmetry.
   Pick one; if (b), don't leave the asymmetry undocumented.
3. Rename the outer Alpine scope on `/papers` from `x-data="homePage"` to `x-data="papersPage"` (or similar) — it's vestigial from when /papers was part of /home; currently misleading when someone greps for where /papers state lives. Confirm `homePage` doesn't carry behavior that papers doesn't want first.
4. Unit test: query with leading/trailing whitespace → URL and API both see trimmed form.

**Non-goals:**
- `auth._saveSession(token, ..., 6args)` API-misunderstanding cleanup across login.js/orcid-callback.js/settings.js — separate sweep (flag in the architect's own CLAUDE.md or a dedicated task later).

**Deliverable:** Clean URL round-trip on search queries. Filter-change-vs-submit UX explicitly decided. Homepage Alpine scope rename if pursued. Move to Review when done.

---

### SEC-004-BE — Make password optional for ORCID-verified signup/recover (Backend Agent)

**Handoff (2026-04-21, prior Backend agent):** Work was implemented in a worktree that was cleaned up before it could be preserved. No branch, no patch, code is lost. Re-execute from scratch per the spec. Decisions the prior agent made that are worth considering but not binding:
- Placed `has_password: boolean` on `GET /api/settings/email` (auth-gated, account-internal) rather than the public `GET /api/profile/:username`, to avoid leaking an account-private flag on a public endpoint.
- Picked `409 PASSWORD_ALREADY_SET` (not 400) when `POST /api/settings/set-password` is called on an account that already has a password. It's a state conflict, distinct from validation error, so the UI can route to change-password.
- Kept `new_password` required on the seed-phrase recovery path. The spec's "optional" only applies to the ORCID recovery path.
- Added `NO_PASSWORD_SET` and `PASSWORD_ALREADY_SET` to the `ErrorCode` union in `backend/src/types/api.ts`.
- Cleared rate-limit Redis keys in `beforeAll` of new test files (`auth-login`, `auth-signup`, `auth-recover`, `signup-confirm`, `settings-write`, `settings-read`) to prevent 429s when multiple auth test files run in the same suite invocation.
- Docs: updated `agents/docs/api-contracts/auth.md`, created `agents/docs/api-contracts/settings.md`, updated the `api-contract.md` index.
- Tests passed 46/46 across 5 files in isolation in the prior run. Full vitest suite was NOT run.

**Goal:** Back half of the twin P0 findings from the 2026-04-21 audit (password in `localStorage` across ORCID round-trip, signup + recover). Enables the UI side (SEC-004-UI) to stop asking for a password at all during the ORCID flow — if the API accepts a null password for ORCID-verified flows, the frontend never has to persist it, never has to re-prompt, and the attack surface disappears by construction.

**Ships atomically with SEC-004-UI.**

**Why this shape:** Verified in code — `backend/src/custody-crypto.ts:14-21` derives the per-account encryption key from `HKDF(master_key, info='pevo:custody:${username}')`. **Password is NOT part of key derivation.** Custody broadcast never needs the password; it's purely a login credential. For ORCID-verified users we can treat password as opt-in, stored only if the user explicitly sets one (during signup or later from settings).

**Actions:**

1. `backend/src/routes/signup-verify.ts`:
   - Confirm path (light account creation with ORCID verification): allow `password` to be omitted, empty string, or null when a valid `orcid_token` is present. When null, insert the account with `password_hash = NULL`. Preserve existing required-password behavior for non-ORCID signups.
   - If a password IS supplied alongside ORCID, still hash and store it (user can opt into password login at signup).

2. `backend/src/routes/auth.ts`:
   - `recoverWithOrcid`: `newPassword` becomes optional. Null → set `password_hash = NULL`. Supplied → hash and store as today.
   - Password-based login (`POST /api/auth/login`): when `password_hash IS NULL`, reject with 403 and a stable error code (`NO_PASSWORD_SET`, message "Account has no password; sign in with ORCID or recover via seed phrase"). Do NOT use 401 — that's indistinguishable from "wrong password" and leaks the same enumeration signal the audit flags elsewhere.

3. `backend/src/routes/settings.ts`:
   - Add `POST /api/settings/set-password` (auth via `verifyHiveSignature`). Body: `{ password }`. Validate strength matches signup policy. Writes `password_hash`. 200 on success. Reject when `password_hash` is already set (user must go through change-password instead).
   - If a change-password route already exists, confirm it requires old-password; set-password must require `password_hash IS NULL` (these are two distinct operations).

4. Expose `has_password: boolean` on the profile or settings-status response so the UI can conditionally show the "Set a password" surface (coordinate with SEC-004-UI on the exact location).

5. Tests (real `verifyHiveSignature`, not `mock-auth`):
   - Signup confirm with valid `orcid_token` and no password → 200, account exists, `password_hash IS NULL`, `has_password=false`.
   - Signup confirm with valid `orcid_token` and supplied password → 200, account exists, `password_hash` set, password login works, `has_password=true`.
   - Recover via ORCID with no password → 200, `password_hash IS NULL` preserved.
   - Password login on null-hash account → 403 `NO_PASSWORD_SET`.
   - Seed-phrase recovery on null-hash account → 200 (regression guard).
   - `POST /settings/set-password` on null-hash account → 200, password_hash set, password login now works.
   - `POST /settings/set-password` when password already exists → 409 or 400 with a clear error.

6. Update `agents/docs/api-contracts/auth.md` and `agents/docs/api-contracts/settings.md` (or create the settings contract file) to reflect the optional-password schemas, the new `NO_PASSWORD_SET` error code, and the new endpoint.

**Files:**
- Modify: `backend/src/routes/signup-verify.ts`
- Modify: `backend/src/routes/auth.ts`
- Modify: `backend/src/routes/settings.ts`
- Modify: `backend/src/routes/profile.ts` (or wherever `has_password` is projected; judgment call)
- Modify / add: `backend/tests/routes/signup-verify.test.ts`, `backend/tests/routes/auth.test.ts`, `backend/tests/routes/settings.test.ts`

**Non-goals (do NOT fold in):**
- Any change to `custody-crypto.ts` — it's correctly username-keyed, leave it alone.
- Migrating existing password-hash-set accounts to null-hash — forward-only behavior for NEW ORCID flows.
- The separate P0 "custody-crypto has no direct tests" — that's a distinct test-gap task.
- The P1 "memo-key recovery bypasses email verification" — separate task.

**Deliverable:** ORCID-verified signup and recover both succeed when `password` is null; null-password accounts can still custody-broadcast via session JWT and can later opt into password login via settings. Password login on a null-hash account returns a distinct error code. Tests cover the grid above. `npx vitest run` passes. Move to Review when done.

---

## Review

### SEC-004-UI — Stop persisting passwords across ORCID round-trip (UI Agent)

**Status:** Implemented, UI-side only. Unit tests 750/750 green (+17 SEC-004-UI tests across 4 files). `npm run build` clean. `/ce-work` stepped through the 5 actions; E2E spec written stubbed-first with 3 `test.fixme`s blocked on SEC-004-BE. **BLOCKER for archive: SEC-004-BE must land before this is safe to merge** — same atomic-ship constraint as SEC-002.

**Changes:**
- `frontend/src/pages/signup.js` — removed `password`/`passwordConfirm` from the `pevo_signup_draft` write in `handleOrcidVerify` and from the `init()` restore. Password + confirm fields hidden via `x-show="!orcidToken"`; added inline hint `signup.orcidNoPassword`. `canSubmit` drops password predicates on the ORCID branch. `handleSubmit` sends `password: null` on the ORCID branch (non-ORCID branch unchanged). Also tightened the DUPLICATE-fallback guard so it only runs when the non-ORCID branch has an actual password to retry with.
- `frontend/src/pages/recover.js` — same pattern: removed `newPassword`/`newPasswordConfirm` from the `pevo_recover_draft` write and init restore. Password fields hidden under `x-show="method !== 'orcid'"`; added `recover.orcidNoPassword` hint. `canSubmitOrcid` no longer requires password; submit path sends `new_password: null` when `method === 'orcid'`.
- `frontend/src/pages/settings.js` — added a "Set a password" surface gated on `emailStatus.hasPassword === false`. New state (`newPasswordInput`, `newPasswordConfirmInput`, `passwordSubmitting`, `passwordError`, `passwordSetDone`), new getters (`newPasswordValid`, `newPasswordsMatch`, `canSubmitPassword`) mirroring signup's validation, and a `handleSetPassword()` that calls the new API and flips `emailStatus.hasPassword` locally so the surface hides on success.
- `frontend/src/api.js` — new `setPassword(password)` helper posting to `/api/settings/set-password` via `authenticatedRequest`.
- `frontend/public/messages/en.json` — 3 new key groups: `signup.orcidNoPassword`, `recover.orcidNoPassword`, 9 `settings.setPassword*` keys.
- `frontend/public/messages/{ar,cs,da,de,es,fa,fr,he,it,nl,pl,pt,sv,tr,zh}.json` (15 files) — same 11 keys added to every locale with English source strings as TODO-placeholders per task instructions.
- `frontend/tests/unit/api.test.js` — +2 tests for `setPassword` (Bearer + UNAUTHORIZED).
- `frontend/tests/unit/pages-signup.test.js` — +5 tests covering the SEC-004 regression surface (no password in draft on OrcidVerify, legacy drafts do NOT rehydrate password, ORCID submit sends `password: null`, `canSubmit` semantics both branches).
- `frontend/tests/unit/pages-recover.test.js` — +5 tests mirroring the above for the recover flow.
- `frontend/tests/unit/pages-settings.test.js` — +6 tests covering `handleSetPassword` (happy path, invalid-password no-op, mismatch no-op, backend-error surface, `newPasswordsMatch`/`canSubmitPassword` getters).
- `frontend/tests/e2e/orcid-no-password.spec.js` (new) — 4 passing specs (2 for signup, 2 for recover) that stub `/api/orcid/start` + `/api/auth/{signup,recover}` at the network layer and assert draft localStorage + request bodies contain no password keys. 3 `test.fixme`s sketch the real-backend integration paths that become runnable once SEC-004-BE lands.

**Dependency on SEC-004-BE (BLOCKER for archive):** SEC-004-UI and SEC-004-BE ship atomically. Merging SEC-004-UI alone will cause the ORCID signup/recover submit paths to return 400 on today's backend (they still treat `password` as required). **Please do not archive SEC-004-UI in isolation.**

---

**Architect review (2026-04-21) — HELD PENDING FIXES:**

Task was architect-gated from archive pending SEC-004-BE. The review surfaced **P0 show-stopper defect** that makes the feature non-functional even when SEC-004-BE lands. Must fix these in the UI before archiving the atomic pair.

1. **P0 SHOW-STOPPER — `hasPassword` / `has_password` field-name mismatch.** Backend `GET /api/settings/email` emits `has_password` (snake_case, matching `backend/src/routes/settings.ts:91`). Template at `settings.js:168` reads `emailStatus.hasPassword === false` (camelCase). `undefined === false` → always false → **Set-Password surface never renders**. Entire SEC-004 opt-in is dead on arrival. Optimistic update spread at `settings.js:496` (`{ ...emailStatus, hasPassword: true }`) has the same wrong key. Unit tests hand-seed camelCase (`pages-settings.test.js:240`), **masking** the bug. Fix: (a) change template `emailStatus.has_password === false`; (b) change spread `has_password: true`; (c) add `has_password: false` to the catch fallback object in `loadEmailStatus` at `settings.js:451`; (d) update unit tests to seed `has_password` (snake_case). 2 reviewers cross-flagged (capped confidence).

2. **P1 — `handleResendVerification` passes empty password on ORCID branch.** After ORCID signup, `this.password=''`. Submitted screen still shows resend; calling `resendVerification(email, '')` likely errors on backend. Fix: either skip the resend button on ORCID branch (hide with `x-show="!orcidToken"`) OR make resendVerification password-optional when there is no password.

3. **P1 — Password not zeroed on error path in `handleSetPassword`.** `settings.js:498` catch block doesn't zero `newPasswordInput` / `newPasswordConfirmInput` → plaintext password remains readable in Alpine reactive state via XSS for the error-display duration. Same class as FE-UPGRADE-CREDENTIAL-WIPE. Fix: add `this.newPasswordInput = ''; this.newPasswordConfirmInput = '';` at the top of the catch block.

4. **P1 — Dead i18n key `common.bip39NotLoaded` in all 16 locale files.** SEC-004-UI's `settings.js` change removed the `_getBip39()` method that referenced this key; FE-UPGRADE-KEY-WRAPPER-ADOPT was going to clean it, but the prerequisite code is already gone NOW. Delete the key from all 16 `frontend/public/messages/*.json`.

**P2/P3 items (batched into FE-SEC-004-POLISH Pending — NOT required to land before archive):**
- `pevo_signup_orcid_name` orphaned in localStorage
- `handleSetPassword` mutation-order fragility
- Overlapping `passwordSetDone` + `emailStatus` signals (collapse after field-name fix lands)
- E2E spec Alpine-internals reach (`_x_dataStack[0]`)
- Brittle `button[@click=...]` selector
- `handleSetPassword` double-guard path untested
- Task-ID refs in comments
- Placeholder-translation markers for 15 locales

**P1 separate follow-up — FE-PASSWORD-POLICY-DRY:** rule `length >= 10 && /[a-z]/ && /[A-Z]/ && /[0-9]/` duplicated across `signup.js`, `recover.js`, `settings.js`, `reset-password.js`. Extract `frontend/src/password-policy.js`. Filed as Pending.

**Path to archive:** (1) UI agent fixes the 4 must-fix items above in a commit on top of SEC-004-UI. (2) SEC-004-BE lands. (3) Atomic ship — archive both together. Review artifact: `.context/compound-engineering/ce-code-review/20260421-122144-98977b64-sec-004-ui/`.

---
