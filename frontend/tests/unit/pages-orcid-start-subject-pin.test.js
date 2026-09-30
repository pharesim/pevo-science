// Subject pin across the page-level ORCID start round-trips.
//
// Test focus: `settings.js#handleOrcidLink` (mode `link`) and
// `accreditation.js#handleOrcidVerify` (mode `accredit`) each write the ORCID
// mode marker, await the start request, and then navigate the tab to ORCID.
// The start request is minted under the JWT of whoever clicked, so a subject
// teardown landing inside that await (a login as another user in this tab, a
// cross-tab login or sign-out arriving through the storage event) must end the
// flow as a silent clean cancel: no navigation on the departed subject's
// behalf, the busy flag released, and no storage key removed, because the
// scrub that tore the subject down already took this flow's keys and whatever
// stands in them afterwards belongs to a later flow.
//
// The subject change is driven through the REAL auth store (`initAuth`) over
// the REAL `lib/fresh-auth.js`, not through a staged helper: the pin reads the
// teardown generation the store's own scrub bumps, so a hand-rolled teardown
// would prove only that the test and the page agree with each other.
//
// Mocking justification (clause (a) of the project CLAUDE.md carve-out for
// deterministic edge-case coverage): `startOrcid` performs a real fetch, and
// every case here parks the flow on that round-trip and lands the subject
// change while it is parked, which needs the round-trip to settle on the
// test's signal rather than the network's. Asserting that NO navigation
// happened requires observing `window.location` rather than following it. The
// remaining stubs (the accreditation status read the store's polling fires,
// the admin-roster probe, keychain, hive-keys, the signer) are module-load
// dependencies of the two pages and the store; no case here exercises them.
// Clause (b): no auth middleware is mocked and no cryptographic verification
// is bypassed; these cases assert what the client does with a start whose
// subject is gone. Clause (c): the integrated start-then-callback path runs
// real in `frontend/tests/e2e/settings-orcid-factor.spec.js` and
// `frontend/tests/e2e/orcid-no-password.spec.js`; no e2e spec changes the
// subject while a start is parked, so the mid-await class is covered here
// only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { stores, mockStartOrcid } = vi.hoisted(() => ({
  stores: {},
  mockStartOrcid: vi.fn(),
}));

// A named store registry, so `initAuth()` registers the real auth store and
// every `Alpine.store('auth')` read in the pages and in fresh-auth.js resolves
// to that same object.
vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name, def) => {
      if (def !== undefined) stores[name] = def;
      return stores[name] ?? {};
    }),
  },
}));

vi.mock('../../src/api.js', async (importActual) => ({
  ...(await importActual()),
  startOrcid: (...args) => mockStartOrcid(...args),
  fetchAccreditationStatus: vi.fn(async () => ({ data: null })),
  fetchAdminRoster: vi.fn(async () => ({ data: { tier: null } })),
  fetchEmailStatus: vi.fn(async () => ({ data: { hasPassword: true } })),
}));

vi.mock('../../src/keychain.js', () => ({
  isKeychainInstalled: vi.fn(() => false),
  waitForKeychain: vi.fn(async () => false),
}));

vi.mock('../../src/sign-request.js', () => ({ signRequest: vi.fn() }));
vi.mock('../../src/signer.js', () => ({ broadcastOps: vi.fn() }));

vi.mock('../../src/hive-keys.js', () => ({
  deriveHiveKeys: vi.fn(),
  deriveHivePublicKeys: vi.fn(),
  loadDhive: vi.fn(),
  generateMnemonic: vi.fn(),
  validateMnemonic: vi.fn(),
}));

vi.mock('../../src/components/paper-card.js', () => ({
  formatDate: (d) => d || '',
}));

import Alpine from 'alpinejs';
import { initAuth } from '../../src/auth.js';
import { initSettingsPage } from '../../src/pages/settings.js';
import { initAccreditationPage } from '../../src/pages/accreditation.js';
import { ORCID_MODE_KEY, RETURN_PATH_KEY } from '../../src/lib/subject-bound-keys.js';

const SESSION_KEY = 'pevo_session';
const FUTURE = '2099-01-01T00:00:00.000Z';
const ORCID_URL = 'https://orcid.org/oauth/authorize?x=1';

function session(username) {
  return {
    token: `${username}-jwt`,
    expires_at: FUTURE,
    username,
    custody: 'light',
    is_accredited: false,
    accreditation: null,
  };
}

function mountPage(init) {
  init();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  return comp;
}

// The two flows under test, as one table: how to mount the page, which handler
// starts the round-trip, which busy flag it holds, and the mode it writes.
const FLOWS = [
  {
    name: 'settings ORCID link',
    mount: () => mountPage(initSettingsPage),
    start: (comp) => comp.handleOrcidLink(),
    busyFlag: 'orcidLinking',
    mode: 'link',
  },
  {
    name: 'accreditation ORCID verify',
    mount: () => mountPage(initAccreditationPage),
    start: (comp) => comp.handleOrcidVerify(),
    busyFlag: 'orcidLoading',
    mode: 'accredit',
  },
];

// Every way the tab's subject is torn down, each through the store's own
// entry point for it.
const SUBJECT_CHANGES = [
  {
    name: 'a login as a different user in this tab',
    apply: (auth) => auth.loginFromResponse(session('bob')),
  },
  {
    name: 'a cross-tab login as a different user (storage event)',
    apply: (auth) => {
      const saved = JSON.stringify({
        token: 'bob-jwt', username: 'bob', expiresAt: FUTURE, custody: 'light',
      });
      localStorage.setItem(SESSION_KEY, saved);
      auth._handleStorageEvent({ key: SESSION_KEY, newValue: saved });
    },
  },
  {
    name: 'a cross-tab sign-out (storage event)',
    apply: (auth) => {
      localStorage.removeItem(SESSION_KEY);
      auth._handleStorageEvent({ key: SESSION_KEY, newValue: null });
    },
  },
  {
    name: 'a sign-out in this tab',
    apply: (auth) => auth.disconnect(),
  },
];

// The flow keys a later flow in this tab writes after the teardown. A stale
// unwind that removes either one strands that flow at its callback.
function writeSuccessorFlowKeys() {
  sessionStorage.setItem(ORCID_MODE_KEY, 'fresh_auth');
  sessionStorage.setItem(RETURN_PATH_KEY, '/papers/bob/successor');
}

function expectSuccessorFlowKeysIntact() {
  expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBe('fresh_auth');
  expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBe('/papers/bob/successor');
}

// Park the start round-trip and hand back its settle functions.
function parkStart() {
  let resolve;
  let reject;
  mockStartOrcid.mockReturnValue(new Promise((res, rej) => { resolve = res; reject = rej; }));
  return { resolve: () => resolve({ redirect_url: ORCID_URL }), reject };
}

let auth;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  stores.toast = { show: vi.fn() };
  stores.router = {
    navigate: vi.fn(),
    registerNavigationGuard: vi.fn(),
    unregisterNavigationGuard: vi.fn(),
  };
  stores.reauthModal = { cancel: vi.fn() };
  stores.i18n = { messages: {} };
  stores.notifications = { stop: vi.fn() };
  initAuth();
  auth = stores.auth;
  auth.loginFromResponse(session('alice'));
  // Observable, non-navigating location. The store's own `init()` is not
  // called (it binds the storage listener on the real window), so the storage
  // cases invoke the handler that listener would.
  vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/settings' } });
});

afterEach(() => {
  auth._stopAccreditationPolling();
  vi.unstubAllGlobals();
});

describe.each(FLOWS)('$name: subject pin across the start round-trip', (flow) => {
  it.each(SUBJECT_CHANGES)(
    'does not navigate after $name lands inside the start await',
    async (change) => {
      const comp = flow.mount();
      const parked = parkStart();

      const started = flow.start(comp);
      expect(comp[flow.busyFlag]).toBe(true);
      expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBe(flow.mode);

      change.apply(auth);
      // The teardown's scrub took this flow's marker with it.
      expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBeNull();
      writeSuccessorFlowKeys();

      parked.resolve();
      await started;

      expect(window.location.href).toBe('');
      expect(comp[flow.busyFlag]).toBe(false);
      expectSuccessorFlowKeysIntact();
      // A silent cancel: the click belonged to a subject that has left.
      expect(stores.toast.show).not.toHaveBeenCalled();
    },
  );

  it('leaves a later flow its keys when a stale start rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const comp = flow.mount();
    const parked = parkStart();

    const started = flow.start(comp);
    auth.loginFromResponse(session('bob'));
    writeSuccessorFlowKeys();

    parked.reject(new Error('start failed'));
    await started;

    expect(window.location.href).toBe('');
    expect(comp[flow.busyFlag]).toBe(false);
    expectSuccessorFlowKeysIntact();
    warnSpy.mockRestore();
  });

  it('still removes its own marker when a live start rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const comp = flow.mount();
    const parked = parkStart();

    const started = flow.start(comp);
    parked.reject(new Error('start failed'));
    await started;

    expect(comp[flow.busyFlag]).toBe(false);
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBeNull();
    warnSpy.mockRestore();
  });

  it('navigates when the subject is unchanged', async () => {
    const comp = flow.mount();
    const parked = parkStart();

    const started = flow.start(comp);
    parked.resolve();
    await started;

    expect(window.location.href).toBe(ORCID_URL);
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBe(flow.mode);
  });

  // A same-subject re-login is not a teardown: the store keeps the tab's
  // subject-bound state, this flow's marker included, so the round-trip is
  // still the clicking user's and still completes on return.
  it('navigates when the same subject logs in again inside the start await', async () => {
    const comp = flow.mount();
    const parked = parkStart();

    const started = flow.start(comp);
    auth.loginFromResponse(session('alice'));
    parked.resolve();
    await started;

    expect(window.location.href).toBe(ORCID_URL);
    expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBe(flow.mode);
  });
});
