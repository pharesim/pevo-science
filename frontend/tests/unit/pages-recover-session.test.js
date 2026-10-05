// A recovery submitted from this browser settles this browser's session.
//
// Test focus: an ORCID recovery revokes every earlier session of the account
// and answers with a reissued one the server spares. The recover page hands
// that answer to the auth store, which takes the reissued session up unless
// the browser is signed in to another account. Seed-phrase recovery's first
// step changes nothing on the account, so it leaves the session alone. Every
// case drives the REAL recover page component into the REAL auth store
// (`initAuth`) through the REAL api.js request path, then reads what the
// browser holds afterwards: the stored session, the subject-bound tab state,
// and what a later bearer request sends and meets.
//
// Mocking justification (clause (a) of the project CLAUDE.md carve-out for
// deterministic edge-case coverage): only the network boundary is stubbed
// (`fetch` answers with the backend's envelopes), plus the `alpinejs` store
// registry every unit suite replaces and the Keychain probe the store's
// module imports. The revoked-then-reissued pair needs a completed ORCID
// round-trip against a live provider, and the later-request case needs the
// server to reject exactly the pre-recovery token, which only a
// test-controlled answer can arrange per request. Clause (b): no auth
// middleware is mocked and no cryptographic verification is bypassed; the
// cases assert what the client does with the server's answers. Clause (c):
// the real-path companion is the ORCID recovery round-trip in
// e2e/orcid-no-password.spec.js, which asserts the browser holds the reissued
// session after a real recovery.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import enMessages from '../../public/messages/en.json';

const { stores, dataDefs } = vi.hoisted(() => ({ stores: {}, dataDefs: {} }));

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn((name, factory) => { dataDefs[name] = factory; }),
    magic: vi.fn(),
    store: vi.fn((name, def) => {
      if (def !== undefined) stores[name] = def;
      return stores[name];
    }),
    $data: vi.fn(() => null),
  },
}));

vi.mock('../../src/keychain.js', () => ({
  isKeychainInstalled: vi.fn(() => false),
  waitForKeychain: vi.fn(async () => false),
}));

import { initAuth } from '../../src/auth.js';
import { initToast } from '../../src/toast.js';
import { initRecoverPage } from '../../src/pages/recover.js';
import { fetchNotifications } from '../../src/api.js';
import { cacheSessionProof, clearCachedSessionProof } from '../../src/lib/fresh-auth.js';

const SESSION_KEY = 'pevo_session';
const WINDOW_KEY = 'pevo_fresh_auth_session_proof';
const FUTURE = '2099-01-01T00:00:00.000Z';
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

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

// verifyHiveSignature's envelope for a bearer token the recovery revoked.
const revokedResponse = () => ({
  ok: false,
  status: 401,
  headers: new Headers(),
  json: async () => ({
    status: 'error',
    error: { code: 'SESSION_INVALIDATED', message: 'Session has been invalidated. Please log in again.' },
  }),
});

// The ORCID path's answer: the recovery applied and a session reissued.
const orcidRecovered = () =>
  okResponse({ token: 'new-jwt', expires_at: FUTURE, custody: 'light', username: 'alice' });

// The seed-phrase path's first-step answer: nothing applied yet.
const seedStaged = () =>
  okResponse({
    recovery: 'pending_verification',
    message: 'Confirm the recovery by clicking the link sent to n***w@***.edu.',
  });

let recoverAnswer;
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

function mountRecoverPage() {
  const comp = dataDefs.recoverPage();
  comp.$t = (key) => key;
  return comp;
}

async function recoverWithOrcid() {
  const comp = mountRecoverPage();
  comp.method = 'orcid';
  comp.username = 'alice';
  comp.orcidToken = 'orcid-token';
  comp.newEmail = 'new@pevo.test';
  await comp.handleSubmit();
  return comp;
}

const storedSession = () => JSON.parse(localStorage.getItem(SESSION_KEY));
const bearerOf = (call) => call[1]?.headers?.Authorization;

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(stores)) delete stores[k];
  for (const k of Object.keys(dataDefs)) delete dataDefs[k];
  localStorage.clear();
  sessionStorage.clear();
  initToast();
  initAuth();
  initRecoverPage();
  stores.i18n = { locale: 'en', messages: enMessages };
  stores.router = { navigate: vi.fn() };
  clearCachedSessionProof();
  recoverAnswer = orcidRecovered;
  // The server has revoked alice's pre-recovery token and nothing else.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accreditations/')) return okResponse(null);
    if (path === '/api/auth/recover') return recoverAnswer();
    return bearerOf([url, init]) === 'Bearer old-jwt' ? revokedResponse() : okResponse({ notifications: [] });
  });
});

afterEach(() => {
  stores.auth?._stopAccreditationPolling();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ORCID recovery in a browser signed in to the recovered account', () => {
  beforeEach(() => {
    signInAs('old-jwt', 'alice');
    openWindow();
  });

  it('replaces the revoked session with the reissued one', async () => {
    const comp = await recoverWithOrcid();

    expect(comp.phase).toBe('done');
    expect(stores.auth.token).toBe('new-jwt');
    expect(stores.auth.username).toBe('alice');
    expect(storedSession()).toMatchObject({ token: 'new-jwt', username: 'alice', custody: 'light' });
    expect(comp.doneCopy.description).toBe('recover.orcidDoneSignedIn');
  });

  it('drops the session-proof window the recovery revoked', async () => {
    expect(sessionStorage.getItem(WINDOW_KEY)).not.toBeNull();

    await recoverWithOrcid();

    expect(sessionStorage.getItem(WINDOW_KEY)).toBeNull();
  });

  it('sends the reissued token on a later request, which meets no teardown', async () => {
    await recoverWithOrcid();

    await fetchNotifications(0);

    const bearerCalls = fetchSpy.mock.calls.filter((call) => bearerOf(call));
    expect(bearerCalls.map(bearerOf)).toEqual(['Bearer new-jwt']);
    expect(stores.auth.isConnected).toBe(true);
    expect(stores.toast.items).toEqual([]);
  });
});

describe('ORCID recovery in a signed-out browser', () => {
  it('signs in with the reissued session', async () => {
    const comp = await recoverWithOrcid();

    expect(stores.auth.isConnected).toBe(true);
    expect(stores.auth.token).toBe('new-jwt');
    expect(storedSession()).toMatchObject({ token: 'new-jwt', username: 'alice' });
    expect(comp.doneCopy).toEqual({
      description: 'recover.orcidDoneSignedIn',
      action: 'recover.goToSettings',
      path: '/settings',
    });
  });
});

describe('ORCID recovery in a browser signed in to another account', () => {
  beforeEach(() => {
    signInAs('bob-jwt', 'bob');
    openWindow();
  });

  it('leaves the other account signed in, with its tab state', async () => {
    const comp = await recoverWithOrcid();

    expect(comp.phase).toBe('done');
    expect(stores.auth.username).toBe('bob');
    expect(stores.auth.token).toBe('bob-jwt');
    expect(storedSession()).toMatchObject({ token: 'bob-jwt', username: 'bob' });
    expect(sessionStorage.getItem(WINDOW_KEY)).not.toBeNull();
  });

  it('says the browser is still signed in to another account', async () => {
    const comp = await recoverWithOrcid();

    expect(comp.doneCopy).toEqual({
      description: 'recover.orcidDoneOtherAccount',
      action: 'common.goToPapers',
      path: '/papers',
    });
  });
});

describe('the first step of a seed-phrase recovery', () => {
  it('leaves the session alone, since nothing on the account has changed yet', async () => {
    recoverAnswer = seedStaged;
    signInAs('old-jwt', 'alice');
    openWindow();
    const comp = mountRecoverPage();
    comp.username = 'alice';
    comp.seedPhrase = MNEMONIC;
    comp.newEmail = 'new@pevo.test';
    comp.newPassword = 'NewSecurePass456';
    comp.newPasswordConfirm = 'NewSecurePass456';

    await comp.handleSubmit();

    expect(comp.error).toBeNull();
    expect(comp.phase).toBe('done');
    expect(stores.auth.token).toBe('old-jwt');
    expect(storedSession()).toMatchObject({ token: 'old-jwt', username: 'alice' });
    expect(sessionStorage.getItem(WINDOW_KEY)).not.toBeNull();
  });
});
