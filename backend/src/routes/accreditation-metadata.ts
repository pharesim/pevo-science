import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { config } from '../config.js';
import { broadcastAdminCustomJson } from '../hive.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate, accreditationMetadataEditSchema } from '../validation.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { getAccreditedSet, getLatestAccreditOp, hasUnliftedSanction, SANCTIONED_ACCREDIT_MESSAGE } from '../accreditation.js';
import { getAppPool } from '../app-db.js';
import { consumeFreshAuthProof, editAccreditationMetadataFreshAuthTarget } from '../lib/fresh-auth.js';
import { logger } from '../logger.js';

// Self-service accreditation metadata edit. Split out of routes/accreditation.ts
// because it shares none of that file's OTP / email-verify / token-cleanup
// machinery — it only re-broadcasts a merged admin-signed accredit op. Mounted
// under the same /api/accreditation prefix (composed into the main router).
const router = Router();

// Per-account write limiter for the metadata edit (each success triggers an
// admin-signed re-broadcast). Placed AFTER verifyHiveSignature so byAccount has
// req.hiveUsername; bounds how fast one account can drive accredit re-broadcasts.
const accreditationEditLimiter = rateLimit({ name: 'accred-edit', windowMs: 60_000, max: 5, keyFn: byAccount });

// ──────────────────────────────────────────────
// PATCH /api/accreditation/metadata — self-service metadata edit
// ──────────────────────────────────────────────
// An accredited account edits its own name/institution/field by re-broadcasting
// a merged admin-signed accredit op. Authorization is the caller's OWN current
// accreditation, NOT an admin roster level. Eligibility is checked in three
// steps before any proof is consumed or broadcast: (1) the latest accredit op
// loads (also the upstream HAF-reachability gate — a HAF outage here is a
// retriable 503, not a misleading 403); (2) currently-accredited membership via
// getAccreditedSet; (3) a non-cached hasUnliftedSanction check that closes the
// membership cache's staleness window so a freshly-sanctioned account cannot
// self-lift. Critical action per ARCHITECTURE.md §6.4 / §6.5 invariant #1: a
// fresh re-auth proof is required, NOT a JWT alone. The tenure anchor
// ("accredited since") is unaffected — it derives from the EARLIEST accredit
// op's block time, which this later re-broadcast does not move.
router.patch(
  '/metadata',
  verifyHiveSignature,
  validate(accreditationMetadataEditSchema),
  accreditationEditLimiter,
  async (
    req: Request<Record<string, string>, unknown, z.infer<typeof accreditationMetadataEditSchema>>,
    res: Response,
  ) => {
    const username = req.hiveUsername;
    if (!username) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required to edit accreditation metadata');
    }

    // Load the current accredit op FIRST. It is BOTH the merge source AND the
    // upstream HAF-reachability gate. Reading it before consuming the single-use
    // fresh-auth proof means a transient HAF read failure surfaces as a retriable
    // 503 with the proof NOT burned. getLatestAccreditOp THROWS on a HAF outage
    // and returns null only for a genuine "no accredit op", so this one read
    // distinguishes HAF-unavailable (-> 503, fail closed: no broadcast) from a
    // not-accredited account (-> 403) — the same distinction the sibling /verify
    // path gets from its existing-accreditation gate. Because HAF is confirmed
    // reachable here, the fail-closed eligibility checks below (getAccreditedSet
    // -> empty, hasUnliftedSanction -> refuse) can be trusted as genuine
    // "not a member / sanctioned" 403s rather than HAF blips.
    let prior: Awaited<ReturnType<typeof getLatestAccreditOp>>;
    try {
      prior = await getLatestAccreditOp(username);
    } catch {
      res.set('Retry-After', '30');
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Could not load the current accreditation. Please retry.', {
        retriable: true,
      });
    }
    if (!prior) {
      // HAF was reachable (no throw) but there is no accredit op for this account:
      // it is not accredited, so there is nothing to edit.
      return sendError(
        res,
        403,
        'FORBIDDEN',
        'Only a currently-accredited, non-sanctioned account can edit its accreditation metadata',
      );
    }

    // Currently-accredited membership check. HAF is confirmed reachable (the op
    // load above did not throw), so an empty result is a genuine "not a current
    // member" (below-threshold WoT, legacy-revoked, or sanction-suppressed) -> 403.
    const accreditedSet = await getAccreditedSet([username]);
    if (!accreditedSet.has(username)) {
      return sendError(
        res,
        403,
        'FORBIDDEN',
        'Only a currently-accredited, non-sanctioned account can edit its accreditation metadata',
      );
    }

    // Non-cached sanction check. getAccreditedSet's fast path reads the
    // accredited_accounts_all cache (10-min TTL), so a freshly-sanctioned account
    // can still pass the membership check during the staleness window. The
    // uncached, fail-closed hasUnliftedSanction closes that window: a sanctioned
    // account is refused before any proof is consumed or op broadcast, so a later
    // self-service accredit cannot lift its own sticky sanction. Placed AFTER the
    // currently-accredited check and BEFORE consuming the proof.
    if (await hasUnliftedSanction(username)) {
      return sendError(res, 403, 'ACCREDITATION_SANCTIONED', SANCTIONED_ACCREDIT_MESSAGE);
    }

    // Fresh re-auth gate (NOT JWT-only). Self-custody/Keychain (signature) is
    // fresh at the middleware; the JWT path demands a single-use proof bound to
    // (edit_accreditation_metadata, <username>, ''). consumeFreshAuthProof is
    // called INLINE here (not as the requireFreshAuth middleware) so it runs only
    // after the eligibility checks above — an ineligible caller never burns a
    // valid proof. The binding-aware reason->status mapping lives once inside it.
    const freshAuth = await consumeFreshAuthProof(req, editAccreditationMetadataFreshAuthTarget);
    if (!freshAuth.ok) {
      return sendError(
        res,
        freshAuth.status,
        'FRESH_AUTH_REQUIRED',
        'Re-authentication required to edit accreditation metadata. Please complete the fresh-auth challenge and retry.',
        { reason: freshAuth.reason },
      );
    }

    const { full_name, institution, field } = req.body;
    const merged = {
      action: 'accredit' as const,
      account: username,
      name: full_name ?? prior.name,
      institution: institution ?? prior.institution,
      field: field ?? prior.field,
      // Preserve method/orcid/evidence_hash/issued_by from the prior op — a
      // metadata edit changes only name/institution/field. Carrying orcid forward
      // keeps the ORCID binding intact; carrying evidence_hash forward avoids
      // fabricating a new attestation hash; carrying issued_by forward keeps the
      // accreditation's ORIGIN attribution (a WoT 'wot' marker stays 'wot' rather
      // than flipping to the admin account on every edit). A legacy op with no
      // issued_by falls back to the admin-account marker (this edit IS admin-key
      // signed, just owner-authorized).
      method: prior.method,
      orcid: prior.orcid,
      evidence_hash: prior.evidence_hash,
      issued_by: prior.issued_by || config.hiveAdminAccount,
      timestamp: new Date().toISOString(),
    };

    // The single-use fresh-auth proof (JWT path) was consumed ABOVE, before this
    // broadcast — re-broadcasting after a failure requires a fresh re-auth (the
    // per-op rule). On a broadcast TIMEOUT the outcome is ambiguous (the op may
    // have landed); handleBroadcastError emits the 504 outcome:'uncertain' /
    // verify_before_retry envelope (retriable:false) so the client verifies on
    // chain and re-mints rather than blind-retrying with the now-spent proof.
    try {
      const result = await broadcastAdminCustomJson(merged);

      // Sync the accounts-row metadata cache (chain stays SSoT). A pure
      // self-custody caller has no accounts row, so this UPDATE affects 0 rows.
      const appPool = getAppPool();
      if (appPool) {
        try {
          await appPool.query(
            'UPDATE accounts SET full_name = $1, institution = $2, field = $3 WHERE username = $4',
            [merged.name, merged.institution, merged.field, username],
          );
        } catch (dbErr) {
          // The chain broadcast is authoritative; a failed cache sync reconciles
          // when the chain read repopulates. Log, do not fail the request.
          logger.warn({ err: dbErr, username }, 'accounts metadata cache sync failed after edit broadcast');
        }
      }

      logger.info({ event: 'accreditation.metadata.edit', username, tx_id: result.id }, 'accreditation metadata edited');
      return sendOk(res, {
        message: 'Accreditation metadata updated',
        tx_id: result.id,
        accreditation: {
          name: merged.name,
          institution: merged.institution,
          field: merged.field,
          method: merged.method,
          orcid: merged.orcid || null,
        },
      });
    } catch (err) {
      return handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting the metadata update timed out',
        failMsg: 'Failed to broadcast the metadata update',
        logContext: { username },
        routeLabel: 'accreditation.metadata.edit',
      });
    }
  },
);

export default router;
