---
title: "pg v8.x pool.query has no AbortSignal — AbortController budgets bound to (budget + statement_timeout), not budget alone"
date: 2026-05-16
category: conventions
module: backend
problem_type: convention
component: database
severity: medium
applies_when:
  - "Wrapping a sequence of pg pool.query / client.query calls with an AbortController + setTimeout wall-clock budget"
  - "Reviewing any HAF or app-DB call path that claims a per-request wall-clock bound"
  - "Tuning a *_BUDGET_MS or *_WALL_CLOCK_MS config knob and reasoning about the real worst-case wall clock"
  - "Authoring docblocks or .env.example operator notes for any AbortController-on-pg surface"
  - "Adding new pg-touching code paths that need per-request timeout protection (HAF walkers, app-DB reads, future query helpers)"
related_components:
  - tooling
tags:
  - node-postgres
  - pg
  - abortcontroller
  - statement-timeout
  - haf
  - budget
  - wall-clock
  - library-version-assumption
---

# pg v8.x pool.query has no AbortSignal — AbortController budgets bound to (budget + statement_timeout), not budget alone

## Context

Round-1 of `backend-haf-walker-wall-clock-budget` (commits `1d01a21` + `79078d7` + `741a3e9` on main, 2026-05-16) added an `AbortController` + `setTimeout(config.hafWalkerWallClockMs)` (default 3000ms) wrapping the canonical-root walker's cascading HAF queries in `backend/src/routes/papers.ts`. A `signal?: AbortSignal` was threaded through five walker functions, with `signal?.aborted` checks at iteration boundaries between `pool.query` calls.

The task acceptance note framed this as "verify; Node-postgres has `signal:` support since v8". Verified empirically against `backend/node_modules/pg @ 8.20.0`:

```bash
grep -rn "AbortSignal\|signal:" node_modules/pg/lib/ | head
# zero hits
```

pg v8.x never shipped `signal:` support in `pool.query` / `client.query`. The belief that it exists is widespread (long-running GitHub issue tracker discussion, speculative TypeScript types in some `@types/pg` versions, other Node DB libraries with the integration), but the pg mainline does not implement it.

The implementer correctly fell back to "manual abort check between queries" per the task spec. The trap surfaced in review: the docblock at `routes/papers.ts:~2084-2097`, the config knob comment at `config.ts:~82-93`, and the `.env.example` operator-facing documentation all framed the budget as wall-clock-tight ("3000ms default per request"). The actual per-request worst case is `hafWalkerWallClockMs` (3000ms) + the last-in-flight `statement_timeout` (`backend/src/db.ts:22` = 30000ms) = **~33s, not 3000ms.**

With `pool.max = 3` (`backend/src/db.ts:24`), three concurrent aborted requests can hold all three connection slots for up to ~27s post-abort, queuing subsequent requests behind `connectionTimeoutMillis=5s` failures.

Four reviewers cross-corroborated this independently (security + adversarial Opus; reliability + performance Sonnet); each had to dig into `node_modules/pg/lib/` to verify. Multi-reviewer convergence on a library-claim refutation is the signal that this is a structural trap, not a one-off mistake. Every future AbortController-on-pg surface in PEvO will face the same gap unless the convention is documented.

This sits in a recognizable "AbortController-coverage-narrower-than-reviewers-assume" cluster. The sibling `fetch-abort-controller-bounds-headers-only-2026-05-06.md` documents the parallel WHATWG `fetch()` trap (abort bounds the headers phase, not body-read). Same meta-shape: the wrapper looks complete; the gap sits between what the abort primitive bounds and what the documentation claims.

## Guidance

**Rule.** When wrapping `pool.query` / `client.query` (pg v8.x) with an `AbortController` for budget discipline, the contract is "abort stops new queries from being dispatched", not "abort the whole call within N ms". In-flight `pool.query` calls run to completion (or to PostgreSQL's `statement_timeout`, whichever fires first); the AbortSignal has no path into the running query because pg v8.x's `query()` does not consume an `init.signal` and does not subscribe to one if passed.

**Real per-request worst case at every AbortController-on-pg site is `budget + statement_timeout`.** Document that sum at every site, not the budget alone.

Three resolution options, ordered by cost:

### 1. Document and accept the bound (recommended default)

At every AbortController-on-pg call site, inline a comment stating the actual bound, the missing library support, and the upgrade path. Update operator-facing docs (`.env.example`, config knob comment, route handler docblock) to reflect `budget + statement_timeout`, not the budget alone. Cheapest; matches PEvO's "document the gap, dismiss the over-fix" disposition on similar AbortController traps.

The comment IS the fix on this path. Without it, the next reviewer reading the code assumes the wrapper is wall-clock-tight, the next operator setting `HAF_WALKER_WALL_CLOCK_MS=3000` thinks they capped requests at 3s, and the next implementer copies the pattern to a new surface inheriting the same silent gap.

### 2. Tighten `statement_timeout` for the affected code path

Per-query `SET LOCAL statement_timeout = 5000` at the top of the path, or a dedicated walker connection pool initialized with a tighter timeout in `connectionString`. Reduces the tail from ~30s to ~5s but still doesn't cancel in-flight queries. The gap remains; the bound is just smaller. Combine with option 1's comment; the comment now says `budget + 5000` instead of `budget + 30000`.

### 3. Real cancellation via `Client.cancel()`

pg's `Client.cancel()` opens a SEPARATE connection and sends a PostgreSQL `CancelRequest` message to the running query's backend. Heavyweight: requires tracking in-flight query handles per `pool.query`, opening an out-of-band connection per cancel, handling cancel-race semantics (query completes between cancel-decide and cancel-send), and managing the extra connection slot's pool pressure. ~30-50 LOC per surface. Reach for this only when the `budget + statement_timeout` bound is operationally too loose for a specific surface (e.g., a user-facing synchronous endpoint where a 33s tail visibly degrades UX, AND the surface has high enough request rate that pool-slot starvation under load is real).

**Code-review checklist.** When reviewing a new AbortController-on-pg site, ask three questions before approving:

- What does the wrapper's contract claim: full wall-clock cap, or "stop dispatching new queries"?
- Is `statement_timeout` (or `SET LOCAL statement_timeout`) referenced at the call site to make the tail computable?
- Is the `budget + statement_timeout` sum reflected in operator-facing docs (`.env.example`, knob comment, route docblock)?

Single-question shortcut: grep the file for `pool.query`, `client.query`, `getClient().query` against the wrapper's `AbortController`. If any are wrapped without an inline comment naming the `budget + statement_timeout` real bound, the wrapper's framing does not match its semantics.

## Why This Matters

The trap is invisible at the wrapper's surface. Reading the walker code, a reviewer sees the canonical AbortController shape (`new AbortController()`, `setTimeout(() => abort(), ms)`, `if (signal.aborted) return` at iteration boundaries, `clearTimeout(timer)` in `finally`) and assumes the contract bounds the whole code path. The MDN documentation for `AbortController` and the broader Node ecosystem reinforce the assumption: `fetch()`, `setTimeout` (Node 17.3+), `stream.pipeline`, several DB libraries (`mysql2`, `mongodb` driver, some `pg` forks/wrappers) all integrate AbortSignal. pg mainline v8.x is the outlier; the assumption that it follows the ecosystem default is the reviewer's default mistake.

The cost compounds under concurrency. With `pool.max = 3` and a 3000ms budget framed as wall-clock-tight, three concurrent aborted requests look like they should free their slots in ~3s. They actually hold slots for up to `3 + 30 = 33s` (until the last `pool.query` returns from `statement_timeout`). Subsequent requests queue behind `connectionTimeoutMillis=5s` failures. The operator looking at `HAF_WALKER_WALL_CLOCK_MS=3000` in `.env` cannot diagnose this from the config; the knob lies about what it does.

The four-reviewer cross-corroboration on `1d01a21+79078d7+741a3e9` is the structural-trap indicator. Each reviewer had to read pg source to verify; each independently flagged the same gap with the same root-cause. Multiple lenses landing on the same gap independently means future PEvO surfaces will hit it too unless the rule is named.

The rule's positive side: stating the bound explicitly turns "AbortController-on-pg coverage" into a concrete review item. New surfaces either document `budget + statement_timeout` precisely (accept the bound) or wire `Client.cancel()` (close the gap structurally). Either way, the gap is no longer silent and the operator-facing knob no longer lies.

This is a third worked example of the broader "verify-library-claims" discipline (see `verify-library-claims-before-load-bearing-security-margins-2026-04-22.md`): the dhive-broadcast-timeout claim and the pg-AbortSignal claim are the same failure mode at different libraries. Task specs assert library capabilities; the assertion goes unverified at draft time; the implementation inherits the misframing; only cross-reviewer code review catches it. The verification recipe below is the per-PR enforcement.

## When to Apply

- Authoring any new AbortController-on-pg site in PEvO backend code: wall-clock budgets on walker code paths, query-budget caps on user-facing routes, fan-out coordinators issuing parallel `pool.query` calls, anything that wraps `pg.Pool` / `pg.Client` with abort semantics.
- Reviewing a PR that introduces or modifies an AbortController wrapping `pool.query` / `client.query`, particularly when the wrapper is presented as "a per-request budget" or "a wall-clock cap".
- Extending an existing wrapper (e.g., the canonical-root walker's `walkerAbort`) to a new caller whose `statement_timeout` differs from the original consumer's pool, or whose `pool.max` makes slot-starvation a different shape.
- Triaging a route handler that exceeds its configured budget in production despite an AbortController being in place. The wrapper might be doing what pg's actual semantics allow (stop new queries); the tail is in `statement_timeout` territory.
- Updating PEvO's `pg` major version: re-run the verification recipe below; if a future pg version ships native AbortSignal support, retire this convention or downgrade it to a pre-v$VERSION footnote.
- Reviewing operator-facing docs (`.env.example`, config knob comments) that quote a budget value alone for any AbortController-on-pg knob — flag for `budget + statement_timeout` sum disclosure.

## Examples

### Anti-pattern — wall-clock-tight framing (the gap)

```ts
// MISLEADING: "Budget bounds the per-request wall-clock to 3000ms"
// (real bound is budget + statement_timeout = ~33s)
const walkerAbort = new AbortController();
const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
try {
  for (const row of cascade) {
    if (walkerAbort.signal.aborted) return null; // bails BEFORE next query
    const result = await pool.query(sql, params);    // in-flight query runs to statement_timeout
    // ...
  }
} finally {
  clearTimeout(walkerBudget);
}
```

```
# .env.example
# Per-request wall-clock budget for the canonical-root walker (ms).
# Caps the worst-case time spent in a single canonical-root resolution.
HAF_WALKER_WALL_CLOCK_MS=3000
```

The wrapper bails before dispatching the next query; the last in-flight query has no way to receive the abort. `.env.example` documents the budget alone; the operator setting `HAF_WALKER_WALL_CLOCK_MS=3000` expects a 3s cap. Three concurrent aborted requests hold pool slots for up to ~33s, queuing subsequent requests behind `connectionTimeoutMillis=5s` failures.

### Fixed — honest bound at every documentation site (option 1, recommended default)

```ts
// Budget stops new queries from being dispatched after config.hafWalkerWallClockMs.
// In-flight pool.query continues until PostgreSQL's statement_timeout
// (backend/src/db.ts:22 = 30000ms). Real per-request worst case = budget +
// statement_timeout = ~33s. pg v8.x does not support AbortSignal in pool.query;
// Client.cancel() is the only way to cancel in-flight queries (heavyweight,
// out of scope here). See agents/docs/solutions/conventions/
// pg-abortcontroller-budget-bounded-by-statement-timeout-2026-05-16.md.
const walkerAbort = new AbortController();
const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
try {
  for (const row of cascade) {
    if (walkerAbort.signal.aborted) return null;
    const result = await pool.query(sql, params);
    // ...
  }
} finally {
  clearTimeout(walkerBudget);
}
```

```ts
// config.ts
// hafWalkerWallClockMs: budget that stops new walker queries from dispatching.
// Real per-request worst case is hafWalkerWallClockMs + db statement_timeout
// (default 30000ms in backend/src/db.ts), since pg v8.x does not honor
// AbortSignal inside an in-flight pool.query. Tune both knobs together when
// adjusting walker bounds.
hafWalkerWallClockMs: numFromEnv('HAF_WALKER_WALL_CLOCK_MS', 3000),
```

```
# .env.example
# Budget that stops new canonical-root walker queries from being dispatched (ms).
# Real per-request worst case is HAF_WALKER_WALL_CLOCK_MS + the database
# statement_timeout (~30000ms default), because pg v8.x does not cancel
# in-flight queries via AbortSignal. With pool.max=3, three concurrent
# aborted requests can hold all three slots until the last in-flight query
# completes. Tune in conjunction with statement_timeout if the tail matters.
HAF_WALKER_WALL_CLOCK_MS=3000
```

The gap is no longer silent. Future maintainers extending the wrapper see the rationale and the upgrade path; operators tuning the knob see the actual bound and the co-knob (`statement_timeout`) that bounds the tail.

### Fixed — tighter per-path statement_timeout (option 2, when the ~30s tail is too loose)

```ts
// Reduces the tail from ~30s to ~5s. Still no in-flight cancellation; the
// budget + 5s sum is the real bound. Apply when budget + 30s degrades a
// specific surface (user-facing sync endpoint, high-rate path with slot
// starvation risk) but Client.cancel() is overkill.
const client = await pool.connect();
try {
  await client.query('SET LOCAL statement_timeout = 5000');
  for (const row of cascade) {
    if (walkerAbort.signal.aborted) return null;
    const result = await client.query(sql, params);
    // ...
  }
} finally {
  client.release();
}
```

The docblock comment now reads `budget + 5000`, not `budget + 30000`. Same shape as option 1; tighter sum.

### Verification recipe (for future readers)

Verify the installed pg version's AbortSignal support empirically before assuming the convention still applies. The check is two commands and definitive:

```bash
# In backend/:
node -e "console.log(require('pg/package.json').version)"
# Then grep the installed source:
grep -rn "AbortSignal\|signal:" node_modules/pg/lib/ | head
```

- Zero hits → no AbortSignal support; this convention applies.
- Non-zero hits → check that version's release notes and `node_modules/pg/lib/client.js` / `connection.js` for the integration shape. If `pool.query` honors `init.signal` to cancel an in-flight query, this convention can be downgraded to a pre-v$VERSION footnote or retired entirely.

Run this check on every pg major-version bump and on every new AbortController-on-pg PR before approving.

## Related

- `agents/docs/solutions/conventions/fetch-abort-controller-bounds-headers-only-2026-05-06.md` — direct sibling. Same meta-shape: AbortController coverage is narrower than reviewers assume; document the actual scope at every wrap site. That doc covers WHATWG `fetch()`'s headers/body split (abort bounds headers, body-read unbounded); this doc covers pg v8.x's missing AbortSignal integration (abort bounds new-query dispatch, in-flight queries unbounded). Both belong in an "AbortController-semantics-misread" cluster: when reviewing any new AbortController wrap site, check both axes.
- `agents/docs/solutions/conventions/verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` — causal predecessor. The canonical PEvO learning that third-party-library claims (dhive broadcast timeout) must be verified empirically, not assumed from documentation or ecosystem analogy. This doc is the same shape applied to pg: "Node-postgres has `signal:` support since v8" was an empirically-false claim that survived task drafting and only surfaced in code-review on cross-reviewer convergence. Verification recipe above is the per-PR enforcement.
- `agents/docs/solutions/conventions/verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md` — sibling on knob-math discipline. `hafWalkerWallClockMs` is a knob whose claimed bound is wrong because a library-behavior assumption (pg AbortSignal) didn't hold. Same family: knob math must be derived from empirically verified library behavior.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — adjacent timeout-semantics convention. Different mechanism (broadcast timer fire says nothing about chain-state) but same family of "timer fire is not the outcome you think it is" hazards. Pairs with this doc when designing any budget+timeout surface that crosses an I/O boundary the timer can't reach into.
- `backend/src/routes/papers.ts` (canonical-root walker, ~lines 2084-2097) — the first PEvO instance of this pattern. Documented gap per this convention; accepted as residual risk for the walker's deployment shape per the architect triage on 2026-05-16.
- `backend/src/db.ts:22` — `statement_timeout = 30000` (the tail bound that pairs with every AbortController-on-pg budget).
- `backend/src/db.ts:24` — `pool.max = 3` (the slot-starvation amplifier under concurrent abort).
- Origin: `/ce-code-review` of commits `1d01a21` + `79078d7` + `741a3e9` (`backend-haf-walker-wall-clock-budget` round-1, 2026-05-16), four-reviewer cross-corroboration (security, adversarial, reliability, performance).
