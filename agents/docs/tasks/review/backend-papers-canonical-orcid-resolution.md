# BACKEND-PAPERS-CANONICAL-ORCID-RESOLUTION — add supersession lookup (orcid_verified, orcid_discrepancy) to paper-detail and paper-list responses

**Owner:** Backend Agent
**Created:** 2026-05-16
**Priority:** P2
**Parent spec:** `agents/docs/tasks-archive.md` (archived `architect-orcid-typed-vs-accredited-supersession-spec`, archived 2026-05-16) — search the archive by title if needed.

## Problem

PEvO's paper endpoints (`/api/papers`, `/api/papers/:author/:permlink`) today return `authors[]` straight from chain metadata:

```json
"authors": [{ "name": "...", "hive": "alice", "orcid": "0000-0001-XXX", "affiliation": "..." }]
```

The chain-stored `orcid` is whatever the publisher typed (or prefilled from accreditation) at broadcast time. If alice is currently accredited with a different ORCID, the chain value is stale and the frontend has no way to know.

The architect spec (now archived) defined a read-time supersession rule: per `authors[i]`, look up `active_accreditations` for `authors[i].hive` and project two new fields:

- `orcid_verified` — the accreditation-attested ORCID when the hive account is currently accredited AND the accreditation carries an ORCID; null otherwise.
- `orcid_discrepancy` — `true` when both `orcid` and `orcid_verified` are present and differ; `false` otherwise.

Both surfaces (`PaperSummary` in the list endpoint, `PaperDetail` in the single-paper endpoint) need the new fields.

## Acceptance

1. **PaperDetail endpoint (`GET /api/papers/:author/:permlink`)** emits `orcid_verified` and `orcid_discrepancy` on each `authors[i]` row, per the canonical SQL pattern in `agents/docs/hive-schemas.md` § 1.1 "Canonical SQL pattern" (LEFT JOIN per author against `active_accreditations`, using the existing `activeAccreditationsCteBody` CTE).

2. **PaperSummary endpoint (`GET /api/papers`)** emits the same two fields on each `authors[i]` row. Performance: the list endpoint joins many papers' authors at once; expand the JOIN with `jsonb_array_elements WITH ORDINALITY` so the supersession lookup happens in a single query rather than per-paper round-trip.

3. **Continuation chains.** When the paper has a continuation chain, the `versions[]` array entries do NOT need supersession fields (`versions[]` is a history index, not a display rendering). Only the top-level `authors[]` array carries supersession.

4. **Null/empty handling.** Per the spec's four cases:
   - `authors[i].hive` empty/absent → `orcid_verified = null`, `orcid_discrepancy = false`.
   - `authors[i].hive` set, not currently accredited → `orcid_verified = null`, `orcid_discrepancy = false`.
   - `authors[i].hive` set, currently accredited, accreditation `orcid` is null → `orcid_verified = null`, `orcid_discrepancy = false`.
   - `authors[i].hive` set, currently accredited, accreditation `orcid` non-null → `orcid_verified = aa.orcid`. `orcid_discrepancy = true` IFF chain `orcid` is also non-null and `aa.orcid <> authors[i].orcid`.

5. **Tests.** Add tests in `backend/tests/` covering each of the four supersession cases. The carve-out for deterministic edge-case coverage (CLAUDE.md "Running Tests") applies: if HAF can't produce all four cases per-test, mock `getHafPool()` with documented justification in the test file header. Prefer real-path where feasible.

6. **No new on-chain fields.** This task is read-time projection only. Do NOT introduce a new `pevo.authors[i].verified_orcid` chain field; the spec explicitly puts that out of scope.

7. **API contract source-of-truth.** `agents/docs/api-contracts/papers.md` already documents the new fields (`orcid_verified`, `orcid_discrepancy`) on both PaperSummary and PaperDetail. The implementation must match those field semantics exactly.

## Implementation notes

- The canonical CTE lives in `backend/src/hafsql.ts:activeAccreditationsCteBody`. Reuse it directly; do not duplicate the latest-action-wins logic. See `agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md`.
- The `active_accreditations` CTE already filters to `action = 'accredit'` and exposes `orcid` per account. A simple LEFT JOIN on `aa.account = (authors[i].elem ->> 'hive')` is enough.
- Suggested SQL skeleton (paraphrased from the canonical pattern in `hive-schemas.md` § 1.1):
  ```sql
  WITH active_accreditations AS (...)  -- existing CTE
  SELECT
    p.author, p.permlink, p.title, ...,
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'name',              a.elem ->> 'name',
          'hive',              a.elem ->> 'hive',
          'orcid',             a.elem ->> 'orcid',
          'affiliation',       a.elem ->> 'affiliation',
          'orcid_verified',    aa.orcid,
          'orcid_discrepancy', CASE
                                  WHEN aa.orcid IS NOT NULL
                                   AND (a.elem ->> 'orcid') IS NOT NULL
                                   AND aa.orcid <> (a.elem ->> 'orcid')
                                  THEN true ELSE false
                                END
        )
        ORDER BY a.ordinality
      )
      FROM jsonb_array_elements(p.json_metadata -> $appTag -> 'authors') WITH ORDINALITY AS a(elem, ordinality)
      LEFT JOIN active_accreditations aa ON aa.account = (a.elem ->> 'hive')
    ) AS authors,
    ...
  FROM posts p
  WHERE ...;
  ```
- TypeScript types: extend the existing `PaperSummary['authors'][number]` and `PaperDetail['authors'][number]` types with the two new optional fields. Keep `affiliation` only on PaperDetail (PaperSummary omits it today).

## Out of scope

- UI rendering of the discrepancy indicator (see `ui-paper-detail-orcid-discrepancy-indicator`).
- Any chain-write or migration to introduce a new on-chain ORCID field.
- Reputation-algorithm changes (the supersession is display-only today per `reputation-algorithm.md` § "ORCID-keyed Aggregations").

## Cross-references

- `agents/docs/hive-schemas.md` § 1.1 — supersession rule and canonical SQL pattern.
- `agents/docs/api-contracts/papers.md` — PaperSummary and PaperDetail field documentation.
- `agents/docs/reputation-algorithm.md` § "ORCID-keyed Aggregations" — confirms no algo change needed.
- `agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md` — the latest-action-wins pattern the CTE encodes.
- `backend/src/hafsql.ts:activeAccreditationsCteBody` — the existing CTE to reuse.

## Backend implementation signal (2026-05-16, round-1 — working tree of this commit)

All 7 acceptance items land in a single commit alongside this signal block + the `git mv` to `tasks/review/`.

### Implementation summary

1. **SQL helper.** Added `authorsWithSupersessionSelect(commentAlias, appTagParam)` to `backend/src/hafsql.ts`. Returns a parenthesized `COALESCE((SELECT jsonb_agg(jsonb_build_object(...) ORDER BY a.ordinality) FROM jsonb_array_elements(...) WITH ORDINALITY LEFT JOIN active_accreditations aa ON ...), '[]'::jsonb)` fragment per the canonical pattern in `hive-schemas.md` § 1.1. The `COALESCE(..., '[]'::jsonb)` outer wrap collapses SQL-NULL (from an empty/missing authors array) to a JSON empty array so the JS layer's `Array.isArray()` check holds. Requires `active_accreditations` CTE in scope.

2. **List endpoint (`GET /api/papers`).** `fetchPapersFromHaf` data SELECT adds the supersession projection column (`authors_with_supersession`) reusing the existing `buildWith(1, activeAccreditationsCteBody, retractedPapersCteBody)` CTE — no new CTE wrapping needed (already had `active_accreditations` in scope). Row mapping uses the projected array for `authors:` instead of the raw `pevo.authors || []`. `pevoAuthors` retained for the `accredited_authors` filter and `is_accredited` lookup (those only need hive names).

3. **Detail endpoint (`GET /api/papers/:author/:permlink`).** `fetchPaperDetailFromHaf` paper SELECT now wraps with `activeAccreditationsCteBody(4)` and adds the projection column. Param layout preserved so author+permlink stay at $1+$2 (existing test responders read `params[0]` / `params[1]` for those values); bridgeAccount at $3; CTE params at $4-$6. The detailWhere helper rebinds `appTagParam` → `$4` and `bridgeAccountParam` → `$3`.

4. **buildPaperDetail consumer.** After `buildPaperDetail(row, meta, [])`, the route overrides `detail.authors = row.authors_with_supersession` when the field is present. Continuation-chain papers override this further down via `buildCumulativeAuthorsForChain`.

5. **buildCumulativeAuthorsForChain.** Captures the pre-override chain `orcid` in a local before the existing server-override mutates `out.orcid`, then computes `(orcid_verified, orcid_discrepancy)` via the new `computeSupersession(hive, preOverrideChainOrcid, accreditedOrcids)` helper. This is the load-bearing call-out in the task body: without sampling the chain claim BEFORE override, `orcid_discrepancy` would always be false on chain papers (the override unifies `out.orcid` with the attestation, making the post-override comparison trivially equal). Capturing pre-override preserves the discrepancy signal end-to-end on chain papers while leaving the existing server-override behavior untouched.

6. **Fallback paths.** The `?version=N` and `metadata_restored` branches in the primary route handler call `buildPaperDetail` directly with JS-reconstructed meta (no SQL-side projection). Both now fetch `getAccreditedOrcidsByAccount()` post-build and apply `applyAuthorSupersession(detail.authors, orcidMap)` to populate the new fields.

7. **JS-side helpers.** Added `computeSupersession(hive, chainOrcid, orcidMap)` returning `{orcid_verified, orcid_discrepancy}` per the 4-case rule, and `applyAuthorSupersession(authors, orcidMap)` for batch application. Mirrors the SQL-side semantics exactly so chain-path and SQL-path responses are shape-equivalent.

### Test coverage

New file `backend/tests/routes/papers-canonical-orcid-resolution.test.ts` (8 tests):

- **Detail endpoint** — 5 tests covering all 4 supersession cases (hive empty, hive set + not accredited, hive accredited + null attestation, hive accredited + differing attestation) plus the case-4b companion (attestation matches chain → `orcid_discrepancy=false` even though `orcid_verified` is populated). Pins the route surfaces the SQL-projected fields without dropping/transforming. The mocked `hafQueryMock` shapes `authors_with_supersession` directly in the row, so the test pins both halves of the contract: SQL produces the shape, the route forwards it.
- **Detail endpoint SQL composition** — 1 test asserting the emitted SQL contains `active_accreditations`, `orcid_verified`, `orcid_discrepancy`, `jsonb_array_elements`, and `WITH ORDINALITY` substrings. Mutation-kill: drop the CTE wrap or the projection from `fetchPaperDetailFromHaf` → assertion fails.
- **List endpoint** — 1 happy-path test pinning the projected fields ship through the list response; 1 SQL-composition test mirroring the detail SQL-shape canary.

Mocked-pool test per CLAUDE.md "Running Tests" carve-out — file header documents justification (deterministic 4-case matrix coverage is impractical against live HAF) and identifies the real-path companion at sibling sites (`papers.test.ts` real-HAF integration coverage; `accreditation.test.ts` for `active_accreditations` shape).

### Verification

- `npx tsc --noEmit` from `backend/`: clean (no output).
- `npm run lint` from `backend/`: only pre-existing `seed-phrase.ts` warnings.
- `npx vitest run` across 6 papers-touched test files (`papers`, `paper-detail-v3`, `cite`, `papers-enrichment-parity-gate`, `papers-canonical-orcid-resolution`, `canonical-root-walker`) with Redis+Postgres reachable via Docker IPs: **52/54 pass, 1 skipped, 1 pre-existing real-HAF flake** on `papers.test.ts > 'every returned paper is accredited-authored'` (same `jesusalejos/...` flicker that flickers across baseline runs; verified pre-my-changes via git-stash round-trip).

### `[TODO Architect]` — TypeScript types

The acceptance §7's TypeScript-types item — "extend the existing `PaperSummary['authors'][number]` and `PaperDetail['authors'][number]` types with the two new optional fields" — was inspected and there are no central exported types for these author shapes; `buildPaperDetail` returns an anonymous `Record<string, unknown>`-shaped object, and the list-endpoint row mapping returns inline-typed objects too. The api-contract docs already document the fields. No code-side type extension is in scope this round; if a future task introduces typed contracts (e.g., a generated TS schema from the contract md), the supersession fields land there.

### Notes for architect

- Continuation-chain papers' `orcid_discrepancy`: pre-existing `buildCumulativeAuthorsForChain` server-override (replaces `out.orcid` with the attestation) ran BEFORE my discrepancy computation. I refactored to sample the pre-override claim into a local, so the discrepancy signal correctly fires on chain papers when the broadcaster's typed value differs from the eventual attestation — even though `out.orcid` ends up overridden in the response. Both behaviors coexist intentionally: the override is the deliberate server-side spoof-prevention, and the discrepancy signal is the UI's audit hook.
- `pevoAuthors` (raw chain authors) is still consulted in `fetchPapersFromHaf` for the `accredited_authors` filter (which only needs hive names) and `is_accredited` check. Could be reworked to consume the SQL-projected `authors_with_supersession` instead, but that's a follow-up; current dual-path keeps the changeset focused.
- The detail endpoint's CTE wrap reordered params from `[author, permlink, appTag, bridgeAccount]` to `[author, permlink, bridgeAccount, appTag, authorities, genesis]`. No production callers care; the test responders read `params[0]` / `params[1]` only so they keep working.

---

## Architect re-review round-1 (2026-05-16) — HELD PENDING FIXES

`/ce-code-review` on commits `469a571` (round-1 main) + `2c40f3a` (follow-up: discriminator widen) dispatched 9 reviewers (correctness opus + adversarial opus + security opus + testing/maintainability/project-standards/performance/api-contract/kieran-typescript sonnet + ce-learnings-researcher sonnet; `ce-agent-native-reviewer` skipped per root CLAUDE.md). 13 findings surfaced and triaged with the user. 4 items held below for this task; 1 finding filed as separate follow-up task (`backend-profile-papers-supersession-parity.md`); 2 architect-side contract-doc updates already landed in `agents/docs/api-contracts/papers.md`; 6 findings dismissed at triage.

### Items to address

**1. (P1 cross-reviewer correctness+adversarial, anchor 100) Hive-key normalization asymmetric across 3 supersession paths**

**Where:**
- `backend/src/hafsql.ts:784` — SQL JOIN `aa.account = (a.elem ->> 'hive')` does NOT normalize.
- `backend/src/routes/papers.ts:283-293` — `applyAuthorSupersession` reads `e.hive` raw before `orcidMap.has(hive)`; does NOT normalize.
- `backend/src/routes/papers.ts:339` — `buildCumulativeAuthorsForChain` DOES normalize via `entry.hive.trim().toLowerCase()`.

**Why:** A paper with `authors[i].hive = "Alice"` (capitalized — possible because Hive consensus normalizes account names only at op level, not in JSON metadata bodies, and co-author input forms may not enforce normalization) produces split-brain across the three paths: list+detail return `orcid_verified=null, orcid_discrepancy=false`; continuation-chain resolves correctly; `?version=N`/`metadata_restored` returns null again. A vouched co-author can suppress the verified-ORCID surface (silencing the discrepancy audit signal) by varying case. Inverse risk: JS-normalized path matches mid-case spoof to real lowercase account.

**Fix:** Normalize at all three paths. Two-pattern options for the implementer's choice:
- **(a)** Inline lowercasing — SQL: `LOWER(TRIM(a.elem ->> 'hive'))` in the JOIN predicate; JS: `e.hive.trim().toLowerCase()` in `applyAuthorSupersession` before the map lookup.
- **(b)** Extract a single `canonicalHiveKey(hive: unknown): string | null` helper in `backend/src/lib/` (or in `helpers.ts`) and use it from all three paths.

Whichever pattern, add a **parity test** in `papers-canonical-orcid-resolution.test.ts` that runs the same `authors[]` array (with mixed-case hives) through all three paths and asserts identical `(orcid_verified, orcid_discrepancy)` output. Mutation kill: dropping the normalization at any one path fails the parity test red.

**2. (P2 cross-reviewer correctness+adversarial, anchor 100) SQL/JS parity — empty-string chain orcid produces `discrepancy=true` in SQL, `false` in JS**

**Where:** `backend/src/hafsql.ts:787-788` (SQL CASE: `(a.elem ->> 'orcid') IS NOT NULL` admits empty string `''`) vs `backend/src/routes/papers.ts:268-271` (JS `computeSupersession`: `claimed = typeof chainOrcid === 'string' && chainOrcid.length > 0 ? chainOrcid : null` — empty-string normalized to null).

**Why:** Publishers leave `orcid` blank in the publish form by default (publish.js:625 / 833 emit `orcid: ''`). An accredited author with a real attestation broadcasting `{hive: 'alice', orcid: ''}` produces opposite discrepancy outputs across endpoints+paths. Semantically the publisher's empty string is "no claim" not "I claim empty"; the JS path is correct, SQL is too liberal.

**Fix:** Tighten the SQL CASE expression to wrap chain orcid in `NULLIF(..., '')` so `IS NOT NULL` correctly rejects empty:

```sql
'orcid_discrepancy', CASE
                       WHEN aa.orcid IS NOT NULL
                        AND NULLIF((a.elem ->> 'orcid'), '') IS NOT NULL
                        AND aa.orcid <> (a.elem ->> 'orcid')
                       THEN true ELSE false
                     END
```

Add a test case in `papers-canonical-orcid-resolution.test.ts`: accredited author with real attestation broadcasts `{hive: 'alice', orcid: ''}` → assert `orcid_verified` populated, `orcid_discrepancy: false`. Mutation kill: reverting the `NULLIF` wrap surfaces the false-positive discrepancy red.

**3. (P2 api-contract, anchor 100) `affiliation` leaks into PaperSummary via shared SQL fragment**

**Where:** `backend/src/hafsql.ts:784` — `'affiliation', a.elem ->> 'affiliation'` in `authorsWithSupersessionSelect`'s `jsonb_build_object` is unconditional; both the list endpoint (PaperSummary) and detail endpoint (PaperDetail) share the helper.

**Why:** Task acceptance criterion #6 and `agents/docs/api-contracts/papers.md` PaperSummary schema explicitly omit `affiliation` from list-response `authors[]`. Implementation ships it on both surfaces — concrete contract violation.

**Fix:** Parameterize the SQL helper with an `includeAffiliation` flag:

```ts
export function authorsWithSupersessionSelect(
  commentAlias: string,
  appTagParam: string,
  opts: { includeAffiliation: boolean } = { includeAffiliation: false },
): string {
  const affiliationField = opts.includeAffiliation
    ? `'affiliation', a.elem ->> 'affiliation',`
    : '';
  // ... use ${affiliationField} inside jsonb_build_object
}
```

List endpoint (`fetchPapersFromHaf`) passes `{ includeAffiliation: false }`; detail endpoint (`fetchPaperDetailFromHaf`) passes `{ includeAffiliation: true }`. Add an assertion in the list-endpoint SQL-shape canary that the SELECT does NOT contain `'affiliation'`; add a behavior canary that PaperSummary response `authors[i]` lacks the `affiliation` key.

**4. (P2 testing, anchor 85) Fallback branches (`?version=N`, `metadata_restored`) have no supersession field assertions**

**Where:** `backend/src/routes/papers.ts:2384` (`?version=N`) and `:2421` (`metadata_restored`) — both call `applyAuthorSupersession(detail.authors, orcidMap)` but no test asserts the supersession fields appear on responses from either branch.

**Why:** If `applyAuthorSupersession(...)` were deleted from either branch, all existing tests pass. The JS-side supersession path on the two fallback code paths is uncovered. The 8 new tests in `papers-canonical-orcid-resolution.test.ts` exclusively exercise the SQL-projected path.

**Fix:** Add two canaries to `papers-canonical-orcid-resolution.test.ts` (one per fallback branch). Each canary: stage a request that routes through the fallback (the `?version=N` test should stage `reconstructVersionsFromHaf` to return rows so the SQL-paper-detail row is bypassed; the `metadata_restored` test stages the metadata-restored branch conditions); stage `getAccreditedOrcidsByAccount` to return an orcid map with a mismatch; assert `res.body.data.authors[i].orcid_discrepancy === true` and `orcid_verified` matches the map value. Mutation kill: deleting `applyAuthorSupersession` from either branch fails the corresponding canary red.

### Architect-side contract-doc updates already landed (no implementer action)

- `agents/docs/api-contracts/papers.md` lines 64-65 updated: added 30-min cache-staleness note for `orcid_verified`/`orcid_discrepancy` and the continuation-chain caveat documenting that on server-override papers, `orcid` MAY equal `orcid_verified` while `orcid_discrepancy` is `true` (the discrepancy is the authoritative audit signal regardless of apparent equality). Line 145 (PaperDetail re-statement) updated to reference both notes.

### Filed as separate follow-up task (no action on this hold)

- `backend-profile-papers-supersession-parity.md` (P2): `/api/profile/:username/papers` silently omits `orcid_verified`/`orcid_discrepancy` because `toPaperSummary` in `helpers.ts` is unwrapped and the supersession helpers are private to `routes/papers.ts`. Cross-surface parity gap per `cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`. The follow-up task captures the helper-extraction to `backend/src/lib/author-supersession.ts` + profile route adoption + canaries.

### Findings dismissed at triage (no action)

- **Spoof-by-attribution / claimed-pending author surfaces verified ORCID (adversarial P1/75):** `orcid_verified` is account-keyed (LEFT JOIN active_accreditations), not paper-keyed. It promises "this hive account is accredited with this ORCID," nothing about paper-level consent. Vouched-set badge (ARCHITECTURE.md § 2.20) is the authorship signal; supersession-fields and vouched-set are orthogonal signals integrators combine. The adversarial framing was a UI-misreading scenario, not a backend defect.
- **Continuation-chain `orcid_discrepancy`/`verified` emission untested (testing P2/80):** Inline comment block in `buildCumulativeAuthorsForChain` documents the pre-override-capture invariant; future refactor would notice. Per `feedback_dismiss_preemptive_test_hardening`.
- **Raw `$1`-`$6` bind-index strings in `fetchPaperDetailFromHaf` (maintainability+kieran-typescript P2/75 corroborated):** Comment block at lines 930-936 documents the layout; `2c40f3a`'s regex-widening test discriminator catches future shifts. Per `feedback_dismiss_preemptive_test_hardening`. (Counter-pattern adoption can be a future broader sweep.)
- **Task-slug references at `papers.ts:444, 664, 851` (maintainability P2/75):** Cosmetic; comments still convey WHY accurately. The slug citations will rot, but the WHY-content is independently valid. Per architect judgment (not worth a re-review round).

### Findings noted-for-awareness (dismiss-as-noted; document here, no code action)

- **`applyAuthorSupersession` spread keeps `affiliation` in fallback paths (api-contract P3/75):** Latent only — currently only used by detail-endpoint fallbacks where affiliation is correct in PaperDetail. Active version is item 3 above. If a future change routes the list endpoint through a JS fallback, this becomes the same contract violation; address then.
- **Scalar coercion divergence for malformed `authors[{hive: 42, orcid: true}]` (adversarial P3/75):** Reachability requires malformed broadcaster bypassing the publish UI (today only pre-hardening corpus). Adversarial reviewer themselves rated as "not a security finding per se; documented for the parity-contract reading." Per `feedback_dismiss_preemptive_test_hardening`. If a hive-normalization helper is extracted per item 1 option (b), consider extending it to reject non-string hive shapes at the same boundary.

### Re-review signal

When items 1-4 land, `git mv` this file from `tasks/pending/` back to `tasks/review/` per `feedback_task_mv_to_review_after_each_round.md`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `2c40f3a`. Items 1+2 are SQL+JS parity items and should land in a focused commit (with the parity test); items 3+4 can be the same commit or separate at the implementer's discretion.

---

## Backend re-review signal (2026-05-16, round-2 — working tree of this commit)

All 4 hold-block items land in a single commit alongside this signal block + the `git mv` back to `tasks/review/`.

### Items addressed

**Item 1 — Hive-key normalization parity across the three supersession paths.** Adopted option (b) from the hold block: extracted a single `canonicalHiveKey(hive: unknown): string | null` helper at `backend/src/routes/papers.ts:259` and used it from all JS-side paths.

- **SQL** (`backend/src/hafsql.ts:authorsWithSupersessionSelect`): JOIN predicate switched to `LEFT JOIN active_accreditations aa ON aa.account = LOWER(TRIM(a.elem ->> 'hive'))`. The `aa.account` column is already lowercase by Hive consensus (chain-enforced), so only the chain `authors[i].hive` metadata needs canonicalization on this side. `LOWER(TRIM(...))` is the parity-symmetric operator on `.trim().toLowerCase()`.
- **JS `computeSupersession`** (line 293): now canonicalizes its `hive` argument via `canonicalHiveKey` before the `orcidMap` lookup. The function's docstring notes that callers MAY pre-canonicalize (e.g., `buildCumulativeAuthorsForChain` does for its own bookkeeping) and that doing so a second time is idempotent.
- **JS `applyAuthorSupersession`** (line 314): unchanged — it delegates the lookup to `computeSupersession`, which now centralizes the normalization.
- **JS `buildCumulativeAuthorsForChain`** (line 358): replaced the inline `entry.hive.trim().toLowerCase()` with `canonicalHiveKey(entry.hive)`. Behavior-equivalent; reduces duplication and pins the parity through a single helper.

**Item 2 — SQL/JS empty-string chain-orcid parity.** SQL CASE expression now wraps the chain orcid in `NULLIF((a.elem ->> 'orcid'), '')` so an empty-string broadcast (the publish form's default) is normalized to "no claim" before the equality check, matching the JS-side `claimed = typeof chainOrcid === 'string' && chainOrcid.length > 0 ? chainOrcid : null` semantics.

**Item 3 — `affiliation` parameterization on `authorsWithSupersessionSelect`.** Added `opts: { includeAffiliation?: boolean } = {}` parameter; default `false` (the more restrictive PaperSummary shape). The list endpoint's call site at `papers.ts:703` passes `{ includeAffiliation: false }`; the detail endpoint's call site at `papers.ts:957` passes `{ includeAffiliation: true }`. The `'affiliation', a.elem ->> 'affiliation'` line is now conditionally emitted inside `jsonb_build_object`.

**Item 4 — Fallback branch supersession canaries.** Added two route-level canaries that drive the `?version=N` cache-miss branch and the `metadata_restored` fallback path through to response. Both stage `getAccreditedOrcidsByAccount`'s SQL to return a mismatching accredited ORCID for `alice`, and the version-reconstruction SQL to return chain `authors[]` with a different `orcid`. Each asserts `res.body.data.authors[0].orcid_verified` matches the accredited value and `orcid_discrepancy` is `true`. Mutation kill: deleting `detail.authors = applyAuthorSupersession(...)` from either branch fails the corresponding canary red.

### Test coverage added

Extended `backend/tests/routes/papers-canonical-orcid-resolution.test.ts` (12 new tests, 20 total):

- **Item 1 parity (4 tests):**
  - `canonicalHiveKey` unit test: mixed-case, whitespace, null/undefined/non-string inputs.
  - `computeSupersession` mixed-case parity: `'Alice'` and `'  alice  '` resolve identically against a lowercase `orcidMap`.
  - `applyAuthorSupersession` parity invariant: the same `authors[]` with mixed-case `hive` values produces identical `(orcid_verified, orcid_discrepancy)` output to its lowercase counterpart.
  - SQL canary: list and detail SQL fragments both contain `LOWER(TRIM(a.elem ->> 'hive'))`.

- **Item 2 empty-string parity (3 tests):**
  - `computeSupersession`: empty-string chain orcid + accredited author → `orcid_verified` populated, `orcid_discrepancy: false`.
  - `applyAuthorSupersession`: `{hive: 'alice', orcid: ''}` end-to-end via the helper → discrepancy=false.
  - SQL canary: both list and detail SQL contain `NULLIF((a.elem ->> 'orcid'), '')`.

- **Item 3 affiliation parameterization (3 tests):**
  - List endpoint SQL omits `'affiliation', a.elem ->> 'affiliation'`.
  - Detail endpoint SQL retains it.
  - List response `authors[i]` does NOT have an `affiliation` key (behavior canary; complements the SQL canary).

- **Item 4 fallback-branch canaries (2 tests):**
  - `?version=N` route → assert supersession fields on response authors.
  - `metadata_restored` fallback → assert `metadata_restored=true` AND supersession fields populated.

### Item 1 helper-extraction note

The hold block offered two implementation options. Option (b) (extracted `canonicalHiveKey` helper) was chosen because (a) it reduces three potential drift sites to one, (b) it forms a natural extension point for the `backend-profile-papers-supersession-parity` follow-up's helper-extraction to `lib/author-supersession.ts`, and (c) the inline-cleanup of `buildCumulativeAuthorsForChain`'s existing `.trim().toLowerCase()` becomes a one-line call-site swap. The helper lives in `routes/papers.ts` next to the other supersession helpers; the follow-up task moves all three to a shared `lib/author-supersession.ts` together.

The follow-up task `backend-profile-papers-supersession-parity` (created at round-1 architect triage) is the natural site for `canonicalHiveKey`, `computeSupersession`, and `applyAuthorSupersession` to migrate to `backend/src/lib/author-supersession.ts`. The exports added in this round (named exports on all three helpers) make that migration a straight `import-from-rename`, not a refactor.

### Verification

- `npm run typecheck` from `backend/`: clean.
- `npm run lint` from `backend/`: clean.
- `npx vitest run tests/routes/papers-canonical-orcid-resolution.test.ts` (Redis+Postgres reachable via Docker IPs): **20/20 pass.**
- Broader regression sweep (`papers`, `paper-detail-v3`, `cite`, `papers-enrichment-parity-gate`, `papers-canonical-orcid-resolution`, `canonical-root-walker`): **64/66 pass, 1 skipped, 1 pre-existing real-HAF flake** on `paper-detail-v3.test.ts > 'includes versions array and retraction fields when paper exists'` — the same `jesusalejos/...` wall-clock-exceeded flicker the round-1 verification noted on `papers.test.ts`. Verified pre-existing via `git stash` round-trip against `main`.

### Findings noted-for-awareness — status update

The round-1 "Scalar coercion divergence for malformed `authors[{hive: 42, orcid: true}]`" awareness item noted: "If a hive-normalization helper is extracted per item 1 option (b), consider extending it to reject non-string hive shapes at the same boundary." The new `canonicalHiveKey` does exactly that — its `typeof hive !== 'string'` early-return rejects non-string shapes uniformly across all JS paths, returning `null` (which falls through to case-1 "no hive → no verified ORCID"). The unit test pins this behavior on `42` and `{ hive: 'alice' }` inputs.

The round-1 "`applyAuthorSupersession` spread keeps `affiliation` in fallback paths (api-contract P3/75)" awareness item: still latent. The Item 4 fallback-branch canaries surface `orcid_verified`/`orcid_discrepancy` correctly, but they don't run against a list-endpoint JS fallback (the list endpoint has no JS fallback today). If a future change routes the list through a JS fallback, the `applyAuthorSupersession` spread would surface the `affiliation` field; that's the same risk the round-1 P3 noted, addressed at that future site.

---

## Architect re-review round-2 (2026-05-19) — HELD PENDING FIXES

`/ce-code-review` on commit `37a49a1` dispatched 10 reviewers (correctness opus + adversarial opus + security opus + testing/maintainability/project-standards/performance/api-contract/kieran-typescript sonnet + ce-learnings-researcher sonnet; `ce-agent-native-reviewer` skipped per root CLAUDE.md). 22 findings surfaced across this task and the sibling `backend-profile-papers-supersession-parity` round-1 review (combined triage; cluster-level findings split per task). 7 main items held below for this task plus 2 passing items plus architect-side deferrals.

### Items to address

**1. (P1 cross-reviewer sec+adv, anchor 100) SQL TRIM vs JS `.trim()` asymmetry — round-2 hold item 1 NOT fully closed**

**Where:**
- `backend/src/hafsql.ts:830` — `LEFT JOIN active_accreditations aa ON aa.account = LOWER(TRIM(a.elem ->> 'hive'))`
- `backend/src/lib/author-supersession.ts` — `canonicalHiveKey` JSDoc claims "LOWER(TRIM(...)) is the parity-symmetric operator on `.trim().toLowerCase()`"

**Why:** PostgreSQL `TRIM(text)` with no character-set arg strips ONLY U+0020 (space). Empirically verified against the running `pevo-postgres-1`: `TRIM(E'\tAlice\n')` returns `\tAlice\n` unchanged. JS `String.prototype.trim()` strips ECMA-262 WhiteSpace + LineTerminator (tab, LF, CR, NBSP, BOM, U+2028/2029, etc.). A broadcaster posting `{hive: '\tBob'}` produces split-brain across surfaces: JS-path /api/profile + chain-detail surface `orcid_verified` + `orcid_discrepancy=true`; SQL-path /api/papers + single-link detail emit `orcid_verified=null` and no discrepancy. The vouched-co-author spoof channel the round-1 hold prescribed to close is still open via non-space whitespace.

**Fix:** Two candidate shapes for the implementer's choice:
- **(a) Reject malformed at the boundary.** Hive consensus restricts accounts to `[a-z0-9.\-]`. Tighten the hive-account normalizer to return `null` on any input containing characters outside that set after trim+lowercase. Add an SQL guard via regex: `LOWER(TRIM(a.elem ->> 'hive')) ~ '^[a-z0-9.\-]+$'` (or rewrite the JOIN to compare against a regex-validated subexpression). Broadcaster-malformed metadata never silently matches a real account. Strongest fix.
- **(b) Widen SQL TRIM to match JS .trim().** Replace `LOWER(TRIM(a.elem ->> 'hive'))` with `LOWER(REGEXP_REPLACE(a.elem ->> 'hive', '^[\s ﻿]+|[\s ﻿]+$', '', 'g'))` so both ends strip the broader Unicode whitespace set. Mechanically symmetric; less defensive than (a).

Whichever shape, add a parity test that runs `'\tbob'`, `' bob'`, `'bob\n'`, and `'Alice'` through BOTH paths and asserts identical `(orcid_verified, orcid_discrepancy)` output. Mutation kill: dropping the normalization at either side fails the parity test red.

**2. (P1 adv, anchor 75) Hive-account normalizer not adopted at all lookup sites in `papers.ts`**

**Where:**
- `backend/src/routes/papers.ts:814` (`fetchPapersFromHaf` row builder): `accredited_authors: pevoAuthors.filter(a => a.hive && allAccredited.has(a.hive)).map(a => a.hive!)` — raw key lookup, no canonicalization.
- `backend/src/routes/papers.ts:1207` (non-chain detail branch): `detail.accredited_authors = detailAuthors.filter((a) => typeof a.hive === 'string' && accreditedAccountSet.has(a.hive as string)).map((a) => (a.hive as string).trim().toLowerCase())` — `.filter()` uses raw lookup; `.map()` uses the old inline pattern instead of the wrapper.

**Why:** Round-2 extracted the canonical-hive-key wrapper and adopted it at three planned sites (`computeSupersession`, `buildCumulativeAuthorsForChain`, SQL JOIN), but these two sibling sites in the same file do hive-account lookups against an accredited set without canonicalization. Concrete cascade: mixed-case `authors[i].hive = 'Alice'` on a chain paper produces `orcid_verified='0000-...'` (supersession correctly resolved) AND `accredited_authors=[]` (raw lookup misses lowercase set) in the SAME response row. Same-response-row split-brain across `orcid_verified` and `accredited_authors` fields.

This is the wrapping-primitive exhaustive call-site audit pattern from `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — once a canonical wrapper exists, every direct caller of the underlying pattern is a structural drift risk.

**Fix:** At both sites, replace raw `.hive` lookups with the renamed wrapper (per item 6 below). Run `grep -nE '\.hive\b' backend/src/routes/papers.ts backend/src/hafsql.ts` and re-disposition every site against the wrapper.

Companion test: chain paper with `authors[{hive: 'Alice'}]`, alice in accreditation set; assert `orcid_verified` populated AND `accredited_authors` includes `'alice'` in the same response row, across list AND detail surfaces.

**3. (P1 cross-reviewer maint+test+std, anchor 100) Comment-anchor violations in test source — coordination context**

**Where:** `backend/tests/routes/papers-canonical-orcid-resolution.test.ts`
- Section comment block embedding "Round-2 hold-block items 1-4 canaries", "Item 1 (P1)", "Item 2 (P2)", "Item 3 (P2)", "Item 4 (P2)"
- Four `describe()` labels of the form `'supersession round-2 hold — item N (<behavioral text>)'`

**Why:** Root CLAUDE.md "Comment anchors" — do not embed task slugs, round numbers, or hold-item references in production or test code. The describe labels are forever; they appear in CI output for the lifetime of the regression test.

**Fix:**
- Replace the section comment with one anchored on behavior: `// Canaries for hive-key normalization parity, empty-string orcid parity, affiliation parameterization, and fallback-branch supersession.`
- Strip the `supersession round-2 hold — item N (...)` prefix from each `describe()` label, keeping the behavioral parenthesized content (e.g., `describe('hive-key normalization parity across the wrapper, computeSupersession, applyAuthorSupersession, and SQL JOIN', ...)`).

**4. (P2 cross-reviewer sec+adv, anchor 100) Whitespace-only chain orcid bypasses NULLIF**

**Where:** `backend/src/hafsql.ts` (SQL `NULLIF((a.elem ->> 'orcid'), '')`) + `backend/src/lib/author-supersession.ts` `computeSupersession` (JS `chainOrcid.length > 0` check)

**Why:** Round-2 hold item 2 closed the byte-exact empty case (`''`) for parity. A broadcaster posting `{hive: 'alice', orcid: ' '}` (single space) bypasses both filters: SQL `NULLIF(' ', '')` returns `' '` (non-null) → discrepancy guard fires → `orcid_discrepancy=true`. JS `chainOrcid.length > 0 → true` → `claimed = ' '` → discrepancy check fires → `orcid_discrepancy=true`. Parity-consistent but both wrong — surfaces a false-positive discrepancy audit signal against an accredited author who didn't actually claim anything substantive.

**Fix:** Tighten both gates to treat any-whitespace-only as no-claim:
- SQL: `NULLIF(BTRIM(a.elem ->> 'orcid'), '') IS NOT NULL` (BTRIM strips ASCII whitespace).
- JS: `typeof chainOrcid === 'string' && chainOrcid.trim().length > 0 ? chainOrcid.trim() : null` in `computeSupersession`.

Companion test: `computeSupersession('alice', ' ', orcidMap)` → `orcid_discrepancy: false`. SQL canary: both list+detail fragments contain the BTRIM (or chosen normalization).

**5. (P2 test, anchor 75) Item 3 behavior canary is redundant with the SQL canary**

**Where:** `backend/tests/routes/papers-canonical-orcid-resolution.test.ts` — the item-3 "list response authors[i] lacks affiliation key" behavior canary

**Why:** Test mocks SQL row without `affiliation`, then asserts the response `authors[i]` lacks `affiliation`. Code path: `fetchPapersFromHaf` passes the SQL column verbatim — affiliation can only appear in the response if the SQL row contained it. The counterfactual (revert `includeAffiliation: false` → `true` at the call site) doesn't change what the mocked test reads. The test passes vacuously. The SQL-shape canary (the first item-3 test) is the real kill switch.

**Fix:** Delete the redundant behavior canary and tighten the SQL canary's comment to explain it's the affiliation contract kill switch.

**6. (P2 maint, anchor 75) `canonicalHiveKey` name implies a non-null key — rename**

**Where:** `backend/src/lib/author-supersession.ts` exported function

**Why:** Signature returns `string | null`. The word "key" connotes a non-null map key. Round-3 is adding new call sites (items 1+2 above); natural moment to settle on a clearer name.

**Fix:** Rename to `normalizeHiveAccount(hive: unknown): string | null` (or `toCanonicalHive`) across the lib, all call sites in `papers.ts` (including the new sites from items 1+2), `helpers.ts` if imported there, and tests. Update the JSDoc accordingly.

**7. (P2 maint, anchor 75) hafsql.ts JSDoc parenthetical file-path is already stale**

**Where:** `backend/src/hafsql.ts` — JSDoc on `authorsWithSupersessionSelect`: "Matches the JS-side normalization in `canonicalHiveKey` (see `backend/src/routes/papers.ts`); the parity is the contract."

**Why:** Task 2 (commit `d41da25`, already on main) moved the helpers from `routes/papers.ts` to `backend/src/lib/author-supersession.ts`. The parenthetical pointer is wrong as-of HEAD.

**Fix:** Drop the parenthetical file-path supplement. JSDoc becomes: "Matches the JS-side normalization in `<renamed-helper>`; the parity is the contract." The function-name anchor alone is stable.

### Passing items (small fixes alongside the above)

**8.** `rows: [] as any[]` in `vi.hoisted` mock initializer at `papers-canonical-orcid-resolution.test.ts` → `rows: [] as unknown[]`.
**9.** Unused `params: unknown[]` parameter in the `stageVersionRoute` mock → `_params` per underscore-prefix convention used elsewhere in the same file.

### Architect-side contract-doc deferrals (land at round-3 archive, no implementer action)

The following contract-doc edits in `agents/docs/api-contracts/papers.md` will land alongside the round-3 archive, after the implementer's round-3 emit-shape behavior is settled. Deferred from this hold because the round-3 fix for item 1 may change the emit semantics for `authors[i].hive` (if option (a) rejection-at-boundary is chosen, malformed inputs emit as null; if option (b), verbatim emit continues):

- `authors[i].hive` field note: clarify whether the emitted value is verbatim chain-broadcast or normalized at the emit boundary, and that consumers MUST compare case-insensitively against Hive account names (chain consensus restricts real accounts to `[a-z0-9.-]`).
- `authors[i].orcid` field note: clarify that the field MAY be empty/whitespace strings if the broadcaster typed blank/whitespace; consumers should treat as equivalent to null for display.

### Dismissed at triage (no action)

- (T1 kt-01) Transitional exports from `routes/papers.ts` already closed at HEAD by `d41da25` (task 2 landed the lib migration). Not actionable.
- (T1 sec-3) Round-2 parity tests use only ASCII-space inputs — implicit by item 1's non-space whitespace parity test addition.
- (T1 kt-04, kt-05) Pre-existing redundant casts at the `preOverrideChainOrcid` capture site and `computeSupersession` hive parameter type asymmetry. Pre-existing, not introduced by round-2.

### Re-review signal

When items 1-9 land, `git mv` this file from `tasks/pending/` back to `tasks/review/`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `37a49a1`. Items 1+2 share the wrapper/parity scope and should land together with the parity test (item 1) and the call-site audit grep (item 2). Item 4 is the orcid analog; item 6 is the rename. Items 3, 5, 7, 8, 9 are mechanical cleanups that bundle naturally alongside the substantive edits.

---

## Backend re-review signal (2026-05-19, round-3 — working tree of this commit)

All 9 hold-block items land in this single commit alongside the signal block + the `git mv` back to `tasks/review/`. Approach choice for item 1: **option (a) — reject malformed at the boundary** (the strongest fix; aligns with the architect's just-landed solutions doc `sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md`).

### Items addressed

**Item 1 (P1) — SQL TRIM vs JS `.trim()` asymmetry, closed via reject-at-boundary.** Both sides now agree on rejection: SQL adds `LOWER(TRIM(a.elem ->> 'hive')) ~ '^[a-z0-9.-]+$'` as a second JOIN predicate; JS `normalizeHiveAccount` narrows from `.trim()` to a new `trimAsciiSpace` helper (`s.replace(/^ +| +$/g, '')`) that matches PostgreSQL `TRIM` semantics exactly, then applies the same `[a-z0-9.-]+` regex check. Inputs containing non-ASCII whitespace (`\t`, `\n`, `\r`, NBSP, etc.) are rejected on both paths; inputs containing characters outside Hive's account charset (`al;ice`, `alice_bob`, `alice@example`) are rejected on both paths. Mixed-case + ASCII-space-padded inputs (`'Alice'`, `'  alice  '`) continue to resolve to canonical lowercase on both paths. Parity test (`tests/routes/papers-canonical-orcid-resolution.test.ts` — `hive normalization parity: \tbob, ` bob`, bob\n, Alice resolve identically across JS and SQL`) pins the cross-path behavior on each of the 4 architect-prescribed inputs, plus expanded `normalizeHiveAccount` unit coverage for non-ASCII whitespace and out-of-charset inputs.

**Item 2 (P1) — `normalizeHiveAccount` adopted at the two sibling lookup sites in `papers.ts`.** Replaced `pevoAuthors.filter(a => a.hive && allAccredited.has(a.hive)).map(a => a.hive!)` at the list-endpoint row builder with `pevoAuthors.map(a => normalizeHiveAccount(a.hive)).filter(...)`. Replaced the non-chain-detail branch's `.filter(...accreditedAccountSet.has(a.hive)).map(a => a.hive.trim().toLowerCase())` with the same wrapper-based pattern. Companion test `papers.ts adopts normalizeHiveAccount at sibling accredited_authors lookup sites` stages a chain paper with `authors[0].hive = 'Alice'` (mixed case) and asserts `orcid_verified` AND `accredited_authors` resolve correctly in the same response row — the same-row-split-brain regression the architect flagged.

**Item 3 (P1) — Comment-anchor cleanup in test source.** Replaced the `Round-2 hold-block items 1-4 canaries` section comment block with a single behavioral line. Stripped `supersession round-2 hold — item N (...)` prefixes from the four `describe()` labels, keeping the behavioral parenthesized content (`hive-account normalization parity across SQL JOIN, computeSupersession, and applyAuthorSupersession`, `chain-orcid empty/whitespace parity between SQL BTRIM and JS .trim()`, `affiliation parameterization (PaperSummary omits, PaperDetail retains)`, `?version=N and metadata_restored fallback branches apply applyAuthorSupersession post-build`).

**Item 4 (P2) — Whitespace-only chain orcid bypass closed.** SQL: `NULLIF((a.elem ->> 'orcid'), '')` → `NULLIF(BTRIM(a.elem ->> 'orcid'), '')` so single-space and multi-space orcid values are treated as no-claim. The `aa.orcid <> ...` equality check also wraps in `BTRIM(...)` so a `'0000-0000-0000-1234 '` chain claim (trailing space) compares equal to the trimmed attestation. JS: `computeSupersession` now reads `typeof chainOrcid === 'string' && chainOrcid.trim().length > 0 ? chainOrcid.trim() : null` — matching the SQL BTRIM behavior. Companion tests (`computeSupersession treats whitespace-only chain orcid as no claim`, `SQL CASE wraps chain orcid in NULLIF(BTRIM(...), '')...`) pin both halves.

**Item 5 — Redundant item-3 behavior canary deleted.** Dropped the `list response authors[i] lacks the affiliation key` test that was reading back what the mock returned (mocked SQL row already omits `affiliation`, so the response assertion was vacuous). The SQL-shape canary (`list endpoint SQL omits the affiliation projection from the authors jsonb_build_object`) is the affiliation contract kill switch; its comment now explicitly documents that role.

**Item 6 — `canonicalHiveKey` renamed to `normalizeHiveAccount` across the lib, all call sites in `routes/papers.ts`, and tests.** New name aligns with the `string | null` return signature (the prior "Key" connoted a non-null map key). JSDoc rewritten to describe the lowercase + ASCII-space-trim + charset-regex semantics. Two stale JSDoc references in `tests/routes/profile-papers-supersession.test.ts` updated to the new name (collateral cleanup forced by the rename — the test file's behavior remains untouched; task 2 round-2 owns the substantive edits to that file).

**Item 7 — `hafsql.ts` JSDoc parenthetical file-path supplement dropped.** The JSDoc on `authorsWithSupersessionSelect` previously read "Matches the JS-side normalization in `canonicalHiveKey` (see `backend/src/routes/papers.ts`)." Updated to "Matches the JS-side normalization in `normalizeHiveAccount`" — function-name anchor only, no file path. The JSDoc paragraph is also expanded to describe the new regex guard and BTRIM-on-orcid behavior.

**Items 8 + 9 — Mechanical test cleanups.** `rows: [] as any[]` in the `vi.hoisted` initializer → `rows: [] as unknown[]`. Unused `params: unknown[]` in the `stageVersionRoute` mock → `_params: unknown[]` per the underscore-prefix convention used elsewhere in the same file.

### Test coverage added

Net change in `tests/routes/papers-canonical-orcid-resolution.test.ts`: 20 → 22 tests after deleting the redundant item-3 canary and adding 4 new tests for round-3:

- `normalizeHiveAccount` unit test extended to cover non-ASCII whitespace rejection (`\tbob`, `bob\n`, `bob\r`) and out-of-charset rejection (`al;ice`, `alice@example`, `alice_bob`).
- Cross-path parity test for the architect-prescribed 4-input matrix (`\tbob`, ` bob`, `bob\n`, `Alice`).
- Call-site adoption canary: chain paper with mixed-case `Alice` resolves `orcid_verified` AND `accredited_authors` in same row.
- `computeSupersession` whitespace-only chain orcid → no-claim collapse.

The SQL canaries (regex guard + BTRIM) were added to the existing per-describe canaries — each describe block's SQL canary now asserts both the original wrap and the new round-3 addition (regex match for the JOIN; BTRIM for the CASE).

### Verification

- `npm run typecheck` from `backend/`: clean.
- `npm run lint` from `backend/`: clean.
- `npx vitest run tests/routes/papers-canonical-orcid-resolution.test.ts` (Redis+Postgres reachable via Docker IPs): **22/22 pass.**
- Broader regression sweep (`papers-canonical-orcid-resolution`, `paper-detail-v3`, `papers-enrichment-parity-gate`, `canonical-root-walker`, `profile-papers-supersession`, `profile`): **63/64 pass, 1 pre-existing real-HAF flake** on `paper-detail-v3.test.ts > 'includes versions array and retraction fields when paper exists'` — confirmed pre-existing via `git stash` round-trip (same test fails red on `HEAD~1` against the unstashed state with identical 503 error).

### Notes for architect

- The new solutions doc `sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md` landed in commit `395ef20` while round-3 fixes were in flight. The doc names two acceptable parity shapes (reject-at-boundary vs widen-SQL-whitespace) and prescribes the non-ASCII-space test discipline; this implementation chose shape (a) and the parity test inputs match the doc's prescription. No drift between this commit's behavior and the doc's prescription.
- `normalizeHiveAccount` is now the canonical name across `routes/papers.ts` and the lib. Task 2 round-2 (the `backend-profile-papers-supersession-parity` hold) inherits the renamed symbol; no new symbol the task-2 fix needs to introduce. The two JSDoc references in `profile-papers-supersession.test.ts` were updated in this commit as collateral cleanup forced by the rename — the test file's behavior is unchanged.
- The architect-side contract-doc deferrals (PaperSummary/PaperDetail `authors[i].hive` and `authors[i].orcid` field notes) in `agents/docs/api-contracts/papers.md` are settled by this commit's emit-shape behavior: `authors[i].hive` continues to emit verbatim chain-broadcast value (no boundary rewrite of the emitted entry — only the lookup is normalized); `authors[i].orcid` emits verbatim too. Consumers compare case-insensitively / treat empty+whitespace as null per the doc deferral notes; the implementation defends those semantics on the read path.

### Re-review signal

`git mv tasks/pending/backend-papers-canonical-orcid-resolution.md tasks/review/` in the same commit as the source edits. The architect's next `/ce-code-review` pass scopes to commits since `395ef20` (the solutions-doc commit) — this round-3 backend commit is the only one in that range touching the supersession source.
