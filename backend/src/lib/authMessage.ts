import { cryptoUtils } from '@hiveio/dhive';

/**
 * Assembles the canonical request-bound auth message that both the frontend
 * (signMessage via Keychain) and the backend (verifyHiveSignature middleware)
 * must agree on byte-for-byte.
 *
 * Format: `{appTag}-auth|v1|{METHOD}|{path}|{sha256_hex(body)}|{timestamp}`
 *
 * - `body` is serialized as `JSON.stringify(body ?? {})` in all cases (GET included),
 *   matching frontend/src/sign-request.js. This keeps the canonical string defined
 *   for bodyless requests without special-casing the method.
 * - `path` is the request path with any query string stripped by the caller
 *   (the middleware strips it from `req.originalUrl`; frontends pass the path
 *   they intend to sign). Query strings are never part of the signed payload.
 * - `timestamp` is embedded verbatim; callers pass the same string they send
 *   in the `X-Hive-Timestamp` header.
 *
 * Frontend callers (e.g. TEST-003 equivalence test) import this from
 * `backend/src/lib/authMessage.ts` so both sides drive from the same source.
 */
export function buildCanonicalAuthMessage(input: {
  appTag: string;
  method: string;
  path: string;
  body: unknown;
  timestamp: number | string;
}): string {
  const bodyHash = cryptoUtils.sha256(JSON.stringify(input.body ?? {})).toString('hex');
  return `${input.appTag}-auth|v1|${input.method}|${input.path}|${bodyHash}|${input.timestamp}`;
}
