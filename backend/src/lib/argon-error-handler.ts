// Centralized catch handler for argon2-semaphore errors thrown from a
// `runWithArgon2Slot` call inside a route handler. Replaces the 3-way
// `instanceof` chain that was previously inlined (and quietly drifted)
// across auth.ts, custody.ts, settings.ts, signup-verify.ts.
//
// The three semaphore error classes map onto two HTTP outcomes:
//
//   ArgonQueueFullError → 503 SERVICE_UNAVAILABLE  (transient saturation)
//   ShuttingDownError   → 503 SERVICE_UNAVAILABLE  (terminal — SIGTERM drain)
//   ArgonAbortError     → silent return            (client already disconnected)
//
// Distinct log lines so operators can separate "increase capacity"
// (ArgonQueueFullError spikes under load) from "benign during rolling
// restart" (ShuttingDownError during SIGTERM drain) from "client gone"
// (ArgonAbortError, debug-only). All three flow through one place so a
// future fourth error class is enforced by the `ArgonSemaphoreError` base
// (the type system flags any concrete subclass not handled in the switch
// below).
//
// ── Return-shape footgun discussion ─────────────────────────────────────
//
// The previous inlined helper returned `boolean` and the call sites used
// `if (handleArgonQueueFull(res, err)) return;`. That shape has a known
// footgun: a caller that omits `return` falls through to the generic 500
// branch and double-responds (500 written after the helper already wrote
// the 503). No test catches this, the type system is silent.
//
// We could fix this with a void-returning "throw if not handled" shape, but
// every existing caller already wraps the call in try/catch (the catch is
// where this helper runs), so re-throwing inside it would force every site
// to add an outer try/catch — strictly more boilerplate.
//
// Chosen shape: return a string-literal sentinel `'handled' | 'unhandled'`,
// matching the convention already established by `handleBroadcastError`
// (which returns `'timeout' | 'failure'`). The call site becomes
//
//   if (handleArgonError(res, err, opts) === 'handled') return;
//
// which is harder to typo than `if (helper(res, err))` and self-documents
// what the boolean would have meant. Forgetting the `=== 'handled'` produces
// `if ('unhandled') return;` which is a truthy short-circuit, BUT static
// analysis (eslint, tsc with `--noUncheckedIndexedAccess`) flags the
// implicit truthy-on-string. The string-literal type also lets a future
// caller pattern-match on the discriminated outcome if we add a third
// classification.
//
// ── Generic 503 client message ──────────────────────────────────────────
//
// The two 503 branches share a single client-facing body string,
// `SERVICE_UNAVAILABLE_MESSAGE`. Earlier wording ("Authentication service
// temporarily overloaded.", "Service shutting down.") leaked argon2 as the
// chokepoint and let an attacker distinguish saturation from drain — minor
// reconnaissance that the SERVICE_UNAVAILABLE error code already conveys
// more cleanly. Operators still get the distinct branch via the
// `logger.warn` (queue-full) vs `logger.info` (shutdown) call below; only
// the wire body is genericized. See `backend-503-message-genericize.md`.
//
// ── Retry-After header on 503 responses ─────────────────────────────────
//
// Both 503 branches set `Retry-After` from per-branch defaults
// (`QUEUE_FULL_RETRY_AFTER_SEC` / `SHUTDOWN_RETRY_AFTER_SEC`). The defaults
// live on the helper, not the call sites — every route that runs an argon2
// op should emit the same retry window for the same condition; pushing the
// number to call sites would re-introduce the drift this consolidation was
// meant to kill. `HandleArgonErrorOpts.retryAfterSec` is an optional
// per-call override; when set it wins over the defaults for both branches.
// `ArgonAbortError` gets no header (the socket is gone — there is no
// header to send). See `backend-503-retry-after.md`.

import type { Response } from 'express';
import { sendError } from '../response.js';
import { logger } from '../logger.js';
import {
  ArgonQueueFullError,
  ShuttingDownError,
  ArgonAbortError,
  ArgonSemaphoreError,
} from './argon2-semaphore.js';

/**
 * Discriminated outcome of {@link handleArgonError}. Caller MUST early-return
 * on `'handled'` to avoid falling through to a generic 500 branch that
 * would write a second response onto the same socket. `'unhandled'` means
 * the helper recognized none of the three argon semaphore error classes
 * and the caller should run its normal error path (typically a `logger.error`
 * + `sendError(res, 500, 'INTERNAL_ERROR', ...)`).
 */
export type HandleArgonErrorResult = 'handled' | 'unhandled';

/**
 * Generic client-facing body string used on both 503 branches. Operators
 * still see distinct log lines (`logger.warn` for queue-full, `logger.info`
 * for shutdown); only the wire body is genericized. Exported so route-level
 * tests can assert against the canonical string instead of a hand-copied
 * literal.
 */
export const SERVICE_UNAVAILABLE_MESSAGE = 'Service temporarily unavailable. Please retry.';

/**
 * Default `Retry-After` (seconds) for the queue-full branch. Queue typically
 * drains in ~625ms at full depth × the configured argon2 cap, but 5s gives
 * clients a safe window without thundering-herd retry on the next instance
 * during a rolling deploy.
 */
export const QUEUE_FULL_RETRY_AFTER_SEC = 5;

/**
 * Default `Retry-After` (seconds) for the shutdown branch. Matches the
 * `server.close()` force-timeout used by the SIGTERM drain path so the
 * client comes back after the rolling deploy has likely cut over.
 */
export const SHUTDOWN_RETRY_AFTER_SEC = 30;

/**
 * Optional per-call context.
 *
 * `logContext` is merged into the structured log record on the two 503
 * branches and the debug-level disconnect log; it lets routes propagate
 * identifiers (e.g. `username`) into the log line without each route
 * re-implementing the catch chain.
 *
 * `retryAfterSec` is an optional per-call override for the `Retry-After`
 * header on the two 503 branches. When unset (the common case) the helper
 * uses the per-branch defaults: {@link QUEUE_FULL_RETRY_AFTER_SEC} for
 * `ArgonQueueFullError` and {@link SHUTDOWN_RETRY_AFTER_SEC} for
 * `ShuttingDownError`. The override applies to whichever branch fires; it
 * is not branch-specific because no current call site needs to override
 * one branch but not the other. `ArgonAbortError` ignores it (no response
 * to write).
 */
export interface HandleArgonErrorOpts {
  /** Structured-log context merged into the helper's log calls. */
  logContext?: Record<string, unknown>;
  /**
   * Override for the `Retry-After` header (seconds) on the two 503 branches.
   * Defaults to {@link QUEUE_FULL_RETRY_AFTER_SEC} / {@link SHUTDOWN_RETRY_AFTER_SEC}
   * when unset.
   */
  retryAfterSec?: number;
}

/**
 * Translate an argon2 semaphore error into the matching HTTP response and
 * log line. Returns `'handled'` if the error was recognized and the
 * response was written; `'unhandled'` if the caller should fall through to
 * its own generic-error branch.
 *
 * Intended call shape:
 *
 * ```ts
 * } catch (err) {
 *   if (handleArgonError(res, err, { logContext: { username } }) === 'handled') return;
 *   logger.error({ err }, 'Some operation failed');
 *   sendError(res, 500, 'INTERNAL_ERROR', 'Some operation failed');
 * }
 * ```
 *
 * The `=== 'handled'` comparison closes the boolean-return footgun: a
 * caller that forgot to compare would still trigger the truthy short-
 * circuit (because `'unhandled'` is also truthy), but the explicit string
 * comparison is far harder to omit by accident than a bare `if (fn())`.
 *
 * NOTE on `ArgonAbortError`: returns `'handled'` WITHOUT writing a
 * response. The client socket is already torn down; writing into it would
 * surface as an EPIPE in the global error handler. Caller MUST early-
 * return on `'handled'` to avoid the generic 500 branch attempting a write.
 */
export function handleArgonError(
  res: Response,
  err: unknown,
  opts: HandleArgonErrorOpts = {},
): HandleArgonErrorResult {
  // Fast-path: if the error isn't a semaphore error at all, don't pay the
  // cost of three more instanceof checks. The base class is the only
  // discriminator; the three subclasses are exhaustive (enforced by the
  // `abstract` keyword on `ArgonSemaphoreError`).
  if (!(err instanceof ArgonSemaphoreError)) {
    return 'unhandled';
  }

  const ctx = opts.logContext ?? {};

  if (err instanceof ArgonQueueFullError) {
    logger.warn({ err, ...ctx }, 'argon2 queue saturated — returning 503');
    res.set('Retry-After', String(opts.retryAfterSec ?? QUEUE_FULL_RETRY_AFTER_SEC));
    sendError(res, 503, 'SERVICE_UNAVAILABLE', SERVICE_UNAVAILABLE_MESSAGE);
    return 'handled';
  }
  if (err instanceof ShuttingDownError) {
    logger.info({ err, ...ctx }, 'argon2 semaphore shutting down — returning 503');
    res.set('Retry-After', String(opts.retryAfterSec ?? SHUTDOWN_RETRY_AFTER_SEC));
    sendError(res, 503, 'SERVICE_UNAVAILABLE', SERVICE_UNAVAILABLE_MESSAGE);
    return 'handled';
  }
  if (err instanceof ArgonAbortError) {
    // Client disconnected before the argon2 slot was granted; there is no
    // response to write (the socket is gone). Return 'handled' so the
    // caller's catch block does NOT fall through to the generic 500 /
    // sendError path, which would try to write to the torn-down socket.
    logger.debug(
      { err, ...ctx },
      'argon2 slot aborted by client disconnect — no response to write',
    );
    return 'handled';
  }

  // Unreachable as long as `ArgonSemaphoreError` stays abstract and the
  // three concrete subclasses above are the only extenders. If a future
  // subclass is added, the `instanceof ArgonSemaphoreError` check at the
  // top will catch it but none of the branches will fire — log loudly so
  // we notice in production while the type system catches up.
  logger.error(
    { err, ...ctx },
    'unknown ArgonSemaphoreError subclass — falling through to generic 500',
  );
  return 'unhandled';
}
