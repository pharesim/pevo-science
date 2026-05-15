import { PrivateKey, cryptoUtils } from '@hiveio/dhive';
import { config } from '../../src/config.js';

/**
 * Produce a request-bound Hive signature for the test harness.
 *
 * Mirrors the signing-message construction performed by `signRequest()` in
 * `frontend/src/lib/api.ts` (and verified server-side by `verifyHiveSignature`
 * in `backend/src/middleware/hive-auth.ts`): sha256 over
 * `${appTag}-auth|v1|${method}|${fullPath}|${bodyHash}|${timestamp}` where
 * `bodyHash` is sha256-hex of `JSON.stringify(body || {})`.
 *
 * Extracted from per-file copies in `auth.test.ts` and `signup-verify.test.ts`
 * (BE-LOG-PII-EMAIL-HASH round-2 hold item 3 — maintainability MAINT M1).
 * Both files bound a private key via closure; the shared helper takes the key
 * as an explicit parameter so any future signing-protocol change is applied
 * once.
 */
export function signRequestBound(
  privateKey: PrivateKey,
  method: string,
  fullPath: string,
  body: unknown,
  timestamp: string,
): string {
  const bodyHash = cryptoUtils.sha256(JSON.stringify(body || {})).toString('hex');
  const msg = `${config.appTag}-auth|v1|${method}|${fullPath}|${bodyHash}|${timestamp}`;
  const msgHash = cryptoUtils.sha256(msg);
  return privateKey.sign(msgHash).toString();
}
