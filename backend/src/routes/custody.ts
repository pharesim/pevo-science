import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { PrivateKey, Signature, cryptoUtils } from '@hiveio/dhive';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { sendOk, sendError } from '../response.js';
import { config } from '../config.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { getAppPool } from '../app-db.js';
import { broadcastSendOperationsWithTimeout, BroadcastTimeoutError, hiveClient } from '../hive.js';
import { decryptKey } from '../custody-crypto.js';
import { logCustodyBroadcast, type CustodyAuditExtras } from '../custody-audit.js';
import { logger } from '../logger.js';
import { runWithArgon2Slot } from '../lib/argon2-semaphore.js';
import { handleArgonError, ARGON_HANDLED } from '../lib/argon2-error-handler.js';
import { burnSentinel } from './auth.js';
import { requestAbortSignal } from '../lib/request-abort-signal.js';
import { handleBroadcastError, makeLogBroadcastAttempt } from '../lib/broadcast-error.js';
import {
  CONSENT_OP_ACTIONS,
  changeEmailFreshAuthTarget,
  computeFreshAuthTargetHash,
  consumeFreshAuthToken,
  consumeSessionFreshAuthToken,
  deleteAccountFreshAuthTarget,
  issueFreshAuthToken,
  issueSessionFreshAuthToken,
  type FreshAuthMechanism,
  type FreshAuthTarget,
  type FreshAuthTargetAction,
} from '../lib/fresh-auth.js';
import { sha256HexDigest } from '../lib/log-pii.js';
import {
  embedIdempotencyKey,
  lookupCustodyBroadcastIdempotency,
  validateIdempotencyKey,
} from '../lib/idempotency.js';
import { assertBodyRecord, requireStringField } from '../lib/body-record.js';
import { HIVE_PERMLINK_MAX_LEN } from '../lib/hive-permlink.js';
import { getPool, isHafConfigured } from '../db.js';

// Centralized length caps for custody body-shape validation. Shared between
// the pre-limiter validators and the handler-side defense-in-depth reads so
// the two layers cannot diverge on what counts as malformed input. Selected
// to absorb the route's body-parser limit (1 MB) without ever requiring the
// handler to materialize multi-megabyte attacker-supplied fields.
const PASSWORD_MAX_LEN = 4096;
const DERIVED_PUBKEY_MAX_LEN = 100;
const SIGNED_PROOF_MAX_LEN = 200;
const SIGNED_AT_MAX_LEN = 64;
const ROOT_AUTHOR_MAX_LEN = 64;

const router = Router();

// Allowed Hive operations for custodial broadcast
const ALLOWED_OPS = new Set(['comment', 'vote', 'custom_json']);

const broadcastLimiter = rateLimit({ name: 'custody-broadcast', windowMs: 60_000, max: 30, keyFn: byAccount });
// Consume-on-success-only: the 1/hr cap exists to bound a one-shot ceremony,
// not to penalize transient upstream failures (Hive RPC 503) or stolen-JWT
// attackers spraying empty bodies (400 VALIDATION_ERROR). Failed responses
// (status >= 400) don't count, so the legitimate user can always retry after
// a transient failure within the hour. Full rationale (skipFailedRequests
// design choice + stolen-JWT-DoS protection) lives in the
// `RateLimitConfig.skipFailedRequests` JSDoc above the type definition.
const upgradeLimiter = rateLimit({ name: 'custody-upgrade', windowMs: 3_600_000, max: 1, keyFn: byAccount, skipFailedRequests: true });
// Tighter than broadcast: each issuance pays a full argon2.verify (~50 ms × N
// in-flight under the JS-level semaphore). 10/min/account is generous for the
// re-auth-then-broadcast UX (the user sees one prompt → one proof → one
// broadcast). `skipFailedRequests: true` is a deliberate tradeoff: closing
// the legitimate-user-lockout DoS surface (stolen JWT + 10 wrong-password
// attempts = legit-user locked out of the mint path for 60s) over rate-
// bounding per-account password brute-force. JWT theft is PEvO's accepted
// upstream prerequisite; a stolen JWT already grants broadcast access via
// the JWT alone. The argon2 server-wide semaphore at
// `backend/src/lib/argon2-semaphore.ts` caps aggregate verifies/sec across
// ALL routes but does NOT bound per-account attempts; `loginLimiter` is
// IP-keyed (not account-keyed) so it also does NOT bound per-account
// brute-force from a JWT-holding attacker rotating IPs. The unbounded per-
// account password brute-force surface is the accepted residual risk; the
// DoS protection on legitimate users is the deciding factor. The mint
// path's `burnSentinel` call on the null-hash branch (timing-oracle
// equalization) runs BEFORE the deferred-consume hook, so the null-hash
// 401 also benefits from the slot-non-consume semantic.
const freshAuthLimiter = rateLimit({
  name: 'custody-fresh-auth',
  windowMs: 60_000,
  max: 10,
  keyFn: byAccount,
  skipFailedRequests: true,
});
// Same shape and budget as `freshAuthLimiter` — both routes pay an argon2.verify
// per call and serve the State A/B mint paths; bucket them under a dedicated
// name so the metric/observability surface for the session-mint path stays
// distinct from the per-op consent-mint path. `skipFailedRequests: true` for
// the same deliberate-tradeoff reason documented on `freshAuthLimiter` above:
// closing the legitimate-user-lockout DoS over rate-bounding per-account
// password brute-force, with the brute-force surface accepted as residual
// risk (the JWT-gate is per-account but JWT theft is the accepted upstream
// prerequisite; the server-wide argon2 semaphore and IP-keyed `loginLimiter`
// do not bound per-account attempts).
const sessionAuthLimiter = rateLimit({
  name: 'custody-session-auth',
  windowMs: 60_000,
  max: 10,
  keyFn: byAccount,
  skipFailedRequests: true,
});

// Body-shape validators that run BEFORE the per-account limiters above. The
// `skipFailedRequests: true` flag on those limiters refunds the slot on any
// 4xx/5xx response, which closes the legitimate-user-lockout DoS but opens
// a CPU-amplification surface: a JWT holder can spray malformed bodies
// indefinitely and each spray pays the full `verifyHiveSignature` ECDSA
// recovery cost plus the handler's argon2.verify / Signature.recover /
// Hive-RPC cost upstream of the limiter. Placing body-shape checks ahead of
// the limiter shifts the malformed-body class to a 400 VALIDATION_ERROR
// that does NOT pay the handler/auth cost. The verifyHiveSignature cost is
// already paid (the JWT auth gate runs first by design so the username is
// available for `byAccount` keying); the bound is on everything downstream
// of auth. See `RateLimitConfig.skipFailedRequests` JSDoc for the layered
// pattern obligation.

/** Body-shape validator for POST /api/custody/upgrade. Asserts the proof
 *  fields are present, well-typed, and within reasonable length caps. Runs
 *  BEFORE `upgradeLimiter` so malformed bodies pay only auth + this check,
 *  not the Signature.recover / Hive getAccounts / DB roundtrip the handler
 *  performs. */
function validateUpgradeBodyShape(req: Request, res: Response, next: NextFunction) {
  const body = assertBodyRecord(req);
  const derivedPubkey = requireStringField(body, 'derived_pubkey', DERIVED_PUBKEY_MAX_LEN);
  if (!derivedPubkey.ok) return sendError(res, 400, 'VALIDATION_ERROR', derivedPubkey.error);
  const signedProof = requireStringField(body, 'signed_proof', SIGNED_PROOF_MAX_LEN);
  if (!signedProof.ok) return sendError(res, 400, 'VALIDATION_ERROR', signedProof.error);
  const signedAt = requireStringField(body, 'signed_at', SIGNED_AT_MAX_LEN);
  if (!signedAt.ok) return sendError(res, 400, 'VALIDATION_ERROR', signedAt.error);
  next();
}

/** Body-shape validator for POST /api/custody/fresh-auth. Asserts the
 *  password is present and the action is one of the allowed values, with
 *  action-conditional presence of root_author / root_permlink. Runs BEFORE
 *  `freshAuthLimiter` so malformed bodies do not pay the argon2.verify cost
 *  the handler performs. Length caps are conservative defaults aligned
 *  with the route's existing 1mb body limit. */
function validateFreshAuthBodyShape(req: Request, res: Response, next: NextFunction) {
  const body = assertBodyRecord(req);
  const password = requireStringField(body, 'password', PASSWORD_MAX_LEN, 'Password is required');
  if (!password.ok) return sendError(res, 400, 'VALIDATION_ERROR', password.error);
  const action = body.action;
  if (action === 'change_email' || action === 'delete_account') {
    // No additional fields required; target is derived from authenticated
    // username inside the handler.
    return next();
  }
  if (action === 'author_accept' || action === 'author_resign') {
    const rootAuthor = requireStringField(body, 'root_author', ROOT_AUTHOR_MAX_LEN);
    if (!rootAuthor.ok) return sendError(res, 400, 'VALIDATION_ERROR', rootAuthor.error);
    const rootPermlink = requireStringField(body, 'root_permlink', HIVE_PERMLINK_MAX_LEN);
    if (!rootPermlink.ok) return sendError(res, 400, 'VALIDATION_ERROR', rootPermlink.error);
    return next();
  }
  return sendError(
    res,
    400,
    'VALIDATION_ERROR',
    'action must be one of: author_accept, author_resign, change_email, delete_account',
  );
}

/** Body-shape validator for POST /api/custody/session-auth. Asserts the
 *  password is present and well-typed. Runs BEFORE `sessionAuthLimiter` so
 *  malformed bodies do not pay the argon2.verify cost. */
function validateSessionAuthBodyShape(req: Request, res: Response, next: NextFunction) {
  const body = assertBodyRecord(req);
  const password = requireStringField(body, 'password', PASSWORD_MAX_LEN, 'Password is required');
  if (!password.ok) return sendError(res, 400, 'VALIDATION_ERROR', password.error);
  next();
}

/** Stable session-id derived from the bearer JWT for audit-log correlation.
 *  SHA-256 of the raw token, truncated to 16 hex chars — opaque to the
 *  client, identifies the issuance session without persisting the token
 *  itself. Returns `null` when no Authorization header is present. */
function bearerSessionId(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  if (token.length === 0) return null;
  return sha256HexDigest(token).slice(0, 16);
}

/** SHA-256 hash of the User-Agent header for audit-log storage. Returns
 *  `undefined` for absent, empty, or non-string headers; the audit-log
 *  writer translates `undefined` to NULL.
 *
 *  Hashing satisfies GDPR Art. 5(1)(c) data minimization: the forensic
 *  purpose of retaining a UA (correlating UA changes between consent ops
 *  to prove session continuity) is satisfied by hash-equality without
 *  retaining the raw header, which can leak OS / browser version and in
 *  some mobile apps a device or username substring. Full 64-char digest
 *  (no truncation): collision resistance matters here in a way it does
 *  not for `bearerSessionId`'s compact correlator. */
export function hashUserAgentForAudit(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return sha256HexDigest(value);
}

/** Result discriminator for `findConsentOpsInBundle`. The single-consent rule
 *  is structural: a bundle either contains zero consent ops (no fresh-auth
 *  required), exactly one consent op (fresh-auth required for that op), or
 *  more than one (rejected).
 *
 *  Round-5 hold #3: the `single` arm carries the full target triple
 *  (`action`, `root_author`, `root_permlink`) so the consume side can
 *  compute the expected target hash and reject substitution attacks where
 *  a compromised SPA swaps action/paper between the user's auth ceremony
 *  and the broadcast. The triple shape is `{action, root_author,
 *  root_permlink}` matching `FreshAuthTarget` in `lib/fresh-auth.ts`; a
 *  consent op whose payload omits or malforms these fields is treated as
 *  malformed and skipped (the broadcast then falls into the no-consent-op
 *  branch and proceeds without proof, but the consent op itself will be
 *  rejected by the chain since it lacks required fields). */
type ConsentOpScan =
  | { kind: 'none' }
  | { kind: 'single'; action: string; rootAuthor: string; rootPermlink: string }
  | { kind: 'multiple' };

/** Type guard: a Hive operation is a [type, params] tuple where params is a
 *  non-null object. Replaces the round-3 `as { json?: unknown }` cast at
 *  this site (round-4 hold #8). */
function isOpTuple(op: unknown): op is [string, Record<string, unknown>] {
  return (
    Array.isArray(op) &&
    op.length === 2 &&
    typeof op[0] === 'string' &&
    typeof op[1] === 'object' &&
    op[1] !== null
  );
}

/** Scan the operations bundle for consent ops (`author_accept` /
 *  `author_resign`). Per round-4 hold #1, we explicitly reject bundles
 *  containing more than one consent op: a single fresh-auth proof gates
 *  the entire bundle, so allowing N consent ops in one call would let a
 *  compromised SPA convert one auth ceremony into N consent broadcasts
 *  (substitution-attack vector). The function returns a discriminator so
 *  the caller can distinguish "no consent op" (no proof needed) from
 *  "exactly one" (verify proof) from "multiple" (reject 400). */
function findConsentOpsInBundle(operations: unknown[]): ConsentOpScan {
  let firstAction: string | null = null;
  let firstRootAuthor: string | null = null;
  let firstRootPermlink: string | null = null;
  for (const op of operations) {
    if (!isOpTuple(op)) continue;
    const [opType, opParams] = op;
    if (opType !== 'custom_json') continue;
    const rawJson = opParams.json;
    let payload: unknown;
    try {
      payload = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
    } catch {
      continue;
    }
    if (typeof payload !== 'object' || payload === null) continue;
    const action = (payload as { action?: unknown }).action;
    if (typeof action !== 'string' || !CONSENT_OP_ACTIONS.has(action)) continue;
    // Round-5 hold #3: consent ops with malformed targets fall through to
    // the no-consent path. Chain rejection is the backstop — a missing or
    // non-string `root_author`/`root_permlink` makes the custom_json op
    // invalid at the consensus layer, so the bundle's atomic-transaction
    // semantic rolls back any sibling ops along with it. We surface the
    // op as no-consent here rather than as a 400 because (a) the per-op
    // ALLOWED_OPS check upstream already rejected non-allowlisted custom
    // ops, (b) chain rejection is correlated for operator visibility by
    // `event:'broadcast_failed'` (chain-reject path via handleBroadcastError)
    // and `event:'custody.broadcast.attempt'` with `outcome:'failure'` (the
    // per-attempt audit-log helper), and (c) treating this as "no consent op
    // detected" keeps the substitution-attack surface flat: an attacker
    // can't slip a malformed consent op into a legitimate bundle to
    // bypass the fresh-auth gate, because the chain rejects the entire
    // bundle along with the malformed op.
    const rawRootAuthor = (payload as { root_author?: unknown }).root_author;
    const rawRootPermlink = (payload as { root_permlink?: unknown }).root_permlink;
    if (
      typeof rawRootAuthor !== 'string' || rawRootAuthor.length === 0 ||
      typeof rawRootPermlink !== 'string' || rawRootPermlink.length === 0
    ) {
      continue;
    }
    if (firstAction === null) {
      firstAction = action;
      firstRootAuthor = rawRootAuthor;
      firstRootPermlink = rawRootPermlink;
    } else {
      // Second consent op detected — short-circuit with the multi-consent
      // discriminator. The caller responds 400 MULTIPLE_CONSENT_OPS without
      // consuming the proof or reaching the broadcast path.
      return { kind: 'multiple' };
    }
  }
  return firstAction === null
    ? { kind: 'none' }
    : {
        kind: 'single',
        action: firstAction,
        rootAuthor: firstRootAuthor!,
        rootPermlink: firstRootPermlink!,
      };
}

// ─────────────────────────────────────────────────────────────
// POST /api/custody/broadcast — Sign and broadcast operations for light accounts (LA9)
// ─────────────────────────────────────────────────────────────
router.post('/broadcast', verifyHiveSignature, broadcastLimiter, async (req: Request, res: Response) => {
  const username = req.hiveUsername;
  const custody = req.hiveCustody;

  if (!username) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  // Only light (custodial) accounts can use this endpoint
  if (custody !== 'light') {
    return sendError(res, 403, 'FORBIDDEN', 'This endpoint is only for custodial accounts. Use Hive Keychain to sign transactions.');
  }

  let { operations } = req.body || {};
  if (!Array.isArray(operations) || operations.length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Operations array is required');
  }

  // Optional `idempotency_key` (per-broadcast UUID from the SPA) closes the
  // retry-amplification class documented in
  // `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`
  // Option A.4. When the key is present + HAF is reachable + the bundle has at
  // least one comment or custom_json op, a pre-broadcast HAF check returns the
  // existing tx_id with `outcome:'already_landed'` instead of re-broadcasting.
  // Today's SPA does NOT yet send the field; the corresponding UI task
  // (`ui-custody-broadcast-idempotency-key.md`) wires it up. The backend
  // accepts requests without the field with a structured-warn so the
  // amplification window is observable while the SPA migrates.
  const rawIdempotencyKey = (req.body as { idempotency_key?: unknown })?.idempotency_key;
  let idempotencyKey: string | null = null;
  if (rawIdempotencyKey !== undefined) {
    // F11: discriminated result eliminates the prior `string | null` shape
    // where success (`null`) shared a type with failure (the error message
    // string). The narrowed `value` is the validated key — no `as string`
    // cast at the assignment site.
    const validation = validateIdempotencyKey(rawIdempotencyKey);
    if (!validation.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', validation.error);
    }
    idempotencyKey = validation.value;
  }

  // Validate each operation
  for (const op of operations) {
    if (!Array.isArray(op) || op.length !== 2) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Each operation must be a [type, params] tuple');
    }

    const [opType, opParams] = op;

    // Check operation is in allowlist
    if (!ALLOWED_OPS.has(opType)) {
      return sendError(res, 403, 'FORBIDDEN', `Operation '${opType}' is not allowed for custodial accounts`);
    }

    // Enforce author/voter matches JWT subject
    if (opType === 'comment') {
      if (opParams.author !== username) {
        return sendError(res, 403, 'FORBIDDEN', `Comment author must be '${username}'`);
      }
      // Validate app tag in json_metadata
      try {
        const meta = typeof opParams.json_metadata === 'string'
          ? JSON.parse(opParams.json_metadata)
          : opParams.json_metadata;
        if (!meta.app || !String(meta.app).startsWith(config.appTag)) {
          return sendError(res, 400, 'VALIDATION_ERROR', `json_metadata.app must start with '${config.appTag}'`);
        }
      } catch {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid json_metadata');
      }
    } else if (opType === 'vote') {
      if (opParams.voter !== username) {
        return sendError(res, 403, 'FORBIDDEN', `Voter must be '${username}'`);
      }
    } else if (opType === 'custom_json') {
      // Only allow specific custom_json actions, and enforce sender is the authenticated user
      const auths = opParams.required_posting_auths;
      if (!Array.isArray(auths) || auths.length !== 1 || auths[0] !== username) {
        return sendError(res, 403, 'FORBIDDEN', `required_posting_auths must be ['${username}']`);
      }
      if (opParams.id !== config.appTag) {
        return sendError(res, 400, 'VALIDATION_ERROR', `custom_json id must be '${config.appTag}'`);
      }
      try {
        const payload = typeof opParams.json === 'string' ? JSON.parse(opParams.json) : opParams.json;
        const allowedActions = [
          'revote',
          'claim_authorship',
          'approve_authorship',
          'revoke_authorship',
          // Round-3 of BACKEND-COAUTHOR-TRUST-MODEL: consent ops gate
          // continuation-chain admit. Light-account broadcast is allowed,
          // but each call also requires a fresh-auth proof (gated below).
          'author_accept',
          'author_resign',
        ];
        if (!allowedActions.includes(payload.action)) {
          return sendError(res, 403, 'FORBIDDEN', `Only ${allowedActions.join(', ')} custom_json actions are allowed for custodial accounts`);
        }
      } catch {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid custom_json payload');
      }
    }
  }

  // Round-3: consent-op operations require a per-op fresh-auth proof.
  // Round-4 hold #1: bundles with MORE THAN ONE consent op are rejected
  // with 400 MULTIPLE_CONSENT_OPS — one proof gates one consent op, never
  // an N-op consent fan-out. Verified BEFORE decrypting the posting key so
  // a missing/expired proof or multi-consent bundle never reaches the
  // broadcast path. The proof is consumed (single-use) even if the
  // broadcast itself later fails — re-broadcasting requires a fresh re-auth,
  // matching the ARCH.md "per-op" rule.
  const consentScan = findConsentOpsInBundle(operations);
  if (consentScan.kind === 'multiple') {
    logger.warn(
      {
        event: 'custody.broadcast.multiple_consent_ops_rejected',
        route: 'custody.broadcast',
        username,
        op_count: operations.length,
      },
      'custody.broadcast rejected — bundle contains multiple consent ops',
    );
    return sendError(
      res,
      400,
      'MULTIPLE_CONSENT_OPS',
      'A custody broadcast bundle may contain at most one consent operation (author_accept or author_resign). Submit each consent op in its own request with its own fresh-auth proof.',
    );
  }

  // Fresh-auth verification hoisted ABOVE the idempotency check (round-2 F2).
  // Pre-fix order ran idempotency first so a retry of a confirmed consent op
  // wouldn't burn a fresh proof, but that ordering also let a key-collision
  // bypass the fresh-auth gate: if a prior op for the same (username, key,
  // op_type) was found, the route short-circuited to 200 WITHOUT verifying
  // the SPA could prove fresh re-auth. The architect's call: fresh-auth
  // proofs are single-use anyway — a SPA retry must re-derive the proof,
  // and the substitution-attack closure (target-hash binding from round-5)
  // is more important than retry ergonomics on consent ops specifically.
  //
  // The non-consent branch requires `fresh_auth_proof` too (consumed via
  // the session-kind path, no per-op binding check). This closes ARCH.md
  // § 6.5 invariant #1 on the non-consent surface — without it, only the
  // JWT would be required, making a stolen JWT a one-step takeover vector
  // for vote/comment broadcasts. State A/B users mint via
  // `/api/custody/fresh-auth` (password, per-op proof — accepted via the
  // cross-kind-accept on session consume); State B/C users mint via
  // `/api/orcid/callback mode='session_auth'` (ORCID, session-kind proof).
  const consentAction = consentScan.kind === 'single' ? consentScan.action : null;
  let freshAuthMechanism: FreshAuthMechanism | null = null;
  const proofRaw = (req.body as { fresh_auth_proof?: unknown })?.fresh_auth_proof;
  const proofToken = typeof proofRaw === 'string' ? proofRaw : undefined;
  if (consentScan.kind === 'single') {
    // Round-5 hold #3: compute the expected target hash from the consent
    // op's actual fields (action, root_author, root_permlink). The proof
    // must have been minted for THIS exact target — otherwise a compromised
    // SPA could swap the action or paper between the user's auth ceremony
    // and the broadcast. `consentScan.action` is narrowed to the consent
    // action set at this point; cast is safe because `consentScan.action`
    // has already been filtered through `CONSENT_OP_ACTIONS.has()` at the
    // scan site (see `findConsentOpsInBundle` around line 133), and those
    // values are a strict subset of `FreshAuthTargetAction` (which now
    // additionally includes `set_password` and `change_email` for the
    // non-broadcast surfaces).
    const expectedTarget: FreshAuthTarget = {
      action: consentScan.action as FreshAuthTargetAction,
      root_author: consentScan.rootAuthor,
      root_permlink: consentScan.rootPermlink,
    };
    const expectedTargetHash = computeFreshAuthTargetHash(expectedTarget);
    const result = await consumeFreshAuthToken(proofToken, username, expectedTargetHash);
    if (!result.valid) {
      logger.warn(
        {
          event: 'custody.broadcast.fresh_auth_rejected',
          route: 'custody.broadcast',
          username,
          consent_action: consentAction,
          consent_root_author: consentScan.rootAuthor,
          consent_root_permlink: consentScan.rootPermlink,
          reason: result.reason,
        },
        'custody.broadcast rejected — fresh-auth proof invalid',
      );
      // Round-4 hold #10 + round-5 hold #3: discriminate status code on
      // reason. `username_mismatch` and `target_mismatch` are binding
      // violations (token issued for a different user / target) → 403; the
      // remaining outcomes (`missing`, `expired`, `malformed`) are all
      // "no valid proof present" → 401. `kind_mismatch` is also a binding
      // violation (session-kind proof on the consent surface).
      const status =
        result.reason === 'username_mismatch' ||
        result.reason === 'target_mismatch' ||
        result.reason === 'kind_mismatch'
          ? 403
          : 401;
      return sendError(
        res,
        status,
        'FRESH_AUTH_REQUIRED',
        'Re-authentication required to broadcast this operation. Please complete the fresh-auth challenge and retry.',
        { reason: result.reason },
      );
    }
    freshAuthMechanism = result.mechanism;
  } else {
    // Non-consent path: require a session-kind proof (or cross-kind-accept
    // a consent_op-kind proof). No per-op binding check. The same status
    // discrimination applies — `username_mismatch` → 403, everything else
    // → 401.
    const result = await consumeSessionFreshAuthToken(proofToken, username);
    if (!result.valid) {
      logger.warn(
        {
          event: 'custody.broadcast.fresh_auth_rejected',
          route: 'custody.broadcast',
          username,
          consent_action: null,
          reason: result.reason,
        },
        'custody.broadcast rejected — fresh-auth proof invalid (non-consent path)',
      );
      const status = result.reason === 'username_mismatch' ? 403 : 401;
      return sendError(
        res,
        status,
        'FRESH_AUTH_REQUIRED',
        'Re-authentication required to broadcast this operation. Please complete the fresh-auth challenge and retry.',
        { reason: result.reason },
      );
    }
    freshAuthMechanism = result.mechanism;
  }

  // Idempotency check + embed. Runs AFTER per-op validation, multi-consent
  // rejection, AND fresh-auth verification (so a key-collision cannot bypass
  // the fresh-auth gate — see round-2 F2 reasoning above).
  //
  // Embed-first ordering (F2 continued): we run `embedIdempotencyKey` BEFORE
  // the HAF lookup so the resolved `embedded.opType` plumbs through to the
  // lookup. The HAF probe is then scoped to the SAME op surface the embed
  // picks, closing the cross-op-type shadowing class. Pure-vote bundles
  // (no embed surface) fall through to an unscoped two-arm probe so the
  // layer still dedups against a prior comment/cj broadcast carrying the
  // same key. The embed is pure (returns a fresh array); we commit the
  // result to the outer `operations` binding only AFTER the lookup miss
  // path is taken, so the broadcast sees the embedded version while a
  // short-circuit return path doesn't pay the splice.
  if (idempotencyKey !== null) {
    const embedded = embedIdempotencyKey(operations, idempotencyKey);
    if (!embedded.embedded) {
      // Pure-vote bundle (or other no-embed-surface shape). Vote re-cast is
      // low-harm (duplicate VP cost only); the layer cannot guarantee
      // dedup here. Surface a structured warn so operators can spot SPAs
      // that send `idempotency_key` on bundles where it has no effect.
      logger.warn(
        {
          event: 'custody.broadcast.idempotency_no_embed_surface',
          route: 'custody.broadcast',
          username,
          idempotency_key: idempotencyKey,
          op_types: operations.map((op: unknown) => Array.isArray(op) ? op[0] : 'unknown'),
        },
        'custody.broadcast idempotency_key supplied but bundle has no embed surface (pure-vote)',
      );
    }
    const hafPool = isHafConfigured() ? getPool() : null;
    if (hafPool) {
      try {
        // Pass the resolved opType (when present) so the HAF lookup probes
        // ONLY the matching arm (F2). Pure-vote bundles fall through to the
        // unscoped two-arm probe with `opType: undefined`.
        const probedOpType = embedded.embedded ? embedded.opType : undefined;
        const existing = await lookupCustodyBroadcastIdempotency(
          hafPool,
          username,
          idempotencyKey,
          probedOpType,
        );
        if (existing) {
          logger.info(
            {
              event: 'custody.broadcast.idempotency_hit',
              route: 'custody.broadcast',
              username,
              idempotency_key: idempotencyKey,
              tx_id: existing.tx_id,
              block_num: existing.block_num,
            },
            'custody.broadcast idempotency hit — returning existing tx_id',
          );
          return sendOk(res, {
            tx_id: existing.tx_id,
            // F13: coerce null to undefined so the SPA's arithmetic on a
            // missing block_num produces NaN (visible failure), not 0
            // (silent coercion). The fresh-broadcast envelope sets
            // block_num to the on-chain value; the idempotency-hit path
            // matches that shape when HAF carries one, else omits the
            // field entirely.
            block_num: existing.block_num ?? undefined,
            outcome: 'already_landed',
          });
        }
      } catch (lookupErr) {
        // HAF lookup failure degrades to "no idempotency layer"; the broadcast
        // proceeds. A 5xx here would be over-cautious — the dedup check is
        // best-effort, and a HAF blip should not block a legitimate broadcast.
        // F22: inlined from the prior `logIdempotencySkip` helper.
        logger.warn(
          {
            event: 'custody.broadcast.idempotency_lookup_failed',
            route: 'custody.broadcast',
            username,
            idempotency_key: idempotencyKey,
            err: lookupErr instanceof Error ? lookupErr : new Error(String(lookupErr)),
          },
          'custody.broadcast idempotency HAF lookup failed — proceeding without dedup',
        );
      }
    } else {
      // F10: event renamed from `idempotency_haf_unavailable` to
      // `idempotency_haf_unconfigured` because `isHafConfigured()` tests
      // configuration presence, not live reachability. The prior name led
      // operators to mis-read this branch as an outage signal; the new name
      // makes the config-only semantics explicit. `_lookup_failed` (above)
      // remains the real-outage discriminator.
      logger.warn(
        {
          event: 'custody.broadcast.idempotency_haf_unconfigured',
          route: 'custody.broadcast',
          username,
          idempotency_key: idempotencyKey,
        },
        'custody.broadcast idempotency layer degraded — HAF not configured, proceeding without dedup',
      );
    }
    if (embedded.embedded) {
      operations = embedded.ops;
    }
  } else {
    // Today's SPA does not yet send the field; the structured warn lets
    // operators measure the migration window. Drop this branch entirely once
    // the SPA migration completes and the field becomes required.
    logger.warn(
      {
        event: 'custody.broadcast.idempotency_key_missing',
        route: 'custody.broadcast',
        username,
        op_count: operations.length,
      },
      'custody.broadcast no idempotency_key supplied — retry-amplification window open',
    );
  }

  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  // Hoisted to the outer try-scope (round-2 hold #5): both the inner
  // (broadcast-path) and outer (db / decrypt / key-parse) catch reference the
  // same operation context. A pre-fix outer catch only logged `{ err, username }`
  // — operators investigating a `decryptKey` throw lost the operation context.
  // Computed up-front from the validated `operations` array; the structured
  // `op_types` (string[]) and `op_count` (number) are what dashboards key on
  // (round-2 hold #5: a comma-joined string can't be filtered by a single op
  // type in JSON-log queries, and a multi-op transaction's chain rejection at
  // op[1] can't be correlated with the bundle without the array shape).
  // `opTypes` (legacy comma-joined) stays threaded into `logCustodyBroadcast`
  // because the audit-log table column is a single TEXT field; the structured
  // pino fields are the per-attempt operator-log signal.
  const op_types = operations.map((op: [string, unknown]) => op[0]);
  const op_count = op_types.length;
  const opTypes = op_types.join(',');

  // Per-attempt audit-log signal (round-2 hold #4 — close audit-log blind
  // spot). The DB-side `logCustodyBroadcast` writes only on success; this
  // pino-side structured event fires on EVERY attempt with
  // outcome ∈ {success, failure, timeout}. Operators correlate
  // `event:'custody.broadcast.attempt'` to spot retry-amplification across
  // the idempotency-gated request path.
  //
  // Round-3 hold #1: `attempt_n` is INTENTIONALLY OMITTED. The idempotency
  // layer landed (`embedIdempotencyKey` + `lookupCustodyBroadcastIdempotency`
  // above wire the dedup gate against HAF), but that arc did NOT add a
  // per-attempt counter — the gate either short-circuits with the prior
  // tx_id on a hit or proceeds with no retry-history state. So a hardcoded
  // `attempt_n: 1` would still silently report "no retries" to dashboards
  // keyed on the field for retry-amplification alerts — masking the very
  // signal the alert exists to surface. The slot stays empty until a
  // per-key counter mechanism exists; alerts fire on missing-field rather
  // than reading a constant 1 as ground truth.
  //
  // BACKEND-BROADCAST-ATTEMPT-HELPER-EXTRACTION: the closure-shape factor
  // out to `lib/broadcast-error.ts` so the bridge `/register` audit-log
  // site shares the same shape (event-label literal + spread-after-literal
  // for outcome/event). The factory does NOT declare an `attempt_n` param;
  // the field stays absent until a per-key counter mechanism is added.
  const logBroadcastAttempt = makeLogBroadcastAttempt(
    'custody.broadcast.attempt',
    { route: 'custody.broadcast', username, op_types, op_count },
  );

  try {
    // Fetch and decrypt the posting key
    const { rows } = await pool.query<{
      posting_key_enc: Buffer;
      iv_posting: Buffer;
      upgraded_at: string | null;
    }>(
      'SELECT posting_key_enc, iv_posting, upgraded_at FROM accounts WHERE username = $1',
      [username],
    );

    if (rows.length === 0) {
      // 401, not 404 — authed endpoint, missing-own-row ≡ stale session
      // (especially relevant for light-account Bearer JWTs that may outlive
      // the underlying account row).
      return sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
    }

    const account = rows[0];
    if (account.upgraded_at) {
      return sendError(res, 403, 'FORBIDDEN', 'Account has been upgraded to self-custody. Use Hive Keychain.');
    }

    if (!account.posting_key_enc || !account.iv_posting) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Posting key not available');
    }

    // Decrypt key — held in memory only for this request
    const postingKeyWif = decryptKey(username, account.posting_key_enc, account.iv_posting);
    const key = PrivateKey.fromString(postingKeyWif);

    // Broadcast. Scoped try/catch so BroadcastTimeoutError is discriminated
    // into a 504 envelope via handleBroadcastError, and non-timeout chain
    // errors land in a 502 envelope. Non-broadcast errors (db, decrypt,
    // key parse) fall through to the outer 500 INTERNAL_ERROR.
    try {
      const result = await broadcastSendOperationsWithTimeout(operations, key);

      // Audit log (DB write, non-blocking) — captures only the success path.
      // Round-3: consent-op broadcasts also persist auth-mechanism + session
      // + user-agent per ARCH.md "Light-account signing of consent ops".
      // Round-4 hold #9: `auditExtras` is typed as `CustodyAuditExtras`;
      // the constructor below pins `auth_mechanism` + `fresh_auth_outcome`
      // together (TS no longer admits the half-populated shape that
      // motivated the convention).
      //
      // `freshAuthMechanism` is non-null on the success path:
      // `consumeFreshAuthToken` and `consumeSessionFreshAuthToken` early-
      // return 401/403 on missing/invalid proof, so whichever upstream
      // branch ran has assigned `result.mechanism` before reaching this
      // constructor. The prior `=== null ? undefined : {...}` arm was
      // unreachable; inlined the populated branch.
      const auditExtras: CustodyAuditExtras = {
        auth_mechanism: freshAuthMechanism,
        fresh_auth_outcome: 'verified',
        session_id: bearerSessionId(req) ?? undefined,
        user_agent: hashUserAgentForAudit(req.headers['user-agent']),
      };
      logCustodyBroadcast(username, opTypes, result.id, result.block_num, auditExtras).catch(() => {});
      // Pino-side per-attempt signal (round-2 hold #4 — every attempt logged).
      // See hold #6 note above: `freshAuthMechanism` is non-null here.
      logBroadcastAttempt('success', {
        tx_id: result.id,
        block_num: result.block_num,
        consent_action: consentAction,
        auth_mechanism: freshAuthMechanism,
      });

      return sendOk(res, {
        tx_id: result.id,
        block_num: result.block_num,
      });
    } catch (err) {
      // Pino-side per-attempt signal for the broadcast catch path. The
      // outcome label discriminates timeout vs. failure so dashboards can
      // separate the two without parsing the inner-helper's stable suffix.
      const outcome: 'failure' | 'timeout' = err instanceof BroadcastTimeoutError ? 'timeout' : 'failure';
      logBroadcastAttempt(outcome);
      return handleBroadcastError(res, err, {
        timeoutMsg: 'Broadcasting signed operation timed out',
        failMsg: 'Failed to broadcast signed operation to Hive',
        logContext: { username, op_types, op_count },
        routeLabel: 'custody.broadcast',
      });
    }
  } catch (err) {
    // Outer catch: db / decrypt / PrivateKey.fromString errors. Round-2 hold
    // #5: include the structured `op_types` + `op_count` so operators don't
    // lose the operation context when the failure is upstream of the
    // broadcast. `event:'custody.broadcast.internal_error'` discriminates
    // this branch from the broadcast-path event so dashboards filter cleanly.
    logger.error(
      {
        event: 'custody.broadcast.internal_error',
        route: 'custody.broadcast',
        username,
        op_types,
        op_count,
        err,
      },
      'Custodial broadcast failed (non-chain error)',
    );
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to broadcast transaction');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/custody/fresh-auth — Mint a per-op fresh-auth proof (password path).
// Round-3 of BACKEND-COAUTHOR-TRUST-MODEL. The ORCID issuance path lives in
// `routes/orcid.ts` under `mode: 'fresh_auth'` (parallel issuance flow that
// completes a real OAuth round-trip).
// ─────────────────────────────────────────────────────────────
router.post('/fresh-auth', verifyHiveSignature, validateFreshAuthBodyShape, freshAuthLimiter, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
  const username = req.hiveUsername;
  const custody = req.hiveCustody;

  if (!username) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
  }
  if (custody !== 'light') {
    return sendError(res, 403, 'FORBIDDEN', 'This endpoint is only for custodial accounts. Self-custody users sign consent ops via Hive Keychain.');
  }

  // Defense-in-depth re-read via the shared `requireStringField` helper. The
  // pre-limiter `validateFreshAuthBodyShape` middleware already short-circuits
  // malformed inputs; these handler-side reads exist to (a) narrow `req.body`
  // to typed locals without an unsafe cast and (b) document intent at the use
  // site. The length-cap constants (PASSWORD_MAX_LEN etc.) are the same ones
  // the middleware uses, so a future cap change at one site cannot diverge
  // from the other.
  const body = assertBodyRecord(req);
  const passwordResult = requireStringField(body, 'password', PASSWORD_MAX_LEN, 'Password is required');
  if (!passwordResult.ok) return sendError(res, 400, 'VALIDATION_ERROR', passwordResult.error);
  const password = passwordResult.value;
  // Round-5 hold #3: per-op target binding. The proof binds to the
  // (action, root_author, root_permlink) triple of the consent op the user
  // intends to authorize. Closed-default: consent-op callers must supply
  // all three fields; legacy callers that omit them get a 400 rather than
  // a target-less proof that would still be honored at consume.
  //
  // change_email and delete_account are non-broadcast critical actions: the
  // target binds to (action, <authenticated username>, '') and request body
  // does NOT carry root_author / root_permlink. Issuance via this route
  // (password mechanism) is only admissible for state A/B accounts
  // (password_hash IS NOT NULL); state C (passwordless) has no password to
  // base a password-mechanism proof on and must mint via
  // /api/orcid/start { mode: 'fresh_auth' } instead.
  const action = body.action;
  let target: FreshAuthTarget;
  if (action === 'change_email') {
    target = changeEmailFreshAuthTarget(username);
  } else if (action === 'delete_account') {
    target = deleteAccountFreshAuthTarget(username);
  } else if (action === 'author_accept' || action === 'author_resign') {
    const rootAuthorResult = requireStringField(body, 'root_author', ROOT_AUTHOR_MAX_LEN);
    if (!rootAuthorResult.ok) return sendError(res, 400, 'VALIDATION_ERROR', rootAuthorResult.error);
    const rootPermlinkResult = requireStringField(body, 'root_permlink', HIVE_PERMLINK_MAX_LEN);
    if (!rootPermlinkResult.ok) return sendError(res, 400, 'VALIDATION_ERROR', rootPermlinkResult.error);
    target = {
      action,
      root_author: rootAuthorResult.value,
      root_permlink: rootPermlinkResult.value,
    };
  } else {
    return sendError(
      res,
      400,
      'VALIDATION_ERROR',
      'action must be one of: author_accept, author_resign, change_email, delete_account',
    );
  }

  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  try {
    const { rows } = await pool.query<{
      password_hash: string | null;
      upgraded_at: string | null;
    }>(
      'SELECT password_hash, upgraded_at FROM accounts WHERE username = $1',
      [username],
    );

    if (rows.length === 0) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
    }

    const account = rows[0];
    if (account.upgraded_at) {
      return sendError(res, 403, 'FORBIDDEN', 'Account has been upgraded to self-custody. Use Hive Keychain.');
    }

    if (!account.password_hash) {
      // Password mechanism unavailable for this account (e.g., ORCID-only
      // hybrid). Direction the user toward the ORCID re-auth path. The
      // 401 + UNAUTHORIZED shape mirrors the wrong-password branch so the
      // route does not become a password-existence oracle. Burn an argon2
      // sentinel verify BEFORE the 401 to equalize wall-time with the
      // password-verify path (~50ms) — otherwise the null-hash branch
      // returns in <10ms and a JWT-holding attacker can distinguish State C
      // (password_hash IS NULL) from State A/B accounts along the latency
      // axis, reopening the same oracle the envelope-equivalence assertion
      // closes. Mirrors the `/login` ORCID-only burn (auth.ts) and the
      // `/session-auth` null-hash branch (sibling site below).
      await burnSentinel(password, abortSignal);
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid password');
    }

    const passwordHash = account.password_hash;
    const valid = await runWithArgon2Slot(
      () => argon2.verify(passwordHash, password),
      { signal: abortSignal },
    );
    if (!valid) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid password');
    }

    const issued = await issueFreshAuthToken(username, 'password', target);
    return sendOk(res, {
      fresh_auth_proof: issued.token,
      expires_at: issued.expires_at,
      mechanism: issued.mechanism,
    });
  } catch (err) {
    if (handleArgonError(res, err, { logContext: { username } }) === ARGON_HANDLED) return;
    logger.error(
      { event: 'custody.fresh_auth.failed', route: 'custody.fresh-auth', username, err },
      'Fresh-auth issuance failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to issue fresh-auth proof');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/custody/session-auth — Mint a session-kind fresh-auth proof (password path).
// State A users (light + password, no ORCID) previously had no usable mint
// path for non-consent broadcasts.
// `/api/custody/fresh-auth` mints `consent_op`-kind proofs that require per-op
// target binding (action + root_author + root_permlink) — hostile UX for
// vote/comment flows. `/api/orcid/start { mode: 'session_auth' }` needs ORCID
// linkage which State A users don't have. This route mints a target-less
// session-kind proof via the same argon2 password path; consumed by the non-
// consent surface of `/api/custody/broadcast` (cross-kind accept already wired
// via `consumeSessionFreshAuthToken`). Kind isolation: the session-kind proof
// is REJECTED on the consent-op surface with `details.reason: 'kind_mismatch'`.
// ─────────────────────────────────────────────────────────────
router.post('/session-auth', verifyHiveSignature, validateSessionAuthBodyShape, sessionAuthLimiter, async (req: Request, res: Response) => {
  const abortSignal = requestAbortSignal(req, res);
  const username = req.hiveUsername;
  const custody = req.hiveCustody;

  if (!username) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
  }
  if (custody !== 'light') {
    return sendError(res, 403, 'FORBIDDEN', 'This endpoint is only for custodial accounts. Self-custody users sign consent ops via Hive Keychain.');
  }

  // Defense-in-depth re-read via the shared `requireStringField` helper. See
  // the equivalent doc on the sibling `/fresh-auth` handler for why the
  // middleware short-circuit is augmented with a typed handler-side read.
  const body = assertBodyRecord(req);
  const passwordResult = requireStringField(body, 'password', PASSWORD_MAX_LEN, 'Password is required');
  if (!passwordResult.ok) return sendError(res, 400, 'VALIDATION_ERROR', passwordResult.error);
  const password = passwordResult.value;

  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  try {
    const { rows } = await pool.query<{
      password_hash: string | null;
      upgraded_at: string | null;
    }>(
      'SELECT password_hash, upgraded_at FROM accounts WHERE username = $1',
      [username],
    );

    if (rows.length === 0) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
    }

    const account = rows[0];
    if (account.upgraded_at) {
      return sendError(res, 403, 'FORBIDDEN', 'Account has been upgraded to self-custody. Use Hive Keychain.');
    }

    if (!account.password_hash) {
      // Password mechanism unavailable for this account (State C: ORCID-only,
      // `password_hash IS NULL`). Mirror the wrong-password 401 envelope so
      // the route does not become a password-existence oracle. State C users
      // should mint via `/api/orcid/start { mode: 'session_auth' }` instead.
      // Burn an argon2 sentinel verify BEFORE the 401 to equalize wall-time
      // with the password-verify path (~50ms) — without this, a JWT-holding
      // attacker can distinguish State C accounts (~1ms) from State A/B
      // accounts (~50ms) along the latency axis. Same equalization the
      // sibling `/fresh-auth` route applies above, and the canonical pattern
      // `/login` uses for its ORCID-only branch (`auth.ts`).
      await burnSentinel(password, abortSignal);
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid password');
    }

    const passwordHash = account.password_hash;
    const valid = await runWithArgon2Slot(
      () => argon2.verify(passwordHash, password),
      { signal: abortSignal },
    );
    if (!valid) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid password');
    }

    const issued = await issueSessionFreshAuthToken(username, 'password');
    return sendOk(res, {
      fresh_auth_proof: issued.token,
      expires_at: issued.expires_at,
      mechanism: issued.mechanism,
    });
  } catch (err) {
    if (handleArgonError(res, err, { logContext: { username } }) === ARGON_HANDLED) return;
    logger.error(
      { event: 'custody.session_auth.failed', route: 'custody.session-auth', username, err },
      'Session fresh-auth issuance failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to issue fresh-auth proof');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/custody/upgrade — Notify backend that key upgrade completed (LA12)
// ─────────────────────────────────────────────────────────────
//
// BACKEND-CUSTODY-UPGRADE-SEED-PHRASE-REAUTH: per ARCHITECTURE.md § 6.4, the
// re-auth proof for the light→self upgrade is the seed-phrase-derived pubkey,
// NOT a password. The UI derives keys client-side from the BIP39 mnemonic,
// broadcasts an `account_update` on-chain with the new pubkeys, then calls
// this route with proof that it holds the corresponding private key.
//
// Proof shape (`derived_pubkey` + `signed_proof` + `signed_at`):
//   • The client signs a canonical challenge string with the new private key.
//   • The challenge is `${appTag}-custody-upgrade|v1|${username}|${signed_at}`.
//   • Backend recovers the pubkey from the signature, requires it to equal
//     `derived_pubkey` (binding check), and requires that pubkey to appear in
//     the on-chain account's posting/active/owner key-auths set fetched via
//     `getAccounts(username)`.
//   • `signed_at` is an ISO-8601 timestamp; we enforce a past-biased window
//     with a small forward-skew tolerance: `tsMs > Date.now() +
//     UPGRADE_PROOF_FUTURE_SKEW_MS` rejects, and `Date.now() - tsMs >
//     UPGRADE_PROOF_TIMESTAMP_WINDOW_MS` rejects. The 5s forward tolerance
//     absorbs typical client clock drift (non-NTP devices, mobile, browsers
//     without precision-time-sync) without materially extending the captured-
//     proof replay race window (60s past + 5s forward = 65s, still under
//     adversarial-observation thresholds). The symmetric `|delta| < 60s` form
//     this replaced doubled the race window to 120s; the zero-skew form that
//     followed locked out users with 100ms of normal forward drift. The
//     `signed_at` is excluded from the request body when hashing for signature
//     reconstruction because the entire body is what the client signs over;
//     we re-build the canonical message from the body fields. This avoids the
//     circular-hash problem of having the signature embedded in the message
//     being signed.
//
// We require BOTH a `derived_pubkey` declaration AND a `signed_proof` signature
// to match the rigor of existing fresh-auth primitives (`verifyHiveSignature`
// recovers signatures against on-chain pubkeys). Pubkey-match alone would only
// prove knowledge of the rotated pubkey (which is publicly readable on-chain
// post-rotation); the signature requirement closes that gap by proving private-
// key possession in addition.
const UPGRADE_PROOF_TIMESTAMP_WINDOW_MS = 60_000;
// Forward-skew tolerance (5s) absorbs typical client clock drift without
// materially extending the captured-proof replay race window. See
// `signed_at` discussion in the doc comment above for rationale.
const UPGRADE_PROOF_FUTURE_SKEW_MS = 5_000;

// Exported for test-support only (frontend byte-equality canary asserts the
// SPA's challenge construction matches the server's). Not a stable contract;
// remains an internal route helper.
export function buildCustodyUpgradeChallenge(input: {
  appTag: string;
  username: string;
  signedAt: string;
}): string {
  return `${input.appTag}-custody-upgrade|v1|${input.username}|${input.signedAt}`;
}

// Both inputs are expected to be fixed-length STM-prefixed base58check pubkeys
// (53 ASCII chars), so `Buffer.from(str)` (defaults to utf-8) yields exactly
// 53 bytes for each and byte-equality is character-equality. The length-guard
// short-circuit is defense-in-depth, not load-bearing under that invariant.
// If a future refactor accepts non-STM keys (e.g., uncompressed pubkeys or
// variable-length representations), revisit: utf-8 byte-equality may differ
// from character-equality for non-ASCII inputs.
function timingSafePubkeyEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

router.post('/upgrade', verifyHiveSignature, validateUpgradeBodyShape, upgradeLimiter, async (req: Request, res: Response) => {
  const username = req.hiveUsername;
  const custody = req.hiveCustody;

  if (!username) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  if (custody !== 'light') {
    return sendError(res, 403, 'FORBIDDEN', 'Only custodial accounts can upgrade');
  }

  // Defense-in-depth re-read via the shared `requireStringField` helper. The
  // pre-limiter `validateUpgradeBodyShape` middleware short-circuits malformed
  // bodies before this handler runs; these reads pin the typed boundary at
  // the use site without an unsafe cast and share length caps with the
  // middleware.
  const body = assertBodyRecord(req);
  const derivedPubkeyResult = requireStringField(body, 'derived_pubkey', DERIVED_PUBKEY_MAX_LEN);
  if (!derivedPubkeyResult.ok) return sendError(res, 400, 'VALIDATION_ERROR', derivedPubkeyResult.error);
  const derivedPubkey = derivedPubkeyResult.value;
  const signedProofResult = requireStringField(body, 'signed_proof', SIGNED_PROOF_MAX_LEN);
  if (!signedProofResult.ok) return sendError(res, 400, 'VALIDATION_ERROR', signedProofResult.error);
  const signedProof = signedProofResult.value;
  const signedAtResult = requireStringField(body, 'signed_at', SIGNED_AT_MAX_LEN);
  if (!signedAtResult.ok) return sendError(res, 400, 'VALIDATION_ERROR', signedAtResult.error);
  const signedAt = signedAtResult.value;

  // Freshness gate: past-biased 60s window with 5s forward-skew tolerance.
  // The symmetric `Math.abs(...) > 60s` form this replaced doubled the
  // captured-proof replay race window to 120s. The zero-forward-skew form
  // that followed rejected users with 100ms of normal forward clock drift
  // (common on non-NTP devices, mobile, browsers without precision-time-
  // sync). The 5s forward tolerance absorbs that drift while keeping the
  // race window bounded (60s past + 5s forward = 65s, well under
  // adversarial-observation thresholds).
  const tsMs = Date.parse(signedAt);
  const nowMs = Date.now();
  const isFutureSkew = Number.isFinite(tsMs) && tsMs > nowMs + UPGRADE_PROOF_FUTURE_SKEW_MS;
  if (
    !Number.isFinite(tsMs) ||
    isFutureSkew ||
    nowMs - tsMs > UPGRADE_PROOF_TIMESTAMP_WINDOW_MS
  ) {
    // Operator diagnostic: future-skew rejects are the failure mode an
    // operator most often misdiagnoses as "users can't upgrade" without
    // realizing server NTP has drifted ahead of typical client clocks. A
    // single uniform 401 envelope still protects against client-side
    // disclosure; the log gives operators a discriminator that doesn't
    // leak to the wire. Past-stale and invalid-format rejects share the
    // same 401 but don't warrant the warn (the user-side fix is to re-
    // sign; the operator-side has nothing to do).
    if (isFutureSkew) {
      logger.warn(
        {
          event: 'custody.upgrade.proof_future_skew',
          username,
          tsMs,
          nowMs,
          skewMs: tsMs - nowMs,
          toleranceMs: UPGRADE_PROOF_FUTURE_SKEW_MS,
        },
        'Upgrade proof rejected: signed_at past forward-skew tolerance (NTP drift?)',
      );
    }
    return sendError(res, 401, 'UNAUTHORIZED', 'Upgrade proof expired or invalid timestamp');
  }

  const pool = getAppPool();
  if (!pool) return sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');

  try {
    const { rows } = await pool.query<{
      upgraded_at: string | null;
    }>(
      'SELECT upgraded_at FROM accounts WHERE username = $1',
      [username],
    );

    if (rows.length === 0) {
      // 401, not 404 — authed endpoint, missing-own-row ≡ stale session.
      return sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
    }

    const account = rows[0];
    if (account.upgraded_at) {
      return sendError(res, 409, 'ALREADY_UPGRADED', 'Account has already been upgraded to self-custody');
    }

    // Verify the signed_proof recovers a pubkey that matches `derived_pubkey`
    // AND appears in the on-chain key set. Any failure collapses to the same
    // 401 + generic message so the route does not become a key-existence /
    // signature-validity oracle. Detailed reason lands in operator logs.
    const challenge = buildCustodyUpgradeChallenge({
      appTag: config.appTag,
      username,
      signedAt,
    });
    const msgHash = cryptoUtils.sha256(challenge);

    let recoveredPubkey: string;
    try {
      const sig = Signature.fromString(signedProof);
      recoveredPubkey = sig.recover(msgHash).toString();
    } catch (sigErr) {
      logger.warn(
        {
          event: 'custody.upgrade.proof_malformed',
          route: 'custody.upgrade',
          username,
          err: sigErr instanceof Error ? sigErr.message : String(sigErr),
        },
        'Custody upgrade proof signature malformed',
      );
      logCustodyBroadcast(username, 'upgrade_failure').catch(() => {});
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid upgrade proof');
    }

    if (!timingSafePubkeyEqual(recoveredPubkey, derivedPubkey)) {
      logger.warn(
        {
          event: 'custody.upgrade.pubkey_binding_mismatch',
          route: 'custody.upgrade',
          username,
        },
        'Custody upgrade proof: recovered pubkey does not match declared derived_pubkey',
      );
      logCustodyBroadcast(username, 'upgrade_failure').catch(() => {});
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid upgrade proof');
    }

    // Fetch the on-chain key set. The derived_pubkey must appear in posting,
    // active, or owner key_auths. After a successful `account_update` rotation
    // the chain reflects the new (seed-derived) pubkeys, so the user's freshly
    // derived key matches one of these auths.
    let chainKeys: string[];
    try {
      const [hiveAccount] = await hiveClient.database.getAccounts([username]);
      if (!hiveAccount) {
        logger.warn(
          {
            event: 'custody.upgrade.hive_account_missing',
            route: 'custody.upgrade',
            username,
          },
          'Custody upgrade proof: on-chain account not found',
        );
        logCustodyBroadcast(username, 'upgrade_failure').catch(() => {});
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid upgrade proof');
      }
      chainKeys = [
        ...hiveAccount.posting.key_auths.map(([k]) => k.toString()),
        ...hiveAccount.active.key_auths.map(([k]) => k.toString()),
        ...hiveAccount.owner.key_auths.map(([k]) => k.toString()),
      ];
    } catch (hiveErr) {
      logger.error(
        {
          event: 'custody.upgrade.hive_lookup_failed',
          route: 'custody.upgrade',
          username,
          err: hiveErr,
        },
        'Custody upgrade: Hive getAccounts failed',
      );
      // Surface as 503 so the SPA can retry rather than treating the failure
      // as a fatal proof rejection (the user's proof may be perfectly valid;
      // the Hive read is the failure point).
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Could not verify upgrade proof against chain state. Please retry.');
    }

    let chainKeyMatched = false;
    for (const chainKey of chainKeys) {
      if (timingSafePubkeyEqual(chainKey, derivedPubkey)) {
        chainKeyMatched = true;
        break;
      }
    }
    if (!chainKeyMatched) {
      logger.warn(
        {
          event: 'custody.upgrade.chain_key_mismatch',
          route: 'custody.upgrade',
          username,
        },
        'Custody upgrade proof: derived_pubkey not present in on-chain key set',
      );
      logCustodyBroadcast(username, 'upgrade_failure').catch(() => {});
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid upgrade proof');
    }

    // Overwrite and NULL encrypted keys, set upgraded_at
    await pool.query(
      `UPDATE accounts
       SET posting_key_enc = NULL, iv_posting = NULL,
           memo_key_enc = NULL, iv_memo = NULL,
           upgraded_at = NOW()
       WHERE username = $1`,
      [username],
    );

    // Audit log (non-blocking)
    logCustodyBroadcast(username, 'upgrade').catch(() => {});

    // Issue new JWT with custody: "self"
    const token = jwt.sign(
      { sub: username, custody: 'self' },
      config.sessionSecret,
      { expiresIn: '24h' },
    );
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    sendOk(res, { custody: 'self', token, expires_at: expiresAt });
  } catch (err) {
    logger.error(
      { event: 'custody.upgrade.failed', route: 'custody.upgrade', username, err },
      'Custody upgrade failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Upgrade failed');
  }
});

export default router;
