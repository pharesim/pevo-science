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

## Backend note (2026-06-01) — landed, with two flagged deviations

All casts wrapped in `CASE WHEN <regex> THEN ...::int END`. typecheck + lint clean;
real-Postgres canary + reputation-lifecycle / citing / papers-enrichment tests green.

Two departures from the literal spec, both made to actually satisfy the task's goal
(fail closed, query completes) rather than to expand scope. Flagging for review:

1. **Weight regex bounds digits: `^-?[0-9]{1,9}$`, not the suggested `^-?[0-9]+$`.**
   The unbounded form passes a 14-digit weight, which then overflows `::int`
   (`integer out of range`) and still aborts the query, defeating the fix. `{1,9}`
   (max +/-999,999,999) admits every legitimate Hive weight (+/-10000) while closing
   the overflow vector. `author_index`'s `^[0-9]{1,9}$` (the task's own regex) is
   already overflow-safe, so it is unchanged.

2. **Six enumerated sites + one the task missed = 7 guarded.** `routes/papers.ts`
   carries TWO identical `(cj.json::jsonb ->> 'weight')::int` revote casts (the
   enumerated detail-enrichment one plus a second voters-enrichment query). Both are
   the same broadcaster-controlled defect (a malformed revote weight 503s the
   enrichment endpoint), so both are guarded rather than leaving a knowingly-inconsistent
   half-fix in one file. Final inventory: 2 `author_index` + 5 `weight`.

3. **Test placement.** The canary lives in a new `tests/cast-hardening-author-index-weight.test.ts`
   (synthetic-VALUES behavioral + per-file source-shape canaries), not in the
   triage-suggested `reputation-batch-sql-failure.test.ts` — that file is about the
   batch orchestrator's cycle-advance decision under a mocked pool, an unrelated concern.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-06-09) — HELD PENDING FIXES (1 item)

`/ce-code-review` fan-out (correctness + security + adversarial on Opus; testing/maintainability/project-standards/performance/reliability/kieran-typescript on Sonnet; learnings unstructured; ce-agent-native skipped per PEvO) on commit `fa572740`. **The P0 fix is VERIFIED correct and complete and STAYS.** All 7 broadcaster-controlled cast sites (2 `author_index` + 5 `weight`) are regex-guarded and fail closed — the no-ELSE `CASE` yields NULL, dropped cleanly downstream (author_index by the `IS NOT NULL` accept-arm guards; weight by `!= 0` and the `SUM FILTER` aggregates) — so the query completes instead of aborting. The POSIX trailing-newline anchor trap was empirically refuted on PG 16.13 (`'5\n' ~ '^[0-9]{1,9}$'` → FALSE); ASCII-only `[0-9]` rejects full-width / Arabic-Indic / zero-width digits; the `{1,9}` bound closes the int4 overflow-re-abort that the spec's unbounded `+` would have left open; the drop is signer-bound (an accredited attacker can only NULL their own forged op, never erase a third party's signal). Sibling review-rating `::numeric`/`::float` casts are separately gated by `validReviewWhere`'s `^[1-5]$` and were never abortable. Both deviations the implementer flagged (the `{1,9}` bound; 7 sites incl. the two papers.ts weight casts the spec missed) are correct.

One item before archive:

1. (P2, maintainability) **Anchor the `{1,9}` overflow rationale in-source.** The reason the weight guard is `^-?[0-9]{1,9}$` and NOT the task's `^-?[0-9]+$` — an unbounded match admits a 14-digit string that then overflows `::int` and re-aborts the very query this fix protects — currently lives only in the commit message and the test docblock. A future editor reading `~ '^-?[0-9]{1,9}$'` at a guard site has no local cue and could "simplify" the bound to `+`, silently reopening the overflow-abort on this P0 path. Add a brief inline SQL comment at the weight-guard sites (or once per file near the first occurrence) stating the bound is overflow-safety (max Hive weight is 10000; an unbounded match overflows `::int` and aborts the query). Anchor on the behavioral reason — no task slug, round number, line number, or SHA. The same bound makes `author_index`'s `^[0-9]{1,9}$` overflow-safe too; a one-line note there is optional.

Dismissed at triage (no action): the papers.ts NULL-weight → `Number(null)===0` implicit self-retraction (correct as-is — signer-bound to the voter's own vote, caught by the `effectiveWeight===0` skip, matches existing retraction semantics, strictly better than the pre-fix crash); the preemptive test-hardening notes (the HAF-gated behavioral test could run on `getAppPool`; the exact 10-digit boundary case; test-local guard constants) — theoretical failure modes already backstopped by the source-shape count canary plus the real-HAF companion. Pre-existing comment-anchor rot in reputation.ts/papers.ts is tracked by the blocked `backend-haf-query-comment-anchor-sweep`, not this task.

When the comment lands, `git mv` this file back to `tasks/review/`. Do not edit the held item above — the commit diff is the evidence.

## Backend re-review signal (2026-06-09)

Anchored the `{1,9}` overflow rationale in-source (round-1 hold item 1). Added a one-line SQL comment at each weight-guard site — `reputation.ts` (the paper / review / citing revote arms) and `routes/papers.ts` (the detail-enrichment + voters-enrichment revote queries) — stating the bound is overflow-safety: an unbounded match admits a value that overflows `::int` and aborts the whole query (max Hive vote weight is 10000). Added the parallel one-line note at the `author_index` guard in `hafsql.ts`. Comment-only; anchored on the behavioral reason (no slug / round / line / SHA). `npm run typecheck` + `npm run lint` clean (the lone pre-existing `author-supersession.ts` unused-directive warning is untouched).
