/**
 * errorHandler middleware unit tests.
 *
 * Test-mock carve-out justification (per root CLAUDE.md "Running Tests"):
 *
 * (a) Why mocking is used: this test mocks `logger.error` via `vi.spyOn` to
 *     observe the structured payload that errorHandler emits when an
 *     unhandled error reaches it. `logger` is the observability surface
 *     called out in the carve-out clause; capturing pino output via stdout
 *     interception per-test would be impractical (transport buffering,
 *     ordering across the supertest async boundary, no stable hook for
 *     reading the in-memory destination from a worker pool). Spying on the
 *     logger method gives a deterministic assertion against the exact
 *     argument shape the middleware constructs — which is precisely what
 *     this test exists to pin.
 *
 * (b) No auth or permission middleware is mocked. The Express app under
 *     test mounts only a stub route that throws and `errorHandler` itself.
 *     `verifyHiveSignature` is not on the chain.
 *
 * (c) Same risk class is covered elsewhere by real-path tests: every route
 *     test in `backend/tests/routes/` exercises the real Express error
 *     pipeline against the real backend (no errorHandler stub). Those tests
 *     don't assert the projection shape (which is what this test pins);
 *     this targeted unit test is the projection-shape pin, and the route
 *     suites are the integrated-path companions.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the error class name in the structured payload', async () => {
    const errorSpy = vi
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined as unknown as void);

    const res = await request(createApp()).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      status: 'error',
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [payload, message] = errorSpy.mock.calls[0] as [
      { err: { name: string; message: string; stack?: string } },
      string,
    ];
    expect(message).toBe('Unhandled error');
    expect(payload.err.name).toBe('TestError');
    expect(payload.err.message).toBe('test message');
    expect(typeof payload.err.stack).toBe('string');
  });
});
