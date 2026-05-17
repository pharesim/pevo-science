# UI-NON-CONSENT-BROADCAST-FRESH-AUTH-WIRING — supply `fresh_auth_proof` on every `/api/custody/broadcast` call

**Owner:** UI
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` round-1 @ 84602f8 — P0 frontend-coordination gap)
**Priority:** P0 (deploy-blocker — backend ships the new `fresh_auth_proof`-required wire contract on next deploy; current SPA broadcast helper omits the field, blocking ALL light-account publish/comment/vote/edit/vouch operations post-deploy)

## Problem

Backend commit `84602f8` requires `fresh_auth_proof` on every `/api/custody/broadcast` call (consent op or non-consent). Closes ARCHITECTURE.md § 6.5 invariant #1 — pre-change a stolen JWT was a one-step takeover vector for vote/comment broadcasts.

The SPA's universal broadcast entry point at `frontend/src/signer.js:16-23` sends `{ operations }` with no `fresh_auth_proof` field. Seven downstream call sites use `broadcastOps` for non-consent ops: `publish.js`, `review.js`, `comment-composer.js`, `paper-detail.js`, `vote-buttons.js`, `edit.js`, `vouch-section.js`. After the backend deploy every light-account user will receive 401 FRESH_AUTH_REQUIRED on each of these flows. State C (passwordless ORCID-only) is the originally-motivating case but the breakage is universal — State A and State B users are blocked too.

## Goal

Wire `fresh_auth_proof` minting + submission into the SPA's broadcast helper for non-consent ops. Each user state mints via the factor it has registered:

- **State A** (light + password, no ORCID) → password mint. Today only `/api/custody/fresh-auth` exists, and it requires per-op target fields (`action`, `root_author`, `root_permlink`) that don't apply to vote/comment. A backend follow-up (`backend-custody-session-auth-password-mint`) adds a session-kind password issuance; this UI task depends on that landing.
- **State B** (light + password + ORCID) → either password or ORCID mint. ORCID session_auth is the simpler shape (target-less, single OAuth round-trip per session). Recommend ORCID by default.
- **State C** (passwordless ORCID-only) → ORCID mint via `POST /api/orcid/start { mode: "session_auth" }`. Only path.

## Acceptance

### 1. `signer.js` broadcast helper signature change

`broadcastOps(operations, { freshAuthProof })` — accept an optional `freshAuthProof` parameter that is passed through into the request body as `fresh_auth_proof`. Document that the parameter is REQUIRED for any non-consent bundle going forward; the optionality at the JS API level is for the migration window only.

### 2. Mint flow integration

Add a `mintNonConsentProof()` helper that:

- Detects user state (custody, has-password, has-orcid).
- For State C: redirects through the ORCID OAuth round-trip via `mode: "session_auth"`. Cache the issued proof in memory for the session's 5-minute TTL; subsequent broadcasts in the same window reuse it without a new round-trip.
- For State B: prefer the cached session-kind proof if present; otherwise mint via ORCID session_auth. Optionally offer a password fallback (out of scope for round-1).
- For State A: mint via the new `backend-custody-session-auth-password-mint` endpoint (depends on that backend task landing first).

### 3. Per-call site wiring

Each of the seven non-consent broadcast call sites wraps its broadcast in `await mintNonConsentProof()` → `broadcastOps(ops, { freshAuthProof })`. The proof is consumed atomically; if the broadcast fails (502, 504), the proof is gone — re-mint on retry.

### 4. UX considerations

- ORCID session_auth requires a full OAuth round-trip (redirect to orcid.org, return). For State B/C users, the first non-consent op of a session triggers the round-trip; subsequent ops within the 5-minute TTL reuse the cached proof. Surface a clear "Authenticating..." UI during the round-trip.
- State A users do not redirect; the password mint is in-line.
- Consider showing a one-time "Re-authentication required" tooltip the first time a user encounters the new gate, to set expectations.

### 5. Error handling on the broadcast

- 401 `FRESH_AUTH_REQUIRED` `details.reason: "missing" | "expired" | "malformed"` → mint a new proof and retry the broadcast.
- 403 `FRESH_AUTH_REQUIRED` `details.reason: "username_mismatch"` → critical session inconsistency; force re-login.
- 403 `FRESH_AUTH_REQUIRED` `details.reason: "kind_mismatch"` → shouldn't happen on the non-consent surface (it accepts both kinds); if seen, log and treat as misconfiguration.

### 6. Tests

E2E tests cover: State C user (passwordless ORCID-only) publishes a paper, comments, votes; State B user does the same with ORCID mechanism; State A user does the same with password mechanism (depends on `backend-custody-session-auth-password-mint`). Cover the proof-cache reuse within the 5-minute window, and the re-mint behavior after TTL expiry.

## Out of scope

- Backend changes (already landed in commit `84602f8`).
- API contract doc updates (architect lands during the task-4 archive cycle).
- Consent-op broadcasts (`author_accept` / `author_resign`) — those already mint via `/api/custody/fresh-auth` per the existing flow; this task only adds the non-consent path.

## Dependencies

- `backend-custody-session-auth-password-mint.md` (pending) — adds the State A password session-kind mint endpoint. State A users cannot use this UI flow until that backend task lands.

## Cross-references

- `agents/docs/api-contracts/custody.md` — `/api/custody/broadcast` contract (updated by architect alongside this task's creation).
- `agents/docs/api-contracts/orcid.md` — `mode='session_auth'` documentation (also updated alongside).
- `agents/docs/ARCHITECTURE.md` § 6.4 (re-auth contract), § 6.5 invariant #1 (critical-action fresh-auth requirement, the invariant this fix closes).
- `backend/src/lib/fresh-auth.ts` — read for the consume function semantics + cross-kind accept rules.

## Source

`/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` (architect session 2026-05-16): api-contract AC-1 P0 conf 100. Frontend-coordination gap surfaced during architect triage.

## Architect re-review (2026-05-16) — HELD PENDING FIXES [BLOCKED by Backend]:

Reviewed via `/ce-code-review` against commit `6dfdb37` with 10 personas (correctness/security/adversarial Opus; testing/maintainability/project-standards/api-contract/reliability/julik-frontend-races/learnings-researcher Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). The cross-cutting wiring is sound on the happy path: api-contract verified the wire shape across 7 fields (`fresh_auth_proof` body field name, Bearer auth, error envelope shape, status codes 401/403, `POST /api/orcid/start` body, ORCID callback contract, response shape), security confirmed no proof leak in logs / errors and no CSRF surface (Bearer auth never auto-included cross-origin), the ORCID redirect hostname allowlist passes strict-equality check (no subdomain or punycode bypass), the proof is correctly target-less (kind=session_auth) per § 6.4 contract for non-consent.

**Why blocked-by-backend:** the most severe finding is a backend wire-contract violation that makes the entire 5-minute proof cache dead-on-arrival — every light-account broadcast triggers a full ORCID OAuth round-trip. The fix is in backend's emission, not the UI's parsing (the UI parses per the documented contract). See **[BLOCKED by Backend]** below.

### Blocking item

**B1. [BLOCKED by Backend] P0 — `expires_at` wire-contract mismatch.** correctness 90 + security 60 + adversarial 95 + api-contract 100 → cross-reviewer **synthesis confidence 100**. Backend's `fresh-auth.ts:290` emits `expires_at` as epoch SECONDS (number); contract docs (`custody.md:108`, `orcid.md:208,239`) document ISO-8601 string. UI parses via `new Date(expiresAt).getTime()` → year 1970 → cache always expired → every broadcast triggers full ORCID round-trip. E2E spec at `non-consent-fresh-auth.spec.js:57` stubs as ISO string and masks the bug.

Backend task filed: `agents/docs/tasks/pending/backend-expires-at-iso-conformance.md`. Task also audits `frontend/src/auth.js`'s JWT-expiry consumer for the same latent bug. When backend lands the ISO emission, this UI task unblocks for archive (modulo the UI-zone items below).

### UI-zone items to address (in parallel with B1)

**1. P1 (testing) — 401 FRESH_AUTH_REQUIRED retry path has zero test coverage (`frontend/src/lib/fresh-auth.js:156-168`).** T1 (P1/90). Most exposed bug surface — `clearCachedSessionProof` + re-mint + re-POST. If the reason-list check is wrong, if cache clearing is dropped, if the re-mint return is not propagated, production light-account broadcasts will 401-loop or silently drop. Add a unit test mocking the broadcast to 401 once with `details.reason: 'expired'` then 200; assert `clearCachedSessionProof` was called between attempts and `broadcastOps` was invoked twice. Spec template: see the `mintNonConsentProof` cache-hit path in the existing e2e spec for the shape.

**2. P1 (testing) — 403 username_mismatch disconnect+toast path untested (`frontend/src/lib/fresh-auth.js:173-180`).** T2 (P1/90). Mutation class: dropping `auth.disconnect()` silently leaves users in a broken state with a corrupt session. Add a test mocking broadcast to 403 with `details.reason: 'username_mismatch'`; assert `auth.disconnect()` was called AND a toast was shown.

**3. P1 (project-standards) — Hardcoded English toast bypasses i18n (`frontend/src/lib/fresh-auth.js:175-178`).** PS-T6-01 (P1/90). String `'Session inconsistency detected. Please sign in again.'` is non-translatable. Every other toast in the diff uses `$t(key)`. Fix: extract a locale key (suggest `auth.sessionInconsistency`), add English value to `en.json`, stub the 15 non-English locales, add a STUBS.md sweep entry.

**4. P1 (julik) — `broadcastConfirm` single `_resolve` slot orphans first waiter on concurrent calls (`frontend/src/components/broadcast-confirm.js:16-28`).** F1 (P1/100). Global singleton; two `voteButtons` components on the same paper-detail page can both call `request()` and the second overwrites `_resolve`, permanently orphaning the first's Promise. The first caller's `handleVote` freezes at the await with `isVoting=true` forever. Fix: add a queue OR a cancel-and-overwrite pattern. The minimal fix is to resolve the prior `_resolve(false)` before overwriting when a new `request()` arrives.

**5. P1 (julik + reliability, cross-reviewer conf 100) — `handleVote` missing `isVoting` entry guard (`frontend/src/components/vote-buttons.js:127-150`).** F2 + R1. `isVoting = true` is set only after the `broadcastConfirm.request()` await resolves. Template `:disabled="isVoting"` is stale until the first await returns. Double-click reaches `handleVote` twice before either sets the flag. Fix: add `if (this.isVoting) return;` as the FIRST check inside `handleVote` (after the `isConnected` / `accredited` guards, before any await). One line.

**6. P1 (maintainability) — Three helpers exported with no external consumers (`frontend/src/lib/fresh-auth.js:25-72`).** M1 (P1/80). `getCachedSessionProof`, `clearCachedSessionProof`, `mintNonConsentProof` are only called within the module. The legitimate external consumers are `orcid-callback.js` (uses `cacheSessionProof`, `getReturnPath`, `clearReturnPath`) and the 7 broadcast call sites (use only `broadcastWithFreshAuth` and `FRESH_AUTH_REDIRECT_PENDING`). Fix: remove `export` from `getCachedSessionProof`, `clearCachedSessionProof`, `mintNonConsentProof`.

### P2 items to address (in parallel with B1)

**7. P2 (julik) — `pevo_orcid_mode` localStorage cross-tab interference (`frontend/src/lib/fresh-auth.js:97`).** F3 (P2/90). localStorage is shared across tabs. Two tabs in different modes corrupt each other's callback dispatch (e.g., tab 1 'link' mode silently overwritten by tab 2 'session_auth' mode → tab 1's callback dispatches to wrong handler). Fix: move `pevo_orcid_mode` from `localStorage` to `sessionStorage` (matches `pevo_fresh_auth_return_to` and `pevo_fresh_auth_session_proof` which are already sessionStorage). Audit other writers of this key (`settings.js`, `login.js`, `signup.js`, `accreditation.js`) and migrate them too. Carry the localStorage write during a transition window if backwards-compat with stale tabs is needed; otherwise switch atomically.

**8. P2 (adversarial) — 403 username_mismatch returns `FRESH_AUTH_REDIRECT_PENDING` (null) — `publish.js` step machine has no recovery from `step='broadcasting'` (`frontend/src/lib/fresh-auth.js:167`).** adv-task6-2 (P2/80). Call sites `publish.js`, `comment-composer.js`, `vouch-section.js` bail cleanly on null but publish leaves `step='broadcasting'` UI stuck. Fix: when 403 username_mismatch fires inside `broadcastWithFreshAuth`, the disconnect+toast surfaces the issue and `auth.disconnect()` triggers re-login UI globally — but the per-page step machine must also reset to a non-broadcasting state. Either reset in the call sites' broadcast helpers (after seeing null return, reset their own step machine) OR change the sentinel to throw a typed error the call sites must catch.

**9. P2 (testing) — `getCachedSessionProof` expiry-eviction branch untested (`frontend/src/lib/fresh-auth.js:26-38`).** T3 (P2/85). Add a unit test storing a proof with an expired `expiresAt` and asserting `getCachedSessionProof` returns null AND removes the key. (This test is also part of the regression coverage for finding B1's fix.)

**10. P2 (maint) — Back-compat string `opts` branch has no deprecation marker (`frontend/src/signer.js:23-24`).** M2 (P2/75). All 7 migrated call sites now go through `broadcastWithFreshAuth` which always passes an object. Fix: either (a) audit and remove any legacy string-passing callers and delete the branch, OR (b) add a `// TODO(deprecate, post-2026-06-01): remove string-form back-compat once all callers migrated` comment with a grep-friendly marker.

**11. P2 (maint) — Error shape contract between signer.js and fresh-auth.js implicit (`frontend/src/lib/fresh-auth.js:152-189` ↔ `frontend/src/signer.js:40-43`).** M3 (P2/70). Fix: add a brief inline comment at the catch block in fresh-auth.js naming `signer.js#broadcastOps` as the error-shape source (`{ status, code, details }`).

### P3 advisory items (carry, not blocking)

- **adv-task6-3 (P2/75):** Old SPA bundle (HTTP-cached / long-lived tab) has no in-app recovery from FRESH_AUTH_REQUIRED post-deploy. Coordinate with finding B1's deploy strategy.
- **R2 (P3/80):** sessionStorage unavailable silently drops return-path; user lands on `/`. Acceptable graceful degradation.
- **adv-task6-5 (P3/75):** User-typed comment/review body lost on ORCID redirect (publish has autosave; comment/review don't). Stale state preservation is a separate scope.
- **adv-task6-6 (P3/90):** `router.path` is undefined on the router store; `mintNonConsentProof` always falls back to `window.location.pathname`. Either remove the dead branch (`(router && router.path) || window.location.pathname || '/'` → just `window.location.pathname || '/'`) OR document that `router.path` is intentional forward-compat.

### Path to archive

This task archives when:
1. Backend `backend-expires-at-iso-conformance.md` lands (clears finding B1).
2. UI-zone items #1-#11 land.
3. P3 advisory items are either landed or carried as filed follow-ups.

Once finding B1 resolves and the UI items land, `git mv` this file back to `tasks/review/`. The next architect re-review will cover the full re-fan-out diff against `6dfdb37..HEAD`.

Learnings-researcher flagged the ORCID callback mode-dispatch pattern (state stashing, return-path validation, session_auth handler shape) as a `/ce-compound` candidate for the archive checkpoint. The wire-contract-mismatch class itself (epoch-seconds vs ms vs ISO) is also a worthwhile capture — surfaced via cross-reviewer ×4 corroboration, no existing entry covers it.

Cross-references:
- `agents/docs/tasks/pending/backend-expires-at-iso-conformance.md` — the blocking backend task.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — the audit-by-grep convention; 7 call sites were correctly migrated per architect verification, but the convention prescribes embedding the grep output in the signal block for future audits.
- `agents/docs/solutions/conventions/helper-contract-flip-untouched-adopter-audit-2026-05-16.md` — relevant if `broadcastWithFreshAuth`'s contract is later modified (it'll silently re-grade all 7 call sites).
- `agents/docs/solutions/conventions/hive-signature-request-binding-shape-2026-04-21.md` — the canonical-challenge convention that the fresh-auth wire format also broadly follows.

## UI re-review signal (2026-05-17, commits acf0663..989d0e3)

Round-2 hold-block fixes landed. Backend B1 (`backend-expires-at-iso-conformance`) archived 2026-05-16 (verified: `toISOString()` at `backend/src/lib/fresh-auth.ts:347,420`); blocker cleared.

**All findings landed (#1-#11 P0/P1/P2):**
1. T1 401 retry-path coverage — `frontend/tests/unit/fresh-auth-401-retry.test.js` (7 tests; expired + missing + malformed).
2. T2 403 username_mismatch disconnect+toast — tested in `fresh-auth-401-retry.test.js`.
3. i18n `auth.sessionInconsistency` key extracted; 15 non-English stubs; STUBS.md entry; `fresh-auth.js` reads from i18n store with raw-English fallback.
4. `broadcast-confirm.js` `_resolve` race: prior `_resolve(false)` is now resolved before overwriting.
5. `handleVote` entry guard `if (this.isVoting) return;` added as first check.
6. Unused exports removed from `fresh-auth.js` (`getCachedSessionProof`, `clearCachedSessionProof`, `mintNonConsentProof`); grep-verified internal-only.
7. `pevo_orcid_mode` migrated atomically from `localStorage` to `sessionStorage` across all 6 writers/readers.
8. `publish.js` + `vouch-section.js` (2 sites) reset `step='idle'` on `FRESH_AUTH_REDIRECT_PENDING`; `comment-composer.js` already self-resets via finally (no change).
9. `getCachedSessionProof` expiry-eviction unit test (B1 regression coverage).
10. `signer.js` string-`opts` back-compat branch removed; JSDoc updated.
11. Error-shape contract comment added at fresh-auth.js catch block.

**P3 advisories also landed:**
- adv-task6-6: `router.path` dead-branch removed in `mintNonConsentProof`.

**P3 advisories carried (out of round-2 scope):**
- adv-task6-3 (old SPA bundle recovery), R2 (sessionStorage unavailable graceful degradation), adv-task6-5 (comment/review body loss on ORCID redirect).

**Tests:** 342/342 across 12 affected files (7 new fresh-auth tests + 5 migrated page tests + i18n / publish / accreditation regressions).

**`/ce-compound` candidate flagged:** `vi.spyOn(sessionStorage, 'removeItem')` does NOT intercept in jsdom — Storage methods live on the prototype; direct property assignment is silently ignored. Patch `Storage.prototype.removeItem` instead. New test file documents inline; worth capturing as a convention if architect agrees.

## Architect re-review (2026-05-17) — HELD PENDING FIXES (round-3):

Reviewed via `/ce-code-review` against commits `acf0663..989d0e3` with 11 personas (correctness/security/adversarial Opus; testing/maintainability/project-standards/julik-frontend-races/reliability/api-contract/previous-comments/learnings-researcher Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). All 11 round-2 hold items landed; api-contract verifies the wire shape end-to-end (`expires_at` ISO parsing, error envelope, 401-retry body, 403 `username_mismatch` discriminator, `kind_mismatch` defensive code). Backend B1 archived (`toISOString()` at `backend/src/lib/fresh-auth.ts:347,420`). Test mock-carve-out clauses a/b/c all met. Sister test files updated for sessionStorage migration. Eleven residual items + 1 carry-forward + 1 cross-task batch surfaced.

### Items to address

**1. P1 — `vouch-section.js` `handleVouch`/`handleRetract` missing entry guard.** julik JFR-1 (conf 90). Same class of bug round-2 #5/F2 fixed in `vote-buttons.js`, extended to a sibling file. Both methods write `this.step = 'signing'` as their first statement but never read it as a guard. Two rapid clicks both pass the synchronous entry window and both reach `await broadcastWithFreshAuth(...)`, firing two identical custom_json broadcasts. Fix: add `if (this.step === 'signing') return;` as the first statement in both methods (after the username null-check). One line each.

**2. P1 — `vote-buttons.js` `isVoting = true` placement (partial round-2 #5).** julik JFR-2 (conf 85). Round-2 #5 prescribed both (a) the entry guard `if (this.isVoting) return;` AND (b) `isVoting = true` set BEFORE any await. Only (a) landed; (b) was not moved. Currently `isVoting = true` is set AFTER `broadcastConfirm.request()` await resolves. The guard is functionally safe only because F1's single-slot eviction cancels the first waiter — a hidden coupling that breaks silently if `broadcastConfirm`'s single-slot design ever changes. Fix: move `this.isVoting = true` to before the `broadcastConfirm.request()` call in both the `weight===0` and non-zero paths.

**3. P1 — `auth.disconnect()` does not scrub cached fresh-auth proofs or `pevo_orcid_mode`.** security sec-r2-1 (conf 75). Round-2 item #2 added `auth.disconnect()` to the 403 username_mismatch path. `disconnect()` at `auth.js:135-145` clears the JWT + `pevo_session` localStorage but leaves `pevo_fresh_auth_session_proof`, `pevo_fresh_auth_consent_op_proof`, `pevo_fresh_auth_return_to`, and `pevo_orcid_mode` in sessionStorage. The session-kind proof that triggered the 403 is server-side GETDEL'd, but a cached consent_op proof from a sibling flow remains valid for its 5-min TTL bound to the disconnected JWT subject. Cross-user re-login on a shared browser picks up the stale cache. Backend username binding catches it (no cross-user broadcast), but the UX is confusing and the leftover proofs are observable to any XSS payload post-logout. Fix: extend `auth.disconnect()` to call `clearCachedSessionProof()`, `clearCachedConsentOpProof()`, `clearReturnPath()`, and `sessionStorage.removeItem('pevo_orcid_mode')`. Round-1 missed this because `disconnect()` was not yet called from `fresh-auth.js`.

**4. P1 — 401-retry re-mint failure surfaces with wrong error shape.** reliability R1 (conf 90). When the 401 retry path calls `mintNonConsentProof()` and the mint itself throws (network error, ORCID outage), the error bypasses the outer catch and propagates with the mint error shape rather than the original 401 error. Callers (publish.js, vouch-section.js, vote-buttons.js) all have their own catch blocks, so the UI does not hang — but the error message is wrong. Fix: wrap the re-mint+retry sequence in `fresh-auth.js:245-257` in a try/catch that normalizes to the `{ status, code, details }` contract documented at the catch block.

**5. P1 — Item #8 step-machine reset extension to `edit.js` + `review.js`.** correctness (conf 75) + previous-comments PC-1 (conf 72) → cross-reviewer promoted. Round-2 item #8 prescribed the `step='idle'` reset on `FRESH_AUTH_REDIRECT_PENDING` for publish.js, vouch-section.js, comment-composer.js (the three sites the architect enumerated). `edit.js` and `review.js` have the IDENTICAL failure mode: `step='broadcasting'` at `edit.js:987,1090`; `step='submitting'` at `review.js:262`. Both bail on the null sentinel at `edit.js:1010,1104` and `review.js:321` without resetting. Light-account 403 username_mismatch leaves the spinner UI hanging indefinitely after disconnect+toast fires. Fix: add the same `step='idle'` reset at all 3 missed sites (edit.js × 2, review.js × 1). Sibling-file completeness for round-2 #8.

**6. P1 — Strip task/round/finding-number references from production code comments.** maintainability M-COMMENT-1 (conf 90). 9 comments in this task's scope: `signer.js:17`, `fresh-auth.js:168`, `orcid-callback.js:97`, `login.js:227`, `signup.js:252,276`, `recover.js:244`, `accreditation.js:308`, plus `settings.js:644` (the migration-comment for #7). Per root CLAUDE.md "Don't reference the current task, fix, or callers" — these belong in commit messages, not code. Bulk strip the round-N / adv-task6-X references; keep only the durable invariant the surrounding sentence already states. Batched with the custody-upgrade sister task's hold-block item #1; one stripping pass covers both.

**7. P2 — `auth.disconnect()` not awaited before toast in 403 handler.** reliability R2 (conf 85). `fresh-auth.js:262-272`. If `disconnect()` is async (backend logout call), the user sees the "sign in again" toast while session teardown is still in flight. Race window between toast-click → re-login flow and disconnect completion. Fix: `await auth.disconnect()` before invoking the toast. If `disconnect()` is documented synchronous, add a one-line comment naming the synchronous-only contract.

**8. P2 — Modal title-swap on concurrent `broadcastConfirm.request()`.** reliability R3 (conf 80) + adversarial adv-r2-6 (conf 70) → cross-reviewer promoted. Round-2 #4's cancel-prior fix correctly evicts the first waiter, but the modal's title/message/confirmLabel are silently rewritten while the modal is open. A user who clicked confirm shortly after a silent title-swap confirms the second request's action (e.g., "mild concerns" instead of the displayed "strong endorsement"). Pre-existing single-slot design issue rendered observable by the round-2 fix. Architect prefers (b) refuse the overwrite while the modal is open — the second call's `await` waits on the resolved-`false`-then-retry signal once the first dialog closes. Alternative: (a) flicker the modal closed/open on overwrite. Implementer's call which to land.

**9. P2 — 401-retry mint path unserialized.** julik JFR-3 (conf 70). Two concurrent 401-retry callers both call `startOrcid()` and both write `RETURN_PATH_KEY`. De-facto idempotent on the same page (both write the same values), but a module-level in-flight promise coalescer is the correct ~6-line fix. Fix: serialize concurrent `mintNonConsentProof()` calls via `let _mintInFlight = null` at module scope.

**10. P2 — Missing regression tests for #4 cancel-prior race and #5 entry-guard.** adversarial adv-r2-2 (conf 80) + julik TG-1/3 (P1). Round-2 added the F1 and F2 fixes but no unit tests cover them — future refactors that drop either defense ship green. Fix: (a) `components-broadcast-confirm.test.js` — call `request()` twice synchronously, assert the first promise resolves to `false`; (b) `components-vote-buttons.test.js` — fire `handleVote` twice synchronously, assert `broadcastOps` invoked exactly once. Couples with items #1 and #2 — add the same regression for vouch-section's new entry guard.

**11. P2 — i18n test asserts identical string for localized and fallback branches.** adversarial adv-r2-1 (conf 75). `fresh-auth-401-retry.test.js:172-210` sets `mockI18nStore.messages.auth.sessionInconsistency` to the same English string as the fallback at `fresh-auth.js:269`. A typo regression (e.g., `?.messsages?.auth` or `session_inconsistency` snake_case drift) would collapse to fallback unconditionally and both tests still pass. Fix: replace the mock value with a distinct sentinel string (e.g., "LOCALIZED-SENTINEL") and assert it exactly in the i18n-present test.

### Items NOT addressed in this round-3 hold (filed as separate follow-up tasks)

- **adversarial adv-r2-5 (P2, conf 85)** — `pevo_orcid_return_to` localStorage key not migrated alongside `pevo_orcid_mode`. Two concurrent recover flows in different tabs can corrupt each other's return path. Filed as `tasks/pending/ui-pevo-orcid-return-to-session-storage-migration.md`. The round-2 migration claim was correct for the scope it covered (only `pevo_orcid_mode`), but the migration comment at `recover.js:242-244` should be narrowed to clarify scope when the sibling task lands.

### Dismissed at architect triage (no further action)

- **api-contract ac-1 (P2, conf 90)** — `kind_mismatch` branch structurally dead on non-consent surface. Defensive code with explanatory in-line comment; harmless if backend evolves.
- **previous-comments PC-2 (P2, conf 65)** — #9 expiry-eviction test uses indirect assertion (via `broadcastWithFreshAuth` path) rather than direct `getCachedSessionProof returns null`, architecturally blocked by #6's export removal. Indirect coverage is functionally equivalent.
- **P3 batch** — adv-r2-3 (two-consecutive-401 untested), adv-r2-4 (stale localStorage cleanup — inert), adv-r2-7 (cross-tab callback URL handoff — sessionStorage migration was the higher priority), JFR-4 (silent exception swallow — observability only), R4 (no test pins once-only retry budget — preemptive hardening).

### Path to archive

1. Items #1–#11 land.
2. Re-review scoped to the round-3 diff against round-2 HEAD.

Storage.prototype.removeItem jsdom-mocking `/ce-compound` candidate confirmed by learnings-researcher as having no existing solutions-store entry; architect will authorize after this round-3 lands.
