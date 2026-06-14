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

## [BLOCKED by UI] (2026-06-11, Backend) — backend echo landed, block re-characterized

The named backend dependency is RESOLVED: the `mode=fresh_auth` ORCID callback
response now echoes `author_index` / `claimer` from the bound target (the
response builder in `backend/src/routes/orcid.ts` spreads both optional
fields; landed with the archived `backend-authorship-credit-ops-fresh-auth`,
its item 7). Verified in code 2026-06-11.

NOT moved to `pending/` because the secondary gate still fails: no SPA
credit-op broadcast wiring exists at all (grep for `claim_authorship` /
`approve_authorship` / `revoke_authorship` across `frontend/src` returns
nothing), so there is still no cache write/read site to key. The remaining
dependency is UI-zone sequencing, so the block is re-characterized
`[BLOCKED by UI]`: unblocks when the SPA credit-op broadcast wiring that
passes `fresh_auth_proof` lands; whoever lands it moves this file to
`pending/`. No backend work remains on this task.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

## [UI] (2026-06-14) — DELIVERED with the consent-affordances surface; moved to review/

The unblock condition is met AND the acceptance is implemented, landing together
with `ui-multi-author-consent-affordances` (the surface that IS this cache's
broadcast-wiring consumer). Moving directly to `review/` (done, not merely
startable). What landed:

- The single-slot consent-op proof cache now keys on the FULL target. Both
  `cacheConsentOpProof` and `getCachedConsentOpProof` (`frontend/src/lib/fresh-auth.js`)
  take optional `authorIndex` / `claimer`, normalize absent values to `null`, and
  strict-match every field. Anchored consent ops and settings actions (no
  author_index/claimer) keep matching on the `(action, root_author, root_permlink)`
  triple — backward compatible, including pre-extension cached entries.
- The key derives from the BACKEND-ECHOED target, not a client reconstruction:
  the `/orcid/callback` `_handleFreshAuth` threads `data.author_index` /
  `data.claimer` into `cacheConsentOpProof`; the password factor mints via the
  same target fields. Both issuance paths echo `author_index` (claim/approve) and
  `claimer` (approve/revoke).
- The credit-op broadcast wiring that consumes the keyed proof is the
  `withAuthorshipFreshAuth` orchestrator (`frontend/src/lib/authorship-consent.js`),
  used by paper-detail's claim/approve/revoke handlers (which previously broadcast
  a session-kind proof the custody gate rejects with `kind_mismatch`).
- Tests: `frontend/tests/unit/lib-fresh-auth-consent-op-cache.test.js` pins the
  acceptance directly — a slot-2 proof is not reused for slot-3; an approve proof
  for claimer A is not reused against claimer B; the triple-only and pre-extension
  paths still hit. `lib-authorship-consent.test.js` covers the orchestrator's
  full-target cache lookup.

Acceptance met: full-target store+lookup; slot-2/slot-3 non-reuse; key derived
from echoed fields; consent-op (triple) path unchanged. The architect reviews
and archives alongside the parent.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-14) — HELD PENDING FIXES

`/ce-code-review` of the delivery commit surfaced one substantive item squarely on
this task (the credit-field echo this cache keys on) plus an anchor cleanup; the
user elected to hold. The broadcast-wiring and orchestrator findings live on the
sibling `ui-multi-author-consent-affordances` hold block. Re-review scopes to the
commits landed since this block.

Should-fix:

1. The `_handleFreshAuth` echo guard in `src/pages/orcid-callback.js` validates
   only the `(action, root_author, root_permlink)` triple, NOT the `author_index`
   (claim/approve) and `claimer` (approve/revoke) credit-op fields this task now
   keys the cache on. The guard's own comment claims it prevents writing
   `undefined` into a target field and the resulting indefinite re-OAuth — but for
   a credit op that is exactly what happens if the backend drops a credit-field
   echo: `cacheConsentOpProof` stores `undefined → null` while the eventual lookup
   keys on the real index/subject, so the strict match permanently misses and the
   user re-OAuths in a loop with no error surface. Extend the guard per action:
   require `author_index` a non-negative integer for
   `claim_authorship`/`approve_authorship`; require `claimer` a non-empty string
   for `approve_authorship`/`revoke_authorship`; surface `status='error'` /
   `orcid.verificationFailed` on a malformed echo, mirroring the triple guard.

Comment-anchor cleanup:

2. `tests/unit/lib-fresh-auth-consent-op-cache.test.js` header cites the task slug
   ("sibling `ui-credit-op-proof-cache-slot-key` acceptance"); re-anchor on
   behavior ("slot-keyed proof non-reuse") per root CLAUDE.md "Comment anchors".

Test gap worth closing: the cache suite never asserts the `author_index === 0`
POSITIVE hit (0 is only exercised as an expected miss); a broken `0 ?? null`
normalization on a real slot-0 claim/approve proof would slip through.

When fixed, `git mv` this file back to `tasks/review/`; the move is the re-review
signal. Do not edit this block.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI re-review signal (2026-06-14, working tree) — holds landed

Both items landed (alongside the sibling `ui-multi-author-consent-affordances`,
same commit). Full frontend unit suite green (1490 passed).

1. (Should-fix) `_handleFreshAuth` echo guard in `src/pages/orcid-callback.js`
   now validates the per-action credit fields the cache keys on, after the
   existing triple guard: `author_index` a non-negative integer for
   `claim_authorship` / `approve_authorship` (slot 0 is valid — checked via
   `Number.isInteger`, not truthiness); `claimer` a non-empty string for
   `approve_authorship` / `revoke_authorship`. A malformed/dropped echo now
   surfaces `status='error'` / `orcid.verificationFailed` instead of caching
   undefined→null and re-OAuth-looping. Anchored consent ops (author_accept /
   author_resign) and settings actions bind neither field and skip the guard.
   New per-action tests in `pages-orcid-callback.test.js`: slot-0 claim caches
   author_index 0; missing author_index errors; approve caches both fields;
   missing claimer errors; revoke binds claimer only.
2. (Anchor) `lib-fresh-auth-consent-op-cache.test.js` header re-anchored on
   behavior ("slot-keyed proof non-reuse"). Test gap closed: slot-0 positive
   cache-hit test added (guards the `author_index ?? null` normalization — 0
   round-trips as 0, and a triple-only lookup does NOT hit a slot-0 entry).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review #2 (2026-06-14) — HELD PENDING FIXES: per-action echo-guard negative coverage

Both round-1 holds (the per-action echo guard + the slot-0 anchor/positive-hit
test) are confirmed FIXED — verified in code and via the focused unit run. The
guard at the per-action credit-field check in `src/pages/orcid-callback.js`
`_handleFreshAuth` is correct: `claim_authorship`/`approve_authorship` require
`author_index` a non-negative integer (slot 0 accepted via `Number.isInteger`),
`approve_authorship`/`revoke_authorship` require `claimer` a non-empty string,
and a malformed echo returns BEFORE `cacheConsentOpProof` so no partial entry is
written.

A fresh `/ce-code-review` (9 reviewers; correctness/security/adversarial on the
session model, ce-agent-native skipped per PEvO) surfaced one in-scope gap on
this task's own deliverable: the per-action guard is under-tested on two
branches. The happy paths plus the missing-`claimer` case for approve are
covered, but two negative branches the guard depends on have no test. A mutation
of the per-action requirement sets would pass the current suite. Close both in
`tests/unit/pages-orcid-callback.test.js`:

1. `revoke_authorship` fresh_auth echo with a missing or empty `claimer`
   (and no `author_index`, since revoke binds claimer only): assert the handler
   surfaces `status='error'` with `orcid.verificationFailed` AND writes no
   consent-op proof to sessionStorage. The guard marks revoke as claimer-binding,
   so this branch fires in production but is unexercised — a regression dropping
   revoke from the claimer-binding set would slip through.

2. `approve_authorship` fresh_auth echo with a valid `claimer` but a missing or
   non-integer `author_index`: assert the same error + no-cache outcome. Approve
   binds BOTH fields; the existing approve tests cover both-present and
   missing-`claimer` but not missing-`author_index`, so a regression dropping
   approve from the index-binding set would cache `author_index → null` for an
   approve op undetected.

Assert the actual error status/key and the ABSENCE of the cache write (parse
sessionStorage), mirroring the existing per-action positive tests — not just
"no throw."

When fixed, `git mv` this file back to `tasks/review/`; the move is the
re-review signal. Do not edit this block.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI re-review signal (2026-06-14, working tree) — re-review #2 holds landed

Both negative-coverage gaps from re-review #2 are closed in
`tests/unit/pages-orcid-callback.test.js`, mirroring the existing per-action
positive/negative tests: each asserts `status='error'` with
`orcid.verificationFailed` AND the ABSENCE of the sessionStorage consent-op
proof write (parsed, not just "no throw").

1. `revoke_authorship` fresh_auth echo with a missing `claimer` (plus a second
   variant with an empty-string `claimer`), no `author_index`: surfaces the
   error and writes no proof. Guards revoke staying in the claimer-binding set.
2. `approve_authorship` fresh_auth echo with a valid `claimer` but a missing
   `author_index` (plus a second variant with a non-integer `author_index`):
   surfaces the error and writes no proof. Guards approve staying in the
   index-binding set.

Focused file: 76 passed. Full frontend unit suite green (1525 passed).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
