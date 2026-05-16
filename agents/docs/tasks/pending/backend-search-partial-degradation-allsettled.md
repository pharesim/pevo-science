# BACKEND-SEARCH-PARTIAL-DEGRADATION-ALLSETTLED — surface partial results on type=all search degradation

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, follow-up to `backend-papers-filter-accreditation.md` round-1 review)
**Priority:** P2

## Problem

`backend/src/routes/search.ts:286-308` (`searchFromHaf`) handles the `?type=all` branch by fanning out to `searchPapersFromHaf` and `searchReviewsFromHaf` via `Promise.all`. Neither inner function has its own catch; both propagate throws. The outer route catch swallows any rejection, returns `null`, and the route emits an empty `200`.

Path-by-path:

- Both branches succeed → merged results returned ✅
- Pool absent (`getPool()` returns null) → each branch returns `null`; outer `?? []` guards yield partial results ✅
- One branch throws (HAF transient error mid-query) → `Promise.all` rejects → outer catch → empty `200` ❌

A reviews-search transient HAF error silently collapses BOTH branches even though the papers-search succeeded. Users can't distinguish "no matching content" from "search partially broken." Operators must read logs to know.

Pre-existing bug (predates `backend-papers-filter-accreditation` lane-3); surfaced during round-1 reliability review (REL-03 P2/75) of that task. Filed as separate task because not in lane-3 accreditation-gate scope.

## Goal

Surface partial results from `?type=all` search when one branch degrades, with a structured log event signaling the partial failure.

## Acceptance

- Replace `Promise.all` at `search.ts:286-308` with `Promise.allSettled`.
- On either branch rejection, return the successful branch's results; populate the failed branch with `[]`; log `event: 'search_partial_degradation'` with `branch` (papers|reviews), error class, and the search query parameters.
- Real-HAF canary (or mocked-pool with carve-out documentation) asserting: when reviews branch throws, response contains papers results + log event fires; symmetric for papers branch throwing.
- Coverage that both-throw still yields empty 200 (no regression vs current behavior).

## Out of scope

- Refactoring `searchPapersFromHaf` / `searchReviewsFromHaf` internals.
- Other `Promise.all` sites in the codebase — separate audit if this pattern recurs.

## Source

- `backend-papers-filter-accreditation` round-1 `/ce-code-review` reliability REL-03 (P2/75). Pre-existing bug; lane-3 just happened to put eyes on the file.
- User triage 2026-05-16 elected separate-task filing because pre-existing scope, not lane-3-introduced.

## Cross-references

- `agents/docs/tasks/pending/backend-papers-filter-accreditation.md` — sibling task; reviewer surfaced this finding while inspecting lane-3 search.ts changes.
- `backend/src/routes/search.ts:286-308` — `searchFromHaf` type=all branch.

## Backend implementation signal (2026-05-16, worktree)

Acceptance items 1-4 + lint/tsc gate landed.

- **Refactor:** `Promise.allSettled` replaces `Promise.all` in `searchFromHaf` `type=all` branch (`backend/src/routes/search.ts:277-336` post-edit). Each rejected branch logs a `logger.warn` with the structured event slug below, then the merge step uses `[]` for the failed branch's rows. Both-throw degrades to empty rows → route renders as `200 OK { data: [], total: 0 }` (regression preserved). The outer `try/catch` is retained as the catch-all safety net for any unexpected throw outside the two helpers.
- **Event slug:** `search.type_all.partial_degradation` (dot-namespaced per the recent convention sweep; consistent with `accreditation.verify.*`, `custody.broadcast.*`, `auth.signup.*`). Payload shape: `{ event, branch: 'papers' | 'reviews', errClass, err, queryParams: { type, discipline, language, source, includeRetracted, sort, limit, offset } }`.
- **Tests:** 4 canaries added in a new file `backend/tests/routes/search-partial-degradation.test.ts`:
  - Reviews-branch-throws → 200, papers-only data, one warn fires with `branch: 'reviews'`.
  - Papers-branch-throws → 200, reviews-only data, one warn fires with `branch: 'papers'`.
  - Both-throw → 200 empty, two warns fire (one per branch). Regression guard against outer-catch collapse re-introduction.
  - QueryParams payload shape canary — pins `type`, `discipline`, `language`, `sort` in the warn event so future filter additions get operator-dashboard visibility.
- **Carve-out:** mocked `getPool()` via `vi.mock` so `pool.query` discriminates by SQL substring (` p ON ` is the reviews-branch JOIN — structural discriminator, not a brittle alias-name match). Real-HAF was impractical: inducing single-branch failure (one query times out, the other succeeds) requires per-statement timeouts plus a controlled rogue-query fixture the live corpus does not provide. Real-path companion is the existing `?type=all` happy-path coverage in `backend/tests/routes/search.test.ts` (different risk class — SQL-shape vs JS-level allSettled discrimination). New test file header documents the carve-out under clauses (a), (b), (c). `verifyHiveSignature` is NOT mocked (`/api/search` is unauthenticated; carve-out's auth-focused exclusion does not apply).
- `npm run lint` clean (pre-existing seed-phrase.ts warnings only); `npx tsc --noEmit` clean. Vitest not run in worktree (parent serializes after all worktrees merge).

## Architect re-review (2026-05-16, round-1 → round-2) — HELD PENDING FIXES:

`/ce-code-review` ran on commit `31b02fb` with 9 personas (correctness opus; reliability, security, testing, maintainability, project-standards, kieran-typescript, ce-learnings-researcher sonnet; adversarial opus). `ce-agent-native-reviewer` skipped per PEvO root CLAUDE.md. Cluster-3 architect triage produced 5 items to address.

### Items to address

1. **(P1 kieran-typescript, anchor 75)** errClass cast is a silent no-op. At both warn-emit sites (`backend/src/routes/search.ts:306` and `:319`):

   ```ts
   errClass: (err as Error | null | undefined)?.constructor?.name ?? 'Unknown',
   ```

   `PromiseRejectedResult.reason` is typed `any` (per `lib.es2020.promise.d.ts:24`). `err` is already `any` so the cast to `Error | null | undefined` is accepted without any structural verification — it reads as defensive but teaches the compiler nothing.

   Fix: rewrite both sites to a compiler-verified guard:

   ```ts
   errClass: err instanceof Error ? err.constructor.name : 'Unknown',
   ```

   Same runtime behavior, shorter, the narrowing is actually checked. Both sites in one commit.

2. **(P2 cross-reviewer testing+reliability+adversarial+maintainability, anchor 100 promoted)** SQL substring discriminator is fragile under alias rename. At `backend/tests/routes/search-partial-degradation.test.ts:71-76` the helper:

   ```ts
   const isReviewsBranchSql = (sql: string) => / p ON /.test(sql);
   ```

   matches the reviews-branch JOIN structure (`JOIN ${T.comments} p ON ...` in `searchReviewsFromHaf`). A future SQL refactor renaming the alias `p` (to `parent`, `c2`, etc.), or the papers branch gaining a JOIN whose alias coincidentally renders as ` p ON `, will silently misroute the mock — tests pass against the wrong assertion class. Per `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`: filter fragments must be grep-verified against production source AND resilient to cosmetic refactors.

   Fix: replace the substring discriminator with a more structurally stable token. Implementer's choice of mechanism — e.g., a per-branch SQL sentinel comment (`/* search.reviews.branch */`) emitted from `searchReviewsFromHaf` and matched by the mock, OR call-order-based routing (first invocation = papers, second = reviews) since `Promise.allSettled` preserves array order, OR named-mock-returns indexed by helper-invocation count. Architect-spec is the goal (discriminator survives alias rename); not the mechanism.

3. **(P3 testing, anchor 90)** Canary 4 queryParams shape pin is incomplete. At `backend/tests/routes/search-partial-degradation.test.ts:191-210`, the queryParams shape canary asserts `type`, `discipline`, `language`, `sort` but NOT `source` and `includeRetracted` — both of which are in the production `queryParams` object (search.ts:299). Stated intent ("if a new filter param is added... this spec fails first") undermined by 2 unasserted fields.

   Fix: add `expect(payload.queryParams.source).toBeUndefined()` and `expect(payload.queryParams.includeRetracted).toBe(false)` to canary 4. 2-line addition.

4. **(P3 testing, anchor 80)** Carve-out clause (c) header prose overstates real-path companion. File header at `backend/tests/routes/search-partial-degradation.test.ts:32-35` claims `search.test.ts` "exercises the integrated `?type=all` path end-to-end" — `search.test.ts` has zero explicit `?type=all` requests. The implicit real-HAF coverage comes from no-type-param requests that default to `type=all` in the route handler; coverage is real but the claim overstates explicitness.

   Fix: correct the header prose to accurately describe the companion coverage. E.g., "...exercises the integrated `?type=all` path implicitly via the no-type-param default-type coverage..." OR add 1 explicit `?type=all` test to `search.test.ts` to make the claim accurate. Implementer's choice.

5. **(P3 testing, anchor 75)** Canaries 1 and 2 don't assert surviving-branch data flow. Both canaries mock the surviving branch to return empty rows, so `res.body.data` is always `[]` and the surviving branch's data-flow is unasserted. A regression where `paperResult?.rows ?? []` was replaced with `[]` (dropping the merge step) would pass both canaries — the warn-event assertion does not substitute for a data-flow assertion. The whole point of the allSettled refactor is "preserve surviving data".

   Fix: change the mocked surviving-branch return to include one synthetic row (e.g., `{ rows: [{ type: 'paper', author: 'fixture', ... }], total: 1 }`). Assert `res.body.data.length === 1` and that `res.body.data[0].type` matches the surviving-branch's expected row type. ~4 lines per canary.

### Items dismissed during architect triage

- (P1 cross-reviewer correctness+reliability+adversarial+learnings, anchor 100) Cache stores degraded results for 15s (both-throw cached empty post-patch vs uncached null pre-patch; single-branch cached partial). **Dismissed**: sub-cases manifest only during HAF degradation; 15s cached-empty/partial is acceptable under those conditions and arguably preferable to pre-patch per-request live-retry. Implementer's inline comment acknowledges the single-branch case; the both-throw cache-shape imprecision in the signal block ("regression preserved" is response-shape-true but cache-behavior-different) is noted at archive, not separately actionable.
- (P2 maintainability MAINT-01, anchor 75) Two near-identical warn-log blocks should extract `logBranchFailure` helper. **Dismissed at N=2 YAGNI**: helper would add type plumbing (branch literal-union, queryParams shape) heavier than the inline form. Implementer's inline form is defensible.
- (P2 adversarial ADV-03, anchor 70) pg DatabaseError may leak bound params via err.message — **dismissed after verification**: the pino redactor at `backend/src/logger.ts:74` allowlists `SAFE_BASELINE_FIELDS = ['code', 'errno', 'syscall']` only. pg DatabaseError fields like `internalQuery`/`where` that could echo bind values are NOT in the allowlist and are stripped. `err.message` references `$N` placeholders, not bound values. User `?q=` is always `$N`-bound. No GDPR/CNPD leak path.
- (P3 adversarial ADV-05, anchor 80) Response envelope shape opaque to partial degradation vs empty corpus. **Dismissed**: frontend is sole consumer; partial degradation is rare; operator logs are the right surface for the distinction. Adding a `degraded: true` flag would require frontend UX work for a rare scenario.
- (P2 adversarial ADV-02 anchor 75) Log volume amplification on both-throw catastrophic outage — folded into Coverage; the 2 new warn logs ARE the explicit task acceptance criterion per `feedback_pevo_logging_minimal`.
- (P3 adversarial ADV-04 anchor 90 about SQL discriminator brittleness) — already folded into item 2 above (same finding, multi-reviewer).
- Several below-confidence-gate findings (correctness-2 anchor 50, reliability RR-2 anchor 50, kieran-typescript KT-2/KT-3 anchor 50/40, maintainability MAINT-RR-01/02 anchor 50).

### Re-review signal

When all 5 items above land, `git mv` this file back to `tasks/review/`. Round-2 architect re-review scopes `/ce-code-review` to the round-2 commit. Anchor: item 1 (errClass cast) is a 2-line touch at search.ts; items 2-5 are all in the test file. Single commit reasonable; or split production-code (item 1) from test changes (items 2-5) — implementer's choice.
