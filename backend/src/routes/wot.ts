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
import { getVouchStatus, broadcastWotAccreditation, cascadeRevocation, PartialCascadeError, type VouchStatus } from '../wot.js';
import { logger } from '../logger.js';
import { isHafConfigured } from '../db.js';
import { hafCache } from '../cache.js';

const router = Router();

// Vouch-status poll window. The vouch custom_json is broadcast by the frontend
// BEFORE /api/wot/vouch is called; HAF block-ingestion lags that broadcast by
// ~3s+, and a prior reader may have populated the 60s `getVouchStatus` cache
// with pre-vouch state. The cap is kept tight (~2 Hive blocks); on timeout the
// flow falls through to the existing skipped path.
const VOUCH_POLL_CAP_MS = 6_000;
const VOUCH_POLL_INTERVAL_MS = 1_500;

/**
 * Bust the cached vouch status for `vouchee` and poll HAF until the vouch from
 * `voucher` surfaces, or the cap elapses. Returns the freshest status seen
 * (null if HAF is unavailable, or a status still missing the vouch on timeout)
 * so the caller can run the threshold check and build the response from it.
 *
 * Each iteration invalidates the cache BEFORE reading: busting alone would
 * re-read still-lagging HAF and re-cache the stale answer; polling without
 * busting would re-read the just-populated cache. Both are required. The cap /
 * interval are injectable so the timing-sensitive paths can be exercised
 * deterministically without real-time sleeps.
 */
export async function pollForVouch(
  vouchee: string,
  voucher: string,
  opts: { capMs?: number; intervalMs?: number } = {},
): Promise<VouchStatus | null> {
  const capMs = opts.capMs ?? VOUCH_POLL_CAP_MS;
  const intervalMs = opts.intervalMs ?? VOUCH_POLL_INTERVAL_MS;
  const deadline = Date.now() + capMs;

  let status: VouchStatus | null = null;
  for (;;) {
    await hafCache.invalidate(`vouch_status:${vouchee}`);
    status = await getVouchStatus(vouchee);
    if (status?.vouches.some((v) => v.voucher === voucher)) return status;
    if (Date.now() + intervalMs >= deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ──────────────────────────────────────────────
// GET /api/wot/:username — vouch status
// ──────────────────────────────────────────────

router.get('/:username', async (req: Request, res: Response) => {
  const username = req.params.username as string;

  if (!isHafConfigured()) {
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

  // Bust the stale vouch-status cache and poll HAF for the just-broadcast
  // vouch before the threshold check, so an over-threshold vouch accredits in
  // this same request instead of waiting for the next vouch or the 60s cache
  // expiry (see pollForVouch). On timeout this returns the latest status and
  // the flow falls through to the existing skipped path. Reuse the polled
  // status for the response: broadcastWotAccreditation does not change the
  // vouch count, and its own getVouchStatus read hits the poll's fresh cache.
  const status = await pollForVouch(vouchee, voucher);

  // Check if the vouchee now meets the threshold
  const accreditResult = await broadcastWotAccreditation(vouchee);

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
    logger.error(
      { err: accreditResult.err, voucher, vouchee },
      'WoT accreditation broadcast chain error',
    );
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
