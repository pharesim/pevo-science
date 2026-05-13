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
