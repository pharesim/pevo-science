# BACKEND-AUTHOR-INDEX-CAST-HARDENING — `(cj.json ->> 'author_index')::int` crashes the entire reputation cycle and HAF read surface on one malformed custom_json

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, ranks #4 + #18 high+medium severity, correctness; merged into one task per the synthesis recommendation)
**Priority:** P0 (one broadcaster-controlled bad event aborts the daily reputation batch for every user and 500s every read-surface query touching the targeted paper)

## Problem

Two sites cast `(cj.json::jsonb ->> 'author_index')::int` over broadcaster-controlled custom_json with **no shape guard**:

1. **[hafsql.ts:692](backend/src/hafsql.ts#L692)** (`authorshipClaimsCteBody`) — cascades to `claims.ts`, `profile.ts`, and paper-detail in `papers.ts`. Every viewer of the targeted paper gets 500s until the op is purged from the scope.
2. **[reputation.ts:468-483](backend/src/reputation.ts#L468-L483)** (`claim_events`) — unscoped path; one bad event breaks the daily `computeReputationBatch` for every user.

A single forged `claim_authorship` with `author_index:"abc"` raises `invalid_text_representation` and aborts the whole query. The same defense pattern (`jsonb_typeof` / regex guards) already exists elsewhere in the codebase.

Companion: the same files have unguarded `(weight)::int` casts on three revote arms (`paper_vote_signals`, `review_vote_signals`, `citing_vote_signals` — plus `papers.ts:3322`'s revote weight). Downvotes are valid (negative integers), so the regex needs to admit a leading minus.

## Goal

Replace bare casts with regex-guarded `CASE WHEN ... THEN (...)::int END` shapes so a malformed broadcaster string fails closed (the offending row drops; the query completes) instead of aborting.

### Suggested approach

For `author_index` (non-negative integer):

```sql
CASE WHEN (cj.json::jsonb ->> 'author_index') ~ '^[0-9]{1,9}$'
     THEN ((cj.json::jsonb ->> 'author_index')::int)
END
```

For vote `weight` (signed integer, downvotes valid):

```sql
CASE WHEN (cj.json::jsonb ->> 'weight') ~ '^-?[0-9]+$'
     THEN ((cj.json::jsonb ->> 'weight')::int)
END
```

Apply at both `author_index` sites AND audit the three revote-arm `weight` casts in `reputation.ts` plus `papers.ts:3322`. The two `author_index` fixes plus the revote-weight audit land as one task.

## Acceptance

- Real-Postgres canary test injecting `{"action":"claim_authorship", "author_index":"abc"}` (or other non-integer) into a scoped custom_json and asserting:
  - `authorshipClaimsCteBody`-backed query does NOT throw.
  - `claim_events` (reputation cycle path) does NOT throw on a daily-batch run.
- Equivalent canary for a non-integer vote `weight` (e.g. `"weight": "abc"`) hitting one of the revote arms — query completes, that row's contribution drops, others process normally.
- Existing legitimate ops (numeric `author_index`, signed integer `weight`) still process identically (positive + negative integer cases pinned).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Originally surfaced as ranks #4 (hafsql) + #18 (reputation) — merged because they're literally the same bug at two sites and the test/canary infrastructure overlaps fully.
- The weight-cast audit is in scope because it's the same defect class on adjacent lines; do NOT defer it.
- Land before rank #28 (`backend-reputation-claims-cte-dedup`) so the dedup's merge target already has the guard.

## Cross-references

- [backend/src/hafsql.ts](backend/src/hafsql.ts) line 692 (`author_index` cast in `authorshipClaimsCteBody`).
- [backend/src/reputation.ts](backend/src/reputation.ts) lines 468-483 (`author_index` cast in `claim_events`); audit revote-arm `weight` casts in same file.
- [backend/src/routes/papers.ts](backend/src/routes/papers.ts) line 3322 (revote weight cast).
- Sibling `jsonb_typeof` / regex-guard examples already present in the codebase (grep for `~ '^` patterns over JSONB extracts).
- HAF-query review run `w274tijk0` ranks #4 + #18.
