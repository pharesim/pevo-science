import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub Alpine: api.js imports the default export and calls Alpine.store('auth').
// We control the returned store per-test via the `authStore` variable.
let authStore = null;
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => (name === 'auth' ? authStore : null)),
  },
}));

// linkExistingAccount signs the request with a Hive key via signRequest before
// POSTing. Stub it so the credentials assertion below exercises the fetch shape
// without a real key — signRequest itself is covered in sign-request.test.js.
vi.mock('../../src/sign-request.js', () => ({
  signRequest: vi.fn(async (_username, _method, _path, bodyObject) => ({
    headers: { 'X-Hive-Signature': 'stub-sig' },
    body: JSON.stringify(bodyObject),
  })),
}));

// uploadFileToIpfs hashes the file via crypto.js; stub it for a deterministic
// digest so the descriptor assertions are stable (real hashing is covered in
// crypto.test.js).
vi.mock('../../src/crypto.js', () => ({
  sha256File: vi.fn(async () => 'a'.repeat(64)),
}));

import {
  ApiRequestError,
  fetchPlatformStats,
  fetchPapers,
  fetchNotifications,
  fetchDisciplines,
  completeOrcid,
  setPassword,
  submitEmail,
  deleteEmail,
  mintSettingsActionProof,
  isRetriable503,
  resumeSignup,
  confirmAccount,
  linkExistingAccount,
  mintIpfsUploadProof,
  uploadFileToIpfs,
  promoteAdmin,
} from '../../src/api.js';
import { signRequest } from '../../src/sign-request.js';

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

describe('adminMutation custody dispatch (exercised via promoteAdmin)', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    signRequest.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    authStore = null;
  });

  it('light account: JWT path, body carries the fresh-auth proof, no signature', async () => {
    authStore = { token: 'jwt-light-1', custody: 'light', username: 'alice' };
    fetchSpy.mockResolvedValue(mockJsonResponse(200, { status: 'ok', data: {} }));

    await promoteAdmin('bob', 'admin', 'proof-xyz');

    expect(signRequest).not.toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/admin/roster/grant');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jwt-light-1' });
    expect(init.headers['X-Hive-Signature']).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ account: 'bob', level: 'admin', fresh_auth_proof: 'proof-xyz' });
  });

  it('self-custody: signs the request (no JWT, no body proof) so the backend sees a fresh signature', async () => {
    authStore = { token: 'jwt-self-1', custody: 'self', username: 'alice' };
    fetchSpy.mockResolvedValue(mockJsonResponse(200, { status: 'ok', data: {} }));

    await promoteAdmin('bob', 'admin', undefined);

    // Signature path: signRequest is bound to the full /api path and the body
    // object (no fresh_auth_proof — the per-request signature IS the proof).
    expect(signRequest).toHaveBeenCalledWith('alice', 'POST', '/api/admin/roster/grant', { account: 'bob', level: 'admin' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/admin/roster/grant');
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers['X-Hive-Signature']).toBe('stub-sig');
    expect(JSON.parse(init.body)).toEqual({ account: 'bob', level: 'admin' });
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

// The signup-session-binding triad mints (/resume-signup) and consumes
// (/confirm, /link) the httpOnly `pevo_signup_session` cookie. The cookie only
// rides along on the follow-up XHR if the fetch is made with credentials that
// attach same-origin cookies. These specs pin `credentials: 'same-origin'` on
// the cookie-bearing calls so a refactor that drops the option (silently
// breaking /confirm and /link with a binding-missing 400) is caught here.
describe('signup-session-binding cookie credentials', () => {
  let fetchSpy;

  beforeEach(() => {
    authStore = null;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockJsonResponse(200, { status: 'ok', data: { flow: 'choose', auth_token: 'confirmed:x', email: 'e@x.com' } }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('resumeSignup sends credentials: same-origin so the binding cookie is stored from Set-Cookie', async () => {
    await resumeSignup('e@x.com', 'pass');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/auth/resume-signup');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe(JSON.stringify({ email: 'e@x.com', password: 'pass' }));
  });

  it('confirmAccount sends credentials: same-origin so the binding cookie is re-sent', async () => {
    await confirmAccount('confirmed:x', 'alice', { owner_public: 'STM1' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/auth/confirm');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
  });

  it('linkExistingAccount sends credentials: same-origin so the binding cookie is re-sent', async () => {
    await linkExistingAccount('confirmed:x', 'alice');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/auth/link');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
  });
});

// The three settings critical actions (change_email / set_password /
// delete_account) carry a single-use `fresh_auth_proof` in the request body on
// the JWT path and omit it on the Keychain path. These pin that the field is
// threaded through (and only when present), plus the password-factor mint shape.
describe('settings critical-action proof threading', () => {
  let fetchSpy;

  beforeEach(() => {
    authStore = { token: 'jwt-1' };
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockJsonResponse(200, { status: 'ok', data: { fresh_auth_proof: 'minted', message: 'ok' } }),
    );
  });

  afterEach(() => fetchSpy.mockRestore());

  it('mintSettingsActionProof POSTs /custody/fresh-auth with action+password and returns the proof', async () => {
    const proof = await mintSettingsActionProof('change_email', 'pw');
    expect(proof).toBe('minted');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/custody/fresh-auth');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jwt-1', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ action: 'change_email', password: 'pw' });
  });

  it('submitEmail includes fresh_auth_proof when provided and omits it when not', async () => {
    await submitEmail('e@x.com', 'proof-1');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ email: 'e@x.com', fresh_auth_proof: 'proof-1' });
    await submitEmail('e@x.com');
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ email: 'e@x.com' });
  });

  it('setPassword includes fresh_auth_proof when provided and omits it when not', async () => {
    await setPassword('Abcdefgh1x', 'proof-2');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ password: 'Abcdefgh1x', fresh_auth_proof: 'proof-2' });
    await setPassword('Abcdefgh1x');
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ password: 'Abcdefgh1x' });
  });

  it('deleteEmail includes fresh_auth_proof when provided and omits it when not', async () => {
    await deleteEmail(true, 'proof-3');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/settings/email');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ confirm: true, fresh_auth_proof: 'proof-3' });
    await deleteEmail(true);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ confirm: true });
  });
});

describe('mintIpfsUploadProof', () => {
  let fetchSpy;
  afterEach(() => { fetchSpy?.mockRestore(); });

  it('POSTs /api/custody/fresh-auth with the ipfs_upload action + password and returns the proof', async () => {
    authStore = { token: 'jwt-light', username: 'alice', custody: 'light' };
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockJsonResponse(200, { status: 'ok', data: { fresh_auth_proof: 'proof-xyz', expires_at: 't' } }),
    );

    const proof = await mintIpfsUploadProof('hunter2');
    expect(proof).toBe('proof-xyz');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/custody/fresh-auth');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jwt-light', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ action: 'ipfs_upload', password: 'hunter2' });
  });
});

describe('uploadFileToIpfs', () => {
  let fetchSpy;
  const makeFile = () => new Blob(['test-bytes'], { type: 'application/pdf' });
  afterEach(() => { fetchSpy?.mockRestore(); });

  it('self-custody signs the upload-token descriptor (no Bearer, no proof) then uploads with the token', async () => {
    authStore = { token: 'jwt-self', username: 'bob', custody: 'self' };
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJsonResponse(200, { status: 'ok', data: { upload_token: 'tok-1', expires_in: 60 } }))
      .mockResolvedValueOnce(mockJsonResponse(200, { status: 'ok', data: { cid: 'bafy', filename: 'paper.pdf' } }));

    const res = await uploadFileToIpfs(makeFile());
    expect(res.data.cid).toBe('bafy');

    const [tokenUrl, tokenInit] = fetchSpy.mock.calls[0];
    expect(tokenUrl).toBe('/api/ipfs/upload-token');
    expect(tokenInit.headers).toMatchObject({ 'X-Hive-Signature': 'stub-sig', 'Content-Type': 'application/json' });
    expect(tokenInit.headers.Authorization).toBeUndefined();
    expect(JSON.parse(tokenInit.body)).toMatchObject({ file_sha256: 'a'.repeat(64), mimetype: 'application/pdf' });
    expect('fresh_auth_proof' in JSON.parse(tokenInit.body)).toBe(false);

    const [uploadUrl, uploadInit] = fetchSpy.mock.calls[1];
    expect(uploadUrl).toBe('/api/ipfs/upload');
    expect(uploadInit.headers).toMatchObject({ Authorization: 'Bearer jwt-self', 'X-Upload-Token': 'tok-1' });
    expect(uploadInit.body).toBeInstanceOf(FormData);
  });

  it('light account sends the fresh-auth proof in the upload-token body and the token on upload', async () => {
    authStore = { token: 'jwt-light', username: 'alice', custody: 'light' };
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJsonResponse(200, { status: 'ok', data: { upload_token: 'tok-2', expires_in: 60 } }))
      .mockResolvedValueOnce(mockJsonResponse(200, { status: 'ok', data: { cid: 'bafy2', filename: 'f.pdf' } }));

    const res = await uploadFileToIpfs(makeFile(), { freshAuthProof: 'proof-abc' });
    expect(res.data.cid).toBe('bafy2');

    const [tokenUrl, tokenInit] = fetchSpy.mock.calls[0];
    expect(tokenUrl).toBe('/api/ipfs/upload-token');
    expect(tokenInit.headers).toMatchObject({ Authorization: 'Bearer jwt-light' });
    expect(JSON.parse(tokenInit.body)).toMatchObject({ file_sha256: 'a'.repeat(64), mimetype: 'application/pdf', fresh_auth_proof: 'proof-abc' });

    const [uploadUrl, uploadInit] = fetchSpy.mock.calls[1];
    expect(uploadUrl).toBe('/api/ipfs/upload');
    expect(uploadInit.headers).toMatchObject({ Authorization: 'Bearer jwt-light', 'X-Upload-Token': 'tok-2' });
  });

  it('light account without a proof throws FRESH_AUTH_REQUIRED before any pre-flight is sent', async () => {
    authStore = { token: 'jwt-light', username: 'alice', custody: 'light' };
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse(200, { status: 'ok', data: {} }));
    await expect(uploadFileToIpfs(makeFile())).rejects.toMatchObject({ code: 'FRESH_AUTH_REQUIRED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws UNAUTHORIZED when no session is present', async () => {
    authStore = null;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse(200, { status: 'ok', data: {} }));
    await expect(uploadFileToIpfs(makeFile())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
