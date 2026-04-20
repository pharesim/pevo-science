import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let store;
const mockWaitForKeychain = vi.fn().mockResolvedValue(false);
const mockFetchAccreditationStatus = vi.fn().mockResolvedValue({ data: null });

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name, def) => {
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

import { initAuth } from '../../src/auth.js';

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

    it('defaults optional fields', () => {
      store.loginFromResponse({ token: 't2', username: 'jack', expires_at: '2099-01-01' });
      expect(store.isAccredited).toBe(false);
      expect(store.accreditation).toBeNull();
      expect(store.custody).toBe('self');
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
      mockFetchAccreditationStatus.mockClear();
      store.loginFromResponse({ token: 't4', username: 'leo', expires_at: '2099-01-01' });
      expect(mockFetchAccreditationStatus).toHaveBeenCalledWith('leo');
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
});
