# UI-MULTI-AUTHOR-CONSENT-AFFORDANCES — display + actions for consent-gated authorship

**Owner:** UI Agent
**Created:** 2026-05-05 (architect, surfaced by `/ce-doc-review` of `agents/docs/ARCHITECTURE.md` Multi-Author Trust Model section)
**Priority:** P1 (blocks the multi-author trust model flag-day cutover)

## Problem

The Multi-Author Trust Model in `agents/docs/ARCHITECTURE.md` introduces a vouched-vs-claimed-pending distinction for paper co-authors, plus two new on-chain ops (`author_accept`, `author_resign`). Without a UI surface, users have no way to broadcast accept/resign and no consistent display of vouched status.

Per the spec's display rule: vouched authors get a PEvO user badge plus profile link on their name; claimed-but-not-vouched names display as plain text without the badge. There is no separate "pending" UI tier.

## Goal

Land the frontend surface that lets users:

1. See the vouched-vs-claimed status of each author on a paper-detail page (badge presence is the only display distinction).
2. Discover papers they are claimed-pending on and accept them.
3. Resign from a paper they are currently vouched on (and disclaim a claimed-pending listing they don't want).
4. Get migration-day awareness when their existing vouched status flips to claimed-pending under the new rules.

## Acceptance

### 1. Paper-detail author display

For each entry in the displayed authors list on `/papers/:author/:permlink`:

- **Vouched authors**: show their `name` plus a PEvO user badge; the name is a link to their PEvO profile.
- **Claimed-but-not-vouched authors** (in `pevo.authors[].hive` but no valid `author_accept`, OR `hive: null` bridge-paper credits): show their `name` as plain text, no badge, no profile link.

No separate "pending" affordance, no italicized state, no per-paper banner for pending entries. The badge is the only signal.

### 2. Accept affordance

When a logged-in user views a paper they are claimed-pending on (i.e., listed in `pevo.authors[]` without an active `author_accept`), surface a clear "Accept authorship of this paper" action on the paper-detail page (a button or panel that's only visible to that user). On click:

- **Self-custody users**: prompt Hive Keychain to sign the `author_accept` `custom_json` op; broadcast.
- **Light-account users**: route through the custody endpoint with a fresh-auth challenge appropriate to the user's auth mechanism (password re-prompt for password accounts, fresh ORCID OAuth for ORCID accounts; see `agents/docs/ARCHITECTURE.md` "Light-account signing of consent ops").

After successful broadcast, the page re-renders with the user's PEvO badge present (after backend cache invalidation completes; the spec commits to one-block staleness).

### 3. Resign / disclaim affordance

A user can broadcast `author_resign` for any paper they are listed in (vouched or claimed-pending). Place the affordance on the paper-detail page (a "..." menu or analogous secondary surface) only visible when the current user is in the paper's `pevo.authors[]`. On click, present a confirmation modal explaining consequences:

- For vouched users: loss of continuation-broadcast power, loss of citation credit going forward, retention of historical contribution record.
- For claimed-pending users: removal from the paper's display (you disclaim the listing).

After confirmation, broadcast `author_resign` (Keychain or custody, same paths as accept).

### 4. Migration-day awareness

On flag-day deploy, every existing multi-author co-author who has not yet broadcast `author_accept` lands in the claimed-pending state — they lose their PEvO badge on those papers until they accept. The UI MUST surface this transition once per affected user:

- A one-time banner on first login after the deploy, listing the affected papers with direct links to accept.
- The banner persists until the user has resolved (accept or disclaim) every affected listing.

The list of affected papers is sourced from the backend's `/api/me/authorships/pending` endpoint (see `backend-notification-infra-for-consent-ops`).

### 5. i18n

All new microcopy (the accept button label, resign confirmation modal, migration banner, etc.) must be added to `frontend/public/messages/*.json` keys, with English source updated and stub entries for other languages per the existing pattern.

### 6. Tests

- Unit tests for the badge-vs-no-badge author-display logic.
- E2E test covering the accept flow (Keychain signing path; light-account custody-fresh-auth path may be covered separately).
- E2E test covering the resign flow.
- Migration-banner test (mocks "user has N pending acceptances" state).

## Out of scope

- A separate "pending acceptance" UI tier — per the spec, badge-vs-no-badge is the only distinction.
- A dedicated `/me/authorships` page — the affordances live on paper-detail pages plus the migration banner.
- A real-time notification badge for new claimed-pending state — the migration-day banner is one-shot; ongoing additions are surfaced when the user navigates to the paper.
- The backend infrastructure for `/api/me/authorships/*` (filed separately as `backend-notification-infra-for-consent-ops`).
- The chain-layer rules for who can accept/resign (filed in `backend-coauthor-trust-model` Phase 2).

## Dependencies

- `backend-coauthor-trust-model` Phase 2 (custody endpoint accepts new action types; vouched-set computation is queryable; cache invalidation fires on consent ops).
- `backend-notification-infra-for-consent-ops` (the `/api/me/authorships/*` endpoints for the migration banner).

## Cross-references

- `agents/docs/ARCHITECTURE.md` section 2 "Multi-Author Trust Model" — canonical spec.
- `agents/docs/tasks/pending/backend-coauthor-trust-model.md` — Phase 2 chain-layer implementation.
- `agents/docs/tasks/pending/backend-notification-infra-for-consent-ops.md` — sibling backend task.
- `agents/docs/tasks/review/ui-coauthor-continuation-publishing.md` — adjacent UI work for co-author continuation publishing.

[BLOCKED by Backend] (2026-05-05) — Both named dependencies are still in `agents/docs/tasks/pending/`:
- `backend-coauthor-trust-model.md` — Phase 2 needs to land before the UI can call the custody endpoint with `author_accept`/`author_resign` action types, query the vouched-set, or rely on cache invalidation firing on consent ops.
- `backend-notification-infra-for-consent-ops.md` — the `/api/me/authorships/pending` endpoint is what the migration-day banner enumerates; without it, acceptance criterion #4 has no data source.

Without these, the UI surface has no working backend to broadcast consent ops through and no list of affected papers to render in the migration banner. Move back to `pending/` once both backend tasks archive (or once Phase 2 lands and the notification endpoint at minimum exposes the pending-authorships list).

## Architect coordination note 2026-06-09 — endpoint owner moved; migration premise obsolete; re-scope needed

The consented-authorship model was ratified (architect + user, 2026-06-09) and folded into tasks. Several references in this file are now stale. Flagging here rather than rewriting the body, because this task needs a proper re-scope before the UI agent picks it up:

- **Endpoint owner moved.** `backend-notification-infra-for-consent-ops` was superseded and **removed** 2026-06-09. The `/api/me/authorships/pending` endpoint — this file's criterion #4 data source, the "Out of scope" item, the dependency, and the cross-references all point at it — is now owned by **`backend-consented-set-read-surfaces`** (which also delivers the paper-detail consented badge). Repoint all five references there.
- **Migration-day premise is obsolete.** The decided model is **go-forward, no flag-day** (nothing live uses the consent ops). Goal #4 and acceptance #4 (the one-time migration banner) no longer apply — no existing co-author is demoted on a cutover. Drop the banner; keep the steady-state affordances.
- **Terminology:** "vouched" → "consented" throughout (the ratified rename; sense-3 only).
- **Two routes, not one.** This file covers only Route 2 (`author_accept`/`author_resign`). The settled model also has **Route 3 (name-only)**: a claimer's `claim_authorship` affordance and the paper author's `approve_authorship` affordance. Add both.
- **Stale block reason.** The `[BLOCKED by Backend]` note names `backend-coauthor-trust-model` (since archived) and `backend-notification-infra-for-consent-ops` (now removed) as "still in `pending/`". The real backend dependency is now **`backend-implement-consented-authorship-model`** (read-path consent wiring) + **`backend-consented-set-read-surfaces`** (endpoint + badge). Re-base the block on those.

Recommend a re-scope pass on this task (likely including a vouched→consented title/slug update) when the backend consent work nears landing. Left in `blocked/` pending that re-scope.
