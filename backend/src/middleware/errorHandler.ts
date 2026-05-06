import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { sendError } from '../response.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  logger.error({ err: { message: err.message, stack: err.stack } }, 'Unhandled error');
  sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
}
