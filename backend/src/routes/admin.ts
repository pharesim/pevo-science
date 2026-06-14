import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import {
  validate,
  accreditationVerifySchema,
  adminRosterGrantSchema,
  adminRosterRevokeSchema,
  adminAccreditationGrantSchema,
  adminSanctionSchema,
  adminRetractPaperSchema,
  adminAuthorshipRevokeSchema,
  adminAuthorshipApproveSchema,
} from '../validation.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { logger } from '../logger.js';
import { hashTokenForLogs } from '../lib/log-pii.js';
import { broadcastAttemptsKey } from './accreditation.js';
import {
  requireAdminLevel,
  requireFreshAdminAuth,
  getAdminLevel,
  levelMeets,
  getAdminRosterDetailed,
  bustAdminRosterCache,
} from '../admin-roster.js';
import { invalidateOnRevocation } from '../reputation.js';
import { broadcastAdminCustomJson, broadcastJsonWithTimeout } from '../hive.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';
import { hafCache } from '../cache.js';
import { getRequiredBridgePostingKey } from '../startup-checks.js';
import { assertBridgeKeyConfigured } from './bridge.js';

const router = Router();

// ──────────────────────────────────────────────
// POST /api/admin/accreditation/reset-broadcast-counter
//
// Operator manual-reset lever: clears an inflated `/api/accreditation/verify`
// broadcast-attempts counter when the in-process pending-decrement queue
// cannot converge (process restart between flap and drain, 24h TTL expiry,
// or queue overflow), or when a user reports persistent
// BROADCAST_ATTEMPT_LIMIT_EXCEEDED despite no actual broadcast having fired.
//
// Auth: admin Hive signature against `config.hiveAdminAccount` (singular).
// ──────────────────────────────────────────────

router.post(
  '/accreditation/reset-broadcast-counter',
  verifyHiveSignature,
  validate(accreditationVerifySchema),
  async (
    req: Request<Record<string, string>, unknown, z.infer<typeof accreditationVerifySchema>>,
    res: Response,
  ) => {
    const username = req.hiveUsername!;
    if (username !== config.hiveAdminAccount) {
      // Hash the would-be target token before logging so an unauthorized
      // probe doesn't leak the plaintext token to operator logs.
      logger.warn(
        {
          event: 'accreditation.admin.reset_broadcast_counter_forbidden',
          attempted_by: username,
          token_hash: hashTokenForLogs(req.body.token),
        },
        'admin reset-broadcast-counter rejected — caller is not the configured admin account',
      );
      return sendError(res, 403, 'FORBIDDEN', `Only ${config.hiveAdminAccount} can reset broadcast counters`);
    }

    const token = req.body.token;
    const key = broadcastAttemptsKey(token);
    const redis = getRedis();

    if (!redis || !isRedisAvailable()) {
      // Without Redis there is no counter key to delete; the in-memory
      // fallback is per-process and the operator likely doesn't know
      // which container holds the inflated counter. Surface 503 so the
      // operator can retry once Redis is back, matching the auto-recovery
      // queue's same-fail-open semantics. Pair the body's `retriable:true`
      // with a `Retry-After: 30` header to match the sibling /verify 503
      // paths' floor — SPAs read the header to schedule backoff.
      logger.warn(
        {
          event: 'accreditation.admin.reset_broadcast_counter_redis_unavailable',
          admin_username: username,
          token_hash: hashTokenForLogs(token),
        },
        'admin reset-broadcast-counter: Redis unavailable; counter unchanged',
      );
      res.set('Retry-After', '30');
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Redis unavailable; counter unchanged. Retry once Redis recovers, or wait for the 24h TTL.',
        { retriable: true },
      );
    }

    let priorValue: number | null = null;
    try {
      // Atomic GETDEL (Redis 6.2+) reads + deletes in a single command so the
      // `prior_value` returned to the operator matches the value that was
      // actually cleared, even if a concurrent /verify INCR lands between
      // the read and the delete.
      const raw = await redis.getdel(key);
      priorValue = raw === null ? null : Number(raw);
    } catch (err) {
      logger.error(
        {
          err,
          event: 'accreditation.admin.reset_broadcast_counter_failed',
          admin_username: username,
          token_hash: hashTokenForLogs(token),
        },
        'admin reset-broadcast-counter failed',
      );
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to reset broadcast counter');
    }

    // Operator audit trail: every reset is logged with admin account, hashed
    // token, prior counter value (null if the counter was already absent),
    // and a timestamp injected by pino.
    logger.info(
      {
        event: 'accreditation.admin.reset_broadcast_counter',
        admin_username: username,
        token_hash: hashTokenForLogs(token),
        prior_value: priorValue,
      },
      'admin reset broadcast counter',
    );

    sendOk(res, {
      token_hash: hashTokenForLogs(token),
      prior_value: priorValue,
    });
  },
);

// ──────────────────────────────────────────────────────────────────
// Admin console: roster management + authority actions.
//
// Every route below is roster-gated (`requireAdminLevel`) AND fresh-re-auth
// gated (`requireFreshAdminAuth`) — two independent gates per ARCHITECTURE.md
// §6.4 / §6.5 invariant #1, so a stolen admin JWT alone cannot broadcast an
// authority op. The single `pevo.admin` key signs the ops (the roster is the
// human-authorization layer in front of it, NOT a widening of the signer).
// Middleware order is verifyHiveSignature -> requireAdminLevel -> validate ->
// requireFreshAdminAuth so a malformed body 400s before the caller's single-use
// fresh-auth proof is consumed. These are distinct from the self-service
// user-signed routes (author self-retract in papers.ts, peer approve/revoke in
// claims.ts), which keep their own identity-based authorization.
// ──────────────────────────────────────────────────────────────────

// GET /api/admin/roster — viewer tier + the chain-derived roster. Returns
// `tier: null` (200, not 403) for non-roster callers so the SPA renders a
// not-authorized state rather than bouncing. The roster list is disclosed only
// to roster members (admin+); non-members get an empty list with their null tier.
router.get('/roster', verifyHiveSignature, async (req: Request, res: Response) => {
  const username = req.hiveUsername!;
  const tier = await getAdminLevel(username);
  if (tier === null) {
    return sendOk(res, { tier: null, roster: [] });
  }
  try {
    const roster = await getAdminRosterDetailed();
    sendOk(res, { tier, roster });
  } catch (err) {
    logger.error({ err, event: 'admin.roster.read_failed', username }, 'admin roster detailed read failed');
    res.set('Retry-After', '30');
    sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Roster temporarily unavailable. Please retry shortly.', { retriable: true });
  }
});

// POST /api/admin/roster/grant — promote an account. super_admin may grant
// `admin`; only root may grant `super_admin`. Broadcasts `admin_grant` then busts
// the roster cache so the new tier is visible without waiting for the TTL.
router.post(
  '/roster/grant',
  verifyHiveSignature,
  requireAdminLevel('super_admin'),
  validate(adminRosterGrantSchema),
  requireFreshAdminAuth('admin_grant_role'),
  async (
    req: Request<Record<string, string>, unknown, z.infer<typeof adminRosterGrantSchema>>,
    res: Response,
  ) => {
    const actor = req.hiveUsername!;
    const { account, level } = req.body;
    if (level === 'super_admin' && req.adminLevel !== 'root') {
      return sendError(res, 403, 'FORBIDDEN', 'Only root can grant the super_admin level');
    }
    if (account === config.rootAdminAccount) {
      return sendError(res, 422, 'VALIDATION_ERROR', 'The root account holds authority from bootstrap config and cannot be granted a chain level');
    }
    const payload = {
      action: 'admin_grant',
      account,
      level,
      issued_by: actor,
      timestamp: new Date().toISOString(),
    };
    try {
      const result = await broadcastAdminCustomJson(payload);
      await bustAdminRosterCache();
      logger.info({ event: 'admin.roster.grant', actor, account, level, tx_id: result.id }, 'admin roster grant');
      sendOk(res, { message: `Granted ${level} to ${account}`, tx_id: result.id });
    } catch (err) {
      const outcome = handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting the role grant timed out',
        failMsg: 'Failed to broadcast the role grant',
        logContext: { username: actor },
        routeLabel: 'admin.roster.grant',
      });
      // Timeout is ambiguous (the op may have landed): bust so a landed grant
      // becomes visible. A definite failure leaves the cache untouched.
      if (outcome === 'timeout') await bustAdminRosterCache();
    }
  },
);

// POST /api/admin/roster/revoke — demote an account. The tier required is keyed
// off the TARGET's current level: super_admin may demote an `admin`; only root
// may demote a `super_admin`. Lockout-safe: root is never demotable (bootstrap
// config), and an admin cannot demote themselves out of the capability in use.
router.post(
  '/roster/revoke',
  verifyHiveSignature,
  requireAdminLevel('super_admin'),
  validate(adminRosterRevokeSchema),
  requireFreshAdminAuth('admin_revoke_role'),
  async (
    req: Request<Record<string, string>, unknown, z.infer<typeof adminRosterRevokeSchema>>,
    res: Response,
  ) => {
    const actor = req.hiveUsername!;
    const { account } = req.body;
    if (account === config.rootAdminAccount) {
      return sendError(res, 422, 'VALIDATION_ERROR', 'Root holds authority from bootstrap config and cannot be demoted');
    }
    if (account === actor) {
      return sendError(res, 422, 'VALIDATION_ERROR', 'You cannot demote yourself out of the capability you are using');
    }
    const targetLevel = await getAdminLevel(account);
    if (targetLevel === null) {
      return sendError(res, 422, 'VALIDATION_ERROR', 'Account is not in the admin roster');
    }
    if (targetLevel === 'root') {
      // Defensive: getAdminLevel only returns 'root' for the bootstrap config
      // account, already rejected above. Narrows targetLevel to a chain tier.
      return sendError(res, 422, 'VALIDATION_ERROR', 'Root cannot be demoted');
    }
    if (targetLevel === 'super_admin' && req.adminLevel !== 'root') {
      return sendError(res, 403, 'FORBIDDEN', 'Only root can demote a super_admin');
    }
    const payload = {
      action: 'admin_revoke',
      account,
      level: targetLevel,
      reason: 'Demoted via roster management',
      issued_by: actor,
      timestamp: new Date().toISOString(),
    };
    try {
      const result = await broadcastAdminCustomJson(payload);
      await bustAdminRosterCache();
      logger.info({ event: 'admin.roster.revoke', actor, account, level: targetLevel, tx_id: result.id }, 'admin roster revoke');
      sendOk(res, { message: `Revoked ${targetLevel} from ${account}`, tx_id: result.id });
    } catch (err) {
      const outcome = handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting the role revocation timed out',
        failMsg: 'Failed to broadcast the role revocation',
        logContext: { username: actor },
        routeLabel: 'admin.roster.revoke',
      });
      if (outcome === 'timeout') await bustAdminRosterCache();
    }
  },
);

// POST /api/admin/accreditation/grant — manual admin accreditation (admin tier).
// Broadcasts an admin-signed `accredit` op; the latest accredit op is
// authoritative for metadata, so this also serves as a re-grant that lifts a
// prior sanction. The reputation seed reconciles via the next batch cycle /
// boot-time backfill (mirrors the self-service accredit path, which also defers).
router.post(
  '/accreditation/grant',
  verifyHiveSignature,
  requireAdminLevel('admin'),
  validate(adminAccreditationGrantSchema),
  requireFreshAdminAuth('admin_grant_accreditation'),
  async (
    req: Request<Record<string, string>, unknown, z.infer<typeof adminAccreditationGrantSchema>>,
    res: Response,
  ) => {
    const actor = req.hiveUsername!;
    const { account, full_name, institution, field, method } = req.body;
    const payload = {
      action: 'accredit',
      account,
      name: full_name,
      institution,
      field,
      method,
      evidence_hash: '',
      issued_by: actor,
      timestamp: new Date().toISOString(),
    };
    try {
      const result = await broadcastAdminCustomJson(payload);
      logger.info({ event: 'admin.accreditation.grant', actor, account, method, tx_id: result.id }, 'admin accreditation grant');
      sendOk(res, { message: `Accreditation granted to ${account}`, tx_id: result.id });
    } catch (err) {
      handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting the accreditation timed out',
        failMsg: 'Failed to broadcast the accreditation',
        logContext: { username: actor },
        routeLabel: 'admin.accreditation.grant',
      });
    }
  },
);

// POST /api/admin/accreditation/sanction — authority sanction (admin tier).
// Broadcasts a `revoke` carrying `type:"sanction"`, which is STICKY: it
// suppresses accreditation regardless of vouch support and is lifted ONLY by a
// later authority `accredit` (POST /accreditation/grant). This is the only
// `revoke` the backend broadcasts — a WoT threshold drop is a self-healing
// live-membership non-event with no op.
//
// Membership-cache staleness: getAccreditedSet / getAllAccreditedAccounts read
// through the `accredited_accounts_all` STABLE cache (10-min TTL). clearVolatile
// (the block-watcher tick) does NOT flush it, and an immediate invalidate would
// be ineffective anyway (HAF must ingest the op first). So a sanctioned account
// can remain in the membership set for up to ~10 min — an accepted tradeoff,
// symmetric with grant-staleness. Reputation is cleared promptly below.
//
// Tier guard (mirrors the /roster/revoke ladder): a base `admin` may sanction
// non-admins only; the actor cannot sanction itself, the root account, or any
// account whose admin tier is at or above the actor's own.
router.post(
  '/accreditation/sanction',
  verifyHiveSignature,
  requireAdminLevel('admin'),
  validate(adminSanctionSchema),
  requireFreshAdminAuth('admin_sanction'),
  async (
    req: Request<Record<string, string>, unknown, z.infer<typeof adminSanctionSchema>>,
    res: Response,
  ) => {
    const actor = req.hiveUsername!;
    const { account, reason } = req.body;
    if (account === actor) {
      return sendError(res, 422, 'VALIDATION_ERROR', 'You cannot sanction yourself');
    }
    if (account === config.rootAdminAccount) {
      return sendError(res, 422, 'VALIDATION_ERROR', 'The root account cannot be sanctioned');
    }
    const targetLevel = await getAdminLevel(account);
    if (targetLevel !== null && levelMeets(targetLevel, req.adminLevel!)) {
      return sendError(res, 403, 'FORBIDDEN', 'You cannot sanction an account whose admin tier is at or above your own');
    }
    const payload = {
      action: 'revoke',
      type: 'sanction',
      account,
      reason,
      issued_by: actor,
      timestamp: new Date().toISOString(),
    };
    try {
      const result = await broadcastAdminCustomJson(payload);
      // Clear the sanctioned account's cached reputation so its displayed score
      // collapses to zero promptly rather than lingering until the next batch
      // cycle (the batch itself reads live membership). Best-effort: a failure
      // reconciles at the next cycle.
      await invalidateOnRevocation(account).catch((invErr) =>
        logger.warn({ err: invErr, account }, 'sanction reputation invalidate failed; reconciles next batch cycle'),
      );
      logger.info({ event: 'admin.accreditation.sanction', actor, account, tx_id: result.id }, 'admin accreditation sanction');
      sendOk(res, { message: `Accreditation sanctioned for ${account}`, tx_id: result.id });
    } catch (err) {
      handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting the sanction timed out',
        failMsg: 'Failed to broadcast the sanction',
        logContext: { username: actor },
        routeLabel: 'admin.accreditation.sanction',
      });
    }
  },
);

// POST /api/admin/papers/retract — authority retraction (admin tier). Distinct
// from the author's own self-service retract in papers.ts.
router.post(
  '/papers/retract',
  verifyHiveSignature,
  requireAdminLevel('admin'),
  validate(adminRetractPaperSchema),
  requireFreshAdminAuth('admin_retract_paper'),
  async (
    req: Request<Record<string, string>, unknown, z.infer<typeof adminRetractPaperSchema>>,
    res: Response,
  ) => {
    const actor = req.hiveUsername!;
    const { author, permlink, reason } = req.body;
    // Best-effort already-retracted guard via the shared retraction cache the
    // self-service path maintains. A cold cache reads null and falls through to
    // broadcast; a re-retract is harmless (latest-op-wins).
    const retracted = (await hafCache.get<Array<{ author: string; permlink: string }>>('retracted-papers')) ?? [];
    if (retracted.some((r) => r.author === author && r.permlink === permlink)) {
      return sendError(res, 422, 'VALIDATION_ERROR', 'Paper is already retracted');
    }
    const payload = {
      action: 'retract_paper',
      author,
      permlink,
      reason,
      issued_by: actor,
      timestamp: new Date().toISOString(),
    };
    try {
      const result = await broadcastAdminCustomJson(payload);
      void hafCache.invalidate('retracted-papers');
      logger.info({ event: 'admin.papers.retract', actor, author, permlink, tx_id: result.id }, 'admin paper retract');
      sendOk(res, { message: 'Paper retracted', tx_id: result.id });
    } catch (err) {
      handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting the retraction timed out',
        failMsg: 'Failed to broadcast the retraction',
        logContext: { username: actor, author, permlink },
        routeLabel: 'admin.papers.retract',
      });
    }
  },
);

// POST /api/admin/authorship/revoke — authority revoke of an authorship credit
// (admin tier), admin-signed (pevo.admin). Distinct from the self-service peer
// revoke in claims.ts.
router.post(
  '/authorship/revoke',
  verifyHiveSignature,
  requireAdminLevel('admin'),
  validate(adminAuthorshipRevokeSchema),
  requireFreshAdminAuth('admin_revoke_authorship'),
  async (
    req: Request<Record<string, string>, unknown, z.infer<typeof adminAuthorshipRevokeSchema>>,
    res: Response,
  ) => {
    const actor = req.hiveUsername!;
    const { author, permlink, claimer, reason } = req.body;
    const payload = {
      action: 'revoke_authorship',
      claimer,
      paper_author: author,
      paper_permlink: permlink,
      reason,
      issued_by: actor,
      timestamp: new Date().toISOString(),
    };
    try {
      const result = await broadcastAdminCustomJson(payload);
      void hafCache.invalidate(`claims:${author}:${permlink}`);
      logger.info({ event: 'admin.authorship.revoke', actor, author, permlink, claimer, tx_id: result.id }, 'admin authorship revoke');
      sendOk(res, { message: 'Authorship revoked', tx_id: result.id });
    } catch (err) {
      handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting the authorship revocation timed out',
        failMsg: 'Failed to broadcast the authorship revocation',
        logContext: { username: actor, author, permlink, claimer },
        routeLabel: 'admin.authorship.revoke',
      });
    }
  },
);

// POST /api/admin/authorship/approve — approve a bridged-paper author claim
// (admin tier). Bridge papers are authored by the bridge account and signed with
// the bridge key (NOT pevo.admin); issued_by still attributes the acting admin.
router.post(
  '/authorship/approve',
  verifyHiveSignature,
  requireAdminLevel('admin'),
  validate(adminAuthorshipApproveSchema),
  requireFreshAdminAuth('admin_approve_authorship'),
  async (
    req: Request<Record<string, string>, unknown, z.infer<typeof adminAuthorshipApproveSchema>>,
    res: Response,
  ) => {
    const actor = req.hiveUsername!;
    const { author, permlink, claimer, author_index } = req.body;
    if (author !== config.hiveBridgeAccount) {
      return sendError(res, 422, 'VALIDATION_ERROR', 'Admin approval applies to bridged papers only');
    }
    if (!assertBridgeKeyConfigured(res)) return;
    const key = getRequiredBridgePostingKey();
    const payload = {
      action: 'approve_authorship',
      claimer,
      paper_author: author,
      paper_permlink: permlink,
      author_index: author_index ?? null,
      issued_by: actor,
      timestamp: new Date().toISOString(),
    };
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
      void hafCache.invalidate(`claims:${author}:${permlink}`);
      logger.info({ event: 'admin.authorship.approve', actor, author, permlink, claimer, tx_id: result.id }, 'admin authorship approve');
      sendOk(res, { message: 'Authorship claim approved', tx_id: result.id });
    } catch (err) {
      handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting the authorship approval timed out',
        failMsg: 'Failed to broadcast the authorship approval',
        logContext: { username: actor, author, permlink, claimer },
        routeLabel: 'admin.authorship.approve',
      });
    }
  },
);

export default router;
