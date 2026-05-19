---
title: "Grace-period idempotency records on post-broadcast routes must be written AFTER all permanent-rethrow-capable cleanup operations complete, or the retry's cached envelope silently masks the operator-actionable 502"
date: 2026-05-19
category: conventions
module: backend/src/routes
problem_type: convention
component: authentication
severity: high
applies_when:
  - Adding a grace-period idempotency record (Redis-stored cached success envelope read on retry to return the original response instead of falling through to 400) to a post-broadcast route
  - Reviewing a route that mixes a `PostBroadcastWriteError`-throwing cascade function (`seedAccreditationBonus`, future similar helpers) with a retry-visible cleanup write
  - Auditing whether a sibling 200-emitting branch on `/api/accreditation/verify` (existing-accreditation gate-hit, per-token idempotency-hit) needs the same ordering discipline before extending grace-period coverage
  - Designing a new chain-write route in `backend/src/routes/custody.ts` or `backend/src/routes/orcid.ts` that may grow a grace-period idempotency record in the future
tags:
  - post-broadcast
  - idempotency
  - grace-period
  - operator-actionable
  - cleanup-ordering
  - cascade
---

## Context

The "grace-period idempotency record" pattern — landed in `backend-verify-post-success-retry-idempotency` round-1 on `POST /api/accreditation/verify` — writes a Redis-stored cached success envelope right after a successful on-chain broadcast. A subsequent retry with the same token reads the record and returns the identical 200 envelope instead of falling through to `400 BAD_REQUEST` (the pre-task behavior after `deleteTokenBestEffort` had cleared the pending row). The pattern closes the AbortError-after-success cascade where a client retries because the original response was dropped.

The cascade has a subtle ordering interaction with OTHER post-broadcast cleanup operations on the same handler. Specifically: when one of those cleanups can throw a permanent-failure class that escapes to the user-facing 502 POST_BROADCAST_OPERATOR_REQUIRED envelope, writing the grace-period record BEFORE that cleanup runs lets the user's retry silently mask the operator-actionable signal.

Round-1 of `backend-verify-post-success-retry-idempotency` had this exact bug shape: `recordAccreditationCompletion` ran before `seedAccreditationBonus`, so a `PostBroadcastWriteError('permanent')` from a `getReputationWeights()` shape regression would 502 the original user but 200 every retry — operator never gets the signal that prompts incident response, reputation-seed drift accumulates unobserved.

## Guidance

When adding a grace-period idempotency record to a post-broadcast route, audit every cleanup operation in the handler's success path BEFORE deciding where to place the record write. For any cleanup operation that may throw a class reaching the user-facing 502 POST_BROADCAST_OPERATOR_REQUIRED envelope (currently `PostBroadcastWriteError` with severity `'permanent'`; future classes follow the same shape), the grace-period record write MUST run AFTER that cleanup completes successfully. Never before.

The corrected order on the broadcast-success path:

```ts
// 1. Broadcast succeeds; result.id is captured.

// 2. Run ALL permanent-rethrow-capable cleanups FIRST. Any throw from
//    these reaches the outer catch → 502 POST_BROADCAST_OPERATOR_REQUIRED.
//    NO retry-visible record exists yet, so retries either re-broadcast
//    (idempotent at chain layer) or hit the existing 400 fallback —
//    either way, the operator-actionable signal is preserved.
try {
  await seedAccreditationBonus(pending.hive_username);
} catch (seedErr) {
  throw new PostBroadcastWriteError(result.id, seedErr, 'reputation_seed', 'permanent');
}

// 3. Write the grace-period record AFTER all permanent-rethrow-capable
//    cleanups have succeeded. Wrap in try/catch + warn per the existing
//    helper-extraction-express5-response-ordering convention — a Redis
//    flap on this write must not propagate to Express's async-error
//    handler over the in-flight 200 envelope.
try {
  await recordAccreditationCompletionBestEffort(token, pending.hive_username, result.id, pending);
} catch (cleanupErr) {
  // best-effort warn; the broadcast already happened, so 200 still sends
  logger.warn(/* ... */);
}

// 4. Send the success envelope.
sendOk(res, { message: 'Accreditation confirmed', username, tx_id });
```

The wrong order (the round-1 bug shape):

```ts
// WRONG: grace-period record written before the permanent-rethrow-capable cleanup
try { await recordAccreditationCompletion(token, ...); } catch { logger.warn(...); }

try {
  await seedAccreditationBonus(pending.hive_username);
} catch (seedErr) {
  throw new PostBroadcastWriteError(result.id, seedErr, 'reputation_seed', 'permanent');
}

sendOk(res, ...);  // never reached if seed throws
```

Under this wrong order, a `seedAccreditationBonus` permanent failure produces:
1. Broadcast succeeds.
2. `recordAccreditationCompletion` writes the grace record + deletes the pending token.
3. `seedAccreditationBonus` throws → outer catch → user sees 502 "operator action required".
4. User retries — pending token gone, grace record exists → 200 "Accreditation confirmed".

The 502→200 inversion masks the failure entirely. Operator gets no incident signal.

## Why This Matters

`PostBroadcastWriteError` with severity `'permanent'` is the codified operator-actionable signal. It exists specifically because the next batch cycle will NOT self-heal — examples include `getReputationWeights()` shape regressions, schema drift in downstream tables, dependency-injection failures at module init. The convention `cascade-fns-rethrow-permanent-errors-2026-05-16.md` classifies WHICH errors get this severity. This convention is about WHEN the record-write happens relative to those cleanups.

The grace-period record's whole purpose is to make a retry indistinguishable from the original success. That contract is correct WHEN the original was actually fully successful — broadcast landed AND all post-broadcast cleanups completed. If a permanent-rethrow cleanup failed, the original was NOT fully successful in the user-facing sense (the 502 communicates "operator action required"); the retry must NOT silently report success. Reordering preserves the contract: the grace record is written only when the cascade fully succeeded; the retry-returns-200 promise only holds when the original-returns-200 promise was kept.

Adjacency to existing conventions but distinct from them:

- `helper-extraction-express5-response-ordering-2026-04-28.md` — covers the throw-AFTER-response-committed class (single throw, headers-sent escape). Different shape: that's about ordering between cleanup throw and response send; this is about ordering between cleanup throw and retry-visible record write.
- `chain-write-timeout-ambiguous-outcome-2026-04-22.md` — the parent idempotency convention. Names the broad ambiguous-outcome class but doesn't cover the cleanup-vs-retry ordering interaction.
- `cascade-fns-rethrow-permanent-errors-2026-05-16.md` — about WHICH errors classify as permanent (the rethrow contract). This convention is about WHEN the record-write happens given that contract.

## When to Apply

Apply when:

- Adding a grace-period idempotency record to ANY post-broadcast route. The pattern is on `/api/accreditation/verify` today; sibling routes in `backend/src/routes/custody.ts` and `backend/src/routes/orcid.ts` have AbortError-after-success exposures too and may grow grace-period records in the future.
- Adding a NEW cleanup operation to a post-broadcast handler that already has a grace-period record. Audit the new operation's throw classes; if it can rethrow a permanent class, it goes BEFORE the record write.
- Extending grace-period coverage to sibling 200-emitting branches per the `backend-verify-grace-period-sibling-branch-coverage` task (existing-accreditation gate-hit, per-token idempotency-hit branches of /verify). Apply the same ordering: record-write AFTER any permanent-rethrow-capable cleanup at those branches.

Do NOT apply (or apply differently) when:

- The cleanup operation only throws TRANSIENT errors (transient Redis blip, ioredis reconnect, transient HAF unavailability). Transient throws don't reach the 502 POST_BROADCAST_OPERATOR_REQUIRED envelope — they either get swallowed by best-effort wraps or surface as 503 retriable errors. Grace-period record ordering relative to transient-only cleanups doesn't matter.
- The route has no permanent-rethrow-capable cleanup operations at all. The convention is vacuous in that case.
- The route's success envelope IS allowed to drift between original and retry (e.g., a future route where `outcome: 'grace_period_replay'` is added as a deliberate discriminator). At that point the grace record represents "the original chain write happened" rather than "the original handler-returned-200"; ordering becomes less critical because the retry no longer claims handler-success-equivalence.

## Examples

**Canonical instance — /verify broadcast-success path:**

The round-1 bug + round-2 fix on `backend/src/routes/accreditation.ts` POST `/api/accreditation/verify` (held as item 1 of `backend-verify-post-success-retry-idempotency` round-2 hold-block).

**Future audit candidates:**

- `backend/src/routes/custody.ts` POST `/api/custody/broadcast` — if a grace-period idempotency record is added for non-consent or consent-op AbortError-after-success retries, apply this convention against any `seedAccreditationBonus`-shaped cascade calls on the success path.
- `backend/src/routes/orcid.ts` POST `/api/orcid/callback` — if `handleAccredit` / `handleLink` grow grace-period records, audit the post-broadcast cascade for permanent-rethrow operations and order the record write accordingly.

**Cross-reference to sibling-branch coverage task:**

The `backend-verify-grace-period-sibling-branch-coverage` task (filed 2026-05-19 during cluster-B triage) extends the grace-period record to two sibling 200-emitting branches of /verify (existing-accreditation gate-hit, per-token idempotency-hit). At those branches, the cleanup surface is different — `deleteTokenBestEffort` is best-effort and transient-only; the per-token idempotency check is read-only — so the convention's ordering rule is satisfied trivially on those branches. But the cluster-B implementer must verify this empirically when landing the task: re-audit every cleanup operation on the gate-hit and idempotency-hit branches against the permanent-rethrow classifier in `cascade-fns-rethrow-permanent-errors-2026-05-16.md` before placing the record write.

## References

- `backend/src/routes/accreditation.ts` — `POST /api/accreditation/verify` broadcast-success path; round-2 hold fixes the ordering.
- `agents/docs/solutions/conventions/helper-extraction-express5-response-ordering-2026-04-28.md` — adjacent cleanup-ordering convention.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — parent idempotency convention.
- `agents/docs/solutions/conventions/cascade-fns-rethrow-permanent-errors-2026-05-16.md` — the permanent-rethrow classifier.
- `agents/docs/tasks/pending/backend-verify-post-success-retry-idempotency.md` — round-2 hold item 1, the architect-prescribed reorder fix for the canonical instance.
- `agents/docs/tasks/pending/backend-verify-grace-period-sibling-branch-coverage.md` — sibling-branch coverage extension task; this convention applies to its planned changes.
