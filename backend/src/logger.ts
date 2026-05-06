import pino from 'pino';
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
 */
export function redactErrSerializer(err: unknown): SerializedErr | unknown {
  if (!isErrorLike(err)) return err;

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
  // errors (`err.errors`) follow the same recursion.
  if (errAny.cause !== undefined && errAny.cause !== errAny) {
    out.cause = redactErrSerializer(errAny.cause);
  }

  const maybeErrors = (errAny as unknown as { errors?: unknown }).errors;
  if (Array.isArray(maybeErrors)) {
    out.aggregateErrors = maybeErrors.map((e) => redactErrSerializer(e));
  }

  return out;
}

// ── Logger ─────────────────────────────────────────────────
//
// `baseLogger` is the raw pino instance with `serializers.err` configured
// for transport-level redaction (Layer B). It is NOT exported directly;
// production call sites import `logger`, the wrapper below.
const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  serializers: {
    err: redactErrSerializer,
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
      obj.err = redactErrSerializer(obj.err);
    }
  }
  return arg;
}

// Pino's `LogFn` overloads accept multiple call shapes. Using
// `Parameters<typeof baseLogger.<level>>` preserves the tuple so the
// .map() result can be spread back without losing type safety. The cast
// back to `Parameters<...>` is required because Array.map() widens to
// `unknown[]`; the runtime contract is preserved (we redact only the
// `err` field of object args, never re-shape the tuple).
type WarnArgs = Parameters<typeof baseLogger.warn>;
type ErrorArgs = Parameters<typeof baseLogger.error>;
type InfoArgs = Parameters<typeof baseLogger.info>;
type DebugArgs = Parameters<typeof baseLogger.debug>;
type FatalArgs = Parameters<typeof baseLogger.fatal>;
type TraceArgs = Parameters<typeof baseLogger.trace>;

/**
 * Project-wide logger wrapper. Runs `redactErrSerializer` on any
 * `{err, ...}` argument before delegating to pino. See the
 * pino-spy-serializer-ordering-trap convention doc for the layering
 * rationale.
 */
export const logger = {
  warn: (...args: WarnArgs): void => {
    baseLogger.warn(...(args.map(redactErrInArg) as unknown as WarnArgs));
  },
  error: (...args: ErrorArgs): void => {
    baseLogger.error(...(args.map(redactErrInArg) as unknown as ErrorArgs));
  },
  info: (...args: InfoArgs): void => {
    baseLogger.info(...(args.map(redactErrInArg) as unknown as InfoArgs));
  },
  debug: (...args: DebugArgs): void => {
    baseLogger.debug(...(args.map(redactErrInArg) as unknown as DebugArgs));
  },
  fatal: (...args: FatalArgs): void => {
    baseLogger.fatal(...(args.map(redactErrInArg) as unknown as FatalArgs));
  },
  trace: (...args: TraceArgs): void => {
    baseLogger.trace(...(args.map(redactErrInArg) as unknown as TraceArgs));
  },
  // Pino's destination-flush callback. Call sites in shutdown paths
  // (e.g. routes/auth.ts process.exit guard) rely on this to drain buffered
  // log lines before exit. Forward verbatim — flush carries no err arg, so
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
    err: redactErrSerializer,
  },
});

export { requestContext };
