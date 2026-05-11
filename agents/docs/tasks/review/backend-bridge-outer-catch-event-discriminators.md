# BACKEND-BRIDGE-OUTER-CATCH-EVENT-DISCRIMINATORS — Add `event:` discriminators to 7 outer-catch logger.error sites in `bridge.ts`

**Owner:** backend
**Created:** 2026-05-11 (surfaced by `backend-bridge-custody-broadcast-discrimination` round-2 review, api-contract reviewer AC-2 anchor 75; pre-existing pattern that round-2's custody change made visible)
**Priority:** P2

## Context

Round-2 of `backend-bridge-custody-broadcast-discrimination` added `event: 'custody.broadcast.internal_error'` to `custody.ts`'s outer-catch logger.error call — a clear dashboard-filter key for operators investigating non-broadcast errors (decryptKey throw, pool.query throw, PrivateKey.fromString throw). Without an `event:` field, dashboards filtering on event for both `bridge.*` and `custody.*` surfaces see custody outer-catch events but not bridge outer-catch events.

`backend/src/routes/bridge.ts` has 7 `logger.error` call sites in outer-catch positions that emit no `event:` field. They predate this task's filing — this is not a regression introduced by the custody discrimination work, just a pre-existing asymmetry the custody task made visible.

## Acceptance

1. Identify the 7 outer-catch `logger.error` sites in `backend/src/routes/bridge.ts`. Use `grep -n 'logger.error' backend/src/routes/bridge.ts` and filter for catch-block emissions.

2. Add `event:` discriminators to each site following the convention established by `custody.broadcast.internal_error`:
   - `event: 'bridge.register.internal_error'` for outer-catch in /register handler.
   - `event: 'bridge.check.internal_error'` for outer-catch in /check handler.
   - Other site-specific names following the pattern `bridge.<sub-route>.<failure-class>`.

3. The `event:` field MUST appear AFTER the spread of any context object so the helper-set value wins per the spread-after-literal convention (see `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md`). Plain object-literal log calls already have this property — verify no regression.

4. The `route:` field convention: if the function is called from multiple routes (like `checkExistingBridge` flagged in `backend-bridge-write-haf-lag-and-retry-amplification` round-2 hold item 4), thread a `callerLabel` parameter or move the log emission to each call site. For one-call-site catches, hardcode `route: 'bridge.<sub-route>'`.

5. Update existing operator dashboards / alert rules that key on bridge log shapes — out of scope for this task (the dashboards are not in-repo). File a coordination note as a deployment-side action if any keying changes are noticed during landing.

## Tests

For each touched logger.error site, add or update a unit test that asserts the `event:` field is present in the call args. Pattern (matches the round-2 custody specs):

```ts
const matchingCall = errorSpy.mock.calls.find(call => {
  const ctx = call[0] as Record<string, unknown> | undefined;
  return ctx?.event === 'bridge.<sub-route>.internal_error';
});
expect(matchingCall).toBeDefined();
```

Avoid the circular-assertion trap (see `backend-bridge-custody-broadcast-discrimination` round-2 hold item 4): `find` by event, then assert OTHER fields (route, op_count, identifier where applicable), NOT `.not.toBe(<other-event>)` on the already-filtered call.

## Coordination

- Cross-references the api-contract AC-2 finding from `backend-bridge-custody-broadcast-discrimination` round-2 review.
- Companion to `backend-bridge-write-haf-lag-and-retry-amplification` round-2 hold item 4 (which adds `callerLabel` threading for `checkExistingBridge`). When that hold lands, this task picks up the route-label convention from it.
- Do NOT touch `agents/docs/api-contracts/bridge.md` — `event:` is operator-log surface, not API contract surface (per task #3's api-contract reviewer note). Architect-zone if a convention doc on the `event:` enum becomes necessary later.

## Out of scope

- Adding `event:` discriminators to log calls outside `bridge.ts`. Other routes that emit untagged log lines are out of scope for this task; file a separate sweep task if a project-wide audit becomes warranted.
- Documenting the `event:` enum as a stable contract. Today the names are operator-internal; a future task can `/ce-compound` the convention if it stabilizes.

## Priority rationale

P2 because the asymmetry was the api-contract reviewer's mid-anchor finding (75) and not a load-bearing fix. Operators can still filter bridge events by `route:`, but the missing `event:` field means cross-surface dashboards (custody + bridge) can't share filter shapes.
