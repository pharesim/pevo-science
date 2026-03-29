/**
 * Mock signature verification middleware for tests.
 *
 * Extracts X-Hive-Username from the request header and sets req.hiveUsername.
 * Returns 401 if the header is missing (same behavior as the real middleware).
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
    next();
  },
};
