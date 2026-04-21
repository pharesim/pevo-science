import type { Response } from 'express';
import type { PaginationMeta, ErrorCode } from './types/index.js';

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
  const error: Record<string, unknown> = { code, message };
  if (details) error.details = details;
  res.status(httpStatus).json({
    status: 'error',
    error,
  });
}
