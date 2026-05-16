# UI-ORCID-CALLBACK-FRESH-AUTH-MODE-DISPATCH — add a `_handleFreshAuth` branch to the orcid-callback switch so ORCID-mediated consent-op proofs can dispatch

**Owner:** UI
**Created:** 2026-05-16 (architect, surfaced as a pre-existing residual by `/ce-code-review` of `backend-expires-at-iso-conformance` — api-contract reviewer)
**Priority:** P3 (latent — no live SPA caller today; will become live when ORCID-only consent ops ship)

## Problem

`frontend/src/pages/orcid-callback.js:205-224` has a switch on `data.mode` that dispatches to per-mode handlers:

```js
switch (data.mode) {
  case 'signup':       this._handleSignup(data); break;
  case 'login':        this._handleLogin(data); break;
  case 'accredit':     this._handleAccredit(data); break;
  case 'link':         this._handleLink(data); break;
  case 'session_auth': this._handleSessionAuth(data); break;
  default:
    this.status = 'error';
    this.errorMessage = this.$t('orcid.verificationFailed');
}
```

The backend's `/api/orcid/callback` endpoint also supports `mode: 'fresh_auth'` — the target-bound (consent-op) ORCID-mediated proof issuance for self-custody / password-mechanism users who want to use ORCID as the fresh-auth factor for `author_accept` / `author_resign` broadcasts. See `agents/docs/api-contracts/orcid.md` section "fresh_auth" (around line 195) and `backend/src/routes/orcid.ts:1148` (the issuance call site).

Because no SPA `case` handles `mode === 'fresh_auth'`, any callback round-trip that returns this mode falls into `default` and surfaces an error page (`orcid.verificationFailed`). The proof is issued backend-side but never reaches a frontend caller.

## Why latent (not live) today

Verified at architect intake on 2026-05-16: `grep -rn "fresh_auth" frontend/src/` shows no SPA call site sets `mode: 'fresh_auth'` on `POST /api/orcid/start`. The only mode-setting caller path is `session_auth` (in `frontend/src/lib/fresh-auth.js:mintNonConsentProof`). So today, no `fresh_auth` callback ever fires — the dispatch gap is unreachable.

## Why this will become live

Per `agents/docs/ARCHITECTURE.md` § 6.4 and the api-contract for `/api/orcid/callback mode=fresh_auth`, the consent-op surface (`author_accept` / `author_resign` ops) for ORCID-only users requires a target-bound fresh-auth proof. When `ui-multi-author-consent-affordances` (currently in `tasks/blocked/`) and related consent-flow UI work lands, the SPA will need a path that:

1. Calls `POST /api/orcid/start` with `mode: 'fresh_auth'` and a per-op target (action + root_author + root_permlink).
2. Routes through the ORCID OAuth round-trip.
3. Receives the callback response with `mode: 'fresh_auth'` and a target-bound `fresh_auth_proof`.
4. Caches or directly hands off the proof to the pending consent-op broadcast.

Today step 4 has no handler. The proof would be issued, the user would see the error page, and the broadcast would never complete.

## Goal

Implement a `_handleFreshAuth(data)` handler in `frontend/src/pages/orcid-callback.js` and add a `case 'fresh_auth':` branch to the switch.

## Acceptance

### 1. New handler

Implement `_handleFreshAuth(data)` mirroring `_handleSessionAuth` (lines 290-300) where the patterns overlap:

- Self-guard on `_mounted`.
- Receive `data.fresh_auth_proof` + `data.expires_at` + the target binding (`action`, `root_author`, `root_permlink` returned by the backend; verify the wire shape against `api-contracts/orcid.md` `fresh_auth` section).
- Stash the proof. The cache shape differs from `session_auth`: a target-bound proof can only be consumed by a broadcast carrying the matching `(action, root_author, root_permlink)` triple. Decide whether to (a) extend `cacheSessionProof` in `frontend/src/lib/fresh-auth.js` to handle target-bound entries, or (b) introduce a new `cacheConsentOpProof` helper. (b) is cleaner per the existing helper's session-kind specialization, but (a) avoids helper sprawl. Pick during implementation.
- Surface the same success-toast pattern.
- Navigate back to the page that initiated the flow (the paper-detail page expecting the consent-op broadcast to complete). Per the session_auth pattern, use `getReturnPath()` / `clearReturnPath()` (or an equivalent helper).

### 2. Switch branch

Add `case 'fresh_auth': this._handleFreshAuth(data); break;` between the existing `link` and `session_auth` cases (preserve roughly-alphabetical/logical ordering).

### 3. Coordination with consent-flow UI

This handler is necessary infrastructure for `ui-multi-author-consent-affordances` (in `blocked/`) and any future ORCID-mediated consent-op UI. Coordinate the cache-shape decision (option (a) vs (b) above) with whichever consent-op UI lands first — the broadcast consumer side needs to know how to look up a target-bound proof from the cache.

If consent-op UI is already landed when this task is picked up, mirror the existing consumer's lookup shape. If consent-op UI hasn't landed, document the chosen cache shape in this task's signal block so the consumer side can target it.

### 4. Tests

E2E test covering: SPA initiates an `mode: 'fresh_auth'` ORCID round-trip → callback receives the target-bound proof → handler caches it → next broadcast against the matching target succeeds. May not be implementable until the SPA caller side exists (per "Why latent" above); in that case, add at minimum a unit test for `_handleFreshAuth` that asserts the cache write and the return-path navigation.

### 5. i18n

If a new toast string differs from `orcid.reauthSuccess` (the existing session_auth success toast), add the new key to `frontend/public/messages/*.json` per the existing stub pattern.

## Out of scope

- Backend changes — `/api/orcid/callback mode=fresh_auth` and `/api/orcid/start mode=fresh_auth` already work.
- The consent-op UI itself (filed separately as `ui-multi-author-consent-affordances` and friends).
- Extending the cache helper for non-consent-op variants — scope this task to the `fresh_auth` mode handler.

## Source

- `/ce-code-review` of `backend-expires-at-iso-conformance` (architect session 2026-05-16): api-contract residual, pre-existing P1 latent. Verified at architect intake (no live SPA caller today, downgraded to P3 latent).

## Cross-references

- `frontend/src/pages/orcid-callback.js:205-224` — the switch site.
- `frontend/src/pages/orcid-callback.js:290-300` — `_handleSessionAuth` as the pattern to mirror.
- `frontend/src/lib/fresh-auth.js` — `cacheSessionProof` / `getCachedSessionProof` for the cache primitives; decide whether to extend or add a sibling helper.
- `agents/docs/api-contracts/orcid.md` `fresh_auth` section — the target-bound callback wire shape.
- `backend/src/routes/orcid.ts:1148` — the backend issuance call site (read for the response shape).
- `agents/docs/tasks/blocked/ui-multi-author-consent-affordances.md` — the future consumer; coordinate cache shape.
- `agents/docs/ARCHITECTURE.md` § 6.4 — re-auth contract and the role of `mode: 'fresh_auth'` in consent-op flows.

## UI implementation signal (2026-05-16, working tree)

Landed the dispatch handler and cache primitives so `mode: 'fresh_auth'` callbacks no longer fall into the default error branch.

**Cache shape decision: Option (b) — new `cacheConsentOpProof` helpers.** Rationale: the existing `cacheSessionProof`/`getCachedSessionProof`/`clearCachedSessionProof` triad is explicitly session-kind specialized (storage key `pevo_fresh_auth_session_proof`, comments name "session-kind", mint helper `mintNonConsentProof`). The session/consent_op kind distinction is first-class on the backend (different broadcast surfaces, different ban rules, different mismatch error reasons); mirroring it on the frontend keeps the helper boundary clean and avoids overloading the session helpers with optional target fields they don't otherwise need.

**Cache shape — for `ui-multi-author-consent-affordances` consumer side:**

- Storage key: `pevo_fresh_auth_consent_op_proof` (sessionStorage, single slot)
- Cached entry shape: `{ token, expiresAt, action, rootAuthor, rootPermlink }`
- Lookup API: `getCachedConsentOpProof(action, rootAuthor, rootPermlink)` — strict match on all three target fields plus TTL check; returns `null` on miss/mismatch/expiry
- Write API: `cacheConsentOpProof(token, expiresAt, action, rootAuthor, rootPermlink)`
- Clear API: `clearCachedConsentOpProof()`

The consumer-side broadcast helper (consent-op equivalent of `broadcastWithFreshAuth`) should call `getCachedConsentOpProof` keyed on the consent op's `(action, root_author, root_permlink)` triple. On miss it mints fresh via a `POST /api/orcid/start` call with `mode: 'fresh_auth'` plus the target triple; the `_handleFreshAuth` callback below seeds the cache when the OAuth round-trip returns. Single-slot is sufficient: each `/start` call mints state for one target, and a second flow legitimately overwrites the prior cached entry (matching the existing `pevo_orcid_mode` localStorage overwrite pattern).

**Deliverables landed:**

- `frontend/src/lib/fresh-auth.js`: added `CONSENT_OP_PROOF_KEY` constant + `cacheConsentOpProof` / `getCachedConsentOpProof` / `clearCachedConsentOpProof` exports.
- `frontend/src/pages/orcid-callback.js`: added `_handleFreshAuth(data)` handler (mirrors `_handleSessionAuth` pattern: self-guard on `_mounted`, cache target-bound proof, consume `getReturnPath()` + `clearReturnPath()`, fire `orcid.reauthSuccess` toast, navigate). Added `case 'fresh_auth':` between `link` and `session_auth` in the dispatch switch. Extended `init()`'s backPath branch to cover `mode === 'fresh_auth'` alongside `session_auth` (both consume the shared return-path slot).

**i18n:** No new keys added. The success toast reuses `orcid.reauthSuccess` — the per-task acceptance §5 escape hatch ("If a new toast string differs from `orcid.reauthSuccess`... add the new key"). For target-bound vs target-less re-auth, the same "Re-authenticated. Please retry your action." copy applies — the consumer-side broadcast already handles the retry.

**Tests added (`frontend/tests/unit/pages-orcid-callback.test.js`):**

- `handles fresh_auth mode: caches target-bound proof, navigates return path, fires success toast` — full happy path through `_verify`, asserts sessionStorage payload shape (including all three target fields), return-path consumption, navigation, and toast.
- `fresh_auth without a stored return path falls back to /` — default-path fallback.
- `_handleFreshAuth direct-call post-teardown is a no-op (handler self-guards)` — mirrors the existing self-guard regression coverage for sibling handlers.
- `init sets backPath from getReturnPath for fresh_auth mode` — init() backPath branch coverage.

Added a `sessionStorage` global stub to the test file's `beforeEach` (the existing test fixture only stubbed `localStorage`, but the new tests need session storage for the cache + return-path slots). Stub is non-disruptive — none of the existing 46 tests touch sessionStorage, and all 50 tests (46 + 4 new) pass.

Per task acceptance §4 "May not be implementable until the SPA caller side exists; in that case, add at minimum a unit test." — only unit tests added; the E2E test waits for the consumer-side caller (`ui-multi-author-consent-affordances`) to land.

**Out of scope as documented:** no backend changes (the `mode: 'fresh_auth'` issuance path at `backend/src/routes/orcid.ts:1144` already works); no consent-op broadcast helper (consumer side); no consent-op UI itself.

## Architect re-review (2026-05-16, round-1) — HELD PENDING FIXES + BLOCKED by Backend:

`/ce-code-review` ran on commit `c0a6e8e` with 10 personas (correctness Opus; testing/maintainability/project-standards/security/reliability/api-contract/julik-frontend-races/learnings-researcher Sonnet; adversarial Opus; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). One P0 wire-contract finding with 5-reviewer corroboration plus two folded sub-items. The implementer's working assumption — that `data.action` / `data.root_author` / `data.root_permlink` arrive in the `/api/orcid/callback` fresh_auth response — does not match the current backend. The cache as currently shipped is a guaranteed no-op the moment the consumer side wires up.

### Items to address (after blocker resolves)

**1. (P0 wire-contract) Cache write stores `{action: undefined, rootAuthor: undefined, rootPermlink: undefined}` because the backend `fresh_auth` callback response doesn't echo those fields.** Cross-reviewer agreement: api-contract (P0/100), security SEC-1 (P2/100), reliability R1 (high/95), adversarial-2 (low/80), correctness (P2/75). The fix path chosen at architect triage is **option (a) backend echoes the target triple** — filed as `agents/docs/tasks/pending/backend-orcid-fresh-auth-callback-echoes-target-triple.md`. This UI task is moved to `tasks/blocked/` `[BLOCKED by Backend]` pending that landing.

   **When unblocked:** verify the existing unit tests in `frontend/tests/unit/pages-orcid-callback.test.js` still pass against the now-correct wire shape (they should — the mocks already include the triple, so the assertions become accurate rather than fabricated). No code change to `_handleFreshAuth` expected (it already reads the right fields). If the backend chose a slightly different field naming, adjust `_handleFreshAuth`'s data-field reads.

   **Folded sub-item 2 (was Finding 2 at triage, P2 correctness/75):** correctness-reviewer flagged that the existing mocks fabricate fields the real backend doesn't return — a false-green. Folds into item 1: once backend echoes the triple, the mock-fabricated state becomes the real state and the assertions are valid. No separate work needed beyond verifying after the backend fix lands.

   **Folded sub-item 3 (was Finding 3 at triage, P2 project-standards/75):** test file `frontend/tests/unit/pages-orcid-callback.test.js` is missing the root CLAUDE.md clause (a) carve-out justification header. The file pre-dates this commit but this commit extends the mock surface (new sessionStorage stub + 4 mocked test cases). While in the file addressing item 1, add a file-header comment naming the mock targets and rationale, e.g.:

   ```js
   /**
    * Unit tests for the orcid-callback Alpine page.
    *
    * Carve-out for deterministic edge-case coverage (root CLAUDE.md clause a):
    * mocks `alpinejs` and `completeOrcid` from api.js. Real paths are impractical
    * per-test (Alpine store/data wiring is non-trivial to bootstrap; completeOrcid
    * hits the live /api/orcid/callback endpoint and requires a full OAuth round-trip).
    * Real-path companion: the future E2E test in ui-multi-author-consent-affordances
    * exercises the live callback against a running backend (deferred per task §4).
    */
   ```

   **Folded sub-item 4 (was Finding 4 at triage, P3 security/75):** `getCachedConsentOpProof` (and its pre-existing sibling `getCachedSessionProof`) treat malformed-but-truthy `expiresAt` as never-expiring because `Date.now() >= NaN` returns `false`. Parallel-fix both helpers in the same commit: compute `const ts = new Date(entry.expiresAt).getTime();` once, then `if (!Number.isFinite(ts)) { sessionStorage.removeItem(...); return null; }` before the TTL comparison. ~4 LOC each; clears the slot on corruption like the other defensive branches do.

### Items dismissed at architect triage

- adversarial-1 (medium/70): expires_at format drift between backend and cache — bounded by the prior `backend-expires-at-iso-conformance` fix per learnings-researcher; below anchor-75 gate.
- adversarial-3 (low/55): shared return-path slot couples session_auth and fresh_auth flows — pre-existing single-slot design, below anchor-75 gate.
- adversarial-4 (low/75): mismatch path in `getCachedConsentOpProof` doesn't clear the slot — **intentional by design** (the proof remains valid for its actual target until TTL), confirmed in the task signal block and by learnings-researcher.

### Learnings surfaced

- **Known Pattern:** `agents/docs/solutions/conventions/wire-contract-shape-pinned-on-backend-not-stub-2026-05-16.md` is exactly this failure mode: a stubbed test masks a backend-emit gap. The backend integration-test pin asked for in the new backend task is this convention's prescription.
- **Known Pattern:** `agents/docs/solutions/conventions/synchronous-flag-before-await-idempotency-guard-2026-05-16.md` — the `_handleFreshAuth` self-guard placement (entry-only, since handler is synchronous) is correctly applied.
- **Known Pattern:** `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` — the dispatch switch + `init()` backPath branch are sibling-paired and currently in sync; any future mode addition must touch both.

### Architect signal

[BLOCKED by Backend] This task is moved to `tasks/blocked/` pending `agents/docs/tasks/pending/backend-orcid-fresh-auth-callback-echoes-target-triple.md` landing. When the backend task is archived, the architect will move this file back to `tasks/pending/` (per root CLAUDE.md rule #8 the HELD PENDING FIXES move from review goes to pending, and the BLOCKED move goes to blocked — this task is currently in the latter state). The UI implementer then addresses items 1 (verify) + folded sub-items 3 + 4 in a single commit, then `git mv`s the file back to `tasks/review/` for round-2 architect re-review.

## Architect-review item 5 (2026-05-16) — defensive validation on the echoed triple

Surfaced by `/ce-code-review` of the now-archived `backend-orcid-fresh-auth-callback-echoes-target-triple` (adversarial reviewer, P3 anchor 75). `_handleFreshAuth` reads `data.action` / `data.root_author` / `data.root_permlink` and passes them straight into `cacheConsentOpProof(...)` with no validation. If a future backend regression dropped one of the three fields from the `sendOk` echo, the SPA would silently write a cache entry with `undefined` in that slot; subsequent `getCachedConsentOpProof` strict-equality lookups would always miss and the user would re-OAuth indefinitely with no error surface. The failure mode is silent UX rot, not a thrown error.

Add a `typeof data.action === 'string' && data.root_author && data.root_permlink` guard before calling `cacheConsentOpProof` in `_handleFreshAuth`. On a missing or malformed field, set `this.status = 'error'` and `this.errorMessage = this.$t('orcid.verificationFailed')` (mirror the default-case error surface in the dispatch switch) so the failure becomes loud rather than silent. Land in the same commit as item 1 (mocks now match the real wire shape) + sub-items 3 + 4.

This is a defense-in-depth measure against future backend drift; the backend integration test pin at `orcid.test.ts:3050+` is the primary contract guard. The SPA-side validation catches the case where the backend echo regresses *between* test runs (a release that ships with the echo dropped but the test suite not re-run).

## UI re-review signal (2026-05-16, round-2, working tree)

All four architect items landed in one commit per the hold-block directive.

**Item 1 (verify):** existing unit tests in `frontend/tests/unit/pages-orcid-callback.test.js` continue to pass against the now-correct wire shape (backend `backend-orcid-fresh-auth-callback-echoes-target-triple` archived 2026-05-16). The mock-fabricated `(action, root_author, root_permlink)` fields in the round-1 tests now reflect the real backend echo, so the assertions became accurate rather than fabricated. No code change to `_handleFreshAuth` was needed for the wire-contract item itself; the existing field reads still match.

**Folded sub-item 3 (test-file carve-out header):** added a JSDoc header to `frontend/tests/unit/pages-orcid-callback.test.js` documenting the clause (a) carve-out — mocks `alpinejs` (Alpine.data, Alpine.store) and `completeOrcid` from `api.js`; real paths impractical per-test (Alpine wiring + OAuth round-trip); clause (b)'s real-middleware requirement does not apply (no `verifyHiveSignature` exercised); clause (c)'s real-path companion is the deferred E2E in `ui-multi-author-consent-affordances`.

**Folded sub-item 4 (NaN expiresAt fix, both helpers):** parallel-fixed `getCachedSessionProof` and `getCachedConsentOpProof` in `frontend/src/lib/fresh-auth.js`. Pattern applied to both: compute `const ts = new Date(entry.expiresAt).getTime();` once, then `if (!Number.isFinite(ts) || Date.now() >= ts) { sessionStorage.removeItem(KEY); return null; }`. Corrupted TTL entries now clear the slot like every other defensive branch. No dedicated test file added — the failure mode requires a malformed `expiresAt` in sessionStorage which no current code path produces (backend emits ISO strings, helpers always write `new Date().toISOString()`), so test coverage of this branch would qualify as preemptive-hardening under the project's default-dismiss posture. Behavior verified by code-review.

**Item 5 (defensive triple validation):** added a guard at the top of `_handleFreshAuth` matching the architect's prescribed shape: `if (typeof data.action !== 'string' || !data.root_author || !data.root_permlink) { this.status = 'error'; this.errorMessage = this.$t('orcid.verificationFailed'); return; }`. Mirrors the dispatch-switch default-case error surface so a future backend regression that drops one of the echoed fields becomes a loud failure (visible error page) instead of silent UX rot (cache write with `undefined` slots, every lookup misses, user re-OAuths indefinitely).

**Tests added** to `frontend/tests/unit/pages-orcid-callback.test.js` (4 new cases under "_verify - error classification"):

- `fresh_auth with missing action: surfaces error, no cache write, no navigation`
- `fresh_auth with missing root_author: surfaces error, no cache write`
- `fresh_auth with missing root_permlink: surfaces error, no cache write`
- `fresh_auth with non-string action: surfaces error, no cache write` — `typeof` strictness on `action`

All 54 tests in the file pass (50 prior + 4 new).

**Files touched:**
- `frontend/src/lib/fresh-auth.js` — NaN-finite guard added to both cached-proof getters
- `frontend/src/pages/orcid-callback.js` — defensive triple validation prefix in `_handleFreshAuth`
- `frontend/tests/unit/pages-orcid-callback.test.js` — carve-out file header + 4 new tests

**Out of scope (unchanged from round-1):** no backend changes, no consent-op broadcast helper, no consent-op UI. The E2E test deferred per acceptance §4 still waits for `ui-multi-author-consent-affordances` to land the consumer side.
