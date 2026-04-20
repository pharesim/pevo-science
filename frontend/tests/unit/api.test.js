import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub Alpine: api.js imports the default export and calls Alpine.store('auth').
// We control the returned store per-test via the `authStore` variable.
let authStore = null;
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => (name === 'auth' ? authStore : null)),
  },
}));

import {
  ApiRequestError,
  fetchPlatformStats,
  fetchPapers,
  fetchNotifications,
  fetchDisciplines,
} from '../../src/api.js';

// Helper: build a mock Response-like object for fetch.
function mockJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function mockNonJsonResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not JSON');
    },
  };
}

describe('ApiRequestError', () => {
  it('carries code, message, and data', () => {
    const err = new ApiRequestError('FOO', 'bad', { extra: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiRequestError');
    expect(err.code).toBe('FOO');
    expect(err.message).toBe('bad');
    expect(err.data).toEqual({ extra: 1 });
  });

  it('defaults data to null when not provided', () => {
    const err = new ApiRequestError('FOO', 'bad');
    expect(err.data).toBeNull();
  });
});

describe('buildQuery (exercised via exported wrappers)', () => {
  let fetchSpy;

  beforeEach(() => {
    authStore = null;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockJsonResponse(200, { status: 'ok', data: [] }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('produces no query string for an empty params object', async () => {
    await fetchPapers({});
    expect(fetchSpy).toHaveBeenCalledWith('/api/papers', expect.any(Object));
  });

  it('strips undefined and empty-string values', async () => {
    await fetchPapers({ author: 'alice', discipline: undefined, tag: '' });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/papers?author=alice');
  });

  it('joins multiple values with & and encodes keys and values', async () => {
    await fetchPapers({ 'a b': 'x y', c: 'z&w' });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/papers?a%20b=x%20y&c=z%26w');
  });

  it('coerces numeric and boolean values via String()', async () => {
    await fetchPapers({ limit: 25, active: true, zero: 0, falsy: false });
    const [url] = fetchSpy.mock.calls[0];
    // All four are kept — only `undefined`/`''` are stripped.
    expect(url).toBe('/api/papers?limit=25&active=true&zero=0&falsy=false');
  });
});

describe('request', () => {
  let fetchSpy;

  beforeEach(() => {
    authStore = null;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns parsed JSON on 2xx', async () => {
    const payload = { status: 'ok', data: { healthy: true } };
    fetchSpy.mockResolvedValue(mockJsonResponse(200, payload));
    await expect(fetchPlatformStats()).resolves.toEqual(payload);
  });

  it('throws ApiRequestError with matching code/message/data on JSON error body', async () => {
    fetchSpy.mockResolvedValue(
      mockJsonResponse(400, {
        status: 'error',
        error: { code: 'VALIDATION_ERROR', message: 'bad input' },
        data: { field: 'title' },
      }),
    );

    try {
      await fetchPlatformStats();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toBe('bad input');
      expect(err.data).toEqual({ field: 'title' });
    }
  });

  it('throws ApiRequestError with INTERNAL_ERROR and status-bearing message on non-JSON error body', async () => {
    fetchSpy.mockResolvedValue(mockNonJsonResponse(502));

    try {
      await fetchPlatformStats();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.message).toContain('502');
    }
  });

  it('applies a default AbortSignal timeout when none is passed', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse(200, {}));
    await fetchDisciplines();

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // The default timeout signal is not yet aborted.
    expect(init.signal.aborted).toBe(false);
  });
});

describe('authenticatedRequest', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('throws UNAUTHORIZED when no token is present in the Alpine auth store', async () => {
    authStore = null;

    try {
      await fetchNotifications();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect(err.code).toBe('UNAUTHORIZED');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws UNAUTHORIZED when the auth store exists but has no token', async () => {
    authStore = { token: null };

    try {
      await fetchNotifications();
      throw new Error('expected throw');
    } catch (err) {
      expect(err.code).toBe('UNAUTHORIZED');
    }
  });

  it('merges Authorization: Bearer <token> header and delegates to request', async () => {
    authStore = { token: 'jwt-abc-123' };
    fetchSpy.mockResolvedValue(mockJsonResponse(200, { status: 'ok', data: [] }));

    await fetchNotifications(100, 10);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/notifications?since_block=100&limit=10');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jwt-abc-123' });
  });
});
