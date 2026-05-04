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
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  serializers: {
    err: redactErrSerializer,
  },
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino/file', options: { destination: 1 } },
  }),
});

export const httpLogger = pinoHttp({
  logger,
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
