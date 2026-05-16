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
 * Usage:
 *   import { MOCK_VERIFY_SIGNATURE } from '../fixtures/mock-auth.js';
 *
 *   vi.mock('../../src/middleware/verifyHiveSignature.js', () => MOCK_VERIFY_SIGNATURE);
 */

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
    next();
  },
};
