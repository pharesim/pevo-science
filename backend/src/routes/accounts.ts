import { Router, type Request, type Response } from 'express';
import { hiveClient } from '../hive.js';
import { getAccreditedSet } from '../accreditation.js';
import { sendOk, sendError } from '../response.js';

const router = Router();

// ──────────────────────────────────────────────
// GET /api/accounts/search
// ──────────────────────────────────────────────

router.get('/search', async (req: Request, res: Response) => {
  const raw = req.query.q;
  if (typeof raw !== 'string' || raw.length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'Query parameter "q" is required');
  }

  // Sanitize: lowercase, strip invalid Hive username characters
  const q = raw.toLowerCase().replace(/[^a-z0-9.\-]/g, '');

  if (q.length < 2) {
    return sendError(res, 400, 'BAD_REQUEST', 'Query must be at least 2 characters');
  }
  if (q.length > 16) {
    return sendError(res, 400, 'BAD_REQUEST', 'Query must be at most 16 characters');
  }

  const limitRaw = parseInt(req.query.limit as string, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 10) : 5;

  try {
    const usernames: string[] = await hiveClient.database.call('lookup_accounts', [q, limit]);

    const accreditedSet = usernames.length > 0
      ? await getAccreditedSet(usernames)
      : new Set<string>();

    const accounts = usernames.map((username) => ({
      username,
      is_accredited: accreditedSet.has(username),
    }));

    sendOk(res, { accounts });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', 'Account search failed');
  }
});

export default router;
