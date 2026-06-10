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

## Implementation note (backend, 2026-06-10)

Both surfaces landed. Design choice worth flagging up front: **both consume the SQL twin** (`consentChainCteBody` + `consentedAuthorsCteBody`, the exact stack the reputation cycle composes), not the JS `consent-ops.ts` primitives. The task's U4 sketch ("derive claimedAuthors + firstClaimBlockByAuthor from the chain walk") presumed the JS route; the SQL twin satisfies the single-source acceptance more directly (zero cycle-vs-read drift by construction, no JS-side slot-derivation to keep in lockstep) and works uniformly on all detail branches including single-post (which has no JS chain walk in scope).

**U4 (consented badge), `backend/src/routes/papers.ts`:**
- `fetchConsentedAccountsForPaper` composes `buildRecursiveWith(activeAccreditationsCteBody, consentChainCteBody({paperAuthor,paperPermlink}), consentedAuthorsCteBody())` and selects `consented_authors.account`. Returns `string[]` (a Set does not survive the Redis JSON round-trip), null on pool-null, throws `HafQueryError` on query failure.
- `annotateAuthorsWithConsent` runs at the route convergence points (both the `?version=N` and the base branch, which the single-post / cumulative / metadata-restored shapes share), per request, OUTSIDE the stable 30-min `paper-detail:*` cache entries — the detail payload keeps its stable tier while the badge resolves through a separate `consented-authors:{a}:{p}` VOLATILE entry (dropped by `block-watcher.ts` `clearVolatile()` each block; at-most-one-block-stale; KTD-2). It returns a response copy (the in-memory cache tier shares the object reference). Annotation keys on `normalizeHiveAccount(entry.hive)`; hive-less entries are never `consented: true`.
- Short-circuits (no consent query): bridge papers (`isPevoBridgePaper`; entries flagged true only if `hive` is the bridge account) and single-author papers whose sole entry is the root broadcaster (Route-1 implicit consent). The single-author short-circuit will not reflect a root self-resign while the paper stays sole-root; the cycle remains authoritative for credit (residual noted in the helper docblock).
- Fail-closed (KTD-3): pool-null → null → 503 `SERVICE_UNAVAILABLE` `{retriable:true}` at the route, never cached (getOrSet null-skip); query failure → `HafQueryError` → the route's existing retriable-503 translation. Never a degraded root-only badge.
- `consented?: boolean` added to `PaperAuthor` (`types/domain.ts`); the `consented-authors:` prefix added to the POST `/:author/:permlink/invalidate` flush list.

**U5 (`GET /api/me/authorships/pending`), new `backend/src/routes/me.ts` + `app.ts` mount:**
- Mounted `app.use('/api/me', readLimiter, meRouter)` before the `/api` 404 catch-all. Auth via REAL `verifyHiveSignature` per-route; the response is scoped to `req.hiveUsername` (no path param to cross-check). Response: `{ pending_claims: [{paper_author, paper_permlink, author_index, claimed_at}], pending_consents: [{paper_author, paper_permlink}] }`.
- Route 3 (`composePendingClaimsQuery`): claimer-scoped `authorshipClaimsCteBody`, `status = 'pending'`.
- Route 2 (`composePendingConsentsQuery`): hand-composed `WITH RECURSIVE` in the reputation cycle's splicing style — custom seed CTEs (`my_attested_orcid` from `active_accreditations`; `naming_posts` = PEvO top-level posts any of whose historical ops name the user's hive or attested ORCID, append-only ops-union; `seed_walk`/`pending_seed` = upward `continues` walk to chain roots, 50-hop cap) feeding `consentChainCteBody({rootsFromCte:'pending_seed'})` + `consentedAuthorsCteBody({signers:[me]})`, final select = `consent_signer_eligibility` minus the user's `route2_latest` rows minus own-root papers. The seed is a candidate superset; the authoritative down-walk re-derives admission/canonical-path/slots (orphaned-fork naming posts yield no eligibility). An invalid Rule-6 pre-claim accept does NOT clear a slot from pending (route2_stream never admits it); accepted, resigned, and revoked users are all cleared.
- Both composers are exported for the FROM-redirect regression; both fetchers return null on pool-null (sentinel resolved at the route, never cached) and the response is cached volatile per-user (`me:authorships-pending:{username}`).

**Tests (all green):**
- `tests/me-pending-authorships-real-postgres.test.ts` (9) — both composers run verbatim on a real planner via the FROM-redirect technique against a tailored corpus: continuation-named slot resolved through the seed up-walk, orphaned-fork exclusion, attested-ORCID anchoring, Rule-6 invalid accept stays pending, accepted/resigned/revoked cleared, own-root + unanchored excluded, claimer-scoped pending claims with approved/revoked excluded. (Corpus note: approval/revocation resolve per `(claimer, paper)` in `authorship_claims` — the revoke wire payload carries no `author_index` — so distinct status cases use distinct claimers.)
- `tests/routes/me-authorships-pending.test.ts` (6) — REAL `verifyHiveSignature` against signed requests (deterministic keypair, mocked `getAccounts` chain read): 200 both lists, 401 missing headers (no chain read, no HAF query), 401 unpublished key, 503 pool-null `{retriable:true}`, 503 transient query failure, pool-null sentinel not cached (immediate recovery).
- `tests/routes/papers-consented-badge.test.ts` (6) — consented/claimed-only/hive-less flags; single-author and bridge short-circuits pinned as "no consent SQL fired"; HAF-down-with-warm-detail-cache → 503 (proves per-request annotation outside the stable entry); consent op reflected on the next volatile drop (block N+1) and NOT before; `?version=N` branch annotated.
- Regression: papers-canonical-orcid-resolution, bridge-paper-author-gate, continuation-author-gate, papers-cumulative-orcid-audit, canonical-root-walker, papers-haf-error-vs-not-found, consented-authors-cte-real-postgres, claims (168 across 8 files) + real-HAF `papers.test.ts` + `app-not-found` (20+1 skipped) — all green. `npm run typecheck` + `npm run lint` clean (one known pre-existing `author-supersession.ts` warning).
