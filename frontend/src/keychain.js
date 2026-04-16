import { getAppTag, getAppId } from './config.js';

export function isKeychainInstalled() {
  return typeof window !== 'undefined' && typeof window.hive_keychain !== 'undefined';
}

export function waitForKeychain(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (isKeychainInstalled()) return resolve(true);
    const start = Date.now();
    const interval = setInterval(() => {
      if (isKeychainInstalled()) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });
}

export function signMessage(username, message) {
  return new Promise((resolve, reject) => {
    if (!window.hive_keychain) {
      return reject(new Error('Hive Keychain is not installed'));
    }
    window.hive_keychain.requestSignBuffer(
      username,
      message,
      'posting',
      (response) => {
        if (response.success) {
          resolve({ signature: response.result });
        } else {
          reject(new Error(response.message));
        }
      }
    );
  });
}
