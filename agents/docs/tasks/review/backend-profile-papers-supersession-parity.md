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

---

## Architect re-review round-1 (2026-05-19) — HELD PENDING FIXES

`/ce-code-review` on commit `d41da25` dispatched 10 reviewers (correctness opus + adversarial opus + security opus + testing/maintainability/project-standards/performance/api-contract/kieran-typescript sonnet + ce-learnings-researcher sonnet; `ce-agent-native-reviewer` skipped per root CLAUDE.md). 22 findings surfaced across this task and the sibling `backend-papers-canonical-orcid-resolution` round-2 review (combined triage; cluster-level findings split per task). 6 main items held below for this task plus 1 passing item plus 1 architect-side action already landed.

### Items to address

**1. (P1 cross-reviewer maint+test+std, anchor 100) Comment-anchor violations in test source**

**Where:** `backend/tests/routes/profile-papers-supersession.test.ts`
- File-header docstring embedding two task slugs (`BACKEND-PAPERS-CANONICAL-ORCID-RESOLUTION`, `BACKEND-PROFILE-PAPERS-SUPERSESSION-PARITY`) and a `Round-1 of` qualifier
- Inline docblock for the `userPapersRow` helper cites `routes/profile.ts:283` — line-number anchor; the line already drifted (line 283 is the count query's `baseParams` argument, not the column list the docblock claims to mirror)

**Why:** Root CLAUDE.md "Comment anchors" — do not embed task slugs, line numbers, or round-number qualifiers in production or test code.

**Fix:**
- Rewrite the header docstring on behavioral anchors only. Drop both slug citations and the `Round-1 of` qualifier. Example: "The SQL-projection in `authorsWithSupersessionSelect` runs on /api/papers but the profile endpoint assembles rows via `fetchUserPapersFromHaf` → `toPaperSummary`; this file pins the JS-side supersession wiring on /api/profile/:username/papers."
- Replace `matching routes/profile.ts:283` with a stable-symbol reference: `mirrors the columns selected by fetchUserPapersFromHaf's data query (author, permlink, title, body, json_metadata, created)`.

**2. (P1 kt, anchor 90) `PaperAuthor` type missing supersession fields; resolves the `as unknown as PaperSummary['authors']` cast and the affiliation type-vs-runtime drift**

**Where:**
- `backend/src/types/domain.ts` — `PaperAuthor` declares `{ name, hive?, orcid?, affiliation? }` only
- `backend/src/helpers.ts` — `as unknown as PaperSummary['authors']` double-cast at the `toPaperSummary` boundary

**Why:** Runtime HTTP response shape now permanently diverges from declared `PaperSummary.authors: PaperAuthor[]`. Consumers reading `summary.authors[i].orcid_verified` get TS errors or have to use `any`. Sibling drift: `PaperAuthor` still declares `affiliation?` even though `toPaperSummary` strips it from PaperSummary (so `summary.authors[i].affiliation` is "always undefined at runtime, optional in type"). Both gaps resolve together.

**Fix:** Two acceptable shapes for the implementer's choice:
- (a) Extend `PaperAuthor` with `orcid_verified?: string | null` and `orcid_discrepancy?: boolean`. Leave `affiliation?` on `PaperAuthor`; accept that `PaperSummary.authors[i].affiliation` is type-optional / runtime-always-undefined (mild drift, defensible).
- (b) Split into `PaperSummaryAuthor` (no affiliation, optional supersession fields) and `PaperDetailAuthor` (with affiliation, optional supersession fields). Stricter, more boilerplate.

Either way, remove the `as unknown as PaperSummary['authors']` cast at the `toPaperSummary` boundary; verify `tsc --strict` clean. One-shot grep for other `as unknown as PaperSummary` / `as unknown as PaperDetail` casts in `backend/src/` to verify the same drift doesn't exist elsewhere.

**3. (P1 cross-reviewer corr+adv, anchor 75) HAF outage on /api/profile/:username/papers returns 500 not 503-retriable; coupled with mislabeled test**

**Where:**
- `backend/src/routes/profile.ts` — inside the `hafCache.getOrSet` miss callback for `/api/profile/:username/papers`. `getAccreditedOrcidsByAccount()` is called without try/catch; `HafQueryError` propagates → 500 INTERNAL_ERROR.
- `backend/tests/routes/profile-papers-supersession.test.ts` — the test labeled "degraded HAF / no pool" stages `stage([...], [])` (empty-result path), not the throw path. Masks the regression from coverage.

**Why:** Pre-task-2, the route absorbed HAF failures inside `fetchUserPapersFromHaf`'s try/catch and returned `{ rows: [], total: 0 }` as 200 — degraded but reachable. Post-task-2 commit regresses partial-HAF degradation to 500 instead of the 503-retriable sibling routes emit (e.g., `/api/papers/:author/:permlink` translates via `HafQueryError`). The mislabeled test let this slip through.

**Fix:** Wrap `getAccreditedOrcidsByAccount()` in try/catch matching the sibling-route pattern; translate the throw to `HafQueryError` so the central error middleware emits 503 retriable. Then rewrite the mislabeled test to stage the actual throw path:
```ts
getPoolMock.mockImplementation((sql) => {
  if (sql.includes('active_accreditations')) throw new HafQueryError(/* ... */);
  return /* user_papers result */;
});
```
Assert 503 with `retriable: true` per central error middleware behavior. Keep a separate test (rename) for the legitimate-empty-accreditation-set path (`active_accreditations` returns `[]`, route serves papers without supersession).

**4. (P2 adv, anchor 80) `applyAuthorSupersession` JS spread leaks broadcaster-controlled extra fields**

**Where:** `backend/src/lib/author-supersession.ts` — `return { ...entry, ...supersession };`

**Why:** SQL-side `authorsWithSupersessionSelect` projects through enumerated `jsonb_build_object` keys (drops broadcaster keys outside the schema). JS-side spread-merges the entire chain entry. A broadcaster posting `authors: [{hive: 'alice', orcid: '0000-...', evil_field: 'payload'}]` produces /api/papers response with `evil_field` dropped, but /api/profile/:username/papers + chain-detail responses retain `evil_field`. Cross-surface response-shape drift; broadcaster-controlled response keys on a public endpoint.

**Fix:** Replace the spread with an explicit projection that pins the JS-side output shape to the SQL-side enumerated key set:
```ts
return {
  name: entry.name,
  hive: entry.hive,
  orcid: entry.orcid,
  affiliation: entry.affiliation,   // PaperDetail consumers want this; toPaperSummary strips later for PaperSummary
  ...supersession,
};
```
Companion test: stage `authors: [{hive: 'alice', evil_field: 'payload'}]` and assert response `authors[0]` has no `evil_field` key across list, chain-detail, non-chain-detail, profile, `?version=N`, and `metadata_restored` surfaces.

**5. (P2 cross-reviewer corr+maint, anchor 78-100) `toPaperSummary` optional `orcidMap?` is a permanent backward hatch; making it required closes JSDoc/code mismatch**

**Where:**
- `backend/src/helpers.ts` — `toPaperSummary` signature + JSDoc claim of "raw passthrough when orcidMap absent" — body always strips affiliation regardless of `orcidMap` presence

**Why:** Today there is exactly one production caller (`profile.ts`) and it always passes the map. The optional parameter creates a permanent dead branch in the body, and the JSDoc's "raw passthrough" claim is provably false (affiliation strip is unconditional). Making `orcidMap` required deletes the dead branch and resolves the docstring/code mismatch in one move.

**Fix:**
- Change `orcidMap?` to required `orcidMap: Map<string, string | null>`.
- Audit `toPaperSummary` call sites: `grep -rn 'toPaperSummary(' backend/src/`. Any caller without an accreditation context either gets a `new Map()` (pure fixture) or surfaces as a real call-site gap.
- Remove the JSDoc claim about absent-orcidMap behavior; describe what the function actually does (always strips affiliation; applies supersession via the passed map).

If the call-site audit surfaces 3+ non-supersession callers, consider splitting into `toPaperSummary(post, meta)` and `toPaperSummaryWithSupersession(post, meta, orcidMap)` instead. Implementer's call.

**6. (P2 perf, anchor 75) Cache-TTL comment vs actual TTL mismatch**

**Where:** `backend/src/routes/profile.ts` — comment inside `hafCache.getOrSet` callback reads "cache the projected result for 30 min"; `hafCache.getOrSet` is called with no explicit `ttlMs` → 30-second default (`hafCache = new QueryCache(30_000)`).

**Why:** Comment promises 30-minute staleness alignment with the architect's papers.md "30-min cache-staleness note for supersession fields." Actual behavior is 30 seconds. Future maintainer could "fix" the comment by changing the TTL to 30 minutes, materially increasing observed revocation lag.

**Fix:** Update the comment to accurately describe behavior: "30-second response cache; cold-cache requests fetch the 10-min-cached accreditation map. Net supersession staleness window: up to ~10 minutes from a revocation event." The architect-side `profiles.md` update already landed (see "Architect-side contract-doc updates" below) describes the actual ~10-minute window for this surface.

### Passing items (small fixes alongside the above)

**7.** `rows: [] as any[]` in `vi.hoisted` mock initializer at `profile-papers-supersession.test.ts` → `rows: [] as unknown[]`.

### Architect-side contract-doc updates already landed (no implementer action)

- `agents/docs/api-contracts/profiles.md` — added field notes for `authors[i].orcid` / `authors[i].orcid_verified` / `authors[i].orcid_discrepancy` on `/api/profile/:username/papers` (cross-referencing papers.md as the canonical PaperSummary supersession SSoT), affiliation-strip note, cache-staleness note describing the actual ~10-minute window for this surface, and a head-only authors caveat documenting the cross-surface authors-set drift with `/api/papers/:author/:permlink` (cumulative-union not yet applied here; tracked separately).

### Findings noted-for-awareness (dismiss-as-noted; document here, no code action)

- **Profile-papers head-only authors vs detail cumulative-union (adv+api-contract P3/70-75):** Pre-existing cross-surface drift — profile lists head broadcaster's authors only; paper detail walks the continuation chain and applies cumulative-union. Same paper viewed on profile vs detail may have a different `authors[]` set, not just different supersession projections. Already tracked by `backend-cumulative-union-listing-surfaces-parity` (currently in `tasks/review/` as design-proposal awaiting architect ratification). No action on this hold.
- **Clause (c) real-path companion claim wording (test P2/75):** Header cites `papers.test.ts` as real-path companion; `papers.test.ts` is structurally a valid clause (c) companion per the carve-out doc's "different mutation class" principle (it exercises the integrated route through real HAF), even though it doesn't assert on supersession fields specifically. Prose is loose but discipline is intact. Per `feedback_dismiss_preemptive_test_hardening`.

### Dismissed at triage (no action)

- (T2 kt-4) `entry as Record<string, unknown>` cast inside `applyAuthorSupersession` — safe per preceding null+object guard; documentation observation only.
- (T2 adversarial-5) Cache TTL skew across surfaces — anchor 60, below the confidence gate. The architect's `profiles.md` cache-staleness note acknowledges per-surface variance.

### Re-review signal

When items 1-7 land, `git mv` this file from `tasks/pending/` back to `tasks/review/`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `d41da25`. Items 2 (PaperAuthor type) + 4 (JS spread shape) + 5 (orcidMap required) share helper/type-system scope and could land as a single commit; item 3 (HAF outage) is the route-correctness item with the test rewrite; items 1, 6, 7 are documentation/test cleanups.

---

## Backend re-review signal (2026-05-19, round-2 — working tree of this commit)

All 7 hold-block items land in this single commit alongside the signal block + the `git mv` back to `tasks/review/`. This commit follows the task-1 round-3 commit `ed7dfa9` (which renamed `canonicalHiveKey` to `normalizeHiveAccount` and added the SQL regex guard); task-2 round-2 inherits the renamed helper into the explicit-projection + type-system cleanup.

### Items addressed

**Item 1 — Comment-anchor cleanup in `profile-papers-supersession.test.ts`.** Rewrote the file-header docstring on behavioral anchors: dropped both task-slug citations (`BACKEND-PAPERS-CANONICAL-ORCID-RESOLUTION`, `BACKEND-PROFILE-PAPERS-SUPERSESSION-PARITY`) and the `Round-1 of` qualifier. New header lead is "The SQL-projection in `authorsWithSupersessionSelect` runs on `/api/papers` (list) and `/api/papers/:author/:permlink` (detail), but the profile-papers endpoint assembles rows via `fetchUserPapersFromHaf` → `toPaperSummary` — a JS-side code path that doesn't round-trip through the SQL projection. This file pins the JS-side supersession wiring on /api/profile/:username/papers." Replaced the `matching routes/profile.ts:283` line-number reference in the `userPapersRow` docblock with a stable-symbol reference to the columns selected by `fetchUserPapersFromHaf`'s data query.

**Item 2 — `PaperAuthor` type extended; `as unknown as PaperSummary['authors']` cast removed.** Adopted option (a) from the hold block: added `orcid_verified?: string | null` and `orcid_discrepancy?: boolean` to `backend/src/types/domain.ts` `PaperAuthor`. Kept `affiliation?` (mild type-vs-runtime drift on PaperSummary, defensible per the architect's prescription). The double-cast at the `toPaperSummary` boundary in `helpers.ts` is gone; a per-entry `rest as unknown as PaperAuthor` narrowing remains inside the map callback — a localized cast on the structurally-typed object literal, much tighter scope than the prior array-level cast. Grep-audit of `as unknown as PaperSummary` / `as unknown as PaperDetail` across `backend/src/`: no other drift sites.

**Item 3 — HAF-outage 503 retriable on profile-papers + mislabeled-test rewrite.** Added `import { HafQueryError } from '../db.js'` to `routes/profile.ts`. Wrapped `getAccreditedOrcidsByAccount()` inside the route's `hafCache.getOrSet` callback in a try/catch that translates pg/HAF errors to `HafQueryError`. The route handler now wraps the entire body in a try/catch that catches `HafQueryError` and returns 503 SERVICE_UNAVAILABLE with `retriable: true`, matching the sibling-route pattern in `routes/papers.ts`. The previously-mislabeled "degraded HAF / no pool" test is renamed to "empty accreditation set: supersession fields collapse to case-1 defaults (null/false), 200 OK" — it actually exercises the empty-accreditation case, not the throw path. A new test "HAF outage on getAccreditedOrcidsByAccount → 503 SERVICE_UNAVAILABLE with retriable:true" stages the actual throw (mock pg.query rejecting on the `FROM active_accreditations` SQL) and asserts the 503 envelope. Mutation-kill: revert the try/catch around `getAccreditedOrcidsByAccount` → response goes 500 instead of 503-retriable. **Test discovery during item 3:** the `vi.mock('../../src/db.js', ...)` mock was using the override-everything form, which broke `import { HafQueryError } from '../db.js'` (the mock didn't expose the class symbol). Switched the mock to the `importOriginal` form so `HafQueryError` and other db.ts exports stay reachable while `getPool`/`isHafConfigured`/`closeHafPool` are overridden.

**Item 4 — JS spread replaced with explicit projection in `applyAuthorSupersession`.** Switched the helper from `return { ...e, ...supersession }` to an enumerated projection — `{name: e.name, hive: e.hive, orcid: e.orcid, affiliation: e.affiliation, ...supersession}`. The output key set now matches the SQL-side `authorsWithSupersessionSelect`'s `jsonb_build_object` keys exactly, so broadcaster-controlled extra fields (`evil_field`, `verified_at`, etc.) drop on the JS path the same way they drop on the SQL path. Companion canary `broadcaster-controlled extra fields on authors[i] do NOT leak through the JS projection` stages `authors: [{hive: 'heidi', evil_field: 'payload', verified_at: '...'}]` and asserts both extras are dropped from the response while supersession fields land verbatim.

**Item 5 — `orcidMap` required in `toPaperSummary`.** Signature: `orcidMap?: Map<...>` → `orcidMap: Map<...>`. Body: dropped the conditional `orcidMap ? applyAuthorSupersession(rawAuthors, orcidMap) : rawAuthors` dead branch — now unconditionally `applyAuthorSupersession(rawAuthors, orcidMap)`. JSDoc rewritten to describe actual behavior: "Callers without an accreditation context pass `new Map()`; the supersession projection collapses to case-1/case-2 (\"no claim\") for every author." Call-site audit: only one production caller (`routes/profile.ts`) already passes the map; 4 legacy callers in `tests/helpers.test.ts` updated to pass `new Map()` via `replace_all`. `fetchUserPapersFromHaf`'s `orcidMap?` parameter also tightened to required to match. No call-sites left passing nothing.

**Item 6 — Cache-TTL comment corrected.** Replaced the "cache the projected result for 30 min" comment with an accurate description: "`hafCache.getOrSet` here uses the QueryCache default (30s), so response-level cache hits serve the same projected map for up to 30 seconds... `getAccreditedOrcidsByAccount` is 10-min cached internally, so cold response-cache misses re-use the accreditation set for up to ~10 minutes before re-fetching. Net supersession revocation window observed on this endpoint: up to ~10 minutes from the on-chain revoke event." Cross-references the architect-side `profiles.md` cache-staleness note.

**Item 7 — `rows: [] as any[]` → `unknown[]` in `profile-papers-supersession.test.ts`.** Mechanical fix, same as task-1 round-3 item 8.

### Drift finding closed during round-2

**`routes/profile.ts:349-351` adopted `normalizeHiveAccount`.** While landing the route-level try/catch for item 3, the same `(row.authors || []).filter((a) => a.hive && allAccredited.has(a.hive)).map((a) => a.hive!)` raw-lookup pattern that task-1 round-3 item 2 fixed in `routes/papers.ts` was discovered on the profile-papers enrichment path. Replaced with the wrapper-based pattern per `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`. This site was NOT in task-2's hold block; surfacing it here as a drift discovered during round-2. The fix follows the same shape as the task-1 round-3 item 2 sibling sites in `routes/papers.ts`, so it composes naturally into the same wrapper-adoption story.

### Test coverage added/changed

`backend/tests/routes/profile-papers-supersession.test.ts`:
- Renamed/clarified "degraded HAF / no pool" → "empty accreditation set: supersession fields collapse to case-1 defaults".
- Added "HAF outage on getAccreditedOrcidsByAccount → 503 SERVICE_UNAVAILABLE with retriable:true" — exercises the actual throw path via mocked pg rejection.
- Added "broadcaster-controlled extra fields on authors[i] do NOT leak through the JS projection" — pins the enumerated-projection contract.

Total: 10 tests in `profile-papers-supersession.test.ts` (up from 8).

### Verification

- `npm run typecheck` from `backend/`: clean (after extending PaperAuthor with `orcid_verified?` / `orcid_discrepancy?` and fixing the `entry → PaperAuthor` cast pattern).
- `npm run lint` from `backend/`: clean.
- `npx vitest run tests/routes/profile-papers-supersession.test.ts`: **10/10 pass.**
- Broader regression sweep (`profile-papers-supersession`, `profile-papers-cid-validate`, `profile`, `helpers`, `papers-canonical-orcid-resolution`, `paper-detail-v3`, `canonical-root-walker`): **111/112 pass, 1 pre-existing real-HAF flake** on `paper-detail-v3.test.ts > 'includes versions array and retraction fields when paper exists'` (same `jesusalejos/...` wall-clock-exceeded flake task-1 round-3 confirmed pre-existing via `git stash` round-trip; the same fingerprint on this run).

### Notes for architect

- Item 2 chose option (a) (extend PaperAuthor) over (b) (split into PaperSummaryAuthor + PaperDetailAuthor) for minimum churn. The `affiliation?` type-vs-runtime drift on PaperSummary is mild (the field is always undefined at runtime, type-optional). If a future refactor wants strict per-surface types, splitting into PaperSummaryAuthor + PaperDetailAuthor is a localized follow-up; the supersession fields are already optional on the base type and would propagate naturally.
- Item 4's explicit projection includes `affiliation` even for PaperSummary callers; `toPaperSummary` post-strips it. The architectural shape is: helper preserves all enumerated chain fields; per-surface contract enforcement happens at the emit site. Same pattern as the SQL helper's `includeAffiliation` flag, just enforced one level closer to the response.
- The route-level try/catch in item 3 wraps the full request flow including the enrichment pass after the cache miss. The enrichment also makes HAF queries (`getAccreditedSet`, `getAllAccreditedAccounts`, `getReputationScores`). Those don't currently throw `HafQueryError` directly, so if they fail with a raw pg error, the central 500 handler still picks them up. Tightening those to also translate to `HafQueryError` is a separate follow-up that would extend the pattern across the route file; this commit's scope is item 3's specific path. The pattern is now in place for future extension.
- Drift finding above (`routes/profile.ts:349-351`) is the third site closed by the wrapping-primitive call-site audit. With this commit, the wrapper is the single source of truth for hive-account canonicalization on the JS-side accreditation lookups across both papers and profile routes.

### Re-review signal

`git mv tasks/pending/backend-profile-papers-supersession-parity.md tasks/review/` in the same commit as the source edits. The architect's next `/ce-code-review` pass scopes to commits since `ed7dfa9` (the task-1 round-3 commit) — this commit and that one form the supersession-cluster round-3/round-2 pair.
