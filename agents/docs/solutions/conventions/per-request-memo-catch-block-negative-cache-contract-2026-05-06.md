---
title: Per-request memoization helpers must memoize null in catch blocks, not just success-path early-returns
date: 2026-05-06
category: conventions
module: backend/src/routes/papers.ts
problem_type: convention
component: caching
severity: high
applies_when:
  - "Writing a per-request memoization helper whose documented contract caches both success and failure results (Map<key, T | null> shape where null is a resolved answer, not a sentinel)"
  - "Adding a try/catch block to any helper that memoizes by key before returning"
  - "Reviewing a helper that returns null on error: check that memo?.set(key, null) is present in every return-null branch including the catch block"
  - "Diagnosing inflated request wall-clock times under degraded backend conditions (the N x statement_timeout request-amplifier pattern)"
related_components:
  - backend-papers-routes
  - haf-pool
  - backend-canonical-root-walker
tags:
  - memoization
  - error-handling
  - statement-timeout
  - request-amplifier
  - contract-enforcement
  - caching-discipline
  - per-request-cache
---

## Rule

A per-request memoization helper of shape `Map<key, T | null>` whose docblock contract states that BOTH null and non-null results are cached MUST enforce that contract at every return path. **The catch block is a return path.** A `return null` in a catch block without a preceding `memo?.set(key, null)` is a contract violation that converts the helper into a request-amplifier under degraded backend conditions.

## Context

`fetchHeadAuthorizedAuthors` in `backend/src/routes/papers.ts` is a per-request memoization helper of shape `Map<string, Set<string> | null>`. Its docblock contract states: "Both null and Set results are cached." The contract is correct in spirit; the enforcement had a gap.

The success-path early-returns correctly memoized both outcomes:
- Lookup succeeds, returns a Set: `memo.set(key, set)`
- Post not found, malformed metadata, or type-spoof: `memo.set(key, null)` then `return null`

The catch block (`papers.ts:843-846` before the round-2 fix) returned null without calling `memo.set(key, null)`. Under degraded HAF, a single HTTP request that called this helper for the same `(author, permlink)` key three times (canonical-walker invocation + `fetchPaperDetailFromHaf` invocation + `reconstructVersionsFromHaf` invocation) re-fired the same failing query three times. Each query blocked for the full HAF `statement_timeout=30000ms` (`backend/src/db.ts:22`). Three lookups meant 90 seconds of blocking instead of 30, with worker-thread starvation under sustained degradation.

The round-2 fix was one line in the catch block (`memo?.set(key, null);`). Round-2 commit `3bef3de` added a canary to `backend/tests/routes/canonical-root-walker.test.ts` that exercises the same-key-multiple-times path with a failing-primitive simulation.

## Guidance

**Bad pattern (catch block missing `memo.set`):**

```ts
async function fetchHeadAuthorizedAuthors(
  author: string,
  permlink: string,
  memo?: Map<string, Set<string> | null>,
): Promise<Set<string> | null> {
  const key = `${author}/${permlink}`;
  if (memo?.has(key)) return memo.get(key)!;

  try {
    const rows = await pool.query(/* ... */);
    if (!rows.length) {
      memo?.set(key, null);
      return null;
    }
    const set = new Set(rows.map(r => r.author));
    memo?.set(key, set);
    return set;
  } catch (err) {
    log.warn({ err }, 'fetchHeadAuthorizedAuthors: HAF error');
    return null;  // BUG: memo?.set(key, null) missing here
  }
}
```

**Good pattern (catch block memoizes the failure):**

```ts
  } catch (err) {
    log.warn({ err }, 'fetchHeadAuthorizedAuthors: HAF error');
    memo?.set(key, null);  // failure is a resolved answer; memoize it
    return null;
  }
```

The optional-chaining (`memo?.set`) is correct when the `memo` parameter is optional; with a required parameter, drop the `?.` for clarity.

### Why the catch block is the miss-prone site

Three forces combine to produce this gap reliably across implementers:

1. **Visual proximity.** The docblock stating "both null and Set are cached" sits near the success-path early-returns. The implementer threads memoization through every visible branch and considers the contract satisfied.
2. **Mental framing.** Catch blocks read as "exceptional path: log and bail." Contract enforcement feels like normal-path logic, not cleanup logic.
3. **Test coverage gap.** Unit tests typically invoke the helper once per test. The same-key-multiple-times-per-request scenario is never exercised, so the missing `memo.set` is invisible until degraded backend conditions surface it.

### The canary pattern this convention requires

Any helper of this shape MUST have a canary that exercises the same-key-multiple-times path under a failing primitive:

```ts
it('does not re-query HAF when first call throws for same key', async () => {
  const memo = new Map<string, Set<string> | null>();
  const querySpy = vi.spyOn(pool, 'query')
    .mockRejectedValueOnce(new Error('simulated HAF timeout'));

  const r1 = await fetchHeadAuthorizedAuthors('alice', 'paper-1', memo);
  const r2 = await fetchHeadAuthorizedAuthors('alice', 'paper-1', memo);

  expect(r1).toBeNull();
  expect(r2).toBeNull();
  expect(querySpy).toHaveBeenCalledTimes(1);  // second call hit memo
});
```

Mutation-kill: revert the catch-block `memo?.set(key, null)` line. `querySpy` fires twice; canary fails red. Per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`, that revert-verify is the load-bearing signal.

## Why This Matters

**Cost amortization under degraded backend.** PEvO's HAF pool sets `statement_timeout=30000ms` (`backend/src/db.ts:22`). Without catch-block memoization, the cost is N × statement_timeout per request, where N is the number of within-request lookups for the same key:

| State | Queries fired | Wall-clock block |
|-------|---------------|------------------|
| Before fix (catch block missing `memo.set`) | 3 | 90s |
| After fix | 1 | 30s |

The savings scale linearly: 1 LOC saves `(N-1) × statement_timeout` per request under sustained backend degradation.

**Silent under normal conditions.** On healthy HAF the query succeeds on the first call, the success-path branch memoizes the Set, and subsequent lookups hit the memo. The missing catch-block memoization is invisible. This is why the gap survives code review and standard test runs: the cost only materializes when the backend is already degraded.

**Self-compounding failure mode.** Under sustained HAF degradation, each request retries N redundant queries. Concurrent requests in flight (likely during a degradation event, as retries pile up) multiply the total query volume against an already-struggling backend. The fix converts per-request N-redundancy into one-query-per-key regardless of degradation duration.

## When to Apply

Apply whenever:

- You are writing or reviewing a `Map<key, T | null>` per-request memoization helper.
- The docblock or informal contract states that both resolved-value and null outcomes are cached.
- The underlying primitive has a non-trivial timeout (`statement_timeout`, fetch timeout, external API timeout).
- The helper can be called multiple times for the same key within a single request or operation.

### Implementer checklist

1. Every early-return that returns null calls `memo?.set(key, null)` first.
2. Every catch block that returns null calls `memo?.set(key, null)` before the return.
3. There is a canary test that simulates a failing primitive and asserts the primitive fires exactly once when the helper is called twice for the same key in the same request.
4. Reverting the catch-block `memo?.set` makes the canary fail red (mutation-kill confirmed).

### Audit grep

When auditing existing helpers in PEvO:

```bash
grep -n "return null" backend/src/routes/papers.ts
```

For each hit, verify a `memo.set` or `memo?.set` call precedes it within the same branch. A `return null` inside a catch block with no preceding `memo.set` in that block is the gap.

## Examples

### The PEvO instance (round-2, 2026-05-06)

`fetchHeadAuthorizedAuthors` was called from three sites within a single paper-detail request, all passing the same `(author, permlink)` key:

1. Canonical-walker invocation (`findCanonicalRoot`)
2. `fetchPaperDetailFromHaf` invocation
3. `reconstructVersionsFromHaf` invocation

Round-2 of `backend-canonical-root-walker-author-gate` (commit `3bef3de`) closed the catch-block contract gap as hold item 4. Round-3 of the same task (filed 2026-05-06) closes a related but distinct gap: a fourth caller (`resolveVersionsFromHaf` at `papers.ts:1421`) was not threading the memo at all, so the catch-block negative-cache benefit could not even apply on that code path. Same convention; different miss site (memo-threading vs catch-block-enforcement).

### Future-helper checklist

When the next per-request memo helper of this shape lands in PEvO (likely candidates: any HAF-backed `fetchX` helper, any reputation-cycle helper, any accreditation-attestation lookup), the implementer must:

1. Document the contract in the docblock ("Both null and `<T>` results are cached").
2. Memoize on every early-return null branch.
3. Memoize on the catch-block null branch.
4. Add the same-key-multiple-times canary with mutation-kill attestation.

## Cross-references

- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — see also for canary / mutation-kill discipline. The required regression test must fail on deletion of the catch-block `memo?.set` line; that revert-verify is what makes the canary load-bearing.
- `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — see also for the outer every-return-path / every-syntactic-shape audit principle. This convention is the intra-helper specialisation: the outer audit covers "did every CALL SITE pass the memo"; this convention covers "did the helper enforce its contract at every INTERNAL return path."

## Source

`/ce-code-review` round-2 of `backend-canonical-root-walker-author-gate` (commit `3bef3de`). Hold item 4 closed the catch-block gap. Architect re-review on 2026-05-06 captured the generalizable contract via `/ce-compound`.

Round-2 reviewer attribution for the original gap-finding: reliability + correctness reviewers traced the cost-amortization arithmetic; learnings-researcher flagged the recurrence-likelihood that justified capturing as a convention.
