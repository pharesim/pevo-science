# UI-CREDIT-OP-PROOF-CACHE-SLOT-KEY — key the credit-op fresh-auth proof cache per slot, not per paper

**Owner:** ui
**Created:** 2026-06-09 (architect, from the `/ce-code-review` of `backend-authorship-credit-ops-fresh-auth`; adversarial + api-contract, P2)
**Priority:** P2 (latent — only bites once the SPA wires credit-op broadcasts with `fresh_auth_proof`)

## Problem

The SPA caches a minted `fresh_auth_proof` so a re-auth round-trip is not repeated per action. For consent ops the cache key is the `(action, root_author, root_permlink)` triple. Credit ops (`claim_authorship`, `approve_authorship`, `revoke_authorship`) bind a richer target: claim/approve also bind `author_index` (the name-only slot), and approve/revoke bind `claimer` (the subject). If the SPA caches credit-op proofs keyed only on the paper, two proofs for different slots on the same paper collide — a slot-2 proof overwrites a slot-3 proof, and the subsequent `POST /api/custody/broadcast` returns 403 `FRESH_AUTH_REQUIRED` `details.reason: "target_mismatch"`.

This is the frontend half of a two-part fix. The backend half (echo `author_index` / `claimer` from the ORCID `mode=fresh_auth` response so the SPA can read the proof's actual binding) is held on the backend task `backend-authorship-credit-ops-fresh-auth` (item 7). This UI task cannot complete until that echo lands.

## Goal

Key the credit-op proof cache on the full target the backend binds — paper plus `author_index` (claim/approve) plus `claimer` (approve/revoke) — so a proof minted for one slot/subject is never reused for another. Read the echoed target fields from the issuance response rather than reconstructing them client-side.

## Acceptance

- The SPA cache stores and looks up a credit-op proof by its full target (paper + `author_index` where present + `claimer` where present), not by paper alone.
- Minting a proof for `(paper, slot 2)` and then broadcasting `(paper, slot 3)` does NOT reuse the slot-2 proof; the SPA mints a fresh proof for slot 3.
- The cache key derives from the backend-echoed target fields, so it cannot drift from the proof's actual binding.
- No change to the consent-op cache path.

## Dependencies / cross-references

- **Blocked-until:** backend item 7 (echo `author_index`/`claimer` from `handleFreshAuth`) on `backend-authorship-credit-ops-fresh-auth`. Until that lands the SPA has no echoed slot/subject to key on. Pick this up once the backend echo is in.
- Also gated by the broader SPA credit-op broadcast wiring (the SPA does not yet pass `fresh_auth_proof` on claim/approve broadcasts).
- `agents/docs/api-contracts/orcid.md` (`fresh_auth` response echo), `agents/docs/api-contracts/custody.md` (credit-op target binding), `ARCHITECTURE.md` § 6.4.
- Frontend proof-cache helper (the consent-op `cacheConsentOpProof` / `getCachedConsentOpProof` shape) is the pattern to extend.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## [BLOCKED by Backend] (2026-06-09, UI)

Routed to `blocked/` at intake. The task's own "Blocked-until" makes this
unstartable: the SPA has no echoed slot/subject to key the cache on until the
backend echoes `author_index` / `claimer` from the `mode=fresh_auth` ORCID
callback. Verified at intake:
- `backend-authorship-credit-ops-fresh-auth` (which carries the echo as its item
  7) is still in `tasks/review/` — the echo has not landed.
- A grep for `author_index` / `claimer` in `frontend/src/pages/orcid-callback.js`
  and `backend/src/routes/orcid.ts` returns no echo of those fields today.

Secondary gate: the SPA does not yet pass `fresh_auth_proof` on credit-op
(claim/approve/revoke) broadcasts at all, so there is no cache write/read site to
re-key even once the echo lands.

**Unblock condition:** the backend echoes `author_index` / `claimer` in the
`fresh_auth` callback response (backend item 7 lands), AND the SPA credit-op
broadcast wiring that passes `fresh_auth_proof` exists. Backend moves this file
back to `tasks/pending/` once the echo is in; re-check the secondary gate before
starting.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
