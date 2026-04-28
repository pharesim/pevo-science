import type { Response } from 'express';
import type { PaginationMeta, ErrorCode } from './types/index.js';
import { logger, getRequestId } from './logger.js';

export function sendOk(res: Response, data: unknown, meta?: PaginationMeta) {
  const body: Record<string, unknown> = { status: 'ok', data };
  if (meta) body.meta = meta;
  res.json(body);
}

export function sendError(
  res: Response,
  httpStatus: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  // Defense-in-depth: callers wrapping middleware in try/catch (e.g. orcid
  // /callback's authenticateRequest dispatch) may invoke sendError after the
  // wrapped middleware has already responded. Writing to a sent response
  // corrupts the stream and triggers Express "Cannot set headers after they
  // are sent". Drop the duplicate write and warn so the upstream pattern is
  // visible in logs without crashing the response.
  if (res.headersSent) {
    logger.warn(
      {
        reqId: getRequestId(),
        method: res.req?.method,
        url: res.req?.url,
        attemptedStatus: httpStatus,
        attemptedCode: code,
      },
      'sendError called after response sent',
    );
    return;
  }
  const error: Record<string, unknown> = { code, message };
  if (details) error.details = details;
  res.status(httpStatus).json({
    status: 'error',
    error,
  });
}
