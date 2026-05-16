import { describe, it, expect } from 'vitest';
import { PrivateKey } from '@hiveio/dhive';
import { deriveKeysFromMnemonic, generateKeysFromNewSeed, isValidSeedPhrase, generateSeedPhrase } from '../src/seed-phrase.js';

/**
 * Parity test for backend seed-phrase derivation against the canonical
 * `PrivateKey.fromLogin(account, master_password, role)` algorithm Hive
 * Keychain's "Add Account by Master Password" flow uses.
 *
 * The backstop this test exists for: if `deriveKeysFromMnemonic` ever drifts
 * away from `PrivateKey.fromLogin` (e.g., a future refactor re-introduces
 * a custom HMAC pipeline, or wraps the mnemonic before passing to fromLogin),
 * users who paste their 12-word phrase into Hive Keychain will get
 * key-mismatch errors and lose the recovery story.
 *
 * Mirrors `frontend/tests/hive-keys.test.js` parity assertion. The two
 * halves of the seed-phrase recovery story (backend + frontend) MUST
 * derive identically.
 *
 * No mocks. No pinned WIF strings. The parity comparison computes
 * `PrivateKey.fromLogin` directly and compares against the helper's
 * output, so if PrivateKey.fromLogin's behavior ever changes in dhive,
 * both sides of the equation move together.
 */
describe('seed-phrase backend derivation parity vs PrivateKey.fromLogin', () => {
  // A fixed valid BIP39 mnemonic (the all-zeros test vector). 12 words from
  // the English wordlist, validates against BIP39 checksum.
  const FIXED_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const ROLES = ['owner', 'active', 'posting', 'memo'] as const;

  it('every role WIF equals PrivateKey.fromLogin(account, mnemonic, role) for a fixed account', async () => {
    const account = 'testaccount';
    const keys = await deriveKeysFromMnemonic(FIXED_MNEMONIC, account);
    for (const role of ROLES) {
      const expected = PrivateKey.fromLogin(account, FIXED_MNEMONIC, role).toString();
      expect(keys[role].private, `role: ${role}`).toBe(expected);
    }
  });

  it('every role public key equals the createPublic() of the fromLogin private key', async () => {
    const account = 'someuser';
    const keys = await deriveKeysFromMnemonic(FIXED_MNEMONIC, account);
    for (const role of ROLES) {
      const expectedPub = PrivateKey.fromLogin(account, FIXED_MNEMONIC, role).createPublic().toString();
      expect(keys[role].public, `role: ${role}`).toBe(expectedPub);
      // Sanity: STM-prefixed pubkey shape.
      expect(keys[role].public).toMatch(/^STM[1-9A-HJ-NP-Za-km-z]+$/);
    }
  });

  it('derivation depends on the account name (different account → different WIFs)', async () => {
    const keysA = await deriveKeysFromMnemonic(FIXED_MNEMONIC, 'alice');
    const keysB = await deriveKeysFromMnemonic(FIXED_MNEMONIC, 'bob');
    for (const role of ROLES) {
      expect(keysA[role].private, `role: ${role}`).not.toBe(keysB[role].private);
    }
  });

  it('derivation depends on the role (different role → different WIFs for same account)', async () => {
    const keys = await deriveKeysFromMnemonic(FIXED_MNEMONIC, 'carol');
    const wifs = ROLES.map((r) => keys[r].private);
    // Each role's WIF must be distinct.
    expect(new Set(wifs).size).toBe(ROLES.length);
  });

  it('rejects an invalid BIP39 mnemonic', async () => {
    // Wrong wordcount + invalid checksum.
    await expect(deriveKeysFromMnemonic('not a real mnemonic', 'alice')).rejects.toThrow(/Invalid BIP39 mnemonic/);
  });

  it('generateKeysFromNewSeed returns a self-consistent (mnemonic, keys) pair', async () => {
    const { mnemonic, keys } = await generateKeysFromNewSeed('newuser');
    expect(await isValidSeedPhrase(mnemonic)).toBe(true);
    // The returned keys must equal what re-deriving from the same mnemonic gives.
    const re = await deriveKeysFromMnemonic(mnemonic, 'newuser');
    for (const role of ROLES) {
      expect(keys[role].private, `role: ${role}`).toBe(re[role].private);
      expect(keys[role].public, `role: ${role}`).toBe(re[role].public);
    }
  });

  it('generateSeedPhrase produces a valid 12-word BIP39 mnemonic', async () => {
    const m = await generateSeedPhrase();
    expect(m.split(/\s+/).length).toBe(12);
    expect(await isValidSeedPhrase(m)).toBe(true);
  });
});
