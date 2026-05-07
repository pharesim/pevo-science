---
title: Defense-in-depth canaries must pin each layer — bypassing the upstream gate to test the downstream branch leaves the upstream invariant unprotected
date: 2026-05-07
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - A canary force-feeds rows past an upstream gate (SQL filter, JS narrowing, auth middleware, schema check) to exercise a downstream branch
  - A downstream branch's log-level discipline (warn vs debug), error severity, or alarm wiring is justified by reasoning that "the upstream gate makes this rare in production"
  - The upstream gate lives in a different layer (SQL, middleware) from the canary mock (JS test fixture)
  - Designing mutation-kill coverage for multi-layer defense-in-depth code paths
related_components:
  - database
  - background_job
tags:
  - testing
  - canaries
  - defense-in-depth
  - mutation-kill
  - log-levels
  - observability
  - layer-bypass
---

## Rule

In a defense-in-depth code path, **each defending layer must have its own canary**. A canary that force-feeds rows past upstream layer N to exercise downstream branch N+1 does NOT mutation-kill layer N. If branch N+1's log level, error severity, or alarm wiring carries a rationale that depends on layer N filtering inputs (e.g., "warn not debug because the SQL guard makes this rare"), that rationale is silently unprotected: a future refactor that removes layer N would silently land, branch N+1 would activate at production-noise volumes, and no test would fail.

The mutation-kill matrix grows with the number of defending layers, not with the number of bypass paths a single downstream canary covers.

## Why this fails silently

The downstream canary is structurally unable to fail when the upstream layer is mutated, because it constructs its inputs *as if* the upstream layer were already absent. The bypass IS the test design. So:

1. A future refactor drops the upstream gate (intentionally, or as an accidental WHERE-clause rewrite).
2. Production now lets through inputs the gate was screening out.
3. The downstream branch fires on every such input.
4. `logger.warn` (or the alarm, or the severity-N error) floods at production-traffic volumes.
5. Every existing canary still passes — they bypassed the upstream gate by construction; their behavior is invariant to whether the gate exists.
6. The level-discipline comment ("rare HAF data-integrity surprise") is now factually wrong, but no CI signal fires.

The failure is especially insidious because the canary suite *looks complete*: it covers the downstream branch from multiple angles, the mutation-kill matrix has rows for it, the review approved the coverage. The missing row is invisible until production floods.

## Fix shape — the upstream-guard canary

For every downstream canary that force-feeds past layer N, add a companion canary whose mock distinguishes "layer N present" from "layer N absent" and asserts the right outcome in each state.

For a SQL guard, the discriminator inspects the live SQL string for the predicate (analogous to the existing `/'type'/.test(sql)` discriminator pattern for `validPevoPaperWhere`):

```ts
it('IS NOT NULL guard canary: drops the spoof row when the SQL guard is present', async () => {
  const probeHandler = (sql: string) => {
    const hasGuard = sql.includes("'continues' IS NOT NULL");
    return hasGuard
      ? []                                                  // guard present → SQL filtered, 0 rows
      : [{ author: 'alice', cont_author: null, /* ... */ }]; // guard absent → spoof row
  };
  mockPool.query.mockImplementation(probeHandler);

  const result = await findCanonicalRoot(startAuthor, startPermlink);

  // With guard present, walker bails on 0 rows; downstream branch never fires.
  expect(result).toBeNull();
  expect(warnSpy).not.toHaveBeenCalled();
  // Mutation-kill row: drop "'continues' IS NOT NULL" → probeHandler returns the spoof row
  //                    → downstream JS narrowing fires → warnSpy WOULD be called → this expect FAILS RED.
});
```

The mutation-kill matrix entry becomes explicit: "drop `'continues' IS NOT NULL`" → guard canary FAIL RED, others PASS GREEN. That is what makes the upstream gate a first-class protected invariant.

The same shape generalizes:

| Upstream layer | Discriminator |
|---|---|
| SQL predicate | inspect SQL string for the predicate substring (e.g., `sql.includes("'continues' IS NOT NULL")`) |
| Express middleware | inspect router middleware stack, OR run an integration test where the request fails at the middleware layer and never reaches the handler |
| Type narrowing earlier in the call chain | construct a value that violates the narrowing precondition; assert the function bails before reaching the downstream branch |
| Schema validation | submit a payload that the schema would reject; assert the route returns 400 before the downstream branch runs |

In every case the rule is the same: the canary's inputs vary based on whether the upstream layer is intact, and the assertion changes accordingly.

## How to recognize the pattern

During review or authorship, look for any of these signals:

- A test comment includes phrases like "force-feed past the SQL gate," "bypass the IS NOT NULL filter," "stub out the middleware to isolate the downstream check."
- A downstream branch contains a comment like "warn (not debug) — the upstream filter makes this rare in prod" or "high severity because the auth layer prevents this reaching here at scale."
- A mock's routing logic is keyed on a guard predicate for *dispatch* purposes (to decide which branch to exercise), but does not assert whether that predicate is present in the real production code.
- The mutation-kill matrix has rows for the downstream branch's behavior but no row for mutating the upstream guard that protects it.

**Smell test.** For every downstream branch whose level, severity, or alarm wiring is justified by an upstream filter, ask: *"Is there a test that will fail RED if I delete the upstream filter?"* If the answer is no, the upstream filter needs its own canary.

## Examples

### PEvO concrete instance — `findCanonicalRoot` `cont_columns_invalid` branch

The upstream guard in `backend/src/routes/papers.ts` (around line 1346):

```sql
WHERE c.json_metadata -> $3 ->> 'app' = $1
  AND c.json_metadata -> $3 -> 'continues' IS NOT NULL  -- upstream guard
  AND ${validPevoPaperWhere(...)}
```

The downstream branch (`backend/src/routes/papers.ts`, around lines 1401-1416):

```ts
if (typeof startRow.cont_author !== 'string' || typeof startRow.cont_permlink !== 'string') {
  const reason: CanonicalRootBailReason = 'cont_columns_invalid';
  logger.warn(
    { event: 'canonical_root_walker_start_invalid', reason, startAuthor, startPermlink },
    'canonical-root walker START row had non-string cont_author or cont_permlink',
  );
  // Level: warn (per discipline comment above) — IS NOT NULL guard normally prevents reaching this branch.
  return null;
}
```

The existing canary in `backend/tests/routes/canonical-root-walker.test.ts` (around lines 690-723) force-feeds a row with `cont_author: null, cont_permlink: null`. The responder mock returns this row whenever the initial-probe regex matches; it does not inspect whether `'continues' IS NOT NULL` is in the SQL string. The canary correctly mutation-kills "delete the JS narrowing check." It does NOT mutation-kill "drop the SQL `IS NOT NULL` predicate."

Failure walkthrough:

| Step | What happens |
|---|---|
| Refactor drops `'continues' IS NOT NULL` | SQL now returns non-continuation paper rows |
| `cont_author` / `cont_permlink` projections | Evaluate against missing JSON keys → `null` |
| JS narrowing branch | Fires on every non-continuation paper detail lookup |
| `logger.warn` | Floods at production-traffic volume |
| `cont_columns_invalid` canary | Still passes — bypasses the deleted guard by construction |
| Level-discipline comment | Now factually incorrect; no test catches the drift |

The fix landed as round-2 hold item 4: a 5th canary whose responder mock inspects the live SQL text for `'continues' IS NOT NULL` and varies its output accordingly. The mutation-kill matrix grew from 4 canaries × 5 mutations to 5 canaries × 6 mutations.

### Hypothetical second instance — auth middleware + handler permission check

```ts
app.use('/api/admin', requireAdminAuth);          // upstream gate

function adminHandler(req, res) {                 // downstream branch
  if (!req.user?.isAdmin) {
    logger.warn({ userId: req.user?.id }, 'Non-admin reached admin handler — possible bypass');
    // Level: warn not error — requireAdminAuth should block all non-admins first.
    return res.status(403).json({ error: 'Forbidden' });
  }
  // ...
}
```

A canary that stubs out `requireAdminAuth` and sends a non-admin request correctly mutation-kills "delete the `!req.user?.isAdmin` check." But if the `warn` level (rather than `error`) is justified by "requireAdminAuth makes non-admins rare here," the same gap applies: no canary fails RED if `requireAdminAuth` is unmounted from `/api/admin`. The fix is a second canary that asserts `requireAdminAuth` is mounted on the route — by inspecting the router's middleware stack, or by integration-testing a request that fails at the middleware layer and never reaches the handler.

## Cross-references

- [`tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`](./tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md) — foundational rule: tests must fail when the code they cover is mutated. This convention is a *specialization* on the layered-defense axis: when a test bypasses layer N to cover layer N+1, it does not satisfy the foundational rule for layer N. Both rules are needed.
- [`pino-spy-level-filter-ordering-trap-2026-05-07.md`](./pino-spy-level-filter-ordering-trap-2026-05-07.md) — adjacent axis on level-discipline coverage: pino spies intercept *before* pino's own level filter, so a `spy.calls` assertion does not prove the message would reach the production log sink. Together with this convention, both belong in the level-discipline canary toolkit: one addresses spy-vs-filter ordering; this one addresses layer-bypass gaps in the mutation-kill matrix.
- [`pino-spy-serializer-ordering-trap-2026-05-06.md`](./pino-spy-serializer-ordering-trap-2026-05-06.md) — sibling pino axis: spy intercepts before pino's serializers run; assertions on `mock.calls` do not verify serializer-level scrubbing. Same family as the level-filter trap.
- [`inner-catch-shadows-outer-catch-in-route-tests-2026-04-28.md`](./inner-catch-shadows-outer-catch-in-route-tests-2026-04-28.md) — structural parallel in a different domain: a lower layer in a composed try/catch silently absorbs failures meant for the upper layer; tests written against the upper layer's intended behavior pass even when the upper layer is dead. Same meta-shape: layered construction with silent coverage gaps.
- [`timing-equalization-sub-branch-oracles-2026-04-21.md`](./timing-equalization-sub-branch-oracles-2026-04-21.md) — structural parallel in the security-timing domain: a fix applied at level N silently leaves a sub-branch at level N+1 unprotected; the fix's rationale is cited as evidence the oracle is closed, which discourages future scrutiny. Same meta-lesson: when the rationale for behavior at level N+1 depends on level N being a gate, that dependency must be tested, not assumed.

## Source

Surfaced by `/ce-code-review` round-2 of `backend-canonical-walker-canary-layer-mutation-kill` on commit `c4ecfcd`, adversarial reviewer (items F4 anchor 100 + F5 anchor 75 — paired). Architect held both items as round-2 hold-fixes (commit `03d26ae`, 2026-05-07). The IS-NOT-NULL canary fix shape was specified inline in the round-2 hold block.
