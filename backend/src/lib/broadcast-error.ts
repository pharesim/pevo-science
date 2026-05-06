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
export type PostBroadcastFailedStep = 'cache_write' | 'account_update' | 'reputation_seed';

export class PostBroadcastWriteError extends Error {
  constructor(
    public readonly txId: string,
    cause: unknown,
    public readonly failedStep: PostBroadcastFailedStep,
  ) {
    // Forward `cause` through Error's standard `{ cause }` slot so the native
    // ES2022 Error.cause property is set. pino's error serializer, structured
    // clone, and any consumer using the inherited Error.prototype.cause read
    // it from there — a class field `public readonly cause: unknown` shadows
    // that slot and presents undefined to those consumers (round-1 hold #6).
    super(`Post-broadcast write failed at step '${failedStep}' (tx ${txId})`, { cause });
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
 * Stable log-message suffixes + structured `event:` discriminators (operator
 * alert anchors — change with care). Round-5 hold #2 added the `event:`
 * literal on every site so dashboards can key on the structured field instead
 * of suffix-matching the free-text message; both the suffix and the literal
 * are load-bearing and pinned at the unit-test layer.
 *   <routeLabel> broadcast timed out                                  (logger.warn,  event:'broadcast_timeout',          timer-fire path)
 *   <routeLabel> broadcast failed on ambiguous-outcome path           (logger.error, event:'broadcast_ambiguous',        forceAmbiguousOutcome non-timer branch)
 *   <routeLabel> broadcast failed                                     (logger.error, event:'broadcast_failed',           standard 502 path)
 *   <routeLabel> broadcast confirmed but post-broadcast write failed  (logger.error, event:'post_broadcast_write_failed', PostBroadcastWriteError discrimination path — routes to DB on-call, not broadcast on-call)
 *   <routeLabel> postBroadcastMsgFn threw — using generic fallback    (logger.warn,  event:'post_broadcast_msg_fn_threw', recovery branch when caller-supplied msg-fn throws)
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
/**
 * Narrowed structured-log context for the 504/502 broadcast-error envelopes.
 *
 * Round-2 hold #6 (BACKEND-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION): the
 * pre-fix `Record<string, unknown>` accepted any string key, so a typo at a
 * call site (`permink` for `permlink`, `usernam` for `username`) compiled
 * silently and operators got an inconsistent log shape. The fields below are
 * the union of every key actually passed at the existing call sites
 * (orcid.ts, claims.ts, accreditation.ts, bridge.ts, custody.ts, etc.) — see
 * `git grep -n 'logContext: {'` under `backend/src/`.
 *
 * The interface is open via the `event` field NOT being declared here (the
 * helper writes `event:` itself, AFTER the spread, so it overrides any
 * caller-supplied value). All other fields are explicit and `?: undefined`.
 *
 * Adding a new context field at a future call site is a one-line addition
 * here — that's the cost we pay for the typo protection. Compile-time
 * narrowing on a small set of structured fields is the right trade vs. the
 * unbounded `Record<string, unknown>`.
 */
export interface LogContext {
  /** Hive author of the targeted post (bridge/orcid surfaces) */
  author?: string;
  /** Hive permlink (bridge/orcid surfaces) */
  permlink?: string;
  /** Hive username of the caller */
  username?: string;
  /** Operation types in a multi-op transaction (custody — legacy comma-joined string) */
  opTypes?: string;
  /** Operation types as an array (custody — preferred structured form) */
  op_types?: string[];
  /** Operation count in a multi-op transaction (custody) */
  op_count?: number;
  /** Outcome label for audit-log call siblings ('success' | 'failure' | 'timeout') */
  outcome?: 'success' | 'failure' | 'timeout';
  /** Attempt counter (idempotency/retry-amplification audit signal) */
  attempt_n?: number;
  /** Generic identifier (orcid / bridge lookup) */
  identifier?: string;
  /** ORCID iD when binding/unbinding */
  orcid?: string;
  /** Reputation cycle id for reputation-bonus seeding */
  cycle_id?: number | string;
  /** SHA-256 hash of caller email (accreditation surfaces — never the raw email) */
  email_hash?: string;
  /** ORCID-flow mode discriminator ('accredit' | 'link') */
  mode?: 'accredit' | 'link';
  /** Paper author for claim approve/revoke surfaces */
  paperAuthor?: string;
  /** Paper permlink for claim approve/revoke surfaces */
  paperPermlink?: string;
  /** Claimer Hive username (claims surfaces) */
  claimer?: string;
  /** Signer discriminator for revoke surface ('bridge' | 'admin') */
  signer?: 'bridge' | 'admin';
}

interface BaseHandleBroadcastErrorOpts {
  /** User-facing 504 message (timer-fire path). */
  timeoutMsg: string;
  /** User-facing 502 message. */
  failMsg: string;
  /** Merged into both log calls. */
  logContext: LogContext;
  /** Optional UI hint for the 504 envelope (e.g. '/settings'). */
  verifyLocation?: string;
  /** Log-message prefix, e.g. 'orcid.handleAccredit'. */
  routeLabel: string;
  /**
   * Optional caller-supplied template for the 502 POST_BROADCAST_FAILED
   * envelope's user-facing message. The helper passes `failedStep` (from the
   * `PostBroadcastWriteError`) so the message can render per-step recovery
   * semantics (e.g. `'reputation_seed'` reconciles via the next batch cycle;
   * `'account_update'` is a denormalized projection that requires a
   * HAF-replay or manual re-run). Defaults to a generic "broadcast confirmed;
   * we'll restore the backend record from the chain shortly" line that does
   * NOT leak internal step labels (round-1 hold #9). Today only ORCID callers
   * throw `PostBroadcastWriteError` (handleAccredit / handleLink); other
   * callers leave this undefined.
   *
   * Renamed from `postBroadcastFailedMsgFn` (round-1 hold #7 — option (b):
   * dropped the redundant `Failed` segment since the type already implies
   * failure; kept the `Fn` suffix to make the callback contract explicit at
   * the type level, since the per-step rendering needs the function form).
   */
  postBroadcastMsgFn?: (failedStep: PostBroadcastFailedStep) => string;
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
 * Generic POST_BROADCAST_FAILED fallback used when a caller omits
 * `postBroadcastMsgFn` or that callback itself throws. Deliberately omits the
 * internal step label (round-1 hold #9 — `'cache_write'` / `'reputation_seed'`
 * are operator vocabulary, not user-facing). Names the txId so the user (or
 * the support agent helping them) has the chain reference for later
 * verification.
 */
function defaultPostBroadcastMsg(txId: string): string {
  return `Your operation is confirmed on Hive (tx ${txId}). A backend write failed; we'll restore the backend record from the chain shortly.`;
}

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
 * Returns one of `'timeout' | 'failure' | 'post_broadcast'` so callers that
 * need a side effect tied to the failure branch (e.g. {@link
 * ../routes/accreditation.ts} `/verify` deleting the accreditation token on
 * chain rejection but preserving it across a timeout) can branch after the
 * helper without re-doing the `instanceof BroadcastTimeoutError` check.
 *
 * The `'post_broadcast'` return distinguishes "broadcast confirmed, downstream
 * write threw" (502 POST_BROADCAST_FAILED) from "broadcast was rejected by
 * chain" (502 BROADCAST_FAILED, return `'failure'`). Round-1 hold #4: a future
 * caller that adopts `PostBroadcastWriteError` discrimination must NOT fire
 * destructive cleanup (e.g. `deleteToken`, `releaseLock`) on a confirmed-on-
 * chain operation — branching only on `'failure'` keeps that property safe.
 */
export function handleBroadcastError(
  res: Response,
  err: unknown,
  opts: HandleBroadcastErrorOpts,
): 'timeout' | 'failure' | 'post_broadcast' {
  // PostBroadcastWriteError discrimination MUST run before the
  // BroadcastTimeoutError / forceAmbiguousOutcome branches: the chain op IS
  // confirmed, so the over-cautious 504 outcome:'uncertain' would mislead
  // operators (alerts route to broadcast on-call instead of DB on-call) and
  // the user (asked to verify a confirmed write). 502 POST_BROADCAST_FAILED
  // with details.outcome:'confirmed' is the right shape.
  // (BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION.)
  if (err instanceof PostBroadcastWriteError) {
    // Structured `event:'post_broadcast_write_failed'` so the 4th anchor is
    // dashboard-keyable alongside the sibling event-tagged anchors
    // (`event:'binding_lock_extend_*'`, `event:'lock_contention_held'`,
    // `event:'post_broadcast_msg_fn_threw'`). The 4th anchor is the
    // operator-facing signal for `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS`
    // — when a cascade fn re-throws on a permanent error, this is what fires
    // at error level. Routes oncall to DB on-call (not broadcast on-call) per
    // the discrimination contract.
    logger.error(
      {
        ...opts.logContext,
        // Authoritative fields placed AFTER `...opts.logContext` so a
        // caller-supplied `logContext: { err / txId / failedStep / event:
        // ... }` cannot silently override the helper's source-of-truth
        // values. JS later-wins semantics; the literals must always win.
        // Round-5 hold #1 extends the round-4 `event:` protection to
        // err / txId / failedStep so the discrimination contract documented
        // in `agents/docs/api-contracts/orcid.md` for `details.failed_step`
        // remains load-bearing in operator logs even if a future caller's
        // logContext drops a colliding key.
        //
        // Round-3 hold #1 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
        // a redundant top-level sibling `cause: err.cause` field used to live
        // here but bypassed both redaction layers — the wrapper at
        // `logger.ts:redactErrInArg` and the Layer-B `serializers.err` only
        // strip the `err` slot, so a sibling `cause` would fall through to
        // pino's default Error serialization (re-introducing the leaky-
        // enumerable surface the redact policy exists to close). It's also
        // unnecessary: the recursive `cause` traversal in `redactErrSerializer`
        // (logger.ts:140-142) already preserves the redacted cause inside
        // `err.cause` of the serialized payload. Do NOT re-add a top-level
        // `cause:` here without first widening the redact policy to cover
        // sibling-cause shapes too.
        err,
        txId: err.txId,
        failedStep: err.failedStep,
        event: 'post_broadcast_write_failed',
      },
      `${opts.routeLabel} broadcast confirmed but post-broadcast write failed`,
    );
    // Resolve the user-facing message under a guard: a caller-supplied
    // `postBroadcastMsgFn` is application code that may throw (mid-rotation
    // logger inside the template, undefined this, future formatter typo).
    // Letting an exception escape here would skip `sendError`, propagate to
    // the route's outer catch as a generic 500 INTERNAL_ERROR, and (on the
    // ORCID surface) consume the OAuth state token in the process — the
    // exact hard-block class the wrapper exists to prevent (round-1 hold #2).
    let userMsg: string;
    try {
      userMsg = opts.postBroadcastMsgFn
        ? opts.postBroadcastMsgFn(err.failedStep)
        : defaultPostBroadcastMsg(err.txId);
    } catch (msgErr) {
      logger.warn(
        {
          ...opts.logContext,
          // Authoritative fields placed AFTER `...opts.logContext` so a
          // caller-supplied `logContext: { err / txId / failedStep / event:
          // ... }` cannot silently override the helper's source-of-truth
          // values (round-5 hold #1: extends round-4's `event:` protection
          // to the sibling fields). The msg-fn-throws anchor is the
          // dashboard-keyable signal that a caller's `postBroadcastMsgFn`
          // template threw — `err` here is the inner template error, NOT
          // the outer `PostBroadcastWriteError`; we name it `err` so pino's
          // serializer renders it as the primary error.
          err: msgErr,
          txId: err.txId,
          failedStep: err.failedStep,
          event: 'post_broadcast_msg_fn_threw',
        },
        `${opts.routeLabel} postBroadcastMsgFn threw — using generic fallback`,
      );
      userMsg = defaultPostBroadcastMsg(err.txId);
    }
    sendError(res, 502, 'POST_BROADCAST_FAILED', userMsg, {
      retriable: false,
      outcome: 'confirmed',
      tx_id: err.txId,
      failed_step: err.failedStep,
    });
    return 'post_broadcast';
  }
  if (err instanceof BroadcastTimeoutError) {
    // Round-5 hold #2: structured `event:` discriminator alongside the
    // sibling event-tagged anchors (`event:'post_broadcast_write_failed'`
    // above, `event:'post_broadcast_msg_fn_threw'` in the recovery branch).
    // Lets dashboards key on the operator-alert anchor without parsing the
    // free-text suffix. Placed AFTER `...opts.logContext` so a caller-
    // supplied `logContext: { event: / err: / timeoutMs: ... }` cannot
    // silently override the literal (item 1's spread-after-literal
    // convention).
    logger.warn(
      {
        ...opts.logContext,
        err,
        timeoutMs: err.timeoutMs,
        event: 'broadcast_timeout',
      },
      `${opts.routeLabel} broadcast timed out`,
    );
    // Source-readability convention for the timer-fire 504 envelope:
    // required fields first, optional fields appended. `timeout_ms` keeps the
    // same position across timer-fire 504 envelopes (orcid + non-orcid) so
    // the literal is grep-aligned across surfaces. JSON consumers read by
    // key (not position) and `toEqual` is order-insensitive at runtime;
    // this is a code-aesthetic, not a wire-format contract. Note: the
    // `forceAmbiguousOutcome` branch below is exempt — it intentionally
    // omits `timeout_ms` because the throw didn't originate from the timer.
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
    // Round-5 hold #2: same `event:` discriminator pattern as the sibling
    // anchors. `event:'broadcast_ambiguous'` distinguishes this branch
    // (non-timer throw on a path the caller forced into ambiguous-outcome
    // semantics) from the timer-fire branch (`'broadcast_timeout'`) and the
    // standard-failure branch (`'broadcast_failed'`). All three emit the
    // 502/504 envelopes documented in `agents/docs/api-contracts/common.md`,
    // but route to different operator-alert dispositions.
    logger.error(
      {
        ...opts.logContext,
        err,
        event: 'broadcast_ambiguous',
      },
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
  // Round-5 hold #2: standard failure-branch `event:'broadcast_failed'`. The
  // common case for a non-timer broadcast throw — chain rejection, RPC error,
  // dhive client error — emits the 502 BROADCAST_FAILED envelope and routes
  // to broadcast on-call (vs. DB on-call for `'post_broadcast_write_failed'`).
  logger.error(
    {
      ...opts.logContext,
      err,
      event: 'broadcast_failed',
    },
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
): 'timeout' | 'failure' | 'post_broadcast' {
  return handleBroadcastError(res, err, opts);
}
