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
import { getVouchStatus, checkAndAccreditViaWot, cascadeRevocation } from '../wot.js';
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
  const txId = await checkAndAccreditViaWot(vouchee);
  const status = await getVouchStatus(vouchee);

  if (txId) {
    logger.info({ voucher, vouchee, txId }, 'WoT accreditation triggered by vouch');
  }

  sendOk(res, {
    message: txId
      ? `Vouch recorded. ${vouchee} has been auto-accredited via Web of Trust.`
      : `Vouch recorded. ${vouchee} has ${status?.vouch_count ?? 0}/${status?.threshold ?? 3} vouches.`,
    accredited: !!txId,
    tx_id: txId,
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
  const revokedTxIds = await cascadeRevocation(voucher);

  const status = await getVouchStatus(vouchee);

  sendOk(res, {
    message: revokedTxIds.length > 0
      ? `Retraction processed. ${revokedTxIds.length} cascading revocation(s) broadcast.`
      : 'Retraction processed. No cascading revocations needed.',
    revocations: revokedTxIds,
    vouch_status: status,
  });
});

export default router;
