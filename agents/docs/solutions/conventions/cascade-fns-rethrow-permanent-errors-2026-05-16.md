---
title: Cascade functions called from post-broadcast catch sites must filter throws and only re-throw permanent-class errors
date: 2026-05-16
category: conventions
module: backend/src/lib + backend/src/routes
problem_type: convention
component: error_handling
severity: medium
applies_when:
  - Writing a cascade function called from a try/catch wrap in a post-broadcast route handler (canonical examples - `cacheOrcidBinding`, `updateAccountOrcid`, `seedAccreditationBonus`)
  - Adding a new failure-mode throw inside any function whose errors flow into `classifyPostBroadcastSeverity`
  - Reviewing a `PostBroadcastWriteError` construction site where the discriminator's correctness depends on the cascade-fn's throw discipline
  - Adding a new sentinel error class to `backend/src/lib/broadcast-error.ts`
tags: [error-classification, post-broadcast, cascade, severity-discrimination, broadcast-error, orcid, accreditation]
---

# Cascade functions called from post-broadcast catch sites must filter throws and only re-throw permanent-class errors

## Context

PEvO discriminates post-broadcast cascade errors via `PostBroadcastWriteError.severity: 'transient' | 'permanent'`. The discriminator routes:

- `'permanent'` → HTTP 502 `POST_BROADCAST_OPERATOR_REQUIRED` ("please contact support")
- `'transient'` → HTTP 502 `POST_BROADCAST_FAILED` ("will reconcile automatically")

The `classifyPostBroadcastSeverity` helper at `backend/src/lib/broadcast-error.ts` distills the discriminator from the error class: `TypeError | SyntaxError | RangeError | AppPoolNotInitialisedError` → `'permanent'`; PostgreSQL error codes matching `23xxx` (integrity constraint) or `42xxx` (syntax/access) → `'permanent'`; everything else → `'transient'` (default fallback).

The helper is the single source of truth for the discrimination, but its correctness is conditional on the cascade-fn rethrow discipline: if a cascade function re-throws a bare `Error` for a permanent failure mode, the helper sees no `instanceof` match and no PG `.code`, falls through to `'transient'`, and the user sees the misleading "will reconcile automatically" copy for a non-reconcilable failure.

## Guidance

Cascade functions called from post-broadcast catch sites MUST filter their throws and only re-throw permanent-class errors. Transient errors should be caught internally and handled by one of:

- **Retry** with bounded backoff (when the cascade can self-recover)
- **Swallow with operator log** (when the cascade is best-effort and the post-broadcast write doesn't need the cascade result)
- **Convert to a known-transient signal** that the classifier recognizes (e.g., a generic `Error` instance with no `.code`)

When throwing a permanent-class error, prefer one of these shapes:

1. **Built-in programming errors** (`TypeError`, `SyntaxError`, `RangeError`) - already recognized by the classifier.
2. **PostgreSQL errors with `.code`** - pass through; the classifier reads `.code` for `23xxx`/`42xxx` patterns.
3. **Named sentinel error class** - for permanent failure modes that don't fit (1) or (2). Add the class to `backend/src/lib/broadcast-error.ts` AND extend `classifyPostBroadcastSeverity`'s `'permanent'` union to include it. The `AppPoolNotInitialisedError` class is the canonical example (added 2026-05-16; pre-pool guard inside `updateAccountOrcid`).

## Why This Matters

The classifier-default-to-transient design assumes the classifier sees a permanent class whenever the cascade fails permanently. The 2026-05-16 incident that prompted this convention: `updateAccountOrcid`'s pre-pool guard threw `new Error('App pool not initialised - accounts.orcid update unavailable')`. No `instanceof TypeError`/`SyntaxError`/`RangeError` match; no `.code`. Classifier returned `'transient'`. Route emitted 502 `POST_BROADCAST_FAILED` with "will reconcile automatically" copy. No reconciler exists for a missing app pool. User was promised self-recovery that would never happen.

Fix path: add `AppPoolNotInitialisedError extends Error` sentinel, replace bare throw with sentinel, extend classifier's `'permanent'` union. The route now emits 502 `POST_BROADCAST_OPERATOR_REQUIRED` with the "please contact support" copy. End-to-end honest UX.

The structural class of failure repeats whenever a future cascade-fn introduces a new permanent failure mode without classifier wiring. The discipline:

1. Classify failure modes inside cascade fns explicitly (transient → handle locally; permanent → throw class-recognized error).
2. When a new permanent class is needed, extend the classifier in the SAME commit. Don't ship the throw without the classifier wiring.
3. Add a unit-test pin to `backend/tests/lib/broadcast-error.test.ts` for any new class added to the `'permanent'` union.

## When to Apply

- Writing a new cascade function called from a post-broadcast route handler.
- Adding a new failure-mode throw to an existing cascade function - verify the thrown class is in the classifier's `'permanent'` union (or document explicitly that the throw is transient-class).
- Code-reviewing a `PostBroadcastWriteError` construction site - verify each upstream throw path produces a class the classifier recognizes correctly.
- Adding a new sentinel error class to `broadcast-error.ts` - the class addition must include classifier wiring + unit test in the same commit.

## Examples

**Bad - bare `Error` for a permanent failure mode** (the incident pattern, pre-fix `updateAccountOrcid` pre-pool guard):

```ts
const pool = getAppPool();
if (!pool) {
  throw new Error('App pool not initialised. accounts.orcid update unavailable');
}
```

The classifier sees no `instanceof` match, no `.code`, defaults to `'transient'`. Wire-shape regression: user sees "will reconcile" for a state that has no reconciler.

**Good - named sentinel + classifier wiring + unit test** (the round-2 fix):

```ts
// backend/src/lib/broadcast-error.ts
export class AppPoolNotInitialisedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppPoolNotInitialisedError';
  }
}

export function classifyPostBroadcastSeverity(err: unknown): 'transient' | 'permanent' {
  if (
    err instanceof TypeError ||
    err instanceof SyntaxError ||
    err instanceof RangeError ||
    err instanceof AppPoolNotInitialisedError
  ) {
    return 'permanent';
  }
  // ... PG .code checks ...
  return 'transient';
}

// backend/src/routes/orcid.ts (updateAccountOrcid pre-pool guard)
const pool = getAppPool();
if (!pool) {
  throw new AppPoolNotInitialisedError('App pool not initialised. accounts.orcid update unavailable');
}

// backend/tests/lib/broadcast-error.test.ts
it('returns "permanent" for AppPoolNotInitialisedError (pre-pool sentinel)', () => {
  expect(
    classifyPostBroadcastSeverity(new AppPoolNotInitialisedError('App pool not initialised.')),
  ).toBe('permanent');
});
```

Three-part discipline: class, wiring, test. Skipping any leaves the regression class live.

## Related

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` - sibling convention covering broadcast retry semantics. Its "Caveat - discrimination is only as live as the cascade fns" clause is the partial coverage this convention extends to first-class status.
- `agents/docs/solutions/conventions/worktree-fanout-orphan-detection-2026-04-29.md` - the convention used at archive intake for the task that prompted this convention's filing.
- `backend/src/lib/broadcast-error.ts` `classifyPostBroadcastSeverity` - authoritative implementation. New sentinel classes added to the `'permanent'` union live here.
- `backend/src/routes/orcid.ts` `isPermanentDbError` and related PG-error helpers - the PG-code branch of the classifier's `'permanent'` union.
- Production docblocks that previously cited the missing slug `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS` should be updated to reference this convention by path when they next see edits.
