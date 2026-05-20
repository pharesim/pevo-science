---
title: "Parallel architect sessions independently file duplicate follow-up tasks for the same cross-cutting concern"
date: 2026-05-20
category: conventions
module: agent-coordination
problem_type: convention
component: agent_coordination
severity: medium
applies_when:
  - "Two or more architect sessions are reviewing related tasks in the same review cluster in parallel (HAF-503 cluster, bridge/broadcast-resilience cluster, supersession cluster, comment-anchor-sweep cluster, etc.)"
  - "A reviewer persona surfaces a cross-cutting concern (rate-limit slot-burn, timer-guard adoption, retriable-503 helper extraction, supersession-projection parity) that could plausibly be derived from a sibling task's audit table or from a sibling commit's review"
  - "About to file a new follow-up task to `tasks/pending/` from a review pass and the session has been active for >15 minutes since the startup-protocol bucket listing"
tags:
  - architect-coordination
  - task-filing
  - duplicate-detection
  - cluster-review
  - multi-agent
  - scoping-race
related_components:
  - documentation
  - development_workflow
---

# Parallel architect sessions independently file duplicate follow-up tasks for the same cross-cutting concern

## Context

PEvO runs multiple architect sessions concurrently against one `.git`. During a multi-cluster review pass, sibling architects independently process overlapping review surfaces — different commits, different `/ce-code-review` fan-outs, different reviewer personas — but the findings produced often converge on the same cross-cutting concern (rate-limit slot-burn, timer-guard adoption, retriable-503 helper extraction, supersession parity).

The startup-protocol bucket listing of `agents/docs/tasks/pending/` is performed once at session start. A typical review-then-triage-then-file pass takes 20–40 minutes (fan out 8 reviewers per commit, walk 20+ findings one-by-one). During that window, a sibling architect can file a task for the same underlying fix from a different review path. The session-start listing is stale by file-creation time, and no second check fires unless the architect adds one explicitly.

The result is two task files in `pending/` for the same fix, each with a different slug and different framing. One is strictly more comprehensive than the other; the duplicate has to be dropped, but only after both were filed, reviewed, and triaged.

## Guidance

**Before filing a follow-up task from a review pass, re-check `tasks/pending/` and recent architect commits at file-creation time, not at session start.** The check is cheap and catches sibling-authored tasks that landed during the current session's triage window.

Concrete check, run immediately before `Write`-ing the new task file:

```bash
# 1. Re-list pending/ for the topic keywords (slug fragments most likely to collide)
ls agents/docs/tasks/pending/ | grep -iE 'register|rate-limit|byip|skipfailed'

# 2. Scan recent architect commits for task-filing activity since session start
git log --author=pharesim --oneline -20 | grep -iE 'register|rate-limit|byip|skipfailed|file.*follow-up'

# 3. If either turns up a candidate, READ the sibling file before deciding:
#    - Same fix, sibling more comprehensive   -> drop yours, do NOT file
#    - Same fix, yours more comprehensive     -> drop sibling's (git rm), file yours, note supersession in commit msg
#    - Adjacent but distinct scope            -> file yours, cross-reference sibling's slug in the body
```

Pick keyword fragments wide enough to catch slug variants. Sibling architects will not pick the same slug — the 2026-05-20 incident produced `backend-register-rate-limit-lock-held-burn` vs `backend-register-rate-limit-byip-skipfailed` for the same fix. Grep on the shared noun (`register`, `rate-limit`), not the slug shape.

The `git log` grep covers the case where the sibling has committed but the topic word is in the commit subject rather than in the slug — and on a shared `.git`, every architect commit is already in the local log without needing to fetch.

This is a paired discipline with [[multi-round-task-at-archive-followup-blindness-2026-05-20]] — that convention prescribes a grep-for-`at archive`-prescriptions check at archive intake; this one prescribes a grep-for-duplicates check at task-creation time. Both run at architect-intake checkpoints with the same shape (`ls` + `git log`).

## Why This Matters

The two existing concurrent-architect convention docs — [[concurrent-agent-staging-sweep-2026-05-12]] and [[parallel-agent-git-index-race-2026-05-15]] — cover **index-layer** races: the shared mutable git index, the staging sweep, the destructive rewind. They prescribe `git diff --cached --name-only` verification and forward-only cleanup. They do not cover **scoping-layer** races, where two architects independently arrive at the same task scope through different review paths and produce two task files for one fix.

The scoping-layer race is not a rare collision; it is the expected outcome of parallel reviews touching adjacent code. Cross-cutting concerns surface from multiple review paths by design — that's what makes them cross-cutting. When the cluster has 2+ active review sessions, "near-certainty" becomes "always assume a sibling is filing this too."

Impact when undetected:

- **Wasted review cycles.** The duplicate gets reviewed alongside the comprehensive sibling, then dropped. Two `/ce-code-review` fan-outs (one for the duplicate's own review pass, plus the supersession-detection work) run for nothing.
- **Implementer confusion.** A backend agent listing `pending/` at startup sees two overlapping task files and has to decide whether they're truly distinct or one supersedes the other. The disambiguation work falls on the implementer, who has less context than either architect.
- **Archive history pollution.** If both get archived (because the duplicate is found late), `tasks-archive.md` contains two entries for one fix, and the 250-line trim window evicts unrelated older entries faster.
- **Risk of implementer picking the weaker scope.** If detection misses entirely and the implementer picks the duplicate up first, they may implement the narrower scope (e.g., only LOCK_HELD path, not the HAF-503 path) and archive before the comprehensive sibling is even seen.

The prevention check is two shell commands. The avoided cost is one full review cycle plus implementer disambiguation.

## When to Apply

Run the re-check at **task-file-creation time** during any review pass when:

- The current session has been active for >15 minutes since startup-protocol listing.
- A sibling architect is known or suspected to be active (default posture per root `CLAUDE.md`: assume yes).
- The finding is a **cross-cutting concern** — slot-burn cascades, primitive adoption sweeps, helper extraction, supersession parity, retriable-error helper extraction. These surface from multiple review paths by construction.
- The review cluster spans 2+ commits touching adjacent code (e.g., a bridge/broadcast-resilience cluster touching multiple rate-limited endpoints, or an HAF-cluster touching multiple 503-emitting routes).

Skip the check for narrow, surface-local findings (a typo in one file, a single-route response-envelope fix) where multi-path discovery is unlikely.

Adjacent but distinct: [[defer-architect-doc-rewrite-when-cluster-sibling-touches-same-doc-2026-05-19]] covers the related case where the duplicated artifact is a documentation edit rather than a task file. The mechanical check is similar; the artifact is different.

## Examples

### 2026-05-20 UI HAF-cluster review — register-rate-limit duplicate

Setup: two architect sessions reviewing the bridge/broadcast-resilience cluster in parallel.

Session A's path:

- Reviewed UI bridge round-1 commit `01931666`.
- `/ce-code-review` reliability reviewer surfaced: LOCK_HELD auto-retries burn `registerLimiter` slots on `/api/bridge/register` because the limiter lacks `skipFailedRequests: true`.
- Triage routed to "file as new backend task" (~30 min after session start).
- Filed `agents/docs/tasks/pending/backend-register-rate-limit-lock-held-burn.md` in commit `e7c1e0a0`.
- Did NOT re-list `pending/` between triage and `Write`.

Session B's path (concurrent):

- Reviewed `backend-retract-rate-limit-haf-503-burn` round-2 commit `6e7c4f91`.
- The retract task's audit-table-of-other-byIp-limiters explicitly flagged `registerLimiter` as a candidate for the same `skipFailedRequests` fix.
- Filed `agents/docs/tasks/pending/backend-register-rate-limit-byip-skipfailed.md` independently.

Outcome:

- Both files landed in `pending/` within minutes.
- Session B's file was strictly more comprehensive: P2 priority (vs A's P3), both LOCK_HELD AND HAF-503 paths (vs A's LOCK_HELD only), 3 mutation-kill canaries (vs A's 1), explicit out-of-scope enumeration of other byIp limiters that MUST NOT be widened.
- Session A dropped its duplicate in commit `0e215b9a`.

**Before (session A's actual flow):**

```text
00:00  session start, ls tasks/pending/  -> no register-rate-limit task
...    triage UI bridge round-1, fan out 8 reviewers, walk 23 findings
00:30  reach LOCK_HELD slot-burn finding, decide "file as new task"
00:31  Write backend-register-rate-limit-lock-held-burn.md   <-- no re-check
00:33  git add + git commit  e7c1e0a0
...    later: discover sibling's backend-register-rate-limit-byip-skipfailed.md
       already exists; drop duplicate in 0e215b9a
```

**After (with prevention check):**

```text
00:00  session start, ls tasks/pending/
...    triage UI bridge round-1
00:30  reach LOCK_HELD slot-burn finding, decide "file as new task"
00:30  ls agents/docs/tasks/pending/ | grep -iE 'register|rate-limit'
       -> backend-register-rate-limit-byip-skipfailed.md
00:30  Read sibling file -> sibling is strictly more comprehensive
00:30  Do NOT file. Note the no-file decision in chat-back to user.
       Move on to next finding.
```

The single `ls | grep` at 00:30 (cost: ~50ms) avoids the 00:31 `Write`, the 00:33 commit, and the later supersession-detection + drop work in `0e215b9a`.

### Co-occurrence with the index-layer race

The same session A also hit the index-layer race covered by [[concurrent-agent-staging-sweep-2026-05-12]] — commit `ced506d0` swept two sibling-staged deletions into the architect's hold-block commit. Recovery was `git reset --soft <my-sha>^` + `git restore --staged <foreign-paths>` + re-commit.

The index-layer race and the scoping-layer race are distinct failure modes that co-occur naturally during parallel reviews: the staging-discipline convention catches the former, this convention catches the latter. The two conventions compose — pre-`Write` re-listing prevents the duplicate task; pre-`commit` index verification prevents the contaminated commit.

## Related

- [[multi-round-task-at-archive-followup-blindness-2026-05-20]] — paired convention at the same architect-intake-checkpoint lifecycle moment. Same-date sibling; both prescribe `ls` + `git log` checks. That convention catches missed `at archive` prescriptions from prior rounds; this one catches duplicate task filings from parallel sessions.
- [[defer-architect-doc-rewrite-when-cluster-sibling-touches-same-doc-2026-05-19]] — closest sibling on the cluster-coordination axis. Different artifact (doc edits vs. task files), same cluster-context premise.
- [[concurrent-agent-staging-sweep-2026-05-12]] — sibling git-index-layer race. Index-layer contention rather than scoping-layer collision. Both can co-occur in one session (and did, on 2026-05-20).
- [[parallel-agent-git-index-race-2026-05-15]] — same family as `concurrent-agent-staging-sweep`. Cited together as the index-layer pair that this scoping-layer convention complements.
- [[re-review-intake-supersession-check-2026-05-05]] — adjacent precedent for "add a mechanical intake check before fanning out / committing." Different artifact (commit SHAs / diff scope vs. task files); same intake-checkpoint shape.
