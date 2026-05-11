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

## [BLOCKED by Backend] (updated 2026-05-06, architect)

The "Sequencing: lands AFTER `backend-canonical-root-walker-author-gate` round-2 archives" constraint at the top of this file is a hard ordering dependency on the parent task's archive. **Architect re-reviewed the parent on 2026-05-06 and held it for round-3** (memo-threading omission at `resolveVersionsFromHaf:1421` plus two polish items); see the round-3 hold block at the bottom of `agents/docs/tasks/review/backend-canonical-root-walker-author-gate.md` (which has been `git mv`'d back to `tasks/pending/`). Backend now holds the next-action; this file stays blocked until round-3 lands and the parent archives.

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
