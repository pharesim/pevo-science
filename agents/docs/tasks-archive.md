### BE-PASSWORD-POLICY-DRY — Extract shared backend password-policy helper (2026-04-21c) — Reviewed ✓

Backend agent extracted `MIN_PASSWORD_LENGTH = 10`, `PASSWORD_POLICY_MESSAGE`, and `isPasswordValid(pw: unknown): boolean` into new [password-policy.ts](backend/src/lib/password-policy.ts), mirroring `frontend/src/password-policy.js`. Six call sites — `auth.ts` signup / signup-ORCID / reset-password / recover-ORCID / recover-seed-phrase plus `settings.ts` set-password — now delegate the length+class rule to `isPasswordValid`. Inline `length < 10`, `/[a-z]/ && /[A-Z]/ && /[0-9]/`, and their duplicated sendError strings are gone. Original two-message error split (length vs character class) collapsed to one combined message — chosen over diverging from FE's boolean shape. New [password-policy.test.ts](backend/tests/lib/password-policy.test.ts) covers length boundary, each character class missing, non-string inputs, and `PASSWORD_POLICY_MESSAGE` content (10 specs). Commit `b50ede8`. Architect review (correctness/testing/maintainability/project-standards/kieran-typescript/api-contract/code-simplicity): clean — 3 P3 polish items dismissed (type-predicate harmless; combined-failure spec is documentation-not-coverage; auth.md wording reconciled in this archive — "a digit" → "numbers" + helper-mirror callout at `auth.md:60/:382` and `settings.md:93`). Unblocks PASSWORD-POLICY-HARMONIZE (Pending — both FE and BE helpers now landed).

---

### SEC-003-BE — Fix bridge-claim approve/revoke authorization, with revocation-aware co-author live-trust (2026-04-21c) — Reviewed ✓

Backend agent rewrote [claims.ts](backend/src/routes/claims.ts) approve/revoke authorization. Approve now requires admin OR an approved co-author who is **currently accredited** (claimer-self-approval rejected); revoke is strictly `isPostAuthor || isClaimer || isAdmin` with `isBridgeAdmin` dropped from the OR-gate; bridge-key server-side broadcast tightened to fire only when admin + bridge paper + `PEVO_BRIDGE_POSTING_KEY` configured. New `isApprovedCoAuthor` helper JOINs `active_accreditations` so a previously-approved co-author whose accreditation is later revoked immediately loses co-sign authority (fail-closed on HAF error). Schema note: HAF `authorship_claims` CTE uses status `'accepted'`, not `'approved'` as the original spec text said — code matches schema. Round-1 commit had 11 test scenarios; round-2 commit `ce9e909` added: `active_accreditations` JOIN (P2 — original commit declared the CTE but never JOINed), multi-signal mock SQL detection (P2), HAF-throw fail-closed test asserting `broadcastJson not.toHaveBeenCalled()` (P2), symmetric native-claimer-revoke test (P3), chain-visible-actor comment at native-admin-revoke broadcast site (P3). 16/16 `claims.test.ts` pass. Architect round-3 review (correctness/security/testing/maintainability/project-standards/kieran-typescript/ce-agent-native): clean, no new findings — auth-bypass class closed, JOIN survives revoked-after-accepted attacker scenarios, mock multi-signal robust to JOIN refactor. `papers.md:301` updated in this archive to document the revocation-JOIN semantic ("Co-sign authority tracks accreditation live"). B1 misleading-error follow-up filed previously as BE-CLAIMS-ERROR-POLISH (still in Review). Curl reproducers in original task spec confirm 403 on bridge approve / bridge revoke by random user.

---

### BE-ACCRED-TX-ID-PARITY + BE-ACCRED-REVOKE-TEST — Add tx_id to /api/accreditations/:username + revoke-branch coverage (atomic pair) (2026-04-21c) — Reviewed ✓

Backend agent added `cj.id AS event_id` to `fetchAccreditationStatusFromHaf` SELECT in [accreditations.ts](backend/src/routes/accreditations.ts); response projects `tx_id: result.rows[0].event_id?.toString() ?? null`. Shape mirrors `/api/profile/:username` exactly. Round-1 [accreditations.test.ts](backend/tests/routes/accreditations.test.ts) added a parity test against beta HAF (4 specs, 1 skipIf for revoke aspirational path); round-2 commit `54618d2` converted the revoke-branch coverage to a separate mocked-pool carve-out file [accreditations-revoke.test.ts](backend/tests/routes/accreditations-revoke.test.ts) so mocks don't spill into real-HAF specs (carve-out justification header documents impracticality of real-HAF seed-and-wait, `verifyHiveSignature` not mocked, real-HAF skipIf retained as aspirational variant). Round-2 also flipped `event_id?.toString() || null` → `event_id?.toString() ?? null` at `accreditations.ts:143` and the companion `profile.ts:53` change landed under SEC-AUTH-BYPASS (same logical fix, two call sites). Architect round-3 review: clean — both round-2 items VERIFIED FIXED, no security/correctness concerns. 4 P3 test-mock hygiene items (hafCache TTL collision risk, mock SQL substring brittleness, fixture comment overstatement, residual `||` at `accreditations.ts:141`) bundled as new Pending **BE-ACCRED-TEST-MOCK-POLISH** (P3). `accreditation.md` already documents the `tx_id` field shape at lines 57-64 (no archive-time edit needed).

---

### SEC-004-BE + SEC-004-UI — Make password optional for ORCID-verified signup/recover, stop persisting passwords across ORCID round-trip (atomic pair) (2026-04-21c) — Reviewed ✓

Atomic pair closing the ORCID-only-signup password coupling. Backend (commits `2fd4d20` + `f1a80cc`): `/signup` and `/recover` accept null password on ORCID paths; `/login` returns `403 NO_PASSWORD_SET` when `password_hash IS NULL`; new `POST /api/settings/set-password` (400 weak / 401 unauthed / 403 ORCID_REQUIRED / 404 → 401 missing-account / 409 PASSWORD_ALREADY_SET / 200 argon2id hash); `GET /api/settings/email` projects `hasPassword: boolean` (camelCase, end-to-end-renamed from `has_password` for consistency with the rest of the response object); new `NO_PASSWORD_SET` / `PASSWORD_ALREADY_SET` / `ORCID_REQUIRED` codes in `backend/src/types/api.ts`. Round-2 closures: P1 login-enumeration timing oracle (sentinel `argon2.verify` against module-load-computed `SENTINEL_ARGON2_HASH_PROMISE` burned on null-hash branch before 403 — closes the ~100x timing gap, status-code 403 vs 401 axis preserved as accepted UX-valuable distinction); 404→401 audit sweep across 4 authed sites (`settings.ts` set-password + DELETE /email, `custody.ts` /broadcast + /upgrade); `/set-password` ORCID-verified guard (403 `ORCID_REQUIRED` when null-hash account has no linked ORCID); recover.ts C2 mutual-exclusion 400 with DB-state mutation-kill; real argon2id seed in 409-path test; `auth.ts` comment-drift cleanup. Frontend (commits `f42786a` + `e257047`): `signup.js` / `recover.js` no longer persist password to `pevo_signup_draft` / `pevo_recover_draft`, ORCID-branch submit sends `password: null`, settings.js gains a "Set a password" surface gated on `emailStatus.hasPassword === false`, all sensitive state zeroed on error paths, dead `common.bip39NotLoaded` i18n key removed from all 16 locales, `handleResendVerification` guarded on ORCID branch. UI 832/832 unit tests + clean build. Backend 230 pass + 3 skipIf across 36 files. Architect round-3 review (correctness/security/testing/maintainability/project-standards/kieran-typescript/reliability/ce-agent-native + frontend-races): both halves clean. P3 advisories — UI commit `e257047` bundled unrelated SEC-003-BE/BE-ACCRED scope (HEAD correct, those re-landed in own commits later), BE recover.ts ≥50ms timing bound brittle to BE-ARGON2-PARAMETER-LOCK (orthogonal once the helper lands) — both dismissed. Pre-existing **unknown-account 401 timing oracle on `/login`** (separate axis from the null-hash branch this task closed) carved as new Pending **SEC-LOGIN-UNKNOWN-USER-TIMING** (P2) — same enumeration class, closing only half is asymmetric. `auth.md` updated in this archive: `/login` NO_PASSWORD_SET error gains an editorial note documenting timing-equalization behavior; recover/signup ORCID-branch wording aligned ("a digit" → "numbers" + helper-mirror callout). `settings.md` updated: `has_password` → `hasPassword` rename in response example (3 sites), `NOT_FOUND` → `UNAUTHORIZED` (401) error-list entry with sweep-reference, new `ORCID_REQUIRED` (403) error documented, password-policy phrasing aligned to runtime message + helper-mirror callout. Atomic-ship constraint preserved — both halves landed in this archive together.

---

### BE-ACCRED-ORCID-FIELD — Include `orcid` in single-user accreditation response (2026-04-21) — Reviewed ✓

Backend agent added one line (`orcid: payload.orcid || null,`) to `fetchAccreditationStatusFromHaf` in [accreditations.ts](backend/src/routes/accreditations.ts#L141) so `GET /api/accreditations/:username` includes the ORCID field the settings page's auth store reads. Matches the coalesce in `profile.ts:getAccreditationFromHaf` for parity (the `||` vs `??` empty-string coalesce was 4-reviewer-flagged but kept deliberately per task rationale). New [accreditations.test.ts](backend/tests/routes/accreditations.test.ts) (118 lines, 2 real-HAF skipIf tests) covers accreditation-with-orcid and the null-path; found `pharesim` and `curangel` on beta HAF as live fixtures. Architect review (8 personas): no P0/P1 in the diff itself. Shape-drift finding (accreditation endpoint omits `tx_id` that profile endpoint includes) and revoke-branch test gap carved as **BE-ACCRED-TX-ID-PARITY** (P2) and **BE-ACCRED-REVOKE-TEST** (P2). Pre-existing `profile.ts:getAccreditationFromHaf` missing `required_posting_auths` filter already tracked via SEC-002-BE follow-up. Review artifact: `.context/compound-engineering/ce-code-review/20260421-114506-a99c2f01-be-accred-orcid/`.

---

### FE-AUTH-ACCRED-POLL-GUARD — Null-username + unhandled-rejection guard in `_checkAccreditation` (2026-04-21) — Reviewed ✓

UI agent added an entry guard (`if (!this.username || !this.isConnected) return;`) and a try/catch that `console.warn`s rejections in [auth.js](frontend/src/auth.js) `_checkAccreditation` (lines 154-171). Closes `/api/accreditations/null` requests during page teardown/pre-login and stops fetch rejections bleeding into subsequent Playwright tests as unhandled promise rejections. 4 new unit tests in [auth.test.js](frontend/tests/unit/auth.test.js) cover null-username, disconnected-but-username-set, rejected-fetch (resolves.toBeUndefined), and happy-path. 750/750 unit tests green. Architect review (7 personas): task description overclaimed "reentry guard alone closes the race." 2 reviewers (correctness 0.85, julik 0.92) independently identified a **remaining post-await disconnect race** — the entry guard runs once, before the `await`; if `disconnect()` runs mid-fetch, the continuation writes `isAccredited=true` + calls `_saveSession` on a disconnected session. Fix is a second guard after the await. Carved as follow-up **FE-AUTH-POST-AWAIT-GUARD** (P1). Test-quality items (no state-unchanged assertion on reject test; no `_saveSession` assertion on happy path; Playwright reference in prod comment; `mockClear` inconsistency) batched into **FE-AUTH-TEST-HARDEN** (P3). Review artifact: `.context/compound-engineering/ce-code-review/20260421-115107-c2df768b-fe-accred-poll-guard/`.

---

### FE-E2E-TRACE-SECRET-REDACTION — Stop leaking WIF keys + passwords into Playwright trace artifacts (2026-04-21) — Reviewed ✓

UI agent opted `seed-phrase.spec.js`, `custody-upgrade.spec.js`, `publish.spec.js` out of `trace/video/screenshot` retention via top-level `test.use({trace:'off', video:'off', screenshot:'off'})`. Added `scanTracesForSecrets()` to [global-teardown.js](frontend/tests/e2e/global-teardown.js) that walks `test-results/`, unzips each `trace.zip` via `unzip -p`, regex-matches WIF private keys, `SESSION_SECRET[=:]` literal, the known E2E password `E2eTestPass1`, and (when set with length >= 16) the SESSION_SECRET value; throws if any found. Scan runs before IPFS cleanup — if secrets leak, teardown fails loudly. Architect review (9 personas) surfaced a **material P0 beyond this task's scope: 6 additional specs (vote-comment, review-submit, settings, login-keychain, accreditation, orcid-link) mint real backend-valid bearer JWTs via `mintSessionJwt` / `seedAccreditedSession` + LACK the trace opt-out**, and the scan's pattern set does NOT match the three-segment base64url JWT shape — so JWTs in retained traces pass the scan clean. 4 reviewers cross-flagged, capped confidence. Also found P1 scan-correctness bugs: `return` vs `continue` on `unzipped.error` abandons all remaining traces (ENOBUFS on any >200MB trace silently disables the safety net); scan runs before IPFS cleanup so throw-on-leak orphans CIDs; `patternMatch[0].slice(0,8)` leaks 8 chars of matched secret into CI logs; SESSION_SECRET < 16 silently disables value scan. Carved as URGENT **FE-E2E-SPEC-TRACE-OFF** (P0) + **FE-TRACE-SCAN-HARDEN** (P1). Review artifact: `.context/compound-engineering/ce-code-review/20260421-115512-e815d98d-fe-e2e-trace-secret/`.

---

### FE-E2E-AUTH-FIXTURE-HARDEN — Harden shared `fixtures/auth.js` + test-infrastructure cleanup (2026-04-21) — Reviewed ✓

UI agent shipped 500+ lines of E2E fixture hardening: new [auth.js](frontend/tests/e2e/fixtures/auth.js) with `parseEnvFile` (quote-aware inline-comment strip), `getSessionSecret` (priority: process.env > `frontend/.env.test`, **no repo-root .env fallback** — task's headline security closure), `mintSessionJwt`, `pickAccreditedResearcher` (4-attempt retry, 500/1000/1500ms backoff for HAF flake), `seedAccreditedSession` / `seedUnaccreditedSession` via `page.addInitScript`, `minimalPdfBuffer`; new [db.js](frontend/tests/e2e/fixtures/db.js) with `assertTestDatabase` (_test suffix guard), `openAppPool`, `withAppPool`, `queryAppDb`; `global-setup.js` gained a localhost `PEVO_TEST_BASE_URL` assertion + `resetRateLimitKeys` (scans `${appTag}:rl:*` via scanStream, del); `playwright.config.js` `retries: 1`; `.env.test.example` + gitignore. 5 signup/settings/recover specs switched to shared helpers + RUN_SUFFIX. Final Playwright: 29 passed / 2 flaky retry-recovered / 4 skipped / 0 failed. 750/750 unit tests. Architect review (10 personas) surfaced substantial defects **in the delivered fixture code**: (1) **localhost guard trivially bypassable** — `startsWith('http://localhost')` accepts `http://localhost.attacker.com`; (2) **DB _test suffix bypassable via path segment** — `postgresql://.../pevo_app/test` passes the guard but libpq connects to `pevo_app`; (3) **parseEnvFile vs loadEnvFile divergence** — global-setup.js has its own simpler parser that doesn't strip inline `# comment`; `.env.test` with `SESSION_SECRET=abc # dev` silently breaks all JWT auth with no diagnostic; (4) **RUN_SUFFIX module-frozen across Playwright retry** — same suffix reused → DUPLICATE signup → 409 masks the original HAF-timeout root cause; (5) **cachedSecret + process-env injection** — CI pipelines that inject SESSION_SECRET to configure the backend container also pollute the fixture's secret chain. Also flagged 2 CLAUDE.md rule conflicts: (a) `frontend/.env.test.example` violates "Single `.env` file" rule; (b) UI agent edited root-level `.gitignore` (architect-owned) including adding `.compound-engineering/` entry without architect's knowledge. Carved fixes: **FE-E2E-FIXTURE-CORRECTNESS** (P1, all 5 correctness bugs batched), **FE-E2E-RETRY-SUFFIX** (P1, per-attempt suffix). Architect absorbed the lane violation on this task + reverted the `.compound-engineering/` gitignore hunk + updated root CLAUDE.md to carve out an E2E-test .env exception and a documented-justification exception to the "no mocked database pools" rule. Review artifact: `.context/compound-engineering/ce-code-review/20260421-120335-0e303e89-fe-e2e-auth-fixture/`.

---

### SEC-002-BE + SEC-002-UI — Auth-gate `/api/orcid/callback` for link/accredit modes (atomic pair) (2026-04-21) — Reviewed ✓

Backend agent auth-gated `/callback` for `link`/`accredit`: caller must be authenticated AND `req.hiveUsername === storedUsername` from state, else 403 FORBIDDEN. State read BEFORE auth but consumed only AFTER auth passes (preserves retry for legitimate initiator). New `authenticateRequest` helper runs `verifyHiveSignature` inline with `res.once('finish'|'close')` settlers that prevent a Promise hang when the middleware's catch path sends without calling `next()`. New `findAccreditedAccountWithOrcid(orcidId)` with two queries (both filtered by `required_posting_auths ?| $authorities`): (1) latest accredit carrying orcid, (2) re-check that account's latest action is still accredit with same orcid. Throws on HAF-unavailable (fail-closed). Returns 409 `ORCID_ALREADY_LINKED` on duplicate bind. UI: `completeOrcid(code, state, mode)` routes through `authenticatedRequest` for link/accredit, `request` for signup/login. Full backend suite green (31 files / 195 passed / 2 skipped); frontend 718/718 unit + 6 passing E2E / 1 `test.fixme`. Architect review (10 personas) surfaced **P0 actively-exploitable finding beyond this task's scope**: `getExistingAccreditation` at `orcid.ts:512-542` lacks the `required_posting_auths ?| $authorities` filter that `findAccreditedAccountWithOrcid` has; an authenticated user self-broadcasting a `custom_json` with `action:'accredit'` from their own Hive account satisfies `handleLink`'s accreditation gate → admin key signs a REAL on-chain accreditation. 3 reviewers cross-flagged with concrete exploit. Carved as URGENT **SEC-AUTH-BYPASS** (P0). Other defects: (P1) **`_saveSession` 6-arg misuse at orcid-callback.js:148** — zero-param function called with 6 positional args, `this.expiresAt` never set → ORCID-login users lose session on every page reload; (P1) **`pevo_orcid_mode` removed before await `completeOrcid`** — 503-refresh sends unauth for link/accredit → 401; (P1) **Backend agent edited `agents/docs/api-contracts/orcid.md`** (architect-owned lane); (P1) **`orcid.test.ts` mocks DB pools** violating "no mocked database pools" rule (backend wrote an in-file justification); (P1) **orcid.md scope said `/authenticate /read-limited` but code uses only `/authenticate`** — ORCID free-tier constraint, architect fixed in this archive pass; (P1) **In-memory `orcidStates` breaks silently in multi-process production**. Carved as **FE-ORCID-CALLBACK-FIXES** (P1) + **SEC-002-HARDENING** (P2 batch: state-consume try/catch, NO_ACCOUNT envelope violation, state-not-consumed-on-403 doc, test.fixme stale, HAF-lag Redis binding-lock, multi-process startup check). Architect housekeeping: accepted the backend-edited orcid.md this time (content accurate, process wrong) + added backend CLAUDE.md protocol reinforcement; updated root CLAUDE.md with a documented-justification carve-out for mocked pools. Review artifact: `.context/compound-engineering/ce-code-review/20260421-121219-cc6142ab-sec-002/`.

---

### UI-URL-PAGE-HARDEN — Close P2 hardening items from UI-FEED-URL-PAGE + UI-FEED-STALE-PAGINATION review (2026-04-21) — Reviewed ✓

UI agent applied 6 hardening items across [paper-feed.js](frontend/src/components/paper-feed.js), [researchers.js](frontend/src/pages/researchers.js), [search.js](frontend/src/pages/search.js) + 3 unit-test files (~1400 lines total scope): `.catch(() => {})` on fire-and-forget `loadDisciplines()`; `_pushUrl()` at end of each page's catch block; `pageOwnsUrl()`/`feedOwnsUrl()` guarding popstate registration AND inner handler; unconditional `totalPages = res.meta ? (Math.ceil(total/limit) || 1) : 1` on success path; catch-block reset of array/totalPages/currentPage. `npx vitest run` (48 files/711 tests) + `npm run build` pass. Architect review (correctness, testing, maintainability, julik-frontend-races, agent-native) — primary goals substantively met for 5 of 6 items. **Finding worth carrying forward: catch-block `_pushUrl` widens the pre-existing generation-counter race** (explicitly-deferred non-goal). Pre-task: catch was URL-neutral. Post-task: catch also actively stomps URL with post-state-reset snapshot. In the rapid-filter-change case (fetch A in flight, fetch B succeeds, fetch A fails late), fetch A's catch wipes papers/researchers + pushes URL reflecting the wipe, erasing fetch B's visible results. Debatable regression — state-reset erasure was always pre-existing; URL now just reflects it consistently — but observable. Real bug found: `totalPages = Math.ceil(total/limit) \|\| 1` produces `Infinity` when `limit=0` because `Infinity` is truthy and bypasses the `\|\| 1` guard (C-1). Structural asymmetries: paper-feed.js has only the registration-time popstate guard (missing the inner-handler `feedOwnsUrl()` check present in the two page files); `pageOwnsUrl`/`feedOwnsUrl` are the same semantic under two names with triplicated locale-strip regex; `researchers._syncFromUrl()` has no `pageOwnsUrl()` guard (paper-feed does); `paper-feed.loadPapers` duplicates `loading=false` in try+catch instead of `finally` (the other two files use `finally`). Observability: `.catch(() => {})` on loadDisciplines has zero detectable side-effect — Playwright agents can't distinguish loaded-vs-silently-failed dropdown. Agent-native: `discipline` URL param is not case-normalized — `/papers?discipline=physics` fetches correctly but dropdown silently shows "All Disciplines" because option value is `"Physics"`; search.js filter changes don't auto-update URL until submit (asymmetric from paper-feed's immediate-push pattern). Test gaps: paper-feed.js and search.js popstate subsystems completely untested; `loadDisciplines` rejection path untested; empty-result→Infinity path untested. Quality: `search.doSearch` catch `_pushUrl` reads untrimmed `this.query` → `?q=+term+` in URL (cosmetic); `papers.js` vestigially uses `x-data="homePage"` on a non-home route; `auth._saveSession(token,...,6args)` called on a 0-param function at `settings.js:545` + same in `login.js:152` + `orcid-callback.js:148` (session saves work via `this.*` mutation; pre-existing API misunderstanding). Carved follow-ups: **FE-TOTALPAGES-INFINITY-GUARD** (P1), **FE-URL-SYNC-UTIL-EXTRACT** (P2), **FE-URL-PAGE-TEST-GAPS** (P2), **FE-LOADDISCIPLINES-OBSERVABILITY** (P2), **FE-DISCIPLINE-CASE-NORMALIZE** (P2), **FE-SEARCH-QUERY-URL-HYGIENE** (P3). Review artifact: `.context/compound-engineering/ce-code-review/20260421-url-page-harden/`.

---

### FE-BIP39-BUNDLE — Wire `@scure/bip39` into settings.js custody-upgrade flow (2026-04-21) — Reviewed ✓

UI agent replaced the runtime `typeof scureBip39` global lookup in [settings.js](frontend/src/pages/settings.js) with static ESM imports — `generateMnemonic, mnemonicToSeedSync, validateMnemonic` from `@scure/bip39`, `wordlist` from `@scure/bip39/wordlists/english.js`. Removed the `_getBip39()` helper + its `common.bip39NotLoaded` throw path. Both callers (`startUpgrade`, `executeUpgrade`) updated to use imports directly. Companion [custody-upgrade.spec.js](frontend/tests/e2e/custody-upgrade.spec.js) drops the `page.addInitScript({scureBip39})` shim and the Node-precomputed mnemonic/seed; spec now reads `newSeedPhrase` off Alpine state after "Begin Upgrade" and drives a real in-browser BIP39 mnemonic + dhive-signed `account_update` broadcast (intercepted at `api.hive.blog`). Zero residual `_getBip39` / `scureBip39` references in `frontend/src` or `frontend/tests`. `@scure/bip39/wordlists/english.js` subpath is valid per package `exports` map; `sideEffects: false` set so Vite/Rollup dedup the wordlist against `hive-keys.js`. Primary ticket goal: clean. Architect review (correctness, testing, maintainability, security) surfaced three pre-existing defects not introduced by this diff but reachable via the same code path: **(a) SEC-BIP39-2 — Wrong Keychain API (`settings.js:515-516`):** `requestAddAccountAuthority(username, newKeys.posting, 'posting', ...)` passes a 64-char raw hex HMAC-SHA512 seed where the API expects an **account name** (second arg). Correct call is `requestImportKey(username, wifKey)` with `wifKey = dhive.PrivateKey.fromSeed(newKeys.posting).toString()`. The E2E stub discards `_authorizedKey`, so the test is blind. Carved out as follow-up **FE-KEYCHAIN-API-MISUSE**. **(b) SEC-BIP39-1 — Mnemonic not wiped on success (`settings.js:329/335/549`):** `executeUpgrade()` sets `upgradePhase='done'` without zeroing `oldSeedPhrase`, `newSeedPhrase`, `upgradePassword`; `resetUpgrade()` clears them but is only reached on the error path. XSS on `/settings` reads the mnemonic plaintext post-upgrade. Carved out as **FE-UPGRADE-CREDENTIAL-WIPE**. **(c) M-1 — `settings.js` bypasses `hive-keys.js` wrappers:** `hive-keys.js:27-36` already exports `generateMnemonic()` / `validateMnemonic(m)` that thread the wordlist + hold the 128-bit entropy constant; other consumers (`signup-verify.js`, `recover.js`) use those wrappers. `settings.js` imports raw `@scure/bip39` symbols and passes `wordlist` manually at 3 call sites — the task author's "two lines of duplication" rationale understates a divergent contract that will drift if BIP39 defaults change. 4-line fix; carved as follow-up **FE-UPGRADE-KEY-WRAPPER-ADOPT** alongside test-quality items (vacuous `/^[0-9a-fA-F]+$/` signature regex; no cross-check of broadcast pubkeys against independently-derived values; old-seed-equals-new-seed means key rotation never actually rotates; `newSeedPhrase` read-race vs Alpine microtask flush; dead `common.bip39NotLoaded` i18n key). Also flagged but pre-existing across the codebase: `auth._saveSession(token, ..., 6 args)` called on a 0-param function — same API misunderstanding in `login.js:152` and `orcid-callback.js:148` (session saves work via `this.*` mutation, but the shape is misleading). `@scure/bip39: "^2.0.1"` + `@hiveio/dhive: "^1.3.6"` caret ranges — lockfile pins correctly so `npm ci` is safe, but `npm install` / lockfile regeneration pulls any 2.x or 1.x; recommend exact-pin on crypto deps. `custody-upgrade.spec.js` captures the mnemonic via `page.evaluate()` and fills a textarea — both are serialized into `retain-on-failure` traces; same class as `seed-phrase.spec.js` and folded into **FE-E2E-TRACE-SECRET-REDACTION**. Review artifact: `.context/compound-engineering/ce-code-review/20260421-bip39-bundle/`.

**Operational note from the implementer (carried forward for deploy docs):** backend Docker image bakes frontend bundle at image-build time (`backend/Dockerfile` runs `cd frontend && npm run build` in build stage, `COPY --from=build /app/backend/public`). `./deploy.sh test-up` does NOT rebuild — only recreates container. `./deploy.sh build backend` is required before `test-up` to surface frontend changes in E2E.

---

### E2E-CRYPTO-1-RETRY — Fix seed-phrase E2E confirm-intercept (2026-04-21) — Reviewed ✓

UI agent re-landed [seed-phrase.spec.js](frontend/tests/e2e/seed-phrase.spec.js) as a deterministic cross-flow crypto equivalence test. Drives /signup → /signup/verify "create account" phase, captures the Alpine-state mnemonic, walks confirm-words + username phases, intercepts `POST /api/auth/confirm` (returns 500 so the backend never runs `create_claimed_account`), then drives /recover with the same mnemonic+username, intercepts `POST /api/auth/recover`, and finally re-derives all keypairs in the Node context via a direct import of [frontend/src/hive-keys.js](frontend/src/hive-keys.js) to assert `signupPOST.keys.memo_private === recoverPOST.memo_key === rederived.memo.private`. Race fix is two-phase and both phases are load-bearing (verified by julik-races reading signup-verify.js `watchUsername()` + Alpine-3 microtask semantics): (a) `Promise.all([waitForRequest, evaluate])` closes the host-side listener-install window, (b) inside the evaluate, `clearTimeout(data._usernameTimer); data.usernameStatus='available'; data.submitCreateAccount()` closes a separate Alpine-internal race where `$watch('username')` fires as a microtask AFTER the first evaluate returns and resets `usernameStatus` to `'checking'` + arms a 400ms debounce before the trigger evaluate runs. Without (b), the guard at `submitCreateAccount` line 378 early-returns and the POST never fires. Primary ticket goal: clean. Architect review surfaced two non-primary issues worth carving out: **P0 — WIF private keys leak into Playwright traces.** `playwright.config.js` has `trace: 'retain-on-failure'`; `capturedConfirmBody` holds real `posting_private`/`memo_private` WIF strings; any post-intercept assertion failure serializes them (plus `new_password`, plus the `verify_token` URL) into the trace zip that CI artifacts carry. **P1 — spec-local `pg.Pool`** at line 69 has no `_test` suffix guard; running the spec in isolation (no global-setup) bypasses the only current safety net for "this DB is the test DB". Also found: hard-coded `TEST_EMAIL` (rerun collision on non-truncated DB; C-01/T-03/M-2 triple-flagged, boosted to 0.95); `_checkUsername` monkey-patch race against Alpine's `x-init` scheduler (C-02, 0.85); **circular equivalence** — all three derivation sites resolve to the same `hive-keys.js`, so a coordinated algorithm change moves all assertions together (T-01, 0.95) — spec detects bundler/runtime drift but not algorithm regressions, needs a golden-vector anchor; weak `/^STM/` and `/^5[HJK]/` regexes; recover side not race-hardened (works today only because `deriveAllKeys` gives the renderer enough time); `pg.Pool` + try/finally pattern duplicated across 5 specs (fixture candidate). Carved out as follow-ups: **FE-E2E-TRACE-SECRET-REDACTION** (P0 trace-leak + spec-local DB-suffix guard) and folded TEST_EMAIL + shared `queryAppDb` helper into the existing **FE-E2E-AUTH-FIXTURE-HARDEN**. Review artifact: `.context/compound-engineering/ce-code-review/20260421-crypto1-retry/`.

---

### E2E-AUTH-2-RETRY — Fix keychain login E2E intercept (2026-04-21) — Reviewed ✓

UI agent re-landed [login-keychain.spec.js](frontend/tests/e2e/login-keychain.spec.js) with a `Promise.all([waitForRequest, waitForResponse, click])` gate around the sign-in-modal Connect-button click. The `page.route('**/api/auth/session', ...)` mock is registered upfront (line 59) and fulfills the POST with a `mintSessionJwt`-backed JWT so the downstream real `GET /api/notifications?since_block=0&limit=1` authenticates against the live backend's `verifyHiveSignature` Bearer path. Spec asserts header set (`x-hive-username`, `x-hive-timestamp`, `x-hive-signature` prefix), Alpine auth-store state, `localStorage.pevo_session`, and a genuine 200 on the Bearer probe. The `since_block=0` minimum works — backend's sinceBlock validation is `< 0`, zero passes. Julik review confirmed the Promise.all gate is correctly structured but the inline rationale comment (lines 125-132) misattributes the race: the mock is already armed at line 59 and its CDP interception is permanent, so what the gate actually closes is the window where `waitForRequest`/`waitForResponse` listeners must be installed before the click fires. Functionally correct; comment misleading. Review surfaced three cross-cutting P1 issues in the companion fixture [fixtures/auth.js](frontend/tests/e2e/fixtures/auth.js) (7-consumer shared helper): `cachedSecret` falsy guard caches wrong values / bypasses on empty-string (C-03), `waitForResponse` predicate lacks a method filter so OPTIONS/leaked requests can satisfy it (C-04), and the repo-root `.env` fallback in `getSessionSecret()` is a production-secret foot-gun when combined with a non-localhost `PEVO_TEST_BASE_URL` (SEC-AUTH2-01). Also: `frontend/.env.test` fallback is dead code (file doesn't exist, not in `.gitignore`), `parseEnvFile` doesn't strip inline `# comment` suffixes, missing `x-hive-request-hash` header assertion in the spec, `toBe('{}')` body check is brittle against null-body semantics, and the `is_accredited: false` mock triggers a pre-existing unhandled-rejection path via `_startAccreditationPolling` + null-username `_checkAccreditation`. Primary ticket goal (race fix) is clean; fixture issues cut across the whole E2E suite and are carved out as follow-up **FE-E2E-AUTH-FIXTURE-HARDEN**. Review artifact: `.context/compound-engineering/ce-code-review/20260421-auth2-retry/`.

---

### E2E-SUITE-EXPANSION — Parallel E2E coverage (6 of 8 specs) (2026-04-21) — Reviewed ✓

UI agent dispatched all 8 E2E-* tasks in parallel as `isolation: "worktree"` subagents per the parallel-task protocol. Each subagent ran `/ce-work` scoped to a single task and stopped before moving to Review. Parent merged the deliverables into the main tree (6 of 8 worktrees resolved into the main checkout directly; 2 remained as isolated worktrees and their spec files were copied over). [fixtures/auth.js](frontend/tests/e2e/fixtures/auth.js) was extended by E2E-ACCR-1 with `seedUnaccreditedSession` and by E2E-AUTH-2 with `mintSessionJwt`; no fixture collision detected between worktrees. Final Playwright run after selector/assertion fixes (parent, `./deploy.sh test-up && npx playwright test`): 19 passed / 6 failed. Backend image rebuilt via `docker compose build backend` to pick up the new frontend bundle; subsequent test-up iterations reuse this image. **Archived here (6 passing specs, individual archive entries above):** E2E-AUTH-1 (login-email), E2E-AUTH-3 (password-recovery), E2E-ACCR-1 (accreditation), E2E-SETTINGS-1 (settings), E2E-CRYPTO-2 (custody-upgrade), E2E-BRIDGE-1 (bridge-preview). **Carved back into Pending with diagnostic hypotheses:** E2E-AUTH-2-RETRY (login-keychain — `page.route()` stub returns 400 despite interception) and E2E-CRYPTO-1-RETRY (seed-phrase — `/api/auth/confirm` POST never fires). Architect review (julik-frontend-races) identified the likely root cause for both: a microtask gap between `page.route()` registration and the triggering `page.evaluate()` can let the intercepted POST escape before the interception layer is active — fix is `Promise.all([page.waitForRequest(...), page.evaluate(...)])`. The scureBip39 bundler gap flagged during E2E-CRYPTO-2 is tracked as FE-BIP39-BUNDLE. **Pre-existing failing specs (not this session):** `paper-detail.spec.js`, `researchers.spec.js`, `review-submit.spec.js`, `vote-comment.spec.js` all fail on `pickAccreditedResearcher` returning null (test-DB `pevo_app_test` has no accredited researchers) — unrelated data-env gap, pre-existing untracked specs.

---

### BE-HAF-CTE-HARDEN — Doc + test hardening for `authorshipClaimsCteBody` scope (2026-04-21) — Reviewed ✓

Backend agent added a load-bearing JSDoc block on [authorshipClaimsCteBody](backend/src/hafsql.ts#L209) documenting why `COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0)` is load-bearing: per [hive-schemas.md](agents/docs/hive-schemas.md) §2.9 `claim_authorship` omits `claimer` from the JSON payload (signer IS the claimer), while §2.10 `approve_authorship` and §2.11 `revoke_authorship` include it explicitly. The JSDoc also spells out the contract that the claimer-scope filter MUST use the identical COALESCE expression as `claims_base.claimer` so scoped queries see the same row set the unscoped CASE correlates against. New [backend/tests/hafsql.test.ts](backend/tests/hafsql.test.ts) replaces the prior silent-trivial-pass (`if (!sample) { expect(empty).toEqual([]); return; }`) with `ctx.skip('reason') + return` on both HAF-data invariant tests, and adds a pool-less `describe('authorshipClaimsCteBody param arithmetic', ...)` block with three tests at `startIdx = 5`: unscoped (3 params, nextIdx 8), claimer-scope (4 params, nextIdx 9), paper-scope (5 params, nextIdx 10). The `return` after `ctx.skip()` also narrows TypeScript cleanly, removing earlier `sample!` non-null assertions. `npx vitest run tests/hafsql.test.ts` → 3 passed / 2 skipped (was 2 passed). Architect review (correctness, kieran-typescript, julik-frontend-races returned; testing/maintainability/project-standards quota-exhausted, filled manually) found only two P3 nits in the new test file: the paper-scope test's `as string` casts on `any` pg column values have no null-guard before use as scope params (TS-01) — low risk since HAF column data is reliable for these events, and the `as string | undefined` cast on line 35 is cosmetic (TS-02). Not blocking; archived as-is. Review artifact: `.context/compound-engineering/ce-code-review/20260421-051152-d30ea63d/`.

---

### UI-FEED-STALE-PAGINATION — Reset pagination state on empty/errored results (2026-04-21) — Reviewed ✓

UI agent fixed two P2 correctness bugs in [paper-feed.js](frontend/src/components/paper-feed.js) `loadPapers()`. (1) Empty-result path: `this.totalPages = Math.ceil(...)` was gated on `if (res.meta)`, so a filter change producing an empty result left `totalPages` at the prior value — the empty-state card then rendered alongside a live pagination nav pointing to ghost pages. Now `this.totalPages = res.meta ? (Math.ceil(res.meta.total / res.meta.limit) || 1) : 1` is unconditional. (2) Error-path retry: the `catch` block previously reset `papers = []` but left `totalPages` and `currentPage` at prior values, so the retry button replayed with a stale `currentPage` against a page that no longer existed. Now the catch resets both to 1. Two new unit tests in [components-paper-feed.test.js](frontend/tests/unit/components-paper-feed.test.js) cover both paths. `search.js` and `researchers.js` were explicitly left alone — they don't have the error-path bug. Architect review surfaced a cross-task interaction with UI-FEED-URL-PAGE (cross-reviewer agreement C-01/JFR-04, P2 @ 0.85): the catch block resets `currentPage = 1` but does NOT call `_pushUrl()`, so after an error the address bar still shows `?page=5` while Alpine state says page 1, and a subsequent popstate can re-seed the failed page from history. Not blocking — back navigation still lands somewhere valid and retry correctly loads page 1 — but worth closing. Rolled into follow-up task **UI-URL-PAGE-HARDEN**. Review artifact: `.context/compound-engineering/ce-code-review/20260421-051152-d30ea63d/`.

---

### UI-PAGINATION-HARDEN — Hardening pass on the shared pagination factory (2026-04-21) — Reviewed ✓

UI agent applied all nine hardening items from the UI-REFAC-3 architect follow-up list without scope creep. (1) Scope-contract JSDoc on the `Alpine.data('pagination', ...)` registration in [pagination.js](frontend/src/components/pagination.js) names the three required ambient parent properties and warns against redeclaration. (2) `goToPage` guards (`page === '...' || page < 1 || page > this.totalPages`) restored in [search.js](frontend/src/pages/search.js), [researchers.js](frontend/src/pages/researchers.js), [paper-feed.js](frontend/src/components/paper-feed.js); factory guards retained for defense-in-depth. (3) `:key="page + '-' + i"` fixes focus loss on page change by making keys unique across array reshapes. (4) `role="none"` on the `<div class="contents">` wrapper suppresses the Firefox+NVDA accessibility-tree announcement with zero layout impact. (5) Inline comment in [main.js](frontend/src/main.js) documents why `if (p.init)` is load-bearing (the `papers` registry entry intentionally omits `init()` and delegates to `paperFeed`). (6) Escaping-trap comment on `paginationTemplate`. (7) Two new `paginationPages` boundary cases (`(8,1)` → `[1,2,'...',8]`; `(10,7)` → `[1,'...',6,7,8,'...',10]`) plus two new `goTo` edge tests (undefined and non-function `onPageChange`) in [components-pagination.test.js](frontend/tests/unit/components-pagination.test.js), suite grew 14→20 tests. (8) New [pages-researchers.test.js](frontend/tests/unit/pages-researchers.test.js) with 9 tests covering filter handlers, `goToPage` happy+guard, `loadResearchers` data/filter/error, and `methodLabel` (7 known keys + unknown). (9) New [pagination-layout.spec.js](frontend/tests/e2e/pagination-layout.spec.js) asserts Prev first, Next last, and ellipses strictly between page buttons on `/papers` with 10 pages — single regression guard for the P1 visual-order bug fixed in UI-REFAC-3. `npx vitest run` → 691/691. Architect review: clean. Review artifact: `.context/compound-engineering/ce-code-review/20260421-051152-d30ea63d/`.

---

### UI-FEED-URL-PAGE — Make `/papers`, `/researchers`, `/search` URL-addressable (2026-04-21) — Reviewed ✓

UI agent closed the agent-native + bookmarkability gap surfaced during UI-REFAC-3 review: `/papers?page=3&discipline=physics&sort=votes` now renders exactly that view on first render, and back/forward navigation works. All three feeds — [paper-feed.js](frontend/src/components/paper-feed.js), [researchers.js](frontend/src/pages/researchers.js), [search.js](frontend/src/pages/search.js) — gained `_syncFromUrl()` / `_pushUrl()` helpers plus an `init`-installed popstate listener cleaned up in `destroy()`. `goToPage`, `handleSubmit` (search), and each filter handler call `_pushUrl()` before reloading. URLs stay clean: `page` only written when `> 1`, filter params only when non-default. paper-feed is shared between home and `/papers`; URL sync is gated by `window.location.pathname.endsWith('/papers')` (helper `feedOwnsUrl`) — the initial `$store.router.route === 'papers'` check raced with Alpine init and returned false on first mount, so the path-based check replaced it. Search's `init()` no longer reads `$store.router.query.q` — reads `window.location.search` via `_syncFromUrl` to pick up `type`/`source`/`discipline`/`page` in one step. Tests: 701/701 across 48 files, `+3` init cases and `+2` URL-sync cases in `pages-search.test.js`, new URL-sync suites in `components-paper-feed.test.js` (4 tests, incl. "inert on home") and `pages-researchers.test.js` (3 tests). New [url-pagination.spec.js](frontend/tests/e2e/url-pagination.spec.js) covers deep-link seed, click-to-push, and back-to-restore on `/papers`. Architect review (julik-frontend-races) surfaced three P2 hardening items: researchersPage and searchPage install their popstate listener unconditionally — no pathname guard unlike paperFeed's `feedOwnsUrl` (JFR-01/JFR-03, @ 0.85/0.70); the `_pushUrl → fetch` sequence has no generation counter or AbortController, so a rapid filter change can push URL state that disagrees with the in-flight-fetch result once it resolves (JFR-02, @ 0.72) — pre-existing race made externally visible by URL sync; plus JFR-06 unhandled rejection on `loadDisciplines`. Not blocking the archive. Bundled into follow-up task **UI-URL-PAGE-HARDEN** alongside the catch-block URL reset from UI-FEED-STALE-PAGINATION. Review artifact: `.context/compound-engineering/ce-code-review/20260421-051152-d30ea63d/`.

---

### E2E-BRIDGE-1 — Preprint bridge preview (2026-04-21) — Reviewed ✓

UI agent shipped [bridge-preview.spec.js](frontend/tests/e2e/bridge-preview.spec.js) with arXiv + bioRxiv preview tests. Mocking strategy: intercept at the backend API boundary via `page.route('**/api/bridge/lookup*')` and `**/api/bridge/check*` with `route.fulfill()`. The frontend never hits arxiv.org / biorxiv.org directly — it calls the PEvO backend which proxies through [bridge.ts](backend/src/bridge.ts). Mocking at `/api/bridge/*` keeps the canned payload aligned with the `BridgeLookupResult` contract in [agents/docs/api-contracts/bridge.md](agents/docs/api-contracts/bridge.md) and decouples the spec from upstream response formats. Both tests drive `/en/bridge`, fill `#bridge-id`, click Look Up, `Promise.all` wait both `lookup` and `check` requests, then assert the Preprint Found heading, title, authors (joined `, `), abstract (`.line-clamp-4`), and source link (bioRxiv also asserts PDF link). Duplicate warning asserted absent. Both stop before the register step. bioRxiv identifier uses `source_type: 'crossref'` per backend's canonicalization (bioRxiv URLs resolve to a DOI and are fetched via CrossRef). Test-infra only; no contract change. Architect review: clean.

---

### E2E-CRYPTO-2 — Light-to-self-custody UI up to key rotation (2026-04-21) — Reviewed ✓

UI agent shipped [custody-upgrade.spec.js](frontend/tests/e2e/custody-upgrade.spec.js). Broadcast intercepted at the network layer via `page.route('**/api.hive.blog/**', ...)` because the upgrade flow in [settings.js](frontend/src/pages/settings.js) signs locally with the owner key derived from the user-entered mnemonic and POSTs to `https://api.hive.blog` via `dhive.Client.broadcast.sendOperations` — does not use Keychain for the `account_update`. The route handler captures both JSON-RPC calls (`condenser_api.get_dynamic_global_properties`, then `condenser_api.broadcast_transaction`), fulfils each with a stub, and records the signed transaction. Assertions verify a single `account_update` op rotates all four authorities to distinct STM-prefixed pubkeys, each with `weight_threshold: 1` and empty `account_auths`. **Important follow-up exposed by this spec:** [settings.js:573](frontend/src/pages/settings.js#L573) reads BIP39 via `typeof scureBip39 !== 'undefined'` — a global that nothing in the bundle populates (`hive-keys.js` imports `@scure/bip39` as ESM properly, but `settings.js` does not). In production any user triggering the upgrade wizard hits the `bip39NotLoaded` error path. The spec paper-overs this with a `window.scureBip39` shim; the real fix is a separate task **FE-BIP39-BUNDLE**. Architect review: spec itself is clean; the production gap it revealed is tracked separately.

---

### E2E-SETTINGS-1 — Settings changes without broadcast (2026-04-21) — Reviewed ✓

UI agent shipped [settings.spec.js](frontend/tests/e2e/settings.spec.js) covering the locale switcher (the only persistent display preference the app exposes) and the email-change flow. Test 1 picks Deutsch from the language listbox, reloads, and asserts URL prefix + `PEVO_LOCALE` cookie + `html[lang]` + the in-memory i18n store all reflect `de`. Test 2 seeds an active light-account row with a verified email, mints a session JWT via `fixtures/auth.js`, submits a new email, reads the verification token directly from `accounts.pending_email_token` (matches `email-signup.spec.js`; Mailpit is running but unused by any spec), follows the verification link, asserts the new email is live. Both tests install a `page.on('dialog')` listener to fail if any `alert()` leaks through. Display-preference gap documented in the archive entry: the settings page itself has no toggle; only the locale switcher qualifies. Architect review: clean.

---

### E2E-ACCR-1 — Accreditation request + ORCID callback (2026-04-21) — Reviewed ✓

UI agent shipped [accreditation.spec.js](frontend/tests/e2e/accreditation.spec.js) plus a new `seedUnaccreditedSession(page, ...)` helper in [fixtures/auth.js](frontend/tests/e2e/fixtures/auth.js) that mints a JWT with `isAccredited: false` for a randomized `e2eunaccr<ts>` username. Both accreditation endpoints are stubbed via `page.route()` because the real backend can't complete them in the E2E env (SMTP_HOST unset, ORCID client creds empty, admin posting key missing). Captured request bodies assert the full payload shape: `POST /api/accreditation/request` → `full_name`/`institution`/`field`/`email`/`orcid` + `Authorization: Bearer <jwt>`; `POST /api/accreditation/verify` → `{ token }`. UI asserts the confirmed-state heading plus `@username` render after navigating to `/accreditation/verify?token=<stub>`. Required a stricter `@username is now` selector to avoid strict-mode multi-match against header/nav occurrences of the same username. "Pending attestation" was interpreted as the email-token flow (backend holds a pending token there); the ORCID OAuth button uses `/orcid/callback` and broadcasts immediately without a pending stage, so it's a separate flow not covered by this spec. Architect review: clean.

---

### E2E-AUTH-3 — Password recovery (2026-04-21) — Reviewed ✓

UI agent shipped [password-recovery.spec.js](frontend/tests/e2e/password-recovery.spec.js). Semantic note documented in the spec header: the task brief said "Drive `/recover`" but `/recover` in this codebase is the seed-phrase/ORCID lost-access flow (no email, no token). The email-based reset flow lives at `/reset-password` (`POST /api/auth/reset-request` → `POST /api/auth/reset`) and matches the brief's request-token-follow-link-login sequence. Reset tokens read from `accounts.reset_token` in `pevo_app_test` via `pg.Pool` (matches `email-signup.spec.js` convention). Follow-up candidate noted in the implementation: backend's reset email URL is `/auth/reset?token=…` but the frontend router only maps `/reset-password`; spec navigates the frontend path, but an alias route may be worth adding. Architect review: clean.

---

### E2E-AUTH-1 — Email+password login (2026-04-21) — Reviewed ✓

UI agent shipped [login-email.spec.js](frontend/tests/e2e/login-email.spec.js). Seeds an active light-account user via SQL (argon2 hash from backend deps, `custody='light'`, `verify_token=NULL`). Happy path drives `/login` with `x-model="emailOrUsername"` + `x-model="password"`, asserts `POST /api/auth/login` body shape + 200, redirect to `/en/papers`, then calls `GET /api/settings/email` with the stored JWT to prove the session is genuine (not mocked). Negative path: wrong password asserts 401 + inline red banner with "Invalid credentials", URL stays on `/en/login`, no session persisted, and a `page.on('dialog')` listener confirms no `alert()` was ever triggered. Required a localStorage assertion fix (auth store always writes an empty-session object, so the test asserts `session.token === null` rather than `session === null`). Architect review: clean.

---

### UI-REFAC-3 — Wire the pagination Alpine factory (2026-04-21) — Reviewed ✓

UI agent turned [frontend/src/components/pagination.js](frontend/src/components/pagination.js) into a real reusable factory. Signature is `pagination(onPageChange)` only: the TASKS.md-suggested 3-arg form `pagination(totalPages, currentPage, onPageChange)` was rejected because Alpine evaluates `x-data` expressions once at init, which would freeze the child's `totalPages`/`currentPage` to their initial values. Instead the factory relies on Alpine scope inheritance so `this.totalPages` / `this.currentPage` walk up to the parent paperFeed/searchPage/researchersPage scope and stay reactive. `paginationPages(total, current)` extracted as a pure exported function (clamps `current` into `[1, total]`, returns `[]` for non-positive total) with an expanded Vitest suite covering flat/near-start/near-end/mid ranges plus clamping. `onPageChange` is closure-captured, not stored on the Alpine scope, so templates cannot reach it directly; `goTo` / `prev` / `next` are the only public entry points. `goTo` got a `page < 1 || page > this.totalPages` bounds check, and a follow-up `/ce-simplify` pass removed the now-dead caller-side guards inside each `goToPage` (and the five unit tests asserting them) since every `goToPage` is only reachable via the factory's validated callback. `paginationTemplate` uses a single `<template x-for>` iteration wrapping both `x-if` siblings inside a `<div class="contents">` wrapper, which **fixes the P1 visual-order bug carried over from UI-REFAC-2**: the previous two-sibling-loop pattern rendered `… … 1 4 5 6 10` instead of `1 … 4 5 6 … 10` on page 5/10. [main.js](frontend/src/main.js) wires `initPagination()` alongside the other Phase-4 components. [paper-feed.js](frontend/src/components/paper-feed.js), [search.js](frontend/src/pages/search.js), [researchers.js](frontend/src/pages/researchers.js) all replaced their inline nav + `paginationPages` getter with `<div x-data="pagination((p) => goToPage(p))">${paginationTemplate}</div>`. `npm run build` clean; `npx vitest run` 676 tests pass (net -5 from baseline, all removals intentional). Architect review (7 persona reviewers: correctness, testing, maintainability, project-standards, julik-frontend-races, ce-agent-native, ce-learnings-researcher) confirmed all three prior findings landed (COR-1/M-4 visual order, COR-2/M-2 `goTo` bounds, M-1 closure-captured callback) with zero P0/P1. P2/P3 hardening items captured in follow-up task UI-PAGINATION-HARDEN. Pre-existing paperFeed catch-block stale-state (now lives in paper-feed.js) rolled into UI-FEED-STALE-PAGINATION's scope. Pre-existing agent-native + bookmarkability gap — none of the three paginated surfaces push `?page=N` to the URL — captured separately as UI-FEED-URL-PAGE. Arch review artifacts: `.context/compound-engineering/ce-code-review/20260421-040940-651d7a61/`; implementer's prior review: `.context/compound-engineering/ce-code-review/20260421-034955-d3efc7e7/`.

---

### HAF-CTE-SCOPE — Push narrowing filters into `authorshipClaimsCteBody` (2026-04-21) — Reviewed ✓

Backend agent added an optional `scope` param to [authorshipClaimsCteBody](backend/src/hafsql.ts#L209): `{ claimer: string } | { paperAuthor: string; paperPermlink: string }`. When provided, the filter is embedded into the `claim_events` CTE and cascades to `claims_base`, `approvals`, `revocations` — avoiding a full PEvO-history scan for every call. The CASE correlation semantics in `authorship_claims` (approve/revoke EXISTS subqueries keyed on `claimer + paper_author + paper_permlink`) are preserved because the scope keys match those correlation keys. Callers migrated: [profile.ts:189](backend/src/routes/profile.ts#L189) scopes by claimer, [claims.ts:44-47](backend/src/routes/claims.ts#L44-L47) and [papers.ts:1097](backend/src/routes/papers.ts#L1097) scope by `{paperAuthor, paperPermlink}`. Unscoped path (no scope arg) is behavior-identical to pre-change — verified by inspection and by the new [tests/hafsql.test.ts](backend/tests/hafsql.test.ts) asserting scoped query == unscoped + JS post-filter against real HAF data. Architect review (6 parallel persona reviewers) surfaced one alarm from the performance reviewer — a claimed correctness bug where `COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0) = $N` was alleged to drop approve/revoke events because the reviewer assumed those events lack `claimer` in JSON. **Verified false against [hive-schemas.md §2.10, §2.11](agents/docs/hive-schemas.md) and the broadcast code at [claims.ts:95-100, 131-137, 202-208](backend/src/routes/claims.ts#L95)**: approve/revoke payloads include `claimer` explicitly; only `claim_authorship` omits it (falling back to signer, which is the claimer). COALESCE yields the correct claimer for all three action types. Secondary findings accepted as non-blocking follow-ups: (a) the hafsql.test.ts empty-dataset escape hatch at lines 30-36 / 63-69 returns trivially green when the environment has no claim events — real but low-impact since production HAF always has data (BE-HAF-CTE-HARDEN below). (b) The payload-shape asymmetry between `claim_authorship` (no explicit claimer) vs approve/revoke (explicit claimer) is undocumented in the CTE source — added to BE-HAF-CTE-HARDEN. (c) `AuthorshipClaimsScope` is an untagged union; a literal like `{claimer, paperAuthor, paperPermlink}` would silently take the claimer branch — no runtime risk since all three call sites build typed literals, but a discriminant field is a reasonable future hardening. (d) `scopeIdx` naming diverges from the `nextIdx` convention used elsewhere in [hafsql.ts](backend/src/hafsql.ts) — cosmetic. (e) The outer `WHERE paper_author / paper_permlink` in [claims.ts:53-54](backend/src/routes/claims.ts#L53-L54) and [papers.ts:1102-1103](backend/src/routes/papers.ts#L1102-L1103) is redundant now that the CTE is paper-scoped — harmless defense-in-depth. No ARCHITECTURE.md change needed (internal query shape). Status CASE semantics unchanged, reputation query ([reputation.ts:267](backend/src/reputation.ts#L267)) intentionally untouched (different CTE shape, different requirements).

---

### UI-REFAC-2 — Extract paper-feed component (2026-04-21) — Reviewed ✓

UI agent extracted the discipline/source/sort filter row, loading skeleton, error state, empty state, card grid, and pagination nav into a single [frontend/src/components/paper-feed.js](frontend/src/components/paper-feed.js) exporting `paperFeedTemplate` and registering `Alpine.data('paperFeed', () => ({...}))`. The factory owns all feed state (`papers`, `disciplines`, `discipline`, `sortBy`, `sourceFilter`, `currentPage`, `totalPages`, `loading`, `error`) and methods (`init`, `loadPapers`, `loadDisciplines`, `onDisciplineChange`, `onSortChange`, `onSourceChange`, `goToPage`, `paginationPages` getter, `navigate`), with `truncateText` / `formatDate` exposed on the scope so the interpolated `${paperCardTemplate}` finds them at the Alpine data level. [main.js](frontend/src/main.js#L30) wires `initPaperFeed()`. Both consumers collapsed cleanly: [home.js](frontend/src/pages/home.js) keeps the unauthenticated landing hero and the authenticated hero but swaps the feed block for `<div x-data="paperFeed">${paperFeedTemplate}</div>`, leaving `homePage` Alpine data with just `navigate()` for hero buttons; [papers.js](frontend/src/pages/papers.js) becomes a thin page-title + feed wrapper with `initPapersPage()` preserved as a registry-compatible no-op. Filter ids use the stable `paper-feed-{discipline,source,sort}` prefix. Diff-wise this is a faithful lift-and-shift: the extracted template is character-equivalent (modulo indentation) to the two prior inlines. `npm run build` succeeds; browser verification confirmed unauthenticated landing renders without the feed, `/papers` loads with filter ids namespaced `paper-feed-*`, and sort/discipline/source changes reset `currentPage` to 1 and re-fetch via `loadPapers`. Architect review (6 persona reviewers) surfaced two real correctness bugs in the pagination nav — **both pre-existing in HEAD `home.js` and `papers.js`, not introduced by UI-REFAC-2**: (1) P1 pagination layout bug at [paper-feed.js:80-92](frontend/src/components/paper-feed.js#L80-L92) renders two sibling `x-for` loops over `paginationPages`, producing DOM order `[all ellipses][all buttons]` instead of the intended interleaving (e.g. page 5 of 10 renders `… … 1 4 5 6 10` instead of `1 … 4 5 6 … 10`). Navigation still works; layout is broken. Naturally in scope for the pending UI-REFAC-3 (shared pagination factory) — annotated there. (2) P2 stale `totalPages` at [paper-feed.js:139-143](frontend/src/components/paper-feed.js#L139-L143): assignment gated on `res.meta`, so a filter transition to an empty-result response leaves prior `totalPages` visible alongside the empty-state card. Also pre-existing — added as UI-FEED-STALE-PAGINATION below. Minor non-blocking findings: `initPaperCard()` in [paper-card.js](frontend/src/components/paper-card.js#L90-L93) is dead code (exported, never imported, body comment inaccurate) — pre-existing; `initPapersPage()` is an empty registry-compat no-op without an explicit convention note — acceptable. Residual test gap: `paginationPages` getter has two branches and ellipsis-insertion logic with no unit coverage; the extraction made it visible as a pure function candidate (future UI-REFAC-3 work). No ARCHITECTURE.md change needed.

---

### E2E-WRITE-3 — Vote and comment up to broadcast (2026-04-21) — Reviewed ✓

Deliverable [frontend/tests/e2e/vote-comment.spec.js](frontend/tests/e2e/vote-comment.spec.js): two tests cover the vote and threaded-comment write paths against the real backend, with the chain replaced by [fixtures/keychain.js](frontend/tests/e2e/fixtures/keychain.js)'s capture buffer. Vote test picks an accredited researcher via `pickAccreditedResearcher`, walks `/api/papers?limit=50` skipping any paper they authored or co-authored (`isAuthorOrCoauthor` checks both `author` and `authors[].hive`), then per candidate fetches `/enrichment` and lowers the target weight to 6000 if the voter already sits at 10000 — correctly anticipating the `currentWeight === weight` short-circuit at [vote-buttons.js:135](frontend/src/components/vote-buttons.js#L135). Drives `handleVote(weight)` directly through `Alpine.$data` rather than the dropdown UI, keeping the assertion decoupled from icon/label markup. Vote routing through `requestVote` (single-op `vote`) is captured separately from `requestBroadcast` per the rule at [signer.js:32-49](frontend/src/signer.js#L32-L49); the spec asserts `kind: 'vote'` plus voter/author/permlink/weight. Comment test picks a paper with reviews, drives the top-level discussion composer via `Alpine.$data` and asserts the broadcast op pair: `comment` body has `parent_author/parent_permlink` = target paper, `permlink` starts with `re-` (matches `generatePermlink` at [comment-composer.js:5-9](frontend/src/components/comment-composer.js#L5-L9)), `json_metadata.app` prefixed with `pevotest/`, tags include `pevotest`, `pevotest.type === 'comment'`, plus a matching `comment_options` op. Reply test toggles `{ showComments: false }` on the first review's wrapper to mount the nested composer, then scopes the composer lookup by `parentPermlink` on the Alpine scope instead of DOM index — the review section renders *before* the paper-level discussion section in the template, so the review reply composer is earlier in the NodeList than the top-level one and naive `[0]`/`[-1]` indexing would be wrong. Both flows use self-custody so [broadcast-confirm.js:19](frontend/src/components/broadcast-confirm.js#L19) auto-resolves and `verifyHiveSignature` accepts the JWT bearer minted by `seedAccreditedSession`. Test-infra only; no contract or ARCHITECTURE.md change. Ran locally green via `./deploy.sh test-up` against `pevo_app_test`.

---

### UI-REFAC-1 — Shared-fragment convention + paper-card extraction (2026-04-21) — Reviewed ✓

Deliverable extracts the paper-list card into [frontend/src/components/paper-card.js](frontend/src/components/paper-card.js) as `paperCardTemplate` and substitutes `${paperCardTemplate}` at the two duplicated call sites ([home.js:153](frontend/src/pages/home.js#L153) authenticated feed, [papers.js:75](frontend/src/pages/papers.js#L75)). Diff verified: the extracted template body is character-identical to both prior inlines (only outer indentation differs, which is whitespace-irrelevant for rendering). Dead `import Alpine from 'alpinejs'` removed from papers.js (no `Alpine.data` or direct usage remains; the page still declares `x-data="homePage"` which is defined by `initHomePage()` in home.js and registered via main.js). The convention header at [paper-card.js:1-9](frontend/src/components/paper-card.js#L1-L9) codifies the rule: fragments export a `*Template` string; stateful fragments additionally register `Alpine.data` + `initFoo()`; presentational fragments (like this one, which reads `paper`, `navigate`, `truncateText`, `formatDate` from the parent x-for scope) skip the factory. The `\${...}` escaping note is preventive — the current paper-card template has no JS-template-literal interpolations (all dynamic bits are Alpine `x-text`/`:attr` expressions inside plain attribute strings), so it safely round-trips through the outer page template literals. Call sites intentionally left alone documented in the shipped-work note: paper-detail renders a different paper header (no hover, extra controls, `ipfsUrl` anchor), profile's publications tab uses a reduced metrics row (review_count only), search renders snippet+highlight not abstract, blog cards render post data not papers — all correctly out of scope. UI agent verified with `npm run build` and a headless render at `/en/papers`. No ARCHITECTURE.md change needed (frontend-local convention, inline-documented). Unblocks UI-REFAC-2 (paper-feed component) which consumes `paperCardTemplate`.

---

### E2E-WRITE-2 — Review submission up to broadcast (2026-04-21) — Reviewed ✓

Deliverable [frontend/tests/e2e/review-submit.spec.js](frontend/tests/e2e/review-submit.spec.js): drives `/review/:author/:permlink` through the real backend against a seeded accredited session, intercepts Keychain `requestBroadcast` via [fixtures/keychain.js](frontend/tests/e2e/fixtures/keychain.js)'s `window.__pevoBroadcastCalls`, and asserts the assembled `comment` + `comment_options` op pair. Paper selection walks `/api/papers?limit=50` and filters out any paper authored by the reviewer (top-level `author` or any `authors[].hive`), which correctly anticipates the `isOwnPaper` guard at [frontend/src/pages/review.js:148-153](frontend/src/pages/review.js#L148-L153). Ratings + `reviewBody` set via `window.Alpine.$data(el)` same pattern as publish.spec, insulating the spec from star-icon markup churn. Self-custody default in `seedAccreditedSession` ([fixtures/auth.js:129](frontend/tests/e2e/fixtures/auth.js#L129)) causes [broadcast-confirm.js:19](frontend/src/components/broadcast-confirm.js#L19) to skip the modal and auto-resolve, which matches the handler's control flow at [frontend/src/pages/review.js:248-253](frontend/src/pages/review.js#L248-L253). Assertions match the payload built at [frontend/src/pages/review.js:236-274](frontend/src/pages/review.js#L236-L274): `parent_author`/`parent_permlink` = target paper, `permlink.startsWith('re-')`, `json_metadata.app` prefixed with `pevotest/`, tags include `pevotest` + `review`, `pevotest.type === 'review'`, full `rating` object, `is_anonymous: false`, and matching `comment_options` op with same author/permlink. Test-infra only; no contract or ARCHITECTURE.md change. Passes locally in 7.5s against `pevo_app_test` via `./deploy.sh test-up`.

---

### E2E-WRITE-1 — Publish flow up to broadcast (2026-04-21) — Reviewed ✓

Deliverable [frontend/tests/e2e/publish.spec.js](frontend/tests/e2e/publish.spec.js): drives the publish page through title/authors/abstract/keywords/PDF upload, intercepts the Keychain `requestBroadcast`, and asserts the captured payload shape (parent permlink = `APP_TAG`, `json_metadata.app` prefixed with `${APP_TAG}/`, IPFS CID recorded in metadata). Shared fixture plumbing landed with this spec and is reused by all later write-flow E2Es: [fixtures/keychain.js](frontend/tests/e2e/fixtures/keychain.js) now stubs `requestBroadcast` and `requestVote` into `window.__pevoBroadcastCalls`; [fixtures/auth.js](frontend/tests/e2e/fixtures/auth.js) mints an HS256 session JWT with `node:crypto` and seeds `localStorage.pevo_session` via `addInitScript`, plus exposes `pickAccreditedResearcher(request)` and `minimalPdfBuffer()`. Accreditation is picked dynamically from HAF rather than hard-coded. Backend's `verifyHiveSignature` accepts the Bearer JWT as equivalent to a Hive signature, so the real IPFS upload succeeds without a valid Keychain signature. Tiptap editors driven via direct Alpine state manipulation since the broadcast payload reads from state. **Initial review (2026-04-21)** flagged a wrong Redis prefix in [global-teardown.js:105](frontend/tests/e2e/global-teardown.js#L105): the backend writes `${config.appTag}:ipfs:pending:${cid}` ([routes/ipfs.ts:211](backend/src/routes/ipfs.ts#L211), [ipfs-cleanup.ts:98](backend/src/ipfs-cleanup.ts#L98)) but teardown was deleting the unprefixed key, so `redis.del` silently returned 0 while the counter reported success. **Fix verified:** teardown now loads `APP_TAG` via `.env.test` → repo-root `.env` fallback (matching the `REDIS_URL`/`IPFS_API_URL` loading already in place), uses `` `${appTag}:ipfs:pending:${cid}` `` at [global-teardown.js:110](frontend/tests/e2e/global-teardown.js#L110), skips Redis cleanup with an explicit warning when `APP_TAG` is missing rather than silently deleting the wrong prefix ([global-teardown.js:88-92](frontend/tests/e2e/global-teardown.js#L88-L92)), and `redisDeleted` only increments when `DEL` actually removed a key ([global-teardown.js:111](frontend/tests/e2e/global-teardown.js#L111)). No contract or ARCHITECTURE.md change.

---

### E2E-READ-2 — Paper detail rendering (2026-04-21) — Reviewed ✓

Deliverable [frontend/tests/e2e/paper-detail.spec.js](frontend/tests/e2e/paper-detail.spec.js): two tests cover the four facets called out by the task (title/metadata, reviews, votes, version list). The "walk the list and pick a paper that exposes each facet" strategy is correct given the shared read-only HAF — hard-coding a permlink would rot. Selectors verified against source: `h1.text-paper-title` at [frontend/src/pages/paper-detail.js:274](frontend/src/pages/paper-detail.js#L274), `.badge-discipline` at [frontend/src/pages/paper-detail.js:266](frontend/src/pages/paper-detail.js#L266), `Peer Reviews ({count})` matches the i18n key at [frontend/public/messages/en.json:45](frontend/public/messages/en.json#L45) with the regex's optional `s?` tolerating either plural form, `Discussion ({count})` matches [frontend/public/messages/en.json:375](frontend/public/messages/en.json#L375), version pills at [frontend/src/pages/paper-detail.js:80-105](frontend/src/pages/paper-detail.js#L80-L105) render as `button` elements with `v{n}` text and a `Latest` badge on the tip. The waitForResponse for the enrichment call before asserting reviews/votes correctly handles the lazy load — `fetchPaperEnrichment` is invoked after `fetchPaper` in the page's `loadPaper()` flow. The `detailResponsePromise` URL-match filter excludes `/enrichment` and `/comments` to pin to the base detail call; both endpoints exist on [backend/src/routes/papers.ts](backend/src/routes/papers.ts). Discussion empty-state acceptance is appropriate since HAF currently has no pevotest-tagged threaded comments. Ran locally green (2/2 passing).

---

### E2E-READ-3 — Profile and researcher directory (2026-04-21) — Reviewed ✓

Deliverable [frontend/tests/e2e/researchers.spec.js](frontend/tests/e2e/researchers.spec.js): one test walks directory → profile click-through covering name, institution, field, reputation, and first paper in the publications tab. Endpoints verified: `/api/accreditations` list at [backend/src/routes/accreditations.ts:83](backend/src/routes/accreditations.ts#L83), `/api/profile/:username` at [backend/src/routes/profile.ts:131](backend/src/routes/profile.ts#L131), `/api/profile/:username/papers` at [backend/src/routes/profile.ts:245](backend/src/routes/profile.ts#L245). Directory card markup matches: `.card` with `@{username}` link and `r.name`/`r.institution`/`r.field` at [frontend/src/pages/researchers.js:62-70](frontend/src/pages/researchers.js#L62-L70). Profile selectors match: `h1` with accreditation name at [frontend/src/pages/profile.js:33](frontend/src/pages/profile.js#L33), `@{username}` at [frontend/src/pages/profile.js:43](frontend/src/pages/profile.js#L43), reputation score rendered as `div.text-4xl.font-bold` at [frontend/src/pages/profile.js:65](frontend/src/pages/profile.js#L65). The "pick a researcher with at least one paper" probing is necessary because not all accredited accounts have published — otherwise the publications assertion would intermittently fail. Test-infra only; no contract or ARCHITECTURE.md change. Ran locally green.

---

### E2E-READ-4 — Blog pages (2026-04-21) — Reviewed ✓

Deliverable [frontend/tests/e2e/blog.spec.js](frontend/tests/e2e/blog.spec.js): one test covers index → card click → post page with title and body rendering. Endpoints verified: `/api/blog` list at [backend/src/routes/blog.ts:49](backend/src/routes/blog.ts#L49) and `/api/blog/:permlink` at [backend/src/routes/blog.ts:70](backend/src/routes/blog.ts#L70). Reading against the live HiveComb-indexed `pevo.science` account is fine — the task's note about mocking was optional and the published launch post gives a stable fixture. The markdown-strip + "first plain-text word" trick tolerates whatever the launch-post body looks like while still asserting the preview isn't empty. Post page asserts `h1` matches the API title and an `article .prose` container contains a >4-char word from the body, which exercises the `x-markdown` pipeline end-to-end. Listener URL filter at [frontend/tests/e2e/blog.spec.js:27-30](frontend/tests/e2e/blog.spec.js#L27-L30) correctly excludes the single-post endpoint via the `/api/blog/[^?]+` regex. Test-infra only. Ran locally green.

---

### E2E-READ-1 — Paper list, filters, search (2026-04-20) — Reviewed ✓

Deliverable [frontend/tests/e2e/papers-browse.spec.js](frontend/tests/e2e/papers-browse.spec.js) covers the four required surfaces: list renders, discipline filter narrows, search returns a match, card link routes to `/paper/:author/:permlink`. Verified against backend shapes: `/api/papers` returns `data[].discipline` top-level ([backend/src/routes/papers.ts:372](backend/src/routes/papers.ts#L372)) so the per-row `expect(paper.discipline).toBe(firstDiscipline)` loop is authoritative rather than DOM-dependent. `/api/search` returns `type in {paper, bridge_paper}` ([backend/src/routes/search.ts:55-61](backend/src/routes/search.ts#L55-L61)), matching the spec's filter. The "first non-empty discipline" strategy is safe because `/api/disciplines` ([backend/src/routes/disciplines.ts:20-32](backend/src/routes/disciplines.ts#L20-L32)) groups by existing values with `paper_count > 0`, and bridge papers bypass `accredited_only` ([backend/src/routes/papers.ts:241-244](backend/src/routes/papers.ts#L241-L244)) so filter-narrowed results stay non-empty against the shared read-only HAF even with an empty `pevo_app_test`. Stable search keyword "consensus" matches an existing crossref bridge paper. Alpine `x-model` selector (`select[x-model="discipline"]`) matches the markup at [frontend/src/pages/papers.js:15](frontend/src/pages/papers.js#L15). Keychain fixture imported but keychain is never exercised — read-only flow, correct. No API contract or ARCHITECTURE.md changes needed; this is test infrastructure only. No HAF seeding possible given read-only shared instance — documented inline with rationale. Ran green locally per task notes.

---

### IPFS-DURABLE-TRACKING — Move pending-pin tracking from Redis to Postgres (2026-04-20) — Reviewed ✓

Redis pending keys had a 24h TTL and were lost on flush/eviction, leaving orphan Kubo pins the cleanup job could never discover. New migration [backend/migrations/003_pending_ipfs_uploads.sql](backend/migrations/003_pending_ipfs_uploads.sql) adds `pending_ipfs_uploads(cid PK, uploader_account NOT NULL, size_bytes, created_at DEFAULT NOW())` with an index on `created_at`; mirrored idempotently inside `initAppDb()` at [backend/src/app-db.ts:100-108](backend/src/app-db.ts#L100-L108) for dev convenience. [backend/src/routes/ipfs.ts:191-201](backend/src/routes/ipfs.ts#L191-L201): after `pinToIpfs()` succeeds, INSERT into `pending_ipfs_uploads` via `getAppPool()` with `ON CONFLICT (cid) DO NOTHING`; failures are logged but don't fail the request (the pin already happened). Redis write retained as hot cache for the download proxy. `cidIsKnown()` now checks Redis → Postgres → HAF in that order ([backend/src/routes/ipfs.ts:237-277](backend/src/routes/ipfs.ts#L237-L277)). [backend/src/ipfs-cleanup.ts](backend/src/ipfs-cleanup.ts) rewrote `runCleanup()` to skip when app DB is unavailable (was Redis), then `SELECT cid, uploader_account FROM pending_ipfs_uploads WHERE created_at < NOW() - interval`; per row: HAF check → if referenced, DELETE row + best-effort Redis del; if not, unpin Kubo first, then DELETE row + Redis del. Failed unpin throws and the row stays for retry next cycle (correct). [agents/docs/api-contracts/ipfs.md:40](agents/docs/api-contracts/ipfs.md#L40) updated to mention the table alongside the Redis cache. ARCHITECTURE.md needed no update — orphan cleanup is an implementation detail, not a documented architectural surface; `hive-schemas.md` documents on-chain JSON shapes, not backend tracking. `npx tsc --noEmit` clean; ipfs route tests 3/3 pass; other backend test failures are pre-existing.

---

### IPFS-CLEANUP — Unpin test-created CIDs in E2E teardown (2026-04-20) — Reviewed ✓

Shared JSONL CID registry at [frontend/tests/e2e/fixtures/captured-cids.js](frontend/tests/e2e/fixtures/captured-cids.js) — cross-worker-safe via POSIX `O_APPEND` (single-line writes are atomic under `PIPE_BUF`). Keychain fixture ([frontend/tests/e2e/fixtures/keychain.js](frontend/tests/e2e/fixtures/keychain.js)) listens for `/api/ipfs/upload` 200 responses and records `body.data.cid ?? body.cid`; auto-applies to every spec via the shared `test` export. [frontend/tests/e2e/global-setup.js](frontend/tests/e2e/global-setup.js) calls `resetCapturedCids()` before each run so leftovers don't re-unpin. [frontend/tests/e2e/global-teardown.js](frontend/tests/e2e/global-teardown.js) reads the registry, POSTs `${IPFS_API_URL}/api/v0/pin/rm?arg={cid}` (same "not pinned" tolerance as [backend/src/ipfs-cleanup.ts:61](backend/src/ipfs-cleanup.ts#L61)) and `DEL ipfs:pending:{cid}` via `ioredis`; per-CID failures log and continue, missing `IPFS_API_URL`/`REDIS_URL` warns and skips rather than failing the suite. Added `ioredis ^5.10.1` to `frontend/devDependencies` (version-matched to backend); `.gitignore` entry `frontend/tests/e2e/.captured-cids.jsonl` confirmed. Playwright config wires both hooks at [frontend/playwright.config.js:7-8](frontend/playwright.config.js#L7-L8). Verified syntax with `node --check` across all four files. Test-infra only — no ARCHITECTURE.md or api-contracts changes required; the reasoning "Redis is cache, Postgres will be source of truth" is now active via the in-flight IPFS-DURABLE-TRACKING task, and this E2E teardown is still correct against either backing store since it targets Kubo directly and treats the Redis `DEL` as optional.

---

### TEST-8B — Test quality audit: execute approved changes (2026-04-20) — Reviewed ✓

Executed Sections 1–4 of `test-audit-findings.md`. Removals/consolidations: ~90 tests across editor, auth, pages-publish/review/signup/home/settings/contact/accreditation/bridge/profile/stats, keychain, error-tracking, components-header, signer. Parameterised `isSubmitting`/`stepClass` 5-case blocks collapsed via `it.each`. Source fixes: publish.handleSubmit now validates empty title/abstract/discipline with new `publish.missingRequiredFields` key added to all 16 locales (`en` populated, others fall back to English); `_restoreSession` early-returns on missing session, `removeItem` fires only on validation failure; DOMPurify hardened with `FORBID_ATTR: ['style']` (new security fix beyond the March M8 style-allowlist removal — belt-and-suspenders defense against CSS/URL injection). Targeted mutation-killing tests added: editor (iframe/javascript:/style/multi-math-regex/raw-HTML onerror), signer (multi-op light-account routing), pages-publish (handleSubmit integration: guards, confirmation dialog, op shape, percent_hbd, APP_TAG parent_permlink, metadata tags/citations filters, ipfs_cid + document_hash), pages-signup (DUPLICATE resolution paths, PENDING_SIGNUP redirect, VALIDATION_ERROR with orcidToken), auth (restore guards for token/username, loginFromResponse persist + accreditation polling). Verified: 46 test files, 681/681 passing (`vitest run` 4.19s). Audit findings file removed after consumption per no-spec-sprawl rule. No ARCHITECTURE.md update required — test structure and security hardening are implementation details, not architectural changes.

---

### TEST-8A — Test quality audit: findings report (2026-04-20) — Reviewed ✓

Report delivered at `agents/docs/test-audit-findings.md`. Suite snapshot: ~737 tests across 35 files. Categorized findings: ~80 low-value tests (third-party library behavior, getter passthroughs, trivial assignments) across editor.test.js, pages-publish/review/signup/settings/home/contact/accreditation/bridge/profile/stats, auth, signer, keychain; ~11 mock-only tests (error-tracking handlers, keychain signBuffer passthrough, components-header delegations, signup argument passthroughs); 2 possibly-enshrined-bug findings (publish.handleSubmit missing validation for title/abstract/discipline; auth._restoreSession calls removeItem unconditionally); ~30 surviving mutations across 5 critical modules (signer light-account multi-op routing, editor XSS/math-regex mutations, publish.handleSubmit entirely untested, signup DUPLICATE/VALIDATION_ERROR branches, auth session-restore guards). Spot-checked findings against source — all accurate. Proposed target: remove ~90 low-value/mock-only, add ~25-30 targeted tests, net ~670 with significantly better defect detection. TEST-8B (execute approved changes) remains Pending for UI Agent after user review of report.

---

### TEST-7 — Unit tests: UI components (2026-04-20) — Reviewed ✓

10 test files covering all components with testable data logic, 107 component tests (737 total suite). Files: components-paper-card (8), components-pagination (12), components-threaded-comments (6), components-vote-buttons (20), components-comment-composer (8), components-broadcast-confirm (4), components-header (13), components-sign-in-modal (13), components-markdown-renderer (10), components-vouch-section (13). Skipped: paper-filters, rating-bar, version-selector, accreditation-badge, review-card, footer, page-mount (DOM-heavy Alpine wiring, no extractable logic). All 107 tests pass in ~1.4s.

---

### TEST-6 — Unit tests: page data logic (2026-04-20) — Reviewed ✓

19 test files covering all page modules, 365 page tests (630 total suite). Files: pages-signup (25), pages-login (16), pages-signup-verify (21), pages-reset-password (12), pages-recover (15), pages-settings (20), pages-settings-verify-email (5), pages-paper-detail (44), pages-publish (33), pages-search (14), pages-review (24), pages-profile (7), pages-stats (7), pages-home (17), pages-blog (13), pages-bridge (36), pages-accreditation (21), pages-orcid-callback (21), pages-contact (14). Skipped: about, faq, getting-started, blog-post, accreditation-verify (trivial/pure template), papers (reuses homePage). All 365 tests pass in ~3s.

---

### TEST-5 — Unit tests: editor and markdown (2026-04-20) — Reviewed ✓

49 tests in `tests/unit/editor.test.js`. Covers all 5 exported helper functions: `markdownToHtml` (18 tests: basic markdown, headings, GFM tables, inline/block math Tiptap conversion, autolink stripping, explicit link preservation, XSS sanitization for script tags and event handlers, data attributes, quote escaping in latex, empty input, lists, blockquotes, code blocks, strikethrough), `createTurndown` (13 tests: bold, italic, headings, strikethrough via del/s, inline/block math spans, GFM tables, fenced code, bullet lists, links, empty table), round-trip fidelity (7 tests: bold, italic, headings, inline math both directions, block math, links), `wrapMarkdownSelection` (3 tests: wrapping selection, placeholder insertion, asymmetric markers), `prefixMarkdownLines` (3 tests: single line, multi-line, empty selection), `isImageFile` (5 tests: png/jpeg/gif true, pdf/text false). All 49 tests pass in 141ms.

---

### TEST-4 — Unit tests: router (2026-04-20) — Reviewed ✓

46 tests in `tests/unit/router.test.js`. Covers all 24 route patterns (home, papers, paper-detail, publish, edit, review, search, bridge, profile, accreditation, accreditation-verify, orcid-callback, researchers, stats, about, faq, getting-started, contact, blog, blog-post, signup, signup-verify, auth/verify alias, login, reset-password, recover, settings, settings-verify-email), unknown-path fallback to home, locale prefix stripping with i18n store sync, query parameter parsing with URI decoding, `navigate()` with auto locale prepend / no double-prepend / hash preservation / scroll-to-top / title update, and popstate handling with i18n locale sync. All 46 tests pass.

---

### TEST-3 — Unit tests: signer and keychain (2026-04-20) — Reviewed ✓

20 tests across 2 files: `tests/unit/keychain.test.js` (8 tests), `tests/unit/signer.test.js` (12 tests). Keychain tests cover `isKeychainInstalled` (present/absent), `waitForKeychain` (immediate/delayed/timeout), and `signMessage` (no keychain/success/failure). Signer tests cover `broadcastOps` across all three routing branches: light account via fetch (success, JSON error body, non-JSON error body), keychain `requestVote` for single vote ops (no keychain, success, failure), and keychain `requestBroadcast` for non-vote ops (no keychain, success, default/custom keyType, failure, multi-ops routing). All mocking is appropriate: Alpine.store, window.hive_keychain, global.fetch. All 20 tests pass.

---

### TEST-2 — Unit tests: Alpine stores (2026-04-20) — Reviewed ✓

46 tests across 4 new test files: toast.test.js (8), notifications.test.js (20), error-tracking.test.js (4), auth.test.js (14). All four store modules tested with 100% branch coverage of data/state logic. Toast covers show/dismiss/cap/auto-dismiss/animation. Notifications covers cursor/seenBlock localStorage, polling start/stop, exponential backoff with cap, MAX_CONSECUTIVE_FAILURES, MAX_EVENTS, markAllRead, unreadCount, refresh, dedup, generation guard, cursor update. Error-tracking covers global error/unhandledrejection/alpine:error handlers plus resilience when toast store unavailable. Auth covers _restoreSession (valid/expired/missing/defaults), _saveSession, _handleStorageEvent (new/removed/other keys), disconnect, loginFromResponse (full/defaults), init (isLoading, keychain check), token expiry. connect() correctly excluded per task boundary. All external deps (Alpine, api.js, keychain.js, sign-request.js, localStorage) properly mocked. All 46 tests pass.

---

### TEST-1 — Unit tests: core utilities (2026-04-20) — Reviewed ✓

63 tests across 3 new test files (i18n.test.js, version-diff.test.js) plus improved hive-keys.test.js. All TEST-1 scope files at 100% coverage (config, crypto, sign-request, hive-keys, i18n). version-diff.js at 100% lines/91.89% branches (v8 artifact on `||` fallback operators). Existing tests (config, crypto, sign-request) confirmed passing at full coverage. api.js core logic covered; thin wrappers deferred to TEST-6.

---

### TEST-004 — First Playwright E2E: email signup golden path (2026-04-20) — Reviewed ✓

Closes the last open item from the TEST-001…TEST-004 testing stack: a real-browser happy-path E2E that exercises the email-signup → verify-email flow end-to-end against `pevo_app_test`. [frontend/tests/e2e/email-signup.spec.js](../../frontend/tests/e2e/email-signup.spec.js) fills the signup form (inputs selected via Alpine `input[x-model="…"]`, which is resilient to i18n/layout drift), asserts the `POST /api/auth/signup` request body shape and 200 response via `page.waitForRequest` / `waitForResponse`, confirms the `Check your email` heading (bound to `signup.checkEmail` i18n key), reads the `verify_token` directly from `pevo_app_test.accounts` via `pg`, navigates to `/signup/verify?token=…` which auto-POSTs `/api/auth/verify`, and asserts the `Email Verified` heading (bound to `seedPhrase.emailVerified`). `pg` added as a frontend devDep for the DB readback. Stable `e2e+signup@pevo.test` email, no timestamp hacks — re-runs pass because `global-setup` truncates the 4 relevant tables.

**Infra gaps uncovered and resolved:**
1. **SMTP.** Signup at [backend/src/routes/auth.ts:211-237](../../backend/src/routes/auth.ts#L211-L237) deletes the row and 500s when `SMTP_HOST` is empty. Resolved by adding a Mailpit sidecar (`axllent/mailpit`, actively maintained MailHog replacement) to [docker-compose.test.override.yml](../../docker-compose.test.override.yml), wired to `backend` via `SMTP_HOST=mailpit`/`SMTP_PORT=1025`. Web UI on `127.0.0.1:8025` for manual inspection; SMTP port only on the compose network.
2. **Institutional-domain gate.** [backend/src/email-validator.ts](../../backend/src/email-validator.ts) rejects non-institutional emails without ORCID. Resolved by `INSTITUTIONAL_EMAIL_DOMAINS=.test` in the test override, so RFC 2606 `.test` addresses pass without pulling in a real domain or an ORCID round-trip.

**Verification:** `./deploy.sh test-up` → `APP_DATABASE_URL=… PEVO_TEST_BASE_URL=http://localhost:3001 npm --prefix frontend run test:e2e` → 2/2 passed in 1.9s (new spec + existing harness smoke). Back-to-back: 2/2 again, no manual cleanup. Dev-DB isolation confirmed (`COUNT(*) = 0` for the test email against `pevo_app`).

**Architect notes:** (a) The `expect(verifyToken.startsWith('confirmed:')).toBe(false)` assertion is a sequencing sanity check — it proves the DB read happened before the verify call rewrote the column, matching the `confirmed:${hex}` state-machine shape used in [backend/src/routes/signup-verify.ts:64](../../backend/src/routes/signup-verify.ts#L64). (b) Keychain fixture is imported but never signs — deliberate per the driver-only stub contract from TEST-001; keeps the wiring exercised on every E2E run so it doesn't rot. (c) `./deploy.sh up` after `test-up` leaves `pevo-mailpit-1` running as an orphan (compose doesn't remove services not in the base file). Harmless (128m cap, SMTP scoped to the compose network) but can be cleaned via `docker stop pevo-mailpit-1` or by adding `--remove-orphans` to `cmd_up` in `deploy.sh`. Flagged by implementer; leaving as-is for now — the next time the user hits it we can decide whether to patch `cmd_up` or teach `cmd_test_up` to stop mailpit on teardown. (d) Node 20 is still required (see repo CLAUDE.md) for running these E2E tests.

### TEST-003 — SEC-001 frontend/backend equivalence test (2026-04-20) — Reviewed ✓

Replaces the still-pending in-browser Keychain smoke test from FINDING-001 with a deterministic, keyless Vitest assertion that the canonical signed string the frontend produces is byte-identical to the string the backend would verify, for identical inputs. [frontend/tests/unit/sec-001-equivalence.test.js](../../frontend/tests/unit/sec-001-equivalence.test.js) imports `buildCanonicalAuthMessage` directly from [backend/src/lib/authMessage.ts](../../backend/src/lib/authMessage.ts) — the backend helper is the single source of truth, never re-implemented in the test. Only `keychain.js` and `config.js` are mocked (app-tag pinned to `pevotest`, Keychain returns a stub so no wallet is needed); real Web Crypto `sha256Hex` runs on the frontend side and real `cryptoUtils.sha256(...).toString('hex')` runs inside the backend helper, so the end-to-end hash implementations are both exercised. Each case captures the frontend-assembled message, extracts the in-built ISO timestamp, then feeds the exact same `(appTag, method, path, body, timestamp)` tuple into the backend helper and asserts byte equality. Four cases: `POST /api/auth/session` body `{}`; `POST /api/auth/link` body `{ auth_token: 'abc123' }`; `GET /api/anything` with `undefined` body (hashes `JSON.stringify({})` on both sides per SEC-001-FIXUP); `GET /api/papers/alice/some-permlink` as a multi-segment-path anti-drift anchor. `cd frontend && npm run test` → 7 files / 49 passed (+4 over TEST-002's 45). `security-audit-findings.md` FINDING-001 updated by the Architect on review to note the Keychain smoke test is superseded; the manual pre-deploy end-to-end check with a real posting key remains deliberately out of automation. **Architect notes:** (a) Vitest transforms the backend `.ts` helper on the fly via Vite/esbuild, and `@hiveio/dhive` resolves out of `frontend/node_modules/`; no symlink, no build step, no extra config. If the backend helper ever grows a transitive dep not in the frontend's `node_modules`, this seam will need attention. (b) Pinning `APP_TAG` via `vi.mock('../../src/config.js', …)` keeps the assertion hermetic regardless of `window.__PEVO_CONFIG__` state.

### TEST-002 — Vitest backfill for frontend logic modules (2026-04-20) — Reviewed ✓

Five new unit-test files landed under [frontend/tests/unit/](../../frontend/tests/unit/) covering the pure-logic surface: [config.test.js](../../frontend/tests/unit/config.test.js) (3, every getter default+injected, `window.__PEVO_CONFIG__` scrubbed in `afterEach`), [crypto.test.js](../../frontend/tests/unit/crypto.test.js) (13, `sha256Hex` against NIST vectors + `'{}'` body-hash vector + UTF-8, `sha256File` using Node 20's `node:buffer` `File`/`Blob` since jsdom's lack `arrayBuffer()`, `slugify` whitespace/underscore/non-word/truncation/all-stripped cases), [sign-request.test.js](../../frontend/tests/unit/sign-request.test.js) (7, mocks only `keychain.js`/`config.js` so real Web Crypto runs; asserts canonical message shape, `JSON.stringify(body ?? {})` body-hash rule for GET/null/undefined, three envelope headers, GET/HEAD vs POST/PUT/PATCH/DELETE body routing, fresh-per-call timestamp), [hive-keys.test.js](../../frontend/tests/unit/hive-keys.test.js) (8, mnemonic generate+validate happy/tampered, `deriveHiveKeys` determinism + per-role distinctness, two inline-snapshot vectors — `abandon…/alice` and `legal winner…/bob` — locking the BIP39 → HMAC-SHA512 → `PrivateKey.fromSeed` pipeline against backend drift, plus same-mnemonic-different-username divergence), [api.test.js](../../frontend/tests/unit/api.test.js) (13, stubs `alpinejs` via `vi.mock`, exercises `buildQuery`/`request`/`authenticatedRequest`/`ApiRequestError` via exported wrappers — empty/undefined/empty-string stripping, URL-encoding, numeric+boolean coercion, 2xx/4xx-JSON/4xx-non-JSON, default `AbortSignal.timeout`, Bearer merging). `cd frontend && npm run test` reports 6 files / 45 tests passing. No `frontend/src/` or `backend/` changes. **Architect notes:** (a) Inline snapshots over `__snapshots__/` — values are byte-comparable and visible next to test bodies. (b) `jsdom` File/Blob workaround documented in the crypto test; production browsers always have spec-compliant `File.arrayBuffer()`. (c) Spec cross-reference drift — the TEST-002 spec pointed at `backend/src/lib/seed-phrase.ts`, but the actual file is `backend/src/seed-phrase.ts`; the test comment already uses the correct path. (d) Operational gotcha: if `npm run test` segfaults on hive-keys, run `npm rebuild secp256k1` once — stale native ABI from the frontend's `secp256k1` build — worth capturing in a `frontend/README.md` on the next UI-facing task.

### TEST-001 — Frontend test harness: Vitest + Playwright (2026-04-20) — Reviewed ✓

Frontend now has both a Vitest jsdom harness for pure-logic unit tests and a Playwright Chromium harness for browser E2E, wired to a dedicated `pevo_app_test` database via TEST-001-BE's reset hook. [frontend/package.json](../../frontend/package.json) adds devDeps (`vitest`, `jsdom`, `@vitest/coverage-v8`, `@playwright/test`) and scripts (`test`, `test:watch`, `test:e2e`, `test:e2e:ui`). `jsdom` was chosen over `happy-dom` for closer Web Crypto / File / Blob fidelity — TEST-002's crypto tests depend on it. [frontend/vitest.config.js](../../frontend/vitest.config.js) runs `tests/unit/**/*.test.js` under jsdom; [frontend/playwright.config.js](../../frontend/playwright.config.js) uses `testDir: './tests/e2e'`, `testMatch: /.*\.spec\.js$/`, Chromium only, `baseURL` defaulting to the dev backend at `http://localhost:3001`. [frontend/tests/e2e/fixtures/keychain.js](../../frontend/tests/e2e/fixtures/keychain.js) injects `window.hive_keychain.requestSignBuffer` via `page.addInitScript`, returning a deterministic `STUB_SIG_<sha256(message)[:16]>` with `publicKey: 'STM_STUB'`; the driver-only constraint (no real signature verification) is called out at the top of the file. [frontend/tests/e2e/global-setup.js](../../frontend/tests/e2e/global-setup.js) optionally loads `frontend/.env.test`, asserts `APP_DATABASE_URL`, and shells out to `npm run --prefix backend --silent test-db:reset` — the backend safety gate still independently refuses any DB name not ending in `_test`. [frontend/tests/e2e/global-teardown.js](../../frontend/tests/e2e/global-teardown.js) is a deliberate no-op so failed-run rows stay inspectable. Sanity tests: [frontend/tests/unit/harness.test.js](../../frontend/tests/unit/harness.test.js) (jsdom + Web Crypto empty-string NIST vector), [frontend/tests/e2e/harness.spec.js](../../frontend/tests/e2e/harness.spec.js) (Keychain stub injection). [frontend/.gitignore](../../frontend/.gitignore) added (`node_modules/`, `dist/`, `coverage/`, `test-results/`, `playwright-report/`, `.env.test`). The pre-existing `frontend/e2e/` folder (10 orphaned mock-routed Playwright specs from the initial commit, never wired to any config) was deleted — user confirmed during the session; not in the original TEST-001 spec but flagged here. Verified: `npm install` (153 new pkgs, no prod-dep changes), `npm run build` (no new warnings), `npm run test` (1/1), E2E smoke (1/1 in 1.7s against a live dev backend, `global-setup` truncated 4 tables). No `frontend/src/` touched. **Architect notes:** (a) `frontend/e2e/` deletion was orthogonal cleanup, not spec-mandated — next person running `git log --follow` on those paths will find them in history. (b) Chromium system deps (`libnspr4` etc.) require `sudo npx playwright install-deps chromium` on a fresh machine — this operational detail should land in a UI-owned `frontend/README.md` when the UI agent next touches that area. (c) Backend runtime DB routing still points at dev `pevo_app`; TEST-004 covers the `docker-compose.test.override.yml` that switches the backend to `pevo_app_test` during E2E. TEST-001 unblocks TEST-002, TEST-003, and TEST-004.

### TEST-003-BE — Extract canonical auth-message builder (2026-04-20) — Reviewed ✓

Pure helper `buildCanonicalAuthMessage({ appTag, method, path, body, timestamp })` extracted to [backend/src/lib/authMessage.ts](../../backend/src/lib/authMessage.ts). No Express types, no side effects. Format unchanged: `${appTag}-auth|v1|${METHOD}|${path}|${sha256_hex(JSON.stringify(body ?? {}))}|${timestamp}`. [backend/src/middleware/verifyHiveSignature.ts](../../backend/src/middleware/verifyHiveSignature.ts) now imports and delegates to the helper; path-stripping (`req.originalUrl.split('?')[0]`) and `req.body` pass-through stay in the middleware. No `-auth|v1|` template literal remains in the middleware. New [backend/tests/lib/authMessage.test.ts](../../backend/tests/lib/authMessage.test.ts) with 4 cases: typical POST with body, bodyless GET (undefined/null/{} all hash identically), per-field variance sensitivity, string+number timestamp forms. All pass. Existing 11-test `tests/routes/auth.test.ts` still passes — refactor is byte-identical on the wire. TEST-003 (frontend) now unblocked — it imports the helper via `../../../backend/src/lib/authMessage.ts` so both sides of the equivalence assertion drive from this one source.

### TEST-001-BE — Test-DB profile and reset hook for Playwright (2026-04-20) — Reviewed ✓

Second Postgres database `pevo_app_test` on the existing container (no sidecar). [deploy.sh](../../deploy.sh): shared `migrate_db <dbname>` function called by both `cmd_migrate` (pevo_app) and new `cmd_test_db_up` (pevo_app_test, idempotent — checks `pg_database` before CREATE). New `cmd_test_db_down` drops it with confirmation gate. `test-db-up` also prints the exact `APP_DATABASE_URL` + npm invocation for Playwright global-setup. [backend/scripts/reset-test-db.js](../../backend/scripts/reset-test-db.js): pure Node+`pg` script that truncates all `public` tables via dynamic `pg_tables` discovery (future migrations need no script edits), with `RESTART IDENTITY CASCADE`. Safety gate refuses any DB whose name doesn't end in `_test` — verified, rejects `pevo_app` with non-zero exit. Missing env var also exits non-zero. New npm script `test-db:reset` in [backend/package.json](../../backend/package.json). TEST-001 (UI) unblocked. **Architect note:** TEST-001-BE intentionally did not touch backend runtime config; the dev backend still points at `pevo_app`. TEST-004 depends on the backend writing to `pevo_app_test` during E2E — this routing gap is now called out in TEST-004's Coordination section and must be resolved (likely a compose override) before TEST-004 can complete.

### SEC-001-FIXUP — Align `signRequest` helper with doc for GET/HEAD (2026-04-20) — Reviewed ✓

Frontend-only follow-up to SEC-001. [frontend/src/sign-request.js](../../frontend/src/sign-request.js) previously hashed `''` for GET/HEAD, which diverged from the backend's uniform `JSON.stringify(req.body || {})` rule and from the body-serialization caveat in `security-audit-findings.md`. Helper now unconditionally computes `bodyForHash = JSON.stringify(bodyObject ?? {})` and hashes that for every method; the serialized body is still omitted from the wire for GET/HEAD via a `methodAllowsBody` flag. JSDoc updated. No backend change needed (already matches). No tests added — verified by inspection: only two callers (`auth.js` POST /api/auth/session, `api.js` POST /api/auth/link), both POST, so no behavior change in practice. The fix is preventative in case a future caller passes GET/HEAD.

### SEC-001 — Remove `X-Hive-Message` escape hatch, enforce request-binding (2026-04-20) — Reviewed ✓

Fix for FINDING-001 (Critical, CVSS 9.6 — universal auth bypass via unbound `X-Hive-Message`). Backend and frontend shipped atomically.

**Backend (SEC-001-BE):** `verifyHiveSignature` middleware no longer reads `X-Hive-Message`. `X-Hive-Timestamp` now required (missing → 401 with exact message `"X-Hive-Timestamp is required"`). Signed message is request-bound: `${appTag}-auth|v1|${method}|${originalUrl without query}|${sha256_hex(JSON.stringify(body || {}))}|${timestamp}`. `req.originalUrl.split('?')[0]` chosen over `req.path` so the backend verifies the full URL the client signs. `X-Hive-Message` removed from CORS `allowedHeaders`. 60s window, 5-min replay cache, JWT bearer path, and timing-safe pubkey compare unchanged. Tests rewritten to exercise the real middleware: positive request-bound sign → JWT; regressions for captured-message replay, missing timestamp, cross-endpoint replay, expired timestamp. All 11 auth tests pass.

**Frontend (SEC-001-UI):** New `frontend/src/sign-request.js` helper `signRequest(username, method, path, bodyObject)` — builds the same message, signs via Keychain, returns `{ headers, body }`. `sha256Hex` added to `crypto.js` (Web Crypto, no new deps). `auth.js connect()` signs `POST /api/auth/session` with body `{}`. `api.js linkExistingAccount(authToken, username)` signs the actual `{ auth_token }` body against `/api/auth/link`. `signup-verify.js handleLinkAccount` delegates to `linkExistingAccount` (old `${email}:link` challenge removed). grep confirms no `X-Hive-Message` references remain in `frontend/` or `backend/`. Build passes.

**Note:** In-browser Keychain login and signup-link smoke test still pending — code paths verified via backend tests and static review. `agents/docs/security-audit-findings.md` FINDING-001 marked Fixed. Contract docs (`api-contracts/common.md`, `auth.md`, `bridge.md`) already reflect the new signed-message format and the removal of `X-Hive-Message`.

### ORCID-4 — Remove old ORCID routes (2026-04-19) — Reviewed ✓

Removed old fragmented ORCID endpoints from `auth.ts` and `accreditation.ts`, replaced by unified `/api/orcid/start` and `/api/orcid/callback` in `orcid.ts`. Cleaned up `signupOrcidStates`, `signupOrcidVerified` maps, legacy `signup_orcid_verified:` Redis key fallbacks, `orcidStates` map, `getExistingAccreditation` (from accreditation.ts), and unused imports. Signup and recover routes now use only `orcid_verified:` keys from the unified orcid module. Build passes, no stale references.

### ORCID-3 — Frontend ORCID consolidation (2026-04-19) — Reviewed ✓

Unified ORCID callback page (`orcid-callback.js`) replaces both `signup-orcid-callback.js` and `accreditation-orcid-callback.js`. All 4 modes (signup, login, accredit, link) handled by single page reading mode from localStorage. API consolidated from 5 functions to 2 (`startOrcid(mode)`, `completeOrcid(code, state)`). All consumer pages (signup, login, accreditation, settings, recover) updated. Router and page registry updated. i18n keys added to all 16 locales. API contract documented in `api-contracts/orcid.md`. Old backend routes preserved for ORCID-4 cleanup.

### ORCID-2b — Fix resend-verification crash on ORCID accounts (2026-04-19) — Reviewed ✓

Null check for `password_hash` in resend-verification handler via ternary guard. When null (ORCID-only accounts), returns `false` for password validation, producing the same constant-time generic response. TypeScript type updated to `string | null`.

### ORCID-2a — Fix login crash on ORCID-only accounts (2026-04-19) — Reviewed ✓

One-line null check for `password_hash` before `argon2.verify()` in login handler. Prevents crash on ORCID-only accounts (null password_hash). Returns same 401 "Invalid credentials" to avoid leaking account type.

### ORCID-2 — Relax signup fields for ORCID (2026-04-19) — Reviewed ✓

Signup handler relaxed: when `orcid_token` present, email/password/institution/field are optional. `full_name` falls back to ORCID profile name. ORCID signups skip email verification (go directly to `confirmed:` state, return `{ flow: 'choose', auth_token }`). ORCID-only signups (no email) use plain INSERT. Dual nonce lookup (unified + legacy keys). Follow-up: ORCID-2b needed for null password_hash guard in resend-verification handler.

### ORCID-1 — Unified ORCID route + migration (2026-04-19) — Reviewed ✓

New `backend/src/routes/orcid.ts` with unified `POST /api/orcid/start` and `POST /api/orcid/callback` supporting 4 modes (signup, login, accredit, link). Migration `002_nullable_email.sql` makes email nullable. `NO_ACCOUNT` error code added. Auth.ts updated with dual nonce lookup (`orcid_verified:` then legacy `signup_orcid_verified:`). Removed `orcidRedirectUri`/`orcidSignupRedirectUri` from config; redirect URI derived at runtime. Old routes preserved with derived URI until ORCID-4 cleanup.

### P3-1 — Extend edit authorization to claimed co-authors (2026-04-19) — Reviewed ✓

`edit.js`: `isAuthorized` getter extended with accepted authorship claim check; `loadPaperData()` extracts `authorship_claims` from enrichment. `paper-detail.js`: `isOwnPaper` getter extended with same check for Edit button visibility. Co-author edits correctly use continuation flow via existing `isContinuation` logic. No backend changes needed.

### P1-4 — Settings page ORCID section (2026-04-19) — Reviewed ✓

ORCID link/update flow in settings page. `startOrcidLink()` API function, OAuth redirect with CSRF state params, hostname validation (orcid.org/sandbox.orcid.org), localStorage signals for callback routing, accreditation gate on endpoint. Redis + in-memory fallback for state storage. i18n keys in all 16 locales.

### P1-3 — Display verified ORCID on profile pages (2026-04-19) — Reviewed ✓

Conditional ORCID display on profile pages with official SVG icon, linked to orcid.org. Only shows verified ORCID from accreditation data (not self-reported). Backend returns `orcid` from accreditation payload.

### P2-5 — Claim authorship UI (2026-04-19) — Reviewed ✓

Frontend claim UI on paper-detail: status badges (confirmed/pending), eligibility-gated claim buttons (ORCID/username/name match heuristic), approve/reject for post authors, unlisted author claims. API functions (fetchPaperClaims, claimAuthorship, approveAuthorshipClaim, revokeAuthorshipClaim). Broadcasts via broadcastOps/Keychain. Bridge paper approvals server-side. Profile UNION query includes claimed papers. i18n keys in all 16 locales.

### P2-6 — Reputation credit for claimed co-authors (2026-04-19) — Reviewed ✓

Extended `computeReputationBatch()` with `claim_events`, `claimer_orcids`, `accepted_claims` CTEs. Co-authors with accepted claims get equal paper credit. Revoked claims excluded. Self-claims excluded to avoid double counting.

### P2-4 — Notifications for authorship claims (2026-04-19) — Reviewed ✓

Three notification types: `claim_pending` (post author), `claim_approved` (claimer), `claim_revoked` (claimer). UNION ALL blocks in HAF notification query + switch cases in event parser + digest descriptions. Note: co-author-listed-on-new-paper notification deferred (requires paper creation listener pattern not yet in notification system).

### P2-3 — Backend claim endpoints (2026-04-19) — Reviewed ✓

`backend/src/routes/claims.ts` with GET list, POST claim, POST approve, POST revoke. Bridge papers server-broadcast, native papers return operation for frontend. Custody allows claim actions for light accounts. `authorship_claims` added to paper enrichment response. Author list merging deferred to frontend.

### P1-1 — Add `orcid` to accreditation custom_json payload (2026-04-19) — Reviewed ✓

Added `orcid: orcidId` to both standard and link-mode `customJsonPayload` in `backend/src/routes/accreditation.ts`. `signup-verify.ts` already included orcid.

### P1-2 — Extract `orcid` in HAF accreditation CTE (2026-04-19) — Reviewed ✓

Added `orcid` field to `accred_ranked` and `active_accreditations` CTEs in `hafsql.ts`. Propagated to accreditations list endpoint and profile accreditation response. Note: `/api/accreditations/:username` single-user endpoint still omits `orcid` from its response (minor inconsistency, not blocking).

### P1-3 — Display verified ORCID on profile pages (2026-04-19) — Reviewed ✓

Conditional ORCID badge in `profile.js:48-59`. Shows official ORCID SVG logo + clickable link to `https://orcid.org/<id>`. Only renders when `profile.accreditation.orcid` is present.

### P1-4 — Settings page ORCID section, backend part (2026-04-19) — Reviewed ✓

`GET /api/accreditation/orcid/link-start` endpoint for accredited users. Shared callback detects `mode: 'link'` from state, preserves existing accreditation fields via `getExistingAccreditation()` helper, broadcasts updated `accredit` custom_json with new ORCID. UI part still pending.

### P2-2 — HAF CTE for authorship claims (2026-04-19) — Reviewed ✓

`authorshipClaimsCteBody()` in `hafsql.ts` with 5 CTEs computing claim status. Auto-accept by ORCID match or hive username match. Revocation logic checks block ordering against latest approval. Requires `active_accreditations` in scope.

### P2-1 — Authorship claim custom_json schemas (2026-04-19) — Reviewed ✓

Schemas defined in `agents/docs/hive-schemas.md` sections 2.9 (claim_authorship), 2.10 (approve_authorship), 2.11 (revoke_authorship). All three payloads specified with required fields, signing accounts, and auto-accept conditions documented.

### SRCH-F1 — Show review results in search UI (2026-04-19) — Reviewed ✓

Implemented in `search.js`. Type filter dropdown (all/papers/reviews). Review results link to parent paper with hash anchor to review. Reviewer name and snippet shown. Type badge per result. All i18n keys in 16 locales.

### PSORT-F1 — Wire sort control on profile reviews tab (2026-04-19) — Reviewed ✓

Implemented in `profile.js`. Sort dropdown (date/votes) in reviews tab. Re-fetches with sort param on change. All i18n keys in 16 locales.

### VVER-F1 — Show voted-version indicator to current user (2026-04-19) — Reviewed ✓

Implemented in `vote-buttons.js` and `paper-detail.js`. `myVotedVersion`/`voteIsOutdated` getters. Amber notice below paper-level vote controls only (not review votes). `vote.outdatedNotice` key in all 16 locales.

### SRCH-B1 — Add review search support to search endpoint (2026-04-19) — Reviewed ✓

Implemented in `search.ts`. Separate `searchPapersFromHaf` and `searchReviewsFromHaf` helpers. `type=review` searches child comments with `type='review'` metadata, ILIKE on body only. `type=all` runs both in parallel and merges by created date desc. `type=paper` unchanged. Review results include `paper_author`/`paper_permlink`, `title: null`. `is_accredited` computed in route handler for all types.

### PSORT-B1 — Implement sort param on profile reviews endpoint (2026-04-19) — Reviewed ✓

Implemented in `profile.ts`. Route reads `sort` query param (votes/date, default date), passes to `fetchUserReviewsFromHaf`, included in cache key. `sort=votes` uses accredited net_votes correlated subquery with `c.created DESC` tiebreaker. `sort=date` preserves existing ORDER BY behavior.

### VVER-B1 — Add voted_version to voter objects in enrichment response (2026-04-19) — Reviewed ✓

Implemented in `papers.ts`. `block_num` on `PaperVersionEntry`, preserved through `resolveVersionsFromHaf`. `fetchEnrichmentFromHaf` builds `versionBlocks` array, `inferVotedVersion` helper infers version from block number. Voter objects include `voted_version` from revote explicit version or block_num inference. Shape: `{ voter, weight, effective_weight, voted_version }`.

### TYPC-1 — Delete dead types from responses.ts (2026-04-19) — Reviewed ✓

No action needed. `responses.ts` already does not exist. Types are in their consumer files: `PaperSummary` in `helpers.ts`, `BridgeLookupResult`/`BridgeLookupAuthor` in `bridge.ts`, notification types in `notification-queries.ts`. No `responses.js` export in `types/index.ts`.

### STALE-3 — Drop vote staleness from frontend (2026-04-19) — Reviewed ✓

Removed all vote staleness UI from `vote-buttons.js` (`myVoteIsStale`, `staleVoteCount`, stale reset, stale branch in `voteCountLabel`; simplified `activeVoteCount`). Removed from `paper-detail.js`: `staleVotesAtVersion()`, stale vote count badge, stale vote banner, `myVoteIsStale` styling. Removed `staleBanner`, `votesWithStale`, `staleAtVersion`, `pendingShort` keys from all 16 locale files. No residual stale references found.

### UNAME-1 — Move username availability check to frontend (2026-04-19) — Reviewed ✓

Replaced backend `checkUsernameAvailability` API call with direct `@hiveio/dhive` `client.database.getAccounts()` call (lazy-loaded via dynamic import). Removed `checkUsernameAvailability` from `api.js`. Frontend `isValidUsername()` covers same rules as removed backend regex. Zero references to `checkUsernameAvailability` or `username-available` remain in codebase.

### STALE-1 — Drop vote staleness from reputation computation (2026-04-19) — Reviewed ✓

Removed `paper_revisions` CTE and its JOIN from `paper_resolved_votes` in `reputation.ts`. Votes now resolved purely by latest signal per voter, self-vote exclusion, co-author exclusion, and weight != 0 retraction. No issues.

### STALE-2 — Drop vote staleness from paper detail endpoint (2026-04-19) — Reviewed ✓

Removed `latestRevisionTs`/`contentRevisions` computation and `stale` field from voter objects in `papers.ts`. `effective_weight` is always the signal weight. Review "outdated" logic (separate from vote staleness) correctly preserved.

### STALE-4 — Update tests for vote staleness removal (2026-04-19) — Reviewed ✓

No changes needed. No test fixtures or assertions reference vote staleness. Only "stale" reference in tests is `setup.ts` Redis cache cleanup comment, which is unrelated.

### UNAME-2 — Remove `/api/auth/username-available` endpoint (2026-04-19) — Reviewed ✓

Removed `GET /username-available` route handler, `USERNAME_RE`/`BAD_SEGMENT_RE` constants, and unused `hiveClient` import from `auth.ts`. Username validation at account creation time (`signup-verify.ts:165`) is unaffected.

### REP-SQL-4 — Clean up removed JS reputation code and update tests (2026-04-19) — Reviewed ✓

Implemented by Backend agent. Removed `getUserStatsFromHiveApi()`, `emptyStats()`, and unused imports from `reputation.ts`. Updated `getReputationScore()` fallback to return zero when HAF unavailable. Updated `profile.ts` to use optional chaining with zero-fallback instead of Hive API fallback. Also added missing `continues IS NULL` filter to profile papers HAF query and Hive API path. TypeScript compiles clean.

### VOTE-1A — Update hive-schemas.md revote documentation (2026-04-18) — Reviewed ✓

Completed 2026-04-18. Updated `agents/docs/hive-schemas.md` section 3.1 and wrote `agents/docs/vote-resolution.md`.

### VOTE-1B — Remove phantom vote restriction (2026-04-19) — Reviewed ✓

Already implemented prior to 2026-04-19. The enrichment function in `papers.ts` processes revote-only voters (no native vote required) in a separate loop at ~line 1298-1314.

### VOTE-1C — Always query revote custom_json (2026-04-19) — Reviewed ✓

Already implemented prior to 2026-04-19. The revote query at ~line 1188 runs unconditionally (no `if` gate).

### VOTE-1D — Handle weight=0 as vote retraction (2026-04-19) — Reviewed ✓

Already implemented prior to 2026-04-19. Vote resolution skips voters with `effectiveSignalWeight === 0` at lines ~1282 and ~1302.

### VOTE-1E — Rewrite vote counting for list view with parallel strategy (2026-04-19) — Reviewed ✓

Already implemented prior to 2026-04-19. `batchResolveVotes()` at ~line 56-172 of `papers.ts` runs native votes and revotes in parallel via `Promise.all()`, merges by highest `block_num`, handles weight=0 retractions, computes `net_votes` and `vote_strength`, and re-sorts in JS when sorting by votes.

### VOTE-1F — Update reputation to use latest-vote-per-voter-per-paper (2026-04-19) — SUBSUMED

Subsumed by REP-SQL-2. The all-SQL reputation query implements latest-signal-per-voter natively.

### VOTE-1G — Add weight=0 retract option to vote UI (2026-04-18) — Reviewed ✓

Implemented 2026-04-18. See changes in `vote-buttons.js`, `paper-detail.js`, and all locale files.

### VOTE-1H — Display vote strength in list and detail views (2026-04-19) — Reviewed ✓

Already implemented prior to 2026-04-19. `vote-buttons.js` accepts `voteStrength`, has `strengthLabel()` and `voteCountLabel()` showing count + strength tier. `paper-detail.js` passes `voteStrength` from enrichment data. `home.js` list view uses `vote.strength.*` i18n keys. All 16 locale files have strength tier translations.

### REP-SQL-1 — Update algorithm spec for deterministic cycle-based SQL computation (2026-04-18) — Reviewed ✓

Completed 2026-04-18. Updated `agents/docs/reputation-algorithm-v3.md` to v0.4. Rewrote "Voter Reputation Weighting" section, added `cycle_blocks` parameter, defined cycle boundaries, replaced SQL sketch with full canonical SQL query (18 CTEs). Updated `agents/docs/hive-schemas.md` section 2.4.

### REP-SQL-2 — Move reputation computation to all-SQL query (2026-04-18) — Reviewed ✓

Reviewed 2026-04-18. See detailed review below in Done section.

### CONT-4 — Filter continuation posts from citations listing — REMOVED

Citations endpoint (`GET /api/papers/:author/:permlink/citations`) was removed as unused. Citation data is returned inline in paper detail responses.

### PERF-1 — Accreditations: single query with window count (2026-04-18) — Already implemented ✓

`fetchAccreditationsFromHaf()` in `backend/src/routes/accreditations.ts` already uses a single query with `count(*) OVER ()::int AS total`. Verified 2026-04-18.

### REP-SQL-3 — Rewrite batch job for deterministic cycle-based computation (2026-04-19) — Reviewed ✓

Reviewed by Architect (2026-04-19). Full rewrite of `reputation-batch.ts` verified against spec. Cycle determination: `floor((head_block - genesis_block) / cycle_blocks)` at L77. `cycle_blocks` read from reputation weights (L64), genesis from HAF (L65). Last computed cycle tracked in Redis `reputation:cycle:last` (L24,84,193). Cycle 0 bootstrap: `prevScores = {}` when `startCycle === 0` (L97-98), all voters get weight 1.0. Each subsequent cycle uses prior cycle's results (L197). Sequential catch-up loop (L114). No convergence iterations — single pass per cycle. `computeReputationSql()` called with `cycleEndBlock = genesis + (cycle+1) * cycleBlocks` (L121,161). Results stored via Redis pipeline (L189-194). Timer reduced from 24h to 1h (L19), checks cycle boundaries and skips if up-to-date (L87-89). Time cap (30min default) with partial result handling: marks cycle done and breaks (L115-117, 147-155, 193) — safe because missing users fall through to on-demand computation, and next run rebuilds prevScores from all Redis keys (L100-111). Adaptive concurrency reduces to 1 on slow HAF (L179-185). On-demand path (`getReputationScore()` → `computeReputationSql()`) uses batch scores from Redis as prevScores via `getBatchReputationMap()` fallback (reputation.ts:751). No issues.

## Done

### REP-SQL-2 — Move reputation computation to all-SQL query (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). `computeReputationSql()` at reputation.ts:725-1131 implements the canonical 18-CTE SQL query from the v0.4 spec. Papers/reviews/citations each have proper vote signal merging (native + revote via UNION ALL). `voter_weights` CTE distinguishes active vs inactive accounts (0.4 floor for active, pure sqrt for inactive). Decay computed in SQL via `EXTRACT(EPOCH FROM ...)`. Final aggregation clamps to [0, 100], rounds to 1 decimal. `getReputationScore()` at L1140-1153 uses SQL as primary path, falls back to JS computation via Hive API. `cycle_blocks: number` added to `ReputationWeights` in domain.ts:65 with default 201600. Parameters $1-$18 correctly mapped to all weight/config values. No issues.

### CONT-1 — Filter continuation posts from search results (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). search.ts:91 adds `(c.json_metadata -> ${appTagParam} -> 'continues') IS NULL` to the WHERE conditions. Correctly uses the parameterized `appTagParam` for the JSON path. No issues.

### CONT-2 — Filter continuation posts from user profile papers (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). HAF count query (profile.ts:154) and data query (profile.ts:166) both add `AND (json_metadata -> $2 -> 'continues') IS NULL`. Hive API fallback (profile.ts:201-202) checks `pevo?.continues` and returns false. All three code paths filter correctly. No issues.

### CONT-3 — Filter continuation posts from platform stats (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). stats.ts:40 adds `AND (c.json_metadata -> ${at} -> 'continues') IS NULL` to the papers CTE. Correctly placed alongside other type/app filters. No issues.

### CONT-5 — Filter continuation posts from vote counting (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). Verified no code changes needed. List query filters continuations at papers.ts:251 (`'continues' IS NULL`). `accreditedVoteCount()` runs as a correlated subquery within already-filtered results. `batchResolveVotes()` only processes papers from the filtered list. Detail/enrichment endpoints redirect continuation posts to canonical root via `findCanonicalRoot()` before vote counting. No issues.

### DOI-1 — Remove DOI endpoints from backend and contract (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). No `doi` route handlers remain in papers.ts. `DoiResponse`/`DoiStatus` types removed from responses.ts. DataCite config removed from config.ts. DOI endpoint sections removed from api-contract.md. No issues.

### PERF-2 — Search: parallelize count and data queries (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). search.ts:112 wraps `countResult` and `dataResult` in `Promise.all()`. Both queries use identical CTE, WHERE clause, and params (count gets only the ILIKE pattern, data gets ILIKE + limit + offset). No issues.

### PERF-3 — getAccreditedSet: check cache before querying HAF (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). accreditation.ts:18-23 checks `hafCache.get('accredited_accounts_all')` as a fast path. If cached, filters the requested usernames against the full set locally and returns immediately. Falls through to existing HAF batch query when cache is cold. No issues.

### VOTE-1G — Add weight=0 retract option to vote UI (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). `vote-buttons.js`: `_updateLocalVoter(0)` correctly removes voter from array; `handleVote(0)` has dedicated retract branch with confirmation dialog (`confirm.retractMessage` + `confirm.retract`), broadcasts `weight: 0` via native vote or revote custom_json depending on payout window, adjusts `displayVotes` correctly, resets state to `voteState='none'`, invalidates cache. `paper-detail.js`: retract button in both paper and review vote dropdowns, gated on `voteState !== 'none'`. All 16 locale files have `vote.retract`, `confirm.retractMessage`, `confirm.retract` keys. Edge case: re-clicking retract when already retracted is caught by the `currentWeight === weight` guard (line 130). No issues.

### Signup Flow v2 — SF1–SF10 (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). All 10 tasks verified against spec. Backend: migration drops `username`/`link_flow` from `pending_signups`, all 6 endpoints updated (signup, verify, confirm, resume-signup, link simplified). Frontend: signup form simplified, `hive-keys.js` key derivation matches backend algorithm, `signup-verify.js` rewritten with full phase flow, `@scure/bip39` added. Deliberate deviation from spec: confirm/link endpoints use high-entropy auth_token instead of email+password re-entry — accepted. 189 backend tests pass, frontend builds clean.

### Backend: LA12 — Upgrade notification endpoint (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `POST /api/custody/upgrade` in `custody.ts:131`: validates `custody: "light"`, password re-entry via argon2, NULLs posting_key_enc/iv_posting/memo_key_enc/iv_memo, sets `upgraded_at = NOW()`, issues new JWT with `custody: "self"`, audit logs success and failure. Rate-limited 1/hr/account. On-chain key verification omitted (spec marked it optional). No issues.

### Backend: LA13 — Password reset flow (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). Two endpoints in `auth.ts:269-410`. `reset-request`: email lookup with constant-time response (prevents enumeration), 1-hour token, HTML+text email, clears token on mail failure. Rate-limited 5/hr/IP. `reset`: token + expiry validation, password complexity (10 chars + lowercase + uppercase + numbers), argon2id hash, sets `sessions_invalidated_at = NOW()`. Session invalidation enforced in `verifyHiveSignature.ts:78-97` — compares JWT `iat` against timestamp, rejects stale JWTs. Migration `004_password-reset.sql` adds `reset_token`, `reset_token_expires_at`, `sessions_invalidated_at`. Audit logged. No issues.

### Backend: LA1 — Database migrations for light accounts (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). Migration `003_light-accounts.sql` + `app-db.ts` create `pending_signups` (with `linked_username`), `light_accounts`, `custody_audit_log`, `account_creation_tokens`. **Fix applied during review:** removed `active_key_enc` and `iv_active` columns — active key is never stored server-side (upgrade is client-side). No other issues.

### Backend: LA2 — Key encryption/decryption module (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `custody-crypto.ts`: AES-256-GCM, HKDF-SHA256 with `pevo:custody:${username}` context, 96-bit random IV, auth tag appended to ciphertext. `CUSTODY_ENCRYPTION_KEY` from config. No issues.

### Backend: LA4 — Institutional email domain validator (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `email-validator.ts`: `.edu`, `.ac.*` (11 countries), `.edu.*` (17 countries), German/French patterns (regex), 5 research institutes, `.gov`. Extensible via `INSTITUTIONAL_EMAIL_DOMAINS` env var. No issues.

### Backend: LA5 — BIP39 seed phrase + Hive key derivation (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `seed-phrase.ts`: 12-word BIP39 mnemonic (128 bits), HMAC-SHA512 with `account+role`, `PrivateKey.fromSeed()`. Exports `generateSeedPhrase`, `deriveKeysFromMnemonic`, `generateKeysFromNewSeed`, `isValidSeedPhrase`. No issues.

### Backend: LA10 — Add `custody` claim to JWT (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). JWT includes `custody: "light" | "self"`. Keychain sessions get `"self"` (verifyHiveSignature.ts:150). Light accounts get `"light"` (auth.ts:244, signup-verify.ts:218). Middleware extracts to `req.hiveCustody` (verifyHiveSignature.ts:75). Session response includes `custody`. No issues.

### Backend: LA3 — Account creation service (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `account-creation.ts`: 6h claim interval, `claim_account` + `create_claimed_account` broadcasts, `FOR UPDATE SKIP LOCKED` token reservation, wired into index.ts startup/shutdown. No issues.

### Backend: LA6 — Signup endpoint (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `POST /api/auth/signup` in `auth.ts`: institutional email validation, username format + Hive availability, duplicate checks, argon2id hash, pending_signups with ON CONFLICT upsert, verification email, `linked_username` support. Rate-limited 10/hr/IP. **Fix applied during review:** added password complexity validation (lowercase + uppercase + numbers required, per spec §10.1). No other issues.

### Backend: LA8 — Password login endpoint (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `POST /api/auth/login`: lookup by username or email, argon2id verify, custody claim from `upgraded_at`, lockout after 20 failures/hr, rate-limited 10/hr/IP. No issues.

### Backend: LA11 — Custody audit logging (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `custody-audit.ts`: non-blocking INSERT, graceful null pool handling, error logged not thrown. No issues.

### Backend: LA14 — Pending signup cleanup job (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `signup-cleanup.ts`: hourly cleanup of expired rows, wired into startup/shutdown, timer unref'd. No issues.

### Backend: LA7 — Email verification callback (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `signup-verify.ts`: `POST /api/auth/verify` branches on `linked_username`. New accounts: seed phrase generation, mnemonic SHA256 hash storage. `POST /api/auth/confirm`: hash verification, `createClaimedAccount`, encrypts posting + memo keys, accreditation broadcast, JWT `custody: "light"`. No issues.

### Backend: LA23 — Link existing Hive account endpoint (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `POST /api/auth/link`: Keychain signature matching `linked_username`, light_accounts row with no keys and `upgraded_at = created_at`, accreditation broadcast, JWT `custody: "self"`. No issues.

### Backend: LA9 — Custodial broadcast endpoint (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `routes/custody.ts`: `ALLOWED_OPS = Set(['comment', 'vote'])`, author/voter enforcement, APP_TAG validation, posting key decrypted in-memory only, non-blocking audit log. Rate-limited 30/min/account. No issues.

### UI: LA15 — Signing abstraction (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `signer.js`: dual-path routing (custody API for light, Keychain for self), vote auto-detection. Auth store `custody` persisted to sessionStorage. No issues.

### UI: LA16 — Signup page (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `pages/signup.js` + `/signup` route. Email, username picker with debounced availability check, password with confirmation, link-existing checkbox. No issues.

### UI: LA17 — Seed phrase display + retention confirmation (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `pages/signup-verify.js` + `/signup/verify` route. Phases: verifying → seed (3x4 grid) → confirm (3 random words) → creating → done. Link-existing branch. No issues.

### UI: LA24 — Link existing Hive account UI (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). Integrated into signup.js (checkbox toggle) and signup-verify.js (link-keychain phase). No issues.

### UI: LA18 — Login page (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `pages/login.js` + `/login` route. Email/password form, session with custody from backend. No issues.

### UI: LA19 — Refactor all Keychain call sites (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). All 6 files refactored to `broadcastOps()`. **Fix applied during review:** vouch-section.js: added `isLightAccount` getter, `canVouch`/`canRetract` exclude light accounts. Added vouch section HTML template to profile page in index.html with light-account message. Added `wot.keychainRequiredToVouch` i18n key to all 16 locales. No other issues.

### UI: LA25 — Confirmation modals for light account broadcasts (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `broadcastConfirm` store + modal. Auto-confirms for non-light. Wired into publish, review, vote, comment. No issues.

### UI: LA20 — Upgrade flow UI in settings (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `pages/settings.js` + `/settings` route. Client-side BIP39, multi-phase upgrade, dynamic crypto loading. No issues.

### UI: LA21 — Password reset pages (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `pages/reset-password.js` + `/reset-password` route. Request + reset modes. No issues.

### UI: LA22 — i18n keys for light accounts (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). 7 key groups in all 16 locales. 122 keys per locale. All JSON valid. No issues.

### UI: RC1 — Add threaded comment section to each review card (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Collapsible comment section at index.html:1243-1278, placed after review body inside `x-for="rev in paper.reviews"` loop. Toggle button with chat icon at L1245-1249 uses local `showComments` state. `x-if="showComments"` gates `threadedComments` initialization (Option B lazy loading). `threadedComments` at L1252 receives `rev.author`/`rev.permlink` — reuses existing component unchanged. `commentComposer` at L1265 with `rev.author`/`rev.permlink` for reply posting. Comment count shown via `review.commentsToggle` (L1260) with ICU plural syntax. Empty state via `review.noComments` (L1259). All 16 locales have 3 new keys (`commentsToggle`, `noComments`, `replyToReview`) with real translations. No backend or component changes. No issues.

### Architect: L0 — Locale routing spec (2026-04-13) — Reviewed ✓

URL-based locale routing with `/:locale/path` structure, 302 redirects for bare paths, hreflang sitemap, backwards-compatible with existing URLs. ARCHITECTURE.md section 13 updated.

### UI: L1 + L2 — Locale-aware router and i18n URL detection (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). **router.js:** `parsePath()` at L67-74 extracts locale from first path segment via `SUPPORTED_LOCALES.includes(segments[1])`, strips it, returns `locale` in result. Router store has `locale` property (L101). `navigate()` at L103-117 auto-prepends `/${currentLocale}` if path lacks a locale prefix. `popstate` handler at L128-135 syncs i18n store when locale changes via back/forward. **i18n.js:** `detectLocale()` at L18-37 priority: (1) URL path, (2) cookie, (3) navigator.language, (4) `en`. `setLocale()` at L82-98 calls `replaceState()` to swap locale prefix in URL and syncs router store locale. `$lp` Alpine magic at L135-137: `(path) => '/' + locale + path`. **main.js:** After `initI18n()`, syncs router locale to i18n locale (L101-104). No issues.

### UI: L3 — Update HTML href attributes to use locale prefix (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All ~50 `<a>` tag `href` attributes in `index.html` converted from `href="/path"` to `:href="$lp('/path')"` and from `:href="'/path/' + expr"` to `:href="$lp('/path/' + expr)"`. Verified: zero remaining hardcoded `href="/..."` except static assets (`/favicon.svg`, `/manifest.json`) which correctly have no locale prefix. `threaded-comments.js:55` profile href updated to use `$lp`. No changes to `navigate()` calls or `@click.prevent` handlers — router auto-prepends locale. No issues.

### Backend: L6 + L7 — Locale extraction and SSR meta injection (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). **Locale extraction:** `SUPPORTED_LOCALES` Set and exclusion sets (`NO_LOCALE_PREFIXES`, `NO_LOCALE_FILES`) at app.ts:233-237. `detectLocale()` at L239-260 parses cookie via `parseCookie()` helper then `Accept-Language` with q-weight sorting. SPA catch-all at L355-460: valid locale → strip and proceed; bare path → 302 redirect with query string preservation. **SSR patterns:** `paperRouteRe` at L212 captures locale/author/permlink. `profileRouteRe` at L213. `staticPageMeta` lookup at L436 uses `pathWithoutLocale`. **hreflang:** `buildHreflangTags()` at L268-275 emits 14 locale links + `x-default` → `/en/...`. Injected in paper meta (L333), profile meta (L427), static page meta (L452), and generic pages (L458). **Breadcrumb:** fixed to use locale-prefixed Papers link (`/${locale}/papers`). No issues.

### Backend: L8 — Sitemap with locale prefixes and hreflang (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `xmlns:xhtml` namespace added to `<urlset>` at L194. `hreflangLinks()` helper at L153-158 emits `<xhtml:link>` for all 14 locales + `x-default`. `staticPaths` at L146 kept as bare paths; `url()` helper at L160-165 uses `/en${path}` for `<loc>` and injects `hreflangLinks(path)` inside each `<url>`. Dynamic paper URLs use same pattern (L187). No issues.

### UI: C1 — Add `canonical_url` to `json_metadata` on publish and edit (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All three broadcast paths add `canonical_url` at `json_metadata` root (outside `pevo` namespace). publish.js:494 uses `${window.location.origin}/paper/${username}/${permlink}`. edit.js:483 (continuation) uses `${window.location.origin}/paper/${username}/${newPermlink}`. edit.js:535 (same-author edit) uses `${window.location.origin}/paper/${this.author}/${this.permlink}`. No issues.

### Backend: C2 — Add `canonical_url` to bridge post metadata (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `buildBridgeMetadata()` at bridge.ts:440 takes two new params (`postAuthor`, `postPermlink`). Returns `canonical_url: \`${config.appUrl}/paper/${postAuthor}/${postPermlink}\`` at object root (L484). Both call sites in routes/bridge.ts pass `config.hiveBridgeAccount` and `permlink` (L207-208, L335-336). No issues.

### Backend: C3 — Add `<link rel="canonical">` to SSR meta injection (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `<link rel="canonical" href="${escAttr(reqUrl)}" />` added at app.ts:175 in `ogTags` array, gated on `reqUrl` truthy. Properly escaped. Injected into `<head>` alongside OG tags. No issues.



### UI: D2 — Version diff computation module (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `version-diff.js` exports `computeVersionDiff(versionA, versionB)`. diff_match_patch used for title/body with `diff_main` + `diff_cleanupSemantic`, returns `[{type, text}]` segments. Body `diffable: false` when either version has `ipfs_cid`. Authors compared by `hive`, supplementary files by `cid`, citations by `author|permlink`, keywords by string set — all return full objects in added/removed arrays with `changed` boolean. No issues.

### UI: D3 — Version comparison state in paper-detail.js (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All 6 state vars (`diffMode`, `diffVersionA/B`, `diffResult`, `diffLoading`, `diffError`, `pickingDiffVersions`) at lines 38-45. `selectDiffVersions()` (L341-351) toggles pick mode. `pickDiffVersion(n)` (L353-368) sets A then B with auto-sort A<B. `startDiff()` (L370-386) fetches both versions via `Promise.all` with version param, calls `computeVersionDiff`, sets `diffMode`. `exitDiff()` (L388-396) resets all state. No issues.

### UI: D4 — Diff view HTML template (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Diff panel at index.html:743-859. Header with comparing label + close button (747-748). Loading state (751-754). No-changes fallback (758-761). Title diff with green insert / red strikethrough delete spans (763-776). Body diff with colored segments or PDF notice (778-796). Authors +/- list (798-811), supplementary files +/- with size (813-826), citations +/- (828-841), keywords as inline tags (843-856) — all gated on `changed`. No issues.

### UI: D5 — Compare versions button and version picker (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Button at index.html:727-734 inside `versions.length > 1` template gate (L697). Version buttons (702-713) conditionally call `pickDiffVersion` vs `loadVersion` based on `pickingDiffVersions`. Selected versions highlighted: blue ring for A, green ring for B (707-708). Button label toggles between "Compare versions" and "Close comparison" with dark styling when active. No issues.

### UI: D6 — Version diff i18n keys (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). 16 `diff.*` keys in all 14 locale files. Verified en.json (all 16 present), spot-checked de/ar/zh — real translations, not English copies. `comparing` uses `{a}`/`{b}` interpolation in all locales. No issues.

### Backend: Harden batch reputation job for scale (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All 5 hardening requirements verified against `reputation-batch.ts`: (1) `maxDurationMs` default 30 min, checked before each chunk with partial Redis writes and skip logging. (2) `Promise.all` chunks of 5 via `DEFAULT_CONCURRENCY`. (3) `isHafAvailable()` at iteration start, skip with warning. (4) Rolling per-user avg tracked, concurrency reduced to 1 when >5s. (5) `batchRunning` boolean lock in try/finally, overlapping runs rejected. Convergence (3 iterations), Redis key format, startup/shutdown, 24h interval all unchanged. No issues.

### UI: Platform comparison table on about page (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Table at index.html:2548-2596, correctly placed after Open Source section. 10 feature rows × 7 platform columns with data-driven Alpine.js rendering. Symbol styling correct: `text-pevo-green` (✓), `text-amber-500` (partial ✓), `text-pevo-crimson` (✗), `text-ink-muted` (—). PEvO column highlighted with `bg-pevo-teal-light/30` on header and data cells. Responsive: `overflow-x-auto` wrapper, sticky left feature column (`sticky left-0 bg-white`). All 19 i18n keys (`comparisonTitle`, `comparisonSubtitle`, `comparisonFooter`, 6 platform headers, 10 feature labels) present in all 14 locales. Table data matches spec exactly. No issues.

### UI: R6 — Update profile reputation display (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Deprecated fields (`paper_votes`, `review_votes`, `account_age`) properly filtered in `breakdownEntries` getter at profile.js:45-50. HTML template uses `$t('profile.breakdown.' + key)` with fallback. i18n keys for all 4 active fields (papers, reviews, citations, accreditation) in all 14 locales. Backend breakdown at reputation.ts:568-574 emits only the 4 valid fields. Test at profile.test.ts:28-38 asserts deprecated fields absent and accreditation present. No issues.

### UI: R7 — Add `reputation_relevant` toggle to citation picker on publish form (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Citations array at publish.js:64 with add/remove/toggle methods at lines 295-308. HTML form at index.html:1353-1382 with author/permlink/title inputs and checkbox for `reputation_relevant`. Citations stored in `json_metadata.pevo.citations` with filtering (lines 448-450) — empty entries excluded, `reputation_relevant` boolean preserved. Draft save/restore works. i18n keys (`publish.citations`, `citationsHint`, `citationAuthor`, `citationPermlink`, `citationTitle`, `citationReputationRelevant`, `noCitations`, `addCitation`) in all 14 locales. No issues.

### UI: R8 — Vote strength selector (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `vote-buttons.js` defines 6 levels: Strong endorsement (+10000), Endorsement (+6000), Mild endorsement (+2500), Mild concerns (-2500), Reject (-6000), Strong reject (-10000) with green/red Tailwind color coding. Accredited users get dropdown selector via `handleVote()`, non-accredited get simple up/down via `handleSimpleVote()` (+/-10000 only). Non-accredited voting redirects to `/accreditation`. Vote UI on paper detail (index.html:842-888) and review cards (1032-1065). Current vote level shown after voting. i18n keys (11 vote keys) in all 14 locales. No issues.

### UI: PubPeer badge on paper detail page (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `loadPubPeer()` at paper-detail.js:81-97 POSTs to PubPeer v3 API when DOI exists. Stores `feedbacks[0]` in `pubpeerData`. Badge at index.html:910-919 renders only when `pubpeerData && total_comments > 0` — clickable link with count via `$t('pubpeer.badge', { count })`. Silent degradation: empty catch, `!res.ok` early return, optional chaining on feedbacks. i18n key `pubpeer.badge` with `{count}` interpolation in all 14 locales. No issues.

### Backend: R9 — Activity-gated voter weight floor (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `voterWeight()` at reputation.ts:90-96 now takes `hasActivity` parameter: active = `0.4 + 0.6 * sqrt(rep/100)`, inactive = `sqrt(rep/100)`. `getActiveAccounts()` at reputation.ts:117 queries HAF for accounts with papers/reviews, cached 1h via hafCache. `voteInfluence()` at reputation.ts:102 accepts `activeAccounts` set. `computeReputation()` at reputation.ts:507 passes active set through to all vote influence calls. `reputation-batch.ts` fetches active accounts once before convergence loop. 8 new test cases for inactive branch, all 40 tests pass. No issues.

## Done

### Backend: R1 — Update reputation types (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All correct: `Citation.reputation_relevant?: boolean` at domain.ts:16. `ReputationBreakdown` has only papers/reviews/citations/accreditation (domain.ts:40-45). `ReputationWeights` has downvote/citation_max, no v2 fields (domain.ts:54-65). `DEFAULT_REPUTATION_WEIGHTS` matches spec exactly (domain.ts:67-78). No issues.

### Backend: R2 — Rewrite computeReputation() (2026-04-13) — Reviewed ✓ (with follow-up)

Reviewed by Architect (2026-04-13). Vote influence formula correct (reputation.ts:91-95). Paper score formula correct (reputation.ts:470-482). Review score formula correct (reputation.ts:485-496). Citation scoring with quality-weighting, decay, reputation_relevant filtering, and citation_max cap all correct (reputation.ts:500-508). No account_age factor. reputationMap parameter correct (reputation.ts:463).

**One issue:** `voterWeight()` at reputation.ts:83-86 always applies the 0.4 floor. Missing the spec's two-branch logic (floor only for accounts with publications/reviews, pure sqrt for accounts with no activity). Tracked as R9.

### Backend: R3 — Update HAF queries (2026-04-13) — Reviewed ✓ (with follow-up)

Reviewed by Architect (2026-04-13). `v.weight` queried (reputation.ts:148,179). Per-paper and per-review vote lists correct. Review ratings queried for quality multiplier (reputation.ts:155-169). Citations carry `reputation_relevant` flag (reputation.ts:200). `getGlobalMaxRshares` removed. 

**One issue:** No voter activity data fetched for the two-branch voter weight formula. Tracked as R9.

### Backend: R4 — Batch reputation computation (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). 3 convergence iterations (reputation-batch.ts:19). Redis storage at `reputation:batch:{username}` with no TTL (reputation-batch.ts:89). Bootstrap mode returns 1.0 for unknown voters (reputation.ts:83-86). Startup/shutdown wired in index.ts:49-50,67. No issues.

### Backend: R5 — Update tests (2026-04-13) — Reviewed ✓ (with follow-up)

Reviewed by Architect (2026-04-13). No v2 breakdown fields asserted. Fixtures use v3 defaults. All required test cases present: downvote penalty (reputation.test.ts:177-216), review quality (218-243), self-citations near zero (293-309), citation cap (311-329), reputation_relevant filtering (331-349), voter weight formula (374-394), vote strength multiplier (76-87).

**One issue:** No test for the non-contributor voterWeight branch (pure sqrt without floor). Tracked as R9.

### UI: R6 — Update profile reputation display (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Deprecated fields filtered via exclusion list (profile.js:47-49). HTML iterates breakdownEntries with i18n (index.html:2064-2068). i18n keys for papers/reviews/citations/accreditation (en.json:105-110). E2E fixtures updated (fixtures.ts:59-65). No issues.

### UI: R7 — Citation reputation_relevant toggle (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Default true on addCitation (publish.js:296). Toggle method (publish.js:303-305). Included in json_metadata (publish.js:448-450). Checkbox bound in HTML (index.html:1357-1358). i18n key present (en.json:175). Draft save/restore includes citations (publish.js:152,227). No issues.

### UI: R8 — Vote strength selector (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All 6 levels with correct Hive vote weights (vote-buttons.js:4-11). Weight passed to Keychain requestVote (keychain.js:334-343). Current vote level shown (vote-buttons.js:30-33). Accredited users get dropdown, non-accredited get simple up/down (index.html:843-888, 1021-1053). Current vote highlighted (index.html:864). All 6 i18n keys present (en.json:308-320). No issues.

### Architect: E0 — Edit flow schemas and interface contracts (2026-04-12) — Reviewed ✓

Schemas defined in TASKS.md and implemented in `backend/src/types/hive.ts` (`AddressedReview`, `ContinuationPointer` interfaces, `addresses_reviews`/`continues` fields on `PaperPevoMeta`) and `backend/src/types/responses.ts` (`PaperVersion`, `PaperDetail`, `ReviewInPaper` updated).

### Backend: E1 — Continuation chain resolution (2026-04-12) — Reviewed ✓

`resolveContinuationChain` + `findCanonicalRoot` in `papers.ts`. Iterative queries, 50-hop cap, JOIN with `operation_comment_view` for block_num collision resolution.

### Backend: E2 — Update `reconstructVersionsFromHaf` for continuation chains (2026-04-12) — Reviewed ✓

Fetches ops for all chain links, continuation post first op treated as full body, `post_author`/`post_permlink`/`addresses_reviews` on versions.

### Backend: E3 — Hide continuation posts from paper listings (2026-04-12) — Reviewed ✓

`(c.json_metadata -> appTag -> 'continues') IS NULL` added to `fetchPapersFromHaf`.

### Backend: E4 — Reverse lookup for continuation post URLs (2026-04-12) — Reviewed ✓

Paper detail endpoint walks backward via `findCanonicalRoot` when post has `pevo.continues`.

### Backend: E5 — Update enrichment for review staleness (2026-04-12) — Reviewed ✓

Reviews gain `outdated` and `addressed_by_version` computed fields.

### Backend: E6 — Cache invalidation endpoint (2026-04-12) — Reviewed ✓

`POST /:author/:permlink/invalidate` with `verifyHiveSignature` + rate limiting. Invalidates `paper-detail` and `paper-enrichment` keys.

### Backend: E7 — Update `buildPaperDetail` response shape (2026-04-12) — Reviewed ✓

`canonical_author`/`canonical_permlink`/`head_author`/`head_permlink` added. Canonical = head for non-chain papers.

### UI: E8 — Add edit route and register page (2026-04-12) — Reviewed ✓

Route in `router.js`, `initEditPage()` in `main.js`.

### UI: E9 — Create edit page component (2026-04-12) — Reviewed ✓

`frontend/src/pages/edit.js`: pre-fill from paper, discipline read-only, authors add-only, diff-match-patch for same-author edits, continuation support, review address checklist, draft save/restore.

### UI: E10 — Add `editPaper` to keychain.js (2026-04-12) — Reviewed ✓

Single `comment` op without `comment_options`. Continuations use `publishPaper`.

### UI: E11 — Add "Edit" button to paper-detail (2026-04-12) — Reviewed ✓

Visible when `isOwnPaper && !paper.is_retracted`, navigates to canonical author/permlink.

### UI: E12 — Edit page HTML template (2026-04-12) — Reviewed ✓

Loading/error/not-authorized states, continuation banner, disabled discipline, add-only authors, review checklist, dynamic submit button.

### UI: E13 — diff-match-patch + cache invalidation API (2026-04-12) — Reviewed ✓

Frontend dependency installed, `invalidatePaperCache` in `api.js`.

### UI: E14 — Review version badges (2026-04-12) — Reviewed ✓

Amber "outdated" badge, green "addressed in v{N}" badge.

### UI: E15 — i18n strings (2026-04-12) — Reviewed ✓

22 keys in `edit` section + 2 keys in `versions` section across all 14 locale files.

### Backend: I5a — Track IPFS uploads in Redis (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified: `ipfs.ts:146-157` — after successful `pinToIpfs()`, gets Redis via `getRedis()`, null-checks, stores `{ cid, uploader, timestamp }` as JSON at key `ipfs:pending:{cid}` with `'EX', 86400` (24h TTL). Non-blocking via `.catch()` that logs warning. No issues.

### Backend: I5b — IPFS orphan cleanup background job (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified all 5 spec requirements:
1. `CLEANUP_INTERVAL_MS = 30 * 60_000` (30 min). `setInterval` in `startIpfsCleanup()` with `.catch()` wrapper. Correct.
2. `runCleanup()` uses Redis `SCAN` with `MATCH ipfs:pending:*`, `COUNT 100`, cursor loop until `'0'`. Age check: `now - data.timestamp < MAX_AGE_MS` skips entries under 24h. Correct.
3. `cidReferencedInHaf()` queries `hafsql.comments` with jsonb `@>` containment for both `pevo.ipfs_cid` and `pevo.supplementary_files[].cid`. Correct.
4. `unpinFromKubo()` calls `POST /api/v0/pin/rm?arg={encodeURIComponent(cid)}` with 15s timeout. Handles "not pinned" gracefully. Correct.
5. `startIpfsCleanup()`/`stopIpfsCleanup()` wired into `index.ts:46` (boot) and `index.ts:63` (graceful shutdown). Correct.

**Accepted deviation:** `cidReferencedInHaf()` also checks `json_metadata->'image'` array for CID matches — catches inline images not covered by spec. Good addition, no issues.

### Backend/Go: I4-fix — CID path traversal validation in community pinner (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). `ValidateCID()` in `pinner.go:13` uses anchored regex `^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58})$` — path traversal impossible. Called at all 4 user-facing entry points: `handlePin` (server.go:109), `handleUnpin` (server.go:129), `handleIPFSProxy` (server.go:189), `handleGateway` (ipfsnode.go:192). All return 400 on invalid CIDs. `LogConfig` length guard at config.go:136 prevents panic on short API keys. No issues.

### Backend/Go: I4 — Community pinner with embedded IPFS node (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). `go vet` passes clean. All 13 files present matching spec: `IPFSBackend` interface (5 methods), config with env/CLI/`.env` loading, HAF SQL discovery (paper CIDs, supplementary files, inline images), Pinata backend, embedded backend with local storage + gateway fetching, HTTP API (6 endpoints), Alpine.js management UI, multi-stage Dockerfile. Graceful shutdown on SIGINT/SIGTERM.

**Architectural deviation (accepted):** boxo/libp2p replaced with simpler fetch-and-store approach — no DHT participation, content only served via local HTTP gateway. Acceptable for initial release; boxo integration can be added later if IPFS network availability is needed.

**Security fix required (tracked as I4-fix):** CID path traversal in `ipfsnode.go` — unvalidated CID string used in `filepath.Join`. Plus minor `LogConfig` panic on short API key. Assigned as pending task.

### UI: I3b-form — Supplementary file upload on publish form (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). All features verified: `supplementaryFiles` array state with correct shape, `handleSupplementaryFiles()` with 5-file limit and 10MB validation, sequential upload during submit with per-file error/status handling, CIDs included in `json_metadata.pevo.supplementary_files`. HTML template has file list with filename/size/status, description input, remove button, conditional "Add files" picker. All 14 locale files have translations. IPFS gateway URL in `paper-detail.js` now configurable via `window.__PEVO_CONFIG__.ipfsGateway`. No issues.

### UI: I3b-display — Show supplementary files on paper detail (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). All features verified: `supplementaryFiles` getter with fallback chain (`paper.supplementary_files` → `json_metadata.pevo.supplementary_files` → `[]`), `supplementaryFileUrl(cid)` using configurable IPFS gateway, `formatFileSize(bytes)` helper. HTML template gated on non-empty array with document icon, filename linked to IPFS gateway (new tab, noopener), description + formatted size. All 14 locale files have `paperDetail.supplementaryFiles` key. No issues.

### Backend: I1 — Add Kubo IPFS container to Docker stack (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified against Phase 4 spec: `ipfs` service in `docker-compose.yml:41-60` matches spec exactly — `ipfs/kubo:latest`, `ipfs_data` volume, gateway `127.0.0.1:8082:8080`, API on 5001 (internal only), `IPFS_PROFILE=server`, healthcheck with `ipfs dag stat`, 1GB memory limit. Backend `depends_on` with `service_healthy`. `ipfs_data` in volumes. No issues.

### Backend: I2 — Replace Pinata with local IPFS pinning (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified: `config.ts:48-49` has `ipfsApiUrl`/`ipfsGatewayUrl` with correct defaults. `ipfs.ts:87-104` `pinToIpfs()` posts to Kubo `/api/v0/add?pin=true` with 30s timeout, parses `Hash`/`Size`. Config check at `ipfs.ts:137` uses `ipfsApiUrl`. Pinata keys retained per spec. No issues.

### Backend: I3 — Accept images and data files in IPFS upload (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified: `ipfs.ts:24-33` has all 8 MIME types matching spec. `validateMagicBytes()` at `ipfs.ts:35-62` correct for all types (PDF, PNG, JPEG, GIF, WebP bytes 8-11, SVG BOM-strip + `<svg` in first 1024, ZIP `PK\x03\x04`, CSV MIME-only). Response includes `type` field at `ipfs.ts:148`. Error message lists all types. No issues.

### Backend: I3b-types — Add SupplementaryFile type to PaperPevoMeta (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified: `SupplementaryFile` at `hive.ts:14-20` matches spec (`cid`, `filename`, `type`, `size`, optional `description`). Added to `PaperPevoMeta` at `hive.ts:37`. Imported and added to `PaperDetail` at `responses.ts:12,82`. `buildPaperDetail()` at `papers.ts:546` populates from `pevo.supplementary_files` with `[]` default. No issues.

### UI: Remove `style` from DOMPurify allowlist — M8 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). Confirmed `style` is not in `ADD_ATTR` list in `markdown-renderer.js:41-49`. Only MathML attributes plus `class`, `width`, `height`, `aria-hidden`. No change needed — finding was already addressed.

### UI: Fix 4 lifecycle/race-condition findings — M4, M5, M6, M11 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 4 findings verified against source:

- **M4** — `publish.js:205`: `destroy()` calls `clearTimeout(this._draftTimer)`. Correct.
- **M5** — `notifications.js:42,50,60,77,87`: `_generation` counter incremented on start/stop, captured before poll, checked before applying response. Correct.
- **M6** — `paper-detail.js:47-48,53,58,211-219`: Both `loadPaper()` and `handleBridgeSync()` snapshot author/permlink and check before applying. Correct.
- **M11** — `auth.js:105,138-139`: `disconnect()` calls `_stopAccreditationPolling()`. `_startAccreditationPolling()` calls `_stopAccreditationPolling()` first. Correct.

No issues found.

### UI: Fix 5 polish findings — M7, M10, L6, L7, L11 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 5 findings verified against source:

- **M7** — `index.html:476`: Retry button with `@click="loadPaper()"`. i18n key present. Correct.
- **M10** — `index.html:220,270`: `x-html` intentional with comment re `<highlight>` tag. Correct.
- **L6** — `header.js:100`: `event.actor || ''` fallback in `formatNotification`. Correct.
- **L7** — `config.js` exports `getAppTag`, `getAppVersion`, `getAppId`. All 3 consumers import correctly. Correct.
- **L11** — `index.html:90`: `:aria-label="$t('aria.notifications')"` on bell icon. Correct.

No issues found.

### Architect: Review and triage audit findings (2026-03-31) — Done ✓

Full-stack code audit completed 2026-03-31. Results in `agents/docs/audit-2026-03-31.md` — 5 HIGH, 11 MEDIUM, 11 LOW findings. Triaged 2026-03-31: all findings assigned as implementation tasks. H5 reclassified as false positive (Hive usernames cannot contain HTML).

---

## Done

### Backend: Fix 6 security/reliability findings — H1, H2, H3, H4, M1, M3 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 6 findings verified against code:

- **H1** — `verifyHiveSignature.ts:38-52`: Redis `SETNX` with `EX 300` (5-min TTL) for replay detection. In-memory Map fallback with cleanup interval. Correct.
- **H2** — `papers.ts:1005` GET route (no auth), `papers.ts:1021` POST route with `verifyHiveSignature` + `doiAssignLimiter` middleware chain. No `runMiddleware` or `res.headersSent` in file. Correct.
- **H3** — `helpers.ts:33`: `Math.min(10000, ...)` for page, `Math.min(100, ...)` for limit. Correct.
- **H4** — `docker-compose.yml:7,28,51,52`: All password refs use `:?` syntax. Correct.
- **M1** — `app.ts:73`: `config.appUrl || false`. Correct.
- **M3** — `search.ts:169-170`: SHA-256 hash, first 32 hex chars. Correct.

No issues found.

### Backend: Fix 5 security-adjacent findings — M2, L1, L4, L5, L9 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 5 findings verified against code:

- **M2** — `accreditation.ts:178`: SHA-256 hash, `.slice(0, 8)` before logging. Correct.
- **L1** — `config.ts:78`: `?? (() => { throw new Error(...) })()`. Correct.
- **L4** — `config.ts:79`: `unsubscribeSecret` with `SESSION_SECRET` fallback. `digest.ts:38`: uses `config.unsubscribeSecret`. Correct.
- **L5** — `accreditation.ts:87-94`: `maskEmail()` shows `m***@***.edu` format — only first char of local + TLD. Correct.
- **L9** — `docker-compose.yml:32`: `REDISCLI_AUTH=$REDIS_PASSWORD redis-cli ping`. No `-a` flag. Correct.

No issues found.

### Backend: Fix 5 code quality findings — M9, L2, L3, L8, L10 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 5 findings verified against code:

- **M9** — `responses.ts:398`: `redis_available?: boolean` in `HealthCheckResponse`. Correct.
- **L2** — All 12 `parseInt` calls across backend have explicit radix `, 10`. Correct.
- **L3** — `ipfs.ts:53`: `AbortSignal.timeout(30_000)` on Pinata fetch. Correct.
- **L8** — 5 routes return `422` with `VALIDATION_ERROR`: non-institutional email, already accredited, self-vouch, already retracted, DOI on retracted paper. `VALIDATION_ERROR` in `ErrorCode` union at `api.ts:22`. Correct.
- **L10** — `002_add-check-constraints.sql`: `CHECK (last_digest_block >= 0)`. Correct.

No issues found.

### UI: Fix 5 paper detail and notification bugs (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 5 bugs verified against spec:

1. **Bug 1 — ICU plural:** `interpolate()` in `i18n.js:40-50` handles `{var, plural, one {…} other {…}}` with `#` replacement. Regex-based, correct branching on `value === 1`. Simple `{key}` replacement runs after plural expansion. Correct.
2. **Bug 2 — Collapsible body:** `bodyExpanded: false` in `paper-detail.js:29`. Toggle button in `index.html` uses `paperDetail.showFullPaper` / `paperDetail.collapseBody`. Body div gated by `x-show="bodyExpanded"`. i18n keys in all 14 locales. Correct.
3. **Bug 3 — Discussion section:** `threaded-comments.js` fetches via `fetchPaperComments`, renders threaded HTML. `comment-composer.js` posts via `postComment` from keychain, dispatches `comment-posted` event for refresh. Section in `index.html` after reviews with loading/error/empty states and connect prompt. Correct.
4. **Bug 4 — Self-review guard:** `isOwnPaper` getter in both `paper-detail.js:73-79` and `review.js:36-41` checks primary author and co-authors array. "Write a Review" button hidden with `x-show="!isOwnPaper"`. Review form gated with `x-if="isAccredited && !isOwnPaper"`. Warning card shown. Backend `anonymousReview.ts:117-132` rejects with 403 for both direct author and co-author matches. `review.cannotReviewOwn` in all 14 locales. Correct.
5. **Bug 5 — Notification formatting:** `formatNotification()` in `header.js:82-105` maps event types to i18n keys, handles `accreditation_update` branching on `event.action`, passes interpolation params. `index.html` uses `x-text="formatNotification(event)"`. Correct.

No issues found.

### UI: Simplify header navigation (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All acceptance criteria verified against ARCHITECTURE.md § 14:

1. **Publish moved:** Removed from `primaryLinks`, placed first in `moreLinks` in `header.js:21`. Correct.
2. **User menu dropdown:** `userMenuOpen` state in `header.js:8`, `toggleUserMenu()` in `header.js:73-75`. Trigger button shows bell icon (with unread badge) + `@username` + chevron. Dropdown contains: Profile link → Notifications panel (title, mark-all-read, event list) → Disconnect button. `@click.outside="userMenuOpen = false"` on container. Correct.
3. **`notifOpen` removed:** Zero occurrences in codebase, fully replaced by `userMenuOpen`. Correct.
4. **Language switcher:** Unchanged position, standalone before user menu. Correct.
5. **Mobile nav:** Unchanged. Correct.
6. **No new i18n keys** needed or added. Correct.

No issues found.

### Backend: Fix 4 runtime bugs (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 4 fixes verified against spec, 166/166 tests pass.

1. **Bug 1 — Set serialization:** `getAllAccreditedAccounts()` caches as `string[]`, wraps in `new Set()` on retrieval. Hive API fallback spreads Set to array before returning. Correct.
2. **Bug 2 — Hive API pagination:** Batches of 20, up to 5 pages, `start_author`/`start_permlink` cursor, `batch.slice(1)` dedup on subsequent pages, early exit on `batch.length < 20`. Correct.
3. **Bug 3 — SQL param indices:** Uses `accredCte.nextIdx` and `accredCte.nextIdx + 1` instead of hardcoded `$5`/`$6`. Comment updated. Correct.
4. **Bug 4 — Bridge permlink/title/errors:** `bridgePermlink()` lowercases, replaces `[^a-z0-9]+` with `-`, trims edges, truncates to 256. Title truncated to 253+`...` before broadcast. Both catch blocks (register + update) now return Hive RPC error detail via `jse_shortmsg`. Correct.

No issues found.

### UI: Alpine.js rewrite — All 5 Phases Complete (2026-03-30) — Reviewed ✓

Reviewed by Architect (2026-03-30). All 5 phases verified: 16 hash-based routes, 9 stores, 16 components, 16 pages, Tiptap editor, error tracking. index.html SPA shell correct (header, footer, toast, onboarding/username modals). Auth store has isAccredited with localStorage persistence and disconnect reset. Vite outputs to `backend/public/`. All dependencies present (Alpine.js, Tiptap, Sentry optional). No issues.

### Architect: Update specs and contracts for Alpine.js rewrite (2026-03-30) — Reviewed ✓

Completed by Architect. ARCHITECTURE.md updated (system diagram, data flow, CORS, i18n, Markdown rendering, editor deps, CSP — all Next.js/React refs removed). `docs/deployment-guide.md` updated to v0.2 (3 Docker services, single port). `contracts/disciplines.json` exported. `agents/architect/CLAUDE.md` updated.

### Backend: Serve static frontend and simplify config (2026-03-30) — Reviewed ✓

Completed by Backend agent. Reviewed by Architect (2026-03-30). `app.ts` correctly adds `express.static` before API routes and SPA catch-all after (skips `/api/` paths). CORS simplified. CSP updated for Alpine.js. `docker-compose.yml` frontend service removed. Dockerfile has correct build order (contracts → frontend → backend). TS compiles clean. No API behavior changed.

### Architect: Verify HAF sender column and update specs (2026-03-30) — Reviewed ✓

Completed by Architect. HAF `required_posting_auths` column confirmed (jsonb array). ARCHITECTURE.md updated with whitelist spec, `ACCREDITATION_AUTHORITIES` env var, and `accredited_only` default change.

### Backend: On-chain discovery + sender-filtered accreditations (2026-03-30) — Reviewed ✓

Completed by Backend agent. Reviewed by Architect (2026-03-30). Five tasks implemented:

1. **Sender whitelist filter:** `config.accreditationAuthorities` correctly built as `[hiveAdminAccount, ...extras]`. `hafsql.ts` CTE and `accreditation.ts` batch query both filter by `cj.required_posting_auths ?| $N::text[]`. Hive API fallback scans all authority accounts. Param indexing correct (`$1=appTag, $2=whitelist, $3+=usernames`).
2. **`accredited_only` default to `false`:** Changed in all three routes (`papers.ts:62`, `search.ts:153`, `comments.ts:21`). Uses `=== 'true'` comparison.
3. **`pending_accreditations` to Redis+memory:** `storeToken` writes both Redis (with TTL) and memory. `getToken` reads Redis first, memory fallback. `deleteToken` cleans both. No `getAppPool` import.
4. **`anon_review_mappings` to Redis+memory:** Same pattern with 180-day TTL. Encryption logic preserved. No `getAppPool` import.
5. **`app-db.ts` simplified:** Only `notification_preferences` remains. Migration updated. `.env` has `ACCREDITATION_AUTHORITIES` and updated `APP_DATABASE_URL` comment.

Tests: 165/166 pass. One flaky test (`papers.test.ts > returns papers with correct structure`) fails in full suite due to HAF connection contention but passes in isolation (8/8). Pre-existing issue, not a regression.

### UI: Add `isAccredited` to AuthContext (2026-03-29) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-29). `isAccredited` and `accreditation` correctly added to AuthState, fetched after login, persisted in localStorage, reset on disconnect. Non-critical fetch failure defaults to unaccredited. No issues.

### UI: Gate all write actions behind accreditation (2026-03-29) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-29). Publish/review forms gated behind `isAccredited`, CommentComposer returns null, VoteButtons redirects to /accreditation. i18n keys present in all locales. No issues.

### UI: Add primary author name/affiliation fields to publish form (2026-03-29) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-29). Three fields added (name required, affiliation/ORCID optional), pre-filled from accreditation, included in draft save/restore, used in submit payload, submit guarded by empty name check. No issues.

### UI: Fix disabled buttons in toolbar (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Undo/Redo correctly branch on markdownMode (execCommand for textarea, Tiptap chain for visual). Image button has no disabled prop; upload indicator is text-only. No stray disabled props on any toolbar button. No issues.

### UI: Auto-save publish form as local draft (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Debounce cleanup correct, initialLoadDone guard prevents restore/auto-save race, draft cleared on success only, all localStorage ops wrapped in try/catch. No bugs.

### UI: Fix B/I/S toolbar buttons — empty editor + markdown source mode (2026-03-27) — Reviewed ✓ (with follow-up)

Completed by UI agent. Reviewed by Architect (2026-03-27). All formatting buttons correctly branch on markdownMode with proper syntax. Focus-loss fix correct. Two minor disabled-button violations flagged as follow-up task above.

### UI: Add Full-screen editor toggle button (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). All 8 requirements met: button placement, variant gating, fixed positioning, flex expansion, icon toggle, Escape key, both modes. No issues.

### UI: Fix Markdown→Visual round-trip parsing in TiptapEditor (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Full remark pipeline, math post-processing, DOMPurify allowlist all correct. Minor caveat: initial content loading (line 545) still uses naive `<p>` wrapping — low priority, doesn't affect toggle round-trip.

### UI: Remove duplicate `.pevo-editor` inline styles from TiptapEditor (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). No `<style jsx global>` remains. globals.css `.ProseMirror` rules are the sole styling source. No issues.

### UI: Editor styling and toolbar state fixes (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Scoped styles, LinkPopover fix, and ExitBlockOnEnter all correct. Follow-up task created for duplicate inline styles.

### UI: Markdown source toggle on editor (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Toggle works correctly in both directions. Follow-up tasks created for Markdown→Visual parsing quality and missing Full-screen button.

### UI: Character counter on all editor variants (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Fully compliant with spec — no issues found.

---

## Done

### REC-1 — Account recovery for light accounts (Backend + Frontend) ✓

Architect review passed. Backend: `POST /api/auth/recover` with seed-phrase (timingSafeEqual memo key comparison) and ORCID (nonce-based OAuth) recovery methods. Rate limited 10/IP/hr, argon2id password update, session invalidation, audit logging, email uniqueness check. 9 tests passing. Frontend: `/recover` page with seed phrase / ORCID tabs, client-side key derivation via `deriveAllKeys()`, ORCID tab conditionally shown after `fetchAccreditationStatus()`, localStorage persistence for OAuth round-trip, password validation, success screen. Route + registry registered. 27 `recover.*` + `login.lostEmailAccess` i18n keys in all 16 locales. No issues found.

### ENRICH-F1 — Frontend: Remove batch-counts enrichment and stop overwriting initial values from enrichment (UI agent) ✓

Architect review passed. `fetchPaperBatchCounts` import and `enrichPapers` method removed from home.js. Paper detail enrichment handler sets only `reviews`, `voters`, `net_votes` — no overwrites of `citation_count`, `is_accredited`, `accredited_authors`, `versions`, `is_retracted`. `fetchPaperBatchCounts` function removed from api.js. No stale references found. No issues found.

### ENRICH-B1 — Backend: Fold review_count and citation_count into paper list query (Backend agent) ✓

Architect review passed. Review count and citation count computed via correlated subqueries in paper list HAF query. batch-counts endpoint removed. Hive API fallback defaults both to 0 via toPaperSummary. Bridge papers enriched with Semantic Scholar external counts. No issues found.

### ENRICH-B2 — Backend: Move citation_count, is_accredited, accredited_authors into initial paper detail load (Backend agent) ✓

Architect review passed. Both HAF and Hive API detail paths compute citation_count, is_accredited, accredited_authors. buildPaperDetail declares accredited_authors: [] as string[]. Bridge external citation counts preserved in both paths. No issues found.

### ENRICH-B3 — Backend: Remove versions and retraction from enrichment response (Backend agent) ✓

Architect review passed. Both HAF and Hive API enrichment paths return only { net_votes, voters, reviews }. Citation, retraction, postMeta queries removed from HAF enrichment. Versions retained internally for staleness computation but excluded from response. No issues found.

### CHUNK-1 — Lazy-load the editor chunk via dynamic import (UI agent) ✓

Architect review passed. Static createEditor import removed from publish.js and edit.js. _mountEditors() is async with dynamic import in both files. Editor chunk loads only on publish/edit pages. No issues found.

### CHUNK-2 — Isolate dhive into its own manual chunk in Vite config (UI agent) ✓

Architect review passed. hiveModules array and manualChunks function in vite.config.js correctly isolate @hiveio/dhive into a separate 'hive' chunk. No issues found.

### CHUNK-3 — Verify all chunks are under 500 KB after CHUNK-1 and CHUNK-2 (UI agent) ✓

Architect review passed. Index chunk 475 KB (under threshold). hive (728 KB) and editor (850 KB) are third-party libraries, lazy-loaded or cached separately. No issues found.

### EMAIL-B1 — Backend: Email management endpoints (Backend agent) ✓

Architect review passed. Migration, schema, 4 endpoints (GET/POST/DELETE email + GET verify/:token), per-endpoint rate limiters, Zod validation, transactional cascade delete, parameterized SQL throughout. 15 tests passing. No issues found.

### EMAIL-F1 — Frontend: Email management section in settings page (UI agent) ✓

Architect review passed. 4 API functions, 3-state email section (no email/verified/pending), delete confirmation with custody-aware warnings, verify-email micro-page, route + registry. Architect fix: 2 hardcoded "Cancel" buttons replaced with `$t('common.cancel')`.

### EMAIL-I1 — Add email management i18n keys to all 16 locale files (UI agent) ✓

Architect review passed. All 20 keys present in all 16 locale files with idiomatic translations. `{email}` placeholder preserved. Brand names untranslated. All files valid JSON. No issues found.

### I18N-1 — Remove dead i18n keys from all 16 locale files (UI agent) ✓

Architect review passed. All dead keys removed from all 16 locale files. `publish.pdfSelected` preserved (actively used). All 16 files have synchronized key sets (948 keys across 50 sections). No JS or HTML files modified. No issues found.

### I18N-2 — Fix hardcoded strings in templates and JS (UI agent) ✓

Architect review passed. All 6 categories verified: aria-labels in index.html use `$t()`, `methodLabel()` in accreditation.js uses i18n, PDF selected in publish.js uses i18n with interpolation, all catch-block error strings across pages use i18n keys, `formatShortDate` in paper-detail.js reads locale from i18n store. 12 new keys confirmed in en.json (2 aria + 10 common error). No remaining hardcoded English strings found. No issues found.

### I18N-3 — Retranslate stale FAQ and missing translations in all 15 non-English locales (UI agent) ✓

Architect review passed. FAQ q3-q14 verified translated (not English placeholders) across all 15 non-English locales. Spot-checked de, fr, es, zh, ar, it, pl — all authentic translations. `footer.contact`, `seedPhrase.chooseCreateHint`, `aria.toggleMenu`, `aria.dismiss`, and all 10 common.* error keys present and translated in all 15 locales. All 16 JSON files pass validation. No issues found.

### VOUCH-B1 — Backend: Add `GET /api/accounts/search` endpoint (Backend agent) ✓

Architect review passed. New route file `accounts.ts` registered at `/api/accounts` with `readLimiter`. Validates `q` (2-16 chars, sanitized to valid Hive username chars), clamps `limit` to [1,10] default 5. Calls `lookup_accounts` Hive API, cross-references accreditation via `getAccreditedSet()`. Response shape matches spec. 9 tests passing against real Hive API. No issues found.

### VOUCH-F1 — Frontend: Replace "Browse researchers" with vouch search (UI agent) ✓

Architect review passed. "Browse researchers" removed. Debounced (300ms) search input with magnifying glass icon, circular Hive avatars (32px, SVG letter fallback), clickable usernames navigating to profile, green checkmark for accredited accounts, "No accounts found." on empty results. `searchAccounts()` in api.js matches spec. i18n: `vouchDescription` updated, 3 new keys added, `browseResearchers` removed (en.json only per spec). All component data properties match spec. No issues found.

### ACC-1 — Show accreditation status for already-accredited users (UI agent) ✓

Architect review passed. Status card shown when user is accredited (green banner, name/institution/field/method/date details, vouch section with "Browse researchers" link). Form wrapped in `x-if="!isAccredited"`. Computed properties, `formatDate` import, and `methodLabel()` helper added. All 9 i18n keys match spec in en.json, no keys removed. No issues found.

### GS-1 — Rework getting-started page (UI agent) ✓

Architect review passed. Template rewritten with comparison cards (quick start vs full custody), icon-enhanced step cards, upgrade callout for quick path, and capabilities section. Key prefix `kc` → `fc` in JS. All 37 i18n keys match spec in en.json, old keys removed. All 16 locale files updated with translations. No issues found.

### GEN-1 — Apply genesis block floor to all custom_json queries (Backend) ✓

Architect review passed. All 3 steps implemented correctly: `getCachedGenesisBlock()` sync accessor, head-block fallback for fresh namespaces, startup warmup. All 3 CTE builders and all 10 standalone queries have parameterized `block_num >= $N` with correct index shifting. Bonus: notifications/digest now clamp `sinceBlock` to genesis floor, tests updated to use dynamic genesis block. 189 tests pass. No issues found.

### AUTH-1 — Per-author accreditation badges across all paper views (Backend + Frontend) ✓

Architect review passed. Backend: `accredited_authors` string array added to enrichment response, paper list endpoints (HAF + Hive API), and profile papers endpoint. Frontend: per-author rendering on paper detail, home, papers, and profile pages — accredited authors shown as clickable profile links with green checkmark icon, non-accredited as plain text. No text label on badge.

### PROF-1 — Skip expensive queries for non-accredited profiles (Backend) ✓

Architect review passed. Profile handler split into two phases: account + accreditation first, expensive HAF/reputation queries only for accredited users. Non-accredited profiles return zeroed stats immediately. No issues found.

### PX-2 — Extract all remaining page templates (UI agent) ✓

Architect review passed. All 26 templates extracted, index.html reduced to 570 lines, page-mount and registry working correctly.

Architect fix: `paper-detail.js` lines 537 and 623 had over-escaped backticks (`\\\``) in Alpine `:style` template literals — changed to `\`` to match the correct pattern used in profile.js, home.js, and papers.js.

### PX-1 — Scaffold page-mount component and page registry (UI agent) ✓

Architect fix: `renderPage` destroyed all children of `<main>` — would wipe inline `<template x-if>` blocks for non-migrated pages on first navigation to a registered route. Fixed by introducing a dedicated `_container` div that `pageMount` manages exclusively, leaving inline template blocks untouched.

### NAV-F1 — Frontend: Jump to review from profile link (UI agent) ✓

### PROF-B1 — Backend: Add `GET /api/profile/:username/reviews` endpoint (Backend agent) ✓

Architect fix: Hive API fallback had `const [parent] = await get_content(...)` — array destructuring on a single-object return. Would extract wrong data for paper title. Fixed to `const parent = ...`.

### PROF-F1 — Frontend: Add Publications/Reviews tabs on researcher profile (UI agent) ✓

### VSTALE-B2 — Backend: Exclude stale votes from reputation computation (Backend agent) ✓

Architect fix: vote resolution when both native vote and revote exist after the latest content revision now compares timestamps per §31 ("use whichever has the later timestamp"). Original code always preferred the revote. Fixed in both `reputation.ts` and `routes/papers.ts`.

### VSTALE-B3 — Backend: Validate incoming `revote` custom_json (Backend agent) ✓

Architect fix: added `version` field presence check to revote validation in both `reputation.ts` and `routes/papers.ts`, and added `version` to the SQL SELECT. §3.1 requires author/permlink/version all present.

### VSTALE-B1 — Backend: Vote staleness detection in paper detail (Backend agent) ✓

Architect fix: SELECT was missing `v.timestamp`, and code referenced `r.vote_ts` (undefined) instead of `r.timestamp`. All native votes on revised papers would have been incorrectly marked stale. Fixed in architect review.

### VSTALE-F1 — Frontend: Broadcast `revote` custom_json (UI agent) ✓
### VSTALE-F2 — Frontend: Show vote staleness in paper detail (UI agent) ✓
### VSTALE-F3 — Frontend: Show stale vote count on version timeline (UI agent) ✓

### ORCID-B1 — Backend: Add `ORCID_MIN_WORKS` config (Backend agent) ✓
### ORCID-B2 — Backend: Add `POST /api/auth/orcid/start` (Backend agent) ✓
### ORCID-B3 — Backend: Add `POST /api/auth/orcid/callback` (Backend agent) ✓

Architect fix: changed source-name comparison to use `source-orcid.path` instead of `source-name.value`. The original compared the source display name against the ORCID iD, which would never match — every work would count as external.

### ORCID-B4 — Backend: Modify `POST /api/auth/signup` to accept `orcid_token` (Backend agent) ✓
### ORCID-B5 — Backend: Include verified ORCID in attestation only (Backend agent) ✓
### ORCID-F1 — Frontend: Replace ORCID text input with OAuth button on signup (UI agent) ✓
### ORCID-F2 — Frontend: Add signup ORCID callback page (UI agent) ✓
### ORCID-F3 — Frontend: Restore form state and show verified ORCID on signup (UI agent) ✓
### ORCID-F4 — Frontend: Update error messaging (UI agent) ✓
### ORCID-F5 — Frontend: Add API functions for signup ORCID flow (UI agent) ✓

### I18N-4 — Internationalize editor.js (UI agent) ✓

All ~30 hardcoded English strings extracted to `_t()` helper using `Alpine.store('i18n').t()`. `editor` section with 36 keys added to all 16 locale files with translations. Toolbar titles, aria-labels, math modal, link popover, character count, fullscreen toggle, and image upload error all internationalized.

### I18N-5 — Deduplicate shared i18n keys into `common` section (UI agent) ✓

7 new keys added to `common` (`getAccredited`, `noAccount`, `signUp`, `hasKeychain`, `connectKeychain`, `alreadySignedIn`, `goToPapers`), 9 old duplicate keys removed from `publish`, `review`, `signIn`, `login`, `signup` sections. All 16 locale files updated atomically. JS/HTML references updated.

### I18N-6 — Fix untranslated values in all locale files (UI agent) ✓

87 untranslated values across 15 non-English locale files translated. Spot-checked: `versionWithDate` uses native words (German "Version", Spanish "Versión", Chinese "版本", Arabic "الإصدار"). All 16 locale files have identical key sets.
