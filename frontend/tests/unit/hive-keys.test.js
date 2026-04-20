import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  validateMnemonic,
  deriveHiveKeys,
  deriveHivePublicKeys,
  deriveAllKeys,
  mnemonicToSeedSync,
} from '../../src/hive-keys.js';

describe('generateMnemonic + validateMnemonic', () => {
  it('generateMnemonic returns a 12-word BIP39 mnemonic that validateMnemonic accepts', () => {
    const m = generateMnemonic();
    expect(m.split(' ')).toHaveLength(12);
    expect(validateMnemonic(m)).toBe(true);
  });

  it('validateMnemonic rejects a tampered mnemonic', () => {
    // Use a known-valid mnemonic and corrupt it deterministically.
    // "abandon" x11 + "about" is valid; replacing "about" with "abandon" breaks checksum.
    const valid = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(validateMnemonic(valid)).toBe(true);
    const tampered = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
    expect(validateMnemonic(tampered)).toBe(false);
  });
});

describe('deriveHiveKeys (deterministic hex seeds)', () => {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('returns the same hex for the same (seed, account)', () => {
    const seed = mnemonicToSeedSync(mnemonic);
    const a = deriveHiveKeys(seed, 'alice');
    const b = deriveHiveKeys(seed, 'alice');
    expect(a).toEqual(b);
  });

  it('returns different hex for every role when the account changes', () => {
    const seed = mnemonicToSeedSync(mnemonic);
    const alice = deriveHiveKeys(seed, 'alice');
    const bob = deriveHiveKeys(seed, 'bob');
    for (const role of ['owner', 'active', 'posting', 'memo']) {
      expect(alice[role]).toMatch(/^[0-9a-f]{64}$/);
      expect(bob[role]).toMatch(/^[0-9a-f]{64}$/);
      expect(alice[role]).not.toBe(bob[role]);
    }
  });

  it('returns four distinct hex seeds per account (one per role)', () => {
    const seed = mnemonicToSeedSync(mnemonic);
    const keys = deriveHiveKeys(seed, 'alice');
    const set = new Set(Object.values(keys));
    expect(set.size).toBe(4);
  });
});

describe('deriveHivePublicKeys', () => {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('returns STM public keys for all four roles', async () => {
    const seed = mnemonicToSeedSync(mnemonic);
    const hexKeys = deriveHiveKeys(seed, 'alice');
    const pubKeys = await deriveHivePublicKeys(hexKeys);

    for (const role of ['owner', 'active', 'posting', 'memo']) {
      expect(pubKeys[role]).toMatch(/^STM[1-9A-HJ-NP-Za-km-z]{30,}$/);
    }
  });

  it('matches public keys from deriveAllKeys', async () => {
    const allKeys = await deriveAllKeys(mnemonic, 'alice');
    const seed = mnemonicToSeedSync(mnemonic);
    const hexKeys = deriveHiveKeys(seed, 'alice');
    const pubKeys = await deriveHivePublicKeys(hexKeys);

    for (const role of ['owner', 'active', 'posting', 'memo']) {
      expect(pubKeys[role]).toBe(allKeys[role].public);
    }
  });
});

describe('deriveAllKeys (full Hive key pairs)', () => {
  // These snapshots lock the exact BIP39 -> HMAC-SHA512 -> PrivateKey.fromSeed
  // pipeline. They MUST byte-match the backend's derivation at
  // backend/src/seed-phrase.ts — see deriveKeysFromMnemonic / derivePrivateKey
  // there. If the backend algorithm drifts, this is the frontend test that
  // breaks first (and that is the point).
  it('snapshot: mnemonic="abandon... about", username="alice"', async () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const keys = await deriveAllKeys(mnemonic, 'alice');

    for (const role of ['owner', 'active', 'posting', 'memo']) {
      expect(keys[role].public).toMatch(/^STM[1-9A-HJ-NP-Za-km-z]{30,}$/);
      expect(keys[role].private).toMatch(/^5[1-9A-HJ-NP-Za-km-z]{30,}$/);
    }

    expect(keys).toMatchInlineSnapshot(`
      {
        "active": {
          "private": "5KBWd1V1ZBKu9gqBweYJK3tbgLLeNAFrcFitWHLMvdHgjV6txQd",
          "public": "STM7fzMrwGENKDvgaWxUg4ddjPsT6jXocsaMgnxWEQS3FTqCZVf3j",
        },
        "memo": {
          "private": "5JkXNNEH2sHEwKy4CZPppTm7fjtG2D7LV85J2NJgvRhqwmgAoDm",
          "public": "STM6onoAMzUYzCkVsWYCMGazU3mWZAtFVRnM1jbBF5akgfMpdQ6o1",
        },
        "owner": {
          "private": "5JfpLB7eK2ZHYvtF49AgaBHMiVHjk6KEiPpbwWQeNVP62fqX66y",
          "public": "STM6a8keZyDDpfXdJ85cy2cK4756aBQh18BTM6RsgYfjGwGkGgbQM",
        },
        "posting": {
          "private": "5K9AQcMqXxLQKmSNF5mmR9L1eT5DvhUnoJ7irmmHM6PSVsTth6T",
          "public": "STM7PSoLXYh3tPht1GU3WMPPzMe3n6aLNoRCRChhyibHY7LZf4zcy",
        },
      }
    `);
  });

  it('snapshot: mnemonic="legal winner...", username="bob" (guards against lucky-collision regression)', async () => {
    const mnemonic = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const keys = await deriveAllKeys(mnemonic, 'bob');

    for (const role of ['owner', 'active', 'posting', 'memo']) {
      expect(keys[role].public).toMatch(/^STM[1-9A-HJ-NP-Za-km-z]{30,}$/);
      expect(keys[role].private).toMatch(/^5[1-9A-HJ-NP-Za-km-z]{30,}$/);
    }

    expect(keys).toMatchInlineSnapshot(`
      {
        "active": {
          "private": "5KG5pyzLoMmmAftjyJMXVDQWj1V6aXkYTzC2SvPdEap1w8edZ3R",
          "public": "STM8FzMAjjfm43sJqgaCLKCe34THjdYmkJvrrZndUQm3Txi1NVHk9",
        },
        "memo": {
          "private": "5JxgAtC98cw2ax5zpsvD3bfVcruJHqKqnHzXtmSv7qU1UyhVYdG",
          "public": "STM67tt1q8qNhr9JWiooYe1JsRk9RWuUMs5CFYDZt6X4BBFUbbVWH",
        },
        "owner": {
          "private": "5JmSFonnkehxYyo7ouo3ndji8hWNrxpYd4XDdKWc6MRfXXa854P",
          "public": "STM74nG55QFP1f2bcpuPGDhDMmUCXexnSq8BVQo6PtidhW1MaciNR",
        },
        "posting": {
          "private": "5KSgS8Zv2RZU7m8B9G4Btpc3Bqc1UnVgQyUATEPWyeNDSXh7gjw",
          "public": "STM6ykXerqdS8G2iQKwCirpr1yPBtF5qu8pDqo2RW4JNXc7PzY7KY",
        },
      }
    `);
  });

  it('changing only the username produces a fully-different key set for the same mnemonic', async () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const alice = await deriveAllKeys(mnemonic, 'alice');
    const charlie = await deriveAllKeys(mnemonic, 'charlie');
    for (const role of ['owner', 'active', 'posting', 'memo']) {
      expect(alice[role].private).not.toBe(charlie[role].private);
      expect(alice[role].public).not.toBe(charlie[role].public);
    }
  });
});
