// Construct an AbortSignal tied to an HTTP request's lifetime, used to drop
// queued argon2 waiters the instant the client disconnects (frees the slot
// for the next live caller instead of letting a dead request acquire it,
// run the full ~50ms argon2.verify, and release it against a torn-down
// socket).
//
// Why this isn't just `req.signal`: Node 20 / Express 5 do NOT expose
// `req.signal` natively (added in Node 22). We reconstruct the equivalent
// via the 'close' event. The `writableEnded` guard skips the abort when
// the handler has already completed cleanly — without it, every normal
// response would also abort(), which is harmless (fn has already run) but
// masks the "actual client disconnect" signal in debug logs.
//
// Extracted from the four routes (auth.ts, custody.ts, settings.ts,
// signup-verify.ts) that previously each defined this helper inline. The
// per-file duplication originally landed under a "no shared new file"
// scope constraint; this module is the later consolidation that removed it.

import type { Request, Response } from 'express';

/**
 * Wire an AbortSignal to the HTTP request lifetime. Aborts when the client
 * disconnects (the request's 'close' event fires) BEFORE the handler has
 * finished writing its response.
 *
 * Pass the returned signal as `runWithArgon2Slot(fn, { signal })` so a
 * queued argon2 waiter is dropped on disconnect — its slot then goes to
 * the next live waiter rather than being burned on a torn-down socket.
 *
 * Does NOT cancel an in-flight argon2 operation (argon2 is native and not
 * AbortSignal-aware); once fn() has started it runs to completion.
 */
export function requestAbortSignal(req: Request, res: Response): AbortSignal {
  const ac = new AbortController();
  req.once('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  return ac.signal;
}
