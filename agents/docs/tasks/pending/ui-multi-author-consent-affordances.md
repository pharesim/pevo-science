# UI-MULTI-AUTHOR-CONSENT-AFFORDANCES — display + actions for consent-gated authorship

**Owner:** UI Agent
**Created:** 2026-05-05 (architect, surfaced by `/ce-doc-review` of `agents/docs/ARCHITECTURE.md`)
**Re-scoped:** 2026-06-14 (architect — folded onto the ratified consented-authorship model; flag-day/vouched premise gone, Route 3 added, backend deps satisfied; then reconciled against the live Route-3 claim surface — EXTEND not rebuild, unified credit badge per decision β)
**Priority:** P2 (user-facing consent surface; the backend read + write surfaces it consumes are live)

## Problem

The consented-authorship model (`agents/docs/ARCHITECTURE.md` § 2 "Consented vs claimed authorship") distinguishes a co-author who is **credited** for a paper (consented via Routes 1/2, or accepted-claim via Route 3; badged) from one who is merely **claimed** (named in `authors[]` but not yet credited). Credit is conferred by on-chain ops on three routes; demotion by their inverses.

A **live Route-3 surface already exists and this task EXTENDS it** — it does not build from scratch. `backend/src/routes/claims.ts` broadcasts `claim_authorship`/`approve_authorship`/`revoke_authorship` and serves `GET .../claims`; `frontend/src/pages/paper-detail.js` already renders per-slot `Confirmed`/`Pending` claim badges and claim/approve/reject buttons (`handleClaimSlot`/`handleApproveClaim`/`handleRejectClaim`, `claims.*` i18n), with `claimAuthorship`/`approveAuthorshipClaim`/`revokeAuthorshipClaim`/`fetchPaperClaims` in `frontend/src/api.js`. Landed `c0d90d29`. What is missing is the unified credit-badge display, Route 2 (`author_accept`/`author_resign`, no frontend at all), and the pending-authorships discovery surface. The architect reconciliation note at the bottom has the full exists-vs-missing split.

Per the display rule: credited authors get a PEvO user badge plus a profile link on their name; claimed-but-not-credited names display as plain text, no badge. There is no separate "pending" display tier — badge presence is the only distinction.

## The three routes (from ARCHITECTURE § 2)

- **Route 1 — root broadcaster:** implicit consent via the post signature. No UI affordance needed (already consented by posting).
- **Route 2 — anchored slot:** the co-author broadcasts `author_accept`. Eligibility anchor = `slot.hive == signer` OR `slot.orcid ==` the signer's authority-attested ORCID. Demotion: `author_resign` (anchored self). **(No frontend today — this is net-new.)**
- **Route 3 — name-only slot (no `hive`/`orcid`):** the claimer broadcasts `claim_authorship`; the paper author/admin broadcasts `approve_authorship`. Demotion: claimer self-`revoke_authorship`, plus the author/admin `revoke` backstop. **(Already wired — see Problem.)**

There is **no metadata auto-accept** and **no flag-day migration** — the model is go-forward; nothing live is demoted on a cutover.

## Goal

Land the frontend surface that lets accredited users:

1. See the credited-vs-claimed status of each author on a paper-detail page (a single credit badge is the only display distinction), driven off the union of the per-author `consented` flag (Routes 1/2) and accepted `authorship_claims[]` entries (Route 3) the paper-detail and enrichment APIs already return.
2. Discover the slots awaiting their action — Route-2 anchored slots they can `author_accept`, and Route-3 name-only slots they can `claim_authorship` (or, as a paper author/admin, `approve_authorship`) — via `GET /api/me/authorships/pending`.
3. Act on those slots: accept/resign (Route 2) and claim/approve/revoke (Route 3), via Hive Keychain (self-custody) or the custody fresh-auth endpoint (light accounts).

## Acceptance

### 1. Paper-detail author display — unified credit badge (folds in the existing two-tier claim badge)

For each entry in the displayed authors list on `/papers/:author/:permlink`, render a single "credited" badge driven by the union of the two backend-authoritative signals the SPA already receives. This collapses the existing `claimStatusForSlot` `Confirmed`/`Pending` two-tier rendering into one credit badge (decision β):

- **Credited** (PEvO user badge + profile link) when EITHER:
  - the per-author `consented` boolean from the paper-detail API is `true` (Routes 1/2) — link the badge to that author's `hive` profile; OR
  - an `authorship_claims[]` entry (from enrichment) with `status === 'accepted'` exists for this author's slot index (Route 3) — link the badge to that entry's `claimer` profile (a name-only slot has no `hive`, but the accepted claim carries the claimer's handle).
- **Not credited** (plain text, no badge, no profile link) otherwise: a pending or absent claim, a `consented: false` slot, or a hive-less bridge-paper credit.

A pending Route-3 claim shows **no badge** (plain text), not a "Pending" badge — the pending state is carried by the claim/approve affordances (Acceptance #3), not by a badge. Note the ORCID-anchored edge: `consented` is hive-keyed, so a hive-less anchored slot can read `consented: false` even when cycle-credited (documented in `agents/docs/api-contracts/papers.md`, the `authors[].consented` field note); render it plain-text and do not synthesize a badge from another field.

### 2. Route 2 — accept / resign (anchored slots)

When a logged-in user views a paper carrying an anchored slot they are eligible for but have not consented on (listed with `hive == them` or `orcid ==` their attested ORCID, no active `author_accept`), surface a clear "Accept authorship of this paper" action on the paper-detail page (visible only to that user). A user who is currently consented on a paper they are listed in can broadcast `author_resign` from a secondary surface (a "..." menu), behind a confirmation modal explaining the consequences (loss of continuation-broadcast power and going-forward citation credit; historical contribution record retained).

### 3. Route 3 — claim / approve / revoke (name-only slots) — EXISTING, reconcile

These ops are already wired (`handleClaimSlot`/`handleApproveClaim`/`handleRejectClaim` + the `claims.ts` endpoints). The work here is (a) fold the existing `Confirmed`/`Pending` per-slot badges into the single credit badge of Acceptance #1 (accepted -> credit badge; pending -> plain text plus the affordances below), and (b) route the broadcasts through the per-slot-keyed `fresh_auth_proof` wiring of Acceptance #4 / the sibling `ui-credit-op-proof-cache-slot-key`. Keep the existing actor model:

- **Claim:** when a logged-in user is the plausible owner of a name-only slot (a `name`-only `authors[]` entry, no `hive`/`orcid`), surface a "Claim this authorship" action that broadcasts `claim_authorship`.
- **Approve:** when the current user is the paper author (or admin) and a `claim_authorship` is pending against a name-only slot, surface an "Approve" affordance that broadcasts `approve_authorship`.
- **Revoke:** the claimer can self-`revoke_authorship`; the paper author/admin can revoke as a backstop. Place behind a confirmation modal.

### 4. Signing paths (both routes)

For every consent op above:

- **Self-custody users:** prompt Hive Keychain to sign the op's `custom_json`; broadcast.
- **Light-account users:** route through the custody endpoint with a fresh-auth challenge appropriate to the user's auth mechanism (password re-prompt for password accounts, fresh ORCID OAuth for ORCID accounts; see `agents/docs/ARCHITECTURE.md` "Light-account signing of consent ops"). The credit-op (`claim`/`approve`/`revoke`) broadcasts carry a `fresh_auth_proof`; the proof's binding is echoed back and cached per the sibling `ui-credit-op-proof-cache-slot-key` task — coordinate so this surface IS the broadcast wiring that task keys its cache on.

After a successful broadcast the paper-detail re-renders with the updated badge once backend cache invalidation completes (the read surfaces commit to at-most-one-block staleness).

### 5. Pending-authorships discovery surface

Surface the user's outstanding actions sourced from `GET /api/me/authorships/pending` (`pending_consents` = Route-2 anchored slots awaiting their `author_accept`; `pending_claims` = Route-3 name-only slots awaiting their `claim`/approval), each linking to the paper-detail affordance. This is a steady-state discovery list, not a one-time banner. Fail-closed: the endpoint 503s on HAF unavailability — surface a retry affordance, never a silent empty list that reads as "nothing pending."

### 6. i18n

All new microcopy (accept/resign/claim/approve/revoke labels, confirmation modals, the discovery surface) added to `frontend/public/messages/*.json`, English source updated with stub entries for other languages per the existing pattern. Reuse the existing `claims.*` keys where the existing Route-3 affordances already cover the copy.

### 7. Tests

- Unit tests for the credit-badge-vs-no-badge author-display logic keyed on the `consented` OR accepted-`authorship_claims` union (cover: Route-1/2 consented, Route-3 accepted, Route-3 pending -> no badge, hive-less bridge credit -> no badge).
- E2E for the Route-2 accept flow (Keychain path; light-account custody-fresh-auth path may be covered separately).
- E2E for a Route-3 claim + approve flow.
- E2E for resign/revoke.
- Discovery-surface test (mocks the `/api/me/authorships/pending` response, incl. the 503 fail-closed path).

## Out of scope

- A separate "pending acceptance" display tier — badge-vs-no-badge is the only distinction (the existing "Pending" claim badge is removed in favor of plain-text-plus-affordance).
- A dedicated `/me/authorships` page — the affordances live on paper-detail pages plus the discovery surface.
- The backend read surfaces (`consented` flag + `GET /api/me/authorships/pending`) — delivered by the archived `backend-consented-set-read-surfaces`.
- The chain-layer rules for who can accept/resign/claim/approve/revoke — delivered by the archived `backend-implement-consented-authorship-model`.
- Folding Route-3-accepted into the backend `consented` flag — explicitly rejected in favor of decision β (SPA-side union); see the reconciliation note.

## Dependencies

Both backend dependencies are satisfied (archived 2026-06-14 / 2026-06-12):

- `backend-implement-consented-authorship-model` — the chain-layer consent model + the cycle's credited-set wiring.
- `backend-consented-set-read-surfaces` — the paper-detail `consented` flag and `GET /api/me/authorships/pending` (Route-2 + Route-3 pending slots), both fail-closed.

## Cross-references

- `agents/docs/ARCHITECTURE.md` § 2 "Consented vs claimed authorship" — canonical model.
- `agents/docs/api-contracts/papers.md` — the `authors[].consented` flag (hive-keyed; `false` for hive-less slots even when cycle-credited) and the `authorship_claims[].status` accepted/pending semantics on the paper-detail / enrichment responses.
- `agents/docs/api-contracts/me.md` — the `GET /api/me/authorships/pending` contract: the `{pending_claims, pending_consents}` response shape and the 503 fail-closed posture.
- `ui-credit-op-proof-cache-slot-key` — the SPA credit-op proof-cache keying that this surface's Route-3 broadcast wiring unblocks (this task IS that wiring).
- Archived backend parents in `agents/docs/tasks-archive.md`: `backend-implement-consented-authorship-model`, `backend-consented-set-read-surfaces`.

## [Architect] (2026-06-14) — RECONCILED + UNBLOCKED; moved to pending/

Supersedes the prior "RE-SCOPED + UNBLOCKED" note and the UI `[BLOCKED by Architect]` re-scope request that followed it (git preserves both). The block was: the old Problem asserted "no frontend surface today," but a live Route-3 claim surface already exists (`claims.ts` + `paper-detail.js` claim badges/buttons + `api.js`, landed `c0d90d29`). An architect surface-mapping pass compared the live surface against ARCHITECTURE § 2 and settled the three reconciliation questions:

1. **`claims.ts` IS Route 3 — EXTEND, do not replace.** It broadcasts the exact `claim_authorship`/`approve_authorship`/`revoke_authorship` ops § 2 mandates (`action` field, `id=APP_TAG`) and reads the `authorship_claims` CTE built by `authorshipClaimsCteBody`, whose docblock is literally "Route 3 of the consent model — name-only slots." `GET /api/me/authorships/pending`'s `pending_claims` reads that same CTE, and the reputation cycle credits `status='accepted'` claims as its Route-3 arm. (`authorship_claims` is a per-request HAF CTE, NOT an app-DB table — no migration 001-016 defines it; the prior block's "HAF table" phrasing was imprecise.) Replacing would rebuild identical live ops for no gain.

2. **Badge semantics — one unified "credited" badge, SPA-computed (decision β, user-ratified).** The paper-detail `consented` flag is hive-keyed and covers Routes 1/2 only (`consentedAuthorsCteBody`: `author_accept`/`author_resign`); a name-only Route-3 accepted claim is credited by the cycle but is NOT reflected in that flag. So the display badge means "credited by ANY route": present iff `consented === true` OR an accepted `authorship_claims[]` entry exists for the author's slot. The SPA already receives both signals (`consented` on `authors[]`; `authorship_claims[]` in enrichment) and ORs them per slot — no backend change, no re-deriving the CTEs. The existing `Confirmed`/`Pending` two-tier claim badge collapses into this one credit badge: accepted -> credit badge; pending -> no badge (plain text) with the claim/approve affordances carrying the state (honors § 2's "badge presence is the only distinction, no pending tier"). Alternatives weighed and rejected: keeping two badge vocabularies (contradicts the single-distinction rule) and folding Route-3-accepted into the backend `consented` flag (cleaner single-source contract but adds a backend dependency and re-blocks this task; β keeps it UI-only).

3. **Body updated to extend-not-build framing** — Problem, the three-routes note, Goal #1, and Acceptance #1/#3 now reflect what already exists.

Backend deps remain satisfied (`backend-implement-consented-authorship-model`, `backend-consented-set-read-surfaces`, both archived); decision β keeps this UI-only. Moving to `pending/` for the UI agent.

Separate architect-zone doc-drift surfaced by the mapping (NOT part of this task; tracked by the architect): `papers.md` does not document the paper-detail `authors[].consented` field and still uses stale "vouched" terminology plus a stale `authorship_claims[].status` "auto-accept via ORCID/hive match" description (the auto-accept arms were removed; acceptance now requires an explicit `approve_authorship` + name-only slot); `GET /api/me/authorships/pending` is undocumented in `api-contracts/*.md`.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-14) — HELD PENDING FIXES

`/ce-code-review` of the delivery commit (10-persona fleet + architect direct
verification) surfaced findings; the user elected to hold all of them. Findings
split across this task and the sibling `ui-credit-op-proof-cache-slot-key` by code
ownership — the items below are this surface's. Re-review scopes to the commits
landed since this block.

BLOCKER (must be green before archive):

1. RED UNIT SUITE. The Route-3 reconcile renamed `handleRejectClaim` →
   `handleRevokeClaim` in `src/pages/paper-detail.js`, but
   `tests/unit/pages-paper-detail.test.js` still calls `comp.handleRejectClaim('bob')`
   and was not updated (the test file is outside the delivery diff). Verified by
   running it: `TypeError: comp.handleRejectClaim is not a function`,
   `Test Files 1 failed`. Rename the `it(...)` title + the call to
   `handleRevokeClaim` (set `comp.revokeTarget = 'bob'` first; the asserted
   `claims.rejectFailed` key is still correct). The commit ships a failing test —
   nothing archives until `npx vitest run` is green.

Should-fix:

2. Double-submit on the consent handlers. `handleClaimSlot`, `handleApproveClaim`,
   `handleRevokeClaim`, `handleAcceptAuthorship`, `handleResignAuthorship` set
   `claimLoading = true` only after the first `await`, gating re-entry solely on
   the reactive `:disabled` binding, which lags a same-tick second click — both
   clicks enter and broadcast. This is the project's
   `synchronous-flag-before-await-idempotency-guard` convention. Add
   `if (this.claimLoading) return;` as the first statement of each handler (the
   pre-existing claim handlers share the gap; fix all five together).

3. Duplicated password-factor machinery. `mintViaPassword` / `REMINTABLE_REASONS`
   / `CANCELLED` / `MINT_FAILED` in `lib/authorship-consent.js` are a near-verbatim
   copy of `lib/settings-fresh-auth.js`; the remintable-reason set and the
   two-prompt flow can silently drift apart. Export `REMINTABLE_REASONS` from
   `lib/fresh-auth.js` and extract a shared `mintViaPasswordFactor(mintFn, { message })`
   both orchestrators call.

4. Comment-anchor durability violations (root CLAUDE.md "Comment anchors": no
   task-slug / round / acceptance-number citations in production OR test code).
   Re-anchor on behavior: `src/authorships.js` header
   ("UI-MULTI-AUTHOR-CONSENT-AFFORDANCES Acceptance #5");
   `tests/unit/lib-credit.test.js` ("and the task's Acceptance #1 / #7");
   `tests/e2e/authorship-consent-actions.spec.js` ("Acceptance #2/#3/#7");
   `tests/e2e/authorship-pending-discovery.spec.js` ("Acceptance #5 / #7"). (The
   cache-test anchor is on the sibling task's block.)

Minor (fix-along or dismiss at your discretion — re-review will not block on these):

5. `mintViaPassword` second-attempt catch (`lib/authorship-consent.js`) is a bare
   `} catch { return MINT_FAILED; }` that masks a 503/transport error on the retry
   mint as a generic re-auth failure. Rethrow non-`UNAUTHORIZED` errors so the
   caller surfaces the real cause.

6. `username_mismatch` on a consent op is folded into the generic `freshAuthFailed`
   "try again" outcome, whereas the session-kind sibling `broadcastWithFreshAuth`
   treats the same 403 as a critical session inconsistency and forces re-login
   (`auth.disconnect()`). The user retries a corrupted session indefinitely.
   Special-case `username_mismatch` to tear down the session, matching the sibling.

7. `authorships` store `load()` has no in-flight short-circuit; the generation
   counter keeps it correct but a `refresh()` during an active load fires a
   redundant fetch. Add `if (this.isLoading) return;`.

8. `orcid-callback` `destroy()` scrubs `pevo_orcid_return_to` but not the
   fresh-auth flow's `RETURN_PATH_KEY` (`pevo_fresh_auth_return_to`); benign today
   (overwritten before the next read) but the comment's stated invariant does not
   hold. Add `clearReturnPath()` to `destroy()`.

Test gap worth closing alongside: no test asserts the `author_index === 0` POSITIVE
credit-badge / cache hit (0 is only exercised as an expected miss); a broken
`0 ?? null` on a real slot-0 paper would slip through.

When fixed, `git mv` this file back to `tasks/review/`; the move is the re-review
signal. Do not edit this block — the commit diff is the evidence.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
