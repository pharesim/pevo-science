# BACKEND-WINDOW-CTE-DETERMINISTIC-TIEBREAKER — `ROW_NUMBER` and `DISTINCT ON` lack deterministic same-block tie-breakers

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #33 low severity, correctness)
**Priority:** P3 (same-block toggle votes or rapid operator accredit/revoke can flip non-deterministically)

## Problem

`ROW_NUMBER OVER PARTITION ORDER BY block_num DESC` (`accred_ranked`, `vouch_ranked` in [hafsql.ts:148, 264](backend/src/hafsql.ts), [883-891](backend/src/hafsql.ts#L883-L891)) and `DISTINCT ON (v.voter) ORDER BY v.voter, v.block_num DESC` (vote queries in [routes/papers.ts:104, 3249-3253, 3277-3281](backend/src/routes/papers.ts#L3249-L3253), [routes/profile.ts:614](backend/src/routes/profile.ts#L614), [reputation.ts:623, 812, 912](backend/src/reputation.ts)) lack deterministic tie-breakers for same-block ops.

Same-block toggle votes or rapid operator accredit/revoke can flip non-deterministically.

Documented convention exists ([hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2](agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md)) — `cj.id` / `id` is the monotonic tie-breaker. The 8 vote sites and 2 ROW_NUMBER sites need landing together to avoid the very partial-fix drift the finding flags.

## Goal

Add deterministic same-block tie-breakers at every affected site in one atomic landing.

### Suggested approach

Single atomic backend task. Two patterns:

- **Window CTEs (`accred_ranked`, `vouch_ranked`):** append `, cj.id DESC` to ORDER BY (id already projected as `event_id`).
- **Vote queries:** extend each `ORDER BY ... block_num DESC` to `... block_num DESC, trx_in_block DESC`. Verify `operation_vote_view` projects `trx_in_block`; fall back to `id DESC` per convention if not.

Cite the convention doc in a brief comment at each site (one-line anchor, not a docblock — the convention path itself is the durable anchor).

## Acceptance

- All 10 sites (2 window CTEs + 8 vote sites) carry the tie-breaker, landed as one commit so no drift is introduced mid-rollout.
- Regression test for same-block toggle votes: assert deterministic resolution to the latest op.
- Regression test for same-block accredit/revoke: assert deterministic resolution.
- Cycle output for the existing seed unchanged in the common case (no same-block ties).
- Comment anchors clean (convention-path citation is fine; no task slug, round number, line number, SHA).
- `npm run typecheck` + `npm run lint` clean.

## Notes

- This is the partial-fix drift trap from the existing convention doc — bundle every site in one task.

## Cross-references

- [backend/src/hafsql.ts](backend/src/hafsql.ts) lines 148, 264, 883-891.
- [backend/src/routes/papers.ts](backend/src/routes/papers.ts) lines 104, 3249-3253, 3277-3281.
- [backend/src/routes/profile.ts](backend/src/routes/profile.ts) line 614.
- [backend/src/reputation.ts](backend/src/reputation.ts) lines 623, 812, 912.
- [agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md](agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md) Rule 2.
- HAF-query review run `w274tijk0` rank #33.

## Implementation note (backend, 2026-06-06)

Landed all 10 enumerated sites in one commit. The cross-reference line numbers
had drifted; sites were located by grepping `ROW_NUMBER` / `DISTINCT ON` /
`ORDER BY ... block_num DESC`.

- **Tie-breaker column:** `operation_vote_view` and `operation_custom_json_view`
  do NOT project `trx_in_block` (verified against the live HAF view: columns are
  `id, timestamp, voter, author, weight, permlink, block_num`). Per the convention
  doc's fallback rule, the monotonic HAF op `id` is the tie-breaker everywhere
  (`v.id DESC` / `cj.id DESC`; reputation's union CTEs project `op_id` from each
  arm — native `vo.id`, revote `cj.id` — then `op_id DESC`).
- **The 10 sites:** window CTEs `accred_ranked` + `vouch_ranked` (`hafsql.ts`);
  DISTINCT-ON vote sites `accreditedVoteCount` (`hafsql.ts`), batch native votes +
  per-paper accredited voters + review net_votes (`papers.ts` ×3), review net_votes
  (`profile.ts`), and `paper_latest_votes` + `review_latest_votes` +
  `citing_latest_votes` (`reputation.ts` ×3).
- **Self-caused test fix (in-scope):** `vouch_ranked` now requires `id` in its
  synthetic VALUES; `active-vouches-signer-gate.test.ts` was updated to project it.

### [Architect triage] related latest-wins sites OUTSIDE this task's enumerated 10
These are latest-*config*/op-wins selections that share the same-block-ambiguity
class but were not in the task's vote/accred scope. Flagging for a triage decision
(file follow-up, or accept as practically-never-tied):
- `reputation.ts` `update_weights` config: `ORDER BY cj.block_num DESC LIMIT 1` (no
  tie-breaker; admin op, same-block tie practically impossible).
- `profile.ts` (early custom_json selection): `ORDER BY cj.block_num DESC`.
- `papers.ts` revote query: `ORDER BY cj.block_num DESC` (dedups via Map insertion
  order downstream, so deterministic-by-Map, but SQL ordering is same-block-ambiguous).
- `tests/bench-reputation.ts`: hand-copied vote-signal SQL (a benchmark, not a test)
  with no tie-breaker.

Verification: typecheck + lint clean; new `window-cte-deterministic-tiebreaker.test.ts`
3/3 (same-block accredit/revoke + toggle votes proven deterministic across reordered
VALUES); reputation-lifecycle (real HAF, validates the merged `op_id` SQL is
executable), reputation-coauthor-claim-credit, active-vouches, hafsql all green on
the integrated main tree.

## Architect review (2026-06-09) — HELD PENDING FIXES (2 items, + 2 bundled)

`/ce-code-review` (correctness + adversarial on Opus; testing, maintainability, project-standards, performance on Sonnet; learnings-researcher; ce-agent-native-reviewer skipped per PEvO) on commit b02ad69d. **The enumerated 10-site change is VERIFIED CORRECT**: every DISTINCT ON `ORDER BY` begins with its DISTINCT ON key before the `block_num/id` tiebreaker; both ROW_NUMBER CTEs add `cj.id DESC` without changing the no-tie result; and — verified empirically against the live HAF node — `id` is a GLOBAL monotonic `haf_operations` PK shared across `operation_vote_view` and `operation_custom_json_view`, so the cross-arm `op_id DESC` tie-break in the reputation union CTEs is genuinely latest-wins, not merely deterministic. But the task's "atomic landing of ALL latest-op-wins sites, no partial-fix drift" acceptance is **not met**: the fleet found latest-wins sites OUTSIDE the enumerated 10 that share the exact pattern of fixed sites.

### Items held (must fix before archive)

1. (P2, correctness, confidence 80) MISSED SITE — `getAccreditedSet` (`accreditation.ts`) inlines the same `ROW_NUMBER() OVER (PARTITION BY …'account' ORDER BY cj.block_num DESC)` pattern fixed in `accred_ranked`, but WITHOUT `cj.id DESC`. This is the primary accreditation gate (called from wot / search / reviews / claims / profile), so a same-block accredit/revoke resolves non-deterministically here and can disagree with the now-deterministic `active_accreditations` CTE. Either append `, cj.id DESC` + the convention-path comment, or (preferred) refactor `getAccreditedSet` to reuse `activeAccreditationsCteBody` so the latest-wins logic has a single source of truth.
2. (P2, testing, confidence 90) The SQL-shape canary pins the tiebreaker at only 2 of the patched sites (`activeAccreditationsCteBody`, `accreditedVoteCount`); the behavioral tests skip when HAF is unconfigured (CI), so the other inspectable sites have no always-on guard. Extend the canary to assert the `block_num DESC, …id DESC` tiebreaker at every site reachable through an exported fragment — at minimum `activeVouchesCteBody` (vouch_ranked). The three reputation union CTEs are not exported as fragments; note that limitation in the test rather than leaving it silent.

### Bundled while in these files (cheap, land with 1-2)

3. (P3, correctness, confidence 80) MISSED SITE — the accreditation list endpoint (`routes/accreditations.ts`) hand-copies the same `accred_ranked` ROW_NUMBER pattern without the tiebreaker (display-surface drift). Same one-line fix as item 1.
4. (P3, correctness, confidence 75) The three reputation union-CTE comments say op_id is "monotonic per source stream", which UNDERSTATES the verified global monotonicity. Reword to document the global-`haf_operations`-id invariant (comparable across the vote and custom_json views) so a future maintainer does not "fix" the cross-arm union by namespacing op_id and break the genuine cross-arm latest-wins.

### Accepted residuals / dismissed (no implementer action)

- (P3, adversarial) `batchResolveVotes` (`papers.ts`) reconciles same-block native-vote-vs-revote in JS by `block_num >`, so cross-arm same-block ties resolve native-always — diverging from reputation's op_id ordering. DISPLAY surface only (net_votes / sort=votes); reputation scoring and accreditation state are unaffected; requires a same-block (<3s) native+revote collision by the same voter on the same paper. Accepted as a known display-surface residual at PEvO scale (the implementer already self-flagged this site out-of-scope); may be addressed in a future `papers.ts` pass, not a blocker here.
- The implementer's other self-flagged out-of-scope sites — `update_weights` read `ORDER BY cj.block_num DESC LIMIT 1` (admin-singular, practically never tied; adversarial agrees acceptable on the single-instance posture), `profile.ts` early custom_json selection, and `tests/bench-reputation.ts` (a benchmark, not a correctness path) — accepted as-is.

### Architect companion action (deferred to clean archive — NOT implementer work)

- The convention doc `hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` Rule 2 still shows `cj.trx_in_block DESC` as the "correct" example and claims `trx_in_block` is exposed — but the deployed HAF mirror views omit it (the reason this whole task exists). Anyone implementing a new latest-wins site from the doc would copy the wrong, absent column. The architect will correct Rule 2 to use `id` (the global `haf_operations` PK) when this task re-reviews clean and archives, alongside a `/ce-compound` on the partial-fix-drift / convention-sweep-misses-semantic-siblings lesson.

### Re-review signal

When items 1-4 land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; the next review scopes to the fix commits only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
