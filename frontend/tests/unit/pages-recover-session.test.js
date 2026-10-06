// A recovery submitted from this browser settles this browser's session.
//
// Test focus: an ORCID recovery, and the confirmation link of a seed-phrase
// recovery, each revoke every earlier session of the account and answer with
// a reissued one the server spares. The page hands that answer to the auth
// store, which takes the reissued session up unless the browser is signed in
// to another account. Seed-phrase recovery's first step changes nothing on
// the account, so it leaves the session alone. Every case drives the REAL
// recover or recover-verify page component into the REAL auth store
// (`initAuth`) through the REAL api.js request path, then reads what the
// browser holds afterwards: the stored session, the subject-bound tab state,
// what a later bearer request sends and meets, and what a second tab of the
// browser makes of the storage events.
//
// Mocking justification (clause (a) of the project CLAUDE.md carve-out for
// deterministic edge-case coverage): only the network boundary is stubbed
// (`fetch` answers with the backend's envelopes), plus the `alpinejs` store
// registry every unit suite replaces and the Keychain probe the store's
// module imports. A unit test has no backend to run the ORCID round-trip, the
// mailed confirmation link and the revocation against. Clause (b): no auth
// middleware is mocked and no cryptographic verification is bypassed; the
// cases assert what the client does with the server's answers. Clause (c):
// the real-path companions are the ORCID recovery round-trip in
// e2e/orcid-no-password.spec.js and the mailed-link round-trip in
// e2e/seed-recovery-links.spec.js, which each assert the browser holds the
// reissued session after a real recovery.
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
import { initRecoverVerifyPage } from '../../src/pages/recover-verify.js';
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

// The token in the seed-phrase confirmation link this browser opens.
const LINK_TOKEN = 'f'.repeat(64);

// The seed-phrase confirmation link's answer: the recovery applied and a
// session reissued.
const linkConfirmed = () =>
  okResponse({ token: 'link-jwt', expires_at: FUTURE, custody: 'light', username: 'alice' });

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
  initRecoverVerifyPage();
  stores.i18n = { locale: 'en', messages: enMessages };
  stores.router = { navigate: vi.fn(), query: { token: LINK_TOKEN } };
  clearCachedSessionProof();
  recoverAnswer = orcidRecovered;
  // The server has revoked alice's pre-recovery token and nothing else.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accreditations/')) return okResponse(null);
    if (path === '/api/auth/recover') return recoverAnswer();
    if (path === '/api/auth/recover/verify') return linkConfirmed();
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
      title: 'recover.doneTitle',
      description: 'recover.orcidDoneSignedIn',
      action: 'recover.goToSettings',
    });
    comp.doneAction();
    expect(stores.router.navigate).toHaveBeenCalledWith('/settings');
  });
});

describe('ORCID recovery with a second tab signed in to the recovered account', () => {
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

  it('leaves both tabs on the reissued session', async () => {
    const secondTab = stores.auth;
    initAuth();
    signInAs('old-jwt', 'alice');
    secondTab._restoreSession();
    const writes = recordSessionWrites();

    await recoverWithOrcid();
    for (const newValue of [...writes]) secondTab._handleStorageEvent({ key: SESSION_KEY, newValue });

    expect(secondTab.isConnected).toBe(true);
    expect(secondTab.token).toBe('new-jwt');
    expect(stores.auth.token).toBe('new-jwt');
    expect(storedSession()).toMatchObject({ token: 'new-jwt', username: 'alice' });
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

  it('says the browser is still signed in to another account, and offers to switch', async () => {
    const comp = await recoverWithOrcid();

    expect(comp.doneCopy).toEqual({
      title: 'recover.doneTitle',
      description: 'recover.orcidDoneOtherAccount',
      action: 'recover.switchAccount',
    });
  });

  it('switches to the recovered account when the user asks', async () => {
    const comp = await recoverWithOrcid();

    comp.doneAction();

    expect(comp.signedIn).toBe(true);
    expect(stores.auth.username).toBe('alice');
    expect(stores.auth.token).toBe('new-jwt');
    expect(storedSession()).toMatchObject({ token: 'new-jwt', username: 'alice' });
    expect(sessionStorage.getItem(WINDOW_KEY)).toBeNull();
    expect(comp.doneCopy.description).toBe('recover.orcidDoneSignedIn');
  });
});

describe('the first step of a seed-phrase recovery', () => {
  // Nothing on the account has changed yet, so the session stays as it was.
  async function recoverWithSeedPhrase() {
    recoverAnswer = seedStaged;
    const comp = mountRecoverPage();
    comp.username = 'alice';
    comp.seedPhrase = MNEMONIC;
    comp.newEmail = 'new@pevo.test';
    comp.newPassword = 'NewSecurePass456';
    comp.newPasswordConfirm = 'NewSecurePass456';
    await comp.handleSubmit();
    expect(comp.error).toBeNull();
    expect(comp.phase).toBe('done');
    return comp;
  }

  it('leaves a signed-in session alone', async () => {
    signInAs('old-jwt', 'alice');
    openWindow();

    await recoverWithSeedPhrase();

    expect(stores.auth.token).toBe('old-jwt');
    expect(storedSession()).toMatchObject({ token: 'old-jwt', username: 'alice' });
    expect(sessionStorage.getItem(WINDOW_KEY)).not.toBeNull();
  });

  it('leaves a signed-out browser signed out', async () => {
    await recoverWithSeedPhrase();

    expect(stores.auth.isConnected).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

describe('the confirmation link of a seed-phrase recovery', () => {
  async function confirmFromLink() {
    const comp = dataDefs.recoverVerifyPage();
    comp.$t = (key) => key;
    comp.init();
    await comp.submit();
    expect(comp.state).toBe('done');
    return comp;
  }

  it('replaces the revoked session of the recovered account and drops its proof window', async () => {
    signInAs('old-jwt', 'alice');
    openWindow();

    const comp = await confirmFromLink();

    expect(stores.auth.token).toBe('link-jwt');
    expect(storedSession()).toMatchObject({ token: 'link-jwt', username: 'alice', custody: 'light' });
    expect(sessionStorage.getItem(WINDOW_KEY)).toBeNull();
    expect(comp.doneCopy.description).toBe('recover.verifyDoneSignedIn');

    await fetchNotifications(0);
    const bearerCalls = fetchSpy.mock.calls.filter((call) => bearerOf(call));
    expect(bearerCalls.map(bearerOf)).toEqual(['Bearer link-jwt']);
    expect(stores.auth.isConnected).toBe(true);
  });

  it('signs a signed-out browser in, and sends the token without a bearer', async () => {
    const comp = await confirmFromLink();

    const verifyCall = fetchSpy.mock.calls.find(([url]) => String(url) === '/api/auth/recover/verify');
    expect(bearerOf(verifyCall)).toBeUndefined();
    expect(JSON.parse(verifyCall[1].body)).toEqual({ token: LINK_TOKEN });
    expect(stores.auth.isConnected).toBe(true);
    expect(storedSession()).toMatchObject({ token: 'link-jwt', username: 'alice' });
    comp.doneAction();
    expect(stores.router.navigate).toHaveBeenCalledWith('/settings');
  });

  it('leaves another signed-in account alone until the user switches', async () => {
    signInAs('bob-jwt', 'bob');
    openWindow();

    const comp = await confirmFromLink();

    expect(stores.auth.token).toBe('bob-jwt');
    expect(storedSession()).toMatchObject({ token: 'bob-jwt', username: 'bob' });
    expect(sessionStorage.getItem(WINDOW_KEY)).not.toBeNull();
    expect(comp.doneCopy.description).toBe('recover.verifyDoneOtherAccount');

    comp.doneAction();

    expect(stores.auth.username).toBe('alice');
    expect(stores.auth.token).toBe('link-jwt');
    expect(storedSession()).toMatchObject({ token: 'link-jwt', username: 'alice' });
    expect(sessionStorage.getItem(WINDOW_KEY)).toBeNull();
    expect(comp.doneCopy.description).toBe('recover.verifyDoneSignedIn');
  });
});
