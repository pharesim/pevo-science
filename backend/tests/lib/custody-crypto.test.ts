/**
 * Direct unit tests for `backend/src/custody-crypto.ts`.
 *
 * The module is load-bearing for every light-account broadcast and recovery
 * flow (it encrypts the posting + memo keys the backend signs on behalf of
 * the user). Existing test files use it only as a fixture (`encryptKey` to
 * mint ciphertexts for route tests) or `vi.mock` it away entirely, so the
 * crypto itself was unasserted. A silent regression in HKDF context,
 * IV handling, or cipher choice would have shipped undetected.
 *
 * Justification for direct unit tests (no infra mocks):
 *  - The module exposes pure functions over `node:crypto`. No DB, Redis, or
 *    HTTP surface is involved — there is nothing to mock besides the crypto
 *    primitives themselves, which the task forbids ("Tests use the real
 *    `crypto` module — no mocks of `crypto.createCipheriv` etc.").
 *  - `CUSTODY_ENCRYPTION_KEY` is read by `src/config.ts` at module load.
 *    The test sets it on `process.env` before any import of either module
 *    so the captured `config.custodyEncryptionKey` is the test-only key.
 *    A separate `describe` block exercises the master-key-length validation
 *    via `vi.resetModules()` + a temporarily replaced env var, so the
 *    invariant covers both accept and reject branches.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// 64 hex chars = 32 bytes (256 bits). Matches the module's documented
// minimum-strength contract for the master key. Deterministic / test-only.
const TEST_MASTER_KEY = 'a'.repeat(64);

// Force the env var to a test-only value BEFORE importing the module under
// test or `config.js`. `vitest.config.ts` overlays the project `.env` onto
// `process.env` via Vite's `loadEnv`, so the production master key would
// otherwise leak into the canonical HKDF-derivation check below (which
// re-derives the per-account key independently and must agree byte-for-byte
// with what `encryptKey` used).
process.env.CUSTODY_ENCRYPTION_KEY = TEST_MASTER_KEY;
// Ensure no previously-cached `config.js` snapshot survives — Vitest may
// have loaded `setup.ts` (which imports `config`) before this file runs.
vi.resetModules();

// Dynamic import so the env mutation above is in effect at config load.
const { encryptKey, decryptKey } = await import('../../src/custody-crypto.js');
const crypto = await import('node:crypto');

const SAMPLE_WIF = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';

describe('custody-crypto: AES-256-GCM round-trip', () => {
  it('encrypt → decrypt yields the original plaintext under the same username', () => {
    const { ciphertext, iv } = encryptKey('alice', SAMPLE_WIF);
    const recovered = decryptKey('alice', ciphertext, iv);
    expect(recovered).toBe(SAMPLE_WIF);
  });

  it('round-trips an empty string', () => {
    const { ciphertext, iv } = encryptKey('alice', '');
    expect(decryptKey('alice', ciphertext, iv)).toBe('');
  });

  it('round-trips a multi-byte UTF-8 payload', () => {
    const payload = 'unicode-test-key-' + '\u{1F511}\u{1F510}é' + '-end';
    const { ciphertext, iv } = encryptKey('alice', payload);
    expect(decryptKey('alice', ciphertext, iv)).toBe(payload);
  });
});

describe('custody-crypto: tamper detection (GCM authenticates ciphertext + auth tag + IV)', () => {
  it('flipping a bit in the ciphertext body causes decrypt to throw', () => {
    const { ciphertext, iv } = encryptKey('alice', SAMPLE_WIF);
    const tampered = Buffer.from(ciphertext);
    // Flip a low bit early in the encrypted body (well clear of the
    // appended 16-byte auth tag at the tail).
    tampered[0] ^= 0x01;
    expect(() => decryptKey('alice', tampered, iv)).toThrow();
  });

  it('flipping a bit in the appended auth tag causes decrypt to throw', () => {
    const { ciphertext, iv } = encryptKey('alice', SAMPLE_WIF);
    const tampered = Buffer.from(ciphertext);
    // The auth tag is the trailing 16 bytes; mutate the last byte.
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decryptKey('alice', tampered, iv)).toThrow();
  });

  it('flipping a bit in the IV causes decrypt to throw', () => {
    const { ciphertext, iv } = encryptKey('alice', SAMPLE_WIF);
    const tamperedIv = Buffer.from(iv);
    tamperedIv[0] ^= 0x01;
    expect(() => decryptKey('alice', ciphertext, tamperedIv)).toThrow();
  });
});

describe('custody-crypto: HKDF username context separation', () => {
  it('ciphertext for alice does not decrypt under bob', () => {
    const { ciphertext, iv } = encryptKey('alice', SAMPLE_WIF);
    // GCM auth-tag check fails when the derived key differs, which is
    // exactly the property HKDF context separation enforces.
    expect(() => decryptKey('bob', ciphertext, iv)).toThrow();
  });

  it('case-different usernames are treated as distinct HKDF contexts', () => {
    // `pevo:custody:Alice` and `pevo:custody:alice` are distinct HKDF
    // info strings; the derived keys must not collide.
    const { ciphertext, iv } = encryptKey('Alice', SAMPLE_WIF);
    expect(() => decryptKey('alice', ciphertext, iv)).toThrow();
  });
});

describe('custody-crypto: IV non-reuse (semantic security)', () => {
  it('two encryptions of the same plaintext under the same username produce different ciphertexts', () => {
    const first = encryptKey('alice', SAMPLE_WIF);
    const second = encryptKey('alice', SAMPLE_WIF);
    // GCM with a fresh random IV per call MUST diverge in both the IV and
    // the encrypted body. If `crypto.randomBytes` were replaced by a fixed
    // constant the assertion below would flip.
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('IV length is 12 bytes (GCM standard nonce size)', () => {
    const { iv } = encryptKey('alice', SAMPLE_WIF);
    // 12-byte (96-bit) IVs are the GCM recommended size. A drift to a
    // longer IV would break interoperability with stored ciphertexts and
    // is worth pinning.
    expect(iv.length).toBe(12);
  });
});

describe('custody-crypto: GCM auth tag is present in the ciphertext envelope', () => {
  it('ciphertext length exceeds the encrypted plaintext by exactly 16 bytes (AES-GCM tag)', () => {
    const plaintext = 'short';
    const { ciphertext } = encryptKey('alice', plaintext);
    // AES-GCM produces ciphertext of the same length as the plaintext
    // (no padding); the module appends the 16-byte auth tag. Any swap to
    // CBC (which pads to the 16-byte block boundary) or to a stream cipher
    // without an appended tag would change this invariant.
    const AUTH_TAG_LENGTH = 16;
    expect(ciphertext.length).toBe(Buffer.byteLength(plaintext, 'utf8') + AUTH_TAG_LENGTH);
  });

  it('the trailing 16 bytes (auth tag slice) are not all zero', () => {
    const { ciphertext } = encryptKey('alice', SAMPLE_WIF);
    const tag = ciphertext.subarray(ciphertext.length - 16);
    expect(tag.length).toBe(16);
    // An all-zero tag would indicate the cipher never produced one (e.g. a
    // silent fall-through to a tag-less mode). Vanishingly unlikely for
    // real GCM output over real plaintext.
    const allZero = tag.every((b) => b === 0);
    expect(allZero).toBe(false);
  });

  it('the ciphertext envelope is distinct from the plaintext bytes', () => {
    const plaintext = SAMPLE_WIF;
    const { ciphertext } = encryptKey('alice', plaintext);
    expect(ciphertext.equals(Buffer.from(plaintext, 'utf8'))).toBe(false);
  });
});

describe('custody-crypto: master key length validation', () => {
  // The validator lives in `deriveKey` and is exercised on every
  // encryptKey/decryptKey call. The check operates on the env-string
  // length (in hex characters), so a too-short hex string must be
  // rejected with a thrown error.
  //
  // `config` captures `process.env.CUSTODY_ENCRYPTION_KEY` at module
  // load, so we must reset modules between mutations to re-snapshot.

  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.CUSTODY_ENCRYPTION_KEY;
  });

  afterEach(async () => {
    // Restore the test-suite-wide key and re-import so any later test
    // in this file sees the normal master-key-present config.
    if (originalKey === undefined) {
      delete process.env.CUSTODY_ENCRYPTION_KEY;
    } else {
      process.env.CUSTODY_ENCRYPTION_KEY = originalKey;
    }
  });

  it('refuses to derive a key when the master key is empty', async () => {
    vi.resetModules();
    process.env.CUSTODY_ENCRYPTION_KEY = '';
    const { encryptKey: encryptFresh } = await import('../../src/custody-crypto.js');
    expect(() => encryptFresh('alice', SAMPLE_WIF)).toThrow(/CUSTODY_ENCRYPTION_KEY/);
    vi.resetModules();
  });

  it('refuses to derive a key when the master key is shorter than 32 hex characters', async () => {
    vi.resetModules();
    // 31 hex chars: one below the validator's minimum.
    process.env.CUSTODY_ENCRYPTION_KEY = 'a'.repeat(31);
    const { encryptKey: encryptFresh } = await import('../../src/custody-crypto.js');
    expect(() => encryptFresh('alice', SAMPLE_WIF)).toThrow(/CUSTODY_ENCRYPTION_KEY/);
    vi.resetModules();
  });

  it('accepts a 32-hex-character master key (current minimum)', async () => {
    // The audit P2 follow-up notes the spec is 32 BYTES (64 hex chars),
    // but the current validator's contract is 32 hex characters. Pin
    // the current acceptance boundary so any tightening of the validator
    // is a deliberate, test-visible change rather than a silent shift.
    vi.resetModules();
    process.env.CUSTODY_ENCRYPTION_KEY = 'b'.repeat(32);
    const { encryptKey: encryptFresh, decryptKey: decryptFresh } = await import('../../src/custody-crypto.js');
    const { ciphertext, iv } = encryptFresh('alice', SAMPLE_WIF);
    expect(decryptFresh('alice', ciphertext, iv)).toBe(SAMPLE_WIF);
    vi.resetModules();
  });
});

describe('custody-crypto: HKDF derives deterministic per-username keys', () => {
  // Belt-and-braces check that the derived key for a given (master, username)
  // pair is stable across calls. If HKDF inputs ever picked up nondeterminism
  // (a timestamp, a random salt) the encrypt/decrypt round-trip would still
  // pass per call but new ciphertexts would be unreadable by later code paths
  // that re-derive the key, which is precisely the recovery-flow failure
  // mode the validation here is meant to lock in.
  it('the same username + master produces ciphertext decryptable across independent encrypt+decrypt pairs', () => {
    const first = encryptKey('alice', SAMPLE_WIF);
    const second = encryptKey('alice', SAMPLE_WIF);
    // Decrypt each independently; both must yield the original plaintext,
    // which requires deterministic key derivation across the two calls.
    expect(decryptKey('alice', first.ciphertext, first.iv)).toBe(SAMPLE_WIF);
    expect(decryptKey('alice', second.ciphertext, second.iv)).toBe(SAMPLE_WIF);
  });

  // Sanity-check that `crypto.hkdfSync` is the primitive under test (i.e.
  // the module did not silently swap to a different KDF). This is the
  // closest no-mock surrogate for an HKDF-context-was-dropped mutation:
  // the derived key bytes for a known input must match the canonical
  // primitive's output.
  it('derives bytes that match a canonical `crypto.hkdfSync` invocation under the same context', () => {
    const masterKey = Buffer.from(TEST_MASTER_KEY, 'hex');
    const canonical = Buffer.from(
      crypto.hkdfSync('sha256', masterKey, '', 'pevo:custody:alice', 32),
    );
    // Round-trip a known plaintext using the module, then independently
    // GCM-decrypt the ciphertext with the canonical derived key. If the
    // module ever drops the username from the HKDF info or swaps to a
    // different KDF, this will fail loudly.
    const { ciphertext, iv } = encryptKey('alice', SAMPLE_WIF);
    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const body = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', canonical, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    expect(plaintext).toBe(SAMPLE_WIF);
  });
});
