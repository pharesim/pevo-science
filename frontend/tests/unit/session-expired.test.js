// A session past its expiry ends before any bearer request leaves the tab.
//
// Test focus: once the client clock passes the stored session's `expiresAt`,
// an authenticated request is not sent; the session ends once, the user is
// told it expired, and sign-in is offered. The in-flight fresh-auth flows
// (session acquisition, both consent-op orchestrators, the upload surface)
// unwind as that teardown, never as a wrong password, a spent re-auth or an
// ORCID fallback. Every case drives the REAL request path (`api.js` bearer
// helper, or `signer.js` for the custody broadcast) into the REAL auth store
// (`initAuth`) over the REAL `lib/fresh-auth.js` flows, with the real English
// bundle as the i18n messages.
//
// The fetch stub answers like the backend: a bearer token past its expiry
// cannot be verified, so `verifyHiveSignature` falls through to the signature
// branch and answers 401 UNAUTHORIZED. That is the answer the misreport came
// from, so a removed or bypassed client-side check fails these cases the way
// the bug did: a request goes out, and the flows read the 401 as a rejected
// password.
//
// Mocking justification (clause (a) of the project CLAUDE.md carve-out for
// deterministic edge-case coverage): only the network boundary is stubbed
// (`fetch`), plus the `alpinejs` store registry every unit suite replaces and
// the Keychain extension module (`keychain.js`). A real expired session needs
// a JWT that lives past its 24-hour lifetime inside one test, which only a
// controlled clock can produce. Clause (b): no auth middleware is mocked and
// no cryptographic verification is bypassed; the cases assert what the client
// does before and instead of sending. Clause (c): the risk class is the
// client's handling of a session the server will no longer accept, and its
// real-path companion is the revoked-session e2e spec requested when the
// SESSION_INVALIDATED handling landed, which drives the same teardown and
// sign-in offer against a real backend.
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
  // A self-custody upload signs its pre-flight descriptor through Keychain.
  signMessage: vi.fn(async () => ({ signature: 'keychain-signature' })),
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
  clearCachedConsentOpProof,
  clearPasswordFactorMemo,
  abandonInFlightAcquisitions,
  resolvePasswordFactor,
} from '../../src/lib/fresh-auth.js';
import { withSettingsFreshAuth } from '../../src/lib/settings-fresh-auth.js';
import { withAuthorshipFreshAuth } from '../../src/lib/authorship-consent.js';
import { uploadFile, describeUploadError } from '../../src/lib/ipfs-upload.js';

const SESSION_KEY = 'pevo_session';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const EXPIRES_AT = new Date(NOW + 3_600_000).toISOString();
const LATER = '2099-01-01T00:00:00.000Z';
const EXPIRED_COPY = enMessages.auth.sessionExpired;
const REVOKED_COPY = enMessages.auth.sessionRevoked;
const VOTE = [['vote', { voter: 'alice', author: 'bob', permlink: 'paper', weight: 10000 }]];
const AUTHORSHIP_TARGET = { action: 'author_accept', rootAuthor: 'bob', rootPermlink: 'paper' };

const saved = (token, expiresAt = EXPIRES_AT, username = 'alice') =>
  JSON.stringify({
    token,
    username,
    expiresAt,
    custody: 'light',
    isAccredited: false,
    accreditation: null,
  });

const okResponse = (data) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ status: 'ok', data }),
});

const errorResponse = (status, code, message) => ({
  ok: false,
  status,
  headers: new Headers(),
  json: async () => ({ status: 'error', error: { code, message } }),
});

// `verifyHiveSignature`'s answer to a bearer token it cannot verify.
const expiredJwtResponse = () =>
  errorResponse(401, 'UNAUTHORIZED', 'X-Hive-Username and X-Hive-Signature headers are required');

// What a live backend answers on each route these flows reach.
function liveAnswer(path) {
  if (path.startsWith('/api/settings/email')) return okResponse({ email: 'alice@uni.test', hasPassword: true });
  if (path.startsWith('/api/custody/session-auth')) {
    return okResponse({
      fresh_auth_proof: 'window-proof',
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      absolute_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
    });
  }
  if (path.startsWith('/api/custody/fresh-auth')) return okResponse({ fresh_auth_proof: 'op-proof' });
  if (path.startsWith('/api/ipfs/upload-token')) return okResponse({ upload_token: 'upload-token' });
  if (path.startsWith('/api/notifications')) return okResponse({ events: [], latest_block: 0, has_more: false });
  return okResponse({});
}

function mountSignInModal() {
  const el = document.createElement('div');
  el.setAttribute('x-data', 'signInModal');
  document.body.appendChild(el);
  // Never settles: the prompt stays open, as it does until the user acts.
  modalHolder.modal = { open: false, prompt: vi.fn(() => new Promise(() => {})) };
  return modalHolder.modal;
}

// Move the client clock past the session's expiry.
const expire = () => vi.setSystemTime(Date.parse(EXPIRES_AT) + 1_000);

// Open a session window a minute before the session expires, so the window is
// still inside its idle period when the session itself has ended.
function openWindowJustBeforeExpiry() {
  vi.setSystemTime(Date.parse(EXPIRES_AT) - 60_000);
  cacheSessionProof(
    'window-proof',
    new Date(Date.now() + 900_000).toISOString(),
    new Date(Date.now() + 7_200_000).toISOString(),
  );
}

// Let every pending continuation run without advancing the clock.
const settle = () => vi.advanceTimersByTimeAsync(0);

// Answer the open password prompt, as a user who knows their password would.
async function answerPrompt() {
  await vi.waitFor(() => expect(stores.reauthModal.open).toBe(true));
  stores.reauthModal.password = 'correct horse battery staple';
  stores.reauthModal.submit();
  await settle();
}

const toastMessages = () => stores.toast.items.map((t) => t.message);
const requestedPaths = () => fetchSpy.mock.calls.map(([url]) => String(url));
const bearerRequests = () =>
  fetchSpy.mock.calls.filter(([, init]) => init?.headers?.Authorization).map(([url]) => String(url));

let fetchSpy;
let promptSpy;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
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
  clearCachedConsentOpProof();
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();
  // Restore rather than log in: a login starts the accreditation poll, whose
  // own request would land on the fetch stub and blur the call counts.
  localStorage.setItem(SESSION_KEY, saved('live-jwt'));
  stores.auth._restoreSession();
  promptSpy = vi.spyOn(stores.reauthModal, 'request');
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    // The public accreditation read the store's poll fires after a restore.
    if (path.startsWith('/api/accreditations/')) return okResponse(null);
    const bearer = init?.headers?.Authorization;
    if (bearer && Date.now() >= Date.parse(EXPIRES_AT)) return expiredJwtResponse();
    return liveAnswer(path);
  });
});

afterEach(() => {
  stores.auth?._stopAccreditationPolling();
  stores.reauthModal?.cancel();
  vi.useRealTimers();
});

// Put the password factor in the memo the way a live session does: one status
// read that reports a password. A memo hit skips the status read, so the
// password prompt is the first thing an expired session meets.
async function warmPasswordMemo() {
  const factor = await resolvePasswordFactor();
  expect(factor).toEqual({ usesPassword: true, assumed: false });
  fetchSpy.mockClear();
}

describe('an authenticated api.js request on a session past its expiry', () => {
  it('sends nothing, ends the session, and says it expired', async () => {
    expire();

    await expect(fetchNotifications(0)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stores.auth.isConnected).toBe(false);
    expect(stores.auth.token).toBeNull();
    expect(stores.auth.username).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(EXPIRED_COPY).toBeTruthy();
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
    expect(stores.toast.items[0].type).toBe('error');
  });

  it('offers sign-in with the reason in the prompt', async () => {
    const modal = mountSignInModal();
    expire();

    await fetchNotifications(0).catch(() => {});

    expect(modal.prompt).toHaveBeenCalledTimes(1);
    expect(modal.prompt).toHaveBeenCalledWith({ notice: EXPIRED_COPY });
  });

  it('ends the session once when several requests meet the expiry', async () => {
    const modal = mountSignInModal();
    expire();

    await Promise.allSettled([fetchNotifications(0), fetchNotifications(0), fetchNotifications(0)]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
    expect(modal.prompt).toHaveBeenCalledTimes(1);
  });

  it('draws the line where a restore does: live before the expiry instant, ended at it', async () => {
    vi.setSystemTime(Date.parse(EXPIRES_AT) - 1);
    await fetchNotifications(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.parse(EXPIRES_AT));
    fetchSpy.mockClear();
    await expect(fetchNotifications(0)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(fetchSpy).not.toHaveBeenCalled();

    // A reload at this instant refuses the same session.
    localStorage.setItem(SESSION_KEY, saved('live-jwt'));
    stores.auth._restoreSession();
    expect(stores.auth.isConnected).toBe(false);
  });

  it('adopts a newer session another tab stored instead of signing every tab out', async () => {
    const modal = mountSignInModal();
    expire();
    // Another tab signed in again; this tab has not yet processed the storage
    // event when its own expired token is about to be sent.
    localStorage.setItem(SESSION_KEY, saved('new-jwt', LATER));

    await expect(fetchNotifications(0)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });

    // The adoption restarts the store's public accreditation poll; no request
    // carrying either token goes out.
    expect(bearerRequests()).toEqual([]);
    expect(stores.auth.isConnected).toBe(true);
    expect(stores.auth.token).toBe('new-jwt');
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)).token).toBe('new-jwt');
    expect(toastMessages()).toEqual([]);
    expect(modal.prompt).not.toHaveBeenCalled();
  });
});

describe('a session that has not expired', () => {
  it('sends the request with its token, as before', async () => {
    const modal = mountSignInModal();

    await fetchNotifications(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer live-jwt');
    expect(stores.auth.isConnected).toBe(true);
    expect(toastMessages()).toEqual([]);
    expect(modal.prompt).not.toHaveBeenCalled();
  });

  it('still ends a revoked session with the revoked message', async () => {
    fetchSpy.mockResolvedValue(
      errorResponse(401, 'SESSION_INVALIDATED', 'Session has been invalidated. Please log in again.'),
    );

    await expect(fetchNotifications(0)).rejects.toMatchObject({ code: 'SESSION_INVALIDATED' });

    expect(stores.auth.isConnected).toBe(false);
    expect(toastMessages()).toEqual([REVOKED_COPY]);
  });
});

describe('a password re-auth started on an expired session', () => {
  it('ends the session acquisition at the mint, without a second prompt', async () => {
    await warmPasswordMemo();
    expire();

    const flight = broadcastWithFreshAuth('alice', VOTE);
    await answerPrompt();

    expect(await flight).toBeNull();
    // One prompt, answered; no mint sent, so no rejection for the
    // second-rejection rule to count against the password.
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(stores.reauthModal.open).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stores.auth.isConnected).toBe(false);
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
  });

  it('ends a cold session acquisition at the status read, without any prompt', async () => {
    expire();

    expect(await broadcastWithFreshAuth('alice', VOTE)).toBeNull();

    expect(promptSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
  });

  it('cancels a settings action at the mint, without a second prompt', async () => {
    await warmPasswordMemo();
    expire();
    const run = vi.fn((proof) => submitEmail('new@uni.test', proof));

    const flight = withSettingsFreshAuth('change_email', { custody: 'light', username: 'alice' }, run);
    await answerPrompt();

    expect(await flight).toEqual({ cancelled: true });
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(stores.reauthModal.open).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
  });

  it('cancels a cold settings action at the status read, with no prompt and no ORCID start', async () => {
    expire();
    const run = vi.fn();

    const result = await withSettingsFreshAuth('change_email', { custody: 'light', username: 'alice' }, run);

    expect(result).toEqual({ cancelled: true });
    expect(promptSpy).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
  });

  it('cancels an authorship op at the mint, without a second prompt', async () => {
    await warmPasswordMemo();
    expire();
    const run = vi.fn();

    const flight = withAuthorshipFreshAuth(AUTHORSHIP_TARGET, { custody: 'light', username: 'alice' }, run);
    await answerPrompt();

    expect(await flight).toEqual({ cancelled: true });
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(stores.reauthModal.open).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
  });

  it('cancels a cold authorship op at the status read, with no prompt and no ORCID start', async () => {
    expire();
    const run = vi.fn();

    const result = await withAuthorshipFreshAuth(AUTHORSHIP_TARGET, { custody: 'light', username: 'alice' }, run);

    expect(result).toEqual({ cancelled: true });
    expect(promptSpy).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
  });
});

describe('the upload surface on an expired session', () => {
  // jsdom's Blob has no arrayBuffer(), which the pre-flight hash reads.
  const pickedFile = () => {
    const file = new File(['figure'], 'figure.png', { type: 'image/png' });
    file.arrayBuffer = async () => new TextEncoder().encode('figure').buffer;
    return file;
  };

  it('abandons an upload whose window needs a password, without a second prompt', async () => {
    await warmPasswordMemo();
    expire();

    const flight = uploadFile(pickedFile()).catch((err) => err);
    await answerPrompt();
    const err = await flight;

    // The already-reported shape: the page adds nothing to the expiry message.
    expect(describeUploadError(err)).toBeNull();
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(stores.reauthModal.open).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
  });

  it('refuses an upload under an open window without retrying it, adding nothing to the expiry message', async () => {
    openWindowJustBeforeExpiry();
    expire();

    const err = await uploadFile(pickedFile()).catch((e) => e);

    expect(describeUploadError(err)).toBeNull();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stores.auth.isConnected).toBe(false);
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
  });

  it('abandons a self-custody upload whose transfer leg meets the expiry, adding nothing to the expiry message', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...JSON.parse(saved('self-jwt')), custody: 'self' }));
    stores.auth._restoreSession();
    expire();

    const err = await uploadFile(pickedFile()).catch((e) => e);

    // The Keychain-signed pre-flight carries no bearer token, so the transfer
    // leg is the first request to meet the expiry check, and it is not sent.
    expect(requestedPaths()).toEqual(['/api/ipfs/upload-token']);
    expect(bearerRequests()).toEqual([]);
    expect(stores.auth.isConnected).toBe(false);
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
    expect(describeUploadError(err)).toBeNull();
  });

  it('still reports the refused upload when a newer session of the same account was adopted', async () => {
    openWindowJustBeforeExpiry();
    expire();
    localStorage.setItem(SESSION_KEY, saved('new-jwt', LATER));

    const err = await uploadFile(pickedFile()).catch((e) => e);

    // Nothing was torn down and nothing said, so the page reports the failure.
    expect(stores.auth.token).toBe('new-jwt');
    expect(bearerRequests()).toEqual([]);
    expect(toastMessages()).toEqual([]);
    expect(describeUploadError(err)).toBe('common.uploadFailed');
  });

  it('says the session changed when another account was adopted under the upload', async () => {
    openWindowJustBeforeExpiry();
    expire();
    localStorage.setItem(SESSION_KEY, saved('bob-jwt', LATER, 'bob'));

    const err = await uploadFile(pickedFile()).catch((e) => e);

    expect(stores.auth.username).toBe('bob');
    expect(bearerRequests()).toEqual([]);
    expect(toastMessages()).toEqual([enMessages.auth.reauthCancelled]);
    expect(describeUploadError(err)).toBeNull();
  });
});

describe('the custody broadcast on an expired session', () => {
  it('sends nothing under a window that outlived the session, and ends the session once', async () => {
    const modal = mountSignInModal();
    openWindowJustBeforeExpiry();
    expire();

    // The clean-abort sentinel: the call site adds nothing to the expiry message.
    expect(await broadcastWithFreshAuth('alice', VOTE)).toBeNull();

    expect(requestedPaths()).toEqual([]);
    expect(stores.auth.isConnected).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
    expect(modal.prompt).toHaveBeenCalledWith({ notice: EXPIRED_COPY });
  });
});

describe('a consent op on an expired session', () => {
  it('cancels a settings action whose cached proof outlived the session', async () => {
    const modal = mountSignInModal();
    cacheConsentOpProof('orcid-proof', LATER, 'change_email', 'alice', '');
    expire();
    const run = vi.fn((proof) => submitEmail('new@uni.test', proof));

    const result = await withSettingsFreshAuth('change_email', { custody: 'light', username: 'alice' }, run);

    // The guarded call itself met the expiry; the action is abandoned as the
    // teardown's own outcome, so the page adds nothing to the expiry message.
    expect(result).toEqual({ cancelled: true });
    expect(run).toHaveBeenCalledWith('orcid-proof');
    expect(promptSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stores.auth.isConnected).toBe(false);
    expect(toastMessages()).toEqual([EXPIRED_COPY]);
    expect(modal.prompt).toHaveBeenCalledWith({ notice: EXPIRED_COPY });
  });
});
