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
 *
 * Round-3 hold #5 (BACKEND-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION):
 * `cause` is INTENTIONALLY OMITTED from this interface. The helper at
 * `:263` below strips a caller-supplied `cause` field from the spread via
 * a `LogContext & { cause?: unknown }` widening destructure, closing the
 * sibling-cause leak path documented in round-3 hold #1 of
 * `backend-bridge-key-startup-validation-and-pino-redact` (top-level
 * `cause:` siblings bypass both the `redactErrInArg` wrapper and the
 * Layer-B `serializers.err` redactor, which only key on the `err` slot).
 * Adding `cause` here directly would silently turn the runtime strip
 * into a no-op (the widening cast would become unnecessary and could be
 * removed by a future maintainer), re-opening the leak. If a future
 * caller genuinely needs to thread a cause, route it through `err`
 * (pino's recursive cause-traversal preserves it via `err.cause` of the
 * serialized payload).
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
  /** ORCID iD when binding/unbinding */
  orcid?: string;
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
  /**
   * Route discriminator for structured-log filtering ('custody.broadcast',
   * 'bridge.register', etc.). Used by `makeLogBroadcastAttempt` callers that
   * want operator dashboards to filter on the route alongside the `event:`
   * discriminator. Optional; the `event:` label already encodes the route
   * prefix so callers can omit `route` if they don't need the redundant key.
   */
  route?: string;
  /** Bridge paper identifier (DOI / arXiv id) — used by bridge.register attempts */
  identifier?: string;
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
  // Round-4 hold #3 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
  // strip a caller-supplied `cause` field from `opts.logContext` BEFORE
  // every `{...opts.logContext, err, ...}` spread below. Round-3 hold #1
  // dropped the helper-emitted top-level `cause: err.cause` field because
  // it bypassed both redaction layers (the wrapper at `logger.ts:redact-
  // ErrInArg` and Layer-B `serializers.err` only redact the `err` slot, so
  // a sibling top-level `cause` falls through to pino's default Error
  // serialization). The companion gap left open: the spread of caller-
  // supplied `opts.logContext` had no symmetric `cause: undefined` strip.
  // A future caller adding `cause` to its `logContext` (intentionally or
  // by mistake — e.g. a TypeScript-bypass or `as unknown as LogContext`
  // cast lets a `cause` key slip past the `LogContext` interface, which
  // does NOT declare a `cause` field) would land a top-level sibling on
  // the log object, outside both redaction layers, re-opening the leak
  // path. The destructure here closes the symmetric vector at one
  // central site so all 4 spread sites below inherit it.
  //
  // The cast to `LogContext & { cause?: unknown }` is required because the
  // `LogContext` interface (declared above) does NOT include a `cause`
  // field — destructuring it directly off `opts.logContext` would be a
  // TypeScript error. The cast is sound: at runtime, JavaScript object
  // destructuring of a property that doesn't exist returns `undefined`
  // and silently moves on. The `cause` strip therefore costs nothing on
  // the typed-caller happy path; it only matters on the type-bypass case
  // this fix exists to defend against.
  const { cause: _ignored, ...sanitizedLogContext } =
    (opts.logContext ?? {}) as LogContext & { cause?: unknown };
  void _ignored;

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
        ...sanitizedLogContext,
        // Authoritative fields placed AFTER `...sanitizedLogContext` so a
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
        // sibling-cause shapes too. Round-4 hold #3 closes the symmetric
        // gap by sanitizing caller-supplied `cause` from `opts.logContext`
        // at the function entry above (the `sanitizedLogContext` const).
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
          ...sanitizedLogContext,
          // Authoritative fields placed AFTER `...sanitizedLogContext` so a
          // caller-supplied `logContext: { err / txId / failedStep / event:
          // ... }` cannot silently override the helper's source-of-truth
          // values (round-5 hold #1: extends round-4's `event:` protection
          // to the sibling fields). The msg-fn-throws anchor is the
          // dashboard-keyable signal that a caller's `postBroadcastMsgFn`
          // template threw — `err` here is the inner template error, NOT
          // the outer `PostBroadcastWriteError`; we name it `err` so pino's
          // serializer renders it as the primary error.
          // Round-4 hold #3: caller-supplied `cause` from `opts.logContext`
          // is stripped at the function entry (`sanitizedLogContext`),
          // closing the symmetric leak path called out in the round-3 hold
          // #1 comment block above.
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
        ...sanitizedLogContext,
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
        ...sanitizedLogContext,
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
      ...sanitizedLogContext,
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-attempt audit-log helper (BACKEND-BROADCAST-ATTEMPT-HELPER-EXTRACTION).
//
// Round-2 hold #4 of `backend-bridge-custody-broadcast-discrimination` added
// a per-attempt audit-log helper inside `routes/custody.ts` as an in-handler
// closure: every broadcast attempt fires a structured pino event tagged
// `event:<route>.attempt` with `outcome ∈ {success, failure, timeout}` so
// operators can correlate retry-amplification before the full idempotency
// design lands. `routes/bridge.ts` /register adopts the same pattern.
//
// The closure shape is identical across the two routes — same base-context
// fields captured (username, op_types, op_count), same outcome → log-level
// dispatch (success → info, failure/timeout → warn), same `extra` spread
// for per-call payloads (tx_id, block_num on success; nothing on
// failure/timeout). Only the event-label literal differs. Without
// extraction, a future maintainer editing one of the two closures has no
// mechanical guarantee the sibling site stays in sync (a divergence at
// the level-dispatch, the spread direction, or the `event:` placement is
// the load-bearing failure mode — operator dashboards would silently
// mis-classify or miss attempts).
//
// `makeLogBroadcastAttempt` is the factory. Returns the per-attempt
// closure pre-bound to the request-scope base context; callers invoke it
// per attempt with `(outcome, extra?)`. Spread order:
//
//   { ...baseContext, ...extra, outcome, event: eventLabel }
//
// — `extra` overrides `baseContext` (caller may want to specialize a base
// field per-attempt; closing over the request-scope is the common case but
// not load-bearing), and `outcome` + `event` go AFTER `...extra` so the
// helper's source-of-truth values cannot be silently overridden by a
// caller-supplied colliding key in `extra`. This is the spread-after-
// literal convention from `handleBroadcastError`'s round-4/5 holds (the
// `event:` field guard at the four 502/504 anchors).
//
// `attempt_n` is INTENTIONALLY NOT a declared field on the factory. Round-3
// hold #1 of `backend-bridge-custody-broadcast-discrimination` established
// that a hardcoded `attempt_n: 1` would silence retry-amplification
// dashboards keyed on the field (a constant 1 reads as "no retries" to
// operators). When the full idempotency cluster lands the real per-key
// counter (filed as `backend-broadcast-idempotency-cluster-followup.md`),
// callers will thread the counter through `extra` or the factory adds a
// dedicated `attempt_n?: number` parameter; until then, the slot stays
// empty so alerts fire on missing-field rather than reading a placeholder
// as ground truth.

/** Outcome label discriminator for every per-attempt audit-log event. */
export type AttemptOutcome = 'success' | 'failure' | 'timeout';

/**
 * Returns a per-attempt audit-log closure pre-bound to `eventLabel` and
 * `baseContext`. Each invocation emits one structured pino event:
 *
 *   logger.info  on outcome:'success'      (broadcast confirmed by Hive)
 *   logger.warn  on outcome:'failure'      (chain rejection / RPC error)
 *   logger.warn  on outcome:'timeout'      (BroadcastTimeoutError fired)
 *
 * Operator-alert anchor: `event:<eventLabel>` is the dashboard-keyable
 * literal. The trailing string passed to pino is `'broadcast attempt'`
 * verbatim (no routeLabel prefix — the `event:` field is the discriminator;
 * the message is just human readability).
 *
 * The returned closure accepts `extra?` for per-call payloads (tx_id and
 * block_num on success; freshAuthMechanism/consent_action on the custody
 * consent-op path). `extra` spreads BEFORE `outcome` + `event:` so the
 * helper's source-of-truth values win.
 *
 * `loggerInstance` is parameterized for unit-test injection — the default
 * binds to the module-scope `logger` re-exported from `../logger.js`.
 * Tests in `backend/tests/lib/broadcast-error.test.ts` pass a vi.fn-spied
 * logger to assert on the structured payload without depending on the
 * global logger's stdout drain.
 */
export function makeLogBroadcastAttempt(
  eventLabel: string,
  baseContext: LogContext,
  loggerInstance: { info: typeof logger.info; warn: typeof logger.warn } = logger,
): (outcome: AttemptOutcome, extra?: Record<string, unknown>) => void {
  return (outcome, extra) => {
    const fields = {
      ...baseContext,
      ...(extra ?? {}),
      // Authoritative fields placed AFTER `...extra` so a caller-supplied
      // `extra: { outcome: ..., event: ... }` cannot silently override the
      // helper's source-of-truth values. Same spread-after-literal
      // convention as `handleBroadcastError`'s round-4/5 holds.
      outcome,
      event: eventLabel,
    };
    if (outcome === 'success') {
      loggerInstance.info(fields, 'broadcast attempt');
    } else {
      loggerInstance.warn(fields, 'broadcast attempt');
    }
  };
}
