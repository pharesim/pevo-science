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
 *
 * `ambiguousMsg` is the user-facing message used on the
 * `forceAmbiguousOutcome` non-timer branch, distinct from `failMsg`. The
 * non-timer ambiguous path is semantically uncertainty (broadcast may have
 * landed; verify before retry), NOT failure — so reusing `failMsg` ("Failed
 * to broadcast …") would contradict `details.outcome: 'uncertain'` in the
 * envelope. Callers that pass `forceAmbiguousOutcome: true` on a wrapper
 * (e.g. `withOrcidBindingLock` `'unavailable'` branch) should set this to
 * a verify-before-retry message like "Broadcast outcome uncertain. Verify
 * your ORCID linkage at /settings before retrying." Defaults to `failMsg`
 * if omitted (preserves pre-existing behavior on the legacy callers).
 */
export interface HandleBroadcastErrorOpts {
  /** User-facing 504 message (timer-fire path). */
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
   * envelope; `ambiguousMsg` (or `failMsg` as fallback) is used for the
   * non-timeout message, `timeoutMsg` for the timer-fire path. Default false
   * (preserves pre-existing 504/502 split).
   */
  forceAmbiguousOutcome?: boolean;
  /**
   * User-facing message for the `forceAmbiguousOutcome` non-timer branch.
   * Falls back to `failMsg` when omitted. Distinct from `failMsg` because
   * the ambiguous path semantically conveys uncertainty, not failure.
   */
  ambiguousMsg?: string;
}

/**
 * Emit the 504 `BROADCAST_TIMEOUT` or 502 `BROADCAST_FAILED` envelope shape per
 * `agents/docs/api-contracts/common.md` for a `broadcastJsonWithTimeout` catch
 * site, plus the matching log call. The contract doc remains the canonical
 * surface description; this helper is a single-source implementation of those
 * envelopes for HTTP route handlers.
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
    // Canonical 504 envelope field order: required fields first
    // (retriable, outcome, verify_before_retry, timeout_ms), then optional
    // fields (verify_location). Keeping `timeout_ms` in the same slot across
    // orcid and non-orcid surfaces means consumers can read it positionally
    // without branching on whether the surface adds verify_location.
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
    // Prefer ambiguousMsg over failMsg here: failMsg ("Failed to broadcast …")
    // contradicts outcome:'uncertain' in the envelope. ambiguousMsg falls back
    // to failMsg for callers that haven't migrated to the new field yet.
    const ambiguousUserMsg = opts.ambiguousMsg ?? opts.failMsg;
    sendError(res, 504, 'BROADCAST_TIMEOUT', ambiguousUserMsg, details);
    return 'failure';
  }
  logger.error(
    { err, ...opts.logContext },
    `${opts.routeLabel} broadcast failed`,
  );
  sendError(res, 502, 'BROADCAST_FAILED', opts.failMsg, { retriable: false });
  return 'failure';
}
