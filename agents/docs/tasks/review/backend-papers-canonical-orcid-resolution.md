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
