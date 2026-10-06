/**
 * Seed an account that a seed-phrase recovery can run against.
 *
 * The recovery's first step checks the submitted memo key against the one
 * stored encrypted on the account row. Real accounts get that row at signup,
 * which also creates the account on chain, so specs insert it directly in
 * pevo_app_test, encrypted with the same algorithm and key as
 * `encryptKey` in backend/src/custody-crypto.ts. If the two ever drift, the
 * recovery's first step answers 401.
 */

import crypto from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './auth.js';
import { seedLightAccount } from './light-account.js';
import { deriveAllKeys } from '../../../src/hive-keys.js';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The CUSTODY_ENCRYPTION_KEY the local backend boots with. Priority:
 *   1. process.env.E2E_CUSTODY_ENCRYPTION_KEY
 *   2. frontend/.env.test → `CUSTODY_ENCRYPTION_KEY`
 * process.env.CUSTODY_ENCRYPTION_KEY and the repo-root .env are ignored, for
 * the reason getSessionSecret in fixtures/auth.js gives for SESSION_SECRET.
 */
function getCustodyEncryptionKey() {
  const fromEnv = process.env.E2E_CUSTODY_ENCRYPTION_KEY;
  if (fromEnv) return fromEnv;
  const fromFile = parseEnvFile(resolve(FRONTEND_ROOT, '.env.test')).CUSTODY_ENCRYPTION_KEY;
  if (fromFile) return fromFile;
  throw new Error(
    '[e2e recoverable account] CUSTODY_ENCRYPTION_KEY not found. Set ' +
      'process.env.E2E_CUSTODY_ENCRYPTION_KEY or populate frontend/.env.test ' +
      '(see frontend/.env.test.example).',
  );
}

function encryptCustodyKey(username, privateKey) {
  const master = Buffer.from(getCustodyEncryptionKey(), 'hex');
  const key = Buffer.from(crypto.hkdfSync('sha256', master, '', `pevo:custody:${username}`, 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]), iv };
}

/**
 * Seed a light account (see seedLightAccount) whose memo key derives from
 * `mnemonic`. `username` must be lowercase: the recover form lowercases what
 * is typed before deriving.
 */
export async function seedRecoverableAccount(pool, { username, email, mnemonic }) {
  const { memo } = await deriveAllKeys(mnemonic, username);
  const { ciphertext, iv } = encryptCustodyKey(username, memo.private);
  await seedLightAccount(pool, { username, email });
  await pool.query(
    'UPDATE accounts SET memo_key_enc = $1, iv_memo = $2 WHERE username = $3',
    [ciphertext, iv, username],
  );
}
