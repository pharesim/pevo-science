# UI-MULTI-AUTHOR-CONSENT-AFFORDANCES — display + actions for consent-gated authorship

**Owner:** UI Agent
**Created:** 2026-05-05 (architect, surfaced by `/ce-doc-review` of `agents/docs/ARCHITECTURE.md`)
**Re-scoped:** 2026-06-14 (architect — folded onto the ratified consented-authorship model; the flag-day/vouched premise is gone, Route 3 added, backend deps now satisfied)
**Priority:** P2 (user-facing consent surface; the backend read + write surfaces it consumes are live)

## Problem

The consented-authorship model (`agents/docs/ARCHITECTURE.md` § 2 "Consented vs claimed authorship") distinguishes a co-author who has **consented** to a paper (credited + badged) from one who is merely **claimed** (named in `authors[]` but not yet consented). Consent is conferred by on-chain ops on three routes; demotion by their inverses. There is no frontend surface today, so accredited users cannot broadcast any consent op, and paper-detail does not display the consented-vs-claimed distinction.

Per the display rule: consented authors get a PEvO user badge plus a profile link on their name; claimed-but-not-consented names display as plain text, no badge. There is no separate "pending" display tier — badge presence is the only distinction.

## The three routes (from ARCHITECTURE § 2)

- **Route 1 — root broadcaster:** implicit consent via the post signature. No UI affordance needed (already consented by posting).
- **Route 2 — anchored slot:** the co-author broadcasts `author_accept`. Eligibility anchor = `slot.hive == signer` OR `slot.orcid ==` the signer's authority-attested ORCID. Demotion: `author_resign` (anchored self).
- **Route 3 — name-only slot (no `hive`/`orcid`):** the claimer broadcasts `claim_authorship`; the paper author/admin broadcasts `approve_authorship`. Demotion: claimer self-`revoke_authorship`, plus the author/admin `revoke` backstop.

There is **no metadata auto-accept** and **no flag-day migration** — the model is go-forward; nothing live is demoted on a cutover.

## Goal

Land the frontend surface that lets accredited users:

1. See the consented-vs-claimed status of each author on a paper-detail page (badge presence is the only display distinction), driven off the per-author `consented` flag the paper-detail API returns.
2. Discover the slots awaiting their action — Route-2 anchored slots they can `author_accept`, and Route-3 name-only slots they can `claim_authorship` (or, as a paper author/admin, `approve_authorship`) — via `GET /api/me/authorships/pending`.
3. Act on those slots: accept/resign (Route 2) and claim/approve/revoke (Route 3), via Hive Keychain (self-custody) or the custody fresh-auth endpoint (light accounts).

## Acceptance

### 1. Paper-detail author display

For each entry in the displayed authors list on `/papers/:author/:permlink`, drive the display off the per-author `consented` boolean the paper-detail API returns (always present on detail; see `agents/docs/api-contracts/papers.md`):

- **Consented authors** (`consented: true`): show their `name` plus a PEvO user badge; the name links to their PEvO profile.
- **Claimed-but-not-consented authors** (`consented: false`, or a hive-less bridge-paper credit): show their `name` as plain text, no badge, no profile link.

No separate "pending" affordance, no italicized state. The badge is the only signal. Note the ORCID-anchored edge: the `consented` annotation is hive-keyed, so a hive-less anchored slot shows `consented: false` even when its owner is cycle-credited (documented in `agents/docs/api-contracts/common.md`); render it as plain-text and do not invent a badge from any other field.

### 2. Route 2 — accept / resign (anchored slots)

When a logged-in user views a paper carrying an anchored slot they are eligible for but have not consented on (listed with `hive == them` or `orcid ==` their attested ORCID, no active `author_accept`), surface a clear "Accept authorship of this paper" action on the paper-detail page (visible only to that user). A user who is currently consented on a paper they are listed in can broadcast `author_resign` from a secondary surface (a "..." menu), behind a confirmation modal explaining the consequences (loss of continuation-broadcast power and going-forward citation credit; historical contribution record retained).

### 3. Route 3 — claim / approve / revoke (name-only slots)

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

All new microcopy (accept/resign/claim/approve/revoke labels, confirmation modals, the discovery surface) added to `frontend/public/messages/*.json`, English source updated with stub entries for other languages per the existing pattern.

### 7. Tests

- Unit tests for the badge-vs-no-badge author-display logic keyed on `consented`.
- E2E for the Route-2 accept flow (Keychain path; light-account custody-fresh-auth path may be covered separately).
- E2E for a Route-3 claim + approve flow.
- E2E for resign/revoke.
- Discovery-surface test (mocks the `/api/me/authorships/pending` response, incl. the 503 fail-closed path).

## Out of scope

- A separate "pending acceptance" display tier — badge-vs-no-badge is the only distinction.
- A dedicated `/me/authorships` page — the affordances live on paper-detail pages plus the discovery surface.
- The backend read surfaces (`consented` flag + `GET /api/me/authorships/pending`) — delivered by the archived `backend-consented-set-read-surfaces`.
- The chain-layer rules for who can accept/resign/claim/approve/revoke — delivered by the archived `backend-implement-consented-authorship-model`.

## Dependencies

Both backend dependencies are satisfied (archived 2026-06-14 / 2026-06-12):

- `backend-implement-consented-authorship-model` — the chain-layer consent model + the cycle's credited-set wiring.
- `backend-consented-set-read-surfaces` — the paper-detail `consented` flag and `GET /api/me/authorships/pending` (Route-2 + Route-3 pending slots), both fail-closed.

## Cross-references

- `agents/docs/ARCHITECTURE.md` § 2 "Consented vs claimed authorship" — canonical model.
- `agents/docs/api-contracts/papers.md` — the `consented` field on paper-detail author entries.
- `agents/docs/api-contracts/common.md` — the `/api/me/authorships/pending` 503 fail-closed contract and the `consented` absent-vs-false / ORCID-anchored hive-less semantics.
- `ui-credit-op-proof-cache-slot-key` — the SPA credit-op proof-cache keying that this surface's Route-3 broadcast wiring unblocks.
- Archived backend parents in `agents/docs/tasks-archive.md`: `backend-implement-consented-authorship-model`, `backend-consented-set-read-surfaces`.

## [Architect] (2026-06-14) — RE-SCOPED + UNBLOCKED; moved to pending/

The stale `[BLOCKED by Backend]` (2026-05-05) and the 2026-06-09 coordination note are superseded by this re-scope (git preserves the prior version). Resolved per that note's five points:

1. **Endpoint owner repointed.** All references now point at `backend-consented-set-read-surfaces` (the `consented` flag + `/api/me/authorships/pending`), replacing the removed `backend-notification-infra-for-consent-ops`.
2. **Flag-day premise dropped.** The one-time migration banner (old Goal #4 / Acceptance #4) is gone; the steady-state `GET /api/me/authorships/pending` discovery surface replaces it. Go-forward model, nothing demoted on a cutover.
3. **vouched -> consented** throughout (the ratified sense-3 rename).
4. **Route 3 added.** The body now covers Route 2 (`author_accept`/`author_resign`) AND Route 3 (`claim_authorship` / `approve_authorship` / `revoke_authorship`).
5. **Block re-based and cleared.** The real backend dependencies (`backend-implement-consented-authorship-model`, `backend-consented-set-read-surfaces`) are both archived, so the surface has a live backend to broadcast through and a live pending-slots data source. Moving to `pending/` for the UI agent.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
