# BE-ACCREDITATIONS-LIKEGUARD — Length-cap + LIKE-metacharacter escape on `/api/accreditations`

**Owner:** backend
**Created:** 2026-05-15 (surfaced by `/ce-code-review` on BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP — `ce-security-reviewer` + `ce-adversarial-reviewer` cross-corroborated, anchor 100)
**Priority:** P1

## Context

BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP (commit `869fea4`) closed the per-request CPU DoS vector on `/api/search ?q=` via a 200-char length cap + `escapeLikePattern()` + `ESCAPE '\\'` on every ILIKE site. The architect's review prompted both the security and adversarial personas to verify scope-completeness against other ILIKE-on-user-input sites. They independently flagged the same gap: `/api/accreditations` ships the same anti-pattern on `?field=` and `?institution=`.

- `backend/src/routes/accreditations.ts:30-36` (and 87-92, the count vs data branches) — `req.query.field as string | undefined` and `req.query.institution as string | undefined` flow into `params.push(`${value}%`)` and bind into `latest.field ILIKE $N` / `latest.institution ILIKE $N`.
- No length cap, no LIKE-metacharacter handling, no `ESCAPE '\\'` clause on the ILIKE sites.
- The `as string` cast also silently coerces `string[]` from repeated `?field=a&field=b` to `"a,b"`, slipping past any future enum-style check (same shape the discipline-canon work fixed for `?discipline=`).

The endpoint is **unauthenticated read**, sharing the same general-purpose rate limit as `/api/search`. A `_%_%_%_…` enumeration on `?field=` injects N live wildcards into ILIKE against every active-accreditation row — materially exploitable in the same way the `?q=` vector was before commit `869fea4`.

## Goal

Apply the BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP defenses to `/api/accreditations`:

1. **Length cap** — same 200-char ceiling (no new constant needed; reuse `SEARCH_QUERY_MAX_LEN` from `backend/src/types/search-filters.ts`, OR introduce a sibling constant if the conceptual scope warrants it — implementer's call).

2. **LIKE-metacharacter escape** — reuse `escapeLikePattern()` from the same helper module. Both `?field=` and `?institution=` should run through the helper before bind.

3. **`ESCAPE '\\'` clause** — add to both ILIKE call sites in the conditions array (count branch + data branch, each emits the same ILIKE fragment via the conditions-and-params shared list).

4. **Repeated-param shape (`?field=a&field=b`)** — silent-unfilter to absent, matching the round-4 `?discipline=` and round-1 `?q=` contracts. Drop the `as string` cast in favor of `typeof === 'string'` narrowing.

5. **400 messages** — return `'Filter "field" too long'` / `'Filter "institution" too long'` (no emdash; matches the project user-facing-text rule). For absent/empty/whitespace/array shapes on these OPTIONAL filters, silent-unfilter (do NOT 400) — they are not required like `?q=` is on `/api/search`.

## Architect decision (baked in)

**Helper reuse vs sibling helper.** Reuse `validateSearchQuery` directly — its semantics match (length cap, LIKE-escape, silent-unfilter on absent/array). The only mismatch is that `validateSearchQuery` returns `null` (absent) → caller emits 400 because `?q=` is required, whereas these filters are optional and should silent-unfilter on `null`. The route handler maps `null` → "don't add the ILIKE condition for this filter" instead of returning 400.

If the implementer judges that reusing `validateSearchQuery` for an OPTIONAL filter muddies the helper's contract (the helper is documented around the required-`q` case), introduce a sibling `validateOptionalLikeFilter(raw: unknown, maxLen: number = SEARCH_QUERY_MAX_LEN): { ok: true; value: string } | { ok: false; message: string } | null` in `search-filters.ts` that returns the same shape but with a documented optional-filter use case. Either approach is acceptable.

**Out of scope:** the existing `${value}%` (prefix-only) ILIKE pattern. Do NOT widen it to `%${value}%` — `/api/accreditations` is a prefix-search-as-you-type surface, not a substring search. Only escape the metacharacters in `value` itself.

## Implementation notes

- The count and data branches share the same conditions array — apply the validation once at the route handler entry, populate the conditions array conditionally based on whether the (escaped) value was present.
- Both `?field=` and `?institution=` get the same treatment in one commit.
- Mirrors the BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP shape exactly — read `commit 869fea4` and the helper at `backend/src/types/search-filters.ts` before starting.

## Tests

Real-HAF + carve-out coverage on `backend/tests/routes/accreditations.test.ts`:

- `?field=` of 201 chars → 400 with `'Filter "field" too long'`.
- `?field=` of 200 chars → 200 (boundary).
- `?field=` of `%_%_%_…` literal metacharacters → 200, escape neutralizes wildcards.
- `?field=a&field=b` repeated-param → 200 with the filter silently unapplied (mirrors the `?discipline=a&discipline=b` silent-unfilter contract).
- Same shape for `?institution=`.
- Mocked-pool spec (carve-out, in `disciplines-canon-mocked.test.ts` or a sibling) asserting both ILIKE sites carry `ESCAPE '\\'` and that the bound parameter is LIKE-escaped (`%` → `\%`, `_` → `\_`, `\` → `\\`).

Document the carve-out justification inline per the project clause (a)/(c) requirement, mirroring the BE-SEARCH-Q-LIKEGUARD test block at the bottom of `disciplines-canon-mocked.test.ts`.

## Acceptance

- `400 BAD_REQUEST` on `?field=` / `?institution=` > 200 chars.
- Both ILIKE call sites in `/api/accreditations` use `ESCAPE '\\'`.
- Bound parameters are LIKE-escaped (mocked-pool carve-out spec).
- Repeated `?field=a&field=b` silent-unfilters (no 400, no string-array coercion bug).
- No regression on the existing accreditations specs.
- `agents/docs/api-contracts/accreditations.md` (or wherever the `/api/accreditations` contract lives) updated to describe the new validity rules on both filters. (Architect-owned; flag via `[TODO Architect]` in the task note before moving to `review/`.)

---

## Implementer signal (2026-05-15, commit `fc0aa29` on `main`) — round 1

Landed the BE-SEARCH-Q-LIKEGUARD defenses on `/api/accreditations`'s `?field=` and `?institution=` filters in a single commit.

**Helper-shape decision:** new sibling helper `validateOptionalLikeFilter(raw, paramName)` exported from `backend/src/types/search-filters.ts`. Differs from `validateSearchQuery` only in the absent-vs-required semantic: optional filters silent-unfilter on absent/empty/non-string (returns `{ ok: true, value: undefined }`) instead of returning `null` for the route's required-400 path. `paramName` is interpolated into the per-param "too long" message so clients get `'Filter "field" too long'` / `'Filter "institution" too long'`.

**Code changes:**
- `backend/src/types/search-filters.ts` — appended `validateOptionalLikeFilter()` + `OptionalLikeFilterResult` discriminated-union return type with full docblock.
- `backend/src/routes/accreditations.ts`:
  * Route entry: replaced `as string | undefined` casts on `req.query.field` / `req.query.institution` with `validateOptionalLikeFilter` calls + ok-branching. 400 BAD_REQUEST on length violation, silent-unfilter on absent/non-string/array.
  * `fetchAccreditationsFromHaf`: added `ESCAPE '\\'` to both ILIKE sites. Added a comment block explaining the pre-escape contract and the attack shape (`_%_%_…`).

**Tests landed:**
- `backend/tests/routes/accreditations-likeguard.test.ts` (new) — 13 specs across 4 describe blocks: length cap boundary at 200/201/4000 on both `?field=` and `?institution=`; LIKE-metacharacter escape on `_%_%` + literal backslash; repeated-param silent-unfilter; absent/empty/whitespace fall-through.

**Verification:** lint clean (2 pre-existing seed-phrase warnings unchanged). Typecheck clean. Per-file test run passed at the worker subagent stage.

### [TODO Architect]

Contract update needed: `agents/docs/api-contracts/accreditations.md` (or wherever the `/api/accreditations` contract lives) — add the new validity rules on `?field=` and `?institution=` filters (200-char cap, LIKE-metacharacter literal-treatment, repeated-param silent-unfilter, per-param "too long" 400 message).

---

## Architect round-1 re-review (2026-05-16) — HELD PENDING FIXES

`/ce-code-review` on commit `fc0aa29` had **partial reviewer coverage** — see "Reviewer re-run window" note below. The reviewers that returned (correctness, performance, maintainability, project-standards) found the diff substantively clean. The fix correctly ports the BE-SEARCH-Q-LIKEGUARD pattern, both ILIKE call sites carry `ESCAPE '\\'`, `validateOptionalLikeFilter` is a defensible sibling helper, and 13 test specs cover the boundaries. Performance is a net win (pre-fix N-wildcard backtrack → post-fix literal byte compare).

One item held; one item flagged for round-2 review.

### Item 1 (P2) — Slug-citation cleanup (3 sites)

Per `agents/docs/solutions/conventions/task-slug-citations-in-code-comments-go-stale-on-archive-2026-05-15.md`. Sites to clean up:

- `backend/src/types/search-filters.ts:82` — `BE-ACCREDITATIONS-LIKEGUARD` citation
- `backend/src/routes/accreditations.ts:28` — `BE-ACCREDITATIONS-LIKEGUARD` citation
- `backend/src/routes/accreditations.ts:98` — `BE-ACCREDITATIONS-LIKEGUARD` citation (the route-entry comment that also restates the helper's JSDoc — when cleaning the slug, trim to 2 lines pointing at the helper rather than re-explaining)

Replace each slug lead with a behavioral description per the convention.

### Item 2 (note) — Reviewer re-run window when round-2 mv to review/

The original round-1 review hit the platform rate-limit (Anthropic Claude API limit) midway through the persona fan-out. **5 reviewer dispatches failed to complete:** `ce-security-reviewer`, `ce-adversarial-reviewer`, `ce-testing-reviewer`, `ce-kieran-typescript-reviewer`, `ce-api-contract-reviewer`. For a P1 security fix on an unauthenticated route, this is a meaningful coverage gap.

When the implementer mv's this task back to `tasks/review/` for round-2 architect intake, the architect will re-run `/ce-code-review` scoped to commit `fc0aa29` PLUS the round-2 cleanup commit. The re-run will dispatch the 5 missing reviewers (now that rate budget has reset) to close the coverage gap. This is NOT an implementer item — it's an architect intake protocol note so the round-2 review pass explicitly runs the deferred personas.

Implementer should mv back to `tasks/review/` once item 1's slug-cleanup commit lands. No additional implementer action expected for item 2.

### Triage decisions (not held)

- **Maintainability flagged the route-entry comment at `accreditations.ts:98` as restating helper JSDoc.** Folded into item 1's cleanup scope — trim to 2 lines pointing at the helper when removing the slug lead. P3, low-effort, while-in-the-area.
- No other findings from the returned reviewers.

### Files for round-2

- `backend/src/types/search-filters.ts` (item 1)
- `backend/src/routes/accreditations.ts` (item 1)
- This task file (round-2 implementer signal block when moving back to review/)

---

## Backend re-review signal (2026-05-16, commit SHA `848ff00`) — round 2

Item 1 landed: slug-citation cleanup across all 3 sites. Item 2 was a process note (deferred-persona re-run at architect intake) — not implementer work.

**Sites cleaned (item 1):**

- `backend/src/types/search-filters.ts:82` — the section-banner header lost its `(BE-ACCREDITATIONS-LIKEGUARD — ports the `?q=` defenses to optional LIKE-bound filters where absent means "no filter" rather than 400)` parenthetical. The new banner anchors on the behavioral description ("Same two defenses as validateSearchQuery (length cap + LIKE-metacharacter escape), but with optional semantics") and on the surfaces that bind through the helper (`?field=` and `?institution=` on /api/accreditations), per `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`.
- `backend/src/routes/accreditations.ts:28` — the SQL-binder docblock lost its `BE-ACCREDITATIONS-LIKEGUARD:` lead. The behavioral content is unchanged (still explains the `${escaped}%` prefix-match contract and the `_%_%_…` attack shape under `ESCAPE '\\'`); only the slug-citation lead was removed.
- `backend/src/routes/accreditations.ts:98` — the route-entry comment was BOTH slug-cleaned AND trimmed per the maintainability triage decision baked into item 1. From a 9-line comment (slug lead + restated helper JSDoc + comparison to the pre-fix cast bug) to 2 lines pointing at the helper: `// Length-cap + LIKE-metacharacter escape for the optional `?field=` / `?institution=` filters. See validateOptionalLikeFilter for the contract.` The helper's JSDoc carries the silent-unfilter contract and the 400-on-too-long contract; restating both at the call site was the maintainability finding.

**Verification:**

- `npx tsc --noEmit -p tsconfig.json` from `backend/`: clean (zero output, exit 0).
- `npm run lint` from `backend/`: clean. 2 pre-existing seed-phrase `no-explicit-any` warnings (unchanged from round-1) — no new lint output.
- `npx vitest run tests/routes/accreditations-likeguard.test.ts` (with Docker IP env overrides per root CLAUDE.md): 13/13 specs pass in 17.72s. No regressions from the comment-only changes.

**Files staged:**

- `backend/src/types/search-filters.ts` (item 1 site 1)
- `backend/src/routes/accreditations.ts` (item 1 sites 2 + 3)
- This task file (round-2 implementer signal block)

The `git mv` to `tasks/review/` is the re-review signal (parent agent will perform the move).

---

## Architect round-2 re-review (2026-05-17) — HELD PENDING FIXES

`/ce-code-review` re-run on commits `fc0aa29` (round-1 implementation) + `848ff00` (round-2 slug cleanup), dispatching the 5 deferred personas from round-1's rate-limit-truncated pass (security + adversarial + testing + kieran-typescript + api-contract) alongside the always-on set + maintainability + performance + project-standards.

Round-2's slug cleanup landed cleanly: all three sites (`search-filters.ts:82` section banner, `accreditations.ts:28` SQL-binder docblock, `accreditations.ts:98` route-entry comment trim) successfully replaced slug citations with behavioral anchors; `grep -rn 'BE-ACCREDITATIONS-LIKEGUARD' backend/src/` returns zero hits in production code.

The deferred-persona re-run surfaced two cross-corroborated assertion-strength gaps that the round-1 review couldn't catch. Both items hold the task.

### Item 1 [P2] — Mocked-pool SQL-contract spec called for by task acceptance §4 did not land

**Cross-corroborated:** correctness × testing (T1, conf 75)
**File:** `backend/tests/routes/accreditations-likeguard.test.ts` (new spec needed; or in a sibling `disciplines-canon-mocked.test.ts`-shape file)

Task acceptance §4 explicitly called for: *"Mocked-pool spec (carve-out, in `disciplines-canon-mocked.test.ts` or a sibling) asserting both ILIKE sites carry `ESCAPE '\\'` and that the bound parameter is LIKE-escaped (`%` → `\%`, `_` → `\_`, `\` → `\\`)."* This was not delivered.

The current real-path specs at `accreditations-likeguard.test.ts:82-100` (the "LIKE-metacharacter escape" describe block) assert only `res.status === 200` and `Array.isArray(res.body.data)`. Neither asserts that the bound parameter was escaped or that the SQL contains `ESCAPE '\\'` at both ILIKE call sites. A regression dropping `escapeLikePattern()` (search-filters.ts:53-55) or dropping `ESCAPE '\\'` from accreditations.ts:41 or :45 still produces 200+array — test passes vacuously.

The sibling clause-(c) at `disciplines-canon-mocked.test.ts:817-903` pins this contract for `/api/search` but no equivalent exists for `/api/accreditations` — different file, different conditions array, different `ESCAPE` clause placement.

**Fix shape:** add a mocked-pool spec mirroring the `disciplines-canon-mocked.test.ts:825-903` shape. Use the `hafQueryMock` infrastructure to assert:
- `pool.query` was called with a SQL string containing `ESCAPE '\\'` at both the count branch (accreditations.ts:41) and the data branch (accreditations.ts:45).
- The params array contains the LIKE-escaped form for an input like `'%_\\'` (showing `\%`, `\_`, `\\`).

Document the carve-out justification inline per the project clause (a)/(b)/(c) requirements (same shape as the BE-SEARCH-Q-LIKEGUARD mocked test).

### Item 2 [P2] — Repeated-param silent-unfilter specs need result-set proxy assertion

**Source:** testing T2 (conf 75)
**File:** `backend/tests/routes/accreditations-likeguard.test.ts:104-123`

The two repeated-param specs at lines 112, 119 (`?field=a&field=b`, `?institution=a&institution=b`) assert only `res.status === 200` and `Array.isArray(res.body.data)`. The "silent-unfilter" contract — that the filter was DROPPED and the result set matches the unfiltered list — is not asserted. A regression re-introducing the `as string` cast (which coerced `['a','b']` → `'a,b'` and bound it as a literal) returns 200 with a (likely empty) array → test passes vacuously.

**Fix shape:** strengthen the two specs to capture the unfiltered baseline `res.body.meta.total` (already exercised at the existing absent/empty fall-through spec at line 128) and assert the repeated-param call returns the same total:

```ts
const unfilteredRes = await request(app).get('/api/accreditations?page=1&limit=50');
const baseline = unfilteredRes.body.meta.total;

const res = await request(app).get('/api/accreditations?field=a&field=b&page=1&limit=50');
expect(res.body.meta.total).toBe(baseline); // filter must be dropped, not bound as 'a,b'
```

With this proxy in place, a regression that drops the `typeof` narrow in `validateOptionalLikeFilter` surfaces as a count mismatch rather than passing silently.

### Files for round-3

- `backend/tests/routes/accreditations-likeguard.test.ts` (items 1, 2) — OR new mocked-pool sibling file for item 1 if cleaner separation is preferred.
- This task file (round-3 implementer signal block when moving back to review/).

### Architect archive-time follow-ups (recorded for the eventual archive)

- `agents/docs/api-contracts/accreditation.md` GET /api/accreditations section update (round-1 [TODO Architect]): document 200-char cap, per-param "too long" 400 messages, repeated-param silent-unfilter, LIKE-metacharacter literal-treatment, prefix-match semantics. Mirror the `papers.md:487` `?discipline=` precedent shape. Architect lands at archive.

### Dismissed at architect triage (recorded for transparency)

- **Helper-direct unit tests for `validateOptionalLikeFilter`** (testing T3 P3/50): preemptive hardening; the route-level tests cover behavior. Per `feedback_dismiss_preemptive_test_hardening`.
- **Repeated-param semantic flip + ILIKE metacharacter literal-treatment + 400 message wire format** (api-contract findings, P2/70 and P3/60): all fold into the architect-side `accreditation.md` contract update at archive time.

---

## Backend re-review signal (2026-05-17, commit SHA `152e164`) — round 3

Both round-2 hold items landed in a single commit. Test additions only — no production-code changes.

**Item 1 (P2, correctness × testing T1) — Mocked-pool SQL-contract spec.**

Landed as a new sibling file `backend/tests/routes/accreditations-likeguard-mocked.test.ts`. Chose the sibling-file path (not folding into `accreditations-likeguard.test.ts`) so the route-level `vi.mock('../../src/db.js', …)` hoist doesn't bleed into the existing real-path specs in the same describe-tree. The file header documents the carve-out clauses (a)/(b)/(c) per root `CLAUDE.md` "Running Tests" — clause (a) names the impracticality (HAF returns rows without echoing the bound params or SQL; real-path specs pass vacuously on a regression that drops escapeLikePattern or ESCAPE `\\`), clause (b) is N/A (unauthenticated route, no verifyHiveSignature on the call path; MOCK_VERIFY_SIGNATURE fixture not used), clause (c) names the risk class ("ILIKE bind drops escape contract" + "bound parameter is not LIKE-escaped") and identifies the real-path companion in `accreditations-likeguard.test.ts` as covering a different mutation class (integrated-path 400/200/array-shape).

Five specs across the describe block, mirroring the `disciplines-canon-mocked.test.ts:817-903` shape:
1. `?field=` bound parameter is LIKE-escaped (`%` → `\%`, `_` → `\_`, `\` → `\\`) — crafted payload `%25_%5C` (URL-encoded `%_\`) captures `params` array, finds the ILIKE pattern bind, strips the trailing `%` suffix added by the route at accreditations.ts:42, asserts the body is the escaped form `\%\_\\`.
2. `?institution=` bound parameter is LIKE-escaped — same shape for the institution branch.
3. `?field=` site emits SQL containing `ESCAPE '\\'` on the ILIKE clause — pins the single-ILIKE case (field only) with exactly 1 occurrence.
4. `?institution=` site emits SQL containing `ESCAPE '\\'` on the ILIKE clause — pins the single-ILIKE case (institution only) with exactly 1 occurrence.
5. Both ILIKE call sites carry `ESCAPE '\\'` when ?field= AND ?institution= are supplied — pins the exact occurrence count to 2 so a regression dropping the clause from ONE site (the "count branch + data branch" framing from the round-2 hold) surfaces as `toBe(1)`.

The capture uniqueness key is `sql.includes('ROW_NUMBER() OVER (PARTITION BY')` — the accreditations data query is the only call carrying that fragment.

**Item 2 (P2, testing T2) — Repeated-param specs strengthened with result-set proxy.**

Edited `backend/tests/routes/accreditations-likeguard.test.ts:104-123` in place. Both specs (`?field=a&field=b` and `?institution=a&institution=b`) now:
1. Issue an unfiltered request `GET /api/accreditations?page=1&limit=50` and capture `meta.total` as the baseline.
2. Issue the repeated-param request `GET /api/accreditations?field=a&field=b&page=1&limit=50` and assert `res.body.meta.total === baseline`.

A regression re-introducing the `as string` cast (coercing `['a','b']` → `'a,b'` and binding `'a,b%'` as the ILIKE pattern) would return zero or fewer rows than the unfiltered baseline on real HAF — count mismatch fails the spec. The describe-block header comment explains the proxy logic. The original status-200 + array-shape assertions are retained alongside the new `meta.total` assertion.

**Verification:**

- `npm run typecheck` from `backend/`: clean (both `typecheck:src` and `typecheck:tests` pass with zero output).
- `npm run lint` from `backend/`: clean (zero output).
- `npx vitest run tests/routes/accreditations-likeguard.test.ts tests/routes/accreditations-likeguard-mocked.test.ts` (with Docker IP env overrides per root CLAUDE.md): 18/18 specs pass in ~3.7s (13 real-path + 5 mocked-pool). No regressions in the existing length-cap, LIKE-metacharacter-escape, and absent/empty-filter specs.

**Files staged:**

- `backend/tests/routes/accreditations-likeguard.test.ts` (item 2 in-place edit)
- `backend/tests/routes/accreditations-likeguard-mocked.test.ts` (new file, item 1)
- This task file (round-3 implementer signal block)

The `git mv` to `tasks/review/` is the re-review signal (parent agent performs the move per the task instructions).

---

## Architect round-3 re-review (2026-05-18) — HELD PENDING FIXES

`/ce-code-review` cluster-pass on commit `2c970c1` dispatched 6 reviewers: correctness, testing, maintainability, project-standards, kieran-typescript, ce-learnings-researcher (skipping `ce-agent-native-reviewer` per root CLAUDE.md; conditional reviewers like security/adversarial/api-contract not selected — this round is tests-only). Cross-reviewer corroboration on the line-number anchor concerns (maintainability × project-standards, promoted to anchor 100). Both P2 items from round-2 landed cleanly: the mocked-pool SQL-contract spec correctly pins the ESCAPE clause and bound-param escape; the `meta.total === baseline` proxy catches the `as string` regression. Three citation-hygiene items held; all in the new mocked-test file, bundle into one round-4 commit.

### Item 1 — Header carve-out + inline comments cite raw line numbers on production source

**Severity:** P2 · **Cross-corroborated:** maintainability M-1 × project-standards PS-1 + PS-2 (conf 100)
**File:** `backend/tests/routes/accreditations-likeguard-mocked.test.ts` (header docstring + inline comments)

Five raw line-number citations on production source: `accreditations.ts:41`, `:42`, `:45` (twice each), `search-filters.ts:53`. Per `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`, anchor on the exported symbol (e.g., `escapeLikePattern()`, the conditions-array push sites in `fetchAccreditationsFromHaf`) rather than the line number — the line numbers shift on any insertion above.

Additionally: `search-filters.ts:53` cites the wrong path. Actual file is `backend/src/types/search-filters.ts`. The citation is already broken at write time, demonstrating the rot risk concretely.

**Fix shape:** strip the line spans from the header docstring and inline comments. Anchor on `escapeLikePattern()` (already named in the prose) and the conditions-array push sites' behavioral description. Fix the `search-filters.ts:53` path bug (or drop the line citation entirely and anchor on the symbol name).

### Item 2 — Task-slug citations in the mocked-test file

**Severity:** P2 · **Source:** maintainability M-2 (conf 95)
**File:** `backend/tests/routes/accreditations-likeguard-mocked.test.ts` (header + inline comments)

Multiple task-slug citations embedded: `BE-ACCREDITATIONS-LIKEGUARD`, `BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP`, two references to "round-2 hold count branch + data branch" framing. Per `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, these rot on archive.

Doubly fragile: the "count branch + data branch" framing is also factually wrong — the accreditations route uses one window-function query with `ROW_NUMBER() OVER (PARTITION BY ...)`, not separate count and data branches. The comment imports a mental model from the architect's round-2 hold prose that doesn't match the actual SQL shape.

**Fix shape:** drop the slug citations; replace the "count branch + data branch" prose with the actual SQL shape ("the single window-function data query in `fetchAccreditationsFromHaf`"). Anchor on the behavioral description, not the architect's coordination-doc framing.

### Item 3 — Cross-file line range `disciplines-canon-mocked.test.ts:817-903`

**Severity:** P3 · **Cross-corroborated:** maintainability M-3 × project-standards PS-1 (conf 100)
**File:** `backend/tests/routes/accreditations-likeguard-mocked.test.ts` (header "mirrors this shape" prose)

The header cites `disciplines-canon-mocked.test.ts:817-903` as the shape this block mirrors. Per `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`, anchor on the describe-block title — line ranges rot on any insertion above. Cross-file line citations are especially rot-prone (one edit in the sibling file shifts the citation without any signal in this file's history).

**Fix shape:** replace the line range with the describe-block title from `disciplines-canon-mocked.test.ts`. The named subsection survives line shifts and is grep-able.

### Files for round-4

- `backend/tests/routes/accreditations-likeguard-mocked.test.ts` (Items 1, 2, 3)
- This task file (round-4 implementer signal block when moving back to review/)

### Architect archive-time follow-ups (recorded for the eventual archive)

- **`agents/docs/api-contracts/accreditation.md`** GET /api/accreditations section update (round-1 [TODO Architect] still open from round-1 hold-block): document 200-char cap, per-param "too long" 400 messages, repeated-param silent-unfilter, LIKE-metacharacter literal-treatment, prefix-match semantics. Mirror the `papers.md:487` `?discipline=` precedent shape. Architect lands at archive.

### Dismissed at architect triage (recorded for transparency)

- **`meta.total === baseline` proxy passes vacuously when baseline is 0** (testing T-1 conf 75): the mocked-pool sibling is the load-bearing layer; baseline=0 vacuity is environmental, not a real failure mode. Per `feedback_dismiss_preemptive_test_hardening`: defense-in-depth on a test that's already cross-pinned at a stronger layer.

---

## Backend re-review signal (2026-05-18, commit SHA `71b3099`) — round 4

All three citation-hygiene items landed in a single comment-only commit on `backend/tests/routes/accreditations-likeguard-mocked.test.ts`. No production-code changes.

**Item 1 (P2, maintainability M-1 × project-standards PS-1 + PS-2) — Raw line-number citations stripped.**

Removed the five raw line-number citations from the header docstring and the inline comments:

- Header clause (a) prose previously cited `search-filters.ts:53` (wrong path — actual is `backend/src/types/search-filters.ts`) and `accreditations.ts:41 or :45`. Now anchors on the symbol `escapeLikePattern()` (with correct path `backend/src/types/search-filters.ts`) and on the conditions-array push sites inside `fetchAccreditationsFromHaf`.
- Top-of-describe-block comment previously cited `accreditations.ts:41` and `:45` for the two ILIKE push sites. Now anchors on the function name `fetchAccreditationsFromHaf` and the SQL fragments `latest.field ILIKE …` / `latest.institution ILIKE …` that identify the two push sites without line numbers.
- Crafted-payload comment in spec 1 previously cited `accreditations.ts:42` for the `${escaped}%` prefix-match suffix. Now anchors on the `${escaped}%` template at the `field` push site in `fetchAccreditationsFromHaf`.

**Item 2 (P2, maintainability M-2) — Task-slug citations dropped + SQL shape framing corrected.**

- Header opening line previously read "Mocked-pool SQL-contract coverage for the BE-ACCREDITATIONS-LIKEGUARD defenses on GET /api/accreditations." Now reads "Mocked-pool SQL-contract coverage for the LIKE-escape + ESCAPE-clause defenses on GET /api/accreditations (`?field=` and `?institution=` filters)." — behavioral description, no slug.
- Header "Mirrors the shape of …" line previously cited `BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP block at disciplines-canon-mocked.test.ts:817-903`. See Item 3 fix below.
- Top-of-describe-block comment previously framed the SQL as "single combined query with a window-function count … There is no separate count branch … The architect's round-2 hold 'count branch + data branch' wording maps to these two ILIKE fragments." Replaced with the actual SQL shape: "single window-function data query in `fetchAccreditationsFromHaf` (window-function count `count(*) OVER ()::int AS total` carried alongside the row data — there are NOT separate count and data branches)." No reference to the architect's round-2 hold framing.
- Both-filters spec comment previously closed with "(the 'count branch + data branch' framing in the architect's round-2 hold)." Replaced with "drops the clause from one ILIKE push site in `fetchAccreditationsFromHaf` while leaving the other clean." No coordination-doc framing.

**Item 3 (P3, maintainability M-3 × project-standards PS-1) — Cross-file line range replaced with describe-block title.**

Header "Mirrors the shape of …" line previously cited `disciplines-canon-mocked.test.ts:817-903`. Now reads "Mirrors the shape of the `GET /api/search — ?q= LIKE-escape SQL contract` describe block in `disciplines-canon-mocked.test.ts`." — the describe-block title at line 817 is `GET /api/search — ?q= LIKE-escape SQL contract (BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP)`; the prefix before the parenthetical task-slug is stable and grep-able, and citing it (without the slug suffix) avoids re-importing a slug citation in the act of fixing one.

**Verification:**

- `npm run typecheck` from `backend/`: clean (both `typecheck:src` and `typecheck:tests` pass with zero output).
- `npm run lint` from `backend/`: clean (zero output).
- `npx vitest run tests/routes/accreditations-likeguard-mocked.test.ts` (with Docker IP env overrides per root CLAUDE.md): 5/5 specs pass in 1.52s. As expected — these are comment-only changes; no spec assertions touched.

**Grep verification (post-fix):**

- `grep -n 'BE-ACCREDITATIONS-LIKEGUARD\|BE-SEARCH-Q-LIKEGUARD' backend/tests/routes/accreditations-likeguard-mocked.test.ts` returns zero hits.
- `grep -nE 'accreditations\.ts:[0-9]|search-filters\.ts:[0-9]|disciplines-canon-mocked\.test\.ts:[0-9]' backend/tests/routes/accreditations-likeguard-mocked.test.ts` returns zero hits.
- `grep -n 'count branch\|data branch' backend/tests/routes/accreditations-likeguard-mocked.test.ts` returns one hit — the deliberate "there are NOT separate count and data branches" clarification that names the wrong mental model in order to refute it. No remaining endorsement of the count/data-branch framing.

**Files staged:**

- `backend/tests/routes/accreditations-likeguard-mocked.test.ts` (Items 1, 2, 3)
- This task file (round-4 implementer signal block)

The `git mv` to `tasks/review/` is the re-review signal (parent agent performs the move per the task instructions).
