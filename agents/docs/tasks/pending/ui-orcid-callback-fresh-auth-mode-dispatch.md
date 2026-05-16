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
