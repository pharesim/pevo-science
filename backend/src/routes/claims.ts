import { Router, type Request, type Response } from 'express';
import { getPool } from '../db.js';
import { broadcastAdminCustomJson, broadcastJsonWithTimeout } from '../hive.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { getAccreditedSet } from '../accreditation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { assertBridgeKeyConfigured } from './bridge.js';
import { getRequiredBridgePostingKey } from '../startup-checks.js';
import {
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  buildRecursiveWith,
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
    const cte = buildRecursiveWith(1,
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

/**
 * Returns true iff `candidate` has an accepted authorship claim on
 * (paperAuthor, paperPermlink). Used to authorize approved co-authors to
 * co-sign approvals of additional claimants on bridge papers.
 *
 * Note: the HAF CTE's status values are 'accepted' / 'pending' / 'revoked'
 * (see `authorshipClaimsCteBody` in src/hafsql.ts). "Approved" in product
 * language maps to `status = 'accepted'` in the schema.
 *
 * Fails closed: if HAF is unavailable or the query errors, returns false.
 * That's the safe default. An unavailable data source must not be treated
 * as positive authorization to trigger a bridge-key broadcast.
 */
async function isApprovedCoAuthor(
  paperAuthor: string,
  paperPermlink: string,
  candidate: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  try {
    const cte = buildRecursiveWith(1,
      activeAccreditationsCteBody,
      (idx) => authorshipClaimsCteBody(idx, { paperAuthor, paperPermlink }),
    );

    // JOIN active_accreditations so a co-author whose accreditation was later
    // revoked loses the ability to co-sign approvals. Without the JOIN, the
    // accepted-claim row on HAF is immutable and would grant co-signing
    // authority in perpetuity, contradicting the trust-layer revocation model.
    const result = await pool.query(
      `${cte.sql}
       SELECT 1
       FROM authorship_claims ac
       JOIN active_accreditations a ON a.account = ac.claimer
       WHERE ac.paper_author = $${cte.nextIdx}
         AND ac.paper_permlink = $${cte.nextIdx + 1}
         AND ac.claimer = $${cte.nextIdx + 2}
         AND ac.status = 'accepted'
       LIMIT 1`,
      [...cte.params, paperAuthor, paperPermlink, candidate],
    );

    return result.rows.length > 0;
  } catch (err) {
    logger.error({ err }, 'HAF approved-co-author check failed — denying authorization');
    return false;
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

  // Distinct misconfiguration surface: bridge paper but bridge posting key
  // unconfigured. Without this guard, control falls through to the native-paper
  // branch and returns "Only the post author can approve claims on native
  // papers" — misleading for operators debugging the misconfig.
  if (paperAuthor === config.hiveBridgeAccount && !assertBridgeKeyConfigured(res)) {
    return;
  }

  // Bridge papers: server broadcasts with bridge account key, but only after
  // caller-identity authorization. Bridge papers have no human post-author,
  // so the platform admin bootstraps the first approved claim, and approved
  // co-authors of the same paper may then vouch for additional claimants.
  // Self-approval by the claimer is disallowed. That would collapse the gate.
  if (paperAuthor === config.hiveBridgeAccount && config.pevoBridgePostingKey) {
    if (username === claimer) {
      return sendError(res, 403, 'FORBIDDEN', 'Claimer cannot approve their own claim');
    }
    const isApprovalAuthority =
      username === config.hiveAdminAccount ||
      await isApprovedCoAuthor(paperAuthor, paperPermlink, username);
    if (!isApprovalAuthority) {
      return sendError(res, 403, 'FORBIDDEN', 'Only the platform admin or an approved co-author can approve claims on bridge papers');
    }

    // Boot-cached key; see getRequiredBridgePostingKey() docstring in startup-checks.ts.
    const key = getRequiredBridgePostingKey();
    try {
      const result = await broadcastJsonWithTimeout(
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
    } catch (err) {
      return handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting authorship approval timed out',
        failMsg: 'Failed to broadcast authorship approval to Hive',
        logContext: { paperAuthor, paperPermlink, claimer, username },
        routeLabel: 'claims.approve',
      });
    }
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

  // Authorization: post author, admin, or claimer themselves. Note that
  // `paperAuthor === config.hiveBridgeAccount` (a property of the paper, not
  // the caller) is deliberately NOT part of this gate. Including it would mean
  // every authenticated user could revoke any claim on any bridge paper, since
  // the bridge account is never a human caller.
  const isPostAuthor = username === paperAuthor;
  const isClaimer = username === claimer;
  const isAdmin = username === config.hiveAdminAccount;

  if (!isPostAuthor && !isClaimer && !isAdmin) {
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

  // Bridge-key broadcast: only when the platform admin is revoking on a
  // bridge paper. A claimer revoking their own claim on a bridge paper falls
  // through to the client-signed return-operation path below. We never burn
  // the bridge key on a user-driven revoke.
  //
  // The `assertBridgeKeyConfigured` guard sits INSIDE this admin-on-bridge
  // branch (not above it) so the bridge-misconfig 503 fires only when the
  // server actually needs to broadcast with the bridge key. A claimer self-
  // revoking on a bridge paper with `pevoBridgePostingKey` unset must reach
  // the client-signed path below and get 200, not a misleading 503. Parallels
  // the guard in the approve handler — operators debugging a missing
  // `PEVO_BRIDGE_POSTING_KEY` get SERVICE_UNAVAILABLE instead of silent fall-
  // through to the admin-native branch (which would broadcast under the wrong
  // signing identity for a bridge paper).
  if (paperAuthor === config.hiveBridgeAccount && isAdmin) {
    if (!assertBridgeKeyConfigured(res)) return;
    // Boot-cached key; see getRequiredBridgePostingKey() docstring in startup-checks.ts.
    const key = getRequiredBridgePostingKey();
    try {
      const result = await broadcastJsonWithTimeout(
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
    } catch (err) {
      return handleBroadcastError(res, err, {
        // 504 message is intentionally identical to the admin-on-native branch
        // below: both paths revoke the same authorship `custom_json`, only the
        // signing key differs. The `signer:'bridge'|'admin'` field in the
        // structured log discriminates for operators; the user-facing message
        // does not need to.
        timeoutMsg: 'Broadcasting authorship revocation timed out',
        failMsg: 'Failed to broadcast authorship revocation to Hive',
        logContext: { paperAuthor, paperPermlink, claimer, username, signer: 'bridge' },
        routeLabel: 'claims.revoke bridge',
      });
    }
  }

  if (isAdmin && config.pevoAdminPostingKey) {
    // Admin revokes on native papers broadcast under the admin account's
    // posting auths — the resulting chain op is visibly signed by admin, NOT
    // by the original paper author. Consumers who audit `revoke_authorship`
    // ops should treat the `required_posting_auths[0]` as the revoker, not
    // the paper author.
    try {
      // Authority attribution: the admin-signed op records the acting admin.
      const result = await broadcastAdminCustomJson({ ...payload, issued_by: username });
      await hafCache.invalidate(`claims:${paperAuthor}:${paperPermlink}`);
      return sendOk(res, { message: 'Authorship claim revoked', tx_id: result.id });
    } catch (err) {
      return handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting authorship revocation timed out',
        failMsg: 'Failed to broadcast authorship revocation to Hive',
        logContext: { paperAuthor, paperPermlink, claimer, username, signer: 'admin' },
        routeLabel: 'claims.revoke admin',
      });
    }
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
