import Alpine from 'alpinejs';
import { signRequest } from './sign-request.js';

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

export function uploadToIpfs(file) {
  const formData = new FormData();
  formData.append('file', file);
  return authenticatedRequest('/ipfs/upload', {
    method: 'POST',
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

export function resumeSignup(email, password) {
  return request('/auth/resume-signup', {
    method: 'POST',
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_token: authToken, username, keys }),
  });
}

export async function linkExistingAccount(authToken, username) {
  const body = { auth_token: authToken };
  const signed = await signRequest(username, 'POST', '/api/auth/link', body);
  return request('/auth/link', {
    method: 'POST',
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

// Set a password on an account that has none (ORCID-verified signup and
// recover flows leave `password_hash = NULL`; this lets the user opt
// into password login later from Settings).
export function setPassword(password) {
  return authenticatedRequest('/settings/set-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

// ─── Email Settings ─────────────────────────────────────────

export function fetchEmailStatus() {
  return authenticatedRequest('/settings/email');
}

export function submitEmail(email) {
  return authenticatedRequest('/settings/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

export function verifyEmailToken(token) {
  return request(`/settings/email/verify/${encodeURIComponent(token)}`);
}

export function deleteEmail(confirm) {
  return authenticatedRequest('/settings/email', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm }),
  });
}

// ─── Blog ───────────────────────────────────────────────────────

export function fetchBlogPosts(params = {}) {
  return request(`/blog${buildQuery(params)}`);
}

export function fetchBlogPost(permlink) {
  return request(`/blog/${encodeURIComponent(permlink)}`);
}

