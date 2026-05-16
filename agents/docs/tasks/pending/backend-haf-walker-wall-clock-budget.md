# BACKEND-HAF-WALKER-WALL-CLOCK-BUDGET — AbortController-bounded HAF walker request budgets

**Owner:** Backend Agent
**Created:** 2026-05-05 (architect, surfaced by `/ce-code-review` reliability finding 5b on `backend-canonical-root-walker-author-gate`)
**Priority:** P2 (reliability)

## Why now

`backend/src/routes/papers.ts` `findCanonicalRoot` (BACKWARD walker, capped at 10 hops × 2 SQL queries) and `resolveContinuationChain` (FORWARD walker, capped at 50 hops × ≥1 SQL query) bound their depth via hop-count caps but have NO wall-clock budget. With the HAF pool's `statement_timeout = 30000ms` (`backend/src/db.ts:22`), the worst-case scenarios are:

- **Backward walker:** 10 hops × 2 sequential queries × 30s = 600s (~10 minutes) per request before depth-cap or error short-circuits.
- **Forward walker:** 50 hops × ≥1 query × 30s = up to 1500s (~25 minutes) per request.
- **`reconstructVersionsFromHaf` + `fetchPaperDetailFromHaf` cascading calls:** worst-case compounding across cascading helper calls.
- **`fetchHeadAuthorizedAuthors`** (called from both walkers): per-call statement_timeout but no walker-level budget.

Under sustained degraded HAF (transient timeouts, slow recovery) plus attacker probing, a single worker thread can occupy the full statement_timeout × hop_count product. For Node.js with N event-loop workers, ~N concurrent attacker requests can saturate worker threads while the depth caps absorb the per-request exit conditions. The DoS-amplifier defense added in `backend-canonical-root-walker-author-gate` (round-1 commit `e2f7e1b`, depth cap 10) is correct for HAF in its happy-path latency regime but leaves the degraded-HAF tail open.

## Threat model

- **Attacker:** any Hive account.
- **Capability:** broadcast a chain of continuation pointers (forward walker amplifier) OR backward-walker-style probing.
- **Trigger:** sustained degraded HAF (genuine ops degradation OR attacker-induced via separate vector — query plan poisoning, connection pool exhaustion).
- **Impact:** worker-thread starvation. Service-wide latency degradation. Tail-latency 99.9p balloons. Genuine users see request timeouts even when their own paper paths are short.
- **Detection:** existing `event: 'canonical_root_walker_*'` warns + logger.error catch path. New event tag added in round-2 of `backend-canonical-root-walker-author-gate` (`canonical_root_walker_error`) helps correlate. But no metric distinguishes "walker took 50ms" from "walker took 30s on first hop, then 30s on hop 2, then ..." so degradation tail isn't quantified.

## Goal

Add an `AbortController`-bounded wall-clock budget that applies to the entire walker request (not per-hop). On budget exhaustion, walker stops at deepest verified node and emits `event: 'canonical_root_walker_wall_clock_exceeded'` (or `event: 'continuation_chain_wall_clock_exceeded'` for the forward walker). Threads through HAF pool callers so the budget is enforced across ALL cascading queries within the walker request.

## Acceptance

### 1. Wall-clock budget configuration

`backend/src/config.ts`:
```ts
HAF_WALKER_WALL_CLOCK_MS: parseInt(process.env.HAF_WALKER_WALL_CLOCK_MS ?? '3000', 10), // 3s default
```

Document in `.env.example`. Default 3000ms based on: typical HAF response ~50-200ms × 10-15 expected query depth = 500-3000ms. Anything beyond is degraded HAF. Operators can tune.

### 2. AbortController threading

`backend/src/routes/papers.ts` route handlers (`/api/papers/:author/:permlink` and the `?version=N` branch):
```ts
const walkerAbort = new AbortController();
const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
try {
  const headAuthorsMemo = makeHeadAuthorsMemo();
  const canonicalRoot = await findCanonicalRoot(author, permlink, headAuthorsMemo, walkerAbort.signal);
  // ... cascading calls all receive walkerAbort.signal
} finally {
  clearTimeout(walkerBudget);
}
```

`findCanonicalRoot`, `resolveContinuationChain`, `fetchHeadAuthorizedAuthors`, `reconstructVersionsFromHaf` all accept an optional `signal?: AbortSignal` and:
- Check `signal?.aborted` at the top of each loop iteration.
- Pass `signal` to `pool.query` via `AbortController` integration if pg supports it (verify; Node-postgres has `signal:` support since v8). If not, manual abort check between queries.
- On abort: return current as canonical / return chain so far / return null. Emit structured warn with `event: '<walker>_wall_clock_exceeded'` and `(startAuthor, startPermlink, hopIndex, elapsedMs)`.

### 3. Integration with depth cap

When BOTH depth cap and wall-clock fire on the same request, prefer the wall-clock event (operator-actionable degraded-HAF signal) over the depth-cap event (operator-actionable attacker-amplifier signal). Order matters for SOC dashboards.

### 4. Tests

`backend/tests/routes/canonical-root-walker.test.ts` (extend):
- `'aborts walker when wall-clock budget elapses mid-walk'` — install responder that delays each query 1500ms; budget 3000ms; assert walker returns deepest verified node after ~2 hops + emits `canonical_root_walker_wall_clock_exceeded`.
- `'depth cap fires before wall-clock when budget is generous'` — install responder with fast queries (5ms); budget 30000ms; 11-hop chain → assert depth-cap event fires (NOT wall-clock).

`backend/tests/routes/continuation-author-gate.test.ts` (extend):
- Same shape for the forward walker.

### 5. Operator runbook

`.env.example` documents the knob and the operator-side meaning (degraded HAF detection signal vs attacker amplification signal).

## Out of scope

- Replacing the depth caps. Both signals are useful: depth cap = attacker amplifier; wall-clock = degraded HAF or attacker timing manipulation.
- Restructuring HAF query batching. Sequential queries are correct (chain semantics).
- Caching canonical-root in Redis. Separate concern; perf reviewer's residual risk on `backend-canonical-root-walker-author-gate`.
- Per-hop wall-clock budget. Single request-level budget is sufficient and simpler.
- Adding wall-clock to non-walker HAF callers (accreditation, reputation, etc.). Walker-specific because the cascading-helper-call shape is unique to walkers; other callers have a single bounded query.

## Coordination

- **Sequencing:** lands AFTER `backend-canonical-root-walker-author-gate` round-2 archives (which closes the type-spoof + cast hardening). No file-conflict between the two; this task adds new parameters, the round-2 hold modifies existing behavior.
- **Convention reference:** `agents/docs/solutions/conventions/verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md` — the wall-clock value (3000ms default) requires documenting the math derivation alongside the constant.

## Source

`/ce-code-review` round-1 of `backend-canonical-root-walker-author-gate`, reliability reviewer finding 5b (P2 conf 55-60). User triage 2026-05-05 elected option (c): observability event tag (5a) into round-2 hold, wall-clock budget (5b) into this separate task.

## Cross-references

- `agents/docs/tasks/review/backend-canonical-root-walker-author-gate.md` — round-2 hold (parent task closing the gate; this task adds the wall-clock dimension).
- `backend/src/routes/papers.ts:805-852` (current `findCanonicalRoot`), `:850-1000` (current `resolveContinuationChain`), `:780-848` (current `fetchHeadAuthorizedAuthors`).
- `backend/src/db.ts:22` `statement_timeout=30000ms` — the per-query bound this task complements with a per-request bound.

## [BLOCKED by Backend] (updated 2026-05-06, architect) — UNBLOCKED 2026-05-11

The "Sequencing: lands AFTER `backend-canonical-root-walker-author-gate` round-2 archives" constraint at the top of this file is a hard ordering dependency on the parent task's archive. **Architect re-reviewed the parent on 2026-05-06 and held it for round-3** (memo-threading omission at `resolveVersionsFromHaf:1421` plus two polish items); see the round-3 hold block at the bottom of `agents/docs/tasks/review/backend-canonical-root-walker-author-gate.md` (which has been `git mv`'d back to `tasks/pending/`). Backend now holds the next-action; this file stays blocked until round-3 lands and the parent archives.

**Unblocked 2026-05-11 (backend startup triage):** parent `BACKEND-CANONICAL-ROOT-WALKER-AUTHOR-GATE` archived 2026-05-06 round-3 clean (see `tasks-archive.md` heading). Both unblock conditions met (round-3 landed; parent archived). File moved `blocked/ → pending/`. The acceptance additions filed at parent archive (loop-SQL `IS NOT NULL` bundle + A3 depth-cap arithmetic comment) remain in scope.

### Acceptance addition (filed at the same triage, 2026-05-06)

Adversarial reviewer surfaced an asymmetry between the walker's two SQL probes: the initial probe at `papers.ts:1107` includes `c.json_metadata -> $3 -> 'continues' IS NOT NULL`; the loop-continuation probe at `:1183-1184` omits it. Effect: one extra HAF round-trip per legitimate non-cyclic chain that reaches root (the SQL fetches a row whose `cont_author`/`cont_permlink` are NULL via the JSON path, and the JS layer at `:1188` correctly returns the predecessor as canonical). Asymmetric drift surface for future probe refactors.

This task is the natural home because it already touches the loop SQL for `AbortController` threading. Bundle as a "while we're here" acceptance item:

- Add `AND c.json_metadata -> $3 -> 'continues' IS NOT NULL` to the loop-continuation SQL probe at `:1183-1184`.
- **Verify the loop semantics first.** The change shifts the bail condition from "fetched a row with NULL continues → return predecessor" to "fetched 0 rows → return current as canonical". The implementer must confirm the loop tracks `(currentAuthor, currentPermlink)` independently of the SQL result so the 0-row case correctly returns the previous iteration's predecessor (which IS the root). If the loop today derives `currentAuthor` from the SQL result row, restructure first or skip this acceptance item and surface the restructure as a separate concern.
- Canary: extend an existing legitimate-chain canary to assert that walker reaches the root in N hops with N+1 SQL queries (initial + N loop), not N+2. Mutation-kill: revert the new SQL filter → query count rises by 1.

Reviewer attribution: adversarial (`adv-loop-continuation-sql-no-continues-not-null`, conf 80). Single reviewer; deferred from round-3 because this task is the better semantic home.

### Acceptance addition (filed at canonical-walker round-3 archive, 2026-05-06)

Architect followup A3 from the canonical-walker round-2 hold block carries forward to this task because the wall-clock-budget work touches the walker's docblock and hot path: append a depth-cap arithmetic comment to the BACKWARD walker's docblock in `backend/src/routes/papers.ts` spelling out the per-request worst-case before this task's `AbortController` budget closes it. Per `agents/docs/solutions/conventions/verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md`, the security margin's underlying math must be documented alongside the constant.

Comment shape (illustrative; implementer applies near `CANONICAL_ROOT_MAX_HOPS = 10`):

```ts
// CANONICAL_ROOT_MAX_HOPS = 10. Per-request worst-case latency under degraded HAF:
// 10 hops × 2 sequential SQL queries × 30s statement_timeout = 600s (10 min).
// This task adds an AbortController-bounded request budget that caps the wall-clock
// independently of hop count. Until then the depth cap absorbs the per-request exit
// condition but does not bound the wall-clock tail.
```

Mirror the same shape on `MAX_HOPS = 50` (forward walker): 50 × ≥1 query × 30s = up to 1500s (~25 min). Both arithmetic comments land in the same diff that introduces the `signal?: AbortSignal` parameter so future readers see the math and the fix together.

Reviewer attribution: carried forward from `backend-canonical-root-walker-author-gate` round-2 hold A3 → round-3 hold A3 → archive at 2026-05-06. Architect-zone scope of A3 was misclassified at round-2 (the comment lives in `backend/src/`, an architect cannot edit it directly); this task is the natural home.

## Backend re-review signal (2026-05-11, round-1 — commits `1d01a21` + `79078d7` + `741a3e9` on `main`)

All five acceptance subsections + the two acceptance additions filed at round-2 triage 2026-05-06 (loop-SQL `IS NOT NULL` bundle + A3 depth-cap arithmetic docblocks) landed across three focused commits. Worked directly on `main`, no worktree fan-out — single-task execution with all changes on overlapping `papers.ts` lines.

### Commit 1 (`1d01a21`) — scaffolding (config + docblocks, no behavior change)

Subject carries `[skip-zone-audit]` because the config knob (`backend/src/config.ts`) and its `.env.example` template entry must land together — they're a tightly coupled pair, and `.env.example` is outside the backend zone.

- `backend/src/config.ts`: added `hafWalkerWallClockMs: parseInt(process.env.HAF_WALKER_WALL_CLOCK_MS || '3000', 10)` with the 50-200ms × 10-15-query-depth derivation rationale comment and cross-reference to `verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md`.
- `.env.example`: documents `HAF_WALKER_WALL_CLOCK_MS=3000` next to `HAF_DATABASE_URL` with the operator-signal split (depth-exceeded = attacker amplifier; wall-clock-exceeded = degraded-HAF).
- `backend/src/routes/papers.ts` `CANONICAL_ROOT_MAX_HOPS = 10` docblock (A3, carried forward from canonical-walker round-2 hold): adds the `10 hops × 2 SQL × 30s = ~10min` worst-case arithmetic and explains why depth cap + wall-clock both exist (orthogonal defense surfaces).
- Same shape inline comment on `MAX_HOPS = 50` (forward walker, ~25min worst-case) per A3.

### Commit 2 (`79078d7`) — AbortController plumbing + canaries

Threads `signal?: AbortSignal` through five functions in `backend/src/routes/papers.ts`:

- `fetchHeadAuthorizedAuthors(pool, author, permlink, memo?, signal?)` — defense-in-depth abort check at function entry (fail-closed return null).
- `resolveContinuationChain(author, permlink, memo?, signal?)` — pre-loop abort check + iteration-boundary check at `for (let i = 0; ...)` top. On abort emits `event: 'continuation_chain_wall_clock_exceeded'` warn with `(startAuthor, startPermlink, hopIndex, elapsedMs)`.
- `findCanonicalRoot(author, permlink, memo?, signal?)` — pre-initial-probe abort check + iteration-boundary check. On abort emits `event: 'canonical_root_walker_wall_clock_exceeded'`. Captures `startedAt = Date.now()` at function entry so `elapsedMs` is meaningful at the warn site.
- `reconstructVersionsFromHaf(author, permlink, prefetchedChain?, memo?, signal?)` — threads signal to its internal `resolveContinuationChain` call; pre-query abort check before the big version-replay query.
- `fetchPaperDetailFromHaf(author, permlink, memo?, signal?)` — threads signal to internal `resolveContinuationChain` + `reconstructVersionsFromHaf` calls.

Route handler `GET /:author/:permlink` wraps walker calls in `AbortController` + `setTimeout(config.hafWalkerWallClockMs)` with `try/finally clearTimeout`, so the budget covers the full per-request walker-chain (cascading helper calls included). Per task scope, this is the only handler wrapped — `/retract`, `/cite`, `/enrichment` are out of scope per the task spec's explicit "route handlers" list. If reviewer wants those later, file as follow-up.

Per acceptance section 3 ("when BOTH depth cap and wall-clock fire, prefer wall-clock"): the iteration-boundary `if (signal?.aborted)` check fires BEFORE the depth-cap exit condition at `i < MAX_HOPS` / `i < CANONICAL_ROOT_MAX_HOPS`, so wall-clock takes priority structurally. Inline comment documents this at both walker sites.

Canaries in `canonical-root-walker.test.ts` (+2):
- `'wall-clock budget: aborts mid-walk on slow HAF, emits canonical_root_walker_wall_clock_exceeded'` — 80ms-per-query responder + 50ms budget. Asserts wall-clock event fires with `hopIndex >= 0` and `elapsedMs > 0`, depth-cap event does NOT fire.
- `'depth cap fires before wall-clock when budget is generous (orthogonal signal pinning)'` — fast queries + 30s budget + 11-hop chain. Asserts depth-cap event fires, wall-clock does NOT.

Canaries in `continuation-author-gate.test.ts` (+2):
- `'wall-clock budget: aborts forward walker mid-walk, emits continuation_chain_wall_clock_exceeded'` — same shape, with the backward walker suppressed via 0-row initial probe (matched by the `'continues' IS NOT NULL` discriminator). Only the forward walker's chain-walk SQL is delayed, so the test pins the FORWARD walker's iteration-boundary check specifically (elapsedMs > 0 fails red on a mutation that leaves only the pre-loop check).
- `'forward walker does NOT emit wall-clock event on fast HAF (orthogonal signal pinning)'` — negative assertion. Mutation: invert the signal check → wall-clock fires on every request → fails red.

Also added file-level `afterEach(() => vi.restoreAllMocks())` to `continuation-author-gate.test.ts` (was missing). Without it, `vi.spyOn(logger, 'warn')` called twice across `it()` bodies returns the EXISTING spy (vitest contract), so the second test's spy contained leaked calls from the first. Mirrors the equivalent guard in `canonical-root-walker.test.ts`. The fix was confirmed by diagnostic instrumentation: `spy.mock.calls.length === 1` BEFORE the fast-HAF test issued its request, with the call having the exact `hopIndex/elapsedMs` signature of the slow-HAF test's event.

### Commit 3 (`741a3e9`) — IS NOT NULL bundle

Added `AND c.json_metadata -> $3 -> 'continues' IS NOT NULL` to the backward walker's loop-continuation probe in `findCanonicalRoot` (the parent-continues SQL inside the for-loop). Aligns with the initial probe's discipline (SQL is SSoT for "has continues pointer"). The JS-side `!parentRow.cont_author` post-check stays in place as defense in depth.

Loop semantics verified: `(currentAuthor, currentPermlink)` is tracked OUTSIDE the SQL result (advanced at the END of each iteration). 0-row case correctly returns the predecessor accumulated so far. Pre-bundle: 1 row with null cont, bail at `!cont_author`. Post-bundle: 0 rows, bail at `rows.length === 0`. Identical outcome.

Canary in `canonical-root-walker.test.ts` (+1):
- `'loop-continuation probe carries IS NOT NULL filter (mirrors initial probe)'` — 3-hop legitimate chain, asserts every captured loop probe (filtered out initial probe by SELECT-clause discriminator) contains `'continues' IS NOT NULL`. Mutation-kill: remove the predicate → canary fails red.

Test helper `isInitialBackwardProbe` updated: it previously discriminated on the IS NOT NULL predicate (unique to the initial probe pre-bundle), but with the bundle landed both probes carry it. New discriminator: `SELECT\s+c\.author,\s+c\.json_metadata,` SELECT-clause prefix (unique to the initial probe because the JS-side type-spoof re-check needs the START row's own identity columns; the loop probe only needs cont fields).

### Deviation from task spec: N+1 vs N+2 SQL-query perf claim

Task acceptance addition stated: "Canary: extend an existing legitimate-chain canary to assert that walker reaches the root in N hops with N+1 SQL queries (initial + N loop), not N+2. Mutation-kill: revert the new SQL filter → query count rises by 1."

By my trace, this perf claim does NOT hold. For a 1-hop chain (alice/v2 → alice/v1) the query counts are:

- **Pre-bundle:** initial probe (1) + iter 0 auth-check (1) + iter 0 parent-continues (1) = 3 queries. Parent-continues returns 1 row with null cont_author; bail at `!cont_author`.
- **Post-bundle:** initial probe (1) + iter 0 auth-check (1) + iter 0 parent-continues (1) = 3 queries. Parent-continues returns 0 rows (IS NOT NULL rejects); bail at `rows.length === 0`.

Same query count. The parent-continues probe runs regardless — IS NOT NULL only changes the row shape returned, not whether the query is issued. The N+1 vs N+2 framing only holds if you count "rows returned with non-null cont_author" or similar, which isn't a useful operator metric.

The STRUCTURAL benefit (SQL-side SSoT, mirrored discipline across both probes, reduced drift surface for future refactors) stands. The PERF claim doesn't validate. I wrote a structural canary (assert SQL contains the predicate) instead of a query-count canary. Flagging here in case the perf framing was load-bearing for some reason I'm missing — happy to adjust the canary if the architect wants a query-count variant, but I'd need guidance on how to count given the trace above.

### Mutation-kill attestation (3 mutations × 3 canaries)

Each mutation applied in-place to `backend/src/routes/papers.ts`, targeted vitest invocations run, mutation reverted, md5sum-verified clean restore between rounds. Final `diff /tmp/papers.ts.attest-base backend/src/routes/papers.ts` is empty.

| Mutation | Backward wall-clock canary | Forward wall-clock canary | IS NOT NULL canary |
|----------|---------------------------|---------------------------|---------------------|
| HEAD (no mutation) | PASS | PASS | PASS |
| A: remove iter-boundary `if (signal?.aborted)` in `findCanonicalRoot` | **FAIL RED** (`expected 0 to be greater than 0` on `wallClockEvents.length`) | PASS | PASS |
| B: remove iter-boundary `if (signal?.aborted)` in `resolveContinuationChain` | PASS | **FAIL RED** (same assertion) | PASS |
| C: remove `'continues' IS NOT NULL` clause from loop probe | PASS | PASS | **FAIL RED** (`probe.sql does not match /'continues' IS NOT NULL/i`) |

Each canary fails red on exactly one mutation and stays green on the orthogonal two. Pre-loop signal checks (which fire when ANOTHER walker burns the budget before this one enters) remain in place as defense in depth and are exercised by the test bodies as a side effect — no separate canary for them, since the iteration-boundary canaries are strictly stronger (they pin the in-loop check, which subsumes the pre-loop check's "what if budget already exceeded?" case).

### Verification

- `npx tsc --noEmit` from `backend/`: clean.
- `npm run lint` from `backend/`: only the two pre-existing `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts` (unrelated).
- `npx vitest run tests/routes/canonical-root-walker.test.ts tests/routes/continuation-author-gate.test.ts`: 68 tests pass on HEAD (was 67 pre-bundle; +1 from the IS NOT NULL canary; +3 in commit 2 and +1 in commit 3 versus the pre-task baseline of 64).
- Broader sweep `npx vitest run tests/routes/canonical-root-walker.test.ts tests/routes/continuation-author-gate.test.ts tests/routes/papers.test.ts tests/routes/paper-detail-v3.test.ts`: 81 pass, 1 skip (Redis-availability `skipIf`). 40s runtime — papers.test.ts and paper-detail-v3.test.ts hit real HAF, which validates the signal-threading doesn't regress the live integration paths.
- `npx vitest run tests/routes/bridge-paper-author-gate.test.ts`: 14 pass. Adjacent surface that touches walker code paths via `extractAuthorizedContinuationAuthors`.

### Notes for architect

- Scope per task spec: only `GET /:author/:permlink` is AbortController-wrapped. `/retract`, `/cite`, `/enrichment` are NOT wrapped (explicit task-scope choice). If reviewer wants budget on those routes too, follow-up.
- The IS NOT NULL bundle's perf claim deviation (see above) is the one open question I'd flag for round-2 hold or dismiss.
- The `isInitialBackwardProbe` test-helper discriminator change is a side effect of the bundle landing. If round-2 hold prefers a different discriminator (e.g., dedicated `mockMode` config flag), happy to refactor.

## Architect re-review (2026-05-16, round-1) — HELD PENDING FIXES

`/ce-code-review` ran on the 3 round-1 commits (`1d01a21` config + docblocks + `[skip-zone-audit]`; `79078d7` AbortController plumbing + canaries; `741a3e9` IS-NOT-NULL bundle) with 10 reviewers (correctness, security, adversarial at opus; testing, maintainability, project-standards, learnings, reliability, kieran-typescript, performance at sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). AbortController threading through the 5 walker functions, iteration-boundary signal check, wall-clock-vs-depth-cap priority (per acceptance section 3), and the IS NOT NULL bundle's loop semantics all land structurally correctly. The implementer's flagged deviation (N+1 vs N+2 query count claim doesn't hold) is correct — task spec was wrong; the structural canary is the right shape.

8 items hold for round-2, four cross-reviewer-corroborated. Round-1 surfaced **one P1 security defect** (item 1) and a **P1 DoS escape hatch on sibling routes** (item 2) — both block archive.

### Items to address (bundle into one round-2 commit)

**1. (P1, anchor 100, cross-reviewer correctness + adversarial — SECURITY DEFECT)** — Backward walker iter-0 wall-clock abort at `papers.ts:1644` returns `{ author: currentAuthor, permlink: currentPermlink }` where those values are sourced from `startRow.cont_author` / `startRow.cont_permlink` (the attacker-controlled `pevo.continues` pointer). The author-consent gate at `papers.ts:1651` (the `fetchHeadAuthorizedAuthors` call) has NOT yet run at iter-0.

   Concrete phishing repro: attacker posts `attacker/spoof-paper` with `pevo.continues={alice, real-paper}`. Under degraded HAF where the initial probe takes ~3000ms, the wall-clock budget fires AFTER the initial probe returns but BEFORE the iter-0 `fetchHeadAuthorizedAuthors(alice, real-paper)` call. The walker returns `{alice, real-paper}` as canonical. The route handler at `papers.ts:~2103-2106` sets `author='alice', permlink='real-paper'` and the response surfaces alice's content under `/api/papers/attacker/spoof-paper` — exactly the phishing vector the canonical-root author-consent gate exists to prevent.

   Compare to the `unauthorized_hop` rejection at `papers.ts:1670` which returns `{ author: childAuthor, permlink: childPermlink }` (the VERIFIED child). The mid-walk abort's choice of `(currentAuthor, currentPermlink)` instead of `(childAuthor, childPermlink)` is the defect: abort fail-OPENS to attacker coords, while `unauthorized_hop` correctly fail-CLOSES to the verified child.

   Fix: change `papers.ts:1644` from `return { author: currentAuthor, permlink: currentPermlink };` to `return { author: childAuthor, permlink: childPermlink };`. At iter-0 `childAuthor === author` and `childPermlink === permlink` (set at `papers.ts:1605-1606` from the route handler's own params), so the URL safely shows the attacker's own content. The author-consent gate's invariant ("canonical resolution must not surface unverified content") is preserved across the abort path.

   Add a layer-pinning canary: spoof-START variant of the slow-HAF canary (`backend/tests/routes/canonical-root-walker.test.ts`, mirror the existing wall-clock canary's responder shape but use a START with `pevo.continues` pointing at an unrelated author's real paper). Assert the abort path returns `{author: STARTAuthor, permlink: STARTPermlink}` (the child/START coords), not the attacker's `pevo.continues` target. Mutation-kill: revert to the buggy `(currentAuthor, currentPermlink)` form → canary fails RED (alice's content surfaces under attacker URL).

**2. (P1, anchor 80, adversarial — DoS escape hatch)** — Sibling routes `/cite`, `/retract`, and `/enrichment` call walker code paths (`fetchPaperDetailFromHaf` and `resolveVersionsFromHaf`) without an AbortController. Pre-this-commit's DoS amplifier (worker-thread starvation on attacker-posted long chains under degraded HAF) is closed on `GET /:author/:permlink` but still exposed via the three sibling URLs. With pool max=3, three concurrent unauth `/cite?format=bibtex` requests against a 50-deep chain saturate the connection pool for tens of minutes under degraded HAF. The implementer flagged this as out-of-scope per the task spec, but the threat model is identical to the primary route — same walker amplifier, same connection-pool saturation, same worker-thread starvation.

   Fix: extend the same `AbortController` + `setTimeout(config.hafWalkerWallClockMs)` + `try/finally clearTimeout` pattern to the three sibling route handlers. Thread the signal into `fetchPaperDetailFromHaf` and into `resolveVersionsFromHaf` (which currently does NOT accept `signal?: AbortSignal` — bundle the wrapper signature change here per kieran-typescript KT-1).

   `resolveVersionsFromHaf` at `papers.ts:~1964` is the thin wrapper around `reconstructVersionsFromHaf` and currently calls `reconstructVersionsFromHaf(author, permlink, undefined, memo)` with no signal. Add `signal?: AbortSignal` as the trailing parameter and thread it through. The `/enrichment` route then passes its AbortController signal through.

   Add canaries that pin the abort firing on each of the 3 sibling routes (mirror the existing wall-clock canary shape; one per route).

**3. (P2, anchor 100, 4-reviewer corroboration: security + adversarial + reliability + performance)** — Documentation fix: pg v8.20.0 does NOT support `AbortSignal` in `pool.query`. Verified empirically against `backend/node_modules/pg/lib/` — zero hits for `signal`/`abort`/`AbortSignal`. The task acceptance note at parent-task line ~58 says "Node-postgres has signal: support since v8" — that claim is wrong; pg v8.x never shipped it.

   The implementer correctly fell back to "manual abort check between queries" per the task spec (no silent no-op from passing signal to `pool.query`). But the docblock at `routes/papers.ts:~2084-2097`, the config knob comment at `config.ts:~82-93`, and the `.env.example` operator-facing documentation all frame the budget as wall-clock-tight. Real worst-case per request = `config.hafWalkerWallClockMs` (default 3000ms) + last-in-flight `statement_timeout` (30000ms) = ~33s, not 3000ms.

   This is still an 18-45× improvement over the pre-fix worst case (10 min / 25 min), so the threat-model's DoS-amplifier closure is meaningfully achieved. But operators tuning the knob downward to "tighten the budget" face a 31s real worst case that undermines the tuning intuition.

   Fix: update `config.ts` comment, `.env.example` documentation, and the route handler's AbortController docblock to state explicitly: "Signal stops new queries from starting; in-flight `pool.query` continues until PostgreSQL's `statement_timeout` (30s) resolves it. Real worst-case per request = `hafWalkerWallClockMs` + `statement_timeout`. Acceptable per task threat model — still 18-45× improvement over pre-fix tail — but operators tuning the budget should know the bound is the SUM, not the configured value alone." ~10-15 LOC of comment edits across the 3 files (papers.ts walker docblock + config.ts knob declaration + .env.example operator note).

**4. (P2, anchor 90, reliability)** — Route handler returns `404 NOT_FOUND` when walker aborts (route maps null/empty walker result to NOT_FOUND), indistinguishable from "paper not found" in HTTP-status-only monitoring. Worse case: a forward walker abort mid-canonical-root resolution assembles a structurally valid but semantically WRONG detail object (wrong `canonical_author`/`canonical_permlink`, missing version entries) and returns 200 OK — user sees stale/incorrect content with no operator signal at the HTTP layer.

   Fix: detect abort condition at response time (e.g., check `walkerAbort.signal.aborted` after the walker returns, or have walker functions return a discriminated `{kind: 'aborted'}` / `{kind: 'result', ...}` shape) and emit `503 SERVICE_UNAVAILABLE` with a retryable hint. HTTP 5xx monitors then catch degraded HAF independently of the warn log. Bundles with item 7 below — both require detecting the abort path at response time. ~15-20 LOC across the 4 route handlers (the primary route + 3 siblings from item 2).

**5. (P2, anchor 75, kieran-typescript)** — `config.ts` `parseInt(process.env.HAF_WALKER_WALL_CLOCK_MS || '3000', 10)` doesn't guard against `NaN`. If the env IS set to a non-numeric string (e.g., `HAF_WALKER_WALL_CLOCK_MS=disabled` or `HAF_WALKER_WALL_CLOCK_MS=3000ms`), the `||` fallback does NOT fire (the env string is truthy), `parseInt` returns `NaN`, and `setTimeout(fn, NaN)` is coerced to `setTimeout(fn, 0)` per ECMAScript spec — fires immediately on the next tick. Effect: every paper-detail request emits a wall-clock-exceeded event and returns degraded data (or, post-item-1 fix, returns START coords on every request).

   Fix: change to `Math.max(1, parseInt(process.env.HAF_WALKER_WALL_CLOCK_MS, 10) || 3000)`. The `||` fallback follows `parseInt` so NaN triggers it; `Math.max(1, ...)` floors at 1ms to prevent `0` setTimeout (which would fire immediately on the next tick even with a real numeric env value of `0`). ~1 LOC change.

**6. (P3, anchor 85, reliability)** — Wall-clock event payloads omit `budgetMs`. Without it, operators can't distinguish "HAF was actually slow" (`elapsedMs ≈ budgetMs`) from "budget was misconfigured too low" (`elapsedMs << budgetMs is impossible, but the question of whether elapsedMs is at the configured ceiling vs much beyond requires knowing the configured value`). Adding `budgetMs: config.hafWalkerWallClockMs` to the 4 wall-clock event payloads gives operators a ratio signal at negligible cost.

   Fix: add the field to the 4 `logger.warn(...)` calls emitting `canonical_root_walker_wall_clock_exceeded` (papers.ts pre-loop + iteration-boundary on backward walker) and `continuation_chain_wall_clock_exceeded` (papers.ts pre-loop + iteration-boundary on forward walker). ~4 LOC.

**7. (P3, anchor 80, reliability — bundles with item 4)** — Walker-aborted partial-detail response must bypass the `hafCache` 30-minute TTL. `hafCache.getOrSet` at `cache.ts:73` correctly skips caching when the inner function returns `null`, but `fetchPaperDetailFromHaf` can return a NON-null detail object built from an abort-truncated partial chain (wrong `canonical_*`, missing version entries from `reconstructVersionsFromHaf` partial output). That non-null partial-detail gets cached with the 30-minute TTL. Once HAF recovers, the next 30 minutes of requests for that paper return the stale partial result. Self-healing after TTL expiry, but the window exists.

   Fix: detect abort in `fetchPaperDetailFromHaf` return path. Either return `null` so `hafCache.getOrSet` skips caching, OR return a discriminated `{cached: false, detail: ...}` shape so the route handler skips the cache write. Bundles with item 4's abort detection — both share the "what does the route handler do at abort time" question. ~10-15 LOC.

**8. (P3, anchor 100, cross-reviewer adversarial + maintainability)** — Add a BRITTLENESS WARNING comment block above the new `isInitialBackwardProbe` SELECT-clause discriminator regex at `backend/tests/routes/canonical-root-walker.test.ts:~127`.

   The new discriminator `/SELECT\s+c\.author,\s+c\.json_metadata,/` matches a column-list prefix. Adding any 3rd column to either probe (e.g., `c.created` for caching, or adding a column to `fetchHeadAuthorizedAuthors`'s SELECT) silently collapses the discriminator → mock returns wrong fixture → canary passes for the wrong reason. Same brittleness class as the canary-task's `/'type'/.test(sql)` discriminator — which DOES carry an explicit BRITTLENESS WARNING block at its site. The discriminator that this commit RETIRED (`IS NOT NULL` predicate, no longer unique post-bundle) ALSO had a brittleness note. The new SELECT-clause discriminator has none.

   Fix: mirror the canary-task's BRITTLENESS WARNING pattern (~6-8 line comment block above the new regex). State: "Detection key `/SELECT\\s+c\\.author,\\s+c\\.json_metadata,/` assumes the initial probe's SELECT clause begins with these two columns in this order. A future SQL refactor that reorders columns, inserts a column between them, or adds whitespace would break the discriminator → mock returns wrong fixture → canary passes for the wrong reason (false GREEN). If this canary or the layer-pinning canaries that depend on the dispatch start failing red after such a refactor, the security property is NOT regressed — the discriminator needs updating, not the gate." No code semantics change.

### Cross-reference to sibling task

Item 1 (this task) and the sibling task `backend-canonical-walker-cycle-detection` round-1 hold item 1 (filed today, 2026-05-16) together standardize backward-walker event field naming. The cycle task's hold-block flips the 3 backward-walker events (cycle_detected, unauthorized_hop, depth_exceeded) from `hopNumber: i + 1` to `hopIndex: i` for symmetry with the wall-clock events in THIS task (which already use `hopIndex`). No work in this task's diff; the cross-task convergence happens when the cycle task's round-2 lands.

### Items dismissed during architect triage

- **(P3, conf 60, security sec-promise-all-cascading-queries-no-signal)** Promise.all cascading queries (paperResult/retraction/accreditation/reputation) at `papers.ts:~747-767` don't receive signal. Each is bounded by its own 30s `statement_timeout`; not amplifiers (single-query depth-1, attacker can't inflate). Below-gate.
- **(P3, conf 95, reliability REL-04) `.env.example` documents `continuation_chain_depth_exceeded` event that doesn't exist in code.** Dismissed at user triage 2026-05-16 — forward walker depth-cap is a rare event (50-hop chain is itself extraordinary); silent exit is acceptable. The `.env.example` reference remains as forward-looking documentation.
- **(P3, conf 70, testing T1) Forward wall-clock canary comment misdescribes the kill discriminator.** Comment-only nit; the kill is real. Dismissed per project memory `feedback_dismiss_preemptive_test_hardening`.
- **(P3, conf 70, maintainability M3) Inline comment above MAX_HOPS=50 restates content from the CANONICAL_ROOT_MAX_HOPS JSDoc.** Marginal comment bloat; not a structural error. Dismissed.
- **(P4, conf 75, reliability REL-06) Wall-clock event spam unbounded by per-event throttle.** Bounded by `readLimiter` (120/min/IP); per project memory `feedback_pevo_logging_minimal`, adding throttle infrastructure defaults dismiss.
- **(P3, conf 50, kieran-typescript KT-4)** Same as cycle-task: cycle event string literals untyped (no `WalkerEvent` union). YAGNI at this site count.
- **(P3, conf 50, kieran-typescript KT-5)** `(config as { hafWalkerWallClockMs: number })` test cast is the correct pattern for non-frozen config mutation; informational only.

### Re-review signal

When items 1-8 land in a single round-2 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only. Item 1 is the highest-risk change semantically (the security fix on the abort fail-closed return); items 2-3-5 are mechanical-ish; items 4+7 are bundled (abort detection at route handler); items 6+8 are localized.
