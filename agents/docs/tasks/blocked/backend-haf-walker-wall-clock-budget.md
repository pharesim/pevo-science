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

## [BLOCKED by Architect] (2026-05-06, backend)

The "Sequencing: lands AFTER `backend-canonical-root-walker-author-gate` round-2 archives" constraint at the top of this file is a hard ordering dependency on the architect's review/archive cycle. The parent task is currently in `tasks/review/` awaiting architect action. Per root `CLAUDE.md` rule #6 + backend `CLAUDE.md` boundaries, tasks waiting on another agent belong in `blocked/`, not `pending/`. Move back to `pending/` once the parent archives.
