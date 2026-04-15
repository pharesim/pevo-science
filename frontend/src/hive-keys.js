/**
 * Client-side Hive key derivation from BIP39 mnemonic.
 * Exact same algorithm as backend's seed-phrase.ts:
 *   mnemonicToSeedSync(mnemonic) -> 64-byte seed
 *   For each role: HMAC-SHA512(seed, account+role) -> first 32 bytes hex -> PrivateKey.fromSeed(hex)
 */

import { generateMnemonic as _genMnemonic, validateMnemonic as _valMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';

const ROLES = ['owner', 'active', 'posting', 'memo'];

// Lazy-loaded dhive (heavy dependency, only load when needed)
let _dhive = null;
async function loadDhive() {
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
 * Validate a BIP39 mnemonic.
 */
export function validateMnemonic(mnemonic) {
  return _valMnemonic(mnemonic, wordlist);
}

/**
 * Derive Hive key hex seeds from a BIP39 seed + account name (synchronous).
 * Returns hex strings that can be passed to PrivateKey.fromSeed().
 * Used by settings.js upgrade flow (which passes seed from mnemonicToSeedSync).
 * @param {Uint8Array} seed - 64-byte seed from mnemonicToSeedSync
 * @param {string} account - Hive username
 * @returns {{ owner: string, active: string, posting: string, memo: string }} hex seed strings
 */
export function deriveHiveKeys(seed, account) {
  const result = {};
  for (const role of ROLES) {
    const data = new TextEncoder().encode(`${account}${role}`);
    const derived = hmac(sha512, seed, data);
    result[role] = bytesToHex(derived.slice(0, 32));
  }
  return result;
}

/**
 * Get public keys from hex seed strings (for the upgrade flow in settings.js).
 * @param {{ owner: string, active: string, posting: string, memo: string }} hexKeys
 * @returns {Promise<{ owner: string, active: string, posting: string, memo: string }>} STM public keys
 */
export async function deriveHivePublicKeys(hexKeys) {
  const dhive = await loadDhive();
  const result = {};
  for (const role of ROLES) {
    const priv = dhive.PrivateKey.fromSeed(hexKeys[role]);
    result[role] = priv.createPublic().toString();
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
  const seed = mnemonicToSeedSync(mnemonic);
  const hexKeys = deriveHiveKeys(seed, username);
  const dhive = await loadDhive();

  const result = {};
  for (const role of ROLES) {
    const priv = dhive.PrivateKey.fromSeed(hexKeys[role]);
    result[role] = {
      private: priv.toString(),
      public: priv.createPublic().toString(),
    };
  }
  return result;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export { mnemonicToSeedSync, wordlist };
