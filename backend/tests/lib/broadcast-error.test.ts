import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import {
  handleBroadcastError,
  handleBroadcastErrorAmbiguous,
  PostBroadcastWriteError,
} from '../../src/lib/broadcast-error.js';
import { BroadcastTimeoutError } from '../../src/hive.js';
import { logger } from '../../src/logger.js';

function mockResponse() {
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('handleBroadcastError', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends 504 BROADCAST_TIMEOUT envelope on BroadcastTimeoutError and logs warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new BroadcastTimeoutError(5000);

    const outcome = handleBroadcastError(res, err, {
      timeoutMsg: 'Broadcasting timed out',
      failMsg: 'Failed',
      logContext: { user: 'alice', action: 'test' },
      routeLabel: 'test.route',
    });

    expect(outcome).toBe('timeout');
    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      error: {
        code: 'BROADCAST_TIMEOUT',
        message: 'Broadcasting timed out',
        details: {
          retriable: false,
          outcome: 'uncertain',
          verify_before_retry: true,
          timeout_ms: 5000,
        },
      },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      { err, timeoutMs: 5000, user: 'alice', action: 'test', event: 'broadcast_timeout' },
      'test.route broadcast timed out',
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('sends 502 BROADCAST_FAILED envelope on generic Error and logs error', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new Error('chain rejected op');

    const outcome = handleBroadcastError(res, err, {
      timeoutMsg: 'Broadcasting timed out',
      failMsg: 'Failed to broadcast',
      logContext: { user: 'bob' },
      routeLabel: 'test.route',
    });

    expect(outcome).toBe('failure');
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      error: {
        code: 'BROADCAST_FAILED',
        message: 'Failed to broadcast',
        details: { retriable: false },
      },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      { err, user: 'bob', event: 'broadcast_failed' },
      'test.route broadcast failed',
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes verifyLocation through to the 504 envelope when provided', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new BroadcastTimeoutError(3000);

    handleBroadcastError(res, err, {
      timeoutMsg: 'Timed out',
      failMsg: 'Failed',
      logContext: {},
      verifyLocation: '/settings',
      routeLabel: 'orcid.handleAccredit',
    });

    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      error: {
        code: 'BROADCAST_TIMEOUT',
        message: 'Timed out',
        details: {
          retriable: false,
          outcome: 'uncertain',
          verify_before_retry: true,
          timeout_ms: 3000,
          verify_location: '/settings',
        },
      },
    });
  });

  it('omits verify_location from the 504 envelope when not provided', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new BroadcastTimeoutError(2000);

    handleBroadcastError(res, err, {
      timeoutMsg: 'Timed out',
      failMsg: 'Failed',
      logContext: {},
      routeLabel: 'papers.retract',
    });

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error.details).not.toHaveProperty('verify_location');
    expect(body.error.details).toEqual({
      retriable: false,
      outcome: 'uncertain',
      verify_before_retry: true,
      timeout_ms: 2000,
    });
  });

  it('merges logContext fields into both log calls', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);

    // timeout path
    const resTimeout = mockResponse();
    const timeoutErr = new BroadcastTimeoutError(1500);
    handleBroadcastError(resTimeout, timeoutErr, {
      timeoutMsg: 'T',
      failMsg: 'F',
      logContext: { author: 'charlie', permlink: 'p1', signer: 'admin' },
      routeLabel: 'claims.revoke',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      { err: timeoutErr, timeoutMs: 1500, author: 'charlie', permlink: 'p1', signer: 'admin', event: 'broadcast_timeout' },
      'claims.revoke broadcast timed out',
    );

    // failure path
    const resFail = mockResponse();
    const failErr = new Error('boom');
    handleBroadcastError(resFail, failErr, {
      timeoutMsg: 'T',
      failMsg: 'F',
      logContext: { author: 'charlie', permlink: 'p1', signer: 'admin' },
      routeLabel: 'claims.revoke',
    });
    expect(errorSpy).toHaveBeenCalledWith(
      { err: failErr, author: 'charlie', permlink: 'p1', signer: 'admin', event: 'broadcast_failed' },
      'claims.revoke broadcast failed',
    );
  });

  // Round-2 hold item #1 — discriminated-union regression guard. The
  // `HandleBroadcastErrorOpts` type now requires `ambiguousMsg: string` when
  // `forceAmbiguousOutcome: true` (the round-1 `ambiguousMsg ?? failMsg`
  // fallback was the silent-regression class round-2 closes). A future caller
  // bypassing the type system (`as any` cast, JSON-deserialised opts, etc.)
  // and setting `forceAmbiguousOutcome: true` without `ambiguousMsg` is the
  // only way the helper can still observe the missing field; the regression
  // would surface as `undefined` in the user-facing 504 message instead of a
  // (now-impossible) silent fallback to `failMsg`. This test pins the
  // observable behavior on that bypass: NO leak of `failMsg` ("Failed to
  // broadcast …") through the ambiguous path. A regression that re-introduces
  // the `?? failMsg` fallback would fail the `not.toMatch(/^Failed to/i)`
  // assertion below.
  it('does NOT fall back to failMsg when ambiguousMsg is missing on the forceAmbiguousOutcome path (type-bypass regression guard)', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new Error('rpc reject under degraded redis');

    // Type-bypassed opts: forceAmbiguousOutcome:true with no ambiguousMsg.
    // Under the discriminated union this is a compile error; the cast lets
    // the test exercise the runtime branch a future bypass might reach.
    const optsBypass = {
      timeoutMsg: 'T',
      failMsg: 'Failed to broadcast — DO NOT LEAK THIS',
      logContext: {},
      routeLabel: 'test.route',
      forceAmbiguousOutcome: true,
    } as unknown as Parameters<typeof handleBroadcastError>[2];

    handleBroadcastError(res, err, optsBypass);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error.code).toBe('BROADCAST_TIMEOUT');
    // The CRITICAL assertion: `failMsg` MUST NOT surface as the user-facing
    // message on the ambiguous path. The discriminated union dropped the
    // `?? failMsg` fallback, so the helper now reads `opts.ambiguousMsg`
    // directly — undefined when the field was bypassed, NOT silently
    // substituted with `failMsg`. A regression that re-introduces the
    // `?? failMsg` fallback would set body.error.message to "Failed to
    // broadcast — DO NOT LEAK THIS" and fail this assertion.
    if (typeof body.error.message === 'string') {
      expect(body.error.message).not.toMatch(/^Failed to broadcast/i);
    } else {
      // undefined is the expected runtime shape under bypass — pin it.
      expect(body.error.message).toBeUndefined();
    }
  });

  // BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION — broadcast-succeeded
  // vs broadcast-threw discrimination matrix at the helper level. Three
  // cases per the architect-required acceptance #5:
  //
  //   Case A — broadcast threw (covered by existing
  //   "sends 502 BROADCAST_FAILED envelope on generic Error" + "sends 504
  //   BROADCAST_TIMEOUT envelope on BroadcastTimeoutError" specs above).
  //   The 502/504 envelopes are unchanged by this discrimination; the new
  //   POST_BROADCAST_FAILED envelope ONLY fires when `err instanceof
  //   PostBroadcastWriteError`.
  //
  //   Case B — broadcast succeeded, cache_write threw → 502
  //   POST_BROADCAST_FAILED with `outcome:'confirmed'`,
  //   `failed_step:'cache_write'`, tx_id matches the constructor input.
  //
  //   Case C — broadcast succeeded, account_update threw → same envelope,
  //   `failed_step:'account_update'`. (The `'reputation_seed'` step is
  //   reserved for handleAccredit's third cascade step; the integration
  //   spec exercises 'account_update' end-to-end via __test_seams.)
  //
  // The user-facing message is constructed via `postBroadcastMsgFn` when
  // supplied; tests pass an ORCID-shape function and assert it surfaces
  // (regression guard against a regression that drops the function-supplied
  // message in favor of a hardcoded fallback). Round-1 hold #7 renamed
  // `postBroadcastFailedMsgFn` → `postBroadcastMsgFn`; #1 narrowed the step
  // union to drop `'unknown'`; #4 changed the return value for this branch
  // from `'failure'` to `'post_broadcast'` so callers can distinguish
  // chain-rejected from confirmed-on-chain-but-cascade-failed.
  it('discriminates PostBroadcastWriteError → 502 POST_BROADCAST_FAILED with outcome:confirmed (case B — failed_step:cache_write)', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new PostBroadcastWriteError('hive-tx-abc-123', new Error('redis flap on binding cache'), 'cache_write');

    const outcome = handleBroadcastError(res, err, {
      timeoutMsg: 'Timed out',
      failMsg: 'Failed (should not surface)',
      logContext: { case: 'B' },
      verifyLocation: '/settings',
      routeLabel: 'orcid.handleAccredit',
      postBroadcastMsgFn: (failedStep) =>
        failedStep === 'cache_write'
          ? 'Your ORCID is verified on Hive. A backend cache write failed; it will repopulate on the next request that uses your ORCID binding.'
          : 'should not surface',
    });

    expect(outcome).toBe('post_broadcast');
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      error: {
        code: 'POST_BROADCAST_FAILED',
        message: 'Your ORCID is verified on Hive. A backend cache write failed; it will repopulate on the next request that uses your ORCID binding.',
        details: {
          retriable: false,
          outcome: 'confirmed',
          tx_id: 'hive-tx-abc-123',
          failed_step: 'cache_write',
        },
      },
    });
    // No verify_location on POST_BROADCAST_FAILED: the chain op IS the
    // source of truth; nothing to verify before retry. NO verify_before_retry
    // either — recovery is per-step (cache_write repopulates on next request,
    // reputation_seed reconciles via the next batch cycle, account_update
    // requires a HAF-replay or manual reconcile).
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error.details).not.toHaveProperty('verify_location');
    expect(body.error.details).not.toHaveProperty('verify_before_retry');
  });

  it('discriminates PostBroadcastWriteError → 502 POST_BROADCAST_FAILED with failed_step:account_update (case C)', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new PostBroadcastWriteError('hive-tx-xyz-456', new Error('pg pool exhausted'), 'account_update');

    handleBroadcastError(res, err, {
      timeoutMsg: 'T',
      failMsg: 'F',
      logContext: { case: 'C' },
      routeLabel: 'orcid.handleLink',
      postBroadcastMsgFn: (failedStep) =>
        failedStep === 'account_update'
          ? 'Your ORCID is linked on Hive. A backend account update failed; the chain record is the source of truth, and login still works.'
          : 'should not surface',
    });

    expect(res.status).toHaveBeenCalledWith(502);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error.code).toBe('POST_BROADCAST_FAILED');
    expect(body.error.details).toEqual({
      retriable: false,
      outcome: 'confirmed',
      tx_id: 'hive-tx-xyz-456',
      failed_step: 'account_update',
    });
    expect(body.error.message).toMatch(/account update failed/);
  });

  it('discriminates PostBroadcastWriteError → 502 POST_BROADCAST_FAILED with failed_step:reputation_seed (case D — handleAccredit-only third step, no msg fn → sanitized fallback)', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new PostBroadcastWriteError('hive-tx-def-789', new Error('reputation cache write failed'), 'reputation_seed');

    handleBroadcastError(res, err, {
      timeoutMsg: 'T',
      failMsg: 'F',
      logContext: {},
      routeLabel: 'orcid.handleAccredit',
    });

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error.details.failed_step).toBe('reputation_seed');
    // No postBroadcastMsgFn supplied → helper falls back to the sanitized
    // default. Round-1 hold #9: the default MUST NOT leak the internal step
    // label ('reputation_seed' / 'cache_write' are operator vocabulary, not
    // user-facing). Pin the txId reference and the absence of the step label.
    expect(body.error.message).toContain('hive-tx-def-789');
    expect(body.error.message).not.toContain('reputation_seed');
    expect(body.error.message).not.toContain('cache_write');
    expect(body.error.message).not.toContain('account_update');
    expect(body.error.message).toContain('confirmed on Hive');
  });

  // Round-1 hold #2 — `postBroadcastMsgFn` is application code that can
  // throw. Letting an exception escape `handleBroadcastError` here would skip
  // `sendError`, propagate to the route's outer catch as a generic 500
  // INTERNAL_ERROR, and (on the ORCID surface) consume the OAuth state token
  // — the exact hard-block class the wrapper exists to prevent. The helper
  // catches the throw, logs a warn line (with the routeLabel-prefixed
  // operator-alert anchor), and falls back to the sanitized default.
  it('survives postBroadcastMsgFn throwing — falls back to sanitized default + logs warn anchor', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new PostBroadcastWriteError('hive-tx-msgfn-throws', new Error('cascade boom'), 'account_update');
    const innerErr = new TypeError('mid-rotation logger inside the template');

    const outcome = handleBroadcastError(res, err, {
      timeoutMsg: 'T',
      failMsg: 'F',
      logContext: { run: 'msgfn-throws' },
      routeLabel: 'orcid.handleAccredit',
      postBroadcastMsgFn: () => {
        throw innerErr;
      },
    });

    // Outcome is still 'post_broadcast' — the message-fn throw is recovered
    // internally; the chain op is still confirmed; the wire envelope still
    // discriminates from chain-rejection.
    expect(outcome).toBe('post_broadcast');
    expect(res.status).toHaveBeenCalledWith(502);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error.code).toBe('POST_BROADCAST_FAILED');
    expect(body.error.message).toContain('hive-tx-msgfn-throws');
    expect(body.error.message).not.toContain('account_update');

    // The error anchor (post-broadcast write failed) still fires for the
    // primary cascade failure; the warn is the message-fn-threw anchor.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ run: 'msgfn-throws', err, txId: 'hive-tx-msgfn-throws', failedStep: 'account_update' }),
      'orcid.handleAccredit broadcast confirmed but post-broadcast write failed',
    );
    // Round-3 hold #3: pin the structured `event` field literal so the
    // operator-dashboard contract is load-bearing (a regression dropping or
    // renaming the event slips through a message-text assertion).
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: innerErr,
        txId: 'hive-tx-msgfn-throws',
        failedStep: 'account_update',
        event: 'post_broadcast_msg_fn_threw',
        run: 'msgfn-throws',
      }),
      'orcid.handleAccredit postBroadcastMsgFn threw — using generic fallback',
    );
  });

  it('PostBroadcastWriteError discrimination fires BEFORE BroadcastTimeoutError + forceAmbiguousOutcome branches', () => {
    // Adversarial case: a PostBroadcastWriteError whose `cause` happens to
    // be a BroadcastTimeoutError. The discrimination order matters — the
    // `instanceof PostBroadcastWriteError` check MUST run first.
    //
    // Mutation kill mechanism (round-1 hold #8): the outer `err` is a
    // PostBroadcastWriteError, not a BroadcastTimeoutError — only its
    // `.cause` is. Removing the `instanceof PostBroadcastWriteError` branch
    // would NOT route here through the timer-fire branch (the
    // `err instanceof BroadcastTimeoutError` check fails on the wrapping
    // PostBroadcastWriteError); control would fall through to the
    // `forceAmbiguousOutcome` branch (which is `true` in this test's opts)
    // and emit a 504 BROADCAST_TIMEOUT envelope with `outcome:'uncertain'`.
    // Either way the wire envelope is wrong (chain op IS confirmed); pinning
    // 502 POST_BROADCAST_FAILED + outcome:'confirmed' kills both reorder
    // mutations.
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    // Reuse the BroadcastTimeoutError import at the top of the file.
    const innerCause = new BroadcastTimeoutError(30_000);
    const err = new PostBroadcastWriteError('hive-tx-mixed', innerCause, 'account_update');

    const outcome = handleBroadcastError(res, err, {
      timeoutMsg: 'T (should not surface)',
      failMsg: 'F (should not surface)',
      ambiguousMsg: 'Ambiguous (should not surface)',
      forceAmbiguousOutcome: true,
      logContext: {},
      routeLabel: 'orcid.handleAccredit',
    });

    expect(outcome).toBe('post_broadcast');
    expect(res.status).toHaveBeenCalledWith(502);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error.code).toBe('POST_BROADCAST_FAILED');
    // Critical: NOT 504 BROADCAST_TIMEOUT (the cause was a
    // BroadcastTimeoutError but the wrapping PostBroadcastWriteError takes
    // precedence — chain op IS confirmed).
    expect(body.error.code).not.toBe('BROADCAST_TIMEOUT');
    expect(body.error.details.outcome).toBe('confirmed');
    expect(body.error.details).not.toHaveProperty('timeout_ms');
    // Native ES2022 Error.cause forwarding (round-1 hold #6). The PostBroadcast-
    // WriteError constructor passes `cause` through `super(msg, { cause })`, so
    // `err.cause` is the inherited slot, not a shadowing class field. pino's
    // error serializer and any structured-clone consumer reads it from there.
    expect(err.cause).toBe(innerCause);
  });

  // Round-2 hold item #4 — handleBroadcastErrorAmbiguous dedicated entry
  // point delegates to handleBroadcastError with the narrowed opts. The
  // wrapper-side caller (withOrcidBindingLock 'unavailable' branch) uses
  // this entry point so it doesn't need to spread `forceAmbiguousOutcome:
  // true` into the helper opts itself. Pin the behavior so a regression
  // that diverges the two entry points (e.g. forgets to set the flag in
  // the alias) fails here.
  it('handleBroadcastErrorAmbiguous emits the same 504 envelope as forceAmbiguousOutcome:true on a non-timer error', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new Error('rpc reject');

    const outcome = handleBroadcastErrorAmbiguous(res, err, {
      timeoutMsg: 'Timed out',
      failMsg: 'Failed (should not surface)',
      ambiguousMsg: 'Outcome uncertain — verify before retrying',
      logContext: { run: 'item-4' },
      verifyLocation: '/settings',
      routeLabel: 'test.route',
      forceAmbiguousOutcome: true,
    });

    expect(outcome).toBe('failure');
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body).toEqual({
      status: 'error',
      error: {
        code: 'BROADCAST_TIMEOUT',
        message: 'Outcome uncertain — verify before retrying',
        details: {
          retriable: false,
          outcome: 'uncertain',
          verify_before_retry: true,
          verify_location: '/settings',
        },
      },
    });
    // timeout_ms is omitted on the non-timer ambiguous branch (canonical
    // discriminator: present iff the underlying throw was a
    // BroadcastTimeoutError; see api-contracts/common.md).
    expect(body.error.details).not.toHaveProperty('timeout_ms');

    // Round-3 hold item #2 — operator-alert anchor MUST fire at the unit
    // layer, not just at the integration layer (orcid.test.ts). The third
    // stable log-message suffix (`<routeLabel> broadcast failed on
    // ambiguous-outcome path`, logger.error) is documented in the helper's
    // docblock as a load-bearing alert anchor. A mutation that renames the
    // suffix in the `forceAmbiguousOutcome` branch passes the integration-
    // layer log-suffix filter only because that filter runs inside an
    // unrelated route's mock — at the unit-under-test layer the suffix has
    // had no assertion until now. Pin it.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ run: 'item-4', err, event: 'broadcast_ambiguous' }),
      'test.route broadcast failed on ambiguous-outcome path',
    );
  });

  // BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION round-4 hold #1: the
  // `event:` field MUST be placed AFTER `...opts.logContext` in the helper's
  // log payload so a caller that (intentionally or by accident) supplies
  // `logContext: { event: 'attacker' }` cannot override the dashboard-keyable
  // anchor literal. JS object literal later-wins semantics — the rightmost
  // property assignment wins. Mutation kill: moving `event:` BEFORE the
  // spread re-exposes the override regression, and these specs fail.
  it('post_broadcast_write_failed event literal wins over a colliding logContext.event field (round-4 hold #1)', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const cause = new Error('redis flap');
    const err = new PostBroadcastWriteError('hive-tx-spread-override-1', cause, 'cache_write');

    handleBroadcastError(res, err, {
      timeoutMsg: 'Timed out',
      failMsg: 'Failed',
      // Adversarial caller-supplied `event:` field — should NOT win.
      logContext: { event: 'caller_override_attempt', run: 'spread-kill-1' },
      routeLabel: 'orcid.handleAccredit',
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'post_broadcast_write_failed',
        run: 'spread-kill-1',
      }),
      'orcid.handleAccredit broadcast confirmed but post-broadcast write failed',
    );
    // Belt-and-suspenders: the colliding caller value MUST NOT have leaked
    // through to the operator anchor. A literal-shape negative assertion
    // catches the regression even if a future refactor reorders fields.
    const callArgs = errorSpy.mock.calls[0][0] as { event: string };
    expect(callArgs.event).toBe('post_broadcast_write_failed');
    expect(callArgs.event).not.toBe('caller_override_attempt');
  });

  it('post_broadcast_msg_fn_threw event literal wins over a colliding logContext.event field (round-4 hold #1)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const cause = new Error('pool exhausted');
    const err = new PostBroadcastWriteError('hive-tx-spread-override-2', cause, 'account_update');

    handleBroadcastError(res, err, {
      timeoutMsg: 'Timed out',
      failMsg: 'Failed',
      logContext: { event: 'caller_override_attempt', run: 'spread-kill-2' },
      routeLabel: 'orcid.handleAccredit',
      // Force the msg-fn-threw branch so the warn anchor fires.
      postBroadcastMsgFn: () => {
        throw new Error('msg fn boom');
      },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'post_broadcast_msg_fn_threw',
        run: 'spread-kill-2',
      }),
      'orcid.handleAccredit postBroadcastMsgFn threw — using generic fallback',
    );
    const callArgs = warnSpy.mock.calls[0][0] as { event: string };
    expect(callArgs.event).toBe('post_broadcast_msg_fn_threw');
    expect(callArgs.event).not.toBe('caller_override_attempt');
  });

  // BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION round-5 hold #1: extends
  // the round-4 spread-kill protection from the `event:` field to the
  // sibling source-of-truth fields (`err`, `txId`, `failedStep`). Same JS
  // later-wins mechanic, same caller-override exposure: a future caller
  // dropping a key like `failedStep` into `logContext` would mis-route
  // operator alerts to the wrong cascade step while the wire envelope still
  // uses `err.failedStep`. Round-4 closed this for `event:` only; round-5
  // closes it for the remaining fields. Pattern matches the existing event:
  // spread-kill specs above.
  //
  // Round-3 hold #1 of BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT
  // dropped the redundant top-level `cause: err.cause` field that bypassed
  // both redaction layers. The recursive `cause` traversal in
  // `redactErrSerializer` now preserves the redacted cause inside `err.cause`
  // of the serialized payload, which is the correct surface to assert. The
  // `cause`-override negative still has value as a no-leak assertion: even
  // though the helper does not emit a top-level `cause:` field anymore,
  // a future regression that re-introduced one (or that copied caller-
  // supplied `logContext.cause` into the payload via spread) would let the
  // caller-override value surface alongside `err`. Pin the absence here.
  it('post_broadcast_write_failed authoritative fields win over colliding logContext keys (round-5 hold #1)', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const realCause = new Error('redis flap (real)');
    const err = new PostBroadcastWriteError('hive-tx-real', realCause, 'reputation_seed');

    // Round-4 hold #3 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
    // re-adds the `cause: 'caller-override-cause'` adversarial fixture that
    // round-3 dropped. The architect's hold called out the regression:
    // round-3 closed the helper-emitted top-level `cause: err.cause` field
    // (the bypass-both-redaction-layers leak), but the spread of caller-
    // supplied `opts.logContext` had no symmetric `cause: undefined` strip.
    // A future caller adding `cause` to its `logContext` (intentionally or
    // by TypeScript-bypass — the `LogContext` interface does NOT declare a
    // `cause` field, so this is a `as unknown as LogContext`-shaped vector)
    // would land a top-level sibling on the log object outside both
    // redaction layers. Round-4 closes that vector at the function entry
    // (`sanitizedLogContext`); this fixture pins the negative invariant
    // the fix is supposed to guarantee. The cast through `as unknown as
    // Parameters<typeof handleBroadcastError>[2]` mirrors the type-bypass
    // shape the round-2 ambiguous-message regression-guard test uses.
    const optsBypass = {
      timeoutMsg: 'Timed out',
      failMsg: 'Failed',
      // Adversarial caller-supplied colliding values — none of the
      // helper-authoritative ones (`err`, `cause`, `txId`, `failedStep`)
      // should win. `cause` is the round-4 hold #3 adversarial vector
      // re-added in this fixture.
      logContext: {
        err: 'caller-override-err',
        cause: 'caller-override-cause',
        txId: 'caller-override-tx',
        failedStep: 'caller-override-step',
        run: 'spread-kill-r5-1',
      },
      routeLabel: 'orcid.handleAccredit',
    } as unknown as Parameters<typeof handleBroadcastError>[2];
    handleBroadcastError(res, err, optsBypass);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'post_broadcast_write_failed',
        run: 'spread-kill-r5-1',
      }),
      'orcid.handleAccredit broadcast confirmed but post-broadcast write failed',
    );
    const callArgs = errorSpy.mock.calls[0][0] as {
      err: unknown;
      cause?: unknown;
      txId: unknown;
      failedStep: unknown;
    };
    // Positive: helper's source-of-truth values surface.
    expect(callArgs.err).toBe(err);
    expect(callArgs.txId).toBe('hive-tx-real');
    expect(callArgs.failedStep).toBe('reputation_seed');
    // Round-3 hold #1 of BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT:
    // the helper no longer emits a top-level sibling `cause: err.cause`
    // field — that field bypassed both redaction layers. Round-4 hold #3
    // extends the same protection to caller-supplied `cause` via the
    // `sanitizedLogContext` strip at the function entry. Pin the absence
    // of a top-level `cause` here: a regression that either (a) re-adds
    // `cause: err.cause` after the spread or (b) drops the
    // `sanitizedLogContext` strip and re-spreads `opts.logContext`
    // directly would re-introduce the leak path. Mutation kill: removing
    // the destructure or changing the spread back to `...opts.logContext`
    // makes `callArgs.cause` equal `'caller-override-cause'` instead of
    // `undefined`.
    expect(callArgs.cause).toBeUndefined();
    // Negative: caller-supplied colliding values for the helper's
    // authoritative fields MUST NOT leak through.
    expect(callArgs.err).not.toBe('caller-override-err');
    expect(callArgs.txId).not.toBe('caller-override-tx');
    expect(callArgs.failedStep).not.toBe('caller-override-step');
  });

  it('post_broadcast_msg_fn_threw authoritative fields win over colliding logContext keys (round-5 hold #1)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const realCause = new Error('pool exhausted (real)');
    const err = new PostBroadcastWriteError('hive-tx-real-2', realCause, 'cache_write');
    const innerMsgErr = new TypeError('msg-fn template throw');

    handleBroadcastError(res, err, {
      timeoutMsg: 'Timed out',
      failMsg: 'Failed',
      logContext: {
        err: 'caller-override-err',
        cause: 'caller-override-cause',
        txId: 'caller-override-tx',
        failedStep: 'caller-override-step',
        run: 'spread-kill-r5-2',
      },
      routeLabel: 'orcid.handleAccredit',
      postBroadcastMsgFn: () => {
        throw innerMsgErr;
      },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'post_broadcast_msg_fn_threw',
        run: 'spread-kill-r5-2',
      }),
      'orcid.handleAccredit postBroadcastMsgFn threw — using generic fallback',
    );
    const callArgs = warnSpy.mock.calls[0][0] as {
      err: unknown;
      txId: unknown;
      failedStep: unknown;
      cause?: unknown;
    };
    // Positive: the msg-fn-threw anchor binds `err` to the INNER msg-fn
    // throw (the template error), NOT the outer PostBroadcastWriteError.
    // Pino's serializer renders this as the primary error; the outer error
    // is still on chain and recoverable, the template bug is what needs
    // operator attention.
    expect(callArgs.err).toBe(innerMsgErr);
    expect(callArgs.txId).toBe('hive-tx-real-2');
    expect(callArgs.failedStep).toBe('cache_write');
    // Negative: caller-supplied colliding values MUST NOT leak through.
    expect(callArgs.err).not.toBe('caller-override-err');
    expect(callArgs.txId).not.toBe('caller-override-tx');
    expect(callArgs.failedStep).not.toBe('caller-override-step');
    // Round-5 hold #6 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
    // pin the absence of a top-level `cause` field on the msg-fn-threw
    // anchor too — round-4's centralized destructure inherit-protects every
    // spread site, but the previous test only pinned the protection on ONE
    // (the post_broadcast_write_failed spec above). A regression that
    // reverted only the warn-site spread back to `...opts.logContext` while
    // leaving the error-site sanitized would leave `callArgs.cause ===
    // 'caller-override-cause'` here with no failing assertion. The
    // type-bypass via `as unknown as Parameters<...>[2]` at the fixture
    // (above) carries the adversarial `cause: 'caller-override-cause'`
    // value into the helper; the destructure at broadcast-error.ts MUST
    // strip it before the spread.
    expect(callArgs.cause).toBeUndefined();
  });

  // Round-5 hold #2: dedicated event-anchor pin for the 3 sibling logger
  // sites that previously had no structured `event:` discriminator. The
  // existing tests above already pin `event: 'broadcast_timeout'` (line ~52,
  // BroadcastTimeoutError happy path), `event: 'broadcast_failed'` (line ~82,
  // generic Error path), and `event: 'broadcast_ambiguous'` (line ~499,
  // forceAmbiguousOutcome path) under exact-match `toHaveBeenCalledWith`
  // payloads. Those exact-match assertions are stricter than `objectContaining`
  // because they fail if the helper emits extra unexpected keys. The dedicated
  // specs below add `objectContaining` pins per the architect's prescription
  // shape — they double-cover the same anchors so a future test refactor that
  // loosens the exact-match shape (e.g. adding more keys) doesn't accidentally
  // drop the event-literal assertion.
  it('event:"broadcast_timeout" pinned on the timer-fire anchor (round-5 hold #2)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new BroadcastTimeoutError(2500);

    handleBroadcastError(res, err, {
      timeoutMsg: 'T',
      failMsg: 'F',
      logContext: { run: 'event-pin-timeout' },
      routeLabel: 'test.route',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'broadcast_timeout', run: 'event-pin-timeout' }),
      'test.route broadcast timed out',
    );
  });

  it('event:"broadcast_ambiguous" pinned on the forceAmbiguousOutcome anchor (round-5 hold #2)', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new Error('rpc reject under degraded redis');

    handleBroadcastError(res, err, {
      timeoutMsg: 'T',
      failMsg: 'F',
      ambiguousMsg: 'Outcome uncertain',
      forceAmbiguousOutcome: true,
      logContext: { run: 'event-pin-ambiguous' },
      routeLabel: 'test.route',
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'broadcast_ambiguous', run: 'event-pin-ambiguous' }),
      'test.route broadcast failed on ambiguous-outcome path',
    );
  });

  it('event:"broadcast_failed" pinned on the standard 502 anchor (round-5 hold #2)', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
    const res = mockResponse();
    const err = new Error('chain rejected');

    handleBroadcastError(res, err, {
      timeoutMsg: 'T',
      failMsg: 'F',
      logContext: { run: 'event-pin-failed' },
      routeLabel: 'test.route',
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'broadcast_failed', run: 'event-pin-failed' }),
      'test.route broadcast failed',
    );
  });
});
