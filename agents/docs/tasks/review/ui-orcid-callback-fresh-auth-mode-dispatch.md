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
