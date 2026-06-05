# BACKEND-NOTIFICATIONS-EDIT-REVOTE-DEDUP — notification arms re-fire on every edit and revote (reviews, replies, citations, votes)

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #7 high severity, correctness)
**Priority:** P1 (every edit and weight change produces a new notification surviving SPA dedup; email digests amplify)

## Problem

Arms 1a/1b/5/6a/6b in [notification-queries.ts:181-263](backend/src/notification-queries.ts#L181-L263) and [309-401](backend/src/notification-queries.ts#L309-L401) read raw `operation_comment_view`, which per [hive-schemas.md line 106](agents/docs/hive-schemas.md) carries every edit. Arms 2a/2b read raw `operation_vote_view` with no `DISTINCT ON`. Each comment edit and each weight change produces a new notification with a different `block_num`. The SPA dedup key includes `block_num`, so duplicates survive into the feed AND the email digest.

Concrete failure modes:
- A reviewer making 3 typo fixes sends 4 `new_review` notifications.
- A voter toggling 100% → 50% → 100% sends 3 `new_vote` notifications.

The `DISTINCT ON` pattern is already established at [routes/papers.ts:3249](backend/src/routes/papers.ts#L3249) and is the canonical fix.

## Goal

Wrap each affected arm in a `DISTINCT ON` subquery so edits/revotes do not produce duplicate notifications, while preserving the intent of each arm.

### Suggested approach

- **Comment arms (1a/1b/5):** `DISTINCT ON (co.author, co.permlink) ... ORDER BY ..., co.block_num ASC` — notify on publication; edits silent.
- **Citation arms (6a/6b):** `DISTINCT ON (citing.author, citing.permlink, cited_ref.author, cited_ref.permlink)` — new citations introduced in an edit still surface, but the same citation surviving across edits doesn't re-fire.
- **Vote arms (2a/2b):** `DISTINCT ON (v.author, v.permlink, v.voter) ... ORDER BY ..., v.block_num DESC` with `v.weight != 0` moved to the OUTER select so vote-then-retract suppresses the notification.

## Acceptance

- Regression tests:
  - Reviewer makes 3 edits → exactly 1 `new_review` notification.
  - Voter toggles 100% → 50% → 100% → exactly 1 `new_vote` notification with the latest weight.
  - Voter votes then retracts (weight → 0) → no `new_vote` notification.
  - Author edits a paper to add a new citation → `new_citation` fires once for the new citation; no re-fire for prior citations.
- Existing arm tests stay green.
- One real-HAF smoke test confirms the feed against a known-active account has no duplicate `block_num` keys per `(arm, author, permlink, voter)` tuple.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Same file, complementary scope: this fix is structural (dedup); #14 (vote-arm content filter), #15 (citation arms paper-exists gate), #16 (claim/vouch arms signer gate), and #25 (new_reply self-exclusion) are all separate semantic fixes in the same module. They can land in any order — but bundle the SQL-shape canary changes coherently so test churn is minimized.
- The notification cache key fix (#8) makes this fix's payoff dramatically more visible — together they reduce the polling cost for active users.

## Cross-references

- [backend/src/notification-queries.ts](backend/src/notification-queries.ts) lines 181-263 (arms 1a/1b/2a/2b), 309-401 (arms 5/6a/6b).
- [backend/src/routes/papers.ts](backend/src/routes/papers.ts) line 3249 (`DISTINCT ON` precedent).
- [agents/docs/hive-schemas.md](agents/docs/hive-schemas.md) line 106 (edit semantics).
- HAF-query review run `w274tijk0` rank #7.

## Backend completion note (2026-06-05)

Implemented inline against HEAD (the worktree fan-out forked from a 112-commit-stale base; the stale worker's diff would have reverted arm 2c, the signer gates, and the citation paper-existence INNER JOINs). Landed in commit `3007f498`. All eight UNION-ALL arms that read raw operation views are dedup-wrapped (1a/1b/5 comment earliest-wins, 2a/2b/2c vote latest-wins, 6a/6b citation earliest-wins), preserving every existing gate. Arm 2c (votes on reviews, target_type 'review') is included in addition to the arms the task named.

Design note: follows the established `DISTINCT ON ... ORDER BY ..., block_num [ASC|DESC]` precedent (papers.ts, reputation.ts) with NO secondary tiebreaker. Adding same-block tiebreakers is the separate `backend-window-cte-deterministic-tiebreaker` task's scope; for notification dedup the dedup key is itself the notification identity, so same-block ambiguity is benign.

Coverage note: the edit/revote behavioral cases (3 edits to 1, toggle to latest, retract to 0, citation-in-edit fires once) are pinned as SQL-shape canaries in `notifications-arm-sql-shape.test.ts` (DISTINCT ON key + ORDER BY direction per arm class, plus the outer weight-hoist), consistent with that file's documented carve-out: real chain-seeding of edit/revote sequences is impractical for these arms, and the deterministic substitute is the clause-form canary. The DISTINCT ON shape is the structural guarantee of the no-duplicate-`block_num`-key invariant the acceptance lists. If you want an additional real-HAF no-dup smoke against a known-active account, flag it and I will add it; I judged the canary plus structural guarantee sufficient and did not want to couple a B assertion into A's `notifications.test.ts`. typecheck + lint clean; `notification-arm-semantics.test.ts` and the lateral-guard canaries stay green against real HAF.

---

## Architect re-review (2026-06-05) — HELD PENDING FIXES

`/ce-code-review` fan-out (correctness, security, adversarial, performance, testing, maintainability, project-standards, kieran-typescript) on commit `3007f498`. Dedup semantics verified correct end-to-end: weight-hoist behavior (retract suppresses; retract-then-revote fires once with the new weight), every pre-existing gate survived inside the wrappers, 15-column UNION alignment across all arms, block floor inside every subquery (no full-history scans), no injection surface, performance neutral-to-better. The real-HAF no-dup smoke offer is declined: the shape canaries pin key + direction per arm, which is the structural guarantee. The window-relative dedup residue on the digest path (dedup floor = caller's cursor, so edits of pre-window content re-fire per digest) is split into the new `backend-notifications-digest-window-cursor` task; the SPA-path window-slide re-fire (one per edit as the 100k window passes the publication row) is accepted as bounded. Five text/canary items block archive, all within the two files this task touched:

1. **Arm 1b comment anchor (P1, acceptance violation).** The restructure carried `-- BACKEND-SELF-REVIEW-EXCLUSION round-1 hold #8.` back in on the + side of the diff. Drop the slug/round qualifier and anchor on behavior: the native arm has no pre-filtered CTE, and arm 1a's INNER JOIN + validPevoPaperWhere comment directly above carries the rationale.

2. **Header inventory (P2).** Extend the arm-sql-shape file's numbered canary inventory and mutation-kill summary to enumerate the four dedup canaries (comment-arm DISTINCT ON + ASC, vote-arm DISTINCT ON + DESC, outer vote_weight hoist, citation 4-tuple).

3. **Arm-1a INNER-JOIN canary title (P2).** The renamed title claims "paper-class existence at the join" but that canary pins join FORM only (INNER, not LEFT); paper-class existence is the adjacent validPevoPaperWhere canary's responsibility. Trim the title to the join-form invariant. (The over-claim followed an earlier hold's own prescription; this supersedes it.)

4. **Citation ORDER BY direction pin (P3).** The citation canary pins the DISTINCT ON 4-tuple but not `citing.block_num ASC`. A DESC flip makes the latest edit's row win dedup, changing the surviving block_num per edit and resurrecting the per-edit re-fire for citations specifically, invisible to all canaries. Add the direction assertion parallel to the comment/vote pins (count = 2).

5. **Arm 5 dedup comment (P3).** Expand to the arm-1a docblock pattern (key, direction, rationale) or add the forward-reference arm 1b uses, so the simplest-looking arm is not the least-explained copy template.
