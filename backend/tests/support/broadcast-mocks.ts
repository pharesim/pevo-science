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
 *
 * Round-3 hold #6 (BACKEND-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION): `cause`
 * is declared `cause?: Error` to match the base `Error.cause?: unknown`
 * declaration. The pre-fix `cause: Error` (required, non-optional) made the
 * `new Error(...) as DhiveLikeError` cast unsound: a future refactor that
 * removed the runtime `err.cause = ...` assignment would leave callers
 * accessing `dhiveErr.cause.message` to crash at runtime with no
 * compile-time warning. Today's factory always populates `cause`; the
 * optional type lets the cast carry its weight if that ever changes.
 */
export interface DhiveLikeError extends Error {
  jse_shortmsg: string;
  jse_cause: string;
  info: Record<string, unknown>;
  cause?: Error;
}

/**
 * Round-3 hold #3 (BACKEND-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION): per-field
 * unique sentinels. The pre-fix factory set
 * `err.message === err.jse_shortmsg === opts.shortmsg` (one value reused) and
 * `err.cause.message === err.jse_cause === opts.cause` (another value reused).
 * A leak-assertion of the form `not.toContain(SHORT)` against that fixture
 * could not distinguish WHICH field leaked when failing, AND a regression
 * that re-introduced interpolation of only one of two same-value fields
 * (e.g. `err.jse_shortmsg` but not `err.message`) would pass spuriously
 * because both fields share the marker.
 *
 * Callers may pass distinct per-field markers (`messageMarker`,
 * `jseShortMsgMarker`, `causeMarker`, `jseCauseMarker`); any field left
 * undefined is auto-populated with a per-field-unique marker derived from
 * `shortmsg` / `cause` plus a field-name suffix. This way the existing
 * 2-marker test ergonomics still work but each leak channel is checkable
 * independently.
 *
 * `shortmsg` and `cause` remain the primary "human-readable" inputs and seed
 * both the per-field markers (when not explicitly overridden) and the
 * `err.message` / `err.cause.message` strings. Test sites should assert
 * `not.toContain(...)` against EACH of the 4 returned per-field markers, not
 * just the original `shortmsg` / `cause` values, so a single-field leak
 * surfaces against the field's own marker.
 */
export interface DhiveLikeErrorMarkers {
  /** Marker on `err.message` (string passed to `new Error(...)`). */
  messageMarker: string;
  /** Marker on `err.jse_shortmsg`. */
  jseShortMsgMarker: string;
  /** Marker on `err.cause.message`. */
  causeMarker: string;
  /** Marker on `err.jse_cause`. */
  jseCauseMarker: string;
}

export function makeDhiveLikeError(opts: {
  shortmsg: string;
  cause: string;
  info?: Record<string, unknown>;
  /** Optional override for `err.message`. Defaults to `${shortmsg}::message`. */
  messageMarker?: string;
  /** Optional override for `err.jse_shortmsg`. Defaults to `${shortmsg}::jse_shortmsg`. */
  jseShortMsgMarker?: string;
  /** Optional override for `err.cause.message`. Defaults to `${cause}::cause_message`. */
  causeMarker?: string;
  /** Optional override for `err.jse_cause`. Defaults to `${cause}::jse_cause`. */
  jseCauseMarker?: string;
}): DhiveLikeError & DhiveLikeErrorMarkers {
  const messageMarker = opts.messageMarker ?? `${opts.shortmsg}::message`;
  const jseShortMsgMarker = opts.jseShortMsgMarker ?? `${opts.shortmsg}::jse_shortmsg`;
  const causeMarker = opts.causeMarker ?? `${opts.cause}::cause_message`;
  const jseCauseMarker = opts.jseCauseMarker ?? `${opts.cause}::jse_cause`;
  const err = new Error(messageMarker) as DhiveLikeError & DhiveLikeErrorMarkers;
  err.name = 'RPCError';
  err.jse_shortmsg = jseShortMsgMarker;
  err.jse_cause = jseCauseMarker;
  err.info = opts.info ?? {};
  err.cause = new Error(causeMarker);
  // Surface the chosen markers on the returned object so test sites can
  // assert leak-by-field without re-deriving the marker strings.
  err.messageMarker = messageMarker;
  err.jseShortMsgMarker = jseShortMsgMarker;
  err.causeMarker = causeMarker;
  err.jseCauseMarker = jseCauseMarker;
  return err;
}
