# BACKEND-JSONB-ARRAY-ELEMENTS-LATERAL-GUARD-SWEEP — migrate WHERE-clause `jsonb_typeof='array'` guards to CASE-WHEN at SRF argument position

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced during `/ce-code-review` of `backend-self-review-exclusion-everywhere` round-4)
**Priority:** P2

## Context

The round-3 architect hold on `backend-self-review-exclusion-everywhere` flagged that `reputation.ts:paper_resolved_votes` had unguarded `jsonb_array_elements(... -> 'authors')` and would cascade-fail the daily reputation cycle on a single chain post with non-array `pevo.authors`. The round-4 implementer fix wrapped the argument in a CASE-WHEN `jsonb_typeof = 'array'` guard at the SRF argument position. Subsequent `/ce-code-review` revealed that **Postgres evaluates `CROSS JOIN LATERAL` BEFORE the WHERE filter** — meaning sibling sites that defend with a `WHERE jsonb_typeof(...) = 'array'` clause after `CROSS JOIN LATERAL jsonb_array_elements(...)` are NOT actually protected. The SRF expansion raises before the WHERE filter can short-circuit.

The reputation-cycle cascade-fail sites (`citing_papers` CTE + `authorsWithSupersessionSelect` helper) are covered by the round-4 hold on `backend-self-review-exclusion-everywhere`. This task covers the **per-user-fail sibling sites** that have smaller blast radius (per-request crash, not cycle-wide) but the same diagnosis.

## Affected sites (per audit of HEAD)

Grep `jsonb_array_elements` across `backend/src/` and verify each call uses CASE-WHEN at SRF argument position. Sites discovered during the round-4 review:

### WHERE-clause guard, ineffective for LATERAL (must migrate)

1. **`backend/src/routes/profile.ts:143`** — `CROSS JOIN LATERAL jsonb_array_elements(... -> 'citations')` with WHERE-clause `jsonb_typeof=='array'` guard. Per-user citations fetch crash on non-array `pevo.citations`.
2. **`backend/src/routes/stats.ts:72`** — same pattern, same `citations` field, same per-user blast radius.

### No guard at all (must add)

3. **`backend/src/notification-queries.ts:329`** — notification arm 6a, unguarded `jsonb_array_elements(... -> 'citations')`. Per-user notification GET fails for the recipient. Pre-existing per round-3 architect's deferred-to-triage flag.
4. **`backend/src/notification-queries.ts:358`** — notification arm 6b, same.

### Already correct (CASE-WHEN at SRF argument position — no action, reference shape)

- `backend/src/hafsql.ts:371` (helper `excludeSelfReviewWhere` — the reference implementation, hardened in round-1 + round-2 of `backend-self-review-exclusion-everywhere`).
- `backend/src/reputation.ts:607-614` (paper_resolved_votes — landed in round-4 of the same task).

### Audit step

Run `grep -rn 'jsonb_array_elements' backend/src/` and confirm each site is either in the "already correct" list above, in this task's migrate-list, or is exempt with documented reasoning. Any new sites discovered get added to this task before the implementer commits.

## Goal

Migrate the 4 enumerated sites to the canonical CASE-WHEN-at-SRF-argument-position pattern, mirroring the reference implementation in `excludeSelfReviewWhere`:

```sql
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(<row>.json_metadata -> $tag -> '<field>') = 'array'
       THEN <row>.json_metadata -> $tag -> '<field>'
       ELSE '[]'::jsonb
  END
) AS <alias>
```

The now-redundant WHERE-clause `jsonb_typeof` guards at sites 1 + 2 can be removed (they were doing no work pre-fix and continue to do no work post-fix; deleting them tightens the SQL).

Sites 3 + 4 add the same shape from scratch.

## Acceptance

1. **All 4 sites migrated** to CASE-WHEN-at-SRF-argument-position with the canonical shape above.
2. **Behavioral test per blast-radius class.** Add at least one synthetic-VALUES + real-Postgres test per file (one for the citations-array shape across profile/stats, one for the notification-queries arm) under `backend/tests/` exercising the cascade-fail-defense — assert that the route or query does NOT raise on a malformed `citations` shape (null, string, integer, object) and returns the expected empty result. Reuse the carve-out clause-(c) header pattern from `hafsql.test.ts:661+`.
3. **Audit document.** Add a brief comment at the top of the test file (or a markdown note in the task's re-review signal) enumerating the audit results — every `jsonb_array_elements` site in `backend/src/` and its disposition (migrated / already correct / exempt with reasoning).
4. **`tsc --noEmit` clean. `npm run lint` clean. Targeted tests pass against real Postgres.**

## Out of scope

- Cycle-cascade sites (`citing_papers` CTE + `authorsWithSupersessionSelect`) — covered by the round-4 hold on `backend-self-review-exclusion-everywhere`. Coordinate so this task's audit step doesn't double-count or block on the sibling's fixes.
- Changes to upstream broadcast validation (e.g., reject malformed `pevo.citations` at publish time). The chain is the source of truth; defense lives at read time.
- Reputation-algorithm doc-sync — architect-zone, lands at archive.

## Coordination

- Sequencing: this task can land BEFORE the round-5 of `backend-self-review-exclusion-everywhere` (the sites are disjoint), OR after (cleaner — the audit step then includes the round-5 fixes as "already correct" references).
- Risk class: same as round-4 hold #1 on `backend-self-review-exclusion-everywhere`. Per `defense-in-depth-canary-must-pin-each-layer-2026-05-07`, each migrated site needs its own per-layer canary.

## Source

- `/ce-code-review` of `backend-self-review-exclusion-everywhere` commit `ba95a4a` (2026-05-16, architect re-review round-4):
  - reliability R-1 (P1, conf 90) — `citing_papers` CTE
  - adversarial #1 (P1, conf 85) — `authorsWithSupersessionSelect`
  - adversarial #2 (P1, conf 80) — notification-queries citations
  - learnings researcher — LATERAL evaluation order trap catalogued in `pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md`

## Cross-references

- `agents/docs/solutions/conventions/pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md` — the canonical convention this task instantiates.
- `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — per-layer canary requirement.
- `backend-self-review-exclusion-everywhere` round-4 hold items 1 + 2 (sibling cycle-cascade fixes).
