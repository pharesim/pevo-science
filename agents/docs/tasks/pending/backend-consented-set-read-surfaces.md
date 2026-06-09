# BACKEND-CONSENTED-SET-READ-SURFACES — consented badge on paper-detail + `GET /api/me/authorships/pending`

**Owner:** backend
**Created:** 2026-06-09 (split from `backend-implement-consented-authorship-model` during the 2026-06-09 ratification)
**Priority:** P2 (user-facing consent surfaces; gated on the core credit migration)

## Problem

The consent model has no read surfaces: no `consented` flag on paper-detail authors, no discovery endpoint for "papers awaiting my consent". Both must consume the **same** consented-set resolution the reputation cycle uses (single source of truth — no cycle-vs-read drift), and both must be fail-closed so a HAF flap never silently demotes legit co-authors to claimed-only.

## Dependency

**Depends on `backend-implement-consented-authorship-model` U1** — the shared `consentedAuthorsCteBody` (the recursive chain-author CTE + Route-2 resolution) and the KTD-3 `{ status: 'ok' | 'haf_unavailable' }` discriminated union. Do not start until U1's resolution exists; both surfaces call it.

## Read-path policy (both surfaces)
- **At-most-one-block-stale, O(1)/request:** call the consented resolution once per request, not per chain hop.
- **Cache tier — volatile (KTD-2):** mirror the existing claims cache `getOrSet` but with `stable: false`. `block-watcher.ts` calls `hafCache.clearVolatile()` every block (~3s), so a volatile entry is dropped each tick — satisfies both "at-most-one-block-stale" and "invalidate on every consent op" with the lowest surface area (no per-op invalidation wiring across the five op paths). Cache keys include the version dimension (e.g. `paper-detail:{a}:{p}` AND `:v{N}`).
- **Fail-closed (KTD-3):** map `haf_unavailable` → 503 INTERNAL_ERROR; resolve the sentinel OUTSIDE `getOrSet` (never cache the failure). Short-circuit the consent fetch for inert cases (single-author / bridge papers) so fail-closed is bounded to genuinely multi-author papers.

## U4 — Consented badge on paper-detail
- `backend/src/routes/papers.ts`: after `cumulativeAuthors` is built (the chain-walk annotation point), call the U1 consented resolution once, derive `claimedAuthors` + `firstClaimBlockByAuthor` from the chain walk, and annotate each author entry with `consented` keyed on lowercased `hive`. Apply to all three branches: the cumulative-authors path, the single-post path, and the `?version=N` path.
- **Tests:** consented co-author → `consented: true`; claimed-but-not-consented → `consented: false`; single-author paper → root broadcaster `consented: true`, no consent query fired (short-circuit); bridge paper → bridge account consented, hive-less credits `consented: false`, short-circuit; HAF down on a multi-author paper → 503 (NOT a degraded root-only badge); a consent op at block N reflected by block N+1 (volatile drop); `?version=N` and single-post branches carry the same annotation.

## U5 — `GET /api/me/authorships/pending`
- **This task is THE owner of the endpoint.** The prior `backend-notification-infra-for-consent-ops` task (which scoped a `/api/me/authorships/pending` endpoint around the now-obsolete flag-day model and a Route-2-only shape) was superseded by this task and removed 2026-06-09. Build the endpoint here, once, in the two-route shape below.
- A claimer-scoped discovery surface: name-only slots awaiting the user's `claim`/approval (Route 3) and anchored slots awaiting the user's `author_accept` (Route 2).
- `backend/src/routes/me.ts` mounted `app.use('/api/me', …)` (or add to `profile.ts`, already mounted and already imports the claimer-scoped builder), auth via `verifyHiveSignature` (the user proving they are `username` — real middleware, this surface IS auth-focused).
- Reuse `authorshipClaimsCteBody(idx, { claimer: username })` selecting `status='pending'` for Route-3 pending claims; add the Route-2 "anchored slots where you're eligible but haven't accepted" query (slots whose `hive` == you or `orcid` == your attested ORCID across papers you're named on, minus papers you've already accepted/resigned). Fail-closed → 503.
- **Tests:** returns the user's pending name-only claims (Route 3) across papers; returns anchored slots awaiting the user's accept (Route 2), excluding already-accepted/resigned; excludes accepted/revoked claims; 401 without a valid signature (auth gate runs real per CLAUDE.md "Running Tests"); HAF down → 503.

## [TODO Architect] doc reconciliation (architect-owned; backend files this note, does NOT edit these)
- `agents/docs/api-contracts/papers.md` — document the `consented` field on paper-detail author entries.
- `agents/docs/api-contracts/<misc|profile>.md` — document `GET /api/me/authorships/pending` (request auth, response shape, 503 fail-closed).

## Acceptance
- Each paper-detail author carries a `consented` flag, single-sourced from the same resolution the cycle uses.
- `GET /api/me/authorships/pending` returns the user's Route-2 + Route-3 pending slots; 401 unauthenticated; 503 on HAF unavailable.
- Both surfaces fail-closed (503, never a degraded root-only result) and are at-most-one-block-stale.
- Single-author / bridge papers short-circuit the consent fetch.
- `[TODO Architect]` api-contract handoff note filed before the task moves to `review/`.
- Comment anchors on stable symbols; `npm run typecheck` + `npm run lint` clean; auth-gate tests run real `verifyHiveSignature`.

## Cross-references
- `backend-implement-consented-authorship-model` (U1 shared CTE — hard dependency).
- `ui-multi-author-consent-affordances` (blocked — the UI that consumes these surfaces).
- `backend/src/routes/papers.ts` (paper-detail annotation), `backend/src/app.ts` (route mount), `backend/src/hafsql.ts` (`authorshipClaimsCteBody`), `backend/src/lib/cache` (`getOrSet` volatile tier), `backend/src/block-watcher.ts` (`clearVolatile`).
