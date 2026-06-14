import { mintAuthorshipFreshAuthProof } from '../api.js';
import {
  getCachedConsentOpProof,
  clearCachedConsentOpProof,
  beginAuthorshipOrcidFreshAuth,
  FRESH_AUTH_REDIRECT_PENDING,
  FRESH_AUTH_CANCELLED,
  FRESH_AUTH_MINT_FAILED,
  REMINTABLE_REASONS,
  mintViaPasswordFactor,
  passwordPromptMessage,
  handleSessionInconsistency,
} from './fresh-auth.js';

/**
 * Fresh-auth proof-challenge flow for authorship consent/credit ops broadcast
 * through the custody endpoint — Routes 2 & 3 of the consent model
 * (`author_accept` / `author_resign`, and `claim_authorship` /
 * `approve_authorship` / `revoke_authorship`).
 *
 * Parallel to `withSettingsFreshAuth` (settings-fresh-auth.js), but the proof
 * binds to the PAPER target — and, for name-only credit ops, the slot
 * (`author_index`) and/or subject (`claimer`) — rather than the account-level
 * `(action, username, '')` target. Self-custody (Keychain) requests are fresh at
 * the middleware and carry no body proof; the per-request signature IS the proof.
 * Light accounts mint a target-bound proof via the factor the account supports
 * and thread it into the custody broadcast.
 *
 * Two factors, selected by account state:
 *   - PASSWORD: prompt via the global reauth modal, then mint at
 *     `/custody/fresh-auth`. Used when the account has a password. Inline.
 *   - ORCID: a full-page OAuth round-trip (`beginAuthorshipOrcidFreshAuth`),
 *     whose proof the `/orcid/callback` handler lands in the consent-op cache.
 *     The factor for ORCID-only (passwordless) accounts, and the safe fallback
 *     when the factor is unknown — every accredited account has a linked ORCID,
 *     so the ORCID factor is always available to a user permitted to consent.
 *
 * `target` is the normalized op descriptor:
 *   { action, rootAuthor, rootPermlink, authorIndex?, claimer? }
 * where `rootAuthor`/`rootPermlink` are the paper's root author/permlink (the
 * fields the backend echoes and the proof cache keys on, for both routes).
 */

// Bind the password factor to this surface's mint call. The prompt/re-prompt
// flow and the CANCELLED/MINT_FAILED outcomes live in the shared
// mintViaPasswordFactor (fresh-auth.js); only the target-bound mint differs.
function mintViaPassword(target) {
  return mintViaPasswordFactor(
    (password) => mintAuthorshipFreshAuthProof(target, password),
    { message: passwordPromptMessage() },
  );
}

function getCachedProof(target) {
  return getCachedConsentOpProof(
    target.action,
    target.rootAuthor,
    target.rootPermlink,
    target.authorIndex,
    target.claimer,
  );
}

// Resolve a target-bound proof for a light account. A freshly-returned ORCID
// proof in the consent-op cache wins; otherwise the password factor when the
// account has a password; otherwise the ORCID factor.
async function resolveProof(target, { hasPassword }) {
  const cached = getCachedProof(target);
  if (cached) return cached;
  if (hasPassword) return mintViaPassword(target);
  return beginAuthorshipOrcidFreshAuth(target);
}

/**
 * Run an authorship consent/credit broadcast with the fresh-auth proof its
 * custody path requires. `run(proof)` performs the broadcast (proof is
 * `undefined` for self-custody — Keychain signs). Returns an outcome object:
 *
 *   { ok: <broadcastResult> }     broadcast succeeded
 *   { redirect: true }            ORCID round-trip in flight; abort cleanly
 *   { cancelled: true }           user dismissed the password modal; abort cleanly
 *   { freshAuthFailed: true }     re-auth rejected or could not be completed;
 *                                 show a generic error
 *   { sessionInconsistent: true } the JWT subject and proof subject diverge
 *                                 (corrupted session); the session is torn down
 *                                 and a re-login toast shown here — the caller
 *                                 aborts cleanly without a second toast
 *
 * Non-fresh-auth errors (a Keychain rejection, a 403 from the chain gate, a
 * transport error) propagate to the caller, which keeps its op-level handling.
 *
 * @param {{action: string, rootAuthor: string, rootPermlink: string, authorIndex?: number|null, claimer?: string|null}} target
 * @param {{ custody: string, username: string, hasPassword: boolean }} ctx
 * @param {(proof: string|undefined) => Promise<any>} run
 */
export async function withAuthorshipFreshAuth(target, ctx, run) {
  // Self-custody: the per-request signature is itself the fresh proof, so no
  // body proof is sent. Mirrors broadcastWithFreshAuth / withSettingsFreshAuth.
  if (ctx.custody !== 'light') {
    return { ok: await run(undefined) };
  }

  const proof = await resolveProof(target, ctx);
  if (proof === FRESH_AUTH_REDIRECT_PENDING) return { redirect: true };
  if (proof === FRESH_AUTH_CANCELLED) return { cancelled: true };
  if (proof === FRESH_AUTH_MINT_FAILED) return { freshAuthFailed: true };

  try {
    const ok = await run(proof);
    // Proof is single-use and consumed by the backend before the broadcast; drop
    // any cached copy so the next op mints fresh rather than replaying a dead
    // token (a no-op when the password factor was used — it never caches).
    clearCachedConsentOpProof();
    return { ok };
  } catch (err) {
    if (err?.code !== 'FRESH_AUTH_REQUIRED') throw err;

    // The proof is consumed (success or fail) before the broadcast, so any retry
    // must mint a fresh one. Drop the cache first.
    clearCachedConsentOpProof();

    // Re-mintable reasons (missing/expired/malformed) retry inline ONLY on the
    // password factor. The ORCID factor would need a second full-page OAuth
    // redirect near the 5-minute TTL (re-OAuth loop risk); surface a terminal
    // failure so the user restarts deliberately. `wrong_mechanism` and the 403
    // username/target/kind mismatches are not fixable by re-minting the same
    // factor — they fall through to freshAuthFailed.
    const remintable = REMINTABLE_REASONS.includes(err.details?.reason);
    if (remintable && ctx.hasPassword) {
      const retry = await mintViaPassword(target);
      if (retry === FRESH_AUTH_CANCELLED) return { cancelled: true };
      if (retry === FRESH_AUTH_MINT_FAILED) return { freshAuthFailed: true };
      try {
        const ok = await run(retry);
        clearCachedConsentOpProof();
        return { ok };
      } catch (retryErr) {
        if (retryErr?.code === 'FRESH_AUTH_REQUIRED') return { freshAuthFailed: true };
        throw retryErr;
      }
    }

    // username_mismatch: the JWT subject and the proof subject diverge — a
    // corrupted session, not a retryable re-auth failure. Tear the session down
    // and force re-login via the shared teardown, matching the session-kind and
    // settings siblings; otherwise the user retries a broken session indefinitely
    // against the generic "try again" outcome. Gate on the reason, not a status
    // code: the custody-broadcast error reaching this catch is an api.js
    // ApiRequestError carrying only code/details, no `status`.
    if (err.details?.reason === 'username_mismatch') {
      handleSessionInconsistency();
      return { sessionInconsistent: true };
    }

    return { freshAuthFailed: true };
  }
}
