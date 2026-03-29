import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { sendOk, sendError } from '../src/response.js';

function mockResponse() {
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
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
});
