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
  completeOrcid,
  setPassword,
  isRetriable503,
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

describe('isRetriable503', () => {
  it('returns true when code is SERVICE_UNAVAILABLE and details.retriable is true', () => {
    expect(isRetriable503({ code: 'SERVICE_UNAVAILABLE', details: { retriable: true } })).toBe(true);
  });

  it('also matches on a real ApiRequestError instance with retriable: true', () => {
    const err = new ApiRequestError('SERVICE_UNAVAILABLE', 'busy', null, { retriable: true });
    expect(isRetriable503(err)).toBe(true);
  });

  it('returns false when details.retriable is false', () => {
    expect(isRetriable503({ code: 'SERVICE_UNAVAILABLE', details: { retriable: false } })).toBe(false);
  });

  it('returns false on a non-503 error code even if details.retriable is true', () => {
    expect(isRetriable503({ code: 'NOT_FOUND', details: { retriable: true } })).toBe(false);
  });

  it('returns false when code is SERVICE_UNAVAILABLE but details is missing', () => {
    expect(isRetriable503({ code: 'SERVICE_UNAVAILABLE' })).toBe(false);
  });

  it('returns false when code is SERVICE_UNAVAILABLE but details.retriable is undefined', () => {
    expect(isRetriable503({ code: 'SERVICE_UNAVAILABLE', details: {} })).toBe(false);
  });

  it('returns false when details.retriable is a truthy non-boolean (e.g. "true" string)', () => {
    // Strict `=== true` guards against accidental coercion bugs on the envelope.
    expect(isRetriable503({ code: 'SERVICE_UNAVAILABLE', details: { retriable: 'true' } })).toBe(false);
    expect(isRetriable503({ code: 'SERVICE_UNAVAILABLE', details: { retriable: 1 } })).toBe(false);
  });

  it('returns false on null', () => {
    expect(isRetriable503(null)).toBe(false);
  });

  it('returns false on undefined', () => {
    expect(isRetriable503(undefined)).toBe(false);
  });

  it('returns false on an empty object', () => {
    expect(isRetriable503({})).toBe(false);
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

describe('completeOrcid mode-based auth', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockJsonResponse(200, { status: 'ok', data: { mode: 'signup' } }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends Authorization: Bearer <token> on link mode', async () => {
    authStore = { token: 'jwt-link-1' };
    await completeOrcid('code', 'state', 'link');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/orcid/callback');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jwt-link-1' });
    expect(init.body).toBe(JSON.stringify({ code: 'code', state: 'state' }));
  });

  it('sends Authorization: Bearer <token> on accredit mode', async () => {
    authStore = { token: 'jwt-accr-1' };
    await completeOrcid('code', 'state', 'accredit');

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jwt-accr-1' });
  });

  it('omits Authorization header on signup mode', async () => {
    authStore = { token: 'jwt-signup-1' };
    await completeOrcid('code', 'state', 'signup');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/orcid/callback');
    expect(init.headers?.Authorization).toBeUndefined();
  });

  it('omits Authorization header on login mode', async () => {
    authStore = { token: 'jwt-login-1' };
    await completeOrcid('code', 'state', 'login');

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers?.Authorization).toBeUndefined();
  });

  it('throws UNAUTHORIZED on link mode when no session token is present', async () => {
    authStore = null;

    try {
      await completeOrcid('code', 'state', 'link');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect(err.code).toBe('UNAUTHORIZED');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws UNAUTHORIZED on accredit mode when no session token is present', async () => {
    authStore = null;

    try {
      await completeOrcid('code', 'state', 'accredit');
      throw new Error('expected throw');
    } catch (err) {
      expect(err.code).toBe('UNAUTHORIZED');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls through to unauthenticated request() on an unknown mode', async () => {
    // Documents the fallback contract: any string that is neither
    // 'accredit' nor 'link' routes through the unauth path. Guards against
    // an accidental inversion of the `requiresAuth` boolean.
    authStore = { token: 'jwt-should-not-be-sent' };
    await completeOrcid('code', 'state', 'bogus-future-mode');

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers?.Authorization).toBeUndefined();
  });
});

describe('setPassword (SEC-004-UI)', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockJsonResponse(200, { status: 'ok', data: {} }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('POSTs to /api/settings/set-password with Bearer auth and JSON body', async () => {
    authStore = { token: 'jwt-setpw-1' };
    await setPassword('Abcdefgh1x');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/settings/set-password');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer jwt-setpw-1',
      'Content-Type': 'application/json',
    });
    expect(init.body).toBe(JSON.stringify({ password: 'Abcdefgh1x' }));
  });

  it('throws UNAUTHORIZED when no session is present', async () => {
    authStore = null;
    try {
      await setPassword('Abcdefgh1x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect(err.code).toBe('UNAUTHORIZED');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
