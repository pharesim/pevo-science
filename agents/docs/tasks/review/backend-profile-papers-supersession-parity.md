# BACKEND-PROFILE-PAPERS-SUPERSESSION-PARITY — extend supersession projection to /api/profile/:username/papers

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by round-1 `/ce-code-review` of `backend-papers-canonical-orcid-resolution` — cross-surface parity finding corroborated by maintainability + ce-learnings-researcher)
**Priority:** P2
**Parent task:** `agents/docs/tasks-archive.md` (search `backend-papers-canonical-orcid-resolution` once archived) — round-1 added `orcid_verified` + `orcid_discrepancy` to `/api/papers` (list) and `/api/papers/:author/:permlink` (detail) but did NOT extend the projection to `/api/profile/:username/papers`. Follow-up filed at user triage 2026-05-16.

## Problem

`backend-papers-canonical-orcid-resolution` added the supersession projection (`orcid_verified` + `orcid_discrepancy` per `authors[i]`) to two paper-emitting endpoints but missed a third: `/api/profile/:username/papers` (route in `backend/src/routes/profile.ts:279`, builds rows via `fetchUserPapersFromHaf` → `toPaperSummary` in `backend/src/helpers.ts:319-333`).

`toPaperSummary` currently emits `authors: (pevo.authors as PaperSummary['authors']) || []` — the raw chain authors[] with no supersession lookup. A UI component or AGPL integrator consuming `/api/profile/:username/papers` receives `undefined` for both `orcid_verified` and `orcid_discrepancy` on every author entry, while the same paper viewed via `/api/papers` or `/api/papers/:author/:permlink` carries the fields.

Same-paper-different-shape across sibling endpoints is a cross-surface parity break per `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`.

## Why the parent task scoped this out

The supersession helpers `computeSupersession` and `applyAuthorSupersession` live module-private in `backend/src/routes/papers.ts` (lines 263-302). They were not extracted to `lib/` during round-1 because the implementer's focus was the two papers endpoints. Extending to profile requires moving the helpers to a shared lib module first, then importing from `helpers.ts` (which is itself imported by `profile.ts` via the `toPaperSummary` consumer).

Folding the profile-papers fix into the round-1 task would have widened scope significantly and delayed the round-1 deliverable. Architect triage filed this as a focused follow-up.

## Goal

Extend the supersession projection (`orcid_verified` + `orcid_discrepancy` per `authors[i]`) to `/api/profile/:username/papers` responses, with the same field semantics as `/api/papers` and `/api/papers/:author/:permlink`.

## Acceptance

1. **Extract `computeSupersession` and `applyAuthorSupersession` to a shared lib module.** New file `backend/src/lib/author-supersession.ts` (or `backend/src/author-supersession.ts` if the codebase prefers flat `src/`). Move both helpers from `routes/papers.ts:263-302` with their JSDoc. Re-export from the lib; update the original `routes/papers.ts` call sites to import from the new module. No behavior change to the existing two endpoints.

2. **Apply supersession in `toPaperSummary`.** Modify `backend/src/helpers.ts:toPaperSummary` to accept an optional `orcidMap?: Map<string, string | null>` parameter. When provided, apply `applyAuthorSupersession(authors, orcidMap)` to the projected authors[]. When absent (legacy callers that don't supply the map), authors[] is emitted raw — backwards-compatible.

3. **Wire `getAccreditedOrcidsByAccount` into the profile-papers route.** In `backend/src/routes/profile.ts` (the `/api/profile/:username/papers` handler that calls `fetchUserPapersFromHaf` + maps via `toPaperSummary`), fetch the orcid map post-query via `getAccreditedOrcidsByAccount()` (the same call the round-1 `papers.ts` fallback paths use) and pass to `toPaperSummary(post, orcidMap)`. The orcid map is small and cached (10-min TTL per `backend/src/accreditation.ts`); fetching it once per request is fine.

4. **Profile-papers SQL projection (optional, performance-driven).** The list endpoint (`/api/papers`) uses SQL-side projection via `authorsWithSupersessionSelect`. The profile-papers route could similarly add a SQL-side projection for parity — but only if the cost of JS-side mapping per request becomes measurable. Round-1 of THIS task: JS-side via the helper extraction in items 1-3 above. If performance becomes a concern, file a separate round-2 task for SQL-side migration.

5. **Affiliation field rule.** PaperSummary (which `/api/profile/:username/papers` emits) does NOT carry `affiliation` per the contract. The JS-side `applyAuthorSupersession` spread (`{ ...e, ...supersession }`) preserves all chain fields including any `affiliation` the publisher typed. The parent task's hold item #3 addresses this for SQL-projected PaperSummary via `includeAffiliation` parameterization; the JS path here MUST behave identically (strip affiliation from PaperSummary). Either: (a) the JS helper accepts an `includeAffiliation` flag mirroring the SQL helper's parameter and explicitly excludes affiliation when false; OR (b) `toPaperSummary` post-strips affiliation after `applyAuthorSupersession` returns (since `toPaperSummary` is PaperSummary-specific, this is the natural site). Implementer's choice; the parity invariant is that PaperSummary `authors[i]` from this route does NOT contain `affiliation`.

6. **Tests.** Add a new test file `backend/tests/routes/profile-papers-supersession.test.ts` (or extend an existing profile-papers test if one exists) with the canonical 4-case matrix:
   - hive empty/absent → `orcid_verified=null, orcid_discrepancy=false`
   - hive set + not accredited → `orcid_verified=null, orcid_discrepancy=false`
   - hive accredited + accreditation orcid null → `orcid_verified=null, orcid_discrepancy=false`
   - hive accredited + accreditation orcid non-null + chain orcid differs → `orcid_verified=<aa.orcid>, orcid_discrepancy=true`
   - Case 4b companion: chain orcid matches attestation → `orcid_verified=<aa.orcid>, orcid_discrepancy=false`
   Plus a negative-control canary asserting PaperSummary `authors[i]` does NOT contain `affiliation`.

   Mocked-pool per the CLAUDE.md carve-out (clauses a/b/c documented in file header); real-path companion is the sister coverage at `papers.test.ts` + the unit-tested pure helpers in the shared lib module.

## Cross-references

- `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` — the convention this task implements
- `agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md` — semantics of `active_accreditations` (inherited via `getAccreditedOrcidsByAccount`)
- `agents/docs/api-contracts/papers.md` — PaperSummary schema; the `orcid_verified`/`orcid_discrepancy` field documentation (including the 30-min cache-staleness note and continuation-chain caveat) applies identically to profile-papers
- `backend/src/routes/papers.ts:263-302` — current home of `computeSupersession` + `applyAuthorSupersession` (to be moved)
- `backend/src/routes/papers.ts:2384, 2421` — sibling fallback-path call sites that already use `applyAuthorSupersession` via `getAccreditedOrcidsByAccount` (the template for profile.ts wiring)
- `backend/src/helpers.ts:319-333` — `toPaperSummary` (the consumer that needs the optional orcidMap parameter)
- `backend/src/routes/profile.ts:279` — the `/api/profile/:username/papers` handler

## Out of scope

- SQL-side projection migration for profile-papers (deferred to a possible round-2 if perf becomes a concern; round-1 here is JS-side via the helper extraction)
- Other endpoints emitting paper-shaped responses (search results — search.ts; user-reviews — should NOT carry supersession since reviews are not papers)
- Reputation-algorithm changes (supersession is display-only per `reputation-algorithm.md` § "ORCID-keyed Aggregations")

## Backend implementation signal (2026-05-17, round-1 — working tree of this commit)

All 6 acceptance items land in this single commit alongside the signal block + the `git mv` from `tasks/pending/` to `tasks/review/`.

### Implementation summary

1. **A1 — Helper extraction** (`backend/src/lib/author-supersession.ts`, new file). Moved `canonicalHiveKey`, `computeSupersession`, and `applyAuthorSupersession` from `routes/papers.ts` to the new shared lib module with their JSDocs preserved. The papers route now imports them from `'../lib/author-supersession.js'`. The unit-test imports in `papers-canonical-orcid-resolution.test.ts` were updated to point at the lib module (the only consumer of the named exports today). Module-level docstring explains the shared-lib's role and pins the cross-surface parity contract with the SQL helper.

2. **A2 — `toPaperSummary` orcidMap parameter** (`backend/src/helpers.ts`). Added optional `orcidMap?: Map<string, string | null>` parameter. When provided, the chain `pevo.authors` array runs through `applyAuthorSupersession` before being assigned to the response. Backwards-compatible: legacy callers that don't pass the map see authors passed through (no supersession projection, fields are absent rather than null — they default to "no claim" in consumer code).

3. **A3 — Route wiring** (`backend/src/routes/profile.ts`). The `/api/profile/:username/papers` handler now fetches the accreditation orcid map via `getAccreditedOrcidsByAccount()` inside the `hafCache.getOrSet` callback. The map is passed through `fetchUserPapersFromHaf(..., orcidMap)` into `toPaperSummary(..., orcidMap)`. The 30-min cache staleness applies to `orcid_verified`/`orcid_discrepancy` here for the same reason it applies on `/api/papers` (architect's round-1 contract-doc note on cache staleness). `getAccreditedOrcidsByAccount` is itself 10-min cached so cold-cache requests pay one cheap accreditation fetch.

4. **A4 — SQL-side projection migration**: NOT done in this round, per the task's explicit "round-1 is JS-side" scope. A future task can revisit if perf becomes a concern; the helper extraction in A1 makes both paths share the same source of truth.

5. **A5 — Affiliation strip**: Chose option (b) — post-strip in `toPaperSummary`. The helper preserves all chain fields (so PaperDetail consumers via the routes/papers.ts fallbacks reuse it unchanged); `toPaperSummary` strips `affiliation` after supersession returns, honoring the PaperSummary contract. Mirrors the SQL-side `includeAffiliation:false` default that round-1 landed at `authorsWithSupersessionSelect`. Existing callers without an orcidMap also get affiliation stripped — consistent with the PaperSummary contract regardless of whether supersession is wired.

6. **A6 — Tests** (`backend/tests/routes/profile-papers-supersession.test.ts`, new file, 8 tests).
   - Case 1: hive empty/absent → both fields per the case-1 collapse.
   - Case 2: hive set + not accredited → both fields null/false.
   - Case 3: hive accredited + null attestation → both fields null/false.
   - Case 4: hive accredited + differing attestation → `orcid_verified` populated, `orcid_discrepancy=true`.
   - Case 4b: chain matches attestation → `orcid_verified` populated, `orcid_discrepancy=false`.
   - Mixed-case hive parity: `{hive: 'Alice'}` resolves to lowercase accreditation entry — exercises the cross-path `canonicalHiveKey` parity contract.
   - PaperSummary affiliation strip: an `authors[i]` carrying `affiliation: 'Sorbonne'` from chain MUST NOT carry `affiliation` in the response.
   - Empty accreditation map (degraded HAF): fields populate with documented "no claim" defaults, not absence.

Mocked-pool per the CLAUDE.md "Running Tests" carve-out — file header documents clauses (a) (deterministic 4-case matrix is impractical against live HAF), (b) (`verifyHiveSignature` not mocked; public GET surface), and (c) (real-path companions at `papers.test.ts` for live HAF integration + `papers-canonical-orcid-resolution.test.ts` for sibling-route mocked-pool coverage + the helper unit tests that exercise the shared lib directly).

### Verification

- `npm run typecheck` from `backend/`: clean (after one `as unknown as PaperSummary['authors']` cast — `PaperAuthor` doesn't yet carry the supersession field types; the round-1 `[TODO Architect]` note about central type extension still applies and the same as-unknown-as pattern is what `routes/papers.ts` uses at its list-endpoint emit site).
- `npm run lint` from `backend/`: clean.
- `npx vitest run` across 7 affected test files (`helpers`, `disciplines-canon-mocked`, `papers-canonical-orcid-resolution`, `profile-papers-supersession`, `profile-papers-cid-validate`, `profile`, `canonical-root-walker`): **127/127 pass.** No flakes observed in this run.

### Notes for architect

- The `applyAuthorSupersession` spread (`{...e, ...supersession}`) preserves every chain field on the entry, including `affiliation`. PaperDetail consumers (`routes/papers.ts:2384`, `:2421`) want this — they receive the full PaperDetail-shaped entries. PaperSummary callers strip affiliation post-supersession at the `toPaperSummary` site. The shared lib stays general; per-surface contract enforcement lives at the emit site. Same architectural shape as the SQL helper's `includeAffiliation` flag, just enforced one level closer to the response.
- Unit-test imports in `papers-canonical-orcid-resolution.test.ts` were updated to reference `'../../src/lib/author-supersession.js'` directly (the only place those named exports are needed). `routes/papers.ts` no longer re-exports them; if a future caller needs them outside the route file, import from the lib.
- Backwards-compat for `toPaperSummary` callers: any production or test caller not passing `orcidMap` now receives authors with `affiliation` stripped but no `orcid_verified`/`orcid_discrepancy` projected. This is per-surface contract-correct (PaperSummary shouldn't carry affiliation; supersession is opt-in via orcidMap). The `[BLOCKED]` and held-task review will confirm.

### Re-review signal

Move task to `tasks/review/`; the architect's review pass scopes `/ce-code-review` to the commit shipping this work. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires.
