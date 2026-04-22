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

// Non-JSON error response: `res.json()` rejects, mirroring real fetch behavior
// when a gateway returns HTML or plain text (e.g. 502 from an upstream proxy).
function mockNonJsonErrorResponse(status, headerEntries = []) {
  return {
    ok: false,
    status,
    headers: new Headers(headerEntries),
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
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

  it('falls back to INTERNAL_ERROR when the body lacks the `error` key (malformed envelope)', async () => {
    // Guard against a TypeError-on-nullish-property-access. A body shaped like
    // `{status:"error"}` or `{status:"error", error:null}` must NOT crash the
    // error-body branch reading `errorBody.error.code`; it should fall through
    // to the INTERNAL_ERROR fallback.
    fetchSpy.mockResolvedValue(
      mockErrorResponse(500, { status: 'error' }, []),
    );

    try {
      await fetchPlatformStats();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.retryAfterSeconds).toBeNull();
      expect(err.details).toBeUndefined();
    }
  });

  it('surfaces retryAfterSeconds via the INTERNAL_ERROR fallback when the response is non-JSON', async () => {
    // Covers the fallback path: a 503 from a gateway with a plain-text body
    // still carries a `Retry-After` header. The JSON parse fails, so `request()`
    // falls through to the `INTERNAL_ERROR` constructor — but the parsed header
    // MUST still reach `err.retryAfterSeconds` so callers can honor it.
    fetchSpy.mockResolvedValue(
      mockNonJsonErrorResponse(503, [['Retry-After', '30']]),
    );

    try {
      await fetchPlatformStats();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.retryAfterSeconds).toBe(30);
      expect(err.details).toBeUndefined();
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
