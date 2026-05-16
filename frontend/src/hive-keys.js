/**
 * Client-side Hive key derivation from a BIP39 mnemonic.
 *
 * Uses `PrivateKey.fromLogin(account, mnemonic, role)` — the same derivation
 * Hive Keychain's "Add Account by Master Password" flow uses. The mnemonic
 * functions as the master password input; `fromLogin` accepts any string.
 *
 * Mirrors backend/src/seed-phrase.ts. If the two derivations drift, every
 * new light-account signup splits across two algorithms (frontend broadcasts
 * pubkeys derived one way, backend recovery expects the other).
 */

import { generateMnemonic as _genMnemonic, validateMnemonic as _valMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const ROLES = ['owner', 'active', 'posting', 'memo'];

// Lazy-loaded dhive (heavy dependency, only load when needed).
// Exported so callers that already need dhive APIs (e.g. PrivateKey.fromString,
// cryptoUtils.sha256) can reuse the cached module instead of issuing a parallel
// `await import('@hiveio/dhive')`. The browser module registry dedupes the
// underlying fetch, but symmetric usage at call sites makes the dependency
// path obvious and matches the _performKeychainImport pattern.
let _dhive = null;
export async function loadDhive() {
  if (!_dhive) {
    _dhive = await import('@hiveio/dhive');
  }
  return _dhive;
}

/**
 * Generate a 12-word BIP39 mnemonic (128 bits of entropy).
 */
export function generateMnemonic() {
  return _genMnemonic(wordlist, 128);
}

/**
 * Validate a BIP39 mnemonic. UX guardrail to catch user typos before
 * derivation, even though `PrivateKey.fromLogin` itself accepts any string.
 */
export function validateMnemonic(mnemonic) {
  return _valMnemonic(mnemonic, wordlist);
}

/**
 * Derive per-role Hive private-key WIFs from a 12-word mnemonic + account name.
 * @param {string} mnemonic - 12-word BIP39 mnemonic (used as master-password input)
 * @param {string} account - Hive username
 * @returns {Promise<{ owner: string, active: string, posting: string, memo: string }>} per-role WIFs
 */
export async function deriveHiveKeys(mnemonic, account) {
  const dhive = await loadDhive();
  const result = {};
  for (const role of ROLES) {
    result[role] = dhive.PrivateKey.fromLogin(account, mnemonic, role).toString();
  }
  return result;
}

/**
 * Get public keys (STM-prefixed) from per-role WIFs.
 * @param {{ owner: string, active: string, posting: string, memo: string }} wifs
 * @returns {Promise<{ owner: string, active: string, posting: string, memo: string }>}
 */
export async function deriveHivePublicKeys(wifs) {
  const dhive = await loadDhive();
  const result = {};
  for (const role of ROLES) {
    result[role] = dhive.PrivateKey.fromString(wifs[role]).createPublic().toString();
  }
  return result;
}

/**
 * Full key derivation: mnemonic + username -> all key pairs (private WIF + public STM).
 * This is the main function for the signup flow.
 * @param {string} mnemonic - 12-word BIP39 mnemonic
 * @param {string} username - Hive username
 * @returns {Promise<{ owner: {private: string, public: string}, active: {private: string, public: string}, posting: {private: string, public: string}, memo: {private: string, public: string} }>}
 */
export async function deriveAllKeys(mnemonic, username) {
  // Delegate to deriveHiveKeys so PrivateKey.fromLogin only appears in one
  // place. If this loop independently called fromLogin again, a future
  // algorithm change patching one function without the other would silently
  // split signup/recovery (uses deriveAllKeys) from custody-upgrade (uses
  // deriveHiveKeys). The parity test in hive-keys.test.js anchors the
  // single-source property module-wide.
  const wifs = await deriveHiveKeys(mnemonic, username);
  const dhive = await loadDhive();
  const result = {};
  for (const role of ROLES) {
    const priv = dhive.PrivateKey.fromString(wifs[role]);
    result[role] = {
      private: priv.toString(),
      public: priv.createPublic().toString(),
    };
  }
  return result;
}
