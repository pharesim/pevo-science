import crypto from 'node:crypto';
import { PrivateKey } from '@hiveio/dhive';

const ROLES = ['owner', 'active', 'posting', 'memo'] as const;
type HiveRole = (typeof ROLES)[number];

export interface HiveKeyPair {
  private: string; // WIF-encoded private key
  public: string;  // STM-prefixed public key
}

export interface DerivedKeys {
  owner: HiveKeyPair;
  active: HiveKeyPair;
  posting: HiveKeyPair;
  memo: HiveKeyPair;
}

// Lazy-load ESM-only @scure/bip39
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _bip39: any = null;
let _wordlist: string[] | null = null;

async function loadBip39() {
  if (!_bip39) {
    _bip39 = await (eval('import("@scure/bip39")') as Promise<any>);
    const wl = await (eval('import("@scure/bip39/wordlists/english")') as Promise<any>);
    _wordlist = wl.wordlist;
  }
  return { bip39: _bip39 as { generateMnemonic: Function; validateMnemonic: Function; mnemonicToSeedSync: Function }, wordlist: _wordlist! };
}

/**
 * Generate a new 12-word BIP39 mnemonic (128 bits of entropy).
 */
export async function generateSeedPhrase(): Promise<string> {
  const { bip39, wordlist } = await loadBip39();
  return bip39.generateMnemonic(wordlist, 128);
}

/**
 * Validate a BIP39 mnemonic.
 */
export async function isValidSeedPhrase(mnemonic: string): Promise<boolean> {
  const { bip39, wordlist } = await loadBip39();
  return bip39.validateMnemonic(mnemonic, wordlist);
}

/**
 * Derive a Hive private key from a seed + account name + role.
 * Uses HMAC-SHA512 with `account + role` as key identifier,
 * matching the spec's deriveKey(seed, account, role) approach.
 */
function derivePrivateKey(seed: Uint8Array, account: string, role: HiveRole): PrivateKey {
  const data = `${account}${role}`;
  const hmac = crypto.createHmac('sha512', Buffer.from(seed));
  hmac.update(data);
  const derived = hmac.digest();
  // Use first 32 bytes as the private key seed string (hex-encoded)
  const keyHex = derived.subarray(0, 32).toString('hex');
  return PrivateKey.fromSeed(keyHex);
}

/**
 * Generate a 12-word BIP39 mnemonic and derive all 4 Hive key pairs
 * for the given account name.
 */
export async function generateKeysFromNewSeed(account: string): Promise<{ mnemonic: string; keys: DerivedKeys }> {
  const mnemonic = await generateSeedPhrase();
  const keys = await deriveKeysFromMnemonic(mnemonic, account);
  return { mnemonic, keys };
}

/**
 * Derive all 4 Hive key pairs from an existing mnemonic + account name.
 */
export async function deriveKeysFromMnemonic(mnemonic: string, account: string): Promise<DerivedKeys> {
  const { bip39, wordlist } = await loadBip39();
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid BIP39 mnemonic');
  }
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const result = {} as DerivedKeys;
  for (const role of ROLES) {
    const priv = derivePrivateKey(seed, account, role);
    result[role] = {
      private: priv.toString(),
      public: priv.createPublic().toString(),
    };
  }
  return result;
}
