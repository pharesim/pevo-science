import { PrivateKey } from '@hiveio/dhive';
import type * as Bip39 from '@scure/bip39' with { 'resolution-mode': 'import' };

const ROLES = ['owner', 'active', 'posting', 'memo'] as const;

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

// Lazy-load ESM-only @scure/bip39 (only used for mnemonic generation/validation
// as a UX guardrail; PrivateKey.fromLogin itself accepts any string). Cached
// as a single atomic object so tsc proves both fields non-null at the return
// site — splitting into two nullable variables would require a `!` assertion
// load-bearing on a structural invariant the type system can't see.
let _cache: { bip39: typeof Bip39; wordlist: string[] } | null = null;

async function loadBip39() {
  if (!_cache) {
    // ESM-only deps. Dynamic import works at runtime under both Node16/CJS
    // (Node treats import() as ESM regardless of host module classification)
    // and under vitest/ESBuild's ESM bundling. The earlier eval('import(...)')
    // workaround failed under vitest because eval doesn't carry the
    // dynamic-import callback. The '.js' suffix on the wordlist subpath is
    // required by the package's exports field.
    const bip39 = await import('@scure/bip39');
    const wl = await import('@scure/bip39/wordlists/english.js');
    _cache = { bip39, wordlist: wl.wordlist };
  }
  return _cache;
}

/**
 * Generate a new 12-word BIP39 mnemonic (128 bits of entropy).
 */
export async function generateSeedPhrase(): Promise<string> {
  const { bip39, wordlist } = await loadBip39();
  return bip39.generateMnemonic(wordlist, 128);
}

/**
 * Validate a BIP39 mnemonic. UX guardrail to catch user typos before
 * derivation; PrivateKey.fromLogin itself accepts any string.
 */
export async function isValidSeedPhrase(mnemonic: string): Promise<boolean> {
  const { bip39, wordlist } = await loadBip39();
  return bip39.validateMnemonic(mnemonic, wordlist);
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
 *
 * Each per-role private key is derived via
 * `PrivateKey.fromLogin(account, mnemonic, role)` — the same derivation
 * Hive Keychain's "Add Account by Master Password" flow uses. The
 * mnemonic functions as the master-password input.
 *
 * Mirrors frontend/src/hive-keys.js. If the two derivations drift, every
 * new light-account signup splits across two algorithms (frontend
 * broadcasts pubkeys derived one way, backend recovery expects the
 * other).
 *
 * The mnemonic is validated against the BIP39 wordlist as a UX guardrail
 * to catch user typos. The validation is no longer cryptographically
 * required (PrivateKey.fromLogin accepts any string), but rejecting
 * typos at this layer surfaces the error closer to user input.
 */
export async function deriveKeysFromMnemonic(mnemonic: string, account: string): Promise<DerivedKeys> {
  const { bip39, wordlist } = await loadBip39();
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid BIP39 mnemonic');
  }
  const result = {} as DerivedKeys;
  for (const role of ROLES) {
    const priv = PrivateKey.fromLogin(account, mnemonic, role);
    result[role] = {
      private: priv.toString(),
      public: priv.createPublic().toString(),
    };
  }
  return result;
}
