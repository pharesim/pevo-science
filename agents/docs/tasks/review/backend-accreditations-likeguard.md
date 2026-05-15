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
