import Alpine from 'alpinejs';
import { startOrcid } from '../api.js';
import { broadcastOps } from '../signer.js';

// In-tab cache of a session-kind fresh_auth_proof. The proof is a single-use
// bearer token (consumed atomically on broadcast attempt) bound to the JWT
// subject, target-less, with a 5-minute TTL. We hold it in sessionStorage so
// it survives the ORCID OAuth round-trip (publish-page → orcid.org →
// /orcid/callback → return-path) but does not leak across tabs or persist
// past tab close. Backend invariant: post-broadcast (success OR failure) the
// proof is gone — re-mint on retry.
const PROOF_KEY = 'pevo_fresh_auth_session_proof';

// In-tab cache of a consent_op-kind fresh_auth_proof. Target-bound to the
// triple `(action, root_author, root_permlink)`; the broadcast consumer
// MUST match all three to consume. Single-slot by design: each ORCID
// fresh_auth round-trip mints state for one target, so a second flow
// overwrites the cached entry (matches the existing pevo_orcid_mode
// overwrite pattern). The token itself is a single-use bearer bound to the
// JWT subject with the same 5-minute TTL as session-kind proofs; backend
// invariant is identical (consumed atomically on broadcast attempt, gone
// post-attempt whether success or failure).
const CONSENT_OP_PROOF_KEY = 'pevo_fresh_auth_consent_op_proof';

// Stashed pre-redirect context so the callback handler can navigate the
// user back to the page they initiated the action on. Cleared by the
// callback handler after the proof lands.
const RETURN_PATH_KEY = 'pevo_fresh_auth_return_to';

// Sentinel for `broadcastWithFreshAuth` callers: when minting required a
// full-page redirect to ORCID, broadcast cannot complete in this tick.
// Returning null (rather than throwing) lets callers `if (res === null) return`
// and unwinds cleanly without a generic error toast firing during navigation.
export const FRESH_AUTH_REDIRECT_PENDING = null;

function getCachedSessionProof() {
  try {
    const raw = sessionStorage.getItem(PROOF_KEY);
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    if (!token || !expiresAt) {
      sessionStorage.removeItem(PROOF_KEY);
      return null;
    }
    // Malformed expiresAt (non-parseable date) yields NaN; `Date.now() >= NaN`
    // is false, so a naive comparison would treat the entry as never-expiring.
    // Treat NaN as corruption: clear the slot and return null so the consumer
    // mints fresh.
    const ts = new Date(expiresAt).getTime();
    if (!Number.isFinite(ts) || Date.now() >= ts) {
      sessionStorage.removeItem(PROOF_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function cacheSessionProof(token, expiresAt) {
  try {
    sessionStorage.setItem(PROOF_KEY, JSON.stringify({ token, expiresAt }));
  } catch {
    // sessionStorage may be unavailable (private mode, quota); the proof
    // simply won't be reused this session. Broadcast still proceeds on the
    // freshly-minted token via the in-memory return value.
  }
}

function clearCachedSessionProof() {
  try {
    sessionStorage.removeItem(PROOF_KEY);
  } catch {
    /* noop */
  }
}

// Cache a consent_op-kind proof along with its `(action, root_author,
// root_permlink)` binding. Returns void; failures (private mode, quota) are
// swallowed and the consumer simply won't find a cache hit on lookup — the
// freshly-minted token returned by the mint flow can still be passed to the
// broadcast in-memory.
export function cacheConsentOpProof(token, expiresAt, action, rootAuthor, rootPermlink) {
  try {
    sessionStorage.setItem(
      CONSENT_OP_PROOF_KEY,
      JSON.stringify({ token, expiresAt, action, rootAuthor, rootPermlink }),
    );
  } catch {
    /* same swallow as cacheSessionProof */
  }
}

// Look up a cached consent_op-kind proof. Strict match on all three target
// fields — any mismatch returns null so the consumer mints fresh. Also
// returns null and clears the slot on TTL expiry.
export function getCachedConsentOpProof(action, rootAuthor, rootPermlink) {
  try {
    const raw = sessionStorage.getItem(CONSENT_OP_PROOF_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !entry.token || !entry.expiresAt) {
      sessionStorage.removeItem(CONSENT_OP_PROOF_KEY);
      return null;
    }
    // Malformed expiresAt yields NaN; `Date.now() >= NaN` is false. Treat
    // NaN as corruption — mirrors getCachedSessionProof.
    const ts = new Date(entry.expiresAt).getTime();
    if (!Number.isFinite(ts) || Date.now() >= ts) {
      sessionStorage.removeItem(CONSENT_OP_PROOF_KEY);
      return null;
    }
    if (
      entry.action !== action ||
      entry.rootAuthor !== rootAuthor ||
      entry.rootPermlink !== rootPermlink
    ) {
      return null;
    }
    return entry.token;
  } catch {
    return null;
  }
}

export function clearCachedConsentOpProof() {
  try {
    sessionStorage.removeItem(CONSENT_OP_PROOF_KEY);
  } catch {
    /* noop */
  }
}

export function getReturnPath() {
  try {
    return sessionStorage.getItem(RETURN_PATH_KEY);
  } catch {
    return null;
  }
}

export function clearReturnPath() {
  try {
    sessionStorage.removeItem(RETURN_PATH_KEY);
  } catch {
    /* noop */
  }
}

// Mint a session-kind fresh_auth_proof for non-consent broadcasts.
//
// Returns the proof string on cache hit, or `null` if a full-page redirect
// to ORCID was initiated (proof will land in cache when the user returns
// via /orcid/callback). Throws on transport / config errors.
//
// Round-1 scope: ORCID session_auth only. Any user reaching a broadcast call
// site is accredited (publish/review/comment/vote are gated on accreditation,
// which requires ORCID), so State A (password, no ORCID) is unreachable. The
// State A password mint path lands in a follow-up after the backend ships
// `POST /api/custody/session-auth` (see
// `backend-custody-session-auth-password-mint.md`).
async function mintNonConsentProof() {
  const cached = getCachedSessionProof();
  if (cached) return cached;

  // `router.path` is not set on the router store today; fall back directly
  // to window.location.pathname. The dead `router && router.path` branch
  // was removed per round-2 hold finding adv-task6-6.
  const returnPath = window.location.pathname || '/';
  try {
    sessionStorage.setItem(RETURN_PATH_KEY, returnPath);
  } catch {
    /* return-path fallback handled in callback */
  }
  // `pevo_orcid_mode` lives in sessionStorage to avoid cross-tab interference
  // between concurrent ORCID flows. localStorage is shared across tabs, so a
  // second tab in a different mode (e.g. 'link') would silently overwrite
  // tab 1's 'session_auth' marker and route the callback to the wrong
  // handler. sessionStorage is per-tab and survives the ORCID OAuth
  // round-trip (orcid.org → /orcid/callback) within the originating tab.
  sessionStorage.setItem('pevo_orcid_mode', 'session_auth');

  let data;
  try {
    data = await startOrcid('session_auth');
  } catch (err) {
    sessionStorage.removeItem('pevo_orcid_mode');
    clearReturnPath();
    throw err;
  }

  // Defense pattern reused from settings.js handleOrcidLink: validate the
  // redirect host before navigating.
  let target;
  try {
    target = new URL(data.redirect_url);
  } catch {
    sessionStorage.removeItem('pevo_orcid_mode');
    clearReturnPath();
    throw new Error('Invalid ORCID redirect URL');
  }
  if (!['orcid.org', 'sandbox.orcid.org'].includes(target.hostname)) {
    sessionStorage.removeItem('pevo_orcid_mode');
    clearReturnPath();
    throw new Error('Invalid ORCID redirect URL');
  }

  window.location.href = data.redirect_url;
  return FRESH_AUTH_REDIRECT_PENDING;
}

// High-level wrapper around `broadcastOps`: mints a session-kind proof if
// needed, attaches it to the broadcast, and handles the FRESH_AUTH_REQUIRED
// retry / re-login fallout per the custody contract.
//
// Returns the broadcast response on success, or `FRESH_AUTH_REDIRECT_PENDING`
// (null) when an ORCID OAuth round-trip is in flight — callers should treat
// the null return as "abort cleanly, the user will retry post-redirect".
//
// Keychain (self-custody) users skip the mint entirely; their per-request
// signed canonical message is the fresh proof.
export async function broadcastWithFreshAuth(username, operations, opts = {}) {
  const auth = Alpine.store('auth');
  if (auth?.custody !== 'light') {
    return broadcastOps(username, operations, opts);
  }

  let proof = getCachedSessionProof();
  if (!proof) {
    proof = await mintNonConsentProof();
    if (proof === FRESH_AUTH_REDIRECT_PENDING) return FRESH_AUTH_REDIRECT_PENDING;
  }

  try {
    return await broadcastOps(username, operations, { ...opts, freshAuthProof: proof });
  } catch (err) {
    // Error shape `{ status, code, details }` is produced by signer.js#broadcastOps
    // (see frontend/src/signer.js — the non-2xx branch parses the JSON envelope
    // and rethrows). Keep this catch's branching aligned with the codes that
    // helper attaches; any new error code introduced upstream must be reflected
    // here.
    // Proof is single-use, consumed atomically before the broadcast attempt.
    // Whether the broadcast succeeded or failed, the proof is now gone — drop
    // the cache so any retry mints a fresh one.
    if (err?.code === 'FRESH_AUTH_REQUIRED') {
      clearCachedSessionProof();

      // 401 missing/expired/malformed → re-mint and retry once. Re-mint may
      // itself redirect (cache miss after clear); the inner mint returns
      // null in that case and we propagate the pending sentinel.
      if (
        err.status === 401 &&
        ['missing', 'expired', 'malformed'].includes(err.details?.reason)
      ) {
        const freshProof = await mintNonConsentProof();
        if (freshProof === FRESH_AUTH_REDIRECT_PENDING) return FRESH_AUTH_REDIRECT_PENDING;
        return broadcastOps(username, operations, { ...opts, freshAuthProof: freshProof });
      }

      // 403 username_mismatch → JWT subject and proof subject diverge.
      // Critical session inconsistency; force re-login.
      if (err.status === 403 && err.details?.reason === 'username_mismatch') {
        auth.disconnect();
        // fresh-auth.js is a lib, not an Alpine component, so it cannot use
        // the `$t` magic helper. Reach into the i18n store directly; fall
        // back to the English value if the locale bundle hasn't loaded.
        const msg =
          Alpine.store('i18n')?.messages?.auth?.sessionInconsistency ||
          'Session inconsistency detected. Please sign in again.';
        Alpine.store('toast')?.show(msg, 'error');
        return FRESH_AUTH_REDIRECT_PENDING;
      }

      // 403 kind_mismatch on the non-consent surface is structurally
      // impossible (this surface accepts both kinds). Treat as a wire-contract
      // regression and log for diagnostics; surface as a generic error.
      if (err.status === 403 && err.details?.reason === 'kind_mismatch') {
        console.warn('[fresh-auth] unexpected kind_mismatch on non-consent broadcast', err);
      }
    }
    throw err;
  }
}
