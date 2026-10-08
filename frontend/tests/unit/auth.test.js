import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let store;
const mockWaitForKeychain = vi.fn().mockResolvedValue(false);
const mockFetchAccreditationStatus = vi.fn().mockResolvedValue({ data: null });

// The reauth modal as the subject scrub sees it. Kept separate from the
// capture-def branch below because the scrub dismisses this store by name: a
// name-blind mock would hand `auth` back for every lookup and the dismissal
// would silently address the wrong object.
const reauthCancel = vi.fn();

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name, def) => {
      if (name === 'reauthModal') return { cancel: (...args) => reauthCancel(...args) };
      if (def) store = def;
      return store;
    }),
  },
}));

vi.mock('../../src/keychain.js', () => ({
  waitForKeychain: (...args) => mockWaitForKeychain(...args),
}));

vi.mock('../../src/api.js', () => ({
  fetchAccreditationStatus: (...args) => mockFetchAccreditationStatus(...args),
}));

vi.mock('../../src/sign-request.js', () => ({
  signRequest: vi.fn(),
}));

// Partial mock: the real cache-clearing runs (the scrub assertions below depend
// on it), with spies over the password-factor memo drop and the in-flight
// acquisition teardown so both can be asserted without reaching into
// module-private state. The window clear stays real behind a pass-through
// spy: the sibling cases seed and inspect the real cache (its in-memory
// mirror included) through the scrub, and the ordering pin below only needs
// to see the call.
const mockClearPasswordFactorMemo = vi.fn();
const mockAbandonInFlightAcquisitions = vi.fn();
const mockClearCachedSessionProofSpy = vi.fn();
vi.mock('../../src/lib/fresh-auth.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    clearCachedSessionProof: (...args) => {
      mockClearCachedSessionProofSpy(...args);
      return actual.clearCachedSessionProof(...args);
    },
    clearPasswordFactorMemo: (...args) => mockClearPasswordFactorMemo(...args),
    abandonInFlightAcquisitions: (...args) => mockAbandonInFlightAcquisitions(...args),
  };
});

import { initAuth } from '../../src/auth.js';
// Real implementations from the partially-mocked module: used to seed and
// observe the fresh-auth window cache (including its in-memory mirror) around
// the subject-change scrub.
import {
  cacheSessionProof,
  slideSessionWindow,
  clearCachedSessionProof,
} from '../../src/lib/fresh-auth.js';
// The fixture mirror of loginFromResponse used by the suites that mock the
// auth store, pinned against the real store by the parity test below, which
// also seeds every key in the shared subject-bound list.
import { mockLoginFromResponse } from './fixtures/mock-auth.js';
import { SUBJECT_BOUND_STORAGE_KEYS, NAVIGATION_STASH_KEY } from '../../src/lib/subject-bound-keys.js';

describe('auth store', () => {
  let localStorageData;

  beforeEach(() => {
    vi.useFakeTimers();
    store = null;
    localStorageData = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => localStorageData[key] ?? null),
      setItem: vi.fn((key, val) => { localStorageData[key] = val; }),
      removeItem: vi.fn((key) => { delete localStorageData[key]; }),
    });
    vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => {});
    mockWaitForKeychain.mockReset().mockResolvedValue(false);
    mockFetchAccreditationStatus.mockReset().mockResolvedValue({ data: null });
    initAuth();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('_restoreSession', () => {
    it('restores valid session from localStorage', () => {
      const future = new Date(Date.now() + 3600000).toISOString();
      localStorageData['pevo_session'] = JSON.stringify({
        token: 'tok123', username: 'alice', expiresAt: future,
        isAccredited: true, accreditation: { type: 'orcid' }, custody: 'light',
      });
      store._restoreSession();
      expect(store.isConnected).toBe(true);
      expect(store.username).toBe('alice');
      expect(store.token).toBe('tok123');
      expect(store.isAccredited).toBe(true);
      expect(store.custody).toBe('light');
    });

    it('clears expired session', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      localStorageData['pevo_session'] = JSON.stringify({
        token: 'tok', username: 'bob', expiresAt: past,
      });
      store._restoreSession();
      expect(store.isConnected).toBe(false);
      expect(store.token).toBeNull();
      expect(localStorage.removeItem).toHaveBeenCalledWith('pevo_session');
    });

    it('defaults isAccredited and custody when fields missing', () => {
      const future = new Date(Date.now() + 3600000).toISOString();
      localStorageData['pevo_session'] = JSON.stringify({
        token: 'tok', username: 'carol', expiresAt: future,
      });
      store._restoreSession();
      expect(store.isAccredited).toBe(false);
      expect(store.custody).toBe('self');
    });

    it('refuses to restore when token is missing', () => {
      // Guards against the `token &&` being dropped from the restore condition.
      const future = new Date(Date.now() + 3600000).toISOString();
      localStorageData['pevo_session'] = JSON.stringify({
        username: 'alice', expiresAt: future,
      });
      store._restoreSession();
      expect(store.isConnected).toBe(false);
      expect(store.token).toBeNull();
    });

    it('refuses to restore when username is missing', () => {
      // Guards against the `username &&` being dropped from the restore condition.
      const future = new Date(Date.now() + 3600000).toISOString();
      localStorageData['pevo_session'] = JSON.stringify({
        token: 'tok', expiresAt: future,
      });
      store._restoreSession();
      expect(store.isConnected).toBe(false);
      expect(store.username).toBeNull();
    });
  });

  describe('_handleStorageEvent', () => {
    it('restores session when pevo_session key changes with new value', () => {
      const future = new Date(Date.now() + 3600000).toISOString();
      localStorageData['pevo_session'] = JSON.stringify({
        token: 'new', username: 'eve', expiresAt: future,
      });
      store._handleStorageEvent({ key: 'pevo_session', newValue: 'something' });
      expect(store.isConnected).toBe(true);
      expect(store.username).toBe('eve');
    });

    it('disconnects when pevo_session is removed', () => {
      store.username = 'frank';
      store.isConnected = true;
      store.token = 'x';
      store._handleStorageEvent({ key: 'pevo_session', newValue: null });
      expect(store.isConnected).toBe(false);
      expect(store.username).toBeNull();
    });

    it('ignores events for other keys', () => {
      store.username = 'gina';
      store.isConnected = true;
      store._handleStorageEvent({ key: 'other_key', newValue: null });
      expect(store.isConnected).toBe(true);
    });
  });

  describe('loginFromResponse', () => {
    it('sets all fields from response data', () => {
      store.loginFromResponse({
        token: 't1', username: 'iris', expires_at: '2099-01-01',
        is_accredited: true, accreditation: { type: 'email' }, custody: 'light',
      });
      expect(store.isConnected).toBe(true);
      expect(store.username).toBe('iris');
      expect(store.token).toBe('t1');
      expect(store.isAccredited).toBe(true);
      expect(store.custody).toBe('light');
    });

    it('preserves existing fields when omitted from data', () => {
      // Helper now preserves-on-undefined for username/is_accredited/
      // accreditation/custody so the upgrade flow can pass only the
      // {token, expires_at, custody} subset without clobbering the
      // user's identity or accreditation state. Login-style callers
      // always emit all six fields, so they're unaffected.
      store.isAccredited = true;
      store.accreditation = { type: 'orcid' };
      store.custody = 'self';
      store.username = 'preexisting';
      store.loginFromResponse({ token: 't2', expires_at: '2099-01-01' });
      expect(store.isAccredited).toBe(true);
      expect(store.accreditation).toEqual({ type: 'orcid' });
      expect(store.custody).toBe('self');
      expect(store.username).toBe('preexisting');
      // The atomic {token, expires_at} pair did rotate (both supplied).
      expect(store.token).toBe('t2');
      expect(store.expiresAt).toBe('2099-01-01');
    });

    it('atomic {token, expires_at} pair: preserves both when expires_at omitted', () => {
      // The pre-sweep upgrade flow had two independent guards that
      // allowed `{token: new, expires_at: undefined}` to persist a
      // fresh token with stale expiry — the user's first API call
      // would 401 because the backend invalidated the rotated token
      // immediately and the UI was unaware. Atomic-pair enforcement:
      // if either side is falsy, neither rotates.
      store.token = 'old';
      store.expiresAt = '2099-01-01';
      store.loginFromResponse({ token: 'new-but-stale-expiry-omitted' });
      expect(store.token).toBe('old');
      expect(store.expiresAt).toBe('2099-01-01');
    });

    it('atomic {token, expires_at} pair: preserves both when token omitted', () => {
      store.token = 'old';
      store.expiresAt = '2099-01-01';
      store.loginFromResponse({ expires_at: '2100-01-01' });
      expect(store.token).toBe('old');
      expect(store.expiresAt).toBe('2099-01-01');
    });

    it('atomic {token, expires_at} pair: preserves both when expires_at is explicit null', () => {
      // The decoupled-guard form would treat `'expires_at' in data` as
      // truthy-key-present and assign null to expiresAt, silently
      // logging users out. The truthy-check (data.expires_at &&) treats
      // null as falsy and skips both assignments.
      store.token = 'old';
      store.expiresAt = '2099-01-01';
      store.loginFromResponse({ token: 'new', expires_at: null });
      expect(store.token).toBe('old');
      expect(store.expiresAt).toBe('2099-01-01');
    });

    it('persists the session to localStorage', () => {
      // Guards against `_saveSession` being dropped from loginFromResponse.
      localStorage.setItem.mockClear();
      store.loginFromResponse({ token: 't3', username: 'kim', expires_at: '2099-01-01' });
      const call = localStorage.setItem.mock.calls.find((c) => c[0] === 'pevo_session');
      expect(call).toBeDefined();
      const saved = JSON.parse(call[1]);
      expect(saved.token).toBe('t3');
      expect(saved.username).toBe('kim');
    });

    it('starts accreditation polling', () => {
      // Guards against `_startAccreditationPolling` being dropped. The poll
      // loop calls fetchAccreditationStatus with the current username.
      store.loginFromResponse({ token: 't4', username: 'leo', expires_at: '2099-01-01' });
      expect(mockFetchAccreditationStatus).toHaveBeenCalledWith('leo');
    });
  });

  describe('applyAccreditationMetadata', () => {
    it('merges name/institution/field and preserves tenure, method, and orcid', () => {
      store.accreditation = {
        orcid: '0000-0001', method: 'orcid',
        accredited_since: 'SINCE', timestamp: 'LATEST',
        name: 'Old', institution: 'Old U', field: 'Old Field',
      };
      const ok = store.applyAccreditationMetadata({
        name: 'Ada Lovelace', institution: 'AE Co', field: 'Mathematics',
      });
      expect(ok).toBe(true);
      expect(store.accreditation).toEqual({
        orcid: '0000-0001', method: 'orcid',
        accredited_since: 'SINCE', timestamp: 'LATEST',
        name: 'Ada Lovelace', institution: 'AE Co', field: 'Mathematics',
      });
    });

    it('bumps the polling generation so an in-flight stale poll drops itself', () => {
      store.accreditation = { name: 'Old', institution: 'Old U', field: 'Old Field' };
      const before = store._pollingGeneration;
      store.applyAccreditationMetadata({ name: 'Ada', institution: 'AE Co', field: 'Math' });
      expect(store._pollingGeneration).toBe(before + 1);
    });

    it('persists the merged metadata to localStorage', () => {
      store.accreditation = { name: 'Old', institution: 'Old U', field: 'Old Field' };
      localStorage.setItem.mockClear();
      store.applyAccreditationMetadata({ name: 'Ada', institution: 'AE Co', field: 'Math' });
      const call = localStorage.setItem.mock.calls.find((c) => c[0] === 'pevo_session');
      expect(call).toBeDefined();
      expect(JSON.parse(call[1]).accreditation).toMatchObject({
        name: 'Ada', institution: 'AE Co', field: 'Math',
      });
    });

    it('returns false and changes nothing when there is no current accreditation', () => {
      store.accreditation = null;
      const before = store._pollingGeneration;
      localStorage.setItem.mockClear();
      const ok = store.applyAccreditationMetadata({ name: 'Ada', institution: 'AE Co', field: 'Math' });
      expect(ok).toBe(false);
      expect(store.accreditation).toBeNull();
      expect(store._pollingGeneration).toBe(before);
      expect(localStorage.setItem).not.toHaveBeenCalledWith('pevo_session', expect.anything());
    });
  });

  describe('init', () => {
    it('checks keychain availability', async () => {
      mockWaitForKeychain.mockResolvedValue(true);
      store.init();
      await vi.runAllTimersAsync();
      expect(store.isKeychainInstalled).toBe(true);
    });
  });

  describe('_checkAccreditation race with disconnect', () => {
    it('does not write accreditation state if disconnect runs mid-fetch', async () => {
      // Set up a connected session so _checkAccreditation proceeds past its
      // pre-fetch guard.
      store.username = 'mia';
      store.isConnected = true;
      store.isAccredited = false;

      // Hold the fetch promise open via a manual resolver.
      let resolveFetch;
      const pending = new Promise((resolve) => { resolveFetch = resolve; });
      mockFetchAccreditationStatus.mockReset().mockReturnValue(pending);
      localStorage.setItem.mockClear();

      // Kick off the check, then disconnect before the fetch settles.
      // Pass the current generation so the stale-fetch gen guard admits
      // this call; the disconnect race is then guarded by the post-await
      // `!this.username || !this.isConnected` check, which is what this
      // test exercises.
      const checkPromise = store._checkAccreditation(store._pollingGeneration);
      store.disconnect();

      // Resolve the in-flight fetch with a positive accreditation. The post-
      // await re-check should drop the result on the floor.
      resolveFetch({ data: { is_accredited: true, accreditation: { type: 'orcid' } } });
      await checkPromise;

      expect(store.isAccredited).toBe(false);
      expect(localStorage.getItem('pevo_session')).toBeNull();
    });
  });

  describe('disconnect scrubs sessionStorage ORCID flow keys', () => {
    // Disconnect must clear BOTH pevo_orcid_mode and pevo_orcid_return_to so a
    // concurrent-tab logout StorageEvent in the middle of a /recover ORCID
    // flow cannot leak a stale return-path pointer ('recover') into a later
    // orcid-callback resolution on the same tab, which would route the user
    // to /recover instead of /signup.
    let sessionStorageData;

    beforeEach(() => {
      sessionStorageData = {};
      vi.stubGlobal('sessionStorage', {
        getItem: vi.fn((key) => sessionStorageData[key] ?? null),
        setItem: vi.fn((key, val) => { sessionStorageData[key] = val; }),
        removeItem: vi.fn((key) => { delete sessionStorageData[key]; }),
      });
    });

    it('removes pevo_orcid_mode on disconnect', () => {
      sessionStorageData['pevo_orcid_mode'] = 'session_auth';
      store.disconnect();
      expect(sessionStorageData['pevo_orcid_mode']).toBeUndefined();
      expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
    });

    it('removes pevo_orcid_return_to on disconnect', () => {
      sessionStorageData['pevo_orcid_return_to'] = 'recover';
      store.disconnect();
      expect(sessionStorageData['pevo_orcid_return_to']).toBeUndefined();
      expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_return_to');
    });

    it('removes the navigation stash on disconnect', () => {
      // Seeded by name rather than through the shared key list, so this fails
      // when the stash key is dropped from SUBJECT_BOUND_STORAGE_KEYS: the
      // parity pin loops that list and cannot see a missing member. A review
      // body, possibly marked anonymous, must not outlive the session.
      sessionStorageData[NAVIGATION_STASH_KEY] = JSON.stringify({
        surface: 'review',
        target: { author: 'alice', permlink: 'paper-1' },
        subject: 'bob',
        payload: { reviewBody: 'draft', isAnonymous: true },
        savedAt: Date.now(),
      });
      store.disconnect();
      expect(sessionStorageData[NAVIGATION_STASH_KEY]).toBeUndefined();
      expect(sessionStorage.removeItem).toHaveBeenCalledWith(NAVIGATION_STASH_KEY);
    });

    it('drops the password-factor memo on disconnect', () => {
      // The memo is username-keyed, so a re-login as someone else cannot
      // inherit it; this drop also retires a stale positive for the SAME
      // account after the one transition that removes a password.
      mockClearPasswordFactorMemo.mockClear();
      store.disconnect();
      expect(mockClearPasswordFactorMemo).toHaveBeenCalledTimes(1);
    });

    it('dismisses an open re-auth prompt on disconnect', () => {
      // Nothing else closes it. Left open it stays answerable after the
      // logout, still holding the typed password, with its caller parked on
      // the prompt promise — that await has no timeout, so the action never
      // unwinds until a human touches the modal.
      reauthCancel.mockClear();
      store.disconnect();
      expect(reauthCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('subject change runs the cross-user scrub', () => {
    // A login that changes the JWT subject must run the same subject-bound
    // scrub as an explicit logout: the previous subject's fresh-auth proofs,
    // ORCID flow keys, password-factor memo and in-flight acquisitions must
    // not be inheritable by the next subject on a shared browser. A
    // same-subject re-login is NOT a subject change and keeps the live
    // re-auth window (a re-auth the user does not owe).
    let sessionStorageData;
    let throwingSetItemKey;

    const FUTURE_EXPIRY = '2099-01-01';

    function loginAs(username, token = `jwt-${username}`) {
      store.loginFromResponse({
        token,
        expires_at: FUTURE_EXPIRY,
        username,
        custody: 'light',
        is_accredited: false,
        accreditation: null,
      });
    }

    function seedSubjectBoundKeys() {
      sessionStorageData['pevo_fresh_auth_session_proof'] = JSON.stringify({
        token: 'window-token',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        idlePeriodMs: 900_000,
      });
      sessionStorageData['pevo_fresh_auth_consent_op_proof'] = JSON.stringify({ token: 'consent' });
      sessionStorageData['pevo_fresh_auth_return_to'] = '/publish';
      sessionStorageData['pevo_orcid_mode'] = 'session_auth';
      sessionStorageData['pevo_orcid_return_to'] = 'recover';
    }

    beforeEach(() => {
      sessionStorageData = {};
      throwingSetItemKey = null;
      vi.stubGlobal('sessionStorage', {
        getItem: vi.fn((key) => sessionStorageData[key] ?? null),
        setItem: vi.fn((key, val) => {
          if (key === throwingSetItemKey) throw new Error('quota exceeded');
          sessionStorageData[key] = val;
        }),
        removeItem: vi.fn((key) => { delete sessionStorageData[key]; }),
      });
      // The window cache keeps an in-memory mirror in fresh-auth module
      // state; drop it so one test's window cannot leak into the next.
      clearCachedSessionProof();
    });

    it('signing in as a different username scrubs every subject-bound cache', () => {
      loginAs('alice');
      seedSubjectBoundKeys();
      mockClearPasswordFactorMemo.mockClear();
      mockAbandonInFlightAcquisitions.mockClear();

      loginAs('bob');

      expect(sessionStorageData['pevo_fresh_auth_session_proof']).toBeUndefined();
      expect(sessionStorageData['pevo_fresh_auth_consent_op_proof']).toBeUndefined();
      expect(sessionStorageData['pevo_fresh_auth_return_to']).toBeUndefined();
      expect(sessionStorageData['pevo_orcid_mode']).toBeUndefined();
      expect(sessionStorageData['pevo_orcid_return_to']).toBeUndefined();
      expect(mockClearPasswordFactorMemo).toHaveBeenCalled();
      expect(mockAbandonInFlightAcquisitions).toHaveBeenCalled();
      // The tab now marks bob as the subject its state belongs to.
      expect(sessionStorageData['pevo_tab_subject']).toBe('bob');
      expect(store.username).toBe('bob');
    });

    it('same-subject re-login preserves the live window and caches', () => {
      loginAs('alice');
      seedSubjectBoundKeys();
      mockClearPasswordFactorMemo.mockClear();
      mockAbandonInFlightAcquisitions.mockClear();

      loginAs('alice', 'jwt-alice-2');

      expect(sessionStorageData['pevo_fresh_auth_session_proof']).toBeDefined();
      expect(sessionStorageData['pevo_fresh_auth_consent_op_proof']).toBeDefined();
      expect(sessionStorageData['pevo_orcid_mode']).toBe('session_auth');
      expect(mockClearPasswordFactorMemo).not.toHaveBeenCalled();
      expect(mockAbandonInFlightAcquisitions).not.toHaveBeenCalled();
      expect(store.token).toBe('jwt-alice-2');
    });

    it('a response omitting username falls back to the current subject and preserves the window', () => {
      // Defensive fallback with no live caller: every call site passes
      // `username` explicitly (the custody-upgrade sites pin a subject
      // captured before their first await). An omitted username still
      // resolves to whoever is signed in, so nothing is scrubbed.
      loginAs('alice');
      seedSubjectBoundKeys();
      mockAbandonInFlightAcquisitions.mockClear();

      store.loginFromResponse({ token: 'jwt-upgraded', expires_at: FUTURE_EXPIRY, custody: 'self' });

      expect(sessionStorageData['pevo_fresh_auth_session_proof']).toBeDefined();
      expect(mockAbandonInFlightAcquisitions).not.toHaveBeenCalled();
      expect(store.username).toBe('alice');
      expect(store.custody).toBe('self');
    });

    it('a cross-tab storage-event login as a different user scrubs this tab', () => {
      loginAs('alice');
      seedSubjectBoundKeys();

      const future = new Date(Date.now() + 3600000).toISOString();
      localStorageData['pevo_session'] = JSON.stringify({
        token: 'jwt-bob', username: 'bob', expiresAt: future,
      });
      store._handleStorageEvent({ key: 'pevo_session', newValue: 'changed' });

      expect(store.username).toBe('bob');
      expect(sessionStorageData['pevo_fresh_auth_session_proof']).toBeUndefined();
      expect(sessionStorageData['pevo_fresh_auth_consent_op_proof']).toBeUndefined();
      expect(sessionStorageData['pevo_orcid_mode']).toBeUndefined();
      expect(sessionStorageData['pevo_tab_subject']).toBe('bob');
    });

    it('a cold-load restore under another subject\'s leftover state scrubs it', () => {
      // Reload after a different-user login in another tab: module state is
      // fresh (username null) but this tab's sessionStorage still holds the
      // previous subject's proofs. The per-tab subject marker is what makes
      // the divergence detectable without any in-memory history.
      sessionStorageData['pevo_tab_subject'] = 'alice';
      seedSubjectBoundKeys();
      const future = new Date(Date.now() + 3600000).toISOString();
      localStorageData['pevo_session'] = JSON.stringify({
        token: 'jwt-bob', username: 'bob', expiresAt: future,
      });

      store._restoreSession();

      expect(store.username).toBe('bob');
      expect(sessionStorageData['pevo_fresh_auth_session_proof']).toBeUndefined();
      expect(sessionStorageData['pevo_tab_subject']).toBe('bob');
    });

    it('a same-subject restore keeps the window (ordinary reload, ORCID round-trip return)', () => {
      sessionStorageData['pevo_tab_subject'] = 'alice';
      seedSubjectBoundKeys();
      const future = new Date(Date.now() + 3600000).toISOString();
      localStorageData['pevo_session'] = JSON.stringify({
        token: 'jwt-alice', username: 'alice', expiresAt: future,
      });

      store._restoreSession();

      expect(store.username).toBe('alice');
      expect(sessionStorageData['pevo_fresh_auth_session_proof']).toBeDefined();
      expect(sessionStorageData['pevo_tab_subject']).toBe('alice');
    });

    it('signing in as a different username dismisses an open re-auth prompt', () => {
      // The prompt belongs to the previous subject but the mint behind it
      // reads the JWT at call time, so an answered prompt would authenticate
      // as the NEW subject. Dismissing it is what makes the mint unreachable
      // and lets the parked orchestrator unwind as a cancel.
      loginAs('alice');
      reauthCancel.mockClear();

      loginAs('bob');

      expect(reauthCancel).toHaveBeenCalledTimes(1);
    });

    it('same-subject re-login leaves an open re-auth prompt alone', () => {
      // The pair-partner of the different-username prompt-dismissal test: no
      // subject change means no scrub, and dismissing a prompt the same
      // account opened would cost a re-auth the user does not owe.
      loginAs('alice');
      reauthCancel.mockClear();

      loginAs('alice', 'jwt-alice-2');

      expect(reauthCancel).not.toHaveBeenCalled();
    });

    it('disconnect removes the tab-subject marker and abandons in-flight acquisitions', () => {
      sessionStorageData['pevo_tab_subject'] = 'alice';
      mockAbandonInFlightAcquisitions.mockClear();

      store.disconnect();

      expect(sessionStorageData['pevo_tab_subject']).toBeUndefined();
      expect(mockAbandonInFlightAcquisitions).toHaveBeenCalledTimes(1);
    });

    it('the scrub clears the window before it abandons in-flight acquisitions', () => {
      // The fresh-auth consume and retry legs (the broadcast and upload
      // surfaces) decline to evict or slide the cached window once their guard
      // reads torn-down, on the strength of this scrub having already dropped
      // the flight's own window BEFORE it bumped the generation: past the bump,
      // whatever sits in the slot belongs to the successor. That reasoning
      // holds only if the clear runs first, and in the same synchronous body.
      // Reordered, a torn-down flight would retain a dead window instead of
      // protecting a live one, and no end-state assertion in this file would
      // notice: this case is the only one that sees the relative order. (A
      // yield between the two is already caught by the sibling cases that
      // count the abandonment synchronously after the login returns; the
      // counts below hold that line too.)
      loginAs('alice');
      mockClearCachedSessionProofSpy.mockClear();
      mockAbandonInFlightAcquisitions.mockClear();

      loginAs('bob');

      // Both ran inside the scrub, before the login returned...
      expect(mockClearCachedSessionProofSpy).toHaveBeenCalledTimes(1);
      expect(mockAbandonInFlightAcquisitions).toHaveBeenCalledTimes(1);
      // ...and the clear came first.
      expect(mockClearCachedSessionProofSpy.mock.invocationCallOrder[0]).toBeLessThan(
        mockAbandonInFlightAcquisitions.mock.invocationCallOrder[0],
      );
    });

    it('a cross-user login clears the in-memory window mirror, not only the stored copy', () => {
      loginAs('alice');
      // A failed storage write parks the window in the fresh-auth module's
      // in-memory mirror instead of sessionStorage (private mode, quota).
      throwingSetItemKey = 'pevo_fresh_auth_session_proof';
      cacheSessionProof(
        'mirror-only',
        new Date(Date.now() + 900_000).toISOString(),
        new Date(Date.now() + 7_200_000).toISOString(),
      );
      throwingSetItemKey = null;

      loginAs('bob');

      // A surviving mirror would re-persist itself on the next idle slide;
      // an empty storage slot afterwards proves the mirror was dropped with
      // the rest of the subject-bound state.
      slideSessionWindow();
      expect(sessionStorageData['pevo_fresh_auth_session_proof']).toBeUndefined();
    });

    it('the fixture mirror and the real store leave identical sessionStorage behind a login', () => {
      // fixtures/mock-auth.js#mockLoginFromResponse reimplements the
      // subject-adoption scrub for suites that mock the auth store. Both now
      // loop the shared key list (subject-bound-keys.js), but the mirror
      // cannot execute the real scrub's clear functions, so this parity pin
      // is what binds the two implementations end to end: the same login
      // sequence, run from identically seeded state through the real store
      // and through the mirror, must leave the same sessionStorage — for a
      // cross-user login (both scrub), a same-subject re-login (both
      // preserve), and keys not bound to the subject (both leave alone). A
      // subject-bound cache scrubbed by one implementation and kept by the
      // other fails here instead of silently un-proving the mirror-backed
      // suites.
      const loginData = (username) => ({
        token: `jwt-${username}`,
        expires_at: FUTURE_EXPIRY,
        username,
        custody: 'light',
        is_accredited: false,
        accreditation: null,
      });
      // Seed the named keys the sibling tests use, then generically seed
      // every remaining key in the shared list — so a key added to the list
      // later is exercised by this pin automatically instead of passing
      // vacuously for never having been seeded.
      const seedEverySubjectBoundKey = () => {
        seedSubjectBoundKeys();
        for (const key of SUBJECT_BOUND_STORAGE_KEYS) {
          sessionStorageData[key] ??= `seeded-${key}`;
        }
      };
      const runThrough = (login) => {
        sessionStorageData = {};
        login(loginData('alice'));
        seedEverySubjectBoundKey();
        sessionStorageData['pevo_unrelated_key'] = 'survives';
        login(loginData('bob'));
        const afterCrossUser = { ...sessionStorageData };
        seedEverySubjectBoundKey();
        login(loginData('bob'));
        return { afterCrossUser, afterSameSubject: { ...sessionStorageData } };
      };

      const real = runThrough((data) => store.loginFromResponse(data));
      const mirrorStore = {
        username: null,
        _saveSession: vi.fn(),
        _startAccreditationPolling: vi.fn(),
      };
      const mirrored = runThrough((data) => mockLoginFromResponse.call(mirrorStore, data));

      expect(mirrored.afterCrossUser).toEqual(real.afterCrossUser);
      expect(mirrored.afterSameSubject).toEqual(real.afterSameSubject);
      // The scrub is a scrub, not a wipe: state not bound to the subject
      // survives the cross-user login in both implementations.
      expect(real.afterCrossUser.pevo_unrelated_key).toBe('survives');
    });
  });

  describe('token expiry', () => {
    it('expired token means session is not restored', () => {
      const past = new Date(Date.now() - 1).toISOString();
      localStorageData['pevo_session'] = JSON.stringify({
        token: 'expired', username: 'zoe', expiresAt: past,
      });
      store._restoreSession();
      expect(store.isConnected).toBe(false);
    });
  });

  describe('_checkAccreditation', () => {
    it('does not fetch when username is null', async () => {
      store.username = null;
      store.isConnected = false;
      await expect(store._checkAccreditation()).resolves.toBeUndefined();
      expect(mockFetchAccreditationStatus).not.toHaveBeenCalled();
    });

    it('does not fetch when not connected even if username is set', async () => {
      store.username = 'alice';
      store.isConnected = false;
      await expect(store._checkAccreditation()).resolves.toBeUndefined();
      expect(mockFetchAccreditationStatus).not.toHaveBeenCalled();
    });

    it('swallows network errors and does not mutate accreditation state', async () => {
      store.username = 'alice';
      store.isConnected = true;
      store.isAccredited = true;
      store.accreditation = { type: 'orcid' };
      mockFetchAccreditationStatus.mockRejectedValueOnce(new Error('network down'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(store._checkAccreditation()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      expect(store.isAccredited).toBe(true);
      expect(store.accreditation).toEqual({ type: 'orcid' });
      warnSpy.mockRestore();
    });

    it('leaves state untouched when response data is null (unaccredited)', async () => {
      store.username = 'alice';
      store.isConnected = true;
      store.isAccredited = true;
      store.accreditation = { type: 'orcid' };
      mockFetchAccreditationStatus.mockResolvedValueOnce({ data: null });
      await store._checkAccreditation(store._pollingGeneration);
      expect(store.isAccredited).toBe(true);
      expect(store.accreditation).toEqual({ type: 'orcid' });
    });

    it('updates state and persists the session on successful fetch', async () => {
      store.username = 'alice';
      store.isConnected = true;
      localStorage.setItem.mockClear();
      mockFetchAccreditationStatus.mockResolvedValueOnce({
        data: { is_accredited: true, accreditation: { type: 'orcid' } },
      });
      await store._checkAccreditation(store._pollingGeneration);
      expect(store.isAccredited).toBe(true);
      expect(store.accreditation).toEqual({ type: 'orcid' });
      const sessionCall = localStorage.setItem.mock.calls.find((c) => c[0] === 'pevo_session');
      expect(sessionCall).toBeDefined();
    });
  });
});
