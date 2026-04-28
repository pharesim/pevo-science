import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { sendOk, sendError } from '../src/response.js';
import { logger } from '../src/logger.js';

function mockResponse(opts: { headersSent?: boolean; req?: { method?: string; url?: string } } = {}) {
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    headersSent: opts.headersSent ?? false,
    req: opts.req,
  } as unknown as Response;
  return res;
}

describe('sendOk', () => {
  it('sends status ok with data', () => {
    const res = mockResponse();
    sendOk(res, { foo: 'bar' });
    expect(res.json).toHaveBeenCalledWith({ status: 'ok', data: { foo: 'bar' } });
  });

  it('includes pagination meta when provided', () => {
    const res = mockResponse();
    sendOk(res, [], { page: 1, limit: 20, total: 100 });
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      data: [],
      meta: { page: 1, limit: 20, total: 100 },
    });
  });
});

describe('sendError', () => {
  it('sends error with correct status code and body', () => {
    const res = mockResponse();
    sendError(res, 404, 'NOT_FOUND', 'Paper not found');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      error: { code: 'NOT_FOUND', message: 'Paper not found' },
    });
  });

  it('sends 400 for bad request', () => {
    const res = mockResponse();
    sendError(res, 400, 'BAD_REQUEST', 'Missing field');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  // Defense-in-depth headersSent guard: callers wrapping middleware in
  // try/catch may invoke sendError after the wrapped middleware has already
  // responded. Writing to a sent response corrupts the stream and triggers
  // Express "Cannot set headers after they are sent". The guard drops the
  // duplicate write and warns instead. These specs pin both halves of the
  // contract (no double-write on headersSent=true, normal write on false).
  it('drops duplicate write and warns when headersSent is true', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const res = mockResponse({
      headersSent: true,
      req: { method: 'POST', url: '/api/orcid/callback' },
    });
    try {
      sendError(res, 500, 'INTERNAL_ERROR', 'boom');
      expect(res.json).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [payload, msg] = warnSpy.mock.calls[0];
      expect(msg).toBe('sendError called after response sent');
      expect(payload).toEqual(
        expect.objectContaining({
          attemptedStatus: 500,
          attemptedCode: 'INTERNAL_ERROR',
          method: 'POST',
          url: '/api/orcid/callback',
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn and writes normally when headersSent is false', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const res = mockResponse({ headersSent: false });
    try {
      sendError(res, 500, 'INTERNAL_ERROR', 'boom');
      expect(warnSpy).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'boom' },
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
