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

// ── Logger ─────────────────────────────────────────────────
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
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
  },
});

export { requestContext };
