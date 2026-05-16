# Typeof-narrow + helper-extract sweep for /api/search query params (language, source, sort, type)

**Owner:** Backend Agent
**Created:** 2026-05-12 (architect review of `backend-search-reviews-contract-reconcile`; bundled findings #1, #3, #4)
**Priority:** P1

## Problem

`backend-search-reviews-contract-reconcile` pinned `?type=` to `['all', 'paper', 'review']` via a typeof-narrowed check that rejects unknown values and repeated params (`?type=a&type=b`). The inline comment on `backend/src/routes/search.ts:313` explicitly diagnoses why `(req.query.x as string)` is unsafe: repeated params yield `string[]` which the cast silently coerces to `'a,b'` before reaching downstream code. The fix was applied to `?type=` and not propagated to the three sibling params right below it:

- `backend/src/routes/search.ts:335` — `const language = req.query.language as string | undefined;`
- `backend/src/routes/search.ts:336` — `const source = req.query.source as string | undefined;`
- `backend/src/routes/search.ts:338` — `const sort = (req.query.sort as string) === 'date' ? 'date' : 'relevance';`

Concrete failure shapes today:

- `?language=en&language=fr` yields `['en','fr']` which the `as string` cast coerces to `'en,fr'`. The downstream SQL bind (`AND c.json_metadata -> 'app_tag_obj' ->> 'language' = $N`) never matches a stored value, so the route silently returns zero results instead of 400.
- `?source=native&source=bridge` yields `['native','bridge']`, coerced to `'native,bridge'`, which fails both `source === 'native'` and `source === 'bridge'` ternary arms and falls through to the `'all'` arm — silent semantic shift instead of 400.
- `?sort=date&sort=relevance` yields `['date','relevance']`, coerced to `'date,relevance'`, falls through the ternary to the `'relevance'` default. Same risk class, lowest impact (fallback is harmless).

The `?type=` validator is also the only one in this route that lives inline inside the `router.get('/')` callback. Sibling validators (`validateDisciplineFilter`, `validateSearchQuery`) live in dedicated modules under `backend/src/types/`. The inline `VALID_SEARCH_TYPES` + `SearchType` are re-created on every request and not importable. Additionally, `searchFromHaf` at `backend/src/routes/search.ts:245` accepts `type: string` rather than the narrowed `SearchType` literal union, discarding the compiler exhaustiveness benefit on the downstream `if (type === 'review') / if (type === 'paper')` branches.

## Acceptance criteria

1. **Extract `?type=` validator** from the inline block at `search.ts:315-325` into `backend/src/types/search-filters.ts` alongside `validateSearchQuery`. Prefer a user-defined type guard `function isSearchType(s: string): s is SearchType` so the route assignment site drops its `as SearchType` cast. Export `SearchType` at module scope so other modules can import it.

2. **Tighten `searchFromHaf` signature** at `search.ts:245` from `type: string` to `type: SearchType` (importing the literal union from `types/search-filters.ts`). No call-site changes required since the route is the only caller and already narrows to `SearchType`.

3. **Sweep `?language=` to typeof-narrow.** Add a `validateLanguageFilter(raw: unknown)` (or `isLanguageCode` type guard) helper in `types/search-filters.ts`. Decide on the rejection-vs-silent-unfilter contract for repeated params:
   - **Option A (recommended):** mirror the `?type=` contract — repeated params and non-string values return `400 BAD_REQUEST` with `Invalid language. Must be a 2-letter ISO 639-1 code` (or whatever charset/length you settle on).
   - **Option B:** mirror the `?discipline=` contract — repeated params fold to null (silent-unfilter) per the round-4 `?discipline=` decision documented in `agents/docs/solutions/conventions/` and tested in `search.test.ts`.

   Either is defensible; pick one and document the choice in the helper's docblock. If you pick Option B for parity with `?discipline=`, the contract update is "repeated `?language=` is silent-unfilter" rather than 400; add a regression test asserting that contract.

4. **Sweep `?source=` to typeof-narrow.** Same shape: typeof check + enum check against `['native', 'bridge']` (omit-allowed → `undefined` → both-types). Repeated params: prefer 400 (Option A above) since `?source=` is already an explicit enum like `?type=`, and there's no "fold to no-filter" semantics that match the `?discipline=` pattern.

5. **Sweep `?sort=` to typeof-narrow.** Lower priority (the ternary fallback masks the silent coerce). Pick: leave as-is with a docblock note, or narrow to `'date' | 'relevance'` with explicit 400 on repeated params. Architect-side preference: narrow for consistency, since the same hardening pass is already underway.

6. **Tests.** Add three regression test cases mirroring the existing `?type=paper&type=review` repeated-param test at `search.test.ts:88-92`:
   - `?language=en&language=fr` — behavior depends on your Option A/B choice for criterion 3 (400 or silent-unfilter).
   - `?source=native&source=bridge` — should 400.
   - `?sort=date&sort=relevance` — depends on your choice for criterion 5.

7. **Verify against real HAF.** Run targeted vitest for `backend/tests/routes/search.test.ts` against the live HAF + Hive setup. The existing 14/14 baseline plus your new cases should all pass.

## Out of scope

- The `?type=` validator's behavior itself — already pinned by `backend-search-reviews-contract-reconcile`. This task moves the *placement* and tightens the call-site exhaustiveness, not the input contract.
- `?q=` validation — owned by `BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP` (already landed in `validateSearchQuery`).
- `?discipline=` validation — owned by `BE-DISCIPLINE-CANONICALIZE` and `BE-DISCIPLINE-LENGTH-CAP` (already landed in `validateDisciplineFilter`).
- `?include_retracted=` — single-value boolean coercion (`=== 'true'`), repeated-param coerce yields `'true,true'` which doesn't match and falls to `false` (the default). Same risk class but tolerable since the fallback is the documented default. Out of scope unless you want a full sweep.
- `?page=` / `?limit=` — handled by `parsePageLimit(req)` already; out of scope.

## Why now

Three independent reviewer personas converged on this asymmetry during the `backend-search-reviews-contract-reconcile` review pass: kieran-typescript (P1, conf 100), maintainability (P2, conf 75), and (implicitly) api-contract via the documented `?type=` enum-rejection contract. The diff that closed `?type=` was explicit about *why* the cast is unsafe; the same vector survives on the three sibling params. The cost to close the asymmetry is small and the pattern to follow is now well-established in the codebase (validateDisciplineFilter, validateSearchQuery).

## Architect re-review (2026-05-16, round-1 → round-2) — HELD PENDING FIXES:

`/ce-code-review` ran on commit `e7a495f` with 8 personas (correctness opus; testing, maintainability, project-standards, security, api-contract, kieran-typescript, ce-learnings-researcher sonnet; adversarial opus). `ce-agent-native-reviewer` skipped per PEvO root CLAUDE.md. Cluster-3 architect triage produced 4 items to address. (Findings on contract-doc updates split out to a separate architect-owned papers.md commit; the deferral on `?language=` length-cap split out to a new follow-up task `backend-language-filter-length-cap.md`.)

### Items to address

1. **(P1 maintainability+kieran-typescript, anchor 100 cross-reviewer)** `source` variable narrow asymmetric. At `backend/src/routes/search.ts:386`, `let source: string | undefined` after the `isSearchSource(rawSource)` narrow widens the type back to `string` immediately. `type` and `sort` get their literal-union types at the local variable (`let type: SearchType`, `let sort: SearchSort`); `source` should follow the same pattern. The `SearchSource` type is exported from `search-filters.ts` but never imported anywhere → dead export.

   Fix: import `type SearchSource` alongside the existing `type SearchSort` in the search-filters import block. Change `let source: string | undefined` to `let source: SearchSource | undefined`. End-to-end completeness of the sweep is the task's whole point; the asymmetric `source` narrowing is the missed application.

2. **(P3 correctness+kieran-typescript, anchor 75 promoted)** Internal-signature missed-narrows on `searchFromHaf` / `searchPapersFromHaf`. At `backend/src/routes/search.ts:268-272` (or wherever the post-edit signatures live), `searchFromHaf` takes `sort: string` not `sort: SearchSort`. `searchPapersFromHaf` is similarly `sort: string` and `source: string | undefined`. The route narrowed both before the call; the internal signatures should follow.

   Fix: change `sort: string` → `sort: SearchSort` on both `searchFromHaf` and `searchPapersFromHaf`. Change `source: string | undefined` → `source: SearchSource | undefined` on both. The ternary `sort === 'date' ? ... : ...` inside `searchPapersFromHaf` body remains valid and becomes exhaustive for readers. Internal signatures should not be wider than the route's contract.

3. **(P2 testing, anchor 90)** Four new helper exports have zero direct unit tests. `isSearchType`, `isSearchSource`, `isSearchSort`, `parseLanguageFilter` are exported from `backend/src/types/search-filters.ts` and used only by `search.ts`. The unit-test file `backend/tests/lib/search-filters.test.ts` imports `validateSearchQuery`, `escapeLikePattern`, `SEARCH_QUERY_MAX_LEN` but none of the 4 new exports. Sister `validateSearchQuery` shipped with 21 direct unit tests; the new helpers have multiple return paths covered only at the route-level rejection path. An inverted `(SEARCH_X as readonly string[]).includes(s)` predicate or a broken `parseLanguageFilter` undefined fast-path would not be caught.

   Fix: add ~6-10 helper-direct unit tests to `backend/tests/lib/search-filters.test.ts`:
   - `isSearchType('all')`, `isSearchType('paper')`, `isSearchType('review')` → true; `isSearchType('foo')` → false
   - `isSearchSource('native')`, `isSearchSource('bridge')` → true; `isSearchSource('foo')` → false
   - `isSearchSort('date')`, `isSearchSort('relevance')` → true; `isSearchSort('foo')` → false
   - `parseLanguageFilter(undefined)` → `{ok:true, value:undefined}`
   - `parseLanguageFilter('en')` → `{ok:true, value:'en'}`
   - `parseLanguageFilter(['en','fr'])` → `{ok:false}` (with message matching `/language/i`)
   - `parseLanguageFilter(42)` (non-string non-array) → `{ok:false}`

4. **(P3 testing+kieran-typescript, anchor 100 promoted)** Route-level test coverage gaps. The repeated-param 400 tests are in place (good). But:
   - No test for `?source=foo` (invalid single string) → 400. `?type=foo` analogue exists at `search.test.ts:143`.
   - No test for `?sort=foo` (invalid single string) → 400.
   - No happy-path test for `?source=native` or `?source=bridge` (valid single value) → 200. If `isSearchSource` were accidentally inverted (e.g., `!includes()` typo), all valid `?source=` requests would silently 400; no current test catches it.
   - `?sort=date` happy-path is incidentally covered by accreditation-gate tests; `?source=` has no such incidental coverage.

   Fix: add 4 route-level tests to `backend/tests/routes/search.test.ts` mirroring the `?type=foo` line-143 pattern: `?source=foo` → 400, `?sort=foo` → 400, `?source=native` → 200, `?source=bridge` → 200. Per `route-level-error-class-coverage-after-helper-extraction-2026-04-29.md`: each error class needs explicit coverage; current sweep covers only `repeated-param` class for these.

### Items dismissed during architect triage

- (P2 maintainability M2, anchor 75) Three near-identical if/else validation blocks for `type`/`source`/`sort` should extract `parseEnumParam` helper — dismissed at YAGNI threshold (N=3, ~4 lines each, generic helper would add type plumbing heavier than the inline form). The implementer's partial-extraction (constants + predicates extracted, control flow inline) is the right local optimum.
- (P3 adversarial, anchor 75) Validation 400s consume `searchLimiter` slots; misconfigured polling clients self-DoS faster post-sweep — dismissed: composition shift surfaces misconfiguration faster (429 vs silent empty 200), arguably better UX. `skipFailedRequests: true` would open a different abuse surface.
- (P3 kieran-typescript KT-2, anchor 50; KT-3 anchor 50; maintainability M3 anchor 65) — below confidence gate.

### Items handed to separate architect actions (not held on this task)

- (P1 api-contract AC-01 anchor 90; P2 AC-02 anchor 80; P3 AC-03 anchor 85; P3 AC-04 anchor 75) `papers.md` `/api/search` doc gaps on `?sort=`/`?source=`/`?language=` validation contracts + enum-order mismatch + rejection-message phrasing — landed in separate architect commit `architect(api-contracts): pin /api/search ?sort/?source/?language= validation in papers.md`.
- (P1 adversarial cache-exhaustion anchor 75) `?language=` lacks length cap — filed as separate follow-up task `backend-language-filter-length-cap.md` in `tasks/pending/` so the architect (you, future-architect) decides on charset + length boundary cleanly, rather than scope-creeping this task.

### Re-review signal

When all 4 items above land, `git mv` this file back to `tasks/review/`. Round-2 architect re-review scopes `/ce-code-review` to the round-2 commit. Anchor: items 1+2 are TypeScript-narrow tightening (route + 2 internal signatures); items 3+4 are tests. Single commit reasonable; or split type-tightening from test-adds — implementer's choice.
