import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PrivateKey } from '@hiveio/dhive';
import { z } from 'zod';
import { config } from '../config.js';
import { broadcastAdminCustomJson, BroadcastTimeoutError } from '../hive.js';
import {
  handleBroadcastError,
  PostBroadcastWriteError,
  classifyPostBroadcastSeverity,
  AppPoolNotInitialisedError,
  type HandleBroadcastErrorOpts,
  type HandleBroadcastErrorAmbiguousOpts,
  type PostBroadcastFailedStep,
} from '../lib/broadcast-error.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { getAppPool } from '../app-db.js';
import { getPool } from '../db.js';
import { T } from '../hafsql.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';
import { assertNever } from '../util/assertNever.js';
import { seedAccreditationBonus } from '../reputation.js';
import {
  adminActionFreshAuthTarget,
  changeEmailFreshAuthTarget,
  consentOpFreshAuthTarget,
  creditOpFreshAuthTarget,
  deleteAccountFreshAuthTarget,
  editAccreditationMetadataFreshAuthTarget,
  extractConsentOpFields,
  extractCreditOpFields,
  ipfsUploadFreshAuthTarget,
  isAdminFreshAuthAction,
  issueFreshAuthToken,
  issueSessionFreshAuthToken,
  setPasswordFreshAuthTarget,
  validFreshAuthActionsMessage,
  type FreshAuthTarget,
} from '../lib/fresh-auth.js';
import {
  findAccreditedAccountWithOrcid,
  withOrcidBindingLock,
  cacheOrcidBinding,
  extendBindingLockOnTimeoutOrLog,
  releaseBindingLock,
  HAF_INDEXING_LAG_CEILING_SECONDS,
} from '../lib/orcid-binding.js';

// Per-route Zod body schema for POST /api/orcid/callback.
// Narrows req.body to typed fields so
// downstream code doesn't need `req.body as { code?: string; state?: string }`
// casts. Business-required guards ("code and state are required") still
// run after the schema parse; Zod only enforces shape.
const CallbackBodySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
});

// Schema for POST /api/orcid/start. The mode
// value is an optional string at the Zod layer; VALID_MODES membership is
// enforced as business validation below (same pattern as auth.ts schemas
// that defer isEmail/isPasswordValid to post-parse). This replaces the
// `req.body as { mode?: string }` cast that previously bypassed the type
// system.
const StartBodySchema = z.object({
  mode: z.string().optional(),
  // Per-op fresh-auth target binding. When `mode` is 'fresh_auth', the request
  // body MUST also carry the target for the op being authorized; the OAuth
  // round-trip stores the target in the state map alongside `mode`/`username`,
  // and the callback reads it back to mint a target-bound proof. Anchored-route
  // consent ops carry (`action`, `root_author`, `root_permlink`); name-only-
  // route credit ops carry (`action`, `paper_author`, `paper_permlink`) plus
  // op-specific fields: `author_index` for claim/approve and `claimer` for
  // approve/revoke (`agents/docs/hive-schemas.md` § 2.9–§ 2.11). Binding
  // `claimer` stops a minted approve/revoke proof being redirected to a
  // different co-author.
  action: z.string().optional(),
  root_author: z.string().optional(),
  root_permlink: z.string().optional(),
  paper_author: z.string().optional(),
  paper_permlink: z.string().optional(),
  author_index: z.number().int().nonnegative().optional(),
  claimer: z.string().optional(),
});

const router = Router();

// ORCID iD format: four groups of four digits separated by hyphens, with the
// last character optionally 'X' (ISO 7064 MOD 11-2 checksum token). We do not
// validate the checksum itself — ORCID validates that upstream at token
// exchange. This guard is format-only defense-in-depth to prevent a malformed
// or adversarial orcid_id from ORCID's token response being interpolated into
// Redis key builders, the pub.orcid.org API path, or on-chain custom_json
// payloads. Exploitability is bounded today (fetch host is pinned, Redis uses
// binary-safe RESP, on-chain payloads are admin-signed), but this closes the
// surface for future callers (e.g. an admin UI rendering orcid_id in HTML).
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

// 'fresh_auth' is an authenticated
// mode that completes a fresh OAuth round-trip and mints a single-use
// fresh-auth proof token bound to the JWT subject. Issued tokens are
// consumed by the custody-broadcast handler when broadcasting `author_accept`
// or `author_resign` ops. Sibling endpoint to POST /api/custody/fresh-auth
// (the password-mechanism issuance path).
// `session_auth` is a sibling of `fresh_auth` for the non-consent broadcast
// surface; mints a target-less session-kind proof. Consent ops use
// `fresh_auth` (per-op binding); non-consent ops use `session_auth` (no
// target). Both require an authenticated session and complete a fresh
// OAuth round-trip. See `handleSessionAuth` below and ARCH.md § 6.5
// invariant #1 for the JWT-alone-as-takeover-vector closure this enables.
type OrcidMode = 'signup' | 'login' | 'accredit' | 'link' | 'fresh_auth' | 'session_auth';
// Allowed `mode` values on /start. Typed as `Set<OrcidMode>` (not
// `Set<string>`) so each initializer element must be a valid OrcidMode —
// prevents typos in the array literal. Note: this does NOT enforce union-
// completeness; a future `OrcidMode` literal added without updating this
// array compiles silently and fails at runtime at the /start dispatch with
// 400 BAD_REQUEST. The `assertNever` arm in the `/callback` dispatch
// switch over `storedMode` is the compile-time exhaustiveness backstop
// for the callback side.
const VALID_MODES = new Set<OrcidMode>(['signup', 'login', 'accredit', 'link', 'fresh_auth', 'session_auth']) satisfies ReadonlySet<OrcidMode>;

/** Type predicate that narrows `string` to `OrcidMode` via `VALID_MODES`
 *  membership. Encapsulates the `.has(value as OrcidMode)` cast required by
 *  `Set<OrcidMode>.has`'s nominal element-typed signature so the cast lives
 *  in exactly one place and callers narrow safely. */
function isOrcidMode(value: string): value is OrcidMode {
  return VALID_MODES.has(value as OrcidMode);
}
const AUTHENTICATED_MODES: ReadonlySet<string> = new Set(['accredit', 'link', 'fresh_auth', 'session_auth']);

const ORCID_STATE_TTL = 600; // 10 minutes
const ORCID_VERIFIED_TTL = 1800; // 30 minutes

// In-memory fallbacks when Redis is unavailable
const orcidStates = new Map<string, {
  mode: OrcidMode;
  username?: string;
  /** Target triple stored when `mode === 'fresh_auth'`,
   *  read back at callback to mint a target-bound proof. Always undefined
   *  for non-fresh-auth modes. */
  fresh_auth_target?: FreshAuthTarget;
  timestamp: number;
  expires: number;
}>();
const orcidVerified = new Map<string, { orcid_id: string; works_count: number; name: string; expires: number }>();

// Periodic cleanup of expired in-memory entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of orcidStates) {
    if (v.expires <= now) orcidStates.delete(k);
  }
  for (const [k, v] of orcidVerified) {
    if (v.expires <= now) orcidVerified.delete(k);
  }
}, 5 * 60_000);

const startLimiter = rateLimit({ name: 'orcid-start', windowMs: 60_000, max: 10, keyFn: byIp });
const callbackLimiter = rateLimit({ name: 'orcid-callback', windowMs: 60_000, max: 10, keyFn: byIp });

/** Per-fetch timeout for ORCID provider calls. Native Node
 *  `fetch` has no default timeout; an ORCID-side hang (provider outage,
 *  network blackhole) blocks the handler indefinitely. New consent-flow
 *  modes (`fresh_auth`) inherited the same surface so the fix is uniform.
 *  10s is generous for a healthy ORCID round-trip (~50-300ms typical) but
 *  short enough that a single hung call doesn't cascade into a thread-pool
 *  starvation. Override via env if a deployment needs to tune it. */
const ORCID_FETCH_TIMEOUT_MS = (() => {
  const raw = process.env.ORCID_FETCH_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
})();

/** Typed error surface for an ORCID-provider hang. The
 *  /callback outer catch maps this specifically to a 504
 *  ORCID_PROVIDER_TIMEOUT response with `details.outcome: 'timeout'`,
 *  distinct from generic 500 errors and distinct from upstream non-2xx
 *  responses. */
class OrcidProviderTimeoutError extends Error {
  constructor(public readonly url: string) {
    super(`ORCID provider timed out after ${ORCID_FETCH_TIMEOUT_MS}ms: ${url}`);
    this.name = 'OrcidProviderTimeoutError';
  }
}

/** Timed-fetch wrapper. Combines the per-call timeout
 *  with any external AbortSignal the caller already supplies. On timer
 *  fire, throws `OrcidProviderTimeoutError` so the route can map it to a
 *  504 (rather than `AbortError` which is also surfaced for caller-driven
 *  aborts). Logs the timeout at warn level with a structured event so
 *  operators can correlate provider-outage windows. */
async function fetchWithOrcidTimeout(
  url: string,
  init: RequestInit = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORCID_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      logger.warn(
        {
          event: 'orcid.fetch.timeout',
          route: 'orcid.fetch',
          url,
          timeout_ms: ORCID_FETCH_TIMEOUT_MS,
        },
        'ORCID provider fetch timed out',
      );
      throw new OrcidProviderTimeoutError(url);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Derive redirect URI at runtime (no env var needed)
function getRedirectUri(): string {
  return `${config.appUrl}/orcid/callback`;
}

// Runs verifyHiveSignature inline outside the Express middleware chain.
// Returns the authenticated username on success. Returns null when the
// middleware has already terminated the response (the caller must return
// without sending more data) — typically because auth failed. The resolve-on-
// finish listener protects against verifyHiveSignature's catch path, which
// sends an error without calling `next()` and would otherwise leave this
// Promise pending forever.
async function authenticateRequest(req: Request, res: Response): Promise<string | null> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    res.once('finish', () => settle(resolve));
    res.once('close', () => settle(resolve));
    void verifyHiveSignature(req, res, (err?: unknown) => {
      settle(err ? () => reject(err) : resolve);
    });
  });
  if (res.headersSent) return null;
  const username = req.hiveUsername;
  if (!username) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required for this mode');
    return null;
  }
  return username;
}

// ─────────────────────────────────────────────────────────────
// POST /api/orcid/start — Initiate ORCID OAuth for any mode
// ─────────────────────────────────────────────────────────────

router.post('/start', startLimiter, async (req: Request, res: Response) => {
  if (!config.orcidClientId || !config.orcidClientSecret) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'ORCID integration is not configured');
  }

  const startParsed = StartBodySchema.safeParse(req.body);
  if (!startParsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body');
  }
  const { mode } = startParsed.data;
  if (!mode || !isOrcidMode(mode)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'mode must be one of: signup, login, accredit, link');
  }

  // Authenticated modes require a valid session
  let username: string | undefined;
  if (AUTHENTICATED_MODES.has(mode)) {
    const authed = await authenticateRequest(req, res);
    if (!authed) return;
    username = authed;
  }

  // When mode === 'fresh_auth', the request body must
  // carry the per-op target. Closed-default at issuance: an SPA that
  // omits/malforms the target gets a 400, never a target-less proof.
  //
  // The `set_password`
  // action is non-broadcast (transitions state C → state B per
  // ARCHITECTURE.md § 6.3) and has no paper. The target binds to the
  // authenticated username via `root_author`; `root_permlink` is forced
  // empty so the resulting hash cannot collide with any consent-op proof
  // (consent ops require non-empty `root_permlink` at this layer). The
  // `delete_account` action (right-to-erasure exit, A/B/C/D → [no row] per
  // § 6.3) is the ORCID-mechanism issuance side for state C / state B / D.
  //
  // The name-only-route credit ops (`claim_authorship` / `approve_authorship`
  // / `revoke_authorship`) are the broadcast-side counterpart of the consent
  // ops here: they carry the paper via `paper_author` / `paper_permlink` and
  // (for claim/approve) a slot via `author_index`. The ORCID issuance side
  // serves state C (ORCID-only) and state B accounts; state A mints via
  // `POST /api/custody/fresh-auth`.
  let freshAuthTarget: FreshAuthTarget | undefined;
  if (mode === 'fresh_auth') {
    const { action } = startParsed.data;
    if (action === 'set_password' || action === 'change_email' || action === 'delete_account' || action === 'ipfs_upload' || action === 'edit_accreditation_metadata') {
      // Non-broadcast actions bind the target to the authenticated
      // username. The invariant "`username` is set when `mode === 'fresh_auth'`"
      // is enforced by middleware composition (`AUTHENTICATED_MODES`
      // membership + `authenticateRequest` above), not by the type system.
      // A future refactor that reorders or adds a new mode to
      // `AUTHENTICATED_MODES` without re-checking would silently let
      // `username = undefined` flow into the per-action helpers, producing
      // a proof bound to a string-ified undefined. Per
      // `agents/docs/solutions/conventions/validate-once-cache-secret-pattern-2026-05-11.md`,
      // prefer a structured runtime guard over a bare `!` for runtime-only
      // invariants — the cost is 3 dead lines, the benefit is compile-time-
      // enforced shape (the narrowed `username` is `string` after the guard).
      if (!username) {
        // ErrorCode union does not include AUTH_REQUIRED; UNAUTHORIZED is the
        // canonical 401 code used by `verifyHiveSignature` and the parallel
        // `authenticateRequest` helper above (see types/api.ts).
        return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required for fresh-auth action');
      }
      if (action === 'set_password') {
        freshAuthTarget = setPasswordFreshAuthTarget(username);
      } else if (action === 'delete_account') {
        // Non-broadcast target. Same shape as set_password / change_email:
        // target binds to (action, <authenticated username>, ''); request
        // body does not carry root_author / root_permlink. Helper enforces
        // the bind so a future refactor cannot re-introduce the inline literal.
        freshAuthTarget = deleteAccountFreshAuthTarget(username);
      } else if (action === 'ipfs_upload') {
        // Non-broadcast target for the ORCID-mechanism issuance side (state C
        // ORCID-only and state B). Binds to (ipfs_upload, <username>, ''),
        // consumed at POST /api/ipfs/upload-token on the JWT path.
        freshAuthTarget = ipfsUploadFreshAuthTarget(username);
      } else if (action === 'edit_accreditation_metadata') {
        // Self-service accreditation-metadata edit (ORCID-mechanism issuance;
        // serves state C ORCID-only + state B). Binds to
        // (edit_accreditation_metadata, <username>, ''), consumed at
        // PATCH /api/accreditation/metadata on the JWT path.
        freshAuthTarget = editAccreditationMetadataFreshAuthTarget(username);
      } else {
        // Non-broadcast target. Same shape as set_password / delete_account:
        // target binds to (action, <authenticated username>, ''); request body
        // does not carry root_author / root_permlink. Helper enforces the bind
        // so a future refactor cannot silently re-introduce the inline literal.
        freshAuthTarget = changeEmailFreshAuthTarget(username);
      }
    } else if (action === 'author_accept' || action === 'author_resign') {
      // Anchored-route consent ops. Field normalization (trim + length cap)
      // lives in the shared `extractConsentOpFields`, the same validator the
      // password issuance path and the broadcast consume side read through.
      // Routing this path through it closes the prior asymmetry where ORCID
      // validated with bare typeof/length checks (no trim, no cap), letting
      // uncapped values flow into the Redis state and hashing a value the
      // consume side would normalize differently.
      const extraction = extractConsentOpFields(action, startParsed.data as Record<string, unknown>);
      if (!extraction.ok) {
        return sendError(res, 400, 'VALIDATION_ERROR', `${extraction.field} is missing or invalid`);
      }
      freshAuthTarget = consentOpFreshAuthTarget(extraction.fields);
    } else if (action === 'claim_authorship' || action === 'approve_authorship' || action === 'revoke_authorship') {
      // Name-only-route credit ops (ORCID-mechanism issuance side; serves
      // state C ORCID-only + state B accounts). Field normalization (trim +
      // length cap) and the per-op required-field rules (author_index for
      // claim/approve, claimer for approve/revoke; `hive-schemas.md`
      // § 2.9–§ 2.11) live in the shared `extractCreditOpFields`, the same
      // validator the password issuance path and the broadcast consume side
      // read through. Routing this path through it closes the prior asymmetry
      // where ORCID validated with bare typeof/length checks (no trim, no cap),
      // letting uncapped values flow into the Redis state and hashing a value
      // the consume side would later reject as a self-inflicted
      // `target_mismatch`. Binding `claimer` on approve/revoke stops a minted
      // proof being redirected to a different co-author.
      const extraction = extractCreditOpFields(action, startParsed.data as Record<string, unknown>);
      if (!extraction.ok) {
        return sendError(res, 400, 'VALIDATION_ERROR', `${extraction.field} is missing or invalid`);
      }
      freshAuthTarget = creditOpFreshAuthTarget(extraction.fields);
    } else if (typeof action === 'string' && isAdminFreshAuthAction(action)) {
      // Roster-gated admin authority actions (ORCID-mechanism issuance side;
      // serves state C ORCID-only + state B admins). Per-actor like the
      // non-broadcast criticals: target binds to (action, <username>, ''),
      // consumed at the /api/admin/* route by requireFreshAdminAuth on the JWT
      // path. Same username guard as the non-broadcast branch above.
      if (!username) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required for fresh-auth action');
      }
      freshAuthTarget = adminActionFreshAuthTarget(action, username);
    } else {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        validFreshAuthActionsMessage({ includeSetPassword: true }),
      );
    }
  }

  const state = crypto.randomBytes(16).toString('hex');
  const stateKey = `${config.appTag}:orcid_state:${state}`;
  const stateData: Record<string, unknown> = { mode, timestamp: Date.now() };
  if (username) stateData.username = username;
  if (freshAuthTarget) stateData.fresh_auth_target = freshAuthTarget;

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(stateKey, JSON.stringify(stateData), 'EX', ORCID_STATE_TTL);
  } else {
    orcidStates.set(state, {
      mode,
      username,
      fresh_auth_target: freshAuthTarget,
      timestamp: Date.now(),
      expires: Date.now() + ORCID_STATE_TTL * 1000,
    });
  }

  const redirectUrl = `${config.orcidBaseUrl}/oauth/authorize?` +
    `client_id=${encodeURIComponent(config.orcidClientId)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('/authenticate')}` +
    `&redirect_uri=${encodeURIComponent(getRedirectUri())}` +
    `&state=${state}`;

  sendOk(res, { redirect_url: redirectUrl });
});

// ─────────────────────────────────────────────────────────────
// POST /api/orcid/callback — Complete ORCID OAuth for any mode
// ─────────────────────────────────────────────────────────────

router.post('/callback', callbackLimiter, async (req: Request, res: Response) => {
  if (!config.orcidClientId || !config.orcidClientSecret) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'ORCID integration is not configured');
  }

  const parsed = CallbackBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body');
  }
  const { code, state } = parsed.data;
  if (!code || !state) {
    return sendError(res, 400, 'BAD_REQUEST', 'code and state are required');
  }

  // State is read but not consumed until after auth passes, so a legitimate
  // initiator can retry /callback without being forced back through ORCID OAuth
  // if auth fails. The outer try/catch wraps state-read + auth + state-consume
  // + token-exchange so any infrastructure throw (Redis flap on GET/DEL, auth
  // dispatch error) becomes a clean 500 instead of an unhandled rejection; on
  // that path the DEL never runs, preserving state-not-consumed-on-error for
  // symmetry with the state-not-consumed-on-403 contract.
  const stateKey = `${config.appTag}:orcid_state:${state}`;
  const redis = getRedis();
  const redisReady = redis && isRedisAvailable();

  try {
    let storedMode: OrcidMode | null = null;
    let storedUsername: string | undefined;
    let storedFreshAuthTarget: FreshAuthTarget | undefined;

    if (redisReady) {
      const raw = await redis.get(stateKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as {
            mode: unknown;
            username?: string;
            fresh_auth_target?: FreshAuthTarget;
          };
          // Runtime membership guard on the deserialized
          // `mode`. A stale Redis entry written by a prior code version
          // carrying an unrecognized literal would otherwise fall out of the
          // dispatch switch at the end of this function and send no response.
          // The `isOrcidMode` predicate narrows `string` → `OrcidMode` so no
          // cast is needed on assignment.
          if (typeof parsed.mode !== 'string' || !isOrcidMode(parsed.mode)) {
            return sendError(res, 400, 'BAD_REQUEST', 'Unrecognized state mode');
          }
          storedMode = parsed.mode;
          storedUsername = parsed.username;
          storedFreshAuthTarget = parsed.fresh_auth_target;
        } catch {
          // Invalid stored state — fall through to BAD_REQUEST
        }
      }
    } else {
      const entry = orcidStates.get(state);
      if (entry && entry.expires > Date.now()) {
        storedMode = entry.mode;
        storedUsername = entry.username;
        storedFreshAuthTarget = entry.fresh_auth_target;
      }
    }

    if (!storedMode) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired state parameter');
    }

    // Authenticated modes: require the caller to be the same user that initiated /start.
    // Closes the state-hijack path where an attacker with a victim's state could complete
    // link/accredit with their own ORCID code and rewrite the victim's accreditation.
    if (AUTHENTICATED_MODES.has(storedMode)) {
      const callerUsername = await authenticateRequest(req, res);
      if (!callerUsername) return;
      if (callerUsername !== storedUsername) {
        return sendError(res, 403, 'FORBIDDEN', 'Callback caller does not match initiator');
      }
    }

    // Auth passed (or mode is public). Consume state now so it can't be replayed.
    if (redisReady) {
      await redis.del(stateKey);
    } else {
      orcidStates.delete(state);
    }

    // Exchange code for access token. Wrapped in
    // `fetchWithOrcidTimeout` so an ORCID provider hang surfaces as a
    // 504 ORCID_PROVIDER_TIMEOUT (mapped at the outer catch) rather
    // than blocking the handler indefinitely.
    const tokenRes = await fetchWithOrcidTimeout(`${config.orcidBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.orcidClientId,
        client_secret: config.orcidClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: getRedirectUri(),
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      logger.error(
        {
          event: 'orcid.callback.token_exchange_failed',
          route: 'orcid.callback',
          status: tokenRes.status,
          body: errBody,
        },
        'ORCID token exchange failed',
      );
      return sendError(res, 400, 'BAD_REQUEST', 'Failed to exchange authorization code');
    }

    const tokenData = await tokenRes.json() as { orcid: string; name?: string; access_token?: string };
    const orcidId = tokenData.orcid;
    if (!orcidId) {
      return sendError(res, 400, 'BAD_REQUEST', 'ORCID response missing orcid field');
    }
    if (!ORCID_RE.test(orcidId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
    }

    const orcidName = tokenData.name || '';

    // Dispatch to mode handler
    switch (storedMode) {
      case 'signup':
        return await handleSignup(res, orcidId, orcidName, tokenData.access_token);
      case 'login':
        return await handleLogin(res, orcidId);
      case 'accredit':
        return await handleAccredit(res, orcidId, orcidName, storedUsername!, tokenData.access_token);
      case 'link':
        return await handleLink(res, orcidId, storedUsername!);
      case 'fresh_auth':
        // storedFreshAuthTarget must be present at this
        // point because /start enforces it on entry. If somehow absent
        // (corrupt Redis state, future refactor regression), reject as
        // BAD_REQUEST rather than minting a target-less proof.
        if (!storedFreshAuthTarget) {
          return sendError(
            res,
            400,
            'BAD_REQUEST',
            'fresh_auth state is missing the per-op target binding',
          );
        }
        return await handleFreshAuth(res, orcidId, storedUsername!, storedFreshAuthTarget);
      case 'session_auth':
        // Target-less session-kind proof issuance — used by the non-consent
        // broadcast surface where per-op target binding is not required.
        // Same (orcidId, username) binding check as fresh_auth.
        return await handleSessionAuth(res, orcidId, storedUsername!);
      default:
        // Explicit `assertNever` so a future arm added to
        // `OrcidMode` without a switch case fails at compile time instead
        // of falling off the end of the switch body and sending no
        // response. Matches the pattern at the three other switches in
        // this file (handleAccredit / handleLink failedStep / lock state).
        return assertNever(storedMode);
    }
  } catch (err) {
    // Surface ORCID provider hangs as 504 with a
    // structured `details` block, distinct from generic 500s. The
    // closed-enum payload (`outcome: 'timeout'`, `verify_before_retry:
    // true`) signals to the SPA that retrying immediately is unsafe —
    // the broadcast may have started on the provider side and a retry
    // could double-spend the auth code.
    if (err instanceof OrcidProviderTimeoutError) {
      logger.error(
        {
          event: 'orcid.callback.provider_timeout',
          route: 'orcid.callback',
          err,
        },
        'ORCID callback failed — provider timeout',
      );
      sendError(
        res,
        504,
        'ORCID_PROVIDER_TIMEOUT',
        'ORCID provider did not respond in time. Please retry after verifying your ORCID account state.',
        { retriable: false, outcome: 'timeout', verify_before_retry: true },
      );
      return;
    }
    logger.error(
      { event: 'orcid.callback.failed', route: 'orcid.callback', err },
      'ORCID callback failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'ORCID verification failed');
  }
});

// ─────────────────────────────────────────────────────────────
// Mode handlers
// ─────────────────────────────────────────────────────────────

async function handleSignup(
  res: Response,
  orcidId: string,
  orcidName: string,
  accessToken?: string,
): Promise<void> {
  // Belt-and-suspenders format guard matching handleLogin / handleAccredit /
  // handleLink. The dispatch site in POST /callback already guards; this inner
  // check removes the handler-guard asymmetry where only the dispatch site
  // validated, and — specifically for signup — is the only handler that feeds orcidId
  // into a URL-path interpolation (countExternalWorks → pub.orcid.org).
  // Keeping the guard here locks in the mutation-kill for the signup path so
  // the dispatch-site guard is not the sole defense.
  if (!ORCID_RE.test(orcidId)) {
    sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
    return;
  }

  const externalWorksCount = await countExternalWorks(orcidId, accessToken);

  if (externalWorksCount < config.orcidMinWorks) {
    sendError(res, 422, 'VALIDATION_ERROR',
      `ORCID profile has ${externalWorksCount} externally-sourced work(s), but at least ${config.orcidMinWorks} are required`,
      { required: config.orcidMinWorks, have: externalWorksCount });
    return;
  }

  // Store verified ORCID data with nonce
  const nonce = crypto.randomBytes(16).toString('hex');
  const verifiedData = { orcid_id: orcidId, works_count: externalWorksCount, name: orcidName };

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(verifiedData), 'EX', ORCID_VERIFIED_TTL);
  } else {
    orcidVerified.set(nonce, { ...verifiedData, expires: Date.now() + ORCID_VERIFIED_TTL * 1000 });
  }

  sendOk(res, {
    mode: 'signup',
    orcid_token: nonce,
    orcid_id: orcidId,
    works_count: externalWorksCount,
    name: orcidName,
  });
}

async function handleLogin(res: Response, orcidId: string): Promise<void> {
  if (!ORCID_RE.test(orcidId)) {
    sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
    return;
  }

  const pool = getAppPool();
  if (!pool) {
    sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');
    return;
  }

  // `accounts.custody` is `TEXT` (nullable) in the schema. The
  // `WHERE username IS NOT NULL` filter excludes states E/F, so this
  // query only matches finalized rows (A/B/C/D) where `custody` is
  // set. Annotate the column as `string | null` per the wrapping-
  // primitive convention; this honest-types the column's nullability
  // as belt-and-suspenders if the filter ever drops, not a defense
  // against a currently-reachable null row.
  const result = await pool.query<{ username: string; custody: string | null }>(
    `SELECT username, custody FROM accounts WHERE orcid = $1 AND username IS NOT NULL LIMIT 1`,
    [orcidId],
  );

  if (result.rows.length === 0) {
    // NO_ACCOUNT 409/404 carries no payload. The prior `{ orcid_id }` details
    // field was never consumed by any frontend handler — the caller
    // already knows which ORCID they submitted, so echoing it back is
    // redundant. The contract (api-contracts/orcid.md) previously
    // documented it as a top-level sibling of `error`, which the
    // sendError envelope does not produce; the mismatch was
    // audit-hygiene noise with no runtime impact. Architect updates
    // the contract during re-review.
    sendError(res, 404, 'NO_ACCOUNT', 'No account linked to this ORCID. Please sign up first.');
    return;
  }

  const account = result.rows[0];
  // Mint the JWT with the actual DB value rather than coercing to
  // `'light'` — the row matched by this query is finalized, so
  // `account.custody` is `'light'` or `'self'` (states A/B/C/D per
  // ARCHITECTURE.md § 6.1). The `null` branch in the column type is
  // unreachable here; the state-C passwordless shape (password_hash
  // NULL) is defended at /upgrade per the § 6.4 re-auth contract,
  // not by this annotation.
  const token = jwt.sign(
    { sub: account.username, custody: account.custody },
    config.sessionSecret,
    { expiresIn: '24h' },
  );
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  sendOk(res, {
    mode: 'login',
    token,
    expires_at: expiresAt,
    custody: account.custody,
    username: account.username,
  });
}

async function handleAccredit(
  res: Response,
  orcidId: string,
  orcidName: string,
  username: string,
  accessToken?: string,
): Promise<void> {
  if (!ORCID_RE.test(orcidId)) {
    sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
    return;
  }

  // Check if already accredited
  const { getAccreditedSet, hasUnliftedSanction, SANCTIONED_ACCREDIT_MESSAGE } = await import('../accreditation.js');
  const accreditedSet = await getAccreditedSet([username]);
  if (accreditedSet.has(username)) {
    sendError(res, 422, 'VALIDATION_ERROR', 'Account is already accredited');
    return;
  }

  // Ever-sanctioned guard: a self-service ORCID accreditation must NOT lift a
  // moderation sanction (only a deliberate admin accredit lifts it). A sanctioned
  // account is absent from getAccreditedSet, so the already-accredited check above
  // does not catch it; refuse here before the works-count probe and broadcast.
  if (await hasUnliftedSanction(username)) {
    logger.info({ username }, 'orcid accreditation refused — account has an un-lifted sanction');
    sendError(res, 403, 'ACCREDITATION_SANCTIONED', SANCTIONED_ACCREDIT_MESSAGE);
    return;
  }

  const externalWorksCount = await countExternalWorks(orcidId, accessToken);

  if (externalWorksCount < config.orcidMinWorks) {
    sendError(res, 422, 'VALIDATION_ERROR',
      `ORCID profile has ${externalWorksCount} externally-sourced work(s), but at least ${config.orcidMinWorks} are required`,
      { required: config.orcidMinWorks, have: externalWorksCount });
    return;
  }

  if (!config.pevoAdminPostingKey) {
    sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
    return;
  }

  const existingBinding = await findAccreditedAccountWithOrcid(orcidId);
  if (existingBinding && existingBinding !== username) {
    // Durable-binding 409: the ORCID is bound to another account on-chain or
    // in the HAF-lag cache. All `ORCID_ALREADY_LINKED` 409 paths share the
    // same wire shape (status 409, code `ORCID_ALREADY_LINKED`, no `retriable`,
    // no `Retry-After`, no `retry_after_seconds`); the cache-lag, durable, and
    // same-tick lock-contention causes are deliberately wire-indistinguishable
    // because all three are terminal from the user's perspective (the OAuth
    // state token has either been consumed or will be on the next attempt;
    // restart the ORCID flow). Cause discrimination is server-side telemetry
    // only — see `agents/docs/api-contracts/orcid.md` (the ORCID_ALREADY_LINKED
    // section) for the three causes and `withOrcidBindingLock`'s `'held'` branch
    // for the contention anchor.
    sendError(res, 409, 'ORCID_ALREADY_LINKED', 'This ORCID is already linked to another account');
    return;
  }

  // Split into two opts shapes:
  //   * accreditErrorOpts — non-ambiguous variant for fn's inner catch (acquired
  //     branch's BroadcastTimeoutError → 504 timer-fire envelope; non-timeout
  //     broadcast error → 502 BROADCAST_FAILED). The discriminated union forbids
  //     `ambiguousMsg` on this variant so a stray field is a compile error.
  //   * accreditAmbiguousOpts — ambiguous variant for the wrapper's outer catch
  //     on the 'unavailable' branch and for non-timeout
  //     broadcast errors re-thrown from the same branch. `forceAmbiguousOutcome:
  //     true` + `ambiguousMsg` are required by the discriminated union; the
  //     earlier `ambiguousMsg ?? failMsg` fallback is gone.
  const accreditErrorOpts: HandleBroadcastErrorOpts = {
    timeoutMsg: 'Broadcasting ORCID accreditation timed out',
    failMsg: 'Failed to broadcast ORCID accreditation to Hive',
    logContext: { username, orcid: orcidId, mode: 'accredit' },
    verifyLocation: '/settings',
    routeLabel: 'orcid.handleAccredit',
    // Post-broadcast outcome discrimination: 502 POST_BROADCAST_FAILED
    // user-facing message, tailored per cascade step. Recovery
    // semantics differ by step, and a single
    // "HAF will reconcile" line overpromises auto-recovery: only
    // `'reputation_seed'` reconciles via the next batch cycle; `'cache_write'`
    // is repopulated by the next request that needs the binding;
    // `'account_update'` is a denormalized projection with NO auto-reconcile
    // path (a missed write requires HAF-replay, not currently implemented, or
    // manual operator re-run). The message is honest about that without
    // alarming users — the chain state is durable and ORCID-based login
    // lookups via HAF still work; only the denormalized accounts.orcid column
    // is potentially stale until a manual reconcile lands.
    // Switch + `assertNever` (not nested ternary). Adding a
    // 4th `PostBroadcastFailedStep` member would silently route to the
    // account_update tail under the prior `else`-fallback shape — exactly the
    // drift class the discriminated-union convention exists to prevent. The
    // switch makes the union exhaustively pinned at compile time.
    postBroadcastMsgFn: (failedStep: PostBroadcastFailedStep) => {
      switch (failedStep) {
        case 'reputation_seed':
          return 'Your ORCID is verified on Hive. Your reputation score will update at the next scheduled cycle.';
        case 'cache_write':
          return 'Your ORCID is verified on Hive. A backend cache write failed; it will repopulate on the next request that uses your ORCID binding.';
        case 'account_update':
          return 'Your ORCID is verified on Hive. A backend account update failed; the chain record is the source of truth, and login still works. The denormalized account record may be stale until support reconciles it.';
        default:
          return assertNever(failedStep);
      }
    },
  };
  const accreditAmbiguousOpts: HandleBroadcastErrorAmbiguousOpts = {
    ...accreditErrorOpts,
    forceAmbiguousOutcome: true,
    ambiguousMsg: 'Broadcast outcome uncertain. Verify your ORCID linkage at /settings before retrying.',
  };

  await withOrcidBindingLock(res, orcidId, async (lockState) => {
    const customJsonPayload = {
      action: 'accredit',
      account: username,
      name: orcidName || username,
      institution: '',
      field: '',
      method: 'orcid',
      orcid: orcidId,
      evidence_hash: crypto.createHash('sha256').update(`orcid:${orcidId}:${username}`).digest('hex'),
      // Issued by the admin account (the accreditor); see AccreditAction.
      issued_by: config.hiveAdminAccount,
      timestamp: new Date().toISOString(),
    };

    // Admin-key validation parse, deliberately OUTSIDE the inner try: a
    // malformed-key throw must escape fn synchronously to
    // withOrcidBindingLock's acquired/unavailable-branch catch (504
    // ambiguous-outcome envelope + lock release) rather than land in the
    // inner catch as a 502 BROADCAST_FAILED. broadcastAdminCustomJson
    // re-parses the key internally; the parse result is discarded here.
    // The helper's AdminKeyNotConfiguredError (unset key) is unreachable on
    // this path: the pre-lock guard above already returns 500 when
    // config.pevoAdminPostingKey is unset.
    PrivateKey.fromString(config.pevoAdminPostingKey);
    let result;
    try {
      result = await broadcastAdminCustomJson(customJsonPayload);
    } catch (err) {
      if (err instanceof BroadcastTimeoutError) {
        // Lock-TTL extension on timeout. The extend-or-log helper MUST run
        // BEFORE handleBroadcastError writes the response, because the
        // response-write is the last thing inside fn and a malicious caller
        // terminating the connection mid-write could otherwise escape fn
        // before the extend completes. Returning { skipRelease: true }
        // signals withOrcidBindingLock NOT to delete the extended lock in
        // finally; the lock auto-expires at the extended TTL, blocking
        // concurrent binds for the same orcid_id during the window in which
        // our broadcast may still be on-chain unindexed. Non-timeout throws
        // (rethrown below) flow through the wrapper's normal release path.
        // Failure-mode robustness + observability collapsed into the helper.
        await __test_seams.extendBindingLockOnTimeoutOrLog(orcidId, 'orcid.handleAccredit');
        handleBroadcastError(res, err, accreditErrorOpts);
        return { skipRelease: true };
      }
      // On the 'unavailable' branch ANY throw is
      // outcome-ambiguous (no lock-TTL margin, no binding cache to dedup
      // against). Re-throw non-timeout broadcast errors so the wrapper's
      // outer catch emits the 504 ambiguous-outcome envelope via
      // handleBroadcastErrorAmbiguous. On the 'acquired' branch the
      // existing 502 BROADCAST_FAILED envelope still fires (the lock and
      // cache-write provide the dedup signal a retry would need to be
      // safe). Single source of truth for the ambiguous-outcome envelope.
      if (lockState === 'unavailable') {
        throw err;
      }
      handleBroadcastError(res, err, accreditErrorOpts);
      return;
    }

    // Post-broadcast cascade. The chain op is now confirmed (broadcast
    // returned {id}). Any throw inside this block is a downstream cascade
    // failure, NOT an ambiguous-outcome class — discriminate via
    // PostBroadcastWriteError so the wrapper's catch emits 502
    // POST_BROADCAST_FAILED with `outcome:'confirmed'` + `tx_id` +
    // `failed_step` instead of the over-cautious 504. `currentStep` advances
    // before each await so the catch attaches the precise step.
    // (This is the post-broadcast outcome-discrimination contract.)
    //
    // Dead-defense note: the three cascade fns currently
    // swallow their async errors internally — `cacheOrcidBinding` warns and
    // returns, `__test_seams.updateAccountOrcid` (== `updateAccountOrcid`)
    // logs and returns, `seedAccreditationBonus` logs and returns. The
    // wrapping try fires only on a synchronous JS-engine throw (e.g. a
    // future refactor returning null where a method is expected) or if a
    // future cascade-fn refactor switches to re-throwing critical errors.
    // Kept structurally because (a) the discrimination shape is the canonical
    // surface for the broader send-operations outcome-handling work to reuse,
    // and (b) tightening cascade-fn error semantics is a separate, wider scope.
    // A test that exercises the discrimination via __test_seams (see
    // tests/routes/orcid.test.ts post-broadcast specs) is the live proof the
    // path remains wired.
    // Typed as the full `PostBroadcastFailedStep` union as
    // an *intent signal* — handleAccredit's cascade can advance through every
    // member of the union (cache_write → account_update → reputation_seed),
    // so widening to a future 4th member is a deliberate annotation choice,
    // not compile-time enforcement. The compile-time enforcement against
    // forgotten union extensions lives at handleLink's `Extract<>` narrowing
    // below — when a 4th member is added that is reachable from link mode,
    // that site is what fails to compile and forces the question. Enforcement
    // lives only at the handleLink site, not here.
    let currentStep: PostBroadcastFailedStep = 'cache_write';
    try {
      // Cache the binding so a concurrent bind request in the HAF-lag window sees
      // it via findAccreditedAccountWithOrcid() before the chain op is indexed.
      await cacheOrcidBinding(orcidId, username);
      currentStep = 'account_update';

      // Update orcid column in accounts (if light account row exists)
      // Routed through __test_seams so a unit spec can spy on this call
      // (replaces the fragile getAppPool() Once-stack).
      await __test_seams.updateAccountOrcid(username, orcidId);
      currentStep = 'reputation_seed';

      await seedAccreditationBonus(username);
    } catch (postErr) {
      // Classify the re-thrown cascade error at the wrap site so
      // handleBroadcastError emits 502 POST_BROADCAST_OPERATOR_REQUIRED
      // (with the "please contact support" copy) for the permanent-class
      // union — TypeError / SyntaxError / RangeError, AppPoolNotInitialisedError,
      // or PostgreSQL 23xxx/42xxx — and 502 POST_BROADCAST_FAILED (with
      // the "will reconcile automatically" copy) for everything else.
      // The three cascade fns above already filter and only re-throw
      // permanent-class errors per the cascade-fn permanent-error rethrow
      // convention, but the
      // `'transient'` branch is NOT dead code — `updateAccountOrcid`'s
      // pre-pool guard throws before its per-error filter runs, so a
      // sentinel-less pool-missing throw would have leaked as transient.
      // The sentinel + classifier pairing closes that path. The remaining
      // `'transient'` branch defends against a future cascade-fn refactor
      // that loosens the re-throw contract (e.g. starts re-throwing
      // transient HAF errors), keeping the user-message accurate across
      // that refactor surface.
      throw new PostBroadcastWriteError(
        result.id,
        postErr,
        currentStep,
        classifyPostBroadcastSeverity(postErr),
      );
    }

    sendOk(res, {
      mode: 'accredit',
      message: 'Accreditation via ORCID confirmed',
      username,
      orcid: orcidId,
      tx_id: result.id,
    });
  }, accreditAmbiguousOpts);
}

async function handleLink(
  res: Response,
  orcidId: string,
  username: string,
): Promise<void> {
  if (!ORCID_RE.test(orcidId)) {
    sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
    return;
  }

  // Fetch existing accreditation to preserve fields
  const existing = await getExistingAccreditation(username);
  if (!existing) {
    sendError(res, 422, 'VALIDATION_ERROR', 'Account is not accredited');
    return;
  }

  if (!config.pevoAdminPostingKey) {
    sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
    return;
  }

  const existingBinding = await findAccreditedAccountWithOrcid(orcidId);
  if (existingBinding && existingBinding !== username) {
    // Durable-binding 409. Wire shape is shared across all
    // `ORCID_ALREADY_LINKED` 409 paths (no `retriable`, no `Retry-After`); see
    // handleAccredit counterpart and `agents/docs/api-contracts/orcid.md`
    // (the ORCID_ALREADY_LINKED section).
    sendError(res, 409, 'ORCID_ALREADY_LINKED', 'This ORCID is already linked to another account');
    return;
  }

  // See handleAccredit counterpart for split-opts rationale.
  const linkErrorOpts: HandleBroadcastErrorOpts = {
    timeoutMsg: 'Broadcasting ORCID link timed out',
    failMsg: 'Failed to broadcast ORCID link to Hive',
    logContext: { username, orcid: orcidId, mode: 'link' },
    verifyLocation: '/settings',
    routeLabel: 'orcid.handleLink',
    // Post-broadcast outcome discrimination: per-step user-facing
    // message — see handleAccredit counterpart for full rationale.
    // handleLink does NOT seed reputation, so `'reputation_seed'`
    // is unreachable from this route in practice; the switch covers it
    // exhaustively for type safety (and the message degrades gracefully to
    // the account_update phrasing — that was the prior implicit behavior
    // under the else-fallback ternary). Switch + assertNever
    // (not nested ternary) so a 4th union member surfaces as a compile error
    // rather than silently routing to the account_update tail.
    postBroadcastMsgFn: (failedStep: PostBroadcastFailedStep) => {
      switch (failedStep) {
        case 'cache_write':
          return 'Your ORCID is linked on Hive. A backend cache write failed; it will repopulate on the next request that uses your ORCID binding.';
        case 'account_update':
          return 'Your ORCID is linked on Hive. A backend account update failed; the chain record is the source of truth, and login still works. The denormalized account record may be stale until support reconciles it.';
        case 'reputation_seed':
          return 'Your ORCID is linked on Hive. A backend account update failed; the chain record is the source of truth, and login still works. The denormalized account record may be stale until support reconciles it.';
        default:
          return assertNever(failedStep);
      }
    },
  };
  const linkAmbiguousOpts: HandleBroadcastErrorAmbiguousOpts = {
    ...linkErrorOpts,
    forceAmbiguousOutcome: true,
    ambiguousMsg: 'Broadcast outcome uncertain. Verify your ORCID linkage at /settings before retrying.',
  };

  await withOrcidBindingLock(res, orcidId, async (lockState) => {
    const customJsonPayload = {
      action: 'accredit',
      account: username,
      name: existing.name,
      institution: existing.institution,
      field: existing.field,
      method: existing.method,
      orcid: orcidId,
      evidence_hash: crypto.createHash('sha256').update(`orcid:${orcidId}:${username}`).digest('hex'),
      // Issued by the admin account (the accreditor); see AccreditAction.
      issued_by: config.hiveAdminAccount,
      timestamp: new Date().toISOString(),
    };

    // Admin-key validation parse outside the inner try — see handleAccredit
    // counterpart for the failure-shape rationale (synchronous escape to the
    // wrapper's 504 ambiguous-outcome catch + lock release).
    PrivateKey.fromString(config.pevoAdminPostingKey);
    let result;
    try {
      result = await broadcastAdminCustomJson(customJsonPayload);
    } catch (err) {
      if (err instanceof BroadcastTimeoutError) {
        // See handleAccredit counterpart for the full rationale (lock-TTL
        // extension on timeout; helper before handleBroadcastError; skipRelease
        // signals withOrcidBindingLock to leave the extended lock alone).
        await __test_seams.extendBindingLockOnTimeoutOrLog(orcidId, 'orcid.handleLink');
        handleBroadcastError(res, err, linkErrorOpts);
        return { skipRelease: true };
      }
      // See handleAccredit counterpart.
      if (lockState === 'unavailable') {
        throw err;
      }
      handleBroadcastError(res, err, linkErrorOpts);
      return;
    }

    // Post-broadcast cascade — see handleAccredit counterpart for rationale.
    // handleLink does NOT call seedAccreditationBonus (only handleAccredit
    // seeds; link is for already-accredited accounts), so the step enum
    // narrows to 'cache_write' | 'account_update'. The 'reputation_seed'
    // value is reserved for handleAccredit. (Both step labels remain in
    // PostBroadcastWriteError's union for sweep-extensibility.)
    // Typed as the link-narrow Extract over
    // `PostBroadcastFailedStep` — handleLink's cascade does not seed
    // reputation, so `'reputation_seed'` is structurally unreachable here.
    // Adding a 4th union member surfaces as a compile error if it would
    // be reachable from link mode.
    let currentStep: Extract<PostBroadcastFailedStep, 'cache_write' | 'account_update'> = 'cache_write';
    try {
      // Cache the binding so a concurrent bind request in the HAF-lag window sees
      // it via findAccreditedAccountWithOrcid() before the chain op is indexed.
      await cacheOrcidBinding(orcidId, username);
      currentStep = 'account_update';

      // Update orcid column in accounts (if light account row exists)
      // Routed through __test_seams so a unit spec can spy on this call
      // (replaces the fragile getAppPool() Once-stack).
      await __test_seams.updateAccountOrcid(username, orcidId);
    } catch (postErr) {
      // See handleAccredit counterpart for full rationale. handleLink's
      // cascade is narrower (no seedAccreditationBonus step), but the
      // classification helper applies uniformly across the failing-step
      // union — TypeError / SyntaxError / RangeError, AppPoolNotInitialisedError,
      // or PostgreSQL 23xxx/42xxx → `'permanent'` →
      // POST_BROADCAST_OPERATOR_REQUIRED with the "please contact support"
      // copy; everything else → `'transient'` → POST_BROADCAST_FAILED with
      // the "will reconcile automatically" copy.
      throw new PostBroadcastWriteError(
        result.id,
        postErr,
        currentStep,
        classifyPostBroadcastSeverity(postErr),
      );
    }

    sendOk(res, {
      mode: 'link',
      message: 'ORCID linked successfully',
      username,
      orcid: orcidId,
      tx_id: result.id,
    });
  }, linkAmbiguousOpts);
}

// ─────────────────────────────────────────────────────────────
// handleFreshAuth — fresh-auth via ORCID
// ─────────────────────────────────────────────────────────────
//
// Authenticated mode that completes a fresh OAuth round-trip and mints a
// single-use fresh-auth proof bound to the JWT subject. Consumed by the
// custody-broadcast handler when broadcasting `author_accept` /
// `author_resign` ops. Sibling to POST /api/custody/fresh-auth (password
// path).
//
// Security invariant: the OAuth-returned `orcidId` MUST equal
// `accounts.orcid` for the JWT subject. Without this check, a user could
// authenticate via any ORCID they control and issue a token for an account
// whose ORCID linkage is unrelated. Mismatch returns 403 to mirror the
// `accredit`/`link` mode contracts that require ORCID-account binding.

async function handleFreshAuth(
  res: Response,
  orcidId: string,
  username: string,
  target: FreshAuthTarget,
): Promise<void> {
  if (!ORCID_RE.test(orcidId)) {
    sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
    return;
  }

  const pool = getAppPool();
  if (!pool) {
    sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');
    return;
  }

  const result = await pool.query<{ orcid: string | null }>(
    'SELECT orcid FROM accounts WHERE username = $1 LIMIT 1',
    [username],
  );
  if (result.rows.length === 0) {
    sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
    return;
  }
  const accountOrcid = result.rows[0].orcid;
  if (!accountOrcid || accountOrcid !== orcidId) {
    // Fresh-auth via ORCID requires the OAuth round-trip to be for the
    // ORCID linked to the account. This is the symmetric guard to the
    // `link`/`accredit` mode rule that an ORCID belongs to one account.
    sendError(res, 403, 'FORBIDDEN', 'The ORCID you authenticated with is not linked to this account.');
    return;
  }

  const issued = await issueFreshAuthToken(username, 'orcid', target);
  // Echo the bound target so the SPA can cache the issued proof keyed on its
  // actual binding. `target` is non-null here: the dispatch-site defensive 400
  // (search for `fresh_auth state is missing the per-op target binding`) fires
  // BEFORE handleFreshAuth, so `storedFreshAuthTarget` is guaranteed defined at
  // the call site that passes it in. Without this echo, the frontend's
  // `cacheConsentOpProof` helper writes the cache entry with undefined target
  // fields and the subsequent strict-equality lookup becomes a permanent no-op.
  // The optional credit-op fields (`author_index` for claim/approve, `claimer`
  // for approve/revoke) are echoed only when bound so the SPA can confirm the
  // proof is pinned to the intended slot and co-author rather than a substitute.
  sendOk(res, {
    mode: 'fresh_auth',
    fresh_auth_proof: issued.token,
    expires_at: issued.expires_at,
    mechanism: issued.mechanism,
    action: target.action,
    root_author: target.root_author,
    root_permlink: target.root_permlink,
    ...(target.author_index !== undefined ? { author_index: target.author_index } : {}),
    ...(target.claimer !== undefined ? { claimer: target.claimer } : {}),
  });
}

// ─────────────────────────────────────────────────────────────
// handleSessionAuth — mints a target-less ORCID-mechanism session-kind
// fresh-auth proof for the non-consent broadcast surface.
// ─────────────────────────────────────────────────────────────
//
// Sibling of handleFreshAuth that mints a target-less session-kind proof.
// Consumed by the non-consent `/api/custody/broadcast` path. Sibling
// constraint to fresh_auth: the OAuth-returned `orcidId` MUST equal the
// `accounts.orcid` linked to the JWT subject. Without this check, a user
// could authenticate via any ORCID they control and issue a token for an
// account whose ORCID linkage is unrelated.

async function handleSessionAuth(
  res: Response,
  orcidId: string,
  username: string,
): Promise<void> {
  if (!ORCID_RE.test(orcidId)) {
    sendError(res, 400, 'BAD_REQUEST', 'Invalid ORCID iD format');
    return;
  }

  const pool = getAppPool();
  if (!pool) {
    sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');
    return;
  }

  // Scoped try/catch on the DB lookup so a Postgres
  // connection error surfaces as a discriminated 500 with the structured
  // `orcid.session_auth.db_failed` event slug rather than propagating to
  // the outer `/callback` catch (which would emit a generic
  // `orcid.callback.failed` log indistinguishable from token-exchange or
  // dispatch failures). Mirrors the sibling-handler discriminator pattern.
  let result;
  try {
    result = await pool.query<{ orcid: string | null }>(
      'SELECT orcid FROM accounts WHERE username = $1 LIMIT 1',
      [username],
    );
  } catch (err) {
    logger.error(
      { event: 'orcid.session_auth.db_failed', route: 'orcid.handleSessionAuth', username, err },
      'ORCID session-auth DB lookup failed',
    );
    sendError(res, 500, 'INTERNAL_ERROR', 'Session authentication failed');
    return;
  }
  if (result.rows.length === 0) {
    sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
    return;
  }
  const accountOrcid = result.rows[0].orcid;
  if (!accountOrcid || accountOrcid !== orcidId) {
    sendError(res, 403, 'FORBIDDEN', 'The ORCID you authenticated with is not linked to this account.');
    return;
  }

  const issued = await issueSessionFreshAuthToken(username, 'orcid');
  sendOk(res, {
    mode: 'session_auth',
    fresh_auth_proof: issued.token,
    expires_at: issued.expires_at,
    mechanism: issued.mechanism,
  });
}

// ─────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────

async function countExternalWorks(orcidId: string, _accessToken?: string): Promise<number> {
  // Same timed-fetch wrapper as the token-exchange call. A hang here
  // propagates `OrcidProviderTimeoutError` up through `handleSignup` /
  // `handleAccredit`, where the outer /callback catch maps it to a 504
  // ORCID_PROVIDER_TIMEOUT.
  const worksRes = await fetchWithOrcidTimeout(`${config.orcidApiBaseUrl}/v3.0/${orcidId}/works`, {
    headers: { Accept: 'application/json' },
  });

  if (!worksRes.ok) {
    logger.error(
      {
        event: 'orcid.works_fetch.failed',
        route: 'orcid.works-fetch',
        orcidId,
        status: worksRes.status,
      },
      'ORCID works fetch failed',
    );
    throw new Error('Failed to fetch ORCID works');
  }

  const worksData = await worksRes.json() as {
    group?: Array<{
      'work-summary'?: Array<{
        source?: { 'source-orcid'?: { path?: string } };
      }>;
    }>;
  };

  // Count works where source ORCID differs from profile owner (externally sourced).
  // Self-asserted works have source-orcid.path === the profile owner's ORCID iD.
  // External sources (Crossref, Scopus, DataCite) have a different source-orcid.path.
  let count = 0;
  if (worksData.group) {
    for (const group of worksData.group) {
      const summaries = group['work-summary'] || [];
      const hasExternalSource = summaries.some((s) => {
        const sourceOrcid = s.source?.['source-orcid']?.path;
        return sourceOrcid && sourceOrcid !== orcidId;
      });
      if (hasExternalSource) count++;
    }
  }
  return count;
}

async function getExistingAccreditation(username: string): Promise<{
  name: string; institution: string; field: string; method: string; orcid?: string;
} | null> {
  const pool = getPool();
  if (!pool) return null;

  // Filter by accreditationAuthorities so a self-broadcast custom_json (signed
  // by the target account's own posting key) cannot masquerade as a real
  // accreditation and unlock the /link flow.
  // `cj.id DESC` is the same-block deterministic tie-breaker (monotonic HAF op
  // id) per the custom-json hive-primitive design-rules convention, so a
  // same-block accredit/revoke resolves to the later op.
  const result = await pool.query(
    `SELECT cj.json FROM ${T.customJson} cj
     WHERE cj.custom_id = $2
       AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
       AND cj.json::jsonb ->> 'account' = $1
       AND cj.required_posting_auths ?| $3::text[]
     ORDER BY cj.block_num DESC, cj.id DESC
     LIMIT 1`,
    [username, config.appTag, config.accreditationAuthorities],
  );
  if (result.rows.length === 0) return null;

  const payload = typeof result.rows[0].json === 'string'
    ? JSON.parse(result.rows[0].json)
    : result.rows[0].json;

  if (payload.action === 'revoke') return null;
  return {
    name: payload.name || username,
    institution: payload.institution || '',
    field: payload.field || '',
    method: payload.method || 'email',
    orcid: payload.orcid || undefined,
  };
}

/**
 * Classify a thrown DB error as permanent (operator-actionable, deploy
 * regression) or transient (single-blip, recoverable on retry).
 *
 * Cascade-fn permanent-error rethrow convention: the cascade fns
 * (`updateAccountOrcid`, `seedAccreditationBonus`) re-throw permanent errors
 * so the post-broadcast discrimination machinery surfaces real 502
 * POST_BROADCAST_FAILED envelopes for operator alerting; transient errors
 * stay swallowed (next-request or next-cycle reconciles).
 *
 * pg SQLSTATE classes deemed permanent here:
 *   - `23*` integrity_constraint_violation (FK violation, NOT NULL violation,
 *     unique violation, check constraint failure) — schema/data invariant
 *     drifted from what the code expects; deploy regression.
 *   - `42*` syntax_error_or_access_rule_violation (undefined_column,
 *     undefined_table, datatype_mismatch, insufficient_privilege) — column
 *     renamed/dropped or migration not applied; deploy regression.
 *
 * Transient (NOT classified as permanent):
 *   - `08*` connection_exception — network blip; next request reconnects.
 *   - `40001` serialization_failure / `40P01` deadlock — concurrent-update
 *     race; next request typically succeeds.
 *   - Pool-exhaustion-like errors (no SQLSTATE; surfaces as Node Error) —
 *     transient unless sustained, which manifests as repeated occurrences
 *     in the operator-facing log stream.
 */
function isPermanentDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return code.startsWith('23') || code.startsWith('42');
}

async function updateAccountOrcid(username: string, orcidId: string): Promise<void> {
  const pool = getAppPool();
  if (!pool) {
    // Permanent: app pool not initialised. Throw the named-sentinel
    // AppPoolNotInitialisedError so the post-broadcast cascade wrap's
    // classifyPostBroadcastSeverity helper returns 'permanent' and the
    // route emits 502 POST_BROADCAST_OPERATOR_REQUIRED ("please contact
    // support") instead of 502 POST_BROADCAST_FAILED ("will reconcile
    // automatically"). A bare `new Error(...)` here would fall through the
    // helper's Error.code-based branch to 'transient' and mis-route to the
    // self-healing copy, but no reconciler exists for an uninitialised pool
    // — the pool must come back up first, which requires operator action.
    // Production-pathological — the app should fail to start if the DB
    // pool isn't configured — but if it somehow reaches this site, the
    // chain op IS confirmed and the user deserves the discriminated
    // envelope (not silent staleness or a misleading reconcile promise).
    throw new AppPoolNotInitialisedError('App pool not initialised. accounts.orcid update unavailable');
  }
  try {
    await pool.query(
      `UPDATE accounts SET orcid = $1 WHERE username = $2`,
      [orcidId, username],
    );
  } catch (err) {
    if (isPermanentDbError(err)) {
      // Permanent (constraint/schema regression): re-thrown so the wrap-and-throw
      // at the post-broadcast cascade lifts this into PostBroadcastWriteError →
      // 502 POST_BROADCAST_FAILED with `failed_step:'account_update'`. The
      // structured operator-alert anchor (`event:'post_broadcast_write_failed'`)
      // fires at error level so oncall sees it; the per-step user message says
      // "the chain record is the source of truth, manual reconcile may be needed".
      throw err;
    }
    // Transient: log and swallow. A single connection drop or serialization
    // race during a healthy pool isn't operator-actionable per-request — the
    // denormalized accounts.orcid column may be briefly stale, but the chain
    // record is the source of truth for the binding.
    logger.warn(
      {
        event: 'orcid.account_update.transient_failed',
        route: 'orcid.account-update',
        username,
        err,
      },
      'Failed to update accounts.orcid (row may not exist for self-custody user)',
    );
  }
}

// Test-only seam: handleAccredit/handleLink call
// updateAccountOrcid through this object so a unit spec can replace it via
// `vi.spyOn(__test_seams, 'updateAccountOrcid').mockRejectedValueOnce(...)`
// to deterministically inject a post-broadcast throw without depending on the
// fragile getAppPool() Once-stack (which assumes a specific number of
// getAppPool() calls before this one). A future middleware change that adds
// or removes a getAppPool() call would shift the throw onto the wrong site
// and silently break the mutation-kill assertion. Routing the call through
// __test_seams gives the test a stable name to spy on. NOT for production
// import — only the test bypass references this property.
export const __test_seams = {
  updateAccountOrcid,
  // Routed through __test_seams so a unit spec can pin the ordering
  // invariant — the helper MUST run BEFORE handleBroadcastError writes the
  // response (a malicious caller dropping the connection mid-write could
  // otherwise escape fn before the lock-TTL extend lands).
  // Also lets a spec assert the helper was called for both routes
  // (drift surface between handleAccredit/handleLink callers).
  extendBindingLockOnTimeoutOrLog,
  // Exported so the success-path matrix spec can
  // assert `newTtl: HAF_INDEXING_LAG_CEILING_SECONDS` instead of the bare
  // literal `120`. A future tuning that lowers/raises the constant per the
  // derivation comment block must not turn into a red test for the same
  // (now correct) value.
  HAF_INDEXING_LAG_CEILING_SECONDS,
} as const;

// Export the in-memory verified map so auth.ts signup can consume nonces
export { orcidVerified };

// Test-only exports: the Lua CAS multi-holder correctness of the lock release
// is the primary safety property of the Redlock release path, but the other
// specs only exercise it indirectly (self-release on success, self-release on
// broadcast throw, TTL expiry). Expose the release helper so a unit spec can
// assert that releaseBindingLock(orcidId, wrongNonce) refuses to delete a lock
// held under a different nonce. A regression to plain DEL (no CAS) would pass
// every other spec in the file but fail this one. NOT for production import.
export { releaseBindingLock as __test_releaseBindingLock };

export default router;
