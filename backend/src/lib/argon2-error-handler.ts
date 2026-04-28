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
// Chosen shape: return a string-literal sentinel `'handled' | 'unhandled'`
// exposed via the `ARGON_HANDLED` / `ARGON_UNHANDLED` constants, matching
// the convention already established by `handleBroadcastError` (which
// returns `'timeout' | 'failure'`). The call site becomes
//
//   if (handleArgonError(res, err, opts) === ARGON_HANDLED) return;
//
// which is harder to typo than `if (helper(res, err))` and self-documents
// what the boolean would have meant. Forgetting the `=== ARGON_HANDLED`
// produces `if ('unhandled') return;` which is a truthy short-circuit,
// BUT static analysis (eslint, tsc with `--noUncheckedIndexedAccess`)
// flags the implicit truthy-on-string. Going through the constant rather
// than the bare literal also means a typo'd `=== ARGON_HANLDED` is a
// `TS2304: Cannot find name` at compile time instead of a silent runtime
// no-op. The string-literal type also lets a future caller pattern-match
// on the discriminated outcome if we add a third classification.
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
 * Sentinel constants for the discriminated outcome of {@link handleArgonError}.
 * Call sites compare via `=== ARGON_HANDLED` rather than the bare string
 * literals so the magic value lives in exactly one place; renaming the
 * sentinel later is a single-file edit, and any caller that drifts to the
 * wrong literal surfaces as a `TS2367` (no-overlap) at compile time instead
 * of a silent `=== 'foo'` typo that always evaluates false.
 */
export const ARGON_HANDLED = 'handled' as const;
export const ARGON_UNHANDLED = 'unhandled' as const;

/**
 * Discriminated outcome of {@link handleArgonError}. Caller MUST early-return
 * on {@link ARGON_HANDLED} to avoid falling through to a generic 500 branch
 * that would write a second response onto the same socket.
 * {@link ARGON_UNHANDLED} means the helper recognized none of the three argon
 * semaphore error classes and the caller should run its normal error path
 * (typically a `logger.error` + `sendError(res, 500, 'INTERNAL_ERROR', ...)`).
 */
export type HandleArgonErrorResult = typeof ARGON_HANDLED | typeof ARGON_UNHANDLED;

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
 * re-implementing the catch chain. The shape is a closed allowlist (NOT
 * `Record<string, unknown>`) so a future caller cannot pass an arbitrary
 * field like `email` and bypass the project-wide `hashEmailForLogs`
 * convention. PEvO's operating jurisdiction (Portugal / CNPD) makes raw
 * email addresses in operator logs a real compliance risk; widening the
 * type narrows the surface where that mistake can land. Add new fields
 * here intentionally rather than via an open record.
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
  /**
   * Structured-log context merged into the helper's log calls. Closed
   * allowlist by design; see the JSDoc above for rationale.
   */
  logContext?: { username?: string };
  /**
   * Override for the `Retry-After` header (seconds) on the two 503 branches.
   * Defaults to {@link QUEUE_FULL_RETRY_AFTER_SEC} / {@link SHUTDOWN_RETRY_AFTER_SEC}
   * when unset.
   */
  retryAfterSec?: number;
}

/**
 * Translate an argon2 semaphore error into the matching HTTP response and
 * log line. Returns {@link ARGON_HANDLED} if the error was recognized and
 * the response was written; {@link ARGON_UNHANDLED} if the caller should
 * fall through to its own generic-error branch.
 *
 * Intended call shape:
 *
 * ```ts
 * } catch (err) {
 *   if (handleArgonError(res, err, { logContext: { username } }) === ARGON_HANDLED) return;
 *   logger.error({ err }, 'Some operation failed');
 *   sendError(res, 500, 'INTERNAL_ERROR', 'Some operation failed');
 * }
 * ```
 *
 * The `=== ARGON_HANDLED` comparison closes the boolean-return footgun: a
 * caller that forgot to compare would still trigger the truthy short-
 * circuit (because `'unhandled'` is also truthy), but the explicit string
 * comparison is far harder to omit by accident than a bare `if (fn())`.
 *
 * NOTE on `ArgonAbortError`: returns {@link ARGON_HANDLED} WITHOUT writing
 * a response. The client socket is already torn down; writing into it
 * would surface as an EPIPE in the global error handler. Caller MUST
 * early-return on {@link ARGON_HANDLED} to avoid the generic 500 branch
 * attempting a write.
 */
/**
 * Validate a caller-supplied `retryAfterSec` override before it lands on
 * the wire. Accepts only finite non-negative values and floors them to an
 * integer — an HTTP `Retry-After` is delta-seconds (or an HTTP-date), and
 * a fractional / NaN / Infinity / negative number serializes to a malformed
 * header that downstream proxies and clients handle inconsistently. On
 * invalid input, log loudly and fall back to the documented per-branch
 * default rather than emitting a malformed header. No production caller
 * passes the field today; this guard is a perimeter check before a future
 * caller derives the value from user input.
 */
function resolveRetryAfterSec(override: number | undefined, defaultSec: number): number {
  if (override === undefined) return defaultSec;
  if (!Number.isFinite(override) || override < 0) {
    logger.warn(
      { retryAfterSec: override, defaultSec },
      'argon2 handler: ignoring invalid retryAfterSec override; falling back to branch default',
    );
    return defaultSec;
  }
  return Math.floor(override);
}

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
    return ARGON_UNHANDLED;
  }

  const ctx = opts.logContext ?? {};

  if (err instanceof ArgonQueueFullError) {
    // Spread caller ctx FIRST so a stray `ctx.err` cannot clobber the
    // structured `err` field that observability tooling keys on. Same
    // ordering on every log call below.
    logger.warn({ ...ctx, err }, 'argon2 queue saturated — returning 503');
    res.set('Retry-After', String(resolveRetryAfterSec(opts.retryAfterSec, QUEUE_FULL_RETRY_AFTER_SEC)));
    sendError(res, 503, 'SERVICE_UNAVAILABLE', SERVICE_UNAVAILABLE_MESSAGE);
    return ARGON_HANDLED;
  }
  if (err instanceof ShuttingDownError) {
    logger.info({ ...ctx, err }, 'argon2 semaphore shutting down — returning 503');
    res.set('Retry-After', String(resolveRetryAfterSec(opts.retryAfterSec, SHUTDOWN_RETRY_AFTER_SEC)));
    sendError(res, 503, 'SERVICE_UNAVAILABLE', SERVICE_UNAVAILABLE_MESSAGE);
    return ARGON_HANDLED;
  }
  if (err instanceof ArgonAbortError) {
    // Client disconnected before the argon2 slot was granted; there is no
    // response to write (the socket is gone). Return ARGON_HANDLED so the
    // caller's catch block does NOT fall through to the generic 500 /
    // sendError path, which would try to write to the torn-down socket.
    logger.debug(
      { ...ctx, err },
      'argon2 slot aborted by client disconnect — no response to write',
    );
    return ARGON_HANDLED;
  }

  // Unreachable as long as `ArgonSemaphoreError` stays abstract and the
  // three concrete subclasses above are the only extenders. If a future
  // subclass is added, the `instanceof ArgonSemaphoreError` check at the
  // top will catch it but none of the branches will fire — log loudly so
  // we notice in production while the type system catches up.
  logger.error(
    { ...ctx, err },
    'unknown ArgonSemaphoreError subclass — falling through to generic 500',
  );
  return ARGON_UNHANDLED;
}
