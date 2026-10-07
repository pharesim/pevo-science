// A server-revoked session (401 SESSION_INVALIDATED) tears the session down.
//
// Test focus: a bearer request answered `401 SESSION_INVALIDATED` clears the
// stored session, tells the user why, and offers sign-in, without the call
// site doing anything. Every case drives the REAL request path (`api.js`
// bearer helper, or `signer.js` for the custody broadcast) into the REAL auth
// store (`initAuth`) over the REAL `lib/fresh-auth.js` teardown, with the real
// English bundle as the i18n messages. Nothing here builds an error object by
// hand: the rejection is whatever the request path makes of the wire
// response, so a change to how that path surfaces error codes fails these
// cases.
//
// Mocking justification (clause (a) of the project CLAUDE.md carve-out for
// deterministic edge-case coverage): only the network boundary is stubbed
// (`fetch` answers with the backend's envelope for this code), plus the
// `alpinejs` store registry every unit suite replaces and the Keychain probe
// the store's module imports. Producing the real response needs an account
// whose credentials rotate on a second device between two requests, and the
// late-rejection case needs the response to arrive after a cross-tab token
// swap, which only a test-controlled settle can order. Clause (b): no auth
// middleware is mocked and no cryptographic verification is bypassed; the
// cases assert what the client does with the server's answer. Clause (c): the
// real-path companion for this risk class (a second device's session
// outliving a credential rotation) is `tests/e2e/session-revoked.spec.js`,
// which revokes a signed-in browser's session with a real password reset from
// another context and asserts the same teardown against the real backend.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import enMessages from '../../public/messages/en.json';

const { stores, modalHolder } = vi.hoisted(() => ({ stores: {}, modalHolder: { modal: null } }));

// A named store registry, so `initAuth()` registers the real auth store and
// every `Alpine.store('auth')` read in api.js, signer.js and fresh-auth.js
// resolves to that same object. `$data` hands back the sign-in modal stand-in
// for the element the store looks up.
vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    magic: vi.fn(),
    store: vi.fn((name, def) => {
      if (def !== undefined) stores[name] = def;
      return stores[name];
    }),
    $data: vi.fn(() => modalHolder.modal),
  },
}));

vi.mock('../../src/keychain.js', () => ({
  isKeychainInstalled: vi.fn(() => false),
  waitForKeychain: vi.fn(async () => false),
}));

import { initAuth } from '../../src/auth.js';
import { initToast } from '../../src/toast.js';
import { initReauthModal } from '../../src/components/reauth-modal.js';
import { fetchNotifications, submitEmail } from '../../src/api.js';
import {
  broadcastWithFreshAuth,
  cacheConsentOpProof,
  cacheSessionProof,
  clearCachedSessionProof,
  clearPasswordFactorMemo,
  abandonInFlightAcquisitions,
} from '../../src/lib/fresh-auth.js';
import { withSettingsFreshAuth } from '../../src/lib/settings-fresh-auth.js';
import { uploadFile, describeUploadError } from '../../src/lib/ipfs-upload.js';

const SESSION_KEY = 'pevo_session';
const FUTURE = '2099-01-01T00:00:00.000Z';
const REVOKED_COPY = enMessages.auth.sessionRevoked;

const saved = (token, username = 'alice') =>
  JSON.stringify({
    token,
    username,
    expiresAt: FUTURE,
    custody: 'light',
    isAccredited: false,
    accreditation: null,
  });

// The backend's exact envelope for this code (`sendError` in
// verifyHiveSignature's bearer branch): no `details`, no `data`.
const revokedResponse = () => ({
  ok: false,
  status: 401,
  headers: new Headers(),
  json: async () => ({
    status: 'error',
    error: { code: 'SESSION_INVALIDATED', message: 'Session has been invalidated. Please log in again.' },
  }),
});

const okResponse = (data) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ status: 'ok', data }),
});

function mountSignInModal() {
  const el = document.createElement('div');
  el.setAttribute('x-data', 'signInModal');
  document.body.appendChild(el);
  // Never settles: the prompt stays open, as it does until the user acts.
  modalHolder.modal = { open: false, prompt: vi.fn(() => new Promise(() => {})) };
  return modalHolder.modal;
}

// Open a live session window, so the guarded request is the first to meet the
// revoked token.
const openWindow = () => {
  const now = Date.now();
  cacheSessionProof(
    'window-proof',
    new Date(now + 60_000).toISOString(),
    new Date(now + 3_600_000).toISOString(),
  );
};

let fetchSpy;

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(stores)) delete stores[k];
  document.body.innerHTML = '';
  modalHolder.modal = null;
  localStorage.clear();
  sessionStorage.clear();
  initToast();
  initReauthModal();
  initAuth();
  stores.i18n = { locale: 'en', messages: enMessages };
  // Module state in fresh-auth.js outlives a test; reset what these cases read.
  clearCachedSessionProof();
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();
  // Restore rather than log in: a login starts the accreditation poll, whose
  // own request would land on the fetch stub and blur the call counts.
  localStorage.setItem(SESSION_KEY, saved('old-jwt'));
  stores.auth._restoreSession();
  // Every request meets the revoked token, except the public accreditation
  // status read the store's poll fires after a cross-tab restore.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
    String(url).startsWith('/api/accreditations/') ? okResponse(null) : revokedResponse(),
  );
});

afterEach(() => {
  stores.auth?._stopAccreditationPolling();
  vi.useRealTimers();
});

describe('a revoked bearer token on an authenticated api.js request', () => {
  it('clears the stored session and tells the user why', async () => {
    expect(stores.auth.isConnected).toBe(true);

    await expect(fetchNotifications(0)).rejects.toMatchObject({ code: 'SESSION_INVALIDATED' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer old-jwt');
    expect(stores.auth.isConnected).toBe(false);
    expect(stores.auth.token).toBeNull();
    expect(stores.auth.username).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(REVOKED_COPY).toBeTruthy();
    expect(stores.toast.items.map((t) => t.message)).toEqual([REVOKED_COPY]);
    expect(stores.toast.items[0].type).toBe('error');
  });

  it('leaves nothing for a reload to restore', async () => {
    await fetchNotifications(0).catch(() => {});

    // A reload re-runs the restore over whatever storage holds.
    stores.auth._restoreSession();

    expect(stores.auth.isConnected).toBe(false);
    expect(stores.auth.token).toBeNull();
  });

  it('offers sign-in on the current page', async () => {
    const modal = mountSignInModal();

    await fetchNotifications(0).catch(() => {});

    expect(modal.prompt).toHaveBeenCalledTimes(1);
    // The reason rides into the prompt, which outlives the timed message.
    expect(modal.prompt).toHaveBeenCalledWith({ notice: REVOKED_COPY });
  });

  it('does not open a second prompt over a sign-in modal that is already open', async () => {
    const modal = mountSignInModal();
    modal.open = true;

    await fetchNotifications(0).catch(() => {});

    expect(modal.prompt).not.toHaveBeenCalled();
    expect(stores.auth.isConnected).toBe(false);
  });

  it('tears down once when several requests are rejected for the same token', async () => {
    const modal = mountSignInModal();

    await Promise.allSettled([fetchNotifications(0), fetchNotifications(0), fetchNotifications(0)]);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(stores.toast.items.map((t) => t.message)).toEqual([REVOKED_COPY]);
    expect(modal.prompt).toHaveBeenCalledTimes(1);
  });

  it('sends nothing further once torn down', async () => {
    await fetchNotifications(0).catch(() => {});
    fetchSpy.mockClear();

    await expect(fetchNotifications(0)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps a session whose token was replaced while the rejected request was in flight', async () => {
    const modal = mountSignInModal();
    let settle;
    fetchSpy.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const inFlight = fetchNotifications(0).catch((err) => err);

    // Another tab's credential rotation reissued the token; this tab adopts it
    // through the storage event while the old token's request is unanswered.
    localStorage.setItem(SESSION_KEY, saved('new-jwt'));
    stores.auth._handleStorageEvent({ key: SESSION_KEY, newValue: saved('new-jwt') });
    expect(stores.auth.token).toBe('new-jwt');

    settle(revokedResponse());
    const err = await inFlight;

    expect(err.code).toBe('SESSION_INVALIDATED');
    expect(stores.auth.isConnected).toBe(true);
    expect(stores.auth.token).toBe('new-jwt');
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)).token).toBe('new-jwt');
    expect(stores.toast.items).toEqual([]);
    expect(modal.prompt).not.toHaveBeenCalled();
  });

  it('adopts a reissued session already in storage instead of tearing down', async () => {
    const modal = mountSignInModal();
    // Another tab saved the reissued session; this tab has not yet processed
    // the storage event when the old token's rejection arrives.
    localStorage.setItem(SESSION_KEY, saved('new-jwt'));

    await expect(fetchNotifications(0)).rejects.toMatchObject({ code: 'SESSION_INVALIDATED' });

    expect(stores.auth.isConnected).toBe(true);
    expect(stores.auth.token).toBe('new-jwt');
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)).token).toBe('new-jwt');
    expect(stores.toast.items).toEqual([]);
    expect(modal.prompt).not.toHaveBeenCalled();
  });

  it('tears down when the only other stored session has expired', async () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...JSON.parse(saved('stale-jwt')), expiresAt: '2000-01-01T00:00:00.000Z' }),
    );

    await fetchNotifications(0).catch(() => {});

    expect(stores.auth.isConnected).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(stores.toast.items.map((t) => t.message)).toEqual([REVOKED_COPY]);
  });

  it('leaves the session alone on any other 401', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({ status: 'error', error: { code: 'UNAUTHORIZED', message: 'Session is no longer valid' } }),
    });

    await expect(fetchNotifications(0)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(stores.auth.isConnected).toBe(true);
    expect(localStorage.getItem(SESSION_KEY)).not.toBeNull();
    expect(stores.toast.items).toEqual([]);
  });
});

describe('a revoked bearer token on the custody broadcast', () => {
  it('tears down once and neither re-mints nor retries', async () => {
    const modal = mountSignInModal();
    openWindow();

    // The clean-abort sentinel: the call site adds nothing to the revoked
    // message, where the rejection itself would draw its own failure message.
    expect(await broadcastWithFreshAuth('alice', [['vote', {}]])).toBeNull();

    // One request: the broadcast itself. No status read, no mint, no retry.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/custody/broadcast');
    expect(stores.auth.isConnected).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    // One message: the teardown's own, with no cancelled-confirmation or
    // re-auth-failed message stacked on it.
    expect(stores.toast.items.map((t) => t.message)).toEqual([REVOKED_COPY]);
    expect(stores.reauthModal.open).toBe(false);
    expect(modal.prompt).toHaveBeenCalledTimes(1);
  });

  it('ends a cold acquisition silently, without asking for a password', async () => {
    // No open window: the acquisition's first request is the account status
    // read, which is what meets the revoked token.
    const result = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/settings/email');
    expect(stores.reauthModal.open).toBe(false);
    expect(stores.auth.isConnected).toBe(false);
    expect(stores.toast.items.map((t) => t.message)).toEqual([REVOKED_COPY]);
  });

  it('keeps a session whose token was replaced while the broadcast was in flight', async () => {
    openWindow();
    let settle;
    fetchSpy.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const inFlight = broadcastWithFreshAuth('alice', [['vote', {}]]).catch((e) => e);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    localStorage.setItem(SESSION_KEY, saved('new-jwt'));
    stores.auth._handleStorageEvent({ key: SESSION_KEY, newValue: saved('new-jwt') });
    settle(revokedResponse());
    const err = await inFlight;

    expect(err.code).toBe('SESSION_INVALIDATED');
    expect(stores.auth.token).toBe('new-jwt');
    expect(stores.toast.items).toEqual([]);
  });

  it('leaves the session alone when the broadcast fails for any other reason', async () => {
    const modal = mountSignInModal();
    openWindow();
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({ status: 'error', error: { code: 'FORBIDDEN', message: 'Operation not allowed' } }),
    });

    const err = await broadcastWithFreshAuth('alice', [['vote', {}]]).catch((e) => e);

    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(stores.auth.isConnected).toBe(true);
    expect(localStorage.getItem(SESSION_KEY)).not.toBeNull();
    expect(stores.toast.items).toEqual([]);
    expect(modal.prompt).not.toHaveBeenCalled();
  });

  it('does not disturb a successful broadcast', async () => {
    openWindow();
    fetchSpy.mockResolvedValue(okResponse({ tx_id: 'abc' }));

    const res = await broadcastWithFreshAuth('alice', [['vote', {}]]);

    expect(res).toMatchObject({ data: { tx_id: 'abc' } });
    expect(stores.auth.isConnected).toBe(true);
  });
});

describe('a revoked bearer token on the upload surface', () => {
  // jsdom's Blob has no arrayBuffer(), which the pre-flight hash reads.
  const pickedFile = () => {
    const file = new File(['figure'], 'figure.png', { type: 'image/png' });
    file.arrayBuffer = async () => new TextEncoder().encode('figure').buffer;
    return file;
  };

  it('abandons an upload under an open window, adding nothing to the revoked message', async () => {
    openWindow();

    const err = await uploadFile(pickedFile()).catch((e) => e);

    // One request: the pre-flight. No retry, no re-acquisition.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/ipfs/upload-token');
    expect(stores.auth.isConnected).toBe(false);
    expect(describeUploadError(err)).toBeNull();
    expect(stores.toast.items.map((t) => t.message)).toEqual([REVOKED_COPY]);
  });
});

describe('a revoked bearer token on a consent op', () => {
  it('cancels a settings action whose guarded call meets the revoked token', async () => {
    const modal = mountSignInModal();
    cacheConsentOpProof('orcid-proof', FUTURE, 'change_email', 'alice', '');
    const run = vi.fn((proof) => submitEmail('new@uni.test', proof));

    const result = await withSettingsFreshAuth('change_email', { custody: 'light', username: 'alice' }, run);

    expect(result).toEqual({ cancelled: true });
    expect(run).toHaveBeenCalledWith('orcid-proof');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(stores.reauthModal.open).toBe(false);
    expect(stores.auth.isConnected).toBe(false);
    expect(stores.toast.items.map((t) => t.message)).toEqual([REVOKED_COPY]);
    expect(modal.prompt).toHaveBeenCalledWith({ notice: REVOKED_COPY });
  });
});
