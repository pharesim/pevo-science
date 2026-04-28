import type { Response } from 'express';
import { BroadcastTimeoutError } from '../hive.js';
import { sendError } from '../response.js';
import { logger } from '../logger.js';

/**
 * Thrown by callers whose post-broadcast write cascade fails AFTER the chain
 * op has been confirmed by the broadcast endpoint. The chain op is the source
 * of truth; the throw is a downstream cascade failure (e.g. cacheOrcidBinding
 * Redis flap, updateAccountOrcid pool exhaustion, seedAccreditationBonus DB
 * error). Discriminates the "broadcast SUCCEEDED, post-broadcast threw" class
 * from the "broadcast threw" class so {@link handleBroadcastError} can emit a
 * 502 POST_BROADCAST_FAILED envelope (`details.outcome:'confirmed'`,
 * `details.tx_id`, `details.failed_step`) instead of the over-cautious
 * 504 BROADCAST_TIMEOUT (`details.outcome:'uncertain'`).
 *
 * Operator alert quality: alerts keyed on 504 BROADCAST_TIMEOUT only fire on
 * truly uncertain outcomes; 502 POST_BROADCAST_FAILED routes to the DB on-call
 * instead of the broadcast on-call. UX recovery is unchanged — the user is
 * told the chain op is confirmed; HAF will reconcile within 120s.
 *
 * `failedStep` enumerates the cascade-step the throw occurred in. Callers
 * thread a `currentStep` variable through the post-broadcast `try` block,
 * advancing it before each `await`, so the catch can attach the precise
 * failed step.
 *
 * BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION (round-2 follow-up).
 */
export class PostBroadcastWriteError extends Error {
  constructor(
    public readonly txId: string,
    public readonly cause: unknown,
    public readonly failedStep: 'cache_write' | 'account_update' | 'reputation_seed' | 'unknown',
  ) {
    super(`Post-broadcast write failed at step '${failedStep}' (tx ${txId})`);
    this.name = 'PostBroadcastWriteError';
  }
}

/**
 * Base options shared by every broadcast-error envelope.
 *
 * `timeoutMsg` and `failMsg` are the user-facing strings in the 504/502
 * envelopes. `logContext` is merged into BOTH the `logger.warn` (timeout) and
 * `logger.error` (failure) calls, alongside `err` and (on timeout) `timeoutMs`.
 * `verifyLocation` surfaces on the 504 envelope only, as a UI hint for where
 * the caller can verify chain state before retrying (currently only the ORCID
 * surfaces set it to '/settings'). `routeLabel` is baked into the log
 * messages.
 *
 * Stable log-message suffixes (operator alert anchors — change with care):
 *   <routeLabel> broadcast timed out                                  (logger.warn,  timer-fire path)
 *   <routeLabel> broadcast failed on ambiguous-outcome path           (logger.error, forceAmbiguousOutcome non-timer branch)
 *   <routeLabel> broadcast failed                                     (logger.error, standard 502 path)
 *   <routeLabel> broadcast confirmed but post-broadcast write failed  (logger.error, PostBroadcastWriteError discrimination path — routes to DB on-call, not broadcast on-call)
 *
 * Item #1 of round-2 hold (BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING):
 * `forceAmbiguousOutcome` and `ambiguousMsg` are now correlated via a
 * discriminated union. Setting `forceAmbiguousOutcome: true` REQUIRES
 * `ambiguousMsg`; the round-1 `ambiguousMsg ?? failMsg` fallback is gone so
 * a future caller cannot silently regress to "Failed to broadcast …" on a
 * `outcome:'uncertain'` envelope (the round-1 #2 contradiction class). The
 * non-ambiguous variant explicitly disallows `ambiguousMsg` (`?: never`) so
 * a stray field on a non-ambiguous opts object is a compile error.
 */
interface BaseHandleBroadcastErrorOpts {
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
   * Optional caller-supplied template for the 502 POST_BROADCAST_FAILED
   * envelope's user-facing message. The helper passes `failedStep` (from the
   * `PostBroadcastWriteError`) so the message can name which cascade step
   * failed. Defaults to a generic "broadcast confirmed; backend write failed"
   * line when omitted. Today only ORCID callers throw `PostBroadcastWriteError`
   * (handleAccredit / handleLink); other callers leave this undefined.
   */
  postBroadcastFailedMsgFn?: (failedStep: string) => string;
}

/**
 * Discriminated-union ambiguous-outcome fields. The `true` variant requires
 * `ambiguousMsg`; the `false` (or omitted) variant explicitly disallows it
 * so a stray field surfaces at the type level rather than silently no-op'ing.
 *
 * The ambiguous path is used when the caller has no surrounding retry/lock
 * guard (e.g. {@link withOrcidBindingLock}'s `'unavailable'` branch, where
 * Redis is already down and the broadcast may have landed without the caller
 * being able to reconcile later): every throw is outcome-ambiguous, not just
 * a broadcast timeout. `ambiguousMsg` is the user-facing message for the
 * non-timer branch (the timer-fire branch keeps `timeoutMsg`); reusing
 * `failMsg` ("Failed to broadcast …") would contradict the
 * `details.outcome:'uncertain'` field in the envelope.
 */
type AmbiguousOutcomeFields =
  | { forceAmbiguousOutcome?: false; ambiguousMsg?: never }
  | { forceAmbiguousOutcome: true; ambiguousMsg: string };

export type HandleBroadcastErrorOpts = BaseHandleBroadcastErrorOpts & AmbiguousOutcomeFields;

/**
 * The narrowed ambiguous-only variant. Wrappers that always emit the
 * ambiguous-outcome envelope (currently {@link withOrcidBindingLock}'s
 * `'unavailable'` branch) take this type and call
 * {@link handleBroadcastErrorAmbiguous}, so the wrapper does not need to
 * spread `forceAmbiguousOutcome:true` into the helper opts itself (item #4
 * of the round-2 hold — keeps the helper's internal flag name out of caller
 * sites).
 */
export type HandleBroadcastErrorAmbiguousOpts = Extract<
  HandleBroadcastErrorOpts,
  { forceAmbiguousOutcome: true }
>;

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
  // PostBroadcastWriteError discrimination MUST run before the
  // BroadcastTimeoutError / forceAmbiguousOutcome branches: the chain op IS
  // confirmed, so the over-cautious 504 outcome:'uncertain' would mislead
  // operators (alerts route to broadcast on-call instead of DB on-call) and
  // the user (asked to verify a confirmed write). 502 POST_BROADCAST_FAILED
  // with details.outcome:'confirmed' is the right shape.
  // (BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION.)
  if (err instanceof PostBroadcastWriteError) {
    logger.error(
      { err, cause: err.cause, txId: err.txId, failedStep: err.failedStep, ...opts.logContext },
      `${opts.routeLabel} broadcast confirmed but post-broadcast write failed`,
    );
    const userMsg = opts.postBroadcastFailedMsgFn
      ? opts.postBroadcastFailedMsgFn(err.failedStep)
      : `Broadcast confirmed (tx ${err.txId}); backend write at step '${err.failedStep}' failed. The chain operation is the source of truth and will reconcile automatically once HAF indexes it.`;
    sendError(res, 502, 'POST_BROADCAST_FAILED', userMsg, {
      retriable: false,
      outcome: 'confirmed',
      tx_id: err.txId,
      failed_step: err.failedStep,
    });
    return 'failure';
  }
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
    // `ambiguousMsg` is required by the discriminated union when
    // forceAmbiguousOutcome is true — no `?? failMsg` fallback (the round-1
    // fallback could silently regress to "Failed to broadcast …" which
    // contradicts outcome:'uncertain'; round-2 item #1 closes that class at
    // the type level).
    sendError(res, 504, 'BROADCAST_TIMEOUT', opts.ambiguousMsg, details);
    return 'failure';
  }
  logger.error(
    { err, ...opts.logContext },
    `${opts.routeLabel} broadcast failed`,
  );
  sendError(res, 502, 'BROADCAST_FAILED', opts.failMsg, { retriable: false });
  return 'failure';
}

/**
 * Dedicated ambiguous-outcome entry point. Equivalent to
 * `handleBroadcastError(res, err, opts)` where `opts` is statically narrowed
 * to the `forceAmbiguousOutcome:true; ambiguousMsg:string` variant of the
 * union. Wrappers like {@link withOrcidBindingLock}'s `'unavailable'`-branch
 * catch call this directly so the helper's internal `forceAmbiguousOutcome`
 * flag name does not leak into caller code (item #4 of round-2 hold).
 */
export function handleBroadcastErrorAmbiguous(
  res: Response,
  err: unknown,
  opts: HandleBroadcastErrorAmbiguousOpts,
): 'timeout' | 'failure' {
  return handleBroadcastError(res, err, opts);
}
