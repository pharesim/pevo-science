import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub Alpine: api.js imports the default export and calls Alpine.store('auth').
// These tests never need a real auth store, but the import-time mock prevents
// a ReferenceError when api.js's module graph pulls Alpine in.
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn(() => null),
  },
}));

import { ApiRequestError, fetchPlatformStats } from '../../src/api.js';

// Build a mock Response-like object with a real-ish `headers.get()` so
// `parseRetryAfterSeconds` sees the header case-insensitively. We use a real
// `Headers` instance to avoid re-implementing the case-folding contract.
function mockErrorResponse(status, body, headerEntries = []) {
  return {
    ok: false,
    status,
    headers: new Headers(headerEntries),
    json: async () => body,
  };
}

describe('ApiRequestError: details and Retry-After plumbing', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('exposes err.details and err.retryAfterSeconds for a retriable 409', async () => {
    fetchSpy.mockResolvedValue(
      mockErrorResponse(
        409,
        {
          status: 'error',
          error: {
            code: 'ORCID_ALREADY_LINKED',
            message: 'Another request is in flight, retry shortly.',
            details: { retriable: true, retry_after_seconds: 10 },
          },
        },
        [['Retry-After', '10']],
      ),
    );

    try {
      await fetchPlatformStats();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect(err.code).toBe('ORCID_ALREADY_LINKED');
      expect(err.details).toEqual({ retriable: true, retry_after_seconds: 10 });
      expect(err.details.retriable).toBe(true);
      expect(err.retryAfterSeconds).toBe(10);
    }
  });

  it('leaves err.details undefined and err.retryAfterSeconds null for a durable 409', async () => {
    fetchSpy.mockResolvedValue(
      mockErrorResponse(
        409,
        {
          status: 'error',
          error: {
            code: 'ORCID_ALREADY_LINKED',
            message: 'This ORCID is already bound to another Hive account.',
          },
        },
        [],
      ),
    );

    try {
      await fetchPlatformStats();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect(err.code).toBe('ORCID_ALREADY_LINKED');
      expect(err.details).toBeUndefined();
      expect(err.retryAfterSeconds).toBeNull();
    }
  });
});
