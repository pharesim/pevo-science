// A password reset submitted from this browser settles this browser's session.
//
// Test focus: a reset revokes every session of its account and reissues none.
// The page sends the session this browser holds along with the reset, and the
// server answers `session_ended`, true only when that session belongs to the
// reset account. The page then has the auth store end it at once, without the
// signed-out message, so no later bearer request meets the revocation. A
// session for another account stays signed in. Every case drives the REAL
// reset-password page component into the REAL auth store (`initAuth`) through
// the REAL api.js request path, then reads what the browser holds afterwards:
// the stored session, the subject-bound tab state, what the reset and a later
// bearer request send and meet, and what a second tab of the browser makes of
// the storage events.
//
// Mocking justification (clause (a) of the project CLAUDE.md carve-out for
// deterministic edge-case coverage): only the network boundary is stubbed
// (`fetch` answers with the backend's envelopes), plus the `alpinejs` store
// registry every unit suite replaces, the sign-in modal the store would open,
// and the Keychain probe the store's module imports. A unit test has no
// backend to run the mailed reset link and the revocation against. Clause (b):
// no auth middleware is mocked and no cryptographic verification is bypassed;
// the cases assert what the client sends and what it does with the server's
// answers. Clause (c): the real-path companion is the signed-in reset in
// e2e/password-recovery.spec.js, which asserts the real route answers
// `session_ended: true` for the browser's session and that the browser holds
// no session afterwards; backend/tests/routes/auth-reset-session-match.test.ts
// pins the route's answer for each kind of bearer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import enMessages from '../../public/messages/en.json';

const { stores, dataDefs, signInModal } = vi.hoisted(() => ({
  stores: {},
  dataDefs: {},
  signInModal: { open: false, prompt: null },
}));

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn((name, factory) => { dataDefs[name] = factory; }),
    magic: vi.fn(),
    store: vi.fn((name, def) => {
      if (def !== undefined) stores[name] = def;
      return stores[name];
    }),
    $data: vi.fn(() => signInModal),
  },
}));

vi.mock('../../src/keychain.js', () => ({
  isKeychainInstalled: vi.fn(() => false),
  waitForKeychain: vi.fn(async () => false),
}));

import { initAuth } from '../../src/auth.js';
import { initToast } from '../../src/toast.js';
import { initResetPasswordPage } from '../../src/pages/reset-password.js';
import { fetchNotifications } from '../../src/api.js';
import { cacheSessionProof, clearCachedSessionProof } from '../../src/lib/fresh-auth.js';

const SESSION_KEY = 'pevo_session';
const WINDOW_KEY = 'pevo_fresh_auth_session_proof';
const FUTURE = '2099-01-01T00:00:00.000Z';

// The token in the reset link this browser opens, and the password it sets.
const RESET_TOKEN = 'e'.repeat(64);
const NEW_PASSWORD = 'NewSecurePass456';

const saved = (token, username) =>
  JSON.stringify({
    token,
    username,
    expiresAt: FUTURE,
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

// verifyHiveSignature's envelope for a bearer token the reset revoked.
const revokedResponse = () => ({
  ok: false,
  status: 401,
  headers: new Headers(),
  json: async () => ({
    status: 'error',
    error: { code: 'SESSION_INVALIDATED', message: 'Session has been invalidated. Please log in again.' },
  }),
});

const bearerOf = (call) => call[1]?.headers?.Authorization;

// The reset's answer. The link resets alice's password, so only her session
// is one the reset ended.
const resetAnswer = (init) =>
  okResponse({
    message: 'Password has been reset. Please log in with your new password.',
    session_ended: bearerOf([null, init]) === 'Bearer old-jwt',
  });

let answerReset;
let fetchSpy;

function signInAs(token, username) {
  localStorage.setItem(SESSION_KEY, saved(token, username));
  stores.auth._restoreSession();
}

function openWindow() {
  const now = Date.now();
  cacheSessionProof(
    'window-proof',
    new Date(now + 60_000).toISOString(),
    new Date(now + 3_600_000).toISOString(),
  );
}

function mountResetPage() {
  window.history.replaceState({}, '', `/reset-password?token=${RESET_TOKEN}`);
  const comp = dataDefs.resetPasswordPage();
  comp.$t = (key) => key;
  comp.init();
  comp.password = NEW_PASSWORD;
  comp.passwordConfirm = NEW_PASSWORD;
  return comp;
}

async function resetFromLink() {
  const comp = mountResetPage();
  await comp.handleReset();
  expect(comp.resetError).toBeNull();
  expect(comp.resetDone).toBe(true);
  return comp;
}

const resetCall = () => fetchSpy.mock.calls.find(([url]) => String(url) === '/api/auth/reset');
const storedSession = () => JSON.parse(localStorage.getItem(SESSION_KEY));

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(stores)) delete stores[k];
  for (const k of Object.keys(dataDefs)) delete dataDefs[k];
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div x-data="signInModal"></div>';
  signInModal.prompt = vi.fn(async () => null);
  initToast();
  initAuth();
  initResetPasswordPage();
  stores.i18n = { locale: 'en', messages: enMessages };
  stores.router = { navigate: vi.fn() };
  clearCachedSessionProof();
  answerReset = resetAnswer;
  // The server has revoked alice's session and nothing else.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accreditations/')) return okResponse(null);
    if (path === '/api/auth/reset') return answerReset(init);
    return bearerOf([url, init]) === 'Bearer old-jwt'
      ? revokedResponse()
      : okResponse({ events: [], latest_block: 0 });
  });
});

afterEach(() => {
  stores.auth?._stopAccreditationPolling();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a reset in a browser signed in to the reset account', () => {
  beforeEach(() => {
    signInAs('old-jwt', 'alice');
    openWindow();
  });

  it('sends the stored session along with the reset', async () => {
    await resetFromLink();

    const call = resetCall();
    expect(bearerOf(call)).toBe('Bearer old-jwt');
    expect(JSON.parse(call[1].body)).toEqual({ token: RESET_TOKEN, password: NEW_PASSWORD });
  });

  it('signs this browser out of the session the reset revoked', async () => {
    await resetFromLink();

    expect(stores.auth.isConnected).toBe(false);
    expect(stores.auth.token).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(sessionStorage.getItem(WINDOW_KEY)).toBeNull();
  });

  it('shows no signed-out message or sign-in prompt, then or on a later request', async () => {
    await resetFromLink();

    await expect(fetchNotifications(0)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const laterBearerCalls = fetchSpy.mock.calls.filter(
      (call) => bearerOf(call) && String(call[0]) !== '/api/auth/reset',
    );
    expect(laterBearerCalls).toEqual([]);
    expect(stores.toast.items).toEqual([]);
    expect(signInModal.prompt).not.toHaveBeenCalled();
  });

  it('ends the session when the page has gone before the answer', async () => {
    let answer;
    answerReset = (init) => new Promise((resolve) => { answer = () => resolve(resetAnswer(init)); });
    const comp = mountResetPage();

    const pending = comp.handleReset();
    comp.destroy();
    answer();
    await pending;

    expect(comp.resetDone).toBe(false);
    expect(stores.auth.isConnected).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

describe('a reset with a second tab signed in to the reset account', () => {
  // Storage events reach the other windows of a browser, never the one that
  // wrote, so the second tab's events are replayed here in the order the
  // writes happened, which is the order a browser delivers them in.
  function recordSessionWrites() {
    const writes = [];
    const { setItem, removeItem } = Storage.prototype;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === localStorage && key === SESSION_KEY) writes.push(value);
      return setItem.call(this, key, value);
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (key) {
      if (this === localStorage && key === SESSION_KEY) writes.push(null);
      return removeItem.call(this, key);
    });
    return writes;
  }

  it('signs the second tab out too, without a message', async () => {
    const secondTab = stores.auth;
    initAuth();
    signInAs('old-jwt', 'alice');
    secondTab._restoreSession();
    const writes = recordSessionWrites();

    await resetFromLink();
    for (const newValue of [...writes]) secondTab._handleStorageEvent({ key: SESSION_KEY, newValue });

    expect(stores.auth.isConnected).toBe(false);
    expect(secondTab.isConnected).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(stores.toast.items).toEqual([]);
    expect(signInModal.prompt).not.toHaveBeenCalled();
  });
});

describe('a reset in a browser signed in to another account', () => {
  beforeEach(() => {
    signInAs('bob-jwt', 'bob');
    openWindow();
  });

  it('leaves the other account signed in, with its tab state', async () => {
    await resetFromLink();

    expect(bearerOf(resetCall())).toBe('Bearer bob-jwt');
    expect(stores.auth.isConnected).toBe(true);
    expect(stores.auth.token).toBe('bob-jwt');
    expect(storedSession()).toMatchObject({ token: 'bob-jwt', username: 'bob' });
    expect(sessionStorage.getItem(WINDOW_KEY)).not.toBeNull();
  });
});

describe('a reset in a signed-out browser', () => {
  it('sends no session along and stays signed out', async () => {
    await resetFromLink();

    const call = resetCall();
    expect(bearerOf(call)).toBeUndefined();
    expect(JSON.parse(call[1].body)).toEqual({ token: RESET_TOKEN, password: NEW_PASSWORD });
    expect(stores.auth.isConnected).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

describe('a session that changed while the reset was in flight', () => {
  beforeEach(() => {
    signInAs('old-jwt', 'alice');
  });

  it('takes up a newer session another tab stored, rather than removing it', async () => {
    answerReset = (init) => {
      // Another tab signed in to bob, and this tab has not processed the
      // storage event yet.
      localStorage.setItem(SESSION_KEY, saved('bob-jwt', 'bob'));
      return resetAnswer(init);
    };

    await resetFromLink();

    expect(stores.auth.username).toBe('bob');
    expect(stores.auth.token).toBe('bob-jwt');
    expect(storedSession()).toMatchObject({ token: 'bob-jwt', username: 'bob' });
  });

  it('keeps a session this tab switched to', async () => {
    answerReset = (init) => {
      stores.auth.disconnect();
      signInAs('bob-jwt', 'bob');
      return resetAnswer(init);
    };

    await resetFromLink();

    expect(stores.auth.username).toBe('bob');
    expect(stores.auth.token).toBe('bob-jwt');
    expect(storedSession()).toMatchObject({ token: 'bob-jwt', username: 'bob' });
  });
});
