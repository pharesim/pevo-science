import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  logger.error({ err: { message: err.message, stack: err.stack } }, 'Unhandled error');
  res.status(500).json({
    status: 'error',
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
}
