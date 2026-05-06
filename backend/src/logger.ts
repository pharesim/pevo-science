import pino, { type LogFn } from 'pino';
import pinoHttp from 'pino-http';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// ── Request context (AsyncLocalStorage) ────────────────────
interface RequestContext {
  reqId: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/** Returns the current request ID, or 'no-request' outside an HTTP context. */
export function getRequestId(): string {
  return requestContext.getStore()?.reqId ?? 'no-request';
}

// ── Custom err serializer (redact policy) ──────────────────
//
// Pino's default `err` serializer enumerates ALL enumerable own properties of
// an error and copies them to the serialized payload (see
// pino-std-serializers/lib/err.js: `for (const key in err)`). This expands
// the err-object surface in operator logs to include any field a downstream
// library hangs off the error, which has produced two concrete leak surfaces
// in PEvO:
//
//   1. `AssertionError.actual` / `.expected` (from Node's `assert` module,
//      thrown by dhive's `PrivateKey.fromString` on malformed WIF input).
//      Buffer slices DERIVED from the WIF (with the network-ID byte and
//      4-byte checksum) reach operator logs. An attacker with read access
//      to the log stream (aggregation, archive, log-shipping SaaS) can
//      reconstruct the bridge admin posting key.
//
//   2. `ReplyError.command = { name, args }` (from ioredis on errors
//      propagated from a command call). For `redis.eval` of a Lua script,
//      `args[]` includes the script body + the key. PEvO's accreditation-
//      verify-attempts counter key contains the raw 64-hex verify token,
//      which is the SOLE credential at /api/accreditation/verify.
//
// The redact policy below keeps a tight allowlist of safe baseline fields
// (`name`, `message`, `stack`, `cause` recursively) plus a small set of
// operational fields (`code`, `errno`, `syscall`) that operators rely on
// for triage. Everything else — including the leaky standard fields above —
// is dropped before pino sees it. The `cause` chain is recursively passed
// through the same policy so a wrapped `AssertionError` cannot smuggle its
// `actual`/`expected` through a wrapper.
//
// PINO_ERR_REDACT_LEVEL=relaxed allows additional fields for debugging in
// non-production. The default is `strict`.
//
// Two-layer enforcement (see solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md):
//
//   Layer A — call-site wrapper (`logger.warn` / `logger.error` / ...).
//     Runs `redactErrSerializer` on `{err, ...}` arguments BEFORE delegating
//     to pino. This is the layer that vi.spyOn(logger, 'warn') intercepts —
//     spy-based redaction tests inspect `.mock.calls` which captures the
//     args at the call site, not at transport. Without the wrapper, pino's
//     `serializers.err` hook fires later (during format-and-write) and the
//     spy sees raw, unredacted err objects.
//
//   Layer B — pino `serializers.err` on the base logger.
//     Defense-in-depth at transport. Catches any direct call to the base
//     pino instance (e.g. inside pino-http's per-request child logger) and
//     scrubs the same fields before writing to the destination stream. Both
//     layers route through the same exported `redactErrSerializer` so the
//     redact policy stays single-source-of-truth.
//
// Cross-references:
//   - α (BACKEND-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION) — AssertionError leak
//   - δ (BE-VERIFY-BROADCAST-ATTEMPTS-CAP) — ReplyError.command leak
//   - lib/log-pii.ts — per-field hash helpers (`hashEmailForLogs`,
//     `hashTokenForLogs`); this redact policy is the project-wide complement.

const SAFE_BASELINE_FIELDS = ['code', 'errno', 'syscall'] as const;
const RELAXED_EXTRA_FIELDS = ['port', 'address', 'hostname', 'path'] as const;

// Round-3 hold #3 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
// upper bound on `cause`/`errors[]` recursion depth. The pre-round-3 self-
// reference guard (`errAny.cause !== errAny`) caught only depth-1 cycles
// (`A.cause = A`); a 2-step cycle (`A.cause = B; B.cause = A`) or an
// adversarial unbounded chain would stack-overflow and crash the process
// (PEvO is single-instance ⇒ full availability impact). Bail at depth > 10
// returning a sentinel so operators see why the chain truncated rather than
// a silent crash. Ten deep is generous: real cause chains in PEvO peak at
// 2 levels (broadcast cascade re-throw); any cause chain past depth 10 is
// an adversarial or buggy shape, not legitimate operational signal.
const MAX_CAUSE_DEPTH = 10;

// Module-scope cache so re-reads in the serializer don't pay the env lookup
// per call. Tests can re-import the module to refresh.
const REDACT_LEVEL: 'strict' | 'relaxed' =
  (process.env.PINO_ERR_REDACT_LEVEL || 'strict').toLowerCase() === 'relaxed' ? 'relaxed' : 'strict';

interface SerializedErr {
  type: string;
  message: string;
  stack?: string;
  cause?: SerializedErr | unknown;
  [key: string]: unknown;
}

function isErrorLike(value: unknown): value is Error {
  return value instanceof Error || (
    typeof value === 'object' && value !== null &&
    typeof (value as { message?: unknown }).message === 'string' &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

/**
 * Custom pino `err` serializer enforcing the project-wide redact policy.
 *
 * Output shape mirrors pino-std-serializers' baseline (`type`, `message`,
 * `stack`) so existing log consumers (Slack/Sentry/Loki shippers) keep
 * working. The deviation is the absence of the leaky enumerated fields.
 *
 * `depth` parameter (round-3 hold #3): bounds recursive `cause`/`errors[]`
 * traversal. The pre-round-3 self-reference guard caught only depth-1
 * cycles (`A.cause = A`); a 2-step cycle (`A.cause = B; B.cause = A`) or
 * an adversarial unbounded chain would stack-overflow and crash the
 * process. At depth > MAX_CAUSE_DEPTH (10) we bail with a sentinel so
 * operators see why the chain truncated rather than the process dying.
 */
export function redactErrSerializer(err: unknown, depth = 0): SerializedErr | unknown {
  if (!isErrorLike(err)) return err;

  // Round-3 hold #3: depth/cycle guard. Returning early at `depth > MAX`
  // (rather than `>=`) lets the top-level call (depth=0) and 10 levels of
  // genuine cause chain through; depth 11 would be the first to bail. The
  // sentinel shape is recognizable in operator logs as a redact-truncation
  // signal (vs. a serializer failure or a normal serialized err).
  if (depth > MAX_CAUSE_DEPTH) {
    return { type: 'MaxDepthExceeded', depth };
  }

  const errAny = err as Error & Record<string, unknown>;

  const out: SerializedErr = {
    type: errAny.constructor?.name || errAny.name || 'Error',
    message: typeof errAny.message === 'string' ? errAny.message : String(errAny.message ?? ''),
  };
  if (typeof errAny.stack === 'string') {
    out.stack = errAny.stack;
  }

  // Allowlisted operational fields. These are widely consumed by operators
  // (`code` for ENOENT/ETIMEDOUT classification, `errno`/`syscall` for OS
  // errors). They are not known to carry secret-derived material.
  for (const field of SAFE_BASELINE_FIELDS) {
    const v = errAny[field];
    if (v !== undefined && (typeof v === 'string' || typeof v === 'number')) {
      out[field] = v;
    }
  }

  if (REDACT_LEVEL === 'relaxed') {
    for (const field of RELAXED_EXTRA_FIELDS) {
      const v = errAny[field];
      if (v !== undefined && (typeof v === 'string' || typeof v === 'number')) {
        out[field] = v;
      }
    }
  }

  // Recursively redact the cause chain so a wrapped AssertionError or
  // ReplyError cannot smuggle leaky fields through a wrapper. Aggregate
  // errors (`err.errors`) follow the same recursion. Both pass `depth + 1`
  // so the depth guard above bounds the total recursion (round-3 hold #3).
  //
  // Round-4 hold #2 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
  // when `cause` is a non-Error plain object (e.g. `class WrappedErr extends
  // Error { constructor(...) { super(...); this.cause = leakyContext; } }`
  // or `Object.assign(new Error(...), { cause: { command: { args: [...] } } })`),
  // routing it back through `redactErrSerializer` hits the
  // `if (!isErrorLike(err)) return err` short-circuit at the top of the
  // function and the plain object is returned VERBATIM, bypassing the
  // SAFE_BASELINE_FIELDS allowlist. The same bypass class lives at the
  // top-level sibling layer (see solutions/conventions/pino-err-slot-
  // sibling-bypass-redact-policy-2026-05-06.md) and now closes here too.
  // Non-Error causes go through `redactPlainObject`, which applies the
  // allowlist + depth guard with NO short-circuit so the plain-object
  // surface has no leak path.
  if (errAny.cause !== undefined && errAny.cause !== errAny) {
    out.cause = isErrorLike(errAny.cause)
      ? redactErrSerializer(errAny.cause, depth + 1)
      : redactPlainObject(errAny.cause, depth + 1);
  }

  const maybeErrors = (errAny as unknown as { errors?: unknown }).errors;
  if (Array.isArray(maybeErrors)) {
    out.aggregateErrors = maybeErrors.map((e) => redactErrSerializer(e, depth + 1));
  }

  return out;
}

/**
 * Round-4 hold #2 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
 * SAFE_BASELINE_FIELDS allowlist redactor for non-Error `cause` payloads.
 *
 * `redactErrSerializer`'s entry guard (`if (!isErrorLike(err)) return err`)
 * passes plain-object inputs through verbatim, which is correct for the
 * top-level entry (pino can string-coerce primitives and unknown shapes
 * itself). At the recursive `cause` layer, however, that pass-through
 * defeats the redact policy: a future cause shape like
 *   `Object.assign(new Error('outer'), { cause: { command: { args: ['raw-token'] } } })`
 * would hit `isErrorLike(plainObj) === false` on the recursive call and
 * land the unredacted plain object in the serialized payload.
 *
 * This helper applies the allowlist (and ONLY the allowlist) to non-null
 * objects with no isErrorLike short-circuit. The depth guard from round-3
 * hold #3 carries through so cycles and unbounded chains still bail.
 * Non-object inputs (strings, numbers, etc.) pass through — pino can
 * coerce those itself; the failure mode this closes is the structural
 * smuggling-via-plain-object case.
 *
 * Output shape mirrors `SerializedErr` for consumer parity: `type`
 * surfaces a recognizable label so dashboards can distinguish a redacted
 * plain-object cause from a redacted Error cause.
 */
function redactPlainObject(value: unknown, depth: number): unknown {
  if (depth > MAX_CAUSE_DEPTH) {
    return { type: 'MaxDepthExceeded', depth };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    // Not a plain object — pass through. Primitives (string/number) carry
    // no allowlist surface; arrays land outside the cause-chain shape this
    // helper exists to defend.
    return value;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = { type: 'Object' };
  for (const field of SAFE_BASELINE_FIELDS) {
    const v = obj[field];
    if (v !== undefined && (typeof v === 'string' || typeof v === 'number')) {
      out[field] = v;
    }
  }
  if (REDACT_LEVEL === 'relaxed') {
    for (const field of RELAXED_EXTRA_FIELDS) {
      const v = obj[field];
      if (v !== undefined && (typeof v === 'string' || typeof v === 'number')) {
        out[field] = v;
      }
    }
  }
  // Recurse into nested cause if present, applying the same redact
  // discipline so a deeply-nested plain-object chain cannot smuggle leaks
  // through. (`isErrorLike` re-checked because a hybrid chain could mix
  // Error and plain-object levels.)
  if (obj.cause !== undefined && obj.cause !== obj) {
    out.cause = isErrorLike(obj.cause)
      ? redactErrSerializer(obj.cause, depth + 1)
      : redactPlainObject(obj.cause, depth + 1);
  }
  return out;
}

/**
 * Round-3 hold #4 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
 * fault-tolerant invocation of `redactErrSerializer`. The serializer reads
 * `errAny.stack`, `errAny.cause`, `errAny.errors`, and the SAFE_BASELINE_FIELDS
 * indices on the input. Any of these may throw on a hostile / buggy err
 * shape:
 *   - a custom Error subclass with a throwing getter for `stack` or `cause`,
 *   - a Proxy whose `getOwnPropertyDescriptor` throws,
 *   - an AggregateError member with a throwing `Symbol.toPrimitive` that
 *     surfaces during `String(...)` coercion in a future formatter.
 * Letting that throw escape would propagate out of every
 * `logger.error({err}, 'msg')` call site that already had an err in hand,
 * breaking the catch-and-log flow and turning a logged error into a real
 * crash. Returning a sentinel keeps the log line on the wire and surfaces
 * the serializer-fault to operators as a recognizable shape.
 *
 * Pairs with the depth/cycle guard (round-3 hold #3): together they make
 * the serializer fault-tolerant against deep cycles AND throwing-getter
 * shapes. Used by both Layer A (`redactErrInArg`) and Layer B (the
 * `serializers.err` config below).
 */
function safeRedactErr(input: unknown): unknown {
  try {
    return redactErrSerializer(input);
  } catch (serializerErr) {
    return {
      type: 'RedactSerializerFailed',
      message: String(
        (serializerErr as { message?: unknown } | null | undefined)?.message ?? serializerErr,
      ),
    };
  }
}

// ── Logger ─────────────────────────────────────────────────
//
// `baseLogger` is the raw pino instance with `serializers.err` configured
// for transport-level redaction (Layer B). It is NOT exported directly;
// production call sites import `logger`, the wrapper below.
const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  serializers: {
    // Round-3 hold #4: the Layer-B `serializers.err` callback fires inside
    // pino's format-and-write path (worker thread under the async transport).
    // A throwing serializer here would surface as an unhandled exception in
    // the transport, dropping the log line AND potentially destabilizing
    // pino. Wrap via `safeRedactErr` so the serializer always returns a
    // finite payload.
    err: safeRedactErr,
  },
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino/file', options: { destination: 1 } },
  }),
});

/**
 * Apply `redactErrSerializer` to the `err` field of any `{err, ...}`-shaped
 * argument before it reaches pino's call site. This is Layer A from the
 * pino-spy-serializer-ordering-trap convention: vi.spyOn captures args at
 * this call site, so redaction must already be applied here for spy-based
 * redaction tests to be meaningful.
 *
 * IMPORTANT — in-place mutation of the `err` field is INTENTIONAL:
 *   `vi.spyOn(logger, 'warn').mock.calls` captures argument references at
 *   the wrapper-call boundary. If the wrapper substituted a new shallow
 *   copy of the arg via spread (`{...obj, err: redacted}`), the spy's
 *   captured reference would still point at the ORIGINAL unredacted obj,
 *   and `mock.calls[N][0].err.command.args[0]` would still expose the raw
 *   token. By overwriting `obj.err` on the same reference the spy holds,
 *   the redacted form is visible to the spy at the moment the test
 *   inspects `.mock.calls` — closing the spy-vs-serializer ordering trap.
 *   The mutation is scoped to one field (`err`) and only on objects that
 *   already carry an `err` key, so the surface is narrow.
 *
 * Non-object args (strings, numbers, undefined) pass through untouched —
 * pino's own coercion handles them.
 */
function redactErrInArg(arg: unknown): unknown {
  if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
    const obj = arg as Record<string, unknown>;
    if ('err' in obj) {
      // Round-3 hold #4: route through `safeRedactErr` so a throwing-getter
      // err shape (custom subclass with throwing `stack` getter, hostile
      // Proxy, AggregateError with throwing `Symbol.toPrimitive`) cannot
      // propagate out of a `logger.error({err}, 'msg')` call site and
      // break the catch-and-log flow.
      obj.err = safeRedactErr(obj.err);
    }
  }
  return arg;
}

/**
 * Project-wide logger wrapper. Runs `safeRedactErr` (which wraps
 * `redactErrSerializer`) on any `{err, ...}` argument before delegating
 * to pino. See the pino-spy-serializer-ordering-trap convention doc for
 * the layering rationale.
 *
 * Round-3 hold #5: each level method is declared with the explicit
 * `LogFn` type from pino instead of `Parameters<typeof baseLogger.warn>`.
 * `Parameters<>` reduces an overload set to the LAST overload's tuple —
 * pino's `LogFn` is a 3-overload union (msg-only string, obj+optional-msg,
 * obj+msg+placeholders), so the per-level `WarnArgs = Parameters<...>`
 * aliases collapsed to a single shape and silently lost both the msg-only
 * overload and the `%s`/`%d` placeholder type-checking at every call site.
 * Using `LogFn` directly preserves the full overload set; the `.map()` is
 * gone too because the rest-args spread directly through the wrapper after
 * redaction (the `err` field is mutated in place, so passing the same
 * argument array forward is correct).
 */
function makeLevelWrapper(method: LogFn): LogFn {
  // Cast through `unknown` because the rest-args shape varies across
  // pino's LogFn overloads; the runtime contract is preserved (we redact
  // only the `err` field of the FIRST object arg, never re-shape the
  // tuple). Using `LogFn` as the return type re-asserts the overload
  // surface at every call site.
  const wrapped: LogFn = ((...args: unknown[]) => {
    if (args.length > 0) {
      args[0] = redactErrInArg(args[0]);
    }
    (method as (...a: unknown[]) => void).apply(baseLogger, args);
  }) as LogFn;
  return wrapped;
}

export const logger: {
  warn: LogFn;
  error: LogFn;
  info: LogFn;
  debug: LogFn;
  fatal: LogFn;
  trace: LogFn;
  flush: (cb?: (err?: Error | null) => void) => void;
} = {
  warn: makeLevelWrapper(baseLogger.warn.bind(baseLogger)),
  error: makeLevelWrapper(baseLogger.error.bind(baseLogger)),
  info: makeLevelWrapper(baseLogger.info.bind(baseLogger)),
  debug: makeLevelWrapper(baseLogger.debug.bind(baseLogger)),
  fatal: makeLevelWrapper(baseLogger.fatal.bind(baseLogger)),
  trace: makeLevelWrapper(baseLogger.trace.bind(baseLogger)),
  // Pino's destination-flush callback. Call sites in shutdown paths
  // (e.g. routes/auth.ts process.exit guard, the boot-fatal sites in
  // index.ts and startup-checks.ts) rely on this to drain buffered log
  // lines before exit. Forward verbatim — flush carries no err arg, so
  // no redaction is needed.
  flush: (cb?: (err?: Error | null) => void): void => {
    baseLogger.flush(cb);
  },
};

export const httpLogger = pinoHttp({
  logger: baseLogger,
  genReqId: () => crypto.randomUUID(),
  customLogLevel: (_req, res) => {
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      remoteAddress: req.remoteAddress,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
    // Round-3 hold #4: same fault-tolerant invocation as the baseLogger's
    // err serializer above. pino-http child loggers inherit the parent's
    // serializers config, but since this httpLogger declares its own
    // serializers slot we have to wire the safe wrapper here too.
    err: safeRedactErr,
  },
});

export { requestContext };
