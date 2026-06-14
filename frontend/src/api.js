import Alpine from 'alpinejs';
import { signRequest } from './sign-request.js';
import { sha256File } from './crypto.js';
import { getAppTag } from './config.js';

const BASE_URL = '/api';
const DEFAULT_TIMEOUT_MS = 30000;

export class ApiRequestError extends Error {
  constructor(code, message, data, details, retryAfterSeconds) {
    super(message);
    this.code = code;
    this.data = data || null;
    // `details` mirrors `error.details` from the response envelope. It is
    // distinct from `data` (which is the success-path payload, always `null`
    // on errors). Left `undefined` when the server omits it so consumers can
    // use `err.details?.retriable` safely.
    this.details = details;
    // `retryAfterSeconds` is parsed from the `Retry-After` response header.
    // `null` when the header is absent or unparseable; a positive integer
    // otherwise. See `api-contracts/orcid.md` for the retriable discriminator.
    this.retryAfterSeconds = retryAfterSeconds ?? null;
    this.name = 'ApiRequestError';
  }
}

/**
 * Predicate: did this error originate from a retriable 503 response?
 *
 * Backends signal "transient failure with no chain/token side-effect; safe to
 * retry" by pairing `error.code === 'SERVICE_UNAVAILABLE'` with
 * `error.details.retriable === true` on the response envelope. See
 * `agents/docs/api-contracts/common.md` § "Note on `503 SERVICE_UNAVAILABLE`
 * and `details.retriable`" for the authoritative enumeration of emitter routes.
 *
 * Centralizing the predicate here keeps the envelope shape negotiable: a
 * future shift (e.g. `details.recoverable`, `details.retry_after_ms`) updates
 * one site instead of every retry-loop and banner.
 *
 * Null/undefined/missing-`details`/non-matching-`code` all return `false`.
 */
export function isRetriable503(err) {
  return err?.code === 'SERVICE_UNAVAILABLE' && err?.details?.retriable === true;
}

// Parse `Retry-After` response header as seconds. Returns `null` when absent
// or unparseable. Only the delta-seconds form is supported; HTTP-date form
// is rare in our API and not worth the parse cost.
function parseRetryAfterSeconds(res) {
  const raw = res?.headers?.get?.('Retry-After');
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function getToken() {
  try {
    const store = Alpine.store('auth');
    return store ? store.token : null;
  } catch {
    return null;
  }
}

async function request(path, init) {
  const url = `${BASE_URL}${path}`;
  // Compose the caller's signal (if any) with a 30s timeout via
  // AbortSignal.any() so EVERY request gets the timeout safeguard. The
  // previous form set `signal:` before `...init` spread, which meant
  // any caller passing `{signal}` lost the fallback timeout entirely.
  // The composed signal MUST live after the `...init` spread so it
  // wins over any `signal` re-introduced by the spread.
  const composedSignal = init?.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
    : AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const res = await fetch(url, {
    ...init,
    signal: composedSignal,
  });

  if (!res.ok) {
    let errorBody = null;
    try { errorBody = await res.json(); } catch { /* not JSON */ }
    const retryAfterSeconds = parseRetryAfterSeconds(res);
    if (errorBody && errorBody.status === 'error' && errorBody.error) {
      throw new ApiRequestError(
        errorBody.error.code,
        errorBody.error.message,
        errorBody.data,
        errorBody.error.details,
        retryAfterSeconds,
      );
    }
    throw new ApiRequestError(
      'INTERNAL_ERROR',
      `Request failed with status ${res.status}`,
      null,
      undefined,
      retryAfterSeconds,
    );
  }

  return res.json();
}

async function authenticatedRequest(path, init) {
  const token = getToken();
  if (!token) throw new ApiRequestError('UNAUTHORIZED', 'Not logged in');
  return request(path, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}

function buildQuery(params) {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== ''
  );
  if (entries.length === 0) return '';
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  return `?${qs}`;
}

// ─── Papers ──────────────────────────────────────────────────────

export function fetchPapers(params = {}) {
  return request(`/papers${buildQuery(params)}`);
}

export function fetchPaper(author, permlink, version) {
  const q = version ? `?version=${version}` : '';
  return request(`/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}${q}`);
}

export function fetchPaperEnrichment(author, permlink) {
  return request(`/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/enrichment`);
}

export function fetchPaperComments(author, permlink, params = {}) {
  return request(`/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/comments${buildQuery(params)}`);
}

// ─── Profile ─────────────────────────────────────────────────────

export function fetchProfile(username) {
  return request(`/profile/${encodeURIComponent(username)}`);
}

export function fetchProfilePapers(username, params = {}) {
  return request(`/profile/${encodeURIComponent(username)}/papers${buildQuery(params)}`);
}

export function fetchProfileReviews(username, params = {}) {
  return request(`/profile/${encodeURIComponent(username)}/reviews${buildQuery(params)}`);
}

// ─── Search ──────────────────────────────────────────────────────

// The optional second argument forwards `{ signal }` to the underlying
// fetch so search-page guards can cancel an in-flight request when the
// user clicks a new page or hits back/forward (see search.js doSearch).
// Other options are forwarded verbatim; backward-compatible with the
// previous single-argument call sites.
export function searchPapers(params, options = {}) {
  return request(`/search${buildQuery(params)}`, options);
}

// ─── Disciplines ─────────────────────────────────────────────────

export function fetchDisciplines() {
  return request('/disciplines');
}

// ─── IPFS ────────────────────────────────────────────────────────

// Mint a single-use, per-action fresh-auth proof via the PASSWORD factor. POSTs
// the account password to `/custody/fresh-auth`; the backend argon2-verifies it
// against the account and returns a proof bound to (<action>, <username>, '').
// A wrong password and a passwordless (ORCID-only) account both return the same
// 401 UNAUTHORIZED (no password-existence oracle), so callers must route State-C
// accounts to the ORCID factor instead of relying on this. The proof is
// single-use with a 5-minute TTL; callers re-mint on retry. Returns the proof
// string. Shared by the IPFS upload pre-flight and the settings critical-action
// flow (change_email / delete_account); `set_password` is NOT mintable here (it
// transitions a passwordless account, so the route rejects the password factor).
async function mintPasswordFreshAuthProof(action, password) {
  const res = await authenticatedRequest('/custody/fresh-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, password }),
  });
  return res.data.fresh_auth_proof;
}

// Mint a fresh-auth proof for the light-account (JWT) upload-token pre-flight,
// bound to (ipfs_upload, <username>, ''). The proof is consumed by the first
// step of the two-step upload below: `POST /api/ipfs/upload-token` mints a
// single-use token, then `POST /api/ipfs/upload` carries it in `X-Upload-Token`.
export function mintIpfsUploadProof(password) {
  return mintPasswordFreshAuthProof('ipfs_upload', password);
}

// Two-step IPFS upload for one file: (1) a pre-flight that binds the file's
// SHA-256 to the authenticated request and mints a single-use upload token,
// then (2) the multipart upload carrying that token in `X-Upload-Token`.
//
// Only the pre-flight differs by custody. Self-custody (Keychain) signs the
// descriptor — the signature body-hashes the declared SHA-256, so no fresh-auth
// proof is needed (one Keychain prompt per file). Light accounts (JWT) cannot
// sign per request, so the pre-flight carries a per-action `fresh_auth_proof`
// (mint via `mintIpfsUploadProof`), supplied by the caller. The upload itself
// is gated by the single-use token, not the auth method, so both custody types
// authenticate it with their session JWT — self-custody therefore pays no
// second signature. The upload orchestration (credential prompt, State-C
// gating, per-file minting, retry) lives in `lib/ipfs-upload.js`.
export async function uploadFileToIpfs(file, { freshAuthProof } = {}) {
  const auth = Alpine.store('auth');
  const username = auth?.username;
  if (!username) throw new ApiRequestError('UNAUTHORIZED', 'Not logged in');

  const descriptor = {
    file_sha256: await sha256File(file),
    mimetype: file.type,
    size: file.size,
  };

  let uploadToken;
  if (auth?.custody === 'self') {
    const signed = await signRequest(username, 'POST', '/api/ipfs/upload-token', descriptor);
    const tokenRes = await request('/ipfs/upload-token', {
      method: 'POST',
      headers: { ...signed.headers, 'Content-Type': 'application/json' },
      body: signed.body,
    });
    uploadToken = tokenRes.data.upload_token;
  } else {
    if (!freshAuthProof) {
      throw new ApiRequestError(
        'FRESH_AUTH_REQUIRED',
        'Re-authentication required to upload',
        null,
        { reason: 'missing' },
      );
    }
    const tokenRes = await authenticatedRequest('/ipfs/upload-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...descriptor, fresh_auth_proof: freshAuthProof }),
    });
    uploadToken = tokenRes.data.upload_token;
  }

  const formData = new FormData();
  formData.append('file', file);
  return authenticatedRequest('/ipfs/upload', {
    method: 'POST',
    headers: { 'X-Upload-Token': uploadToken },
    body: formData,
  });
}

// ─── Accreditation ───────────────────────────────────────────────

export function requestAccreditation(data) {
  return authenticatedRequest('/accreditation/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function verifyAccreditation(token) {
  return request('/accreditation/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

export function fetchAccreditationStatus(username) {
  return request(`/accreditations/${encodeURIComponent(username)}`);
}

export function fetchAccreditations(params = {}) {
  return request(`/accreditations${buildQuery(params)}`);
}

// ─── Reviews ─────────────────────────────────────────────────────

// Backend translates HAF outages to `503 SERVICE_UNAVAILABLE` with
// `details.retriable: true`; consumers MUST distinguish that case from
// 404 / 200-empty and surface a retry affordance, not a generic error
// or empty state. See the established pattern in
// `frontend/src/components/threaded-comments.js#loadComments`. No SPA
// call sites today; this comment is the forward contract for when the
// review-detail page lands.
export function fetchReview(author, permlink) {
  return request(`/reviews/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}`);
}

export function submitAnonymousReview(data) {
  return authenticatedRequest('/reviews/anonymous', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// ─── Web of Trust ────────────────────────────────────────────────

export function fetchVouchStatus(username) {
  return request(`/wot/${encodeURIComponent(username)}`);
}

export function notifyVouch(vouchee) {
  return authenticatedRequest('/wot/vouch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vouchee }),
  });
}

export function notifyRetractVouch(vouchee) {
  return authenticatedRequest('/wot/retract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vouchee }),
  });
}

// ─── Notifications ───────────────────────────────────────────────

export function fetchNotifications(sinceBlock, limit = 50) {
  return authenticatedRequest(`/notifications${buildQuery({ since_block: sinceBlock, limit })}`);
}

// ─── Platform Stats ──────────────────────────────────────────────

export function fetchPlatformStats() {
  return request('/stats');
}

// ─── ORCID (Unified) ────────────────────────────────────────────

const ORCID_AUTHED_MODES = new Set(['accredit', 'link', 'fresh_auth', 'session_auth']);

export async function startOrcid(mode, extra = {}) {
  const reqFn = ORCID_AUTHED_MODES.has(mode) ? authenticatedRequest : request;
  const res = await reqFn('/orcid/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, ...extra }),
  });
  return res.data;
}

export function completeOrcid(code, state, mode) {
  const reqFn = ORCID_AUTHED_MODES.has(mode) ? authenticatedRequest : request;
  return reqFn('/orcid/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state }),
  });
}

// ─── Citation Export ─────────────────────────────────────────────

export async function fetchCitationExport(author, permlink, format) {
  const res = await request(
    `/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/cite?format=${format}`
  );
  return res.data;
}

// ─── Paper Retraction ────────────────────────────────────────────

export async function retractPaper(author, permlink, reason) {
  const res = await authenticatedRequest(
    `/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/retract`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }
  );
  return res.data;
}

// ─── DOI ─────────────────────────────────────────────────────────


// ─── Notification Preferences ────────────────────────────────────

export async function fetchNotificationPreferences(username) {
  const res = await authenticatedRequest(
    `/profile/${encodeURIComponent(username)}/notification-preferences`
  );
  return res.data;
}

export async function updateNotificationPreferences(username, prefs) {
  const res = await authenticatedRequest(
    `/profile/${encodeURIComponent(username)}/notification-preferences`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    }
  );
  return res.data;
}

// ─── Preprint Bridge ─────────────────────────────────────────────

export function fetchBridgeLookup(identifier) {
  return request(`/bridge/lookup${buildQuery({ identifier })}`);
}

export function fetchBridgeCheck(identifier) {
  return request(`/bridge/check${buildQuery({ identifier })}`);
}

export function registerBridgePaper(data) {
  return authenticatedRequest('/bridge/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// List the caller's own bridge import queue entries (the "My imports"
// surface). The bridge register endpoint is asynchronous: a successful
// POST returns HTTP 202 with a pending queue entry, and the broadcast
// happens later on a worker tick. This endpoint is how the caller learns
// the terminal outcome. Authenticated; entries are scoped to the bearer's
// account server-side (no caller-controlled user selector). `state` and
// `limit` are optional filters; both are validated server-side.
export function fetchBridgeImports({ state, limit } = {}) {
  return authenticatedRequest(`/bridge/imports${buildQuery({ state, limit })}`);
}

// ─── Contact ─────────────────────────────────────────────────────

export function submitContactForm(data) {
  return request('/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// ─── Authorship Claims ─────────────────────────────────────────

export function fetchPaperClaims(author, permlink) {
  return request(`/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/claims`);
}

export function claimAuthorship(author, permlink, authorIndex) {
  return authenticatedRequest(
    `/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/claims`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author_index: authorIndex ?? null }),
    }
  );
}

export function approveAuthorshipClaim(author, permlink, claimer, authorIndex) {
  return authenticatedRequest(
    `/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/claims/${encodeURIComponent(claimer)}/approve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author_index: authorIndex ?? null }),
    }
  );
}

export function revokeAuthorshipClaim(author, permlink, claimer, reason) {
  return authenticatedRequest(
    `/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/claims/${encodeURIComponent(claimer)}/revoke`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }
  );
}

// ─── Authorship consent (Routes 2 & 3) ──────────────────────────

// The signed-in user's outstanding authorship actions: `pending_consents` =
// Route-2 anchored slots awaiting their `author_accept`; `pending_claims` =
// Route-3 name-only slots awaiting their `claim`/approval. Fail-closed: the
// endpoint returns 503 SERVICE_UNAVAILABLE on HAF unavailability rather than an
// empty list (a silent empty would read as "nothing pending" and hide real
// obligations), so callers must surface a retry affordance on 503, never treat
// it as "no actions."
export function fetchPendingAuthorships() {
  return authenticatedRequest('/me/authorships/pending');
}

// Map a normalized authorship fresh-auth target to the request-body fields the
// issuance endpoints (`POST /custody/fresh-auth`, `POST /orcid/start
// {mode:'fresh_auth'}`) expect. Anchored consent ops (author_accept /
// author_resign) carry root_author/root_permlink; name-only credit ops
// (claim/approve/revoke) carry paper_author/paper_permlink plus author_index
// (claim/approve) and claimer (approve/revoke). `action` is always included; the
// optional credit fields are emitted only when bound, mirroring what the backend
// echoes so the SPA proof-cache key matches the proof's actual binding.
export function consentOpRequestFields(target) {
  const { action, rootAuthor, rootPermlink, authorIndex, claimer } = target;
  if (action === 'author_accept' || action === 'author_resign') {
    return { action, root_author: rootAuthor, root_permlink: rootPermlink };
  }
  const fields = { action, paper_author: rootAuthor, paper_permlink: rootPermlink };
  if (authorIndex !== undefined && authorIndex !== null) fields.author_index = authorIndex;
  if (claimer !== undefined && claimer !== null) fields.claimer = claimer;
  return fields;
}

// Mint a single-use, target-bound fresh-auth proof for an authorship consent/
// credit op via the PASSWORD factor (light accounts that carry a password).
// POSTs the password plus the op's target fields to `/custody/fresh-auth`; the
// backend argon2-verifies and returns a proof bound to that same target. Mirrors
// mintPasswordFreshAuthProof but for the per-paper (and, for credit ops,
// per-slot/subject) target. A wrong password and a passwordless account both
// return 401 UNAUTHORIZED, so ORCID-only accounts route to the ORCID factor
// instead. Returns the proof string.
export async function mintAuthorshipFreshAuthProof(target, password) {
  const res = await authenticatedRequest('/custody/fresh-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...consentOpRequestFields(target), password }),
  });
  return res.data.fresh_auth_proof;
}

// Build the unsigned `author_accept` / `author_resign` custom_json operation
// tuple. Unlike the Route-3 credit ops (claim/approve/revoke), the backend does
// NOT pre-build these — there is no preflight endpoint — so the SPA constructs
// the op directly per ARCHITECTURE.md "Author Accept (custom_json)". The signer
// (required_posting_auths[0]) IS the implicit accepting/resigning author: the
// payload carries no subject field, so signer identity is the consenter identity.
// `json` is a stringified payload, matching the backend's claim-op construction.
export function buildConsentCustomJson(action, rootAuthor, rootPermlink, signer) {
  return [
    'custom_json',
    {
      id: getAppTag(),
      json: JSON.stringify({ action, root_author: rootAuthor, root_permlink: rootPermlink }),
      required_auths: [],
      required_posting_auths: [signer],
    },
  ];
}

// ─── Cache Invalidation ─────────────────────────────────────────

export function invalidatePaperCache(author, permlink) {
  return authenticatedRequest(
    `/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/invalidate`,
    { method: 'POST' }
  );
}

// ─── Light Account Auth ─────────────────────────────────────────

export function submitSignup(data) {
  return request('/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// `/resume-signup`, `/confirm`, and `/link` are the signup-session-binding
// triad: `/resume-signup` (and `/verify`) mint the httpOnly `pevo_signup_session`
// cookie via Set-Cookie; `/confirm` and `/link` require that cookie back on the
// request to authorize completing the pending signup. The cookie is scoped
// `path=/api/auth`, `sameSite=lax`. `credentials: 'same-origin'` is set
// explicitly on all three so the binding cookie is stored from the response and
// re-sent on the follow-up XHR even if a future build serves the SPA from a
// configuration where the fetch credentials default would not attach it. The
// auth_token NEVER travels as a URL query param — it lives only in these
// response bodies and request bodies, never the address bar (which leaks to
// logs / Referer).
export function resumeSignup(email, password) {
  return request('/auth/resume-signup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

export function resendVerification(email, password) {
  return request('/auth/resend-verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

export function verifyEmail(token) {
  return request('/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

export function confirmAccount(authToken, username, keys) {
  return request('/auth/confirm', {
    method: 'POST',
    // Sends the `pevo_signup_session` binding cookie minted by /verify or
    // /resume-signup; the route rejects without it. See resumeSignup() above.
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_token: authToken, username, keys }),
  });
}

export async function linkExistingAccount(authToken, username) {
  const body = { auth_token: authToken };
  const signed = await signRequest(username, 'POST', '/api/auth/link', body);
  return request('/auth/link', {
    method: 'POST',
    // Sends the `pevo_signup_session` binding cookie minted by /verify or
    // /resume-signup; the route rejects without it. See resumeSignup() above.
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...signed.headers,
    },
    body: signed.body,
  });
}

export function loginWithPassword(emailOrUsername, password) {
  return request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email_or_username: emailOrUsername, password }),
  });
}

export function requestPasswordReset(email) {
  return request('/auth/reset-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(token, password) {
  return request('/auth/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
}

// ─── Account Recovery ───────────────────────────────────────────

export function recoverWithSeedPhrase(username, memoKey, newEmail, newPassword) {
  return request('/auth/recover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, memo_key: memoKey, new_email: newEmail, new_password: newPassword }),
  });
}

export function recoverWithOrcid(username, orcidToken, newEmail, newPassword) {
  return request('/auth/recover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, orcid_token: orcidToken, new_email: newEmail, new_password: newPassword }),
  });
}

// ─── Account Search ─────────────────────────────────────────────

export async function searchAccounts(q) {
  const res = await request(`/accounts/search?q=${encodeURIComponent(q)}&limit=5`);
  return res.accounts;
}

// ─── Password Settings ──────────────────────────────────────

// Mint a single-use fresh-auth proof for a settings critical action via the
// PASSWORD factor, bound to (<action>, <username>, ''). Used for `change_email`
// and `delete_account` on accounts that have a password (State A/B). NOT for
// `set_password`: that target account is passwordless, so its proof is minted
// only via the ORCID factor (the password route rejects `set_password`).
// Returns the proof string. The orchestration (factor selection, ORCID
// fallback, retry) lives in `lib/settings-fresh-auth.js`.
export function mintSettingsActionProof(action, password) {
  return mintPasswordFreshAuthProof(action, password);
}

// Set a password on an account that has none (ORCID-verified signup and
// recover flows leave `password_hash = NULL`; this lets the user opt
// into password login later from Settings). On the JWT (light-account) path
// the backend requires an ORCID-mechanism `fresh_auth_proof` bound to
// (set_password, <username>, ''); the Keychain path needs none.
export function setPassword(password, freshAuthProof) {
  return authenticatedRequest('/settings/set-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, ...(freshAuthProof ? { fresh_auth_proof: freshAuthProof } : {}) }),
  });
}

// ─── Email Settings ─────────────────────────────────────────

export function fetchEmailStatus() {
  return authenticatedRequest('/settings/email');
}

// Add or change the account email. The change branch on an existing row is a
// critical action: on the JWT (light-account) path the backend requires a
// `fresh_auth_proof` bound to (change_email, <username>, '') in the body; the
// Keychain path needs none. `freshAuthProof` is omitted by self-custody callers.
export function submitEmail(email, freshAuthProof) {
  return authenticatedRequest('/settings/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, ...(freshAuthProof ? { fresh_auth_proof: freshAuthProof } : {}) }),
  });
}

export function verifyEmailToken(token) {
  return request(`/settings/email/verify/${encodeURIComponent(token)}`);
}

// Delete the account (de-facto right-to-erasure). A critical action: on the JWT
// (light-account) path the backend requires a `fresh_auth_proof` bound to
// (delete_account, <username>, '') alongside `confirm: true`; the Keychain path
// needs only `confirm`. `freshAuthProof` is omitted by self-custody callers.
export function deleteEmail(confirm, freshAuthProof) {
  return authenticatedRequest('/settings/email', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm, ...(freshAuthProof ? { fresh_auth_proof: freshAuthProof } : {}) }),
  });
}

// ─── Blog ───────────────────────────────────────────────────────

export function fetchBlogPosts(params = {}) {
  return request(`/blog${buildQuery(params)}`);
}

export function fetchBlogPost(permlink) {
  return request(`/blog/${encodeURIComponent(permlink)}`);
}

