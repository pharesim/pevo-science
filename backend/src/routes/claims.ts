import { Router, type Request, type Response } from 'express';
import { PrivateKey } from '@hiveio/dhive';
import { getPool } from '../db.js';
import { hiveClient } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { getAccreditedSet } from '../accreditation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import {
  T,
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  buildWith,
  getCachedGenesisBlock,
} from '../hafsql.js';

const router = Router({ mergeParams: true });

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/claims
// ──────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const paperAuthor = req.params.author as string;
  const paperPermlink = req.params.permlink as string;

  const cacheKey = `claims:${paperAuthor}:${paperPermlink}`;
  const data = await hafCache.getOrSet(cacheKey, async () => {
    return fetchClaimsFromHaf(paperAuthor, paperPermlink);
  }, 2 * 60_000, true);

  if (!data) return sendError(res, 503, 'INTERNAL_ERROR', 'HAF unavailable');
  sendOk(res, { claims: data });
});

async function fetchClaimsFromHaf(paperAuthor: string, paperPermlink: string) {
  const pool = getPool();
  if (!pool) return null;

  try {
    const cte = buildWith(1,
      activeAccreditationsCteBody,
      (idx) => authorshipClaimsCteBody(idx, { paperAuthor, paperPermlink }),
    );

    const result = await pool.query(
      `${cte.sql}
       SELECT claimer, paper_author, paper_permlink, author_index, status, claimed_at
       FROM authorship_claims
       WHERE paper_author = $${cte.nextIdx}
         AND paper_permlink = $${cte.nextIdx + 1}
         AND status != 'revoked'`,
      [...cte.params, paperAuthor, paperPermlink],
    );

    return result.rows;
  } catch (err) {
    logger.error({ err }, 'HAF claims query failed');
    return null;
  }
}

// ──────────────────────────────────────────────
// POST /api/papers/:author/:permlink/claim
// For light accounts: server-side broadcast of claim_authorship
// Keychain users broadcast directly from frontend
// ──────────────────────────────────────────────

const claimLimiter = rateLimit({ name: 'claim-authorship', windowMs: 60_000, max: 5, keyFn: byAccount });

router.post('/', verifyHiveSignature, claimLimiter, async (req: Request, res: Response) => {
  const username = req.hiveUsername!;
  const paperAuthor = req.params.author as string;
  const paperPermlink = req.params.permlink as string;
  const { author_index } = req.body as { author_index?: number | null };

  // Validate accreditation
  const accreditedSet = await getAccreditedSet([username]);
  if (!accreditedSet.has(username)) {
    return sendError(res, 403, 'FORBIDDEN', 'Only accredited users can claim authorship');
  }

  // Validate author_index
  if (author_index !== null && author_index !== undefined) {
    if (!Number.isInteger(author_index) || author_index < 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'author_index must be a non-negative integer or null');
    }
  }

  // Build the custom_json payload — the frontend will broadcast for Keychain users
  const payload = {
    action: 'claim_authorship',
    paper_author: paperAuthor,
    paper_permlink: paperPermlink,
    author_index: author_index ?? null,
    timestamp: new Date().toISOString(),
  };

  // Return the payload for the frontend to broadcast via Keychain
  // Light account users will use the custody endpoint to broadcast
  sendOk(res, {
    operation: ['custom_json', {
      id: config.appTag,
      json: JSON.stringify(payload),
      required_auths: [],
      required_posting_auths: [username],
    }],
    message: 'Broadcast this operation to claim authorship',
  });
});

// ──────────────────────────────────────────────
// POST /api/papers/:author/:permlink/claims/:claimer/approve
// For bridge papers: server signs with bridge account key
// For native papers: returns operation for frontend to broadcast
// ──────────────────────────────────────────────

const approveLimiter = rateLimit({ name: 'approve-authorship', windowMs: 60_000, max: 10, keyFn: byAccount });

router.post('/:claimer/approve', verifyHiveSignature, approveLimiter, async (req: Request, res: Response) => {
  const username = req.hiveUsername!;
  const paperAuthor = req.params.author as string;
  const paperPermlink = req.params.permlink as string;
  const claimer = req.params.claimer as string;
  const { author_index } = req.body as { author_index?: number | null };

  const payload = {
    action: 'approve_authorship',
    claimer,
    paper_author: paperAuthor,
    paper_permlink: paperPermlink,
    author_index: author_index ?? null,
    timestamp: new Date().toISOString(),
  };

  // Bridge papers: server broadcasts with bridge account key
  if (paperAuthor === config.hiveBridgeAccount && config.pevoBridgePostingKey) {
    const key = PrivateKey.fromString(config.pevoBridgePostingKey);
    const result = await hiveClient.broadcast.json(
      {
        id: config.appTag,
        json: JSON.stringify(payload),
        required_auths: [],
        required_posting_auths: [config.hiveBridgeAccount],
      },
      key,
    );

    // Invalidate claims cache
    await hafCache.invalidate(`claims:${paperAuthor}:${paperPermlink}`);

    return sendOk(res, {
      message: 'Authorship claim approved',
      tx_id: result.id,
    });
  }

  // Native papers: only the post author can approve
  if (username !== paperAuthor) {
    return sendError(res, 403, 'FORBIDDEN', 'Only the post author can approve claims on native papers');
  }

  // Return operation for frontend to broadcast via Keychain or custody
  sendOk(res, {
    operation: ['custom_json', {
      id: config.appTag,
      json: JSON.stringify(payload),
      required_auths: [],
      required_posting_auths: [username],
    }],
    message: 'Broadcast this operation to approve the authorship claim',
  });
});

// ──────────────────────────────────────────────
// POST /api/papers/:author/:permlink/claims/:claimer/revoke
// ──────────────────────────────────────────────

const revokeLimiter = rateLimit({ name: 'revoke-authorship', windowMs: 60_000, max: 10, keyFn: byAccount });

router.post('/:claimer/revoke', verifyHiveSignature, revokeLimiter, async (req: Request, res: Response) => {
  const username = req.hiveUsername!;
  const paperAuthor = req.params.author as string;
  const paperPermlink = req.params.permlink as string;
  const claimer = req.params.claimer as string;
  const { reason } = req.body as { reason?: string };

  // Authorization: post author, bridge account, admin, or claimer themselves
  const isPostAuthor = username === paperAuthor;
  const isClaimer = username === claimer;
  const isAdmin = username === config.hiveAdminAccount;
  const isBridgeAdmin = paperAuthor === config.hiveBridgeAccount;

  if (!isPostAuthor && !isClaimer && !isAdmin && !isBridgeAdmin) {
    return sendError(res, 403, 'FORBIDDEN', 'Not authorized to revoke this claim');
  }

  const payload = {
    action: 'revoke_authorship',
    claimer,
    paper_author: paperAuthor,
    paper_permlink: paperPermlink,
    reason: reason || 'Revoked',
    timestamp: new Date().toISOString(),
  };

  // Bridge papers or admin: server broadcasts
  if (isBridgeAdmin && config.pevoBridgePostingKey) {
    const key = PrivateKey.fromString(config.pevoBridgePostingKey);
    const result = await hiveClient.broadcast.json(
      {
        id: config.appTag,
        json: JSON.stringify(payload),
        required_auths: [],
        required_posting_auths: [config.hiveBridgeAccount],
      },
      key,
    );
    await hafCache.invalidate(`claims:${paperAuthor}:${paperPermlink}`);
    return sendOk(res, { message: 'Authorship claim revoked', tx_id: result.id });
  }

  if (isAdmin && config.pevoAdminPostingKey) {
    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    const result = await hiveClient.broadcast.json(
      {
        id: config.appTag,
        json: JSON.stringify(payload),
        required_auths: [],
        required_posting_auths: [config.hiveAdminAccount],
      },
      key,
    );
    await hafCache.invalidate(`claims:${paperAuthor}:${paperPermlink}`);
    return sendOk(res, { message: 'Authorship claim revoked', tx_id: result.id });
  }

  // Post author or claimer: return operation for frontend to broadcast
  sendOk(res, {
    operation: ['custom_json', {
      id: config.appTag,
      json: JSON.stringify(payload),
      required_auths: [],
      required_posting_auths: [username],
    }],
    message: 'Broadcast this operation to revoke the authorship claim',
  });
});

export default router;
