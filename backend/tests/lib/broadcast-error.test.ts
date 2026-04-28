import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import {
  handleBroadcastError,
  handleBroadcastErrorAmbiguous,
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
      { err, timeoutMs: 5000, user: 'alice', action: 'test' },
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
      { err, user: 'bob' },
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
      { err: timeoutErr, timeoutMs: 1500, author: 'charlie', permlink: 'p1', signer: 'admin' },
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
      { err: failErr, author: 'charlie', permlink: 'p1', signer: 'admin' },
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

  // Round-2 hold item #4 — handleBroadcastErrorAmbiguous dedicated entry
  // point delegates to handleBroadcastError with the narrowed opts. The
  // wrapper-side caller (withOrcidBindingLock 'unavailable' branch) uses
  // this entry point so it doesn't need to spread `forceAmbiguousOutcome:
  // true` into the helper opts itself. Pin the behavior so a regression
  // that diverges the two entry points (e.g. forgets to set the flag in
  // the alias) fails here.
  it('handleBroadcastErrorAmbiguous emits the same 504 envelope as forceAmbiguousOutcome:true on a non-timer error', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
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
  });
});
