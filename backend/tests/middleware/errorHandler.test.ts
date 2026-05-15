/**
 * errorHandler middleware unit tests.
 *
 * Test-mock carve-out justification (per root CLAUDE.md "Running Tests"):
 *
 * (a) Why mocking is used: this test spies on `logger.error` via `vi.spyOn`
 *     (no mock implementation) to capture the structured payload that
 *     errorHandler emits when an unhandled error reaches it. `logger` is the
 *     observability surface called out in the carve-out clause; capturing
 *     pino output via stdout interception per-test would be impractical
 *     (transport buffering, ordering across the supertest async boundary,
 *     no stable hook for reading the in-memory destination from a worker
 *     pool). The spy preserves the real wrapper implementation so the
 *     production Layer-A serializer (`redactErrInArg` → `safeRedactErr` →
 *     `redactErrSerializer` in backend/src/logger.ts) actually runs and
 *     mutates `args[0].err` in place — the test then verifies the
 *     post-serializer shape that production log sinks see. `logger.level`
 *     is set to `'silent'` for the test so the underlying pino instance
 *     doesn't emit to stdout; this is the level filter at the BASE pino
 *     layer, AFTER the wrapper's mutation, so the spy still observes the
 *     full production trace.
 *
 * (b) No auth or permission middleware is mocked. The Express app under
 *     test mounts only a stub route that throws and `errorHandler` itself.
 *     `verifyHiveSignature` is not on the chain.
 *
 * (c) Same risk class is covered elsewhere by real-path tests: every route
 *     test in `backend/tests/routes/` exercises the real Express error
 *     pipeline against the real backend (no errorHandler stub). Those tests
 *     don't assert the serialized err-slot shape (which is what this test
 *     pins); this targeted unit test is the projection-shape pin, and the
 *     route suites are the integrated-path companions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { logger } from '../../src/logger.js';

class TestError extends Error {
  constructor() {
    super('test message');
    this.name = 'TestError';
  }
}

function createApp() {
  const app = express();
  app.get('/boom', (_req, _res, next) => {
    next(new TestError());
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler middleware', () => {
  const originalLevel = logger.level;

  beforeEach(() => {
    // Suppress pino emission to stdout. The base-pino level filter fires
    // AFTER the wrapper's `redactErrInArg` mutation, so the spy still
    // observes the production-trace serialized err shape.
    logger.level = 'silent';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    logger.level = originalLevel;
  });

  it('logs the serialized error class type in the structured payload', async () => {
    const errorSpy = vi.spyOn(logger, 'error');

    const res = await request(createApp()).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      status: 'error',
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          type: 'TestError',
          message: 'test message',
        }),
      }),
      'Unhandled error',
    );
  });
});
