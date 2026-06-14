import { describe, it, expect } from 'vitest';
import { PrivateKey } from '@hiveio/dhive';
import {
  generateMnemonic,
  validateMnemonic,
  deriveHiveKeys,
  deriveHivePublicKeys,
  deriveAllKeys,
} from '../../src/hive-keys.js';

// Seed-phrase / Keychain compatibility: all derivation in this module
// uses PrivateKey.fromLogin(account, mnemonic, role) — the same algorithm
// Hive Keychain's "Add Account by Master Password" flow uses. Mirrors
// backend/src/seed-phrase.ts. Snapshots below pin the derived values.

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

describe('deriveHiveKeys (per-role WIFs)', () => {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('returns the same WIFs for the same (mnemonic, account)', async () => {
    const a = await deriveHiveKeys(mnemonic, 'alice');
    const b = await deriveHiveKeys(mnemonic, 'alice');
    expect(a).toEqual(b);
  });

  it('returns a different WIF for every role when the account changes', async () => {
    const alice = await deriveHiveKeys(mnemonic, 'alice');
    const bob = await deriveHiveKeys(mnemonic, 'bob');
    for (const role of ['owner', 'active', 'posting', 'memo']) {
      expect(alice[role]).toMatch(/^5[1-9A-HJ-NP-Za-km-z]{30,}$/);
      expect(bob[role]).toMatch(/^5[1-9A-HJ-NP-Za-km-z]{30,}$/);
      expect(alice[role]).not.toBe(bob[role]);
    }
  });

  it('returns four distinct WIFs per account (one per role)', async () => {
    const keys = await deriveHiveKeys(mnemonic, 'alice');
    const set = new Set(Object.values(keys));
    expect(set.size).toBe(4);
  });
});

describe('deriveHivePublicKeys', () => {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('returns STM public keys for all four roles', async () => {
    const wifs = await deriveHiveKeys(mnemonic, 'alice');
    const pubKeys = await deriveHivePublicKeys(wifs);

    for (const role of ['owner', 'active', 'posting', 'memo']) {
      expect(pubKeys[role]).toMatch(/^STM[1-9A-HJ-NP-Za-km-z]{30,}$/);
    }
  });

  it('matches public keys from deriveAllKeys', async () => {
    const allKeys = await deriveAllKeys(mnemonic, 'alice');
    const wifs = await deriveHiveKeys(mnemonic, 'alice');
    const pubKeys = await deriveHivePublicKeys(wifs);

    for (const role of ['owner', 'active', 'posting', 'memo']) {
      expect(pubKeys[role]).toBe(allKeys[role].public);
    }
  });
});

describe('deriveAllKeys (full Hive key pairs)', () => {
  // These snapshots lock the PrivateKey.fromLogin(account, mnemonic, role)
  // pipeline. They MUST byte-match the backend's derivation at
  // backend/src/seed-phrase.ts. If the backend algorithm drifts, this is
  // the frontend test that breaks first (and that is the point). The
  // values are the WIFs/pubkeys returned by dhive's fromLogin — the same
  // values Hive Keychain's "Add Account by Master Password" flow produces
  // for the same (account, mnemonic) input.
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
          "private": "5K7iPKKKNjDSokcGPMbJprDUZUPBgp5mUVUubFzbJkgUrYxqiz4",
          "public": "STM8Tm6WuU5QfW7647La45DWL3F9TiujbZfGJUvUsdFyd33Sb5nGb",
        },
        "memo": {
          "private": "5J7FpLzxhHfSZNZpBi3aqQ1fwJooLdb9tj51S3gmnhLHB4gHgwQ",
          "public": "STM57TVnUDUKP8VGRiUfGP9bCbk9nuaKnLzcWgkqt18Kv3PdzUbTf",
        },
        "owner": {
          "private": "5JKMPYTBnK7T2tCsngJYWNBkTtuqgWNQ9uD5QF1hSYnAeq17ZRi",
          "public": "STM7Dkf6c1Ctoso6HrxhBqw6pq5DRynxoC44pPeXpAshWsFVQsfJ9",
        },
        "posting": {
          "private": "5KgVKPu1H8vYJrywXom6FF2a664MquLKB1ZjLvUCReb9Xn5PbmC",
          "public": "STM6VeYVz5rtbV2d5vKz6fYkeHaYAJDNTecGbDur9p5jVUYCqA6Cc",
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
          "private": "5KaBvNRpvtbEdKXMokyZaQ7KUjH6Q4JTHpLNgzN5DsB1Scgx3yu",
          "public": "STM5N8tB3RLe1A2td6ERLAppSuGUSEKDiRLmHbUEkA3C6NrFaS3Ud",
        },
        "memo": {
          "private": "5KVTuC9FB4sKHMQkU3RnaAHw83PHRCVH4qrzKjGAuaKAAy94ys4",
          "public": "STM8DY8Peh8QHY2t1berL2akDtms7wBko56M9PgaXY4PKYXWTzgK3",
        },
        "owner": {
          "private": "5KEPWTiCnDCvU9Ju5UVxc14k6tidaFzwU5LzFKKqFyZDQL1dDde",
          "public": "STM5VBjzdWauBdkPdZ4HbJdqUHEETcUUbQ7kvJsy722xa4Sd4rJ9B",
        },
        "posting": {
          "private": "5J6ZSjghvRzyJF4DqdmjLrLW7yx1oxz3NCaBaSbjUz9ovDw6mAf",
          "public": "STM5qpUzt63isZ8hdHhgb3SigdjRT6rb9d3QfVbv5BktQrxdbjtAi",
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

  // Keychain-compatibility parity test: assert deriveAllKeys produces
  // exactly the WIFs PrivateKey.fromLogin(account, mnemonic, role) would
  // produce when called directly. This is the regression backstop that
  // prevents the algorithm drifting away from Hive Keychain's master-password
  // import — if a future refactor swaps fromLogin for any other derivation
  // (HMAC-SHA512 again, fromSeed(sha256(...)) again, etc.) this test breaks
  // immediately.
  it('parity: every role matches PrivateKey.fromLogin(account, mnemonic, role) computed directly', async () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const account = 'alice';
    const keys = await deriveAllKeys(mnemonic, account);
    for (const role of ['owner', 'active', 'posting', 'memo']) {
      const expected = PrivateKey.fromLogin(account, mnemonic, role).toString();
      expect(keys[role].private).toBe(expected);
    }
  });
});
