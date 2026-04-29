# BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS — Make `PostBroadcastWriteError` discrimination reachable on real cascade failures

**Owner:** backend
**Created:** 2026-04-29 (architect, follow-on to BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION round-2 archive triage)
**Priority:** P2
**Source:** `agents/docs/tasks/review/backend-orcid-broadcast-outcome-discrimination.md` round-1 hold item #5 (architect-flagged `[TODO Architect]`); architect decision recorded 2026-04-29 in cluster archive triage.

## Problem

The `PostBroadcastWriteError` discrimination machinery in `backend/src/lib/broadcast-error.ts` produces a documented 502 POST_BROADCAST_FAILED envelope (`details.failed_step`, `details.outcome:'confirmed'`, `details.tx_id`, per-step user-facing message). The contract is documented in `agents/docs/api-contracts/orcid.md` and the per-step recovery semantics. The frontend treats it as success-with-stale-cache.

But the machinery is **dead-defensive on live paths today** because all three cascade fns swallow async errors internally:

| Cascade fn | File:line | Behavior on error | Auto-reconcile path? |
|---|---|---|---|
| `cacheOrcidBinding` | `backend/src/routes/orcid.ts:1085-1109` | try/catch + `logger.warn`; returns success | yes — next request repopulates cache from HAF |
| `updateAccountOrcid` | `backend/src/routes/orcid.ts:1258-1269` | try/catch + `logger.error`; returns success | **no** — denormalized projection; missed write requires manual operator re-run (HAF-replay job not implemented) |
| `seedAccreditationBonus` | `backend/src/lib/reputation.ts:136-142` | try/catch + `logger.error`; returns success | partial — next batch cycle re-derives from chain state |

The result: a real Redis flap or PG pool exhaustion during the post-broadcast cascade produces 200 OK to the user AND only a generic per-fn `logger.warn`/`logger.error` to operators. There is no contract envelope, no `event:`-tagged operator anchor, no dashboard-keyable signal that an `account_update` cascade failed. For `updateAccountOrcid` specifically — where there's no auto-reconcile — the user's denormalized `accounts.orcid` column may be permanently stale until manual re-run, and operators have no documented path to detect this.

The integration test at `backend/tests/routes/orcid.test.ts` proves the discrimination is wired (via `__test_seams.updateAccountOrcid.mockRejectedValueOnce(...)`), but that's the ONLY currently-reachable trigger.

## Goal

Rewire `updateAccountOrcid` and `seedAccreditationBonus` to re-throw on **permanent / operator-actionable** errors so the `PostBroadcastWriteError` discrimination produces real 502 POST_BROADCAST_FAILED envelopes on real failure modes. Leave `cacheOrcidBinding` swallowing — its lazy-repopulate is the right behavior.

The wire envelope is already documented; this task ships the production trigger for it.

## Scope

### `updateAccountOrcid` (`backend/src/routes/orcid.ts:1258-1269`)

Distinguish transient vs permanent errors. Re-throw on permanent. Examples of permanent / operator-actionable:
- `getAppPool() === null` (pool not initialised) — already throws synchronously today; flagged as residual_risk by reliability reviewer
- Pool exhaustion that doesn't recover within a bounded retry budget
- Schema/constraint errors (column missing, FK violation) — typically a deploy regression

Transient (keep swallowing or retry-then-swallow):
- Single connection drop during a healthy pool — retryable; if exceeded retry budget then re-throw
- pg-ish "could not serialize access due to concurrent update" — retryable

The wrapper at the orcid.ts cascade catch will surface re-thrown errors as `new PostBroadcastWriteError(txId, cause, 'account_update')`.

### `seedAccreditationBonus` (`backend/src/lib/reputation.ts:136-142`)

Same pattern. Permanent errors (Redis fully unreachable for a sustained window OR HAF-derived inputs are malformed) re-throw. Transient errors stay swallowed (next batch cycle re-derives anyway).

The route wrapper produces `new PostBroadcastWriteError(txId, cause, 'reputation_seed')`.

### `cacheOrcidBinding` (out of scope)

Keeps swallowing. Cache miss → next request repopulates from HAF. Adding re-throw here would force the user to see "backend write failed" for what is genuinely zero user impact.

### Sibling sites NOT in this scope

- `signup-verify.ts:295/:404` (reliability reviewer flagged a half-rolled-out variant of this pattern). Different task family — file separately if/when it surfaces. This task does NOT touch signup-verify.

## Operator-alert anchor

When `updateAccountOrcid` or `seedAccreditationBonus` re-throws and the route's wrapper produces `PostBroadcastWriteError`, `handleBroadcastError`'s 4th log-suffix anchor (`<routeLabel> broadcast confirmed but post-broadcast write failed`) fires at error level. That anchor is already operator-facing. Verify it carries enough forensic context (`txId`, `failedStep`, `orcidId` or equivalent) to be useful for an oncall debugging which step failed.

If the existing anchor is insufficient, add a structured `event:` field per PEvO convention (e.g., `event: 'post_broadcast_write_failed'`).

## Tests

- New integration spec exercising `updateAccountOrcid` permanent-error path: stub the function (or its underlying pool call) to reject with a non-transient error class; assert 502 POST_BROADCAST_FAILED with `details.failed_step:'account_update'` envelope.
- New integration spec for `seedAccreditationBonus` permanent-error path (or unit-layer if integration is impractical — file the carve-out per CLAUDE.md test-mocking carve-out).
- Verify the existing pre-`d8b9b75` test seams (`__test_seams.updateAccountOrcid`) still work, since this task may change the implementation but the seam contract should hold.
- Mutation-kill: deleting the re-throw should cause the new specs to fail (route swallows again → 200 OK → spec asserting 502 fails).

## Acceptance

- `updateAccountOrcid` re-throws on permanent / operator-actionable errors.
- `seedAccreditationBonus` re-throws on permanent / operator-actionable errors.
- `cacheOrcidBinding` is unchanged.
- New specs exercise the re-thrown paths and assert the 502 POST_BROADCAST_FAILED envelope shape.
- Operator-alert anchor carries forensic fields (txId, failedStep, route-correlation).
- Existing 54-passed test suite still passes.

## Coordination

- The task is independent of the orcid cluster archive. Architect can archive the orcid cluster review without this task landing first.
- Related: backlog item `backend-sendoperations-outcome-handling-sweep.md` may want to adopt the same pattern for other broadcast routes (bridge/custody/papers/claims). Out of scope here; coordinate when/if that task is filed.

## Source

- `agents/docs/tasks/review/backend-orcid-broadcast-outcome-discrimination.md` round-1 hold item #5 + round-2 signal `[TODO Architect]` block (line 358).
- Architect decision recorded in cluster archive triage 2026-04-29: option (B-narrow) — rewire `updateAccountOrcid` + `seedAccreditationBonus`, leave `cacheOrcidBinding`.
- `agents/docs/api-contracts/orcid.md` POST_BROADCAST_FAILED entry (already documents the envelope shape and per-step recovery semantics).
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` (post-broadcast write failure section).
