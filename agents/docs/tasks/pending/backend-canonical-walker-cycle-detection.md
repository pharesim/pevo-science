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
- `agents/docs/tasks/pending/backend-haf-walker-wall-clock-budget.md` — sibling reliability task; cycle detection reduces its impact.

## [BLOCKED by Backend] (updated 2026-05-06, architect) — UNBLOCKED 2026-05-11

The "Sequencing: lands AFTER `backend-canonical-root-walker-author-gate` round-2 archives" constraint at the top of this file is a hard ordering dependency on the parent task's archive. **Architect re-reviewed the parent on 2026-05-06 and held it for round-3** (memo-threading omission at `resolveVersionsFromHaf:1421` plus two polish items); see the round-3 hold block at the bottom of `agents/docs/tasks/review/backend-canonical-root-walker-author-gate.md` (which has been `git mv`'d back to `tasks/pending/`). Backend now holds the next-action; this file stays blocked until round-3 lands and the parent archives.

**Unblocked 2026-05-11 (backend startup triage):** parent `BACKEND-CANONICAL-ROOT-WALKER-AUTHOR-GATE` archived 2026-05-06 round-3 clean (see `tasks-archive.md` heading). Both unblock conditions met (round-3 landed; parent archived). File moved `blocked/ → pending/`.

## Architect re-review (2026-05-16, round-1) — HELD PENDING FIXES

`/ce-code-review` ran on commit `3b5ca55` with 10 reviewers (correctness, security, adversarial at opus; testing, maintainability, project-standards, learnings, reliability, kieran-typescript, performance at sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Visited-Set primitive, seeding semantics (start + initial predecessor on backward; root on forward), check-before-push order on forward walker, mutation-kill matrix attestation, and the cycle-event emission discipline all land structurally correctly. Two items hold for round-2: one cross-reviewer-corroborated event-naming asymmetry (item 1, expanded to all 3 backward-walker events), and one convention violation on task-slug citations (item 2).

Several review findings were dismissed during architect triage: the iter-0 abort + null-permlink + memoKey-separator + cycle-event-type-alias items are all either pre-existing patterns, data-model-guaranteed-safe, or YAGNI for the call-site count. The mutation-kill comment attribution gap (cont_columns_invalid canary's stated discriminator vs the actual probe-count assertion that kills `visited.add()` removal) was dismissed as comment-only; the kill is real and the test stays green-on-orthogonal-mutations.

### Items to address (bundle into one round-2 commit)

**1. (P2, anchor 100, cross-reviewer maintainability + reliability + adversarial — ALSO bundles cross-task work from sibling wall-clock task review)** — Standardize all backward-walker event hop fields from `hopNumber: i + 1` (1-based) to `hopIndex: i` (0-based) for symmetry with the forward walker and with the wall-clock-budget events.

   Background: forward walker (`continuation_chain_*` events) emits `hopIndex: i`. Backward walker (`canonical_root_walker_*` events) emits `hopNumber: i + 1`. The wall-clock events landed in the sibling task (`backend-haf-walker-wall-clock-budget`) also use `hopIndex: i` on both walkers. So the 0-based form is the established convention; the backward walker's 1-based form is the outlier. An operator dashboard joining cycle-detected against unauthorized_hop against depth_exceeded against wall-clock-exceeded events on the same walker reads cycle depth off by 1 on the backward walker.

   This task's diff introduced the `canonical_root_walker_cycle_detected` event — the immediate scope of the asymmetry. The bundled scope (per user triage 2026-05-16) extends to the two other pre-existing backward-walker events that share the same off-by-one shape so the backward walker's event vocabulary converges in a single diff:

   Fix backward walker events to use `hopIndex: i`:
   - `canonical_root_walker_cycle_detected` (this task's diff, `papers.ts:~1735`): `hopNumber: i + 1` → `hopIndex: i`.
   - `canonical_root_walker_unauthorized_hop` (`papers.ts:~1662`, pre-existing): `hopNumber: i + 1` → `hopIndex: i`.
   - `canonical_root_walker_depth_exceeded` (`papers.ts:~1756`, pre-existing): if the event payload includes `hopNumber` or equivalent 1-based field, normalize to `hopIndex`.

   Update all test assertions that read these fields (canonical-root-walker.test.ts). Mutation-kill: any assertion still asserting `hopNumber` after the rename fails at type-check or at runtime; converge.

**2. (P3, anchor 100, cross-reviewer maintainability + learnings, convention violation)** — Drop the `See agents/docs/tasks/pending/backend-canonical-walker-cycle-detection.md` sentences at the 2 cycle-detection comment blocks in `papers.ts:~1335-1337` (forward walker) and `papers.ts:~1724-1726` (backward walker).

   Per convention `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, code comments citing task-file slugs become dead pointers when the task archives. The surrounding inline comments already explain the cycle-detection mechanism without needing a task citation; the "See..." sentences can be dropped entirely. ~2 LOC removed.

### Items dismissed during architect triage

- **(P1, kieran-typescript KT-1) Asymmetric null guard on `next.permlink as string` at `papers.ts:~1325`.** Dismissed on data-model grounds — the `IS NOT NULL` SQL guard upstream (loop-continuation probe predicate landed in sibling wall-clock task) prevents NULL `cont_permlink` from reaching this code path. Verified at user triage.
- **(P2, kieran-typescript KT-2) `memoKey` `/` separator invariant undocumented.** Dismissed as preemptive hardening — Hive account-name validation upstream enforces the charset constraint.
- **(P2, kieran-typescript KT-3) Cycle event string literals untyped (no `CanonicalRootCycleEvent` parallel to `CanonicalRootBailReason`).** Dismissed — only 2 events at low drift risk; type alias adds ceremony without much payoff.
- **(P3, conf 80, reliability R4) Mutation-kill comment attribution gap.** Test header attributes the `visited.add()` mutation kill to the cycle-event assertion; the probe-count assertion is actually the load-bearing killer for that specific mutation. Dismissed as comment-only nit; the kill is real per the matrix attestation.
- **Below-gate dropped:** adversarial ADV-1 (P3, conf 50) composition canonical-redirect surfaces; adversarial ADV-2 (info, conf 80) structural 1-extra-SQL on cycle (not actionable); reliability R2 (info, conf 70) missing startAuthor on backward; learnings #2/#4 (advisory polish); testing TG-1/TG-2 (theoretical-only per `feedback_dismiss_preemptive_test_hardening`); kieran-typescript KT-4 (P3, conf 50) test inline structural types.

### Re-review signal

When items 1-2 land in a single round-2 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only. Item 1 is structural (touches 3 event payloads + test assertions). Item 2 is comment-only.
