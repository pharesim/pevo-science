# BACKEND-REPUTATION-ACTIVE-AUTHORS-ACCREDITED-FILTER — `active_authors` materializes site-wide author universe before intersecting with `accreditedArr`

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #17 medium severity, performance)
**Priority:** P2 (full corpus scan for rows that get discarded by the only consumer)

## Problem

`active_authors` in [reputation.ts:421-465](backend/src/reputation.ts#L421-L465) UNIONs every PEvO paper site-wide and every review-shaped comment, but its ONLY consumer (`voter_weights` at line 464) joins on `aa.author = a.voter` where `a.voter` iterates `accreditedArr`.

The review arm already has `c.author = ANY($2)`; the paper arm has no such filter — full corpus scan for rows that get discarded.

## Goal

Push the `accreditedArr` filter into the paper arm so `active_authors` only materializes accredited authors.

### Suggested approach

Add `AND c.author = ANY($2::text[])` to the paper arm (line 423-426). Semantically equivalent for the consumer.

Do NOT add the bridge-author OR — bridge papers' `c.author` is the bridge account, never a voter.

## Acceptance

- Trivial one-line change.
- Regression test: cycle output for the same `accreditedArr` is byte-identical to pre-change (modulo any noise; this is a perf-only change with no semantic delta).
- `EXPLAIN ANALYZE` shows the paper arm scans bounded by accredited-author set, not full corpus.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Smallest fix in the batch. Land any time after #1 (cycle off-by-one) — the cycle has to be actually computing for the perf delta to matter.

## Cross-references

- [backend/src/reputation.ts](backend/src/reputation.ts) lines 421-465 (`active_authors`), line 464 (`voter_weights` consumer).
- HAF-query review run `w274tijk0` rank #17.

## Architect re-review (2026-06-06) — HELD PENDING FIXES (2 items)

`/ce-code-review` (correctness + adversarial on Opus; performance, testing, maintainability, project-standards on Sonnet; cluster learnings-researcher; ce-agent-native-reviewer skipped per PEvO) on commit 5193af77. The core change is verified CORRECT and genuinely perf-only: `voter_weights` is the sole consumer of `active_authors` (2 SQL-real occurrences in the template, both verified), `$2` is accreditedArr at both the filter and the `unnest` join, bridge papers' `c.author` is the bridge account (excluded rows were already discarded by the join), the anon-proxy asymmetry between arms is correct (the proxy is never in accreditedArr), and the canary's CTE slicing anchors resolve uniquely. Two items hold.

### Items held (must fix before archive)

1. (P2, performance) The acceptance bullet "EXPLAIN ANALYZE shows the paper arm scans bounded by accredited-author set" is undischarged: no plan output exists in the task file or commit. Run EXPLAIN (ANALYZE, BUFFERS) on the paper arm against the HAF replica and paste the relevant plan lines into this file. Gathering hints from a prior session: the box has no psql, so drive it from a /tmp Node script loading the backend's pg module via createRequire; connect directly with the backend's HAF connection string; pgbouncer rejects `statement_timeout` as a startup parameter, so set it per-session (or skip it) rather than in connection options.
2. (P2, maintainability) The new SQL comment cites positional params ("Bridge accounts ($17/$18)", "unnest($2::text[])"). Positional numbers rot silently when the params array grows. Replace with the stable names the function docblock already maps: hiveBridgeAccount / hiveAnonAccount for the bridge sentence, and let "(accreditedArr)" carry the voter sentence without the `$2` position. No SQL change, comment only.

While addressing the holds, append a brief `## Implementation notes` section (this task moved to review in a batch commit without one; the canonical task-file shape expects it).

### Items dismissed at triage (no action)

- Byte-identical differential cycle-output test: equivalence is mechanically proven (single-consumer + same-param join domain); a retroactive pre-change baseline does not exist. Matches the "mechanically proven" dismissal precedent from the cycle-boundary review.
- Canary hardening for a hypothetical second UNION ALL inside the paper arm, and ANY() planner behavior at thousands-scale: theoretical-only at PEvO scale.

### Re-review signal

When both items land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; the next architect review scopes `/ce-code-review` to the fix commits only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
