/**
 * Web of Trust routes.
 *
 * GET  /api/wot/:username         — vouch status for a user
 * POST /api/wot/vouch             — process a vouch (called after custom_json is broadcast)
 * POST /api/wot/retract           — process a vouch retraction
 */
import { Router, type Request, type Response } from 'express';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { getAccreditedSet } from '../accreditation.js';
import { getVouchStatus, broadcastWotAccreditation, cascadeRevocation, PartialCascadeError } from '../wot.js';
import { logger } from '../logger.js';
import { isHafAvailable } from '../db.js';

const router = Router();

// ──────────────────────────────────────────────
// GET /api/wot/:username — vouch status
// ──────────────────────────────────────────────

router.get('/:username', async (req: Request, res: Response) => {
  const username = req.params.username as string;

  if (!isHafAvailable()) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'HAF database required for WoT queries');
  }

  const status = await getVouchStatus(username);
  if (!status) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch vouch status');
  }

  sendOk(res, status);
});

// ──────────────────────────────────────────────
// POST /api/wot/vouch — process a new vouch
// ──────────────────────────────────────────────
// Called by the frontend after the voucher broadcasts the vouch custom_json
// via Hive Keychain. The backend then checks if the vouchee has reached the
// WoT threshold and auto-accredits if so.

router.post('/vouch', verifyHiveSignature, async (req: Request, res: Response) => {
  const { vouchee } = req.body;
  const voucher = req.hiveUsername!;

  if (!vouchee || typeof vouchee !== 'string' || vouchee.length > 50) {
    return sendError(res, 400, 'BAD_REQUEST', 'vouchee is required and must be a valid Hive username');
  }

  if (voucher === vouchee) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Cannot vouch for yourself');
  }

  // Verify voucher is accredited
  const accreditedSet = await getAccreditedSet([voucher]);
  if (!accreditedSet.has(voucher)) {
    return sendError(res, 403, 'FORBIDDEN', 'Only accredited researchers can vouch');
  }

  // Check if the vouchee now meets the threshold
  const accreditResult = await broadcastWotAccreditation(vouchee);
  const status = await getVouchStatus(vouchee);

  if (accreditResult.ok) {
    logger.info(
      { voucher, vouchee, txId: accreditResult.txId },
      'WoT accreditation triggered by vouch',
    );
    return sendOk(res, {
      message: `Vouch recorded. ${vouchee} has been auto-accredited via Web of Trust.`,
      accredited: true,
      tx_id: accreditResult.txId,
      vouch_status: status,
    });
  }

  if (accreditResult.reason === 'timeout') {
    // Broadcast may or may not have landed — surface a degraded-state warning
    // rather than retry blindly (retry could land a duplicate accreditation).
    logger.error(
      { err: accreditResult.err, voucher, vouchee },
      'WoT accreditation broadcast timed out — outcome ambiguous',
    );
    return sendOk(res, {
      message:
        `Vouch recorded. Auto-accreditation broadcast for ${vouchee} is in a degraded state ` +
        '(timeout). Please check on-chain status before re-attempting.',
      accredited: false,
      accreditation_outcome: 'timeout',
      tx_id: null,
      vouch_status: status,
    });
  }

  if (accreditResult.reason === 'chain_error') {
    return sendOk(res, {
      message: `Vouch recorded. Auto-accreditation broadcast for ${vouchee} failed.`,
      accredited: false,
      accreditation_outcome: 'chain_error',
      tx_id: null,
      vouch_status: status,
    });
  }

  // reason === 'skipped' — not eligible, already accredited, or admin key missing.
  sendOk(res, {
    message: `Vouch recorded. ${vouchee} has ${status?.vouch_count ?? 0}/${status?.threshold ?? 3} vouches.`,
    accredited: false,
    tx_id: null,
    vouch_status: status,
  });
});

// ──────────────────────────────────────────────
// POST /api/wot/retract — process a vouch retraction
// ──────────────────────────────────────────────

router.post('/retract', verifyHiveSignature, async (req: Request, res: Response) => {
  const { vouchee } = req.body;
  const voucher = req.hiveUsername!;

  if (!vouchee || typeof vouchee !== 'string' || vouchee.length > 50) {
    return sendError(res, 400, 'BAD_REQUEST', 'vouchee is required and must be a valid Hive username');
  }

  // Check for cascading revocations
  // The retract_vouch custom_json has already been broadcast by the frontend.
  // We check if the vouchee (and their downstream vouchees) should be revoked.
  let revokedTxIds: string[] = [];
  let partial: PartialCascadeError | null = null;
  try {
    revokedTxIds = await cascadeRevocation(voucher);
  } catch (err) {
    if (err instanceof PartialCascadeError) {
      partial = err;
      revokedTxIds = err.completed;
      logger.error(
        {
          voucher,
          completed: err.completed,
          pending: err.pending,
          rootRevocation: err.rootRevocation,
        },
        'WoT cascade revocation aborted on budget exhaustion — operator follow-up required',
      );
    } else {
      throw err;
    }
  }

  const status = await getVouchStatus(vouchee);

  const baseMessage = revokedTxIds.length > 0
    ? `Retraction processed. ${revokedTxIds.length} cascading revocation(s) broadcast.`
    : 'Retraction processed. No cascading revocations needed.';

  sendOk(res, {
    message: partial
      ? `${baseMessage} Aggregate budget exceeded — ${partial.pending.length} pending revocation(s) require manual follow-up.`
      : baseMessage,
    revocations: revokedTxIds,
    partial_cascade: partial
      ? { completed: partial.completed, pending: partial.pending, root_revocation: partial.rootRevocation }
      : null,
    vouch_status: status,
  });
});

export default router;
