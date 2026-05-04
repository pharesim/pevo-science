/**
 * Shared `BroadcastTimeoutError` mock substitute used across route tests that
 * exercise the 504/502 broadcast-discrimination path in
 * `lib/broadcast-error.ts:handleBroadcastError`.
 *
 * Why this lives in a shared module (round-2 hold #1):
 * Both `tests/routes/bridge.test.ts` and `tests/routes/custody.test.ts` mock
 * `'../../src/hive.js'` and substitute `BroadcastTimeoutError` so a
 * `mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000))` triggers the
 * helper's `instanceof BroadcastTimeoutError` branch. For the substitution to
 * work, the helper's imported reference and the test's "throw it" reference
 * MUST resolve to the SAME class identity. `vi.hoisted` + `vi.mock` give us
 * that today (the mock factory runs before `lib/broadcast-error.ts` imports
 * `hive.js`), but a future refactor that introduces a re-export barrel, a
 * top-level import preempting the hoist, or a test-side `import` ordering
 * change can break the chain silently — the route would emit 502 on a real
 * timeout and every 504-discrimination spec would pass against the wrong
 * branch.
 *
 * Centralizing the mock class here:
 *   1. Eliminates duplication between the two test files (same 9-line stub).
 *   2. Gives both test files a single canonical reference (the import) for
 *      the structural identity assertion mounted at the top of each
 *      `describe`: `expect(BroadcastTimeoutError).toBe(MockBroadcastTimeoutError)`
 *      where `BroadcastTimeoutError` is dynamically imported from
 *      `'../../src/hive.js'` AFTER the route module's `vi.mock` has run. If
 *      the substitution chain breaks, that single assertion fails and the
 *      regression class surfaces immediately instead of producing silent
 *      false-passes across every 504 spec.
 *
 * The class shape mirrors the real `BroadcastTimeoutError` (constructor takes
 * `timeoutMs: number`; sets `name = 'BroadcastTimeoutError'`); pino's error
 * serializer and the `instanceof` check both rely on those.
 */

export class MockBroadcastTimeoutError extends Error {
  public readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Hive broadcast timed out after ${timeoutMs}ms`);
    this.name = 'BroadcastTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Builder for a dhive/VError-shaped chain rejection. Real `@hiveio/dhive`
 * RPCError instances carry `jse_shortmsg` / `jse_cause` / `info` fields (the
 * pre-migration response body interpolated `err.jse_shortmsg` ahead of
 * `err.message`). Tests pass `new Error(CHAIN_INTERNAL)` against the
 * leak-assertion `JSON.stringify(res.body).not.toContain(CHAIN_INTERNAL)`,
 * which passes by construction because the response body is a static string
 * regardless of the throw shape. Round-2 hold #3: at least one spec per route
 * stages a rejection with this real-shape so the leak-assertion has actual
 * surface to catch a regression that re-introduces interpolation of any of
 * these fields.
 *
 * Properties match the dhive RPCError surface as observed in the round-1
 * pre-migration code path; `cause` carries the upstream `Error` so a future
 * pino serializer change that walks `cause` chains does not silently leak the
 * underlying message either.
 */
export interface DhiveLikeError extends Error {
  jse_shortmsg: string;
  jse_cause: string;
  info: Record<string, unknown>;
  cause: Error;
}

export function makeDhiveLikeError(opts: {
  shortmsg: string;
  cause: string;
  info?: Record<string, unknown>;
}): DhiveLikeError {
  const err = new Error(opts.shortmsg) as DhiveLikeError;
  err.name = 'RPCError';
  err.jse_shortmsg = opts.shortmsg;
  err.jse_cause = opts.cause;
  err.info = opts.info ?? {};
  err.cause = new Error(opts.cause);
  return err;
}
