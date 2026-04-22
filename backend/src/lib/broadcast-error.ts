import type { Response } from 'express';
import { BroadcastTimeoutError } from '../hive.js';
import { sendError } from '../response.js';
import { logger } from '../logger.js';

/**
 * Options for {@link handleBroadcastError}.
 *
 * `timeoutMsg` and `failMsg` are the user-facing strings in the 504/502
 * envelopes. `logContext` is merged into BOTH the `logger.warn` (timeout) and
 * `logger.error` (failure) calls, alongside `err` and (on timeout) `timeoutMs`.
 * `verifyLocation` surfaces on the 504 envelope only, as a UI hint for where
 * the caller can verify chain state before retrying (currently only the ORCID
 * surfaces set it to '/settings'). `routeLabel` is baked into the log
 * messages (`<routeLabel> broadcast timed out` / `<routeLabel> broadcast failed`).
 *
 * `forceAmbiguousOutcome` collapses both branches (timeout AND any other
 * throw) into the 504 `BROADCAST_TIMEOUT` ambiguous-outcome envelope. Intended
 * for callers that operate without a surrounding retry/lock guard (e.g.
 * `withOrcidBindingLock`'s `'unavailable'` branch, where Redis is already
 * down and the broadcast may have landed without the caller being able to
 * reconcile later): in that context, every throw is outcome-ambiguous, not
 * just a broadcast timeout. When set, `timeout_ms` in the envelope is
 * reported as the `BroadcastTimeoutError.timeoutMs` on the timer-fire path,
 * and is omitted on the non-timeout path (the error didn't originate from
 * the timer).
 */
export interface HandleBroadcastErrorOpts {
  /** User-facing 504 message. */
  timeoutMsg: string;
  /** User-facing 502 message. */
  failMsg: string;
  /** Merged into both log calls. */
  logContext: Record<string, unknown>;
  /** Optional UI hint for the 504 envelope (e.g. '/settings'). */
  verifyLocation?: string;
  /** Log-message prefix, e.g. 'orcid.handleAccredit'. */
  routeLabel: string;
  /**
   * When true, any throw (timeout OR other) emits the 504 ambiguous-outcome
   * envelope; `failMsg` is used for the non-timeout message, `timeoutMsg` for
   * the timer-fire path. Default false (preserves pre-existing 504/502 split).
   */
  forceAmbiguousOutcome?: boolean;
}

/**
 * Emit the canonical 504 `BROADCAST_TIMEOUT` or 502 `BROADCAST_FAILED` envelope
 * for a `broadcastJsonWithTimeout` catch site, plus the matching log call.
 *
 * Returns `'timeout' | 'failure'` so callers that need a side effect tied to
 * the failure branch (e.g. {@link
 * ../routes/accreditation.ts} `/verify` deleting the accreditation token on
 * chain rejection but preserving it across a timeout) can branch after the
 * helper without re-doing the `instanceof BroadcastTimeoutError` check.
 */
export function handleBroadcastError(
  res: Response,
  err: unknown,
  opts: HandleBroadcastErrorOpts,
): 'timeout' | 'failure' {
  if (err instanceof BroadcastTimeoutError) {
    logger.warn(
      { err, timeoutMs: err.timeoutMs, ...opts.logContext },
      `${opts.routeLabel} broadcast timed out`,
    );
    const details: Record<string, unknown> = {
      retriable: false,
      outcome: 'uncertain',
      verify_before_retry: true,
      timeout_ms: err.timeoutMs,
    };
    if (opts.verifyLocation !== undefined) {
      details.verify_location = opts.verifyLocation;
    }
    sendError(res, 504, 'BROADCAST_TIMEOUT', opts.timeoutMsg, details);
    return 'timeout';
  }
  if (opts.forceAmbiguousOutcome) {
    // Non-timeout throw on an ambiguous-outcome path (e.g. Redis-unavailable
    // degrade where the broadcast may have landed but the caller can't
    // reconcile): emit the same 504 envelope as the timeout branch so the
    // client treats the outcome as uncertain. `timeout_ms` is omitted: the
    // error didn't originate from the timer, so reporting a fake value would
    // mislead consumers keying retry-backoff off that field.
    logger.error(
      { err, ...opts.logContext },
      `${opts.routeLabel} broadcast failed on ambiguous-outcome path`,
    );
    const details: Record<string, unknown> = {
      retriable: false,
      outcome: 'uncertain',
      verify_before_retry: true,
    };
    if (opts.verifyLocation !== undefined) {
      details.verify_location = opts.verifyLocation;
    }
    sendError(res, 504, 'BROADCAST_TIMEOUT', opts.failMsg, details);
    return 'failure';
  }
  logger.error(
    { err, ...opts.logContext },
    `${opts.routeLabel} broadcast failed`,
  );
  sendError(res, 502, 'BROADCAST_FAILED', opts.failMsg, { retriable: false });
  return 'failure';
}
