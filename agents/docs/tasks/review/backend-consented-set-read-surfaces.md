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
- [Architect additions, 2026-06-11 review] `agents/docs/api-contracts/common.md` — add the new endpoint to the HAF-outage 503 retriable-emitter enumeration. Document the 503 code as `SERVICE_UNAVAILABLE` with `retriable: true` (the implementation; supersedes the KTD-3 paragraph's INTERNAL_ERROR wording above). Document `consented` absent-vs-false semantics (absent on summary surfaces, always present on detail) and the ORCID-anchored consented co-author case (annotation is hive-keyed, so a hive-less anchored slot shows `consented: false` even when its owner is cycle-credited) — the blocked UI consent task needs both facts.

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

---

## Architect re-review (2026-06-11) — HELD PENDING FIXES (3 items)

`/ce-code-review` fan-out on commit `2e66440f` (correctness + security + adversarial on the session model; testing/maintainability/project-standards/performance/reliability/api-contract + learnings on Sonnet; ce-agent-native skipped per PEvO; validators on the surviving items). **The surfaces are verified sound**: real `verifyHiveSignature` on every /api/me route with the 401 firing before any chain/HAF read and the response scoped solely to the lowercased authenticated username; every seed-CTE value bound positionally (no payload interpolation); the annotation builds a copy (cached objects never mutated; the badge can never land in the stable tier); the null sentinel is genuinely never cached (getOrSet null-skip) and the per-tier epoch guard suppresses the in-flight stale write-back; fail-closed 503 holds on pool-null and transient-error paths on both surfaces, with non-retriable errors correctly routed to the central 500 handler; Redis-down degrades to the in-memory tier; the 30s volatile TTL backstops a stalled block watcher; cache keys get the appTag prefix from the hafCache constructor; carve-out headers satisfy clauses (a)/(b)/(c); commit hygiene and zone discipline clean. Three items before archive (user-triaged):

1. (P2, performance + adversarial corroborated, conf 100) **Bound the `naming_posts` seed in `composePendingConsentsQuery`.** The seed scans all PEvO top-level posts for ops naming the user with NO LIMIT on `naming_posts` / `pending_seed`. Any Hive account can spam-name a victim across many posts, driving the victim's own pending query into the 30s statement_timeout on every request (re-fired each ~3s volatile clear): a permanent 503 for that user plus HAF-pool (max 3 connections) monopolization affecting every HAF-backed route. Add a LIMIT on the seed (newest-first; exact cap implementer's choice, e.g. 500 naming posts) and document it in the composer docblock as a spam-defense bound with the over-cap semantics stated: truncated-but-served (the seed is a candidate superset feeding the authoritative down-walk, not the authoritative record), not fail-closed.
2. (P2, maintainability, conf 100) **Stale "no read path applies it yet" comment in papers.ts.** The cumulative-union helper comment ("The `computeConsentedAuthors` primitive exists / but no read path applies it yet (membership-only reconstruction)") was true before this commit and is false after it added `fetchConsentedAccountsForPaper`. Reword to distinguish the wired SQL read path (`fetchConsentedAccountsForPaper` / `annotateAuthorsWithConsent`) from the still-unwired JS primitive; keep the still-accurate membership-only observation about the union itself.
3. (P3, testing, validator-confirmed) **Pin the `?version=N` branch's fail-closed guard.** That branch has its own `annotated === null` to 503 guard, separate from the base branch's (which IS tested). No test simulates HAF-down on the version branch, and deleting its guard yields 200 with `data: null` on a fully green suite (`sendOk` serializes null without complaint). Add: warm the version cache for a multi-author paper, set the pool null and clear volatile, GET with `?version=1`, assert 503 retriable.

Dismissed/no-action at triage: the single-author short-circuit negative boundary (the existing positive test catches the equality-flip mutation); pending-list naming spam as a model property (inherent to discovery semantics; item 1 bounds the cost half); the `pending_seed` malformed-continues root admission vs the cycle's `continues IS NULL` credit gate (P3 design-alignment residual, recorded for the hive-schemas § 2.9 doc pass).

When the three items land, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commits. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend re-review signal (2026-06-11, single fix commit on main)

All three hold items landed:

1. **`naming_posts` seed bounded** — `NAMING_POSTS_SEED_CAP = 500` (module constant in `routes/me.ts` with a spam-defense docblock), applied as `ORDER BY c.created DESC LIMIT 500` on the seed CTE. Over-cap semantics documented at the constant and in the composer docblock: truncated-but-served (the seed is a candidate superset feeding the authoritative down-walk), never fail-closed. The real-postgres FROM-redirect corpus (`syn_comments`) gained the `created timestamptz` column the real comments view carries (the redirected relation previously had no column to order on); a corpus comment notes why equal timestamps are fine there.
2. **Stale comment reworded** (`papers.ts` cumulative-union site) — now distinguishes the wired SQL read path (`fetchConsentedAccountsForPaper` / `annotateAuthorsWithConsent`) from the still-unwired JS `computeConsentedAuthors` primitive; the membership-only observation about the union itself is kept.
3. **`?version=N` fail-closed guard pinned** — new test in `tests/routes/papers-consented-badge.test.ts`: warms the version cache for a multi-author paper, drops the pool and clears volatile, asserts 503 `SERVICE_UNAVAILABLE` `{retriable: true}` on `?version=1` (the test comment records the mutation it kills: deleting the version branch's annotated-null guard serves 200 with a null payload).

Verification: papers-consented-badge (7), me-authorships-pending (6), me-pending-authorships-real-postgres (9) all green; `npm run typecheck` (src+tests) clean; `npm run lint` clean except the known pre-existing `author-supersession.ts` warning.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Architect re-review (2026-06-12) — HELD PENDING FIXES (round 2, 2 items)

`/ce-code-review` fan-out on fix commit `c89f4f14` (correctness + adversarial on the session model; testing/maintainability/project-standards + learnings on Sonnet; ce-agent-native skipped per PEvO). All three round-1 items verified landed: the seed cap is semantically correct (ORDER BY applies over the full filtered set before LIMIT inside the non-recursive CTE member; `created` is a real comments-view column; newest-first bias documented; the constant is single-sourced into the SQL with no drift surface; truncation can only omit pending entries, never fabricate, because the authoritative down-walk re-derives admission); the version-branch 503 pin genuinely exercises the version branch's own guard (the stable detail entry survives clearVolatile while the volatile consent entry drops; deleting the guard reaches sendOk(res, null) and fails red); the comment reword is factually accurate. Adversarial confirmed the cap bounds the down-walk as intended; the residual pre-LIMIT seed-scan cost is the pre-existing class and the silent-truncation property is the documented truncated-but-served design accepted at round-1 triage. Two items before archive (user-triaged):

1. (P2, correctness + testing corroborated + the behavior-change-coverage-gap convention, conf 100) **The cap's truncation behavior has zero coverage.** The real-postgres corpus is ~15 rows against cap 500, so the LIMIT never fires anywhere in the suite: deleting the LIMIT line, flipping DESC to ASC (evicting the newest instead of the oldest), or changing 500 to 5 all pass green — the deleted-LIMIT mutant silently reverts the spam defense this round added. The cap is behavior introduced by the fix commit, which puts it on the reportable side of the preemptive-hardening line. Fix: make the cap injectable (or export it for the test to override) and add a FROM-redirect case at a tiny cap (e.g. 2) with distinct `created` values, asserting the oldest naming post falls out of pending discovery while the newest survives — pinning both the LIMIT's existence and the ORDER BY direction.
2. (P3, maintainability + independent validator, conf 75) **The reworded papers.ts comment re-introduces the temporal rot class round 1 fixed.** "JS `computeConsentedAuthors` primitive remains unwired into any read path" (the cumulative-union site) is a coordination-state claim about every other file in the codebase; it silently rots the moment the primitive is wired or removed (the blocked chain-helper extraction task makes churn there plausible). Fix: reword to the in-file-verifiable form, e.g. "The JS `computeConsentedAuthors` primitive (`consent-ops.ts`) is not imported here; this site uses the SQL-side path exclusively." — checkable against this file's import list without codebase-wide knowledge.

When both items land, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commits. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend re-review signal (2026-06-12, single fix commit on main) — round-2 items 1-2 landed

1. **Seed-cap truncation coverage.** `composePendingConsentsQuery` now takes `namingPostsSeedCap` (default `NAMING_POSTS_SEED_CAP`), documented as a test-injection seam; the production route composes with the default. New coverage in `me-pending-authorships-real-postgres.test.ts`: a CAP_PAPERS corpus (three roots naming capuser, explicit distinct `created` values at 3/2/1 days old, unlike the DEFAULT-now() main corpus), an uncapped baseline (all three pending), a binding-cap-2 truncation case (the oldest naming post falls out of discovery, the two newest survive — pinning the LIMIT's existence AND its newest-first direction), and a composition-shape pin that the default-composed SQL carries `LIMIT 500` (kills a silent default change, which the injected-cap case cannot observe).

   Mutation probes performed against the committed fix (mutate, run, red, restore via `git checkout`, green), per `tests-must-fail-on-mutation-of-code-under-test`: LIMIT-line deletion turned the truncation case AND the shape pin red (2 failed / 12); `ORDER BY c.created DESC` flipped to `ASC` turned exactly the truncation case red (received rows kept the oldest and dropped the newest); default `500` changed to `5` turned exactly the shape pin red. Post-restoration run: 12/12 green. Confirmed the specs fail on mutation of the naming_posts seed LIMIT, its ORDER BY direction, and the `NAMING_POSTS_SEED_CAP` default.

2. **papers.ts comment reworded to the in-file-verifiable form.** The cumulative-union site now reads: the JS `computeConsentedAuthors` primitive (`consent-ops.ts`) is not imported here; this site uses the SQL-side path exclusively. The codebase-wide "remains unwired into any read path" claim is gone; the membership-only observation about the union is untouched.

Verification: `npm run typecheck` (src+tests) clean; `npm run lint` clean except the known pre-existing `author-supersession.ts` warning; `me-pending-authorships-real-postgres` (12) + `me-authorships-pending` (6) green.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
