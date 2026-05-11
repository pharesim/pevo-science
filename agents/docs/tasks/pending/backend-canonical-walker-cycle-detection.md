# BACKEND-CANONICAL-WALKER-CYCLE-DETECTION — visited-Set short-circuit on both chain walkers

**Owner:** Backend Agent
**Created:** 2026-05-05 (architect, surfaced by `/ce-code-review` correctness + reliability finding 6d on `backend-canonical-root-walker-author-gate`)
**Priority:** P3 (perf hardening; not a correctness bug)

## Why now

Both chain walkers in `backend/src/routes/papers.ts` are bounded by hop caps but neither detects cycles:
- **Backward walker** (`findCanonicalRoot`, cap = `CANONICAL_ROOT_MAX_HOPS = 10`).
- **Forward walker** (`resolveContinuationChain`, cap = `MAX_HOPS = 50`).

An attacker-posted A → B → A → B → ... cycle (mutually authorized — both authors cover each other's `pevo.authors[]`) consumes the full hop cap of SQL queries before exiting, even though the cycle is detectable in O(1) once a `(author, permlink)` pair is revisited. Bounded waste, not a correctness or security gap (depth cap absorbs the damage). For the backward walker that's 10 SQL queries instead of 2; for the forward walker, 50 instead of 2.

The per-request `HeadAuthorsMemo` already exists in scope and provides the right structural primitive — adding a sibling `Map<string, true>` (or extending the memo to track "visited as walker step") closes the cycle case structurally.

## Threat model

- **Attacker:** Hive accounts in mutual co-authorship (vouched by each other's `pevo.authors[]`).
- **Capability:** broadcast a cycle of continuation pointers (A → B → A → ...). Both gates admit since both are authorized.
- **Impact:** worst-case 10 / 50 SQL queries per request on a 2-node cycle. Bounded by depth caps. Not service-affecting at current traffic; would compound under sustained probing.
- **Detection:** `event: 'canonical_root_walker_depth_exceeded'` and analogous forward-walker depth-cap events fire. New event in this task: `event: '<walker>_cycle_detected'` distinguishes cycle from legitimate-deep-chain depth-exceedance.

## Goal

Add visited-Set cycle detection to both walkers. When walker revisits a `(author, permlink)` pair already in the visited set, stop the walk, return current as canonical / chain so far, emit `event: '<walker>_cycle_detected'`.

## Acceptance

### 1. Visited-Set primitive

Either:
- **Option (a)** — Per-walker-call local `Set<string>` keyed on `${author}/${permlink}` (matches memo key shape).
- **Option (b)** — Extend `HeadAuthorsMemo` to `Map<string, { authors: Set<string> | null; visited: boolean }>` so memo + cycle-detector share the same data structure.

Recommend **(a)** — simpler, decouples cycle detection from author-set caching, both walkers can use independently.

### 2. Backward walker (`findCanonicalRoot`)

After accepting a hop and computing the next `(currentAuthor, currentPermlink)`:
```ts
const visitedKey = memoKey(currentAuthor, currentPermlink);
if (visited.has(visitedKey)) {
  logger.warn(
    {
      event: 'canonical_root_walker_cycle_detected',
      childAuthor,
      childPermlink,
      cycleAuthor: currentAuthor,
      cyclePermlink: currentPermlink,
      hopNumber: i + 1,
    },
    'canonical-root walker detected cycle in continuation pointers',
  );
  return { author: currentAuthor, permlink: currentPermlink };
}
visited.add(visitedKey);
```

### 3. Forward walker (`resolveContinuationChain`)

Same shape. Forward walker's hop count is 50 vs backward's 10; cycle detection benefits forward walker more.

### 4. Tests

`backend/tests/routes/canonical-root-walker.test.ts` (extend):
- `'detects 2-node cycle (A → B → A) on backward walk and stops with cycle event'`
- `'detects N-node cycle (A → B → C → A) on backward walk'` (N=3 to verify the visited Set, not just immediate-back-edge)

`backend/tests/routes/continuation-author-gate.test.ts` (extend):
- Same shape for the forward walker.

### 5. Mutation-kill attestation

Backend signal block must attest: cycle canaries fail when the visited-Set check is removed (i.e., reverting to the original depth-cap-only behavior makes the canary's "cycle event fires" assertion fail because the depth-exceeded event fires instead).

## Out of scope

- Cross-request cycle caching (Redis-side). Per-request Set is sufficient; cycles are attacker-posted on chain so cross-request would not help (each request still walks at least once).
- Restructuring the walker loop entirely. The visited check is a 4-line addition before each hop assignment.
- Cycle detection on `reconstructVersionsFromHaf` directly (it calls `resolveContinuationChain` so the forward walker's check covers it).

## Coordination

- **Sequencing:** lands AFTER `backend-canonical-root-walker-author-gate` round-2 archives. No file conflict.
- **Wall-clock budget interaction** (`backend-haf-walker-wall-clock-budget.md`): cycle detection short-circuits at O(N_unique_nodes) instead of O(hop_cap), reducing the wall-clock budget impact of cycles. Both signals coexist; cycle event has higher operator-actionable priority than wall-clock event when both fire.

## Source

`/ce-code-review` round-1 of `backend-canonical-root-walker-author-gate`, correctness + reliability reviewers (P3 conf 65-70). User triage 2026-05-05 elected option (e): observability hop-number into round-2 hold; cycle detection into this separate task; depth-cap-style asymmetry and `makeHeadAuthorsMemo` factory dismissed.

## Cross-references

- `agents/docs/tasks/review/backend-canonical-root-walker-author-gate.md` — round-2 hold (parent task; this task adds the cycle dimension).
- `backend/src/routes/papers.ts:805-852` (`findCanonicalRoot`), `:850-1000` (`resolveContinuationChain`).
- `agents/docs/tasks/blocked/backend-haf-walker-wall-clock-budget.md` — sibling reliability task; cycle detection reduces its impact.

## [BLOCKED by Backend] (updated 2026-05-06, architect)

The "Sequencing: lands AFTER `backend-canonical-root-walker-author-gate` round-2 archives" constraint at the top of this file is a hard ordering dependency on the parent task's archive. **Architect re-reviewed the parent on 2026-05-06 and held it for round-3** (memo-threading omission at `resolveVersionsFromHaf:1421` plus two polish items); see the round-3 hold block at the bottom of `agents/docs/tasks/review/backend-canonical-root-walker-author-gate.md` (which has been `git mv`'d back to `tasks/pending/`). Backend now holds the next-action; this file stays blocked until round-3 lands and the parent archives.
