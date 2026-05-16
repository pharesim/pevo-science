/**
 * Mock signature verification middleware for tests.
 *
 * Extracts X-Hive-Username from the request header and sets req.hiveUsername.
 * Returns 401 if the header is missing (same behavior as the real middleware).
 *
 * Also mirrors the real middleware's `req.hiveAuthMethod` discriminator
 * (BACKEND-VERIFYHIVE-AUTHMETHOD-DISCRIMINATOR): the field is set to `'jwt'`
 * when the request carries `Authorization: Bearer ...`, otherwise `'signature'`.
 * Cryptographic verification of the Bearer token is bypassed (that's the
 * carve-out point of this fixture), but the discriminator's wire-shape gate
 * is reproduced so route handlers that consume `req.hiveAuthMethod` (e.g.,
 * the change-email branch of POST `/api/settings/email`) see the same value
 * they would under real verification.
 *
 * `req.hiveCustody` is populated from the JWT's `custody` claim on the JWT
 * path (decoded WITHOUT signature verification — that's the bypassed leg of
 * this fixture) and defaults to `'self'` otherwise. Routes that gate on
 * custody (e.g., POST `/api/custody/fresh-auth` requires `'light'`) see the
 * same value they would under the real middleware.
 *
 * Usage:
 *   import { MOCK_VERIFY_SIGNATURE } from '../fixtures/mock-auth.js';
 *
 *   vi.mock('../../src/middleware/verifyHiveSignature.js', () => MOCK_VERIFY_SIGNATURE);
 */

function decodeJwtCustodyClaim(authHeader: string | undefined): 'light' | 'self' {
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return 'self';
  }
  const token = authHeader.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) return 'self';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload?.custody === 'light' ? 'light' : 'self';
  } catch {
    return 'self';
  }
}

export const MOCK_VERIFY_SIGNATURE = {
  verifyHiveSignature: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    const headers = req.headers as Record<string, string> | undefined;
    const username = headers?.['x-hive-username'];
    if (!username) {
      const res = _res as { status: (n: number) => { json: (b: unknown) => void } };
      return res.status(401).json({
        status: 'error',
        error: { code: 'UNAUTHORIZED', message: 'X-Hive-Username and X-Hive-Signature headers are required' },
      });
    }
    req.hiveUsername = username;
    const authHeader = headers?.['authorization'];
    req.hiveAuthMethod =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? 'jwt' : 'signature';
    req.hiveCustody = decodeJwtCustodyClaim(authHeader);
    next();
  },
};
