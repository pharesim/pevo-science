import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevo',
  getAppId: () => 'pevo/0.1',
}));

import { waitForKeychain, signMessage } from '../../src/keychain.js';

describe('keychain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete window.hive_keychain;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('waitForKeychain', () => {
    it('resolves true immediately if keychain is already present', async () => {
      window.hive_keychain = {};
      const result = await waitForKeychain();
      expect(result).toBe(true);
    });

    it('resolves true when keychain appears before timeout', async () => {
      const promise = waitForKeychain(3000);
      // Simulate keychain appearing after 200ms
      setTimeout(() => { window.hive_keychain = {}; }, 200);
      await vi.advanceTimersByTimeAsync(200);
      // Need one more interval tick to detect it
      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;
      expect(result).toBe(true);
    });

    it('resolves false when keychain does not appear before timeout', async () => {
      const promise = waitForKeychain(500);
      await vi.advanceTimersByTimeAsync(600);
      const result = await promise;
      expect(result).toBe(false);
    });
  });

  describe('signMessage', () => {
    it('rejects if hive_keychain is not installed', async () => {
      await expect(signMessage('alice', 'hello')).rejects.toThrow('Hive Keychain is not installed');
    });

    it('rejects with error message on failure', async () => {
      window.hive_keychain = {
        requestSignBuffer: vi.fn((user, msg, key, cb) => {
          cb({ success: false, message: 'User cancelled' });
        }),
      };

      await expect(signMessage('alice', 'hello')).rejects.toThrow('User cancelled');
    });
  });
});
