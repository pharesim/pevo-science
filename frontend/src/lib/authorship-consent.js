import Alpine from 'alpinejs';
import { mintAuthorshipFreshAuthProof } from '../api.js';
import {
  getCachedConsentOpProof,
  clearCachedConsentOpProof,
  beginAuthorshipOrcidFreshAuth,
  FRESH_AUTH_REDIRECT_PENDING,
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

// Sentinel: the user dismissed the password re-auth modal. Both this and
// FRESH_AUTH_REDIRECT_PENDING mean "no proof obtained — abort cleanly without an
// error toast"; the caller surfaces them the same way.
const CANCELLED = Symbol('authorship_fresh_auth_cancelled');

// Sentinel: re-auth could not be completed (a second wrong password, or a
// transport error minting the proof). The caller surfaces a generic re-auth
// failure rather than letting the mint failure escape as the op's own message.
const MINT_FAILED = Symbol('authorship_fresh_auth_mint_failed');

// 401 consume-failure reasons that mean "the proof was absent or no longer
// usable" — re-mint and retry once. Mirrors `withSettingsFreshAuth`'s set;
// `wrong_mechanism` is excluded (re-minting the same factor would not fix it).
const REMINTABLE_REASONS = ['missing', 'expired', 'malformed'];

function passwordPromptMessage() {
  // Lib code cannot use the `$t` magic helper; read the i18n store directly with
  // an English fallback, matching settings-fresh-auth.js.
  return (
    Alpine.store('i18n')?.messages?.settings?.reauthPasswordPrompt ||
    'Enter your account password to confirm this action.'
  );
}

// Password-factor mint: prompt via the global reauth modal, then mint a proof
// bound to `target`. A wrong password (401 UNAUTHORIZED at the mint route)
// re-prompts once. Returns the proof string, CANCELLED (modal dismissed at
// either prompt), or MINT_FAILED (a second wrong password, or a transport error
// on the retry mint). A non-auth error on the first attempt (transport, 503,
// VALIDATION_ERROR) propagates so the caller's op-level handler surfaces it.
async function mintViaPassword(target) {
  const modal = Alpine.store('reauthModal');
  const message = passwordPromptMessage();

  let password = await modal.request({ message });
  if (password === null || password === undefined) return CANCELLED;

  try {
    return await mintAuthorshipFreshAuthProof(target, password);
  } catch (err) {
    if (err?.code !== 'UNAUTHORIZED') throw err;

    password = await modal.request({ message });
    if (password === null || password === undefined) return CANCELLED;
    try {
      return await mintAuthorshipFreshAuthProof(target, password);
    } catch {
      return MINT_FAILED;
    }
  }
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
 *   { ok: <broadcastResult> }  broadcast succeeded
 *   { redirect: true }         ORCID round-trip in flight; abort cleanly
 *   { cancelled: true }        user dismissed the password modal; abort cleanly
 *   { freshAuthFailed: true }  re-auth rejected or could not be completed; show
 *                              a generic error
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
  if (proof === CANCELLED) return { cancelled: true };
  if (proof === MINT_FAILED) return { freshAuthFailed: true };

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
      if (retry === CANCELLED) return { cancelled: true };
      if (retry === MINT_FAILED) return { freshAuthFailed: true };
      try {
        const ok = await run(retry);
        clearCachedConsentOpProof();
        return { ok };
      } catch (retryErr) {
        if (retryErr?.code === 'FRESH_AUTH_REQUIRED') return { freshAuthFailed: true };
        throw retryErr;
      }
    }

    return { freshAuthFailed: true };
  }
}
