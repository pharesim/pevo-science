# BE-BROADCAST-SENDOPERATIONS-WRAP — Extend broadcast-abort-timeout coverage to broadcast.sendOperations call sites

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ORCID-BROADCAST-ABORT-TIMEOUT first-review)
**Priority:** P2

## Context

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` wrapped every `hiveClient.broadcast.json` call via `broadcastJsonWithTimeout`. The helper's acceptance criterion was "grep `hiveClient.broadcast.json` outside the helper returns zero matches" — which is satisfied.

But the helper doesn't cover `hiveClient.broadcast.sendOperations`, which has identical no-timeout behavior (dhive's `Client.timeout` applies only to reads). 5 call sites in the backend use `sendOperations`:

- `backend/src/account-creation.ts`
- `backend/src/routes/anonymousReview.ts`
- `backend/src/routes/bridge.ts`
- `backend/src/routes/custody.ts`
- (5th site per review)

Each can hang indefinitely against a slow Hive node, leaving the same class of execution-stomp and request-holding risk that `broadcast.json` had pre-helper.

F4.8, maintainability residual. See `.context/compound-engineering/ce-code-review/aggregated/04-backend-orcid-broadcast-abort-timeout.md` § F4.8.

## Goal

Extend `broadcastJsonWithTimeout` (or add a sibling `broadcastSendOperationsWithTimeout`) so every `sendOperations` call has a 30s wall-clock abort, matching the `broadcast.json` invariant.

Two shapes:

- **A. Single helper, operation-type agnostic.** Refactor `broadcastJsonWithTimeout` into `broadcastWithTimeout(op, ...)` that accepts either `broadcast.json` or `broadcast.sendOperations`. Single source of truth; 5 call sites migrate.

- **B. Second helper (`broadcastSendOperationsWithTimeout`).** Mirror of the existing helper. Clearer intent per primitive; slight code duplication.

## Non-goals

- Changing dhive version or adding custom transport code.
- Coordinating with `BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING` (that task handles ambiguous-outcome; this one just makes sure the timer fires at all).

## Acceptance

- Grep `hiveClient.broadcast.sendOperations` outside the helper returns zero matches.
- Test per helper covering happy path, timeout, error propagation (mirror the existing `hive-broadcast-timeout.test.ts` shape).
- `BroadcastTimeoutError` is thrown on timeout for both primitives (consistent class).

## [TODO Architect]

- Lean: Option A (single helper). The `broadcast.json` and `broadcast.sendOperations` return types overlap enough that a single generic helper is cleaner.
