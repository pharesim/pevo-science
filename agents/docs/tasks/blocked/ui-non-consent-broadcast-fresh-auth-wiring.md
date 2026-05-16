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
