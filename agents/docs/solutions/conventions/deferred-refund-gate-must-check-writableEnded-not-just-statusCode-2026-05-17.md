---
title: "Deferred refund/cleanup handler on `res` must gate on `res.writableEnded`, not just `res.statusCode`"
date: 2026-05-17
module: backend/src/middleware
problem_type: convention
component: middleware
severity: high
applies_when:
  - "Writing a deferred refund/cleanup handler on an `http.ServerResponse` (Express, Fastify, raw Node)"
  - "The handler registers on `res.on('finish', ...)` and/or `res.on('close', ...)`"
  - "The gate condition decides refund vs no-refund based on `res.statusCode`"
  - "The handler's body can `await` something (DB query, RPC, network) before setting status"
tags:
  - rate-limit
  - refund-on-disconnect
  - tcp-abort
  - http-response-lifecycle
  - writableEnded
  - skip-failed-requests
related_components:
  - rate_limiting
  - middleware
---

# Deferred refund/cleanup handler must gate on `res.writableEnded`, not just `res.statusCode`

A common pattern: a middleware consumes some resource (a rate-limit slot, a connection from a pool, a lock) and registers a deferred callback on `res` to release it when the response finishes. To distinguish "release on failure" from "keep consumed on success" the gate often reads `res.statusCode < 400`.

This is **incomplete** if the handler can abort before setting status.

## Context

The dual-listener pattern looks like this:

```ts
let refunded = false;
const refund = () => {
  if (refunded || res.statusCode < 400) return;
  refunded = true;
  void redis.decr(redisKey).catch(...);
};
res.on('finish', refund);
res.on('close', refund);
```

The intent: `'finish'` fires on a clean response; `'close'` fires on abrupt disconnect (TCP abort, mobile drop, client-side fetch cancel). The once-guard prevents double-refund. Registering on both events looks like it covers all paths.

**It doesn't.** `res.statusCode` defaults to `200` in Node.js and is only updated when the handler calls `res.status()`, `res.sendStatus()`, `sendError()`, or equivalent. If the client aborts BEFORE the handler reaches the status-setting line — typically during an `await pool.query(...)` or `await externalRpc(...)` — `'close'` fires with `statusCode` still at the default `200`. The gate's `res.statusCode < 400` check returns early, refund is skipped, the consumed resource stays consumed for its natural lifetime.

## Guidance

Gate on both `statusCode` AND `writableEnded`:

```ts
let refunded = false;
const refund = () => {
  if (refunded) return;
  refunded = true;
  // Refund if handler errored OR connection aborted before response completed
  if (res.statusCode < 400 && res.writableEnded) return;
  void redis.decr(redisKey).catch(...);
};
res.on('finish', refund);
res.on('close', refund);
```

`res.writableEnded` is `true` after `res.end()` completes (the moment that fires `'finish'`). On an abrupt `'close'` with no prior `res.end()`, it stays `false`. The combined gate now reads:

| `statusCode` | `writableEnded` | Refund? | Scenario |
|--------------|-----------------|---------|----------|
| `< 400`      | `true`          | **No**  | clean 2xx/3xx response — keep slot consumed |
| `< 400`      | `false`         | **Yes** | abort before handler set status — refund |
| `>= 400`     | `true`          | **Yes** | handler errored and responded — refund |
| `>= 400`     | `false`         | **Yes** | handler errored mid-response then aborted — refund |

Order the `refunded = true` assignment **before** any `await` to keep the once-guard idempotency-safe under concurrent event delivery (see `synchronous-flag-before-await-idempotency-guard-2026-05-16.md`).

## Why This Matters

For PEvO's `/api/custody/upgrade` route — account-keyed, max=1 per hour, `skipFailedRequests: true` — a single TCP-abort during the handler's `await pool.query(...)` or `await hiveClient.database.getAccounts(...)` would consume the user's only slot for the full 1-hour window. That is the exact "legitimate-user-lockout DoS" the option exists to prevent: a stolen-JWT attacker aborting requests mid-stream can lock the legitimate user out indefinitely (one abort per hour), without ever attempting the credential check.

The dual-listener pattern catches the **handler-completed-with-4xx-then-abort** sub-case (`'finish'` would have fired anyway just before `'close'`). It misses the **abort-during-await** sub-case, which is the canonical exposure window. The gate semantics — not the listener registration — are the load-bearing piece.

## When to Apply

This applies to every deferred handler on an HTTP response that:

1. Has a runtime gate deciding "do something" vs "skip" based on response state.
2. Is registered on `res.on('finish')` and/or `res.on('close')`.
3. Sits behind a handler that does any awaited work before calling `res.status()` / `sendError()` / equivalent.

Concrete PEvO surfaces today: the `skipFailedRequests` refund path in `backend/src/middleware/rateLimit.ts`. Any future similar pattern (connection-pool release, distributed lock release, audit-log finalization) should adopt the same gate shape.

The same `writableEnded` discriminator works for the inverse — gating "do something on clean completion only" should check `writableEnded === true`, not `statusCode < 400` alone.

## Examples

**Before — incomplete:**

```ts
// backend/src/middleware/rateLimit.ts (round-4 commit 62066cb)
let refunded = false;
const refund = () => {
  if (refunded || res.statusCode < 400) return;
  refunded = true;
  void redis.decr(redisKey).catch(...);
};
res.on('finish', refund);
res.on('close', refund);
```

This was the round-4 commit's attempt at closing the P0 hold ("`res.on('close')` not handled"). The dual-listener fix was correct in shape but the gate carried over verbatim, and the gate's `statusCode < 400` check skips refund on abort-during-await (where `statusCode` stays at the default 200). Cross-reviewer corroboration (correctness × security × adversarial at anchor ≥75) caught the regression at round-4 architect re-review.

**After — complete:**

```ts
let refunded = false;
const refund = () => {
  if (refunded) return;
  refunded = true;
  if (res.statusCode < 400 && res.writableEnded) return;
  void redis.decr(redisKey).catch(...);
};
res.on('finish', refund);
res.on('close', refund);
```

## Test the abort case

The regression-kill test must exercise abort-before-status, not just handler-error-then-abort. A test that calls `req.destroy()` or `res.socket.destroy()` mid-handler (during a pending `await`) and asserts the slot is refunded would catch the gate omission. The PEvO `backend/tests/middleware/rateLimit.test.ts` Redis-path fixture provides the scaffold; the new test needs to register a handler that awaits something cancellable, abort during that await, and assert the post-abort INCR count reflects the refund.

## Cross-references

- `agents/docs/solutions/conventions/synchronous-flag-before-await-idempotency-guard-2026-05-16.md` — companion rule for the once-guard flag itself (set before any `await`)
- `agents/docs/solutions/conventions/skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md` — when `skipFailedRequests` is appropriate to adopt; this rule applies to every adopter

Surfaced in: `backend-custody-upgrade-seed-phrase-reauth` round-3 → round-4 hold (commit `62066cb`, hold filed at `21457d8`). Round-4 hold item 1, cross-corroborated correctness × security × adversarial.
