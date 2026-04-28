/**
 * Library-level tests for `requestAbortSignal` (backend/src/lib/request-abort-signal.ts).
 *
 * Locks the writableEnded guard contract: a 'close' event after the
 * response has already been written cleanly MUST NOT fire `ac.abort()`.
 * Without the guard, every normal request completion would also abort the
 * controller (harmless, but it masks real client-disconnect signals in
 * debug logs and creates a confusing observability story for operators
 * triaging argon2-abort spikes).
 *
 * No real network or DB. We construct minimal `req` (an EventEmitter with
 * the `once` method the helper subscribes to) and `res` (a writableEnded
 * boolean) doubles. The `signal.aborted` boolean is the public observable
 * that proves which branch fired.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { requestAbortSignal } from '../../src/lib/request-abort-signal.js';

function makeReq(): Request & EventEmitter {
  // EventEmitter satisfies the helper's `req.once('close', cb)` subscription.
  // Cast to Request ∩ EventEmitter — the helper only touches the EventEmitter
  // surface and we want the full type for the helper signature.
  return new EventEmitter() as unknown as Request & EventEmitter;
}

function makeRes(writableEnded: boolean): Response {
  return { writableEnded } as unknown as Response;
}

describe('requestAbortSignal — writableEnded guard', () => {
  it('aborts the controller when close fires while the response is still open (writableEnded=false)', () => {
    const req = makeReq();
    const res = makeRes(false);
    const signal = requestAbortSignal(req, res);

    expect(signal.aborted).toBe(false);

    // Simulate a client disconnect mid-handler (response not yet flushed).
    req.emit('close');

    expect(signal.aborted).toBe(true);
  });

  it('does NOT abort when close fires after the response has been written (writableEnded=true)', () => {
    const req = makeReq();
    const res = makeRes(true);
    const signal = requestAbortSignal(req, res);

    expect(signal.aborted).toBe(false);

    // Simulate the normal end-of-request 'close' that fires for every
    // completed response. The guard MUST suppress the abort here — without
    // it, every successful request would observably abort, polluting
    // operator dashboards with phantom client-disconnect signals.
    req.emit('close');

    expect(signal.aborted).toBe(false);
  });

  it('subscribes via `once` so a re-emitted close (e.g. duplicate event) cannot fire abort twice', () => {
    // The helper uses `req.once('close', ...)`, which inherently runs the
    // listener at most one time. Re-emitting close after writableEnded
    // flipped to true (the typical real-world race when a client
    // disconnects in the same tick the response flushes) MUST NOT change
    // the signal's aborted state once decided.
    const req = makeReq();
    const res = makeRes(false);
    const signal = requestAbortSignal(req, res);

    req.emit('close');
    expect(signal.aborted).toBe(true);

    // A second close emission triggers no listener — `once` already
    // unsubscribed. Abort stays sticky-true; no exception thrown.
    expect(() => req.emit('close')).not.toThrow();
    expect(signal.aborted).toBe(true);
  });
});
