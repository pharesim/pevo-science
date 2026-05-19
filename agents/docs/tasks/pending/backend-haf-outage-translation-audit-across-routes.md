# BACKEND-HAF-OUTAGE-TRANSLATION-AUDIT-ACROSS-ROUTES — extend `HafQueryError` / 503-retriable pattern to all HAF-touching routes

**Owner:** Backend Agent
**Created:** 2026-05-19 (architect, surfaced by combined `/ce-code-review` of `backend-profile-papers-supersession-parity` round-2 — cross-corroborated by correctness, adversarial, reliability)
**Priority:** P2

## Problem

`backend-profile-papers-supersession-parity` round-2 (commit `a419b1d`) extended the `HafQueryError` translation + 503-retriable response pattern to one HAF-touching site on `/api/profile/:username/papers` (the `getAccreditedOrcidsByAccount` fetch inside the `hafCache.getOrSet` callback). The architect's hold scoped item 3 narrowly; backend's signal block explicitly flagged the asymmetry as a follow-up: *"The enrichment also makes HAF queries (`getAccreditedSet`, `getAllAccreditedAccounts`, `getReputationScores`). Those don't currently throw `HafQueryError` directly, so if they fail with a raw pg error, the central 500 handler still picks them up. Tightening those to also translate to `HafQueryError` is a separate follow-up..."*

Cluster review surfaced the asymmetry as three different observable responses on the same `/api/profile/:username/papers` route during a HAF outage, depending on which sub-query fails first:

| Site | Pre-fix | Post-fix | Failure response |
|---|---|---|---|
| `getAccreditedOrcidsByAccount` (cache-miss callback) | raw error → 500 | wrapped → `HafQueryError` → 503 retriable | **503 retriable** ✓ |
| `fetchUserPapersFromHaf` (internal try/catch swallows → null) | unchanged | unchanged | **200 OK with empty rows** ✗ |
| `getAllAccreditedAccounts` (enrichment Promise.all) | raw pg → 500 | unchanged | **500 INTERNAL_ERROR** ✗ |

The asymmetry isn't unique to `/api/profile/:username/papers` — it's likely systemic across PEvO's HAF-touching routes. Each route's error-translation patchwork evolved organically and the existing sibling-route consistency stops at "central error middleware emits 500 by default."

## Goal

Audit all HAF-touching routes for `HafQueryError` translation coverage; ensure each HAF query (direct or via helper) maps a runtime failure to `HafQueryError` so the central error middleware emits the consistent 503 SERVICE_UNAVAILABLE with `retriable: true` envelope. Frontend SPA's retry logic keys on `error.code === 'SERVICE_UNAVAILABLE'` + `details.retriable`; the asymmetry breaks retry behavior and operator triage signal.

## Acceptance

1. **Discovery audit** — enumerate every HAF-touching site across `backend/src/routes/` + `backend/src/lib/` + `backend/src/accreditation.ts`. Catalog per-site behavior:
   - Site (file:function)
   - Failure-throw shape today (raw pg error / `HafQueryError` / swallowed-to-null / wrapped-in-other-error-class)
   - Response shape today on failure (500 / 200-with-empty / 503 / etc.)
   - Whether translation to `HafQueryError` is appropriate or whether the swallow-to-empty pattern is intentional (e.g., for fetch-many endpoints where missing data is normal).

2. **Translation pattern documentation** — write a `agents/docs/solutions/conventions/haf-error-translation-pattern.md` (or similar) capturing the prescribed shape:
   - Where to wrap (immediately around the pg-throw site, or at the route handler boundary)
   - When to swallow-to-empty vs translate-to-503 (criteria)
   - How the central error middleware consumes `HafQueryError` and emits the wire envelope

3. **Code remediation** — apply the pattern to all sites the discovery audit flagged as inconsistent. Preserve intentional swallow-to-empty behavior where it's the correct contract (e.g., a "papers by user" query returning empty rows for a non-existent user is correct, not a HAF outage).

4. **Tests per touched route** — add a HAF-outage canary per route that mocks pg rejection at the HAF query and asserts 503 retriable response shape. Use the established mocked-pool carve-out per CLAUDE.md "Running Tests" carve-out.

5. **Mutation-kill verification** — each new canary should fail red if the corresponding try/catch is reverted.

## Out of scope

- Frontend SPA retry-logic changes. Today's SPA keys on `details.retriable` correctly; this task just ensures the backend emits the signal consistently.
- Circuit-breaker / backoff infrastructure. HAF outages are typically operator-resolved (HAF node restart, network restoration); per-route 503 retriable is the right wire contract for the SPA-side retry without server-side breaker work.
- `getReputationScores` and similar long-cache helpers that have their own degraded-mode behavior (returning last-known cached values when HAF is unavailable). Those are intentional behavior, not regressions.

## Cross-references

- Cluster review 2026-05-19 (architect-context): correctness low/70 + adversarial F3 medium/85 + reliability R1 medium/85 + R2 low/75 = cross-corroborated.
- `backend-profile-papers-supersession-parity.md` round-2 (commit `a419b1d`) — established the pattern at one site.
- `backend/src/db.ts` — `HafQueryError` definition.
- `backend/src/routes/papers.ts` — sibling route emitting 503 retriable for HAF outages on `/api/papers/:author/:permlink` (the template for the pattern).
- `backend/src/routes/profile.ts` — the route round-2 partially closed.
