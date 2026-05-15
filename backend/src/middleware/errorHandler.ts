import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { sendError } from '../response.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  // Path B: pass the raw Error so the project-wide logger wrapper
  // (`redactErrInArg` → `safeRedactErr` → `redactErrSerializer` in
  // backend/src/logger.ts) projects the canonical `{type, message, stack,
  // cause?, ...}` shape. `type` resolves to `err.constructor.name`
  // (`TypeError`, `BridgeKeyParseError`, `BootFatal`, ...) — the class
  // identity operator dashboards key on. Hand-rolling a plain-object
  // projection here would defeat the wrapper: `isErrorLike({name, message,
  // stack})` returns true, the serializer reads `constructor.name` of the
  // plain object (`'Object'`), and the hand-set `name` field gets dropped
  // because it's not in SAFE_BASELINE_FIELDS. See
  // agents/docs/solutions/conventions/pino-err-slot-plain-object-projection-loss-2026-05-15.md.
  logger.error({ err }, 'Unhandled error');
  sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
}
