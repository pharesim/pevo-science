import crypto from 'node:crypto';
import { config } from './config.js';

const ALGORITHM = 'aes-256-gcm';
export const IV_LENGTH = 12; // 96 bits for GCM
export const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/**
 * HKDF info prefix that scopes derived keys to this module's purpose.
 * Exported so tests can construct the canonical HKDF input without
 * duplicating the literal string and silently drifting from production.
 */
export const HKDF_INFO_PREFIX = 'pevo:custody:';

/**
 * Derive a per-account encryption key from the master CUSTODY_ENCRYPTION_KEY using HKDF.
 * Each username gets a unique derived key, so compromising one ciphertext
 * doesn't directly help with others.
 */
function deriveKey(username: string): Buffer {
  const masterKey = config.custodyEncryptionKey;
  if (!masterKey || masterKey.length < 32) {
    throw new Error('CUSTODY_ENCRYPTION_KEY must be set (at least 32 hex characters)');
  }
  const keyMaterial = Buffer.from(masterKey, 'hex');
  return Buffer.from(crypto.hkdfSync('sha256', keyMaterial, '', `${HKDF_INFO_PREFIX}${username}`, KEY_LENGTH));
}

/**
 * Encrypt a Hive private key (WIF string) for storage.
 * Returns { ciphertext, iv } as Buffers.
 */
export function encryptKey(username: string, privateKey: string): { ciphertext: Buffer; iv: Buffer } {
  const key = deriveKey(username);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store ciphertext + auth tag together
  const ciphertext = Buffer.concat([encrypted, authTag]);
  return { ciphertext, iv };
}

/**
 * Decrypt a stored Hive private key.
 * Expects the ciphertext to include the GCM auth tag appended at the end.
 */
export function decryptKey(username: string, ciphertext: Buffer, iv: Buffer): string {
  const key = deriveKey(username);
  const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LENGTH);
  const encrypted = ciphertext.subarray(0, ciphertext.length - AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
