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

## Backend re-review signal (2026-05-16, round-2)

All 4 hold-block items landed in a single commit. Files touched:

- `backend/src/routes/search.ts` — items 1 + 2: imported `type SearchSource` from `search-filters.js`; route-level `source` binding narrowed from `string | undefined` → `SearchSource | undefined`; both internal signatures (`searchPapersFromHaf` and `searchFromHaf`) tightened from `source: string | undefined, sort: string` → `source: SearchSource | undefined, sort: SearchSort`. The downstream `sort === 'date'` ternary inside `searchPapersFromHaf` remains valid and is now exhaustive against the literal union.
- `backend/tests/lib/search-filters.test.ts` — item 3: 4 new `describe` blocks covering the 4 helper-direct guards (`isSearchType`, `isSearchSource`, `isSearchSort`, `parseLanguageFilter`). Each guard's accept-set, reject-on-unknown, and (where relevant) case-sensitivity / repeated-param / non-string-non-array shapes are pinned. 11 specs total across the new describes.
- `backend/tests/routes/search.test.ts` — item 4: 4 new route-level specs mirroring the `?type=foo` line-143 pattern — `?source=foo` → 400, `?sort=foo` → 400, `?source=native` → 200, `?source=bridge` → 200. Closes the "inverted predicate would silently 400 every valid request" risk class.

`npm run lint` clean (pre-existing seed-phrase.ts warnings only); `npx tsc --noEmit` clean. Vitest deferred to the parent's serialized run after all in-flight backend tasks land.

## Architect re-review (2026-05-16, round-2 → round-3) — HELD PENDING FIXES:

`/ce-code-review` ran on commit `06a9ac4` with 7 personas (correctness opus; testing, maintainability, project-standards, security, kieran-typescript, ce-learnings-researcher sonnet). `ce-agent-native-reviewer` skipped per PEvO root CLAUDE.md. `ce-adversarial-reviewer` skipped (production change ~6 lines, no auth/payments/mutations; well below the 50-line threshold). Cluster-3 architect triage produced 2 items to address.

### Items to address

1. **(P2 kieran-typescript, anchor 90)** `searchReviewsFromHaf` sort param not tightened — sweep incomplete. The round-2 sweep tightened `searchPapersFromHaf` (signature around `backend/src/routes/search.ts:46`) and `searchFromHaf` (signature around `:263`) to `sort: SearchSort`, but `searchReviewsFromHaf` at `backend/src/routes/search.ts:162` retains `sort: string`. The two call sites in `searchFromHaf` now pass a `SearchSort`-typed argument to a `string`-typed parameter — TypeScript accepts this because `SearchSort` is assignable to `string`, so the mismatch is invisible to the checker. Currently inert (the function only uses `sort` for a hardcoded `ORDER BY 'c.created DESC'`), but the sweep was supposed to thread through all 3 internal functions and this is 1 of 3 missed. The asymmetry defeats the point of the sweep and will silently widen again if a relevance-sort branch is ever added to the reviews function.

   Fix: change `searchReviewsFromHaf`'s `sort` parameter from `sort: string` to `sort: SearchSort`. Import is already present in the file. One-line touch.

2. **(P3 testing+kieran-typescript, anchor 100 cross-reviewer)** No `?sort=relevance` → 200 happy-path test. Round-2 added `?source=native` → 200 and `?source=bridge` → 200 specs because `isSearchSource` had no incidental coverage. The same rationale applies to `?sort=relevance`: the only spec sending `sort=relevance` is the repeated-param 400 test at `backend/tests/routes/search.test.ts:195-200`. `?sort=date` is incidentally covered by accreditation-gate tests further down; `?sort=relevance` has zero happy-path coverage anywhere in the file. An accidentally inverted `isSearchSort` (e.g. `!includes()` typo) would 400 every request with `?sort=relevance`, and no spec in the file would catch it.

   Fix: add one route-level spec mirroring the `?source=native` / `?source=bridge` pattern at `backend/tests/routes/search.test.ts:218-237`:

   ```ts
   it('?sort=relevance returns 200', { timeout: 60_000 }, async () => {
     const res = await request(app).get('/api/search?q=science&sort=relevance');
     expect(res.status).toBe(200);
     expect(res.body.status).toBe('ok');
   });
   ```

### Items dismissed during architect triage

- (P3 project-standards PS-001, anchor 75) Re-review signal heading format `(2026-05-16, round-2)` vs backend-CLAUDE.md spec `(<date>, working tree or commit SHA):` — dismissed as cosmetic. The architect locates commits via `git log` regardless of the parenthetical content. Worth a backend-protocol nudge (systemic across the session's 3 backend commits) but not held on any individual task.
- (P3 testing T-2, anchor 65) `isSearchSource`/`isSearchSort` lack case-sensitivity symmetry with `isSearchType` — dismissed per `feedback_dismiss_preemptive_test_hardening`. All three guards share the identical `(SEARCH_X as readonly string[]).includes(s)` implementation; the failure mode is theoretical-only (no live drift, no pending refactor that would touch one without the others).
- (P3 sub-confidence) KT-2/KT-3 anchor 50; MAINT-RR anchor 50 — below confidence gate.

### Items handed to separate architect actions (not held on this task)

- (Learnings advisory) `backend/src/routes/papers.ts:477,479,517-519` is a known-remaining `req.query.x as string` sweep target per the `req-query-as-string-cast-silent-coerce-2026-05-16` learning. Out of scope for this task; the architect should verify a follow-up `backend-papers-query-cast-sweep` task exists in `tasks/pending/` or file one before archiving the cluster.
- Vitest was deferred per the signal block; the architect should confirm a green Vitest pass on the parent serialized run before archiving the cluster.

### Re-review signal

When both items above land, `git mv` this file back to `tasks/review/`. Round-3 architect re-review scopes `/ce-code-review` to the round-3 commit. Anchor: item 1 is a one-line touch at `search.ts`; item 2 is a one-spec addition at `search.test.ts`. Single commit reasonable.

## Backend re-review signal (2026-05-16, round-3, worktree-agent-a450a90fb195aaf76)

Both round-3 hold items landed in a single commit. Parent re-took over after worker subagent was killed (silently, no notification) while the work was complete on disk but uncommitted; parent ran tsc/lint, appended this signal block, and committed.

- **Item 1 [P2]** — `backend/src/routes/search.ts` `searchReviewsFromHaf` signature tightened from `sort: string` to `sort: SearchSort`. The `SearchSort` import was already present in the file. One-line touch.
- **Item 2 [P3]** — `backend/tests/routes/search.test.ts` gains one new spec: `?sort=relevance` happy-path returns 200. Mirrors the `?source=native` / `?source=bridge` happy-path pattern at lines ~218-237. Closes the "inverted `isSearchSort` predicate would silently 400 every relevance request" coverage gap.

`npx tsc --noEmit` clean. `npm run lint` clean (only the 2 pre-existing `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts`, unrelated). Targeted vitest deferred to the parent's serialized run after all in-flight backend tasks merge back.

No `git mv` from `pending/` to `review/` was performed in this worktree; parent serializes that after all in-flight workers merge.

## Architect re-review (2026-05-18, round-3 → round-4) — HELD PENDING FIXES:

`/ce-code-review` ran on commit `9335aef` with 6 personas (correctness opus; testing, maintainability, project-standards, kieran-typescript, ce-learnings-researcher sonnet). `ce-agent-native-reviewer` skipped per PEvO root CLAUDE.md. `ce-adversarial-reviewer` skipped (production change 1 line, no auth/payments/mutations; well below the 50-line threshold). Round-3 items 1 (signature tighten) and 2 (`?sort=relevance` happy-path) both confirmed landed at `9335aef`; sweep is now exhaustive (`grep -n 'sort: ' backend/src/routes/search.ts` shows 4 hits, all `SearchSort`). Cluster-3 architect triage produced 1 new item to address.

### Items to address

1. **(P2 maintainability+kieran-typescript, anchor 100 cross-reviewer)** `searchReviewsFromHaf` now accepts narrowed `sort: SearchSort` but the body ignores it. At `backend/src/routes/search.ts:213`, `orderBy` is hardcoded to `'c.created DESC'` regardless of the `sort` argument. The round-3 type-narrowing achieved the symmetry it was meant to (call sites in `searchFromHaf` at `:289` and `:312` now flow `SearchSort` → `SearchSort` without widening), but the narrower signature now implies behavior the function does not provide. A reader at the call site reasonably assumes `sort='relevance'` will change ordering for reviews; it won't. The next developer adding relevance-ranking to reviews may miss that the parameter is already accepted-and-discarded.

   Architect-decision baked into the fix: this is the round-2 architect-explicit symmetry-with-future-relevance-ranking decision (round-2 hold item 1 chose "narrow the type, keep the param" over "remove the param"). The right fix is NOT to remove the parameter — that undoes round-2. The right fix is to document the intentional discard at the code site so the architect's symmetry rationale is self-explanatory without archive-spelunking.

   Fix: add a short WHY comment at `backend/src/routes/search.ts:213` (immediately before `const orderBy = 'c.created DESC';`) along the lines of:

   ```ts
   // sort accepted for signature symmetry with searchPapersFromHaf;
   // relevance-ranking for reviews is not yet implemented. When it is,
   // wire the sort value through here (and add a ?type=review&sort=relevance
   // happy-path spec at search.test.ts).
   ```

   No production-behavior change; no new test required.

### Items dismissed during architect triage

- (P3 advisory, cross-reviewer correctness+testing anchor 100) Commit message body of sibling cluster commit `bba29c0` undercounts the round-2 canary's asserted fields (says "asserts 4", actual is 6); in-tree comment is accurate — dismissed. Commit message is git-immutable; adding archive-note metadata would be preemptive documentation hardening (cousin of `feedback_dismiss_preemptive_test_hardening`). Anyone reading the diff resolves the discrepancy in seconds.
- (P3 testing TG-1) `?sort=date` happy-path only incidentally covered by accreditation-gate tests — dismissed per `feedback_dismiss_preemptive_test_hardening`. Coverage is present and stable; a dedicated spec would harden against hypothetical future deletion of the gate-coverage.
- (P3 kieran-typescript TG-02) No `?type=review&sort=relevance` test — dismissed as preemptive (currently harmless because `sort` is ignored in that branch; only becomes relevant after the item-1 comment lands and a future relevance-for-reviews implementation arrives — at which point the spec is part of THAT task, not this one).
- (P3 project-standards RR-1) Task file remained in `tasks/pending/` after round-3 fix landed — dismissed. Backend CLAUDE.md sequence (b) explicitly permits "signal block in commit N, `git mv` in commit N+1". The mv has since happened (file is currently in `tasks/review/` at round-4 intake, presumably moved by the parent serialized run); loose end closed.

### Items handed to separate architect actions (still on the architect's backlog)

- (Learnings advisory, carried from round-3) `backend/src/routes/papers.ts:477,479,517-519` is a known-remaining `req.query.x as string` sweep target per the `req-query-as-string-cast-silent-coerce-2026-05-16` learning. The architect should verify a follow-up `backend-papers-query-cast-sweep` task exists in `tasks/pending/` or file one before final cluster archive (after round-4 lands).
- Vitest deferred per signal block; verify green on parent serialized run before final cluster archive.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. Round-4 architect re-review scopes `/ce-code-review` to the round-4 commit. Anchor: single short comment addition at one location. Trivial single commit.
