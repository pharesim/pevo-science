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
