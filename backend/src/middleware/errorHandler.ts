import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { sendError } from '../response.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  // Path A: explicit projection that preserves err.name (e.g. 'TypeError',
  // 'BridgeKeyParseError', 'BootFatal'). Path B (passing the raw Error to
  // pino's default err-serializer) is not used here because logger.ts wires
  // no custom error serializer — relying on the default would couple this
  // call site to pino-internal projection behavior. See task
  // backend-error-handler-include-err-name-in-log-projection.
  logger.error(
    { err: { name: err.name, message: err.message, stack: err.stack } },
    'Unhandled error',
  );
  sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
}
