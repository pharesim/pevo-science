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
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { getAccreditedSet } from '../accreditation.js';
import { getVouchStatus, broadcastWotAccreditation, vouchStatusCacheKey, type VouchStatus } from '../wot.js';
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
 *
 * Timeout path: when the vouch never surfaces within the cap, the final
 * iteration re-caches the pre-vouch status with a fresh 60s TTL. The operative
 * mitigation for that re-cached staleness is the block-watcher's clearVolatile
 * flushing volatile keys on each ~3s block tick (so the stale window only
 * persists if the block-watcher stalls). `capMs` bounds the sleeps BETWEEN
 * reads, not the total wall-clock — worst case is roughly `capMs` plus one
 * statement_timeout-bounded HAF read.
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
    await hafCache.invalidate(vouchStatusCacheKey(vouchee));
    status = await getVouchStatus(vouchee);
    if (status?.vouches.some((v) => v.voucher === voucher)) return status;
    if (Date.now() + intervalMs >= deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Retract-path counterpart to `pollForVouch`: bust the cached vouch status and
 * poll HAF until the retracting `voucher`'s edge to `vouchee` has DISAPPEARED
 * (the retraction is reflected on-chain), or the cap elapses. Returns the
 * freshest status seen (null if HAF is unavailable; the still-vouched status on
 * timeout). The caller treats "voucher still present on the final read" as an
 * unverified retraction and does NOT revoke — acting on an unverified retraction
 * would let an accredited voucher revoke a victim's accreditation by claiming a
 * retraction they never broadcast. Same bust-before-read discipline and
 * injectable cap/interval as `pollForVouch`.
 */
export async function pollForRetraction(
  vouchee: string,
  voucher: string,
  opts: { capMs?: number; intervalMs?: number } = {},
): Promise<VouchStatus | null> {
  const capMs = opts.capMs ?? VOUCH_POLL_CAP_MS;
  const intervalMs = opts.intervalMs ?? VOUCH_POLL_INTERVAL_MS;
  const deadline = Date.now() + capMs;

  let status: VouchStatus | null = null;
  for (;;) {
    await hafCache.invalidate(vouchStatusCacheKey(vouchee));
    status = await getVouchStatus(vouchee);
    if (status && !status.vouches.some((v) => v.voucher === voucher)) return status;
    if (Date.now() + intervalMs >= deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Per-account write limiter for the vouch/retract endpoints. Both trigger an
// admin broadcast (auto-accredit / revoke); the app-level mount applies only
// the byIp read limiter, so this byAccount layer (placed AFTER
// verifyHiveSignature, which sets req.hiveUsername) bounds how fast one
// accredited account can drive admin broadcasts — defense-in-depth around the
// retraction-verification gate.
const wotWriteLimiter = rateLimit({ name: 'wot-write', windowMs: 60_000, max: 10, keyFn: byAccount });

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

router.post('/vouch', verifyHiveSignature, wotWriteLimiter, async (req: Request, res: Response) => {
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
  // reason === 'sanctioned' is DELIBERATELY collapsed into this same generic
  // response: surfacing it would disclose the vouchee's authority-sanction state
  // to a third-party voucher (a moderation-privacy leak). The voucher learns only
  // that the vouch was recorded and the vouchee is not auto-accredited; the
  // sanction (and its lift, a deliberate admin accredit) is not the voucher's
  // concern. A test pins this collapse.
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

router.post('/retract', verifyHiveSignature, wotWriteLimiter, async (req: Request, res: Response) => {
  const { vouchee } = req.body;
  const voucher = req.hiveUsername!;

  if (!vouchee || typeof vouchee !== 'string' || vouchee.length > 50) {
    return sendError(res, 400, 'BAD_REQUEST', 'vouchee is required and must be a valid Hive username');
  }

  if (voucher === vouchee) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Cannot retract a vouch for yourself');
  }

  // Only accredited researchers participate in the Web of Trust (parity with
  // /vouch). Gating the signer also narrows who can reach the revocation path.
  const accreditedSet = await getAccreditedSet([voucher]);
  if (!accreditedSet.has(voucher)) {
    return sendError(res, 403, 'FORBIDDEN', 'Only accredited researchers can retract a vouch');
  }

  // The retract_vouch custom_json is broadcast by the frontend BEFORE this call.
  // WoT membership is LIVE: a vouchee that drops below the threshold loses
  // accreditation automatically (recomputed from the current vouch graph in
  // activeAccreditationsCteBody) with NO `revoke` op, and recovering vouches
  // restores it. So a retraction is a non-event here — there is nothing to
  // broadcast and no griefing vector to guard against (a fake retraction POST
  // can no longer plant a sticky revoke). We still poll HAF to bust the stale
  // vouch-status cache and return a fresh count for the UI.
  const status = await pollForRetraction(vouchee, voucher);
  const retractionReflected = status !== null && !status.vouches.some((v) => v.voucher === voucher);

  const message = retractionReflected
    ? `Retraction processed. ${vouchee}'s Web of Trust standing is evaluated live from the current vouch graph; no revocation is needed.`
    : `Retraction received. The withdrawn vouch for ${vouchee} is not yet reflected on-chain; ${vouchee}'s standing re-evaluates automatically once it is.`;

  sendOk(res, {
    message,
    revocation_outcome: 'none',
    revocations: [],
    vouch_status: status,
  });
});

export default router;
