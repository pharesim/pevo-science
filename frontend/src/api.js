import Alpine from 'alpinejs';

const BASE_URL = '/api';
const DEFAULT_TIMEOUT_MS = 30000;

export class ApiRequestError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data || null;
    this.name = 'ApiRequestError';
  }
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
  const res = await fetch(url, {
    signal: init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    ...init,
  });

  if (!res.ok) {
    let errorBody = null;
    try { errorBody = await res.json(); } catch { /* not JSON */ }
    if (errorBody && errorBody.status === 'error') {
      throw new ApiRequestError(errorBody.error.code, errorBody.error.message, errorBody.data);
    }
    throw new ApiRequestError('INTERNAL_ERROR', `Request failed with status ${res.status}`);
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

export function searchPapers(params) {
  return request(`/search${buildQuery(params)}`);
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

// ─── ORCID (Signup) ─────────────────────────────────────────────

export async function startSignupOrcid() {
  const res = await request('/auth/orcid/start', { method: 'POST' });
  return res.data;
}

export function completeSignupOrcid(code, state) {
  return request('/auth/orcid/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state }),
  });
}

// ─── ORCID (Accreditation) ──────────────────────────────────────

export async function startOrcidVerification() {
  const res = await authenticatedRequest('/accreditation/orcid/start');
  return res.data;
}

export function completeOrcidVerification(code, state) {
  return authenticatedRequest('/accreditation/orcid/callback', {
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

export function updateBridgePaper(permlink) {
  return authenticatedRequest('/bridge/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permlink }),
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

// ─── Cache Invalidation ─────────────────────────────────────────

export function invalidatePaperCache(author, permlink) {
  return authenticatedRequest(
    `/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/invalidate`,
    { method: 'POST' }
  );
}

// ─── Light Account Auth ─────────────────────────────────────────

export function checkUsernameAvailability(username) {
  return request(`/auth/username-available${buildQuery({ username })}`);
}

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

export function linkExistingAccount(authToken, email, username, signature) {
  const timestamp = new Date().toISOString();
  return request('/auth/link', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hive-Username': username,
      'X-Hive-Signature': signature,
      'X-Hive-Message': `${email}:link`,
      'X-Hive-Timestamp': timestamp,
    },
    body: JSON.stringify({ auth_token: authToken }),
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

// ─── Account Search ─────────────────────────────────────────────

export async function searchAccounts(q) {
  const res = await request(`/accounts/search?q=${encodeURIComponent(q)}&limit=5`);
  return res.accounts;
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

