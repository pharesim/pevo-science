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

## Backend re-review signal (2026-05-16, round-2 — working tree of this commit)

All 8 hold items land in a single round-2 commit alongside this signal block + the `git mv` to `tasks/review/`.

### Item 1 (P1 SECURITY) — backward walker iter-0 wall-clock abort fail-CLOSES to URL coords

`backend/src/routes/papers.ts` `findCanonicalRoot`, iter-0 wall-clock abort site: changed `return { author: currentAuthor, permlink: currentPermlink }` to `return { author: childAuthor, permlink: childPermlink }`. At iter-0 `childAuthor/childPermlink === route params (author, permlink)` (set at `papers.ts:~1604-1605` from the route handler's own params), so the URL safely surfaces the attacker's own content rather than the attacker-controlled `pevo.continues` target. Mirrors the `unauthorized_hop` rejection's fail-CLOSED shape at `papers.ts:~1670`. Added an explanatory comment block at the return site referencing the security invariant.

Layer-pinning canary in `backend/tests/routes/canonical-root-walker.test.ts` (+1, `'wall-clock abort fail-CLOSES to URL coords, not attacker-controlled pevo.continues target (P1 security)'`):

- Spoof-START setup: `attacker/spoof-paper` with `pevo.continues = {alice, real-paper}` pointing at alice's real content. 80ms-per-query responder + 50ms budget.
- Observes via SQL probe capture: after the walker's abort, the route handler immediately rewrites `(author, permlink)` from `canonicalRoot` and passes them to `fetchPaperDetailFromHaf`, which issues a `SELECT c.author, c.permlink, c.title, …` query. The captured params on that probe are the walker's return value lifted to the SQL layer.
- Assertion: NONE of the detail-SELECT probes carry `params[0] === 'alice' && params[1] === 'real-paper'`. Pre-fix the SQL would land as `['alice', 'real-paper', …]`; post-fix the walker returns `['attacker', 'spoof-paper']` so any subsequent detail fetch stays on the attacker's own coords (or never runs because `fetchPaperDetailFromHaf` short-circuits on the aborted signal at its end and returns null).
- Mutation-kill (verified): revert `papers.ts:~1654` from `childAuthor/childPermlink` back to `currentAuthor/currentPermlink` → captured paper-detail SQL params switch to `['alice', 'real-paper', …]` → canary fails RED on the predecessor-coord assertions.

### Item 2 (P1 DoS) — `/cite`, `/retract`, `/enrichment` wrapped in AbortController

Three sibling routes that pre-fix reached the forward walker (`resolveContinuationChain` via `fetchPaperDetailFromHaf` / `fetchEnrichmentFromHaf` / `resolveVersionsFromHaf`) without per-request wall-clock budgets, leaving the DoS amplifier open on the three sibling URLs. Wrapped each in the same `AbortController` + `setTimeout(config.hafWalkerWallClockMs)` + `try/finally clearTimeout` shape as the primary `GET /:author/:permlink` handler.

Signature change per kieran-typescript KT-1: `resolveVersionsFromHaf(author, permlink, memo?, signal?)` now accepts `signal?: AbortSignal` and threads it into `reconstructVersionsFromHaf`. `fetchEnrichmentFromHaf(author, permlink, signal?)` accepts and threads `signal` into `resolveVersionsFromHaf` (the only walker-amplifier helper inside its `Promise.all`).

Three abort canaries (one per route, per architect spec):

- `tests/routes/continuation-author-gate.test.ts` (+2): `'/cite wraps walker in AbortController + surfaces 503 on wall-clock abort'` and `'/enrichment wraps walker in AbortController + surfaces 503 on wall-clock abort'`. Both use a shared `installSlowForwardResponder()` helper that backs the forward walker with 80ms responses. 50ms budget → forward walker's first chain-walk query consumes the budget → iteration-boundary `signal?.aborted` check fires → fetchPaperDetailFromHaf / fetchEnrichmentFromHaf return null at end (item 7) → route handler observes `walkerAbort.signal.aborted` → 503.
- `tests/routes/retract.test.ts` (+1): `'/retract wraps walker in AbortController + surfaces 503 on wall-clock abort'`. Uses a fresh `(ABORT_USER, ABORT_PAPER)` pair to avoid the `paper-retract` rate limiter (max 5/hour byAccount at `papers.ts:353`) that prior tests in the file would exhaust on `PAPER_AUTHOR='alice'`. Assertion includes `expect(broadcastJsonMock).not.toHaveBeenCalled()` — the abort path returns BEFORE the authorization check and broadcast.

### Item 3 (P2 doc fix) — real worst-case = budget + statement_timeout

pg v8.20.0 does NOT support `AbortSignal` in `pool.query` (verified empirically against `node_modules/pg/lib/` — zero hits for `signal`/`abort`/`AbortSignal`). The signal stops NEW queries from starting; in-flight queries continue until PostgreSQL's `statement_timeout` (30s) resolves them. Real worst-case per request = `hafWalkerWallClockMs + statement_timeout`, not the configured budget alone. Still 18-45× improvement over the pre-fix 10/25-min tail.

Updated 3 documentation surfaces:

- `backend/src/config.ts` `hafWalkerWallClockMs` knob docblock: added the "Real worst-case = budget + statement_timeout" explanation block referencing the pg v8.x AbortSignal-unsupported reality.
- `.env.example` `HAF_WALKER_WALL_CLOCK_MS` operator-facing block: same explanation, framed for ops tuning intuition ("tuning DOWN tightens the new-query gate but the in-flight last-query still has the 30s ceiling; the bound is the SUM").
- `backend/src/routes/papers.ts` primary handler AbortController docblock (~line 2092): "Real worst-case per request = `hafWalkerWallClockMs` + `statement_timeout`" block referencing the config docblock.

### Item 4 (P2 reliability) — 503 SERVICE_UNAVAILABLE on walker abort

Pre-fix the route handler returned `404 NOT_FOUND` (or `200 OK` with stale cached data) on walker abort, indistinguishable from "paper not found" or "cache hit" in HTTP-status-only monitoring. Worse: a forward walker abort mid-canonical-root resolution could assemble a structurally valid but semantically WRONG detail object and return 200 OK with stale `canonical_author/canonical_permlink` and missing `versions[]` entries.

Added `if (walkerAbort.signal.aborted)` checks after each cache lookup in the 4 affected route handlers:

- Primary `GET /:author/:permlink` — both the `?version=N` branch (`papers.ts:~2160`) and the unversioned branch (`papers.ts:~2196`) check `walkerAbort.signal.aborted` after `hafCache.getOrSet` returns. On abort: `return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry')`.
- `/retract`, `/cite`, `/enrichment` — same pattern, scoped to the AbortController + try/finally added per item 2.

Bundles with item 7's `fetchPaperDetailFromHaf` / `fetchEnrichmentFromHaf` null-return — together they ensure abort surfaces as a distinct HTTP signal AND the cache stays cold so the next request gets fresh data when HAF recovers.

### Item 5 (P2 kieran-typescript) — NaN guard on env parse

`backend/src/config.ts`: changed
```ts
hafWalkerWallClockMs: parseInt(process.env.HAF_WALKER_WALL_CLOCK_MS || '3000', 10),
```
to
```ts
hafWalkerWallClockMs: Math.max(1, parseInt(process.env.HAF_WALKER_WALL_CLOCK_MS || '', 10) || 3000),
```

Pre-fix: a non-numeric env (`disabled`, `3000ms`) is truthy → `||` fallback DOESN'T fire → `parseInt('disabled', 10) = NaN` → `setTimeout(fn, NaN)` coerces to `setTimeout(fn, 0)` per ECMAScript spec → fires on the next tick → every paper-detail request emits wall-clock-exceeded and returns 503.

Post-fix: `parseInt(env || '', 10)` produces NaN on bad input → `NaN || 3000` falls through to 3000 → `Math.max(1, …)` floors at 1ms to also prevent literal `HAF_WALKER_WALL_CLOCK_MS=0` from producing immediate-fire. Added an explanatory comment block at the knob declaration walking through the `||`-ordering subtlety.

### Item 6 (P3 reliability) — budgetMs in wall-clock event payloads

Added `budgetMs: config.hafWalkerWallClockMs` to 4 `logger.warn(…)` calls:

- `findCanonicalRoot` pre-initial-probe abort (`papers.ts:~1486`).
- `findCanonicalRoot` iteration-boundary abort (`papers.ts:~1640`).
- `resolveContinuationChain` pre-loop abort (`papers.ts:~1199`).
- `resolveContinuationChain` iteration-boundary abort (`papers.ts:~1259`).

Operators can now compute the `elapsedMs / budgetMs` ratio to distinguish "HAF was actually slow" (`elapsedMs ≈ budgetMs`) from "budget was misconfigured too low" (`elapsedMs << budgetMs`).

### Item 7 (P3 reliability) — cache bypass on abort (bundled with item 4)

Added `if (signal?.aborted) return null` at the end of two fetchers, both BEFORE their `return` statement:

- `fetchPaperDetailFromHaf` (`papers.ts:~993`): after the optional citation-count Promise.all branch returns. Comment block explains the cache-poisoning defense: a partial chain from an aborted walker produces wrong `head_author`/`head_permlink`/`versions[]`; returning the detail would let `hafCache` cache the bad shape for 30 min.
- `fetchEnrichmentFromHaf` (`papers.ts:~2452`): after the `authorship_claims` mapping. Same shape — partial versions from aborted `resolveVersionsFromHaf` cause misreported `review.outdated` booleans against a truncated version chain.

`hafCache.getOrSet` already skips caching when the inner function returns `null` (`cache.ts:73`), so returning null IS the cache-bypass mechanism. Route handler then surfaces 503 via item 4's `signal.aborted` check.

### Item 8 (P3 brittleness warning) — comment block above `isInitialBackwardProbe` regex

`backend/tests/routes/canonical-root-walker.test.ts` `isInitialBackwardProbe` (~line 127): added a `BRITTLENESS WARNING` block mirroring the canary-task convention. Spells out the regex matches a column-list prefix (`SELECT c.author, c.json_metadata,` with trailing comma), and any future SQL refactor that reorders, inserts a 3rd column, drops the trailing comma, or normalizes whitespace differently silently breaks the discriminator → false-GREEN canaries. Notes that failing red after such a refactor does NOT indicate a regressed security property — the discriminator needs updating. Closes the brittleness asymmetry with the `'type'`-discriminator's WARNING block elsewhere in the file.

### Test changes summary

Test files touched:

- `backend/tests/routes/canonical-root-walker.test.ts` (+1 canary, +1 brittleness comment block, +1 status assertion update on the existing slow-HAF wall-clock canary 200→503).
- `backend/tests/routes/continuation-author-gate.test.ts` (+2 canaries via `installSlowForwardResponder` helper, +1 status assertion update on existing forward-walker wall-clock canary 200→503).
- `backend/tests/routes/retract.test.ts` (+1 canary in a new describe block).
- `backend/tests/routes/papers.test.ts` (+1 beforeAll/afterAll pair bumping `hafWalkerWallClockMs` to 60_000ms for the file). Necessary because the integration-shape tests hit real testnet HAF whose round-trip latency reliably exceeds the production-default 3000ms budget; with item 4's 503-on-abort change, the budget tripping silently is no longer acceptable. The pre-fix wall-clock-tripped tests returned 200 with possibly-stale cached data; post-fix they return 503 unless the budget is generous enough to absorb the testnet's HAF tail.

### Verification

- `npx tsc --noEmit` from `backend/`: clean (no output).
- `npm run lint` from `backend/`: only the two pre-existing `seed-phrase.ts` `@typescript-eslint/no-explicit-any` warnings (unrelated).
- `npx vitest run` on the 7 most-affected test files (`canonical-root-walker`, `continuation-author-gate`, `retract`, `papers`, `paper-detail-v3`, `cite`, `papers-enrichment-parity-gate`) with Redis + Postgres reachable via Docker IPs per CLAUDE.md "Running Tests": **99/100 pass, 1 skipped, 1 unrelated pre-existing real-HAF flake** on `papers.test.ts > 'every returned paper is accredited-authored or bridge-account-authored'` (the test depends on which papers are in the top 100 returned by the live testnet HAF; `jesusalejos/...` appears unaccredited in real HAF state and flickers in/out of the result set; verified to pass on the baseline pre-my-changes via `git stash` round-trip).

### Notes for architect

- The `/retract` canary uses a fresh `(ABORT_USER, ABORT_PAPER)` pair rather than the file's standard `PAPER_AUTHOR/PAPER_PERMLINK` to dodge the `paper-retract` rate limiter (max 5/hour byAccount). The mocked `hafQueryMock` doesn't filter by params, so any author/permlink works to seed the response shape.
- `papers.test.ts`'s `beforeAll` budget override (60_000ms) is the right shape for this test file because it exercises real testnet HAF whose tail is slower than the production-default 3000ms. Other tests in the suite either use mocked pools (no real HAF) or set their own per-test budget (the wall-clock canaries themselves). No global default change was made — the architect's task spec sets 3000ms intentionally and operators tune via env.
- The pg v8.x AbortSignal-unsupported finding (item 3) is a documentation fix only; the implementation correctly falls back to "manual abort check between queries" per the original task spec. No production code change at the helper layer beyond the docblock updates.
- All 4 wall-clock event payloads now carry `budgetMs`. None of the existing canaries assert exhaustive event-payload shape (just specific fields), so no test breakage from the additive field.

---

## Architect re-review (2026-05-17, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on round-2 main-tree SHA `2494725` with 11 reviewer personas (correctness, security, adversarial on Opus; testing, maintainability, project-standards, learnings-researcher, reliability, kieran-typescript, api-contract, performance on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). The P1 SECURITY iter-0 fail-CLOSE (item 1), the P1 DoS escape hatch on `/cite`/`/retract`/`/enrichment` (item 2), the pg v8 AbortSignal docblock corrections (item 3), the 503 envelope on walker abort (item 4), the NaN guard (item 5), the `budgetMs` payload field (item 6), the cache-bypass on abort (item 7), and the brittleness comment (item 8) all land structurally correctly and against intent. Cross-reviewer corroboration: api-contract AC-1 + reliability R1 jointly flag the same 503-envelope defect (anchor 100 after promotion). Three items hold for round-3; one UI follow-up is filed in chat for the parallel UI architect rather than bundled here.

### Items to address (bundle into one round-3 commit)

**1. (P1, anchor 100, cross-reviewer: api-contract AC-1 + reliability R1) New 503 paths omit `details.retriable: true` — diverges from the established SERVICE_UNAVAILABLE retriable contract.** `backend/src/routes/papers.ts` at the 5 new abort-503 emit sites (the versioned and unversioned branches of `GET /:author/:permlink`, plus `/cite`, `/retract`, `/enrichment`). All 5 call `sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry')` with no `details` argument. The established contract (already shipped: `bridge.ts:443`, `accreditation.ts:716`) passes `{ retriable: true }` as the fifth `sendError` argument; `agents/docs/api-contracts/common.md` documents the convention explicitly: "Some non-argon2 503 paths emit `details.retriable: true` on the same envelope to signal that the failure had no chain-side or token-side state effect and the client may safely retry." The walker-budget 503 is precisely that case (no chain mutation, pure HAF-degradation). A client branching on `err.details?.retriable` per the documented convention will treat this 503 as non-retriable, contradicting the message text "please retry".

   Fix: add `{ retriable: true }` as the fifth argument to all 5 `sendError(res, 503, 'SERVICE_UNAVAILABLE', ...)` calls. Mechanical edit; no other code change required.

**2. (P2, anchor 75, testing T-04, conf 92) `hafWalkerWallClockMs` NaN guard has zero unit-test coverage.** `backend/src/config.ts:114` now reads `Math.max(1, parseInt(process.env.HAF_WALKER_WALL_CLOCK_MS || '', 10) || 3000)`. The integration tests override `config.hafWalkerWallClockMs` directly (via the established `(config as { hafWalkerWallClockMs: number })` mutation pattern), bypassing the parse formula entirely. The defense the formula provides — that `HAF_WALKER_WALL_CLOCK_MS=disabled` / `=3000ms` / unset / `=0` doesn't produce `setTimeout(fn, NaN)` collapsing to `setTimeout(fn, 0)` and 503-on-every-request — has no test pinning it. A regression restoring the pre-fix form is structurally silent. This is NOT preemptive hardening: the invariant landed THIS round, and the integration tests provably cannot exercise it.

   Fix: backend adds a small unit-test file (or extends a sibling, e.g., `tests/lib/config-knobs.test.ts` if one exists; otherwise a new `tests/lib/haf-walker-budget-env-parse.test.ts`) that imports the parsing formula (factored to a tiny helper if needed) or asserts the resolved `config.hafWalkerWallClockMs` after setting `process.env.HAF_WALKER_WALL_CLOCK_MS` to each edge value (unset, empty, `'disabled'`, `'0'`, `'-1'`, `'5000'`, `'3000ms'`). Coverage matrix: ~5-7 cases × ~3 LOC each. If factoring requires touching `config.ts` to export a `parseHafWalkerBudget(env: string | undefined): number` helper, that is the architect-permitted refactor for this round.

**3. (P3, anchor 75, adversarial adv-1, conf 75) Additional NaN-guard edge cases not caught by `parseInt`, plus an inverted comment about the `=0` case.** Two related observations on `config.ts:106-116`:

   (a) `parseInt('1e3', 10) = 1` (stops at `'e'`); `parseInt('1.5', 10) = 1`; `parseInt('-1', 10) = -1` followed by `Math.max(1, -1) = 1`. An operator typing `HAF_WALKER_WALL_CLOCK_MS=1e3` intending 1000ms gets a 1ms budget instead, and every request 503s. The `||` fallback doesn't catch parseInt-truncation because `1 || 3000 = 1` (1 is truthy). Fix shape options: (i) replace `parseInt` with `Number(...)` + `Number.isFinite` check, falling back to 3000 on non-finite; (ii) add a stricter regex pre-validation (`/^\d+$/`) before `parseInt` and fall back to 3000 on mismatch; (iii) widen the floor to a sensible minimum (e.g., `Math.max(100, …)`) so all the truncation cases at least don't immediately-fire. Architect prefers (i) — `Number.isFinite` is the idiomatic check and renames the intent. ~3 LOC.

   (b) The comment at `config.ts:111-115` says `'Math.max(1, …) floors at 1ms to prevent a literal 0 env from producing immediate-fire.'` But `parseInt('0', 10) = 0`, `0 || 3000 = 3000` (0 is falsy), so the `=0` literal is rescued by the `||` fallback, not by `Math.max`. The Max-floor only kicks in for negative values (`-1 → 1`) or the parseInt-truncation cases in (a). Fix: rewrite the comment to accurately describe the path: `||` catches 0/empty/non-numeric, `Math.max(1, ...)` floors negative values. ~3 LOC of comment rewrite.

   Bundle (a) and (b) into the same round-3 hold item — both touch the same `config.ts` lines and the unit-test additions from item 2 should pin the (a) edge cases.

### UI follow-up (filed in chat — NOT a hold-block item)

api-contract AC-3 (P2, conf 75) surfaced a real user-facing regression: `frontend/src/pages/paper-detail.js:799-810` `loadPaper()` has a NOT_FOUND retry-with-2s-delay branch and a dedicated localized error title for `NOT_FOUND`, but no `SERVICE_UNAVAILABLE` branch. Pre-round-2, walker-aborted GET requests returned 404 NOT_FOUND, hitting the retry branch. Post-round-2 they return 503 SERVICE_UNAVAILABLE, falling through to the generic else branch with no retry and a generic error message. The SPA `loadPaper()` should pick up a `SERVICE_UNAVAILABLE` branch with retry + localized message (gated on `details.retriable` once round-3 item 1 lands).

This is UI-zone work. A parallel UI architect was reviewing UI tasks at the time of this hold; the finding is surfaced in chat rather than filed as a `ui-*` task to avoid race against their working tree. User will route to the UI architect or file the task themselves.

### Items dismissed during architect triage

- **(api-contract AC-2, P1 anchor 75, conf 80) 503 omits `Retry-After` header.** Not a hard contract violation per `common.md` (mandated only for argon2 503). The SPA is the sole consumer; the `details.retriable` field (round-3 item 1) plus the message text gives the SPA everything it needs. Revisit if a non-SPA integrator appears.
- **(adversarial adv-2, P3 anchor 75, conf 75) Per-request worst-case ≈ 70s under Promise.all amplifier in `fetchPaperDetailFromHaf`.** The Promise.all fires 7 parallel sub-queries; only `resolveContinuationChain` and `reconstructVersionsFromHaf` (walker calls) receive `signal`. The other 5 are depth-1 non-walker queries bounded individually by `statement_timeout`; they are not chain-amplifiers — the threat model the task closes is the walker amplifier (attacker-controlled chain depth × per-hop SQL). The 7-call Promise.all does mean per-request worst-case is bounded by `~budget + ceil(7/3) × statement_timeout` under sustained pool contention, not the `budget + statement_timeout` the docblock states; this is a documentation accuracy nit, not a closed-by-this-task threat. Dismissed per PEvO single-instance scaling stance (`project_single_instance_only`).
- **(adversarial adv-3, P3 anchor 50, conf 60) `isInitialBackwardProbe` regex brittleness.** Below the confidence gate. The round-2 hold-block ALREADY added a BRITTLENESS WARNING comment for this exact concern (item 8). Reviewer suggests a meta-test for mutual exclusivity with `isHeadAuthorsLookup`; that is preemptive hardening per `feedback_dismiss_preemptive_test_hardening` — no concrete refactor planned.
- **(testing T-01, P2 anchor 75, conf 85) P1 security canary loop is vacuous-safe TODAY but breaks silently if `fetchPaperDetailFromHaf` ever moves the abort check to entry.** Preemptive hardening per `feedback_dismiss_preemptive_test_hardening`. Reviewer admits the assertion IS non-vacuous in current code; the gap requires a hypothetical future refactor.
- **(testing T-02, P3 anchor 75, conf 90) `budgetMs` field has no test assertion in any canary.** Round-2 added `budgetMs` to 4 wall-clock event payloads (item 6). A regression dropping the field is silent. Reviewer recommends an additive assertion in one canary. Dismissed per `feedback_dismiss_preemptive_test_hardening`: `budgetMs` is an operator-observability field; a drop is structurally unusual (the field flows from `config.hafWalkerWallClockMs` at every emit site); the existing canaries assert the load-bearing fields (`hopIndex`, `elapsedMs`). Default-recommend dismiss.
- **(testing T-03, P3 anchor 75, conf 90) Cache-cold guarantee (item 7) is untested.** The 503-on-abort pin confirms abort fires; reviewer notes no test confirms `hafCache` was left cold post-abort. Dismissed per `feedback_dismiss_preemptive_test_hardening`: the null-return-from-fetcher-on-aborted-signal path is straight-line code with no branching beyond the `if (signal?.aborted) return null` guard; `hafCache.getOrSet` correctness (skip-write-on-null) is covered by the cache module's own tests; the integrated regression mode (second request returns stale partial data) is theoretical only.
- **(testing T-05, P3 anchor 75, conf 75) `/retract` canary mutation-kill comment states 403/404 fallthrough; actual is 200.** Documentation-only defect. Assertion is correct (200 ≠ 503 still kills). Dismissed.
- **(reliability R2, P3 anchor 75, conf 80) `/retract` + `/cite` try/finally shape narrower than `/enrichment` + GET — maintenance trap.** No active leak (`clearTimeout(walkerBudget)` fires in `finally` on every exit path). Reviewer flags as future-edit footgun. Dismissed per "three similar lines is better than a premature abstraction" and the explicit inline comments at each route documenting the per-route threat model. Revisit if a future edit adds async work between `finally` and route end.
- **(reliability R3, P3 anchor 75, conf 75) No boot-time warning for high `HAF_WALKER_WALL_CLOCK_MS` values multiplying pool-exhaustion window.** Preemptive operator-guardrail. The `.env.example` operator note documents the budget + `statement_timeout` sum and the `pool max=3` interaction; an operator setting `=60_000` is making a deliberate choice. Dismissed.
- **(performance PERF-01, P2 anchor 75, conf 75) Pool exhaustion ceiling 0.1 req/s docs gap.** Operator-documentation observation. The task spec already accepts the budget + `statement_timeout` tradeoff explicitly; the throughput-arithmetic surfacing is derivable from the existing docs. Dismissed per PEvO single-instance non-SLA stance.
- **(performance PERF-02, P2 anchor 75, conf 75) No single-flight coalescing in `hafCache.getOrSet`.** Real PERF concern but new-feature scope, separate from this task's threat model. Filed as new task `backend-cache-single-flight-coalescing.md` in `tasks/pending/`.
- **(kieran-typescript KT-1, P3 anchor 50, conf 50) `fetchEnrichmentFromHaf` lacks explicit return type.** Below confidence gate.
- **(kieran-typescript KT-2, soft, conf 40) `fetchEnrichmentFromHaf` signal? position asymmetry.** Below confidence gate.
- **(maintainability all M-R1/M-R2/M-R3) Pass-through wrapper, cast pattern repetition, wrapper shape asymmetry.** All at conf 35-60. Below threshold; reviewer self-suppressed.

### Architect followups (land at archive after round-3 clean — do NOT block backend re-submit)

- **A1 (new).** Update `agents/docs/api-contracts/papers.md` Errors sections for the 4 affected endpoints (`GET /:author/:permlink`, `GET /enrichment`, `GET /cite`, `POST /retract`) to document the new 503 SERVICE_UNAVAILABLE behavior (HAF walker budget exceeded; retriable). Architect-zone.
- **A2 (new).** Update `agents/docs/api-contracts/common.md` 503 table to enumerate the walker-budget sub-case (alongside argon2 exhaustion and bridge key not configured). Architect-zone.
- **A3 (new).** `/ce-compound` candidate: "DoS amplifier via attacker-controlled continuation chains — wall-clock budget on all sibling routes that traverse chain pointers, not just the primary GET handler." Sibling to `defense-gated-walker-early-exit-return-discipline-2026-05-16.md`; canonical exemplar is round-2 item 2 (wrapping `/cite`/`/retract`/`/enrichment` after the round-1 primary-GET-only wrapper). Architect discretion at archive.
- **A4 (new).** `/ce-compound` candidate: "503 SERVICE_UNAVAILABLE as HAF-degraded discriminator at canonical-walker routes — distinguishing degraded HAF from missing content in HTTP-status-only monitoring." Round-2 item 4 is the canonical exemplar. Architect discretion at archive.
- **A5 (carry forward).** Round-1 architect followup A3 + IS NOT NULL bundle perf-claim discrepancy from round-1 signal block — both already resolved (depth-cap docblocks landed; perf claim accurately disclaimed as structural-not-perf in the round-1 signal). No work pending.

### Re-review signal

When items 1-3 land in a single round-3 commit, `git mv` this file back to `tasks/review/`. Architect's round-3 review scopes `/ce-code-review` to the round-3 commit only. Item 1 is mechanical (5 sendError additions); item 2 adds a small unit-test file; item 3 reshapes the env parse + comment. Total diff ~30-50 LOC.

---

## Backend re-review signal (2026-05-17, round-3 hold-fixes)

All three round-3 items landed.

### Item 1 — `{ retriable: true }` on the 5 walker-abort 503 sites

`backend/src/routes/papers.ts:2341`, `:2381`, `:2676`, `:2763`, `:2927` — `sendError(res, 503, 'SERVICE_UNAVAILABLE', 'HAF walker budget exceeded; please retry', { retriable: true })`. Matches the established `bridge.ts:443` / `accreditation.ts:716` shape; SPA can branch on `err.details?.retriable` per `common.md` to surface a retry affordance.

### Item 2 — `parseHafWalkerBudget` helper + unit-test coverage

Factored a `parseHafWalkerBudget(env: string | undefined): number` helper out of `backend/src/config.ts` (exported for testability). New file `backend/tests/lib/haf-walker-budget-env-parse.test.ts` pins the 7-case coverage matrix: unset, empty, `'disabled'`, `'0'`, `'-1'`, `'5000'`, `'3000ms'`. Integration tests in `tests/routes/canonical-root-walker.test.ts` still override `config.hafWalkerWallClockMs` directly via the established cast pattern, bypassing this parse path — that's why the unit pin is necessary (the invariant was previously zero-covered).

### Item 3 — Env-parse refinement (a) + comment fix (b)

(a) Helper uses `Number(env)` + `Number.isFinite(parsed) && parsed > 0` → fallback 3000. Fixes the `'1e3' → 1` and `'1.5' → 1` truncation cases the architect called out under item 3(a). (b) Rewrote the comment block at `backend/src/config.ts:133-143`: the prior wording claimed `Math.max(1, …)` rescued literal `0`, but `0 || 3000 = 3000` so the `||` fallback was actually what caught zero — `Math.max` only floored negative values. The new comment notes both `setTimeout(fn, 0)` and `setTimeout(fn, NaN)` coerce to immediate-fire, so the `> 0` floor is load-bearing for zero/negative/non-finite inputs alike.

Scoped vitest (`tests/lib/haf-walker-budget-env-parse.test.ts` + `tests/routes/canonical-root-walker.test.ts` + `tests/routes/continuation-author-gate.test.ts` + `tests/routes/retract.test.ts`): 88 specs green. `npx tsc --noEmit` + `npm run lint` clean.

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` ran on round-3 commit `94bf294` with 7 reviewer personas (correctness on Opus; testing, maintainability, project-standards, learnings-researcher, api-contract, kieran-typescript at Sonnet; adversarial skipped per architect scope on the small 309-LOC diff; `ce-agent-native-reviewer` skipped per project CLAUDE.md). All 3 round-3 hold items landed structurally and against intent. One item holds for round-4; one carry-forward followup; several items dismissed at triage.

### Item to address (round-4 hold)

**1. (P3, anchor 75, cross-reviewer testing T2 + correctness testing_gap + kieran-typescript TG-1) `parseHafWalkerBudget` unit test missing the `'1e3'` and `'1.5'` cases.** `backend/tests/lib/haf-walker-budget-env-parse.test.ts`. The 7-case matrix (`unset, empty, 'disabled', '0', '-1', '5000', '3000ms'`) covers the architect-prescribed fallback inputs but doesn't include the two inputs that motivated the `parseInt` → `Number` switch: `'1e3'` (parseInt → 1, Number → 1000) and `'1.5'` (parseInt → 1, Number → 1.5). Reverting `Number(env)` back to `parseInt(env, 10)` leaves all 7 specs green because `parseInt('5000', 10) === Number('5000')` — the parseInt-vs-Number behavioral difference has no mutation-kill in the current test set.

   Fix: add two cases at the bottom of the test file:
   ```ts
   it('returns 1000 for scientific notation (Number, not parseInt → 1)', () => {
     expect(parseHafWalkerBudget('1e3')).toBe(1000);
   });
   it('returns 1.5 for fractional ms (Number, not parseInt → 1)', () => {
     expect(parseHafWalkerBudget('1.5')).toBe(1.5);
   });
   ```
   ~6 LOC. Each pins the helper's intent against the specific motivating regression class.

### Items dismissed during architect triage

- **(api-contract AC-1 papers.md missing 503 for paper-detail/enrichment/cite/retract + AC-2 common.md 503-table refresh)** Resolved in architect-zone commit `66b213ac` in the same review session.
- **(api-contract AC-3 informational, two distinct 503 triggers on same routes — walker-budget vs HafQueryError-translation)** Addressed in commit `66b213ac` — the new papers.md Errors sections explicitly enumerate both triggers per route and note "consumers cannot distinguish them via the envelope and need not".
- **(maintainability M1 docblock cites two test file paths)** Per user triage: dismiss. File-path anchors are stable enough; the concrete pointer is useful for future readers.
- **(correctness residual: `'1.5'` survives `> 0` floor producing sub-ms budget)** Operator misconfiguration; setTimeout floors to 1ms per HTML spec; effectively immediate-fire. Not a realistic threat.
- **(learnings-researcher: pg `statement_timeout` disclosure on hafWalkerWallClockMs knob)** Real concern flagged by the `pg-abortcontroller-budget-bounded-by-statement-timeout-2026-05-16.md` convention — but the knob docblock at `config.ts` and `.env.example` already document the budget + statement_timeout sum (verified added in round-2 item 3). The learnings-researcher's reminder applies; no new work needed in round-4.
- **(maintainability R3 pre-existing parseInt knobs in config.ts use the safe `|| 'hardcoded-default'` form, not actionable)** Confirmed by reviewer; no migration needed.
- **(reliability/learnings RR-1 budget + statement_timeout disclosure already landed in round-2)** Re-flagged by learnings-researcher; verified the docblock and `.env.example` already capture it.

### Architect followups (no implementer action — already resolved this review session)

- **A1 + A2.** papers.md + common.md doc updates landed in commit `66b213ac`.
- **A3.** Pre-existing residuals in `config.ts:132` (task-slug `BACKEND-HAF-WALKER-WALL-CLOCK-BUDGET`) and `papers.ts:2138-2139` (triple-rot comment) flagged by maintainability as candidates for archive-time sweep. Not bundled into this round-4 (not introduced by this commit, and the focus-trim principle applies). Architect notes for a future comment-anchor sweep task if/when the area is touched.

### Re-review signal

When item 1 lands in a single round-4 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Diff is ~6 LOC; round-4 should converge clean.
